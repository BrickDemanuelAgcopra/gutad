import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { bps } from '../../../common/utils';
import type { CreateIntentInput, IntentResult, PaymentProvider, ProviderEvent, SetupResult } from './payment-provider';

/**
 * Mock processor for pilots and tests. Behaves like a card processor:
 * 2.9% + 30¢ processing fee, authorize → capture, refunds, transfers.
 * Card numbers ending in 0002 are declined, to exercise failure paths.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private intents = new Map<string, { amount: number; captured: number; status: IntentResult['status'] }>();

  private fee(amount: number) {
    return amount > 0 ? bps(amount, 290) + 30 : 0;
  }

  async createIntent(input: CreateIntentInput): Promise<IntentResult> {
    if (input.paymentMethodId?.endsWith('0002')) {
      throw new Error('Card declined');
    }
    const id = `mock_pi_${randomUUID()}`;
    const status: IntentResult['status'] = input.captureMethod === 'automatic' ? 'captured' : 'authorized';
    const captured = status === 'captured' ? input.amountCents : 0;
    this.intents.set(id, { amount: input.amountCents, captured, status });
    return { providerIntentId: id, clientSecret: `${id}_secret`, status, authorizedCents: input.amountCents, capturedCents: captured, processingFeeCents: this.fee(captured), chargeId: `mock_ch_${id.slice(8, 16)}` };
  }

  async capture(providerIntentId: string, amountCents: number): Promise<IntentResult> {
    const i = this.intents.get(providerIntentId) || { amount: amountCents, captured: 0, status: 'authorized' as const };
    i.captured = amountCents;
    i.status = 'captured';
    this.intents.set(providerIntentId, i);
    return { providerIntentId, clientSecret: null, status: 'captured', authorizedCents: i.amount, capturedCents: amountCents, processingFeeCents: this.fee(amountCents), chargeId: `mock_ch_${providerIntentId.slice(8, 16)}` };
  }

  async cancel(providerIntentId: string): Promise<void> {
    this.intents.delete(providerIntentId);
  }

  async refund(providerIntentId: string, amountCents: number): Promise<{ providerRefundId: string; status: 'succeeded' | 'pending' | 'failed' }> {
    return { providerRefundId: `mock_re_${randomUUID()}`, status: amountCents > 0 ? 'succeeded' : 'failed' };
  }

  async createSetup(): Promise<SetupResult> {
    const id = `mock_seti_${randomUUID()}`;
    return { providerSetupId: id, clientSecret: `${id}_secret`, paymentMethodId: `mock_pm_${randomUUID().slice(0, 8)}4242` };
  }

  async createConnectedAccount(input: { legalName: string }): Promise<{ accountId: string; onboardingUrl: string | null }> {
    return { accountId: `mock_acct_${randomUUID().slice(0, 12)}`, onboardingUrl: null };
  }

  async transfer(input: { accountId: string; amountCents: number }): Promise<{ transferId: string; status: 'paid' | 'pending' | 'failed'; failureReason?: string }> {
    if (!input.accountId) return { transferId: '', status: 'failed', failureReason: 'No payout account on file' };
    if (input.amountCents <= 0) return { transferId: '', status: 'failed', failureReason: 'Non-positive amount' };
    return { transferId: `mock_tr_${randomUUID()}`, status: 'paid' };
  }

  async parseWebhook(rawBody: Buffer): Promise<ProviderEvent | null> {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Partial<ProviderEvent> & { id?: string; type?: ProviderEvent['type'] };
      if (!body.id || !body.type) return null;
      return { id: body.id, type: body.type, providerIntentId: body.providerIntentId, providerTransferId: body.providerTransferId, accountId: body.accountId, amountCents: body.amountCents, raw: body };
    } catch {
      return null;
    }
  }
}
