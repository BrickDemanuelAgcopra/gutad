import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { haversineKm } from '../../../common/utils';
import type { DeliveryJobResult, DeliveryProvider, DeliveryProviderEvent, DeliveryQuote, DeliveryQuoteInput } from './delivery-provider';

/**
 * Mock last-mile provider. Prices $5.50 + $0.90/km, quotes expire in 5 minutes.
 * The worker's `delivery.simulate` job advances mock jobs through ASSIGNED → PICKED_UP → DELIVERED.
 */
@Injectable()
export class MockDeliveryProvider implements DeliveryProvider {
  readonly name: string = 'mock';
  private jobs = new Map<string, DeliveryJobResult & { externalId: string }>();

  private distance(i: DeliveryQuoteInput) {
    if (i.pickup.lat !== undefined && i.pickup.lng !== undefined && i.dropoff.lat !== undefined && i.dropoff.lng !== undefined) {
      return haversineKm(i.pickup.lat, i.pickup.lng, i.dropoff.lat, i.dropoff.lng);
    }
    return 3;
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const km = this.distance(input);
    return { providerQuoteId: `mock_dq_${randomUUID()}`, feeCents: 550 + Math.round(km * 90), currency: 'USD', etaMinutes: 25 + Math.round(km * 3), expiresAt: new Date(Date.now() + 5 * 60_000) };
  }

  async createJob(input: DeliveryQuoteInput & { providerQuoteId: string | null; idempotencyKey: string }): Promise<DeliveryJobResult> {
    const existing = Array.from(this.jobs.values()).find((j) => j.externalId === input.externalId);
    if (existing) return existing;
    const job = { providerJobId: `mock_dj_${randomUUID()}`, status: 'REQUESTED' as const, trackingUrl: null, etaAt: new Date(Date.now() + 35 * 60_000), externalId: input.externalId };
    this.jobs.set(job.providerJobId, job);
    return job;
  }

  async findByExternalId(externalId: string): Promise<DeliveryJobResult | null> {
    return Array.from(this.jobs.values()).find((j) => j.externalId === externalId) || null;
  }

  async cancel(providerJobId: string): Promise<{ ok: boolean; feeCents: number }> {
    const j = this.jobs.get(providerJobId);
    if (!j) return { ok: true, feeCents: 0 };
    const late = j.status === 'PICKED_UP';
    j.status = 'CANCELED';
    return { ok: true, feeCents: late ? 300 : 0 };
  }

  async parseWebhook(rawBody: Buffer): Promise<DeliveryProviderEvent | null> {
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as Partial<DeliveryProviderEvent> & { id?: string };
      if (!b.id || !b.providerJobId || !b.status) return null;
      return { id: b.id, providerJobId: b.providerJobId, status: b.status, etaAt: b.etaAt ? new Date(b.etaAt) : null, lat: b.lat, lng: b.lng, proofPhotoUrl: b.proofPhotoUrl ?? null, driverName: b.driverName ?? null, failureReason: b.failureReason ?? null, raw: b };
    } catch {
      return null;
    }
  }
}
