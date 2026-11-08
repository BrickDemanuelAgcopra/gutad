/**
 * Payment provider abstraction. The platform always authorizes first and captures on merchant acceptance,
 * so a rejected order releases the hold instead of refunding captured money.
 */
export interface CreateIntentInput {
  amountCents: number;
  currency: string;
  /** Capture later (orders) or immediately (deposits, tickets). */
  captureMethod: 'manual' | 'automatic';
  /** Connected account that ultimately receives the funds (destination charge). */
  destinationAccountId?: string | null;
  /** Platform's take, deducted from the destination transfer. */
  applicationFeeCents?: number;
  customerEmail?: string | null;
  paymentMethodId?: string | null;
  /** When a saved card is used for a no-show guarantee charge. */
  offSession?: boolean;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface IntentResult {
  providerIntentId: string;
  clientSecret: string | null;
  status: 'requires_action' | 'authorized' | 'captured';
  authorizedCents: number;
  capturedCents: number;
  processingFeeCents: number;
  chargeId?: string | null;
}

export interface SetupResult {
  providerSetupId: string;
  clientSecret: string | null;
  paymentMethodId: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: CreateIntentInput): Promise<IntentResult>;
  /** Partial capture allowed (e.g. one item replaced). */
  capture(providerIntentId: string, amountCents: number): Promise<IntentResult>;
  cancel(providerIntentId: string): Promise<void>;
  refund(providerIntentId: string, amountCents: number, reason: string, idempotencyKey?: string): Promise<{ providerRefundId: string; status: 'succeeded' | 'pending' | 'failed' }>;
  /** Save a card for guarantees without charging. */
  createSetup(customerEmail: string | null): Promise<SetupResult>;
  /** Create a connected account for a legal seller and return an onboarding link. */
  createConnectedAccount(input: { legalName: string; email: string; country: string; returnUrl: string; refreshUrl: string }): Promise<{ accountId: string; onboardingUrl: string | null }>;
  transfer(input: { accountId: string; amountCents: number; currency: string; idempotencyKey: string; description: string }): Promise<{ transferId: string; status: 'paid' | 'pending' | 'failed'; failureReason?: string }>;
  /** Verify and parse a webhook. Returns a normalized event or null when the signature fails. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): Promise<ProviderEvent | null>;
}

export interface ProviderEvent {
  id: string;
  type: 'payment.captured' | 'payment.failed' | 'payment.refunded' | 'dispute.created' | 'dispute.closed' | 'transfer.paid' | 'transfer.failed' | 'account.updated' | 'other';
  providerIntentId?: string;
  providerTransferId?: string;
  accountId?: string;
  amountCents?: number;
  raw: unknown;
}
