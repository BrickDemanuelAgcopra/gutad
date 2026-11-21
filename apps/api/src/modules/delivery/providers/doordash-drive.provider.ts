import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../../../config/config';
import { WebhookAuthError, type Address, type DeliveryJobResult, type DeliveryProvider, type DeliveryProviderEvent, type DeliveryQuote, type DeliveryQuoteInput } from './delivery-provider';

/** A DoorDash API error with its HTTP status (409 = the external delivery id already exists). */
export class DoorDashError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * DoorDash Drive (v2) adapter. Auth is a short-lived HS256 JWT built from developer_id / key_id / signing_secret.
 * Docs: https://developer.doordash.com/en-US/docs/drive/overview/ and the Drive API reference.
 *
 * Courier R2:
 * - Checkout prices with `POST /drive/v2/quotes` (a 5-minute quote under a throwaway id). The delivery itself is created
 *   with `POST /drive/v2/deliveries` under our job id when the order is accepted, because the quote has expired by then
 *   and was made under another id. A 409 (id already used) means a lost response: we look the delivery up.
 * - Items, the alcohol flag, pickup instructions and the kitchen's ready time go with the delivery. The ready time is
 *   moved with `PATCH /drive/v2/deliveries/{id}` when the kitchen estimate changes.
 * - Webhooks must carry the Authorization value set in the Developer Portal (`DOORDASH_WEBHOOK_SECRET`).
 * - Actual and cancellation fees are read back for reconciliation.
 */
@Injectable()
export class DoorDashDriveProvider implements DeliveryProvider {
  readonly name = 'doordash';
  private readonly log = new Logger(DoorDashDriveProvider.name);
  private readonly base = 'https://openapi.doordash.com';
  /** replaceable in tests */
  fetchImpl: typeof fetch = (...a) => fetch(...a);

  private jwt(): string {
    const cfg = loadConfig();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ aud: 'doordash', iss: cfg.DOORDASH_DEVELOPER_ID, kid: cfg.DOORDASH_KEY_ID, exp: now + 300, iat: now })).toString('base64url');
    const sig = createHmac('sha256', Buffer.from(cfg.DOORDASH_SIGNING_SECRET, 'base64url')).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { Authorization: `Bearer ${this.jwt()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text();
      throw new DoorDashError(`DoorDash ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as T;
  }

  private addr(a: Address): string {
    return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country || 'US'].filter(Boolean).join(', ');
  }

  /** E.164-ish phone or DoorDash rejects the request; a placeholder keeps sandbox calls working when none is on file. */
  private phone(p?: string) {
    const digits = (p || '').replace(/[^\d+]/g, '');
    if (!digits) return '+10000000000';
    return digits.startsWith('+') ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  }

  /**
   * DoorDash `delivery_status` → our status. Return legs stay PICKED_UP (the dasher still has the food) until
   * `returned`. Unknown values map to null and are ignored instead of failing the job.
   */
  mapStatus(s: string): DeliveryJobResult['status'] | null {
    switch (s) {
      case 'quote':
      case 'created':
      case 'confirmed':
        return 'REQUESTED';
      case 'enroute_to_pickup':
      case 'arrived_at_pickup':
        return 'ASSIGNED';
      case 'picked_up':
      case 'enroute_to_dropoff':
      case 'arrived_at_dropoff':
      case 'enroute_to_return':
      case 'arrived_at_return':
        return 'PICKED_UP';
      case 'delivered':
        return 'DELIVERED';
      case 'returned':
        return 'RETURNED';
      case 'cancelled':
      case 'canceled':
        return 'CANCELED';
      default:
        return null;
    }
  }

  /** Webhook `event_name` → status, for events that come without a `delivery_status`. */
  private eventStatus(name: string): DeliveryJobResult['status'] | null {
    const m: Record<string, DeliveryJobResult['status']> = {
      DELIVERY_CREATED: 'REQUESTED', DASHER_CONFIRMED: 'ASSIGNED', DASHER_ENROUTE_TO_PICKUP: 'ASSIGNED', DASHER_CONFIRMED_PICKUP_ARRIVAL: 'ASSIGNED',
      DASHER_PICKED_UP: 'PICKED_UP', DASHER_ENROUTE_TO_DROPOFF: 'PICKED_UP', DASHER_CONFIRMED_DROPOFF_ARRIVAL: 'PICKED_UP', DASHER_DROPPED_OFF: 'DELIVERED',
      DELIVERY_RETURN_INITIALIZED: 'PICKED_UP', DASHER_CONFIRMED_RETURN_ARRIVAL: 'PICKED_UP', DELIVERY_RETURNED: 'RETURNED', DELIVERY_CANCELLED: 'CANCELED',
    };
    return m[name] ?? null;
  }

  private cents(v: unknown): number | null {
    const n = Number(v);
    return v === undefined || v === null || !Number.isFinite(n) ? null : Math.round(n);
  }

  private map(d: Record<string, unknown>): DeliveryJobResult {
    return {
      providerJobId: d.external_delivery_id as string,
      status: this.mapStatus(String(d.delivery_status)) ?? 'REQUESTED',
      trackingUrl: (d.tracking_url as string) || null,
      etaAt: d.dropoff_time_estimated ? new Date(d.dropoff_time_estimated as string) : null,
      driverName: (d.dasher_name as string) || null,
      feeCents: this.cents(d.fee),
    };
  }

  /** The delivery body shared by quotes and creates. */
  body(input: DeliveryQuoteInput) {
    return {
      external_delivery_id: input.externalId,
      pickup_address: this.addr(input.pickup),
      pickup_phone_number: this.phone(input.pickup.contactPhone),
      pickup_business_name: input.pickup.contactName,
      pickup_instructions: input.pickup.instructions || undefined,
      dropoff_address: this.addr(input.dropoff),
      dropoff_phone_number: this.phone(input.dropoff.contactPhone),
      dropoff_contact_given_name: input.dropoff.contactName,
      dropoff_instructions: input.dropoff.instructions || undefined,
      ...(input.dropoff.lat !== undefined && input.dropoff.lng !== undefined ? { dropoff_location: { lat: input.dropoff.lat, lng: input.dropoff.lng } } : {}),
      order_value: input.orderValueCents,
      tip: input.tipCents || 0,
      pickup_time: input.pickupReadyAt && input.pickupReadyAt.getTime() > Date.now() ? input.pickupReadyAt.toISOString() : undefined,
      items: input.items?.length ? input.items.map((i) => ({ name: i.name.slice(0, 100), quantity: i.quantity })) : undefined,
      order_contains: input.containsAlcohol ? { alcohol: true } : undefined,
      action_if_undeliverable: 'return_to_pickup',
    };
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const d = await this.call<Record<string, unknown>>('POST', '/drive/v2/quotes', this.body(input));
    const eta = new Date(String(d.dropoff_time_estimated)).getTime();
    return { providerQuoteId: input.externalId, feeCents: Number(d.fee || 0), currency: String(d.currency || 'USD'), etaMinutes: Math.max(10, Math.round(((Number.isFinite(eta) ? eta : Date.now() + 40 * 60_000) - Date.now()) / 60_000)), expiresAt: new Date(Date.now() + 5 * 60_000) };
  }

  async createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null }): Promise<DeliveryJobResult> {
    try {
      return this.map(await this.call<Record<string, unknown>>('POST', '/drive/v2/deliveries', this.body(input)));
    } catch (e) {
      // already created under this id (a retry after a lost response): return the existing delivery
      if (e instanceof DoorDashError && e.status === 409) {
        const found = await this.findByExternalId(input.externalId);
        if (found) return found;
      }
      throw e;
    }
  }

  async findByExternalId(externalId: string): Promise<DeliveryJobResult | null> {
    try {
      return this.map(await this.call<Record<string, unknown>>('GET', `/drive/v2/deliveries/${encodeURIComponent(externalId)}`));
    } catch {
      return null;
    }
  }

  async updatePickupTime(providerJobId: string, at: Date): Promise<{ ok: boolean }> {
    if (at.getTime() <= Date.now()) return { ok: true }; // ready now: nothing to move
    try {
      await this.call('PATCH', `/drive/v2/deliveries/${encodeURIComponent(providerJobId)}`, { pickup_time: at.toISOString() });
      return { ok: true };
    } catch (e) {
      this.log.warn((e as Error).message);
      return { ok: false };
    }
  }

  async cancel(providerJobId: string): Promise<{ ok: boolean; feeCents: number }> {
    try {
      const d = await this.call<Record<string, unknown>>('PUT', `/drive/v2/deliveries/${encodeURIComponent(providerJobId)}/cancel`);
      return { ok: true, feeCents: this.cents(d.cancellation_fee) ?? 0 };
    } catch (e) {
      this.log.warn((e as Error).message);
      return { ok: false, feeCents: 0 };
    }
  }

  /** Constant-time check of the Authorization header against `DOORDASH_WEBHOOK_SECRET`. */
  private authentic(headers: Record<string, string | undefined>) {
    const cfg = loadConfig();
    const secret = cfg.DOORDASH_WEBHOOK_SECRET;
    if (!secret) return cfg.NODE_ENV !== 'production'; // unset: accepted in development only
    const got = Buffer.from(headers.authorization || headers.Authorization || '');
    const want = Buffer.from(secret);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined> = {}): Promise<DeliveryProviderEvent | null> {
    if (!this.authentic(headers)) throw new WebhookAuthError('DoorDash webhook: bad or missing Authorization header');
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!b.external_delivery_id) return null;
    const status = (b.delivery_status ? this.mapStatus(String(b.delivery_status)) : null) ?? this.eventStatus(String(b.event_name || ''));
    const loc = (b.dasher_location || null) as { lat?: number; lng?: number } | null;
    const at = String(b.created_at || b.updated_at || '');
    return {
      id: String(b.event_id || `${b.external_delivery_id}:${b.event_name || b.delivery_status}:${at}`),
      providerJobId: String(b.external_delivery_id),
      // informational events (no status we track) are recorded and ignored: REQUESTED never moves a dispatched job back
      status: status ?? 'REQUESTED',
      etaAt: b.dropoff_time_estimated ? new Date(b.dropoff_time_estimated as string) : null,
      lat: loc?.lat, lng: loc?.lng,
      proofPhotoUrl: (b.dropoff_verification_image_url as string) || null,
      driverName: (b.dasher_name as string) || null,
      failureReason: (b.cancellation_reason as string) || null,
      feeCents: this.cents(b.fee),
      cancelFeeCents: this.cents(b.cancellation_fee),
      raw: b,
    };
  }
}
