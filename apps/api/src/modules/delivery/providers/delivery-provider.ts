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
  /** Courier R2: what the courier collects (sent to providers that accept an item list) */
  items?: { name: string; quantity: number }[];
  containsAlcohol?: boolean;
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
  status: 'REQUESTED' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELED' | 'FAILED' | 'RETURNED';
  trackingUrl: string | null;
  etaAt: Date | null;
  driverName?: string | null;
  /** Courier R2: the provider's actual fee when it reports one */
  feeCents?: number | null;
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
  /** Courier R2: actual fee / cancellation fee reported with the event */
  feeCents?: number | null;
  cancelFeeCents?: number | null;
  raw: unknown;
}

/** Thrown by `parseWebhook` when the request is not authentic (answered with 401). */
export class WebhookAuthError extends Error {}

export interface DeliveryProvider {
  readonly name: string;
  quote(input: DeliveryQuoteInput): Promise<DeliveryQuote>;
  /** Accept a quote and create the job. Must be idempotent on externalId at the provider. */
  createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null; idempotencyKey: string }): Promise<DeliveryJobResult>;
  /** Used when a create call timed out: look the job up by our external id before retrying. */
  findByExternalId(externalId: string): Promise<DeliveryJobResult | null>;
  cancel(providerJobId: string): Promise<{ ok: boolean; feeCents: number }>;
  /** Courier R2: move the pickup time after a kitchen estimate change (providers without it are skipped). */
  updatePickupTime?(providerJobId: string, at: Date): Promise<{ ok: boolean }>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<DeliveryProviderEvent | null>;
}
