import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig } from '../../../config/config';
import type { Address, DeliveryJobResult, DeliveryProvider, DeliveryProviderEvent, DeliveryQuote, DeliveryQuoteInput } from './delivery-provider';

/**
 * DoorDash Drive (v2) adapter. Auth is a short-lived HS256 JWT built from developer_id / key_id / signing_secret.
 * Docs: https://developer.doordash.com/en-US/docs/drive/overview/pricing_payment/ and the Drive API reference.
 * Endpoints: POST /drive/v2/quotes, POST /drive/v2/quotes/{id}/accept, GET /drive/v2/deliveries/{id}, PUT /drive/v2/deliveries/{id}/cancel
 */
@Injectable()
export class DoorDashDriveProvider implements DeliveryProvider {
  readonly name = 'doordash';
  private readonly log = new Logger(DoorDashDriveProvider.name);
  private readonly base = 'https://openapi.doordash.com';

  private jwt(): string {
    const cfg = loadConfig();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ aud: 'doordash', iss: cfg.DOORDASH_DEVELOPER_ID, kid: cfg.DOORDASH_KEY_ID, exp: now + 300, iat: now })).toString('base64url');
    const sig = createHmac('sha256', Buffer.from(cfg.DOORDASH_SIGNING_SECRET, 'base64url')).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { method, headers: { Authorization: `Bearer ${this.jwt()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DoorDash ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  private addr(a: Address): string {
    return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country || 'US'].filter(Boolean).join(', ');
  }

  private mapStatus(s: string): DeliveryJobResult['status'] {
    switch (s) {
      case 'created':
      case 'confirmed':
        return 'REQUESTED';
      case 'enroute_to_pickup':
      case 'arrived_at_pickup':
        return 'ASSIGNED';
      case 'picked_up':
      case 'enroute_to_dropoff':
      case 'arrived_at_dropoff':
        return 'PICKED_UP';
      case 'delivered':
        return 'DELIVERED';
      case 'cancelled':
        return 'CANCELED';
      default:
        return 'FAILED';
    }
  }

  private map(d: Record<string, unknown>): DeliveryJobResult {
    return {
      providerJobId: d.external_delivery_id as string,
      status: this.mapStatus(String(d.delivery_status)),
      trackingUrl: (d.tracking_url as string) || null,
      etaAt: d.dropoff_time_estimated ? new Date(d.dropoff_time_estimated as string) : null,
      driverName: ((d.dasher_name as string) || null),
    };
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const d = await this.call<Record<string, unknown>>('POST', '/drive/v2/quotes', {
      external_delivery_id: input.externalId,
      pickup_address: this.addr(input.pickup),
      pickup_phone_number: input.pickup.contactPhone || '+10000000000',
      pickup_business_name: input.pickup.contactName,
      dropoff_address: this.addr(input.dropoff),
      dropoff_phone_number: input.dropoff.contactPhone || '+10000000000',
      dropoff_contact_given_name: input.dropoff.contactName,
      dropoff_instructions: input.dropoff.instructions,
      order_value: input.orderValueCents,
      tip: input.tipCents || 0,
      pickup_time: input.pickupReadyAt?.toISOString(),
    });
    return { providerQuoteId: input.externalId, feeCents: Number(d.fee || 0), currency: String(d.currency || 'USD'), etaMinutes: Math.max(10, Math.round(((new Date(String(d.dropoff_time_estimated)).getTime() || Date.now() + 40 * 60_000) - Date.now()) / 60_000)), expiresAt: new Date(Date.now() + 5 * 60_000) };
  }

  async createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null }): Promise<DeliveryJobResult> {
    const d = await this.call<Record<string, unknown>>('POST', `/drive/v2/quotes/${encodeURIComponent(input.externalId)}/accept`, { tip: input.tipCents || 0 });
    return this.map(d);
  }

  async findByExternalId(externalId: string): Promise<DeliveryJobResult | null> {
    try {
      return this.map(await this.call<Record<string, unknown>>('GET', `/drive/v2/deliveries/${encodeURIComponent(externalId)}`));
    } catch {
      return null;
    }
  }

  async cancel(providerJobId: string): Promise<{ ok: boolean; feeCents: number }> {
    try {
      await this.call('PUT', `/drive/v2/deliveries/${encodeURIComponent(providerJobId)}/cancel`);
      return { ok: true, feeCents: 0 };
    } catch (e) {
      this.log.warn((e as Error).message);
      return { ok: false, feeCents: 0 };
    }
  }

  async parseWebhook(rawBody: Buffer): Promise<DeliveryProviderEvent | null> {
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      if (!b.external_delivery_id) return null;
      return { id: String(b.event_id || `${b.external_delivery_id}:${b.delivery_status}:${b.updated_at || randomUUID()}`), providerJobId: String(b.external_delivery_id), status: this.mapStatus(String(b.delivery_status)), etaAt: b.dropoff_time_estimated ? new Date(String(b.dropoff_time_estimated)) : null, lat: b.dasher_location ? Number((b.dasher_location as { lat: number }).lat) : undefined, lng: b.dasher_location ? Number((b.dasher_location as { lng: number }).lng) : undefined, proofPhotoUrl: (b.dropoff_verification_image_url as string) || null, driverName: (b.dasher_name as string) || null, failureReason: (b.cancellation_reason as string) || null, raw: b };
    } catch {
      return null;
    }
  }
}
