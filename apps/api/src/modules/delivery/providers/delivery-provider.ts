export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country?: string;
  lat?: number;
  lng?: number;
  instructions?: string;
  contactName?: string;
  contactPhone?: string;
}

export interface DeliveryQuoteInput {
  externalId: string; // our delivery job id / external order id
  pickup: Address;
  dropoff: Address;
  orderValueCents: number;
  pickupReadyAt?: Date | null;
  tipCents?: number;
}

export interface DeliveryQuote {
  providerQuoteId: string;
  feeCents: number; // what the provider charges the platform
  currency: string;
  etaMinutes: number;
  expiresAt: Date;
}

export interface DeliveryJobResult {
  providerJobId: string;
  status: 'REQUESTED' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELED' | 'FAILED';
  trackingUrl: string | null;
  etaAt: Date | null;
  driverName?: string | null;
}

export interface DeliveryProviderEvent {
  id: string;
  providerJobId: string;
  status: DeliveryJobResult['status'];
  etaAt?: Date | null;
  lat?: number;
  lng?: number;
  proofPhotoUrl?: string | null;
  driverName?: string | null;
  failureReason?: string | null;
  raw: unknown;
}

export interface DeliveryProvider {
  readonly name: string;
  quote(input: DeliveryQuoteInput): Promise<DeliveryQuote>;
  /** Accept a quote and create the job. Must be idempotent on externalId at the provider. */
  createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null; idempotencyKey: string }): Promise<DeliveryJobResult>;
  /** Used when a create call timed out: look the job up by our external id before retrying. */
  findByExternalId(externalId: string): Promise<DeliveryJobResult | null>;
  cancel(providerJobId: string): Promise<{ ok: boolean; feeCents: number }>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<DeliveryProviderEvent | null>;
}
