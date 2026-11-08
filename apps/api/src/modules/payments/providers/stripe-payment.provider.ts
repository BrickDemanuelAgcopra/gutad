import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { loadConfig } from '../../../config/config';
import type { CreateIntentInput, IntentResult, PaymentProvider, ProviderEvent, SetupResult } from './payment-provider';

/**
 * Stripe Connect adapter using destination charges: the platform is the merchant of record for the charge,
 * funds flow to the connected account minus `application_fee_amount`.
 * Docs: https://docs.stripe.com/connect/charges (destination charges), https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly log = new Logger(StripePaymentProvider.name);
  private readonly stripe: Stripe;

  constructor() {
    const cfg = loadConfig();
    this.stripe = new Stripe(cfg.STRIPE_SECRET_KEY || 'sk_test_missing', { apiVersion: '2025-08-27.basil' as never });
  }

  private map(pi: Stripe.PaymentIntent): IntentResult {
    const charge = typeof pi.latest_charge === 'object' ? (pi.latest_charge as Stripe.Charge) : null;
    const status: IntentResult['status'] = pi.status === 'succeeded' ? 'captured' : pi.status === 'requires_capture' ? 'authorized' : 'requires_action';
    const captured = pi.amount_received || 0;
    const fee = charge?.balance_transaction && typeof charge.balance_transaction === 'object' ? (charge.balance_transaction as Stripe.BalanceTransaction).fee : Math.round(captured * 0.029) + (captured ? 30 : 0);
    return {
      providerIntentId: pi.id,
      clientSecret: pi.client_secret,
      status,
      authorizedCents: pi.amount_capturable || pi.amount,
      capturedCents: captured,
      processingFeeCents: fee,
      chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : charge?.id || null,
    };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentResult> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      capture_method: input.captureMethod,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      receipt_email: input.customerEmail || undefined,
      metadata: input.metadata,
      expand: ['latest_charge.balance_transaction'],
    };
    if (input.destinationAccountId) {
      params.transfer_data = { destination: input.destinationAccountId };
      if (input.applicationFeeCents) params.application_fee_amount = input.applicationFeeCents;
    }
    if (input.paymentMethodId) {
      params.payment_method = input.paymentMethodId;
      params.confirm = true;
      if (input.offSession) params.off_session = true;
    }
    const pi = await this.stripe.paymentIntents.create(params, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
    return this.map(pi);
  }

  async capture(providerIntentId: string, amountCents: number): Promise<IntentResult> {
    const pi = await this.stripe.paymentIntents.capture(providerIntentId, { amount_to_capture: amountCents, expand: ['latest_charge.balance_transaction'] });
    return this.map(pi);
  }

  async cancel(providerIntentId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(providerIntentId).catch((e) => this.log.warn(`cancel ${providerIntentId}: ${e.message}`));
  }

  async refund(providerIntentId: string, amountCents: number, reason: string, idempotencyKey?: string) {
    const r = await this.stripe.refunds.create(
      { payment_intent: providerIntentId, amount: amountCents, reason: 'requested_by_customer', metadata: { reason }, reverse_transfer: true, refund_application_fee: true },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
    return { providerRefundId: r.id, status: (r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending') as 'succeeded' | 'pending' | 'failed' };
  }

  async createSetup(customerEmail: string | null): Promise<SetupResult> {
    const customer = customerEmail ? await this.stripe.customers.create({ email: customerEmail }) : null;
    const si = await this.stripe.setupIntents.create({ customer: customer?.id, usage: 'off_session', automatic_payment_methods: { enabled: true, allow_redirects: 'never' } });
    return { providerSetupId: si.id, clientSecret: si.client_secret, paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : null };
  }

  async createConnectedAccount(input: { legalName: string; email: string; country: string; returnUrl: string; refreshUrl: string }) {
    const acct = await this.stripe.accounts.create({ type: 'express', country: input.country, email: input.email, business_profile: { name: input.legalName }, capabilities: { card_payments: { requested: true }, transfers: { requested: true } } });
    const link = await this.stripe.accountLinks.create({ account: acct.id, type: 'account_onboarding', return_url: input.returnUrl, refresh_url: input.refreshUrl });
    return { accountId: acct.id, onboardingUrl: link.url };
  }

  async transfer(input: { accountId: string; amountCents: number; currency: string; idempotencyKey: string; description: string }) {
    try {
      const t = await this.stripe.transfers.create({ amount: input.amountCents, currency: input.currency.toLowerCase(), destination: input.accountId, description: input.description }, { idempotencyKey: input.idempotencyKey });
      return { transferId: t.id, status: 'paid' as const };
    } catch (e) {
      return { transferId: '', status: 'failed' as const, failureReason: (e as Error).message };
    }
  }

  async parseWebhook(rawBody: Buffer, signature: string | undefined): Promise<ProviderEvent | null> {
    const secret = loadConfig().STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature) return null;
    let ev: Stripe.Event;
    try {
      ev = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (e) {
      this.log.warn(`webhook signature failed: ${(e as Error).message}`);
      return null;
    }
    const obj = ev.data.object as unknown as Record<string, unknown>;
    const base = { id: ev.id, raw: ev };
    switch (ev.type as string) {
      case 'payment_intent.succeeded':
        return { ...base, type: 'payment.captured', providerIntentId: obj.id as string, amountCents: obj.amount_received as number };
      case 'payment_intent.payment_failed':
        return { ...base, type: 'payment.failed', providerIntentId: obj.id as string };
      case 'charge.refunded':
        return { ...base, type: 'payment.refunded', providerIntentId: obj.payment_intent as string, amountCents: obj.amount_refunded as number };
      case 'charge.dispute.created':
        return { ...base, type: 'dispute.created', providerIntentId: obj.payment_intent as string, amountCents: obj.amount as number };
      case 'charge.dispute.closed':
        return { ...base, type: 'dispute.closed', providerIntentId: obj.payment_intent as string };
      case 'transfer.paid':
        return { ...base, type: 'transfer.paid', providerTransferId: obj.id as string };
      case 'transfer.failed':
        return { ...base, type: 'transfer.failed', providerTransferId: obj.id as string };
      case 'account.updated':
        return { ...base, type: 'account.updated', accountId: obj.id as string };
      default:
        return { ...base, type: 'other' };
    }
  }
}
