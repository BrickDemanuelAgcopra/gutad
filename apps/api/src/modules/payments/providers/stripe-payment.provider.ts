import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { loadConfig } from '../../../config/config';
import type { CardDetails, CreateIntentInput, IntentResult, PaymentProvider, ProviderEvent, SetupResult } from './payment-provider';

/**
 * Stripe Connect adapter using destination charges: the platform is the merchant of record for the charge,
 * funds flow to the connected account minus `application_fee_amount`.
 * Connected accounts are Accounts v2 (`/v2/core/accounts`): Stripe refuses v1 account creation for new Connect
 * platforms. Sellers get the `recipient` configuration (they receive transfers, they never charge cards), the
 * Express Dashboard, and the platform carries fees and losses. v2 accounts still emit v1 `account.updated`.
 * Docs: https://docs.stripe.com/connect/charges (destination charges), https://docs.stripe.com/payments/place-a-hold-on-a-payment-method,
 * https://docs.stripe.com/api/v2/core/accounts/create, https://docs.stripe.com/api/v2/core/account-links/create
 */

/** v2 endpoints need an API version that has them; v1 calls stay on the version pinned in the constructor. */
const V2_API_VERSION = '2026-11-18.endive';

type V2Account = { id: string; configuration?: { recipient?: { capabilities?: { stripe_balance?: { stripe_transfers?: { status?: string } } } } } };

/** Capability status (v2 `stripe_transfers` or its v1 twin `transfers`) to the seller's payout onboarding state. */
function stateOf(status: string | undefined): ProviderEvent['accountState'] {
  if (!status) return undefined;
  if (status === 'active') return 'COMPLETE';
  if (status === 'pending' || status === 'inactive') return 'PENDING';
  return 'RESTRICTED';
}
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
      // 10.3-P a card saved through a SetupIntent belongs to a processor customer; the charge must name it
      const owner = await this.stripe.paymentMethods.retrieve(input.paymentMethodId).then((pm) => (typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || null)).catch(() => null);
      if (owner) params.customer = owner;
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

  // ───── 10.3-P / 18.9-S tokenization for saved cards ─────

  private async customerFor(email: string | null, customerRef: string | null) {
    if (customerRef) return customerRef;
    return (await this.stripe.customers.create(email ? { email } : {})).id;
  }

  async setupForCustomer(input: { email: string | null; customerRef: string | null; idempotencyKey?: string }) {
    const customer = await this.customerFor(input.email, input.customerRef);
    const si = await this.stripe.setupIntents.create({ customer, usage: 'off_session', payment_method_types: ['card'] }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
    return { providerSetupId: si.id, clientSecret: si.client_secret, paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : null, customerRef: customer };
  }

  async hostedSetup(input: { email: string | null; customerRef: string | null; successUrl: string; cancelUrl: string }) {
    const customer = await this.customerFor(input.email, input.customerRef);
    const s = await this.stripe.checkout.sessions.create({ mode: 'setup', customer, payment_method_types: ['card'], currency: loadConfig().DEFAULT_CURRENCY.toLowerCase(), success_url: input.successUrl, cancel_url: input.cancelUrl });
    if (!s.url) throw new Error('Processor did not return a setup page');
    return { sessionId: s.id, url: s.url, customerRef: customer };
  }

  async completeHostedSetup(sessionId: string) {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
    const si = s.setup_intent && typeof s.setup_intent === 'object' ? (s.setup_intent as Stripe.SetupIntent) : null;
    if (s.status !== 'complete' || !si || si.status !== 'succeeded' || !si.payment_method) return null;
    return { paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : si.payment_method.id, customerRef: typeof s.customer === 'string' ? s.customer : s.customer?.id || null };
  }

  async describePaymentMethod(paymentMethodId: string): Promise<CardDetails | null> {
    const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    if (!pm || pm.type !== 'card' || !pm.card) return null;
    return { paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year, customerRef: typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || null };
  }

  private async v2<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    return (await this.stripe.rawRequest(method, path, body, { apiVersion: V2_API_VERSION })) as unknown as T;
  }

  async createConnectedAccount(input: { legalName: string; email: string; country: string; returnUrl: string; refreshUrl: string; existingAccountId?: string | null }) {
    const accountId =
      input.existingAccountId ||
      (
        await this.v2<V2Account>('POST', '/v2/core/accounts', {
          contact_email: input.email,
          display_name: input.legalName,
          dashboard: 'express',
          identity: { country: input.country.toLowerCase() },
          configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
          // required with the Express Dashboard, and what Stripe recommends for destination charges
          defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        })
      ).id;
    const onboarding: Record<string, unknown> = { return_url: input.returnUrl, refresh_url: input.refreshUrl };
    const link = (configurations?: string[]) =>
      this.v2<{ url: string }>('POST', '/v2/core/account_links', { account: accountId, use_case: { type: 'account_onboarding', account_onboarding: configurations ? { ...onboarding, configurations } : onboarding } });
    // Stripe's reference request omits `configurations`, but answers `configs_must_match_to_use_account_links` when it needs them
    const l = await link().catch((e: Error & { code?: string }) => {
      if (!/configs_must_match/.test(`${e.code ?? ''} ${e.message}`)) throw e;
      return link(['recipient']);
    });
    return { accountId, onboardingUrl: l.url };
  }

  /** Whether the platform can transfer to the account. `snapshot` is the v1 account from `account.updated`, used if the v2 read fails. */
  private async accountState(accountId: string, snapshot?: Record<string, unknown>): Promise<ProviderEvent['accountState']> {
    try {
      const a = await this.v2<V2Account>('GET', `/v2/core/accounts/${encodeURIComponent(accountId)}?include=configuration.recipient`);
      const s = stateOf(a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status);
      if (s) return s;
    } catch (e) {
      this.log.warn(`v2 account ${accountId}: ${(e as Error).message}`);
    }
    return stateOf((snapshot?.capabilities as Record<string, string> | undefined)?.transfers);
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
    // Comma-separated: one signing secret per Stripe destination ("Your account" and "Connected accounts").
    const secrets = loadConfig().STRIPE_WEBHOOK_SECRET.split(',').map((x) => x.trim()).filter(Boolean);
    if (!secrets.length || !signature) return null;
    let ev: Stripe.Event | null = null;
    let lastErr = '';
    for (const secret of secrets) {
      try {
        ev = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    if (!ev) {
      this.log.warn(`webhook signature failed: ${lastErr}`);
      return null;
    }
    const base = { id: ev.id, raw: ev };
    // v2 "thin" events (a v2 event destination) carry no data.object, only the related object's id
    const thin = ev as unknown as { object?: string; type: string; related_object?: { id?: string } | null };
    if (thin.object === 'v2.core.event') {
      const acct = thin.related_object?.id;
      if (thin.type.startsWith('v2.core.account') && acct?.startsWith('acct_')) return { ...base, type: 'account.updated', accountId: acct, accountState: await this.accountState(acct) };
      return { ...base, type: 'other' };
    }
    const obj = ev.data.object as unknown as Record<string, unknown>;
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
        return { ...base, type: 'account.updated', accountId: obj.id as string, accountState: await this.accountState(obj.id as string, obj) };
      default:
        return { ...base, type: 'other' };
    }
  }
}
