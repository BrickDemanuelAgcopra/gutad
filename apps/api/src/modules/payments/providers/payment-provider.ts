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
  /**
   * Create a connected account for a legal seller and return an onboarding link.
   * With `existingAccountId`, no account is created: a fresh onboarding link is issued for that account
   * (onboarding left unfinished, an expired link, or requirements to fix).
   */
  createConnectedAccount(input: { legalName: string; email: string; country: string; returnUrl: string; refreshUrl: string; existingAccountId?: string | null }): Promise<{ accountId: string; onboardingUrl: string | null }>;
  transfer(input: { accountId: string; amountCents: number; currency: string; idempotencyKey: string; description: string }): Promise<{ transferId: string; status: 'paid' | 'pending' | 'failed'; failureReason?: string }>;
  /** Verify and parse a webhook. Returns a normalized event or null when the signature fails. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): Promise<ProviderEvent | null>;
  // 10.3-P / 18.9-S live-processor tokenization (optional: the mock processor uses test cards instead)
  /** SetupIntent for a saved card on the processor customer (created when `customerRef` is null). */
  setupForCustomer?(input: { email: string | null; customerRef: string | null; idempotencyKey?: string }): Promise<SetupResult & { customerRef: string | null }>;
  /** Processor-hosted card setup page (for apps without the native sheet); returns its URL. */
  hostedSetup?(input: { email: string | null; customerRef: string | null; successUrl: string; cancelUrl: string }): Promise<{ sessionId: string; url: string; customerRef: string | null }>;
  /** The card saved by a finished hosted setup, or null while it is not complete. */
  completeHostedSetup?(sessionId: string): Promise<{ paymentMethodId: string; customerRef: string | null } | null>;
  /**
   * Attach a card tokenized for a one-off payment to the processor customer (created when `customerRef` is null), so it
   * can be charged again. Fails when the token was already spent on a payment without a customer.
   */
  attachToCustomer?(input: { paymentMethodId: string; email: string | null; customerRef: string | null }): Promise<{ customerRef: string }>;
  /** Masked details of a tokenized card, as the processor reports them. */
  describePaymentMethod?(paymentMethodId: string): Promise<CardDetails | null>;
}

export interface CardDetails { paymentMethodId: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; customerRef: string | null }

export interface ProviderEvent {
  id: string;
  type: 'payment.captured' | 'payment.failed' | 'payment.refunded' | 'dispute.created' | 'dispute.closed' | 'transfer.paid' | 'transfer.failed' | 'account.updated' | 'other';
  providerIntentId?: string;
  providerTransferId?: string;
  accountId?: string;
  /** `account.updated`: whether the connected account can receive the platform's transfers, resolved by the provider. */
  accountState?: 'COMPLETE' | 'PENDING' | 'RESTRICTED';
  amountCents?: number;
  raw: unknown;
}
