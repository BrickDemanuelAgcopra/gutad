import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../../../config/config';
import type { Address, DeliveryJobResult, DeliveryProvider, DeliveryProviderEvent, DeliveryQuote, DeliveryQuoteInput } from './delivery-provider';

/**
 * Uber Direct adapter. OAuth client-credentials token (scope eats.deliveries), then
 * POST /v1/customers/{customer_id}/delivery_quotes and /deliveries.
 * Docs: https://developer.uber.com/docs/deliveries/overview
 */
@Injectable()
export class UberDirectProvider implements DeliveryProvider {
  readonly name = 'uber';
  private readonly log = new Logger(UberDirectProvider.name);
  private token: { value: string; exp: number } | null = null;

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const cfg = loadConfig();
    const res = await fetch('https://auth.uber.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.UBER_CLIENT_ID, client_secret: cfg.UBER_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'eats.deliveries' }),
    });
    if (!res.ok) throw new Error(`Uber auth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.uber.com/v1/customers/${loadConfig().UBER_CUSTOMER_ID}${path}`, { method, headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Uber ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  private addr(a: Address) {
    return JSON.stringify({ street_address: [a.line1, a.line2].filter(Boolean), city: a.city, state: a.region, zip_code: a.postalCode, country: a.country || 'US' });
  }

  private mapStatus(s: string): DeliveryJobResult['status'] {
    switch (s) {
      case 'pending':
        return 'REQUESTED';
      case 'pickup':
        return 'ASSIGNED';
      case 'pickup_complete':
      case 'dropoff':
        return 'PICKED_UP';
      case 'delivered':
        return 'DELIVERED';
      case 'canceled':
        return 'CANCELED';
      default:
        return 'FAILED';
    }
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const q = await this.call<Record<string, unknown>>('POST', '/delivery_quotes', { pickup_address: this.addr(input.pickup), dropoff_address: this.addr(input.dropoff), manifest_total_value: input.orderValueCents, external_store_id: input.pickup.contactName });
    return { providerQuoteId: String(q.id), feeCents: Number(q.fee || 0), currency: String(q.currency || 'USD'), etaMinutes: Number(q.duration || 40), expiresAt: q.expires ? new Date(String(q.expires)) : new Date(Date.now() + 5 * 60_000) };
  }

  async createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null; idempotencyKey: string }): Promise<DeliveryJobResult> {
    const d = await this.call<Record<string, unknown>>('POST', '/deliveries', {
      quote_id: input.providerQuoteId,
      external_id: input.externalId,
      idempotency_key: input.idempotencyKey,
      pickup_address: this.addr(input.pickup),
      pickup_name: input.pickup.contactName || 'Restaurant',
      pickup_phone_number: input.pickup.contactPhone || '+10000000000',
      dropoff_address: this.addr(input.dropoff),
      dropoff_name: input.dropoff.contactName || 'Customer',
      dropoff_phone_number: input.dropoff.contactPhone || '+10000000000',
      dropoff_notes: input.dropoff.instructions,
      manifest_items: [{ name: 'Order', quantity: 1, size: 'medium' }],
      manifest_total_value: input.orderValueCents,
      tip: input.tipCents || 0,
    });
    return { providerJobId: String(d.id), status: this.mapStatus(String(d.status)), trackingUrl: (d.tracking_url as string) || null, etaAt: d.dropoff_eta ? new Date(String(d.dropoff_eta)) : null };
  }

  async findByExternalId(externalId: string): Promise<DeliveryJobResult | null> {
    try {
      const list = await this.call<{ data: Record<string, unknown>[] }>('GET', `/deliveries?external_id=${encodeURIComponent(externalId)}`);
      const d = list.data?.[0];
      return d ? { providerJobId: String(d.id), status: this.mapStatus(String(d.status)), trackingUrl: (d.tracking_url as string) || null, etaAt: d.dropoff_eta ? new Date(String(d.dropoff_eta)) : null } : null;
    } catch {
      return null;
    }
  }

  async cancel(providerJobId: string) {
    try {
      await this.call('POST', `/deliveries/${providerJobId}/cancel`);
      return { ok: true, feeCents: 0 };
    } catch (e) {
      this.log.warn((e as Error).message);
      return { ok: false, feeCents: 0 };
    }
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<DeliveryProviderEvent | null> {
    const secret = loadConfig().UBER_CLIENT_SECRET;
    const sig = headers['x-uber-signature'];
    if (secret && sig) {
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      if (expected !== sig) return null;
    }
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      const data = (b.data as Record<string, unknown>) || b;
      if (!data.id) return null;
      return { id: String(b.id || `${data.id}:${data.status}`), providerJobId: String(data.id), status: this.mapStatus(String(data.status)), etaAt: data.dropoff_eta ? new Date(String(data.dropoff_eta)) : null, proofPhotoUrl: null, driverName: ((data.courier as { name?: string })?.name) || null, raw: b };
    } catch {
      return null;
    }
  }
}
