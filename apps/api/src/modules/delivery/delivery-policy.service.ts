import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { bearing, bearingDiff, NO_BATCH_CATEGORIES, DEFAULT_BATCHING, DEFAULT_DISPATCH, DEFAULT_PAY_POLICY, DEFAULT_READY_SYNC, type BatchingConfig, type CourierPayPolicy, type DispatchConfig, type Manifest, type ManifestBrand, type ReadySyncConfig } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { brands, courierMarketPolicies, deliveryJobs, locations, orderLines, orders, packingTasks, regions } from '../../db/schema';
import { SettingsService } from '../../core/settings.service';
import { AuditService } from '../../core/audit.service';
import { assertCan, JwtPayload } from '../../common/auth';
import { haversineKm } from '../../common/utils';
import type { Address } from './providers/delivery-provider';

type Job = typeof deliveryJobs.$inferSelect;
export interface Market { id: string; name: string; version: number }
export interface EffectivePolicy { market: Market | null; pay: CourierPayPolicy; batching: BatchingConfig; readySync: ReadySyncConfig; dispatch: DispatchConfig }
/** What the batching rules need to know about a job. */
export interface BatchCandidate { id: string; status: string; kitchenKey: string; pickup: Address; dropoff: Address; requirements: string[]; readyAt: Date | null }

const PAY_KEYS: (keyof CourierPayPolicy)[] = ['baseCents', 'perKmCents', 'perMinuteCents', 'waitingGraceMinutes', 'waitingPerMinuteCents', 'returnCents', 'cancelAfterArrivalCents', 'holdHours', 'waitingCapMinutes', 'dropoffGraceMinutes'];
const BATCH_NUM_KEYS: (keyof BatchingConfig)[] = ['maxOrders', 'readyWindowMinutes', 'maxBearingDiff', 'maxExtraMinutes', 'maxDropoffSpreadKm'];
const BATCH_BOOL_KEYS: (keyof BatchingConfig)[] = ['enabled', 'allowMixedTemperature'];

/**
 * Courier R2: markets (operating regions with a courier policy), the effective pay / batching / ready-sync config for a
 * job, the batching rules, and multi-brand manifests.
 */
@Injectable()
export class DeliveryPolicyService {
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  globalPay() { return this.settings.getObject<CourierPayPolicy>('delivery.pay', DEFAULT_PAY_POLICY); }
  globalBatching() { return this.settings.getObject<BatchingConfig>('delivery.batching', DEFAULT_BATCHING); }
  readySync() { return this.settings.getObject<ReadySyncConfig>('delivery.readySync', DEFAULT_READY_SYNC); }
  dispatch() { return this.settings.getObject<DispatchConfig>('delivery.dispatch', DEFAULT_DISPATCH); }

  /** The market for a region: the region itself or its nearest ancestor that has a policy row. */
  async marketForRegion(regionId: string | null | undefined, tx: DbOrTx = this.db): Promise<(Market & { pay: Partial<CourierPayPolicy>; batching: Partial<BatchingConfig> }) | null> {
    if (!regionId) return null;
    const [rs, ps] = await Promise.all([tx.select({ id: regions.id, name: regions.name, parentId: regions.parentId }).from(regions), tx.select().from(courierMarketPolicies)]);
    const byId = new Map(rs.map((r) => [r.id, r]));
    const policy = new Map(ps.map((p) => [p.regionId, p]));
    const seen = new Set<string>();
    for (let r = byId.get(regionId); r && !seen.has(r.id); r = r.parentId ? byId.get(r.parentId) : undefined) {
      seen.add(r.id);
      const p = policy.get(r.id);
      if (p) return { id: r.id, name: r.name, version: p.version, pay: p.pay as Partial<CourierPayPolicy>, batching: p.batching as Partial<BatchingConfig> };
    }
    return null;
  }

  async effectiveForLocation(locationId: string, tx: DbOrTx = this.db): Promise<EffectivePolicy> {
    const [loc] = await tx.select({ regionId: locations.regionId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    return this.effectiveForRegion(loc?.regionId ?? null, tx);
  }

  async effectiveForRegion(regionId: string | null, tx: DbOrTx = this.db): Promise<EffectivePolicy> {
    const [pay, batching, readySync, dispatch, m] = await Promise.all([this.globalPay(), this.globalBatching(), this.readySync(), this.dispatch(), this.marketForRegion(regionId, tx)]);
    return {
      market: m ? { id: m.id, name: m.name, version: m.version } : null,
      pay: { ...pay, ...(m?.pay ?? {}) },
      batching: { ...batching, ...(m?.batching ?? {}) },
      readySync, dispatch,
    };
  }

  /**
   * Why two jobs can't be carried together (empty = batchable). `carried` is the job the courier already has;
   * `next` is the one being offered.
   */
  batchReasons(carried: BatchCandidate, next: BatchCandidate, cfg: BatchingConfig, travelMinutesPerKm: number): string[] {
    const why: string[] = [];
    if (!cfg.enabled) return ['Batching is turned off'];
    if (carried.status !== 'ASSIGNED') why.push('The first order is already picked up');
    if (carried.kitchenKey !== next.kitchenKey) why.push('Different pickup kitchens');
    for (const r of cfg.excludeRequirements) if (carried.requirements.includes(r) || next.requirements.includes(r)) why.push(`${r} orders are not batched`);
    // Courier R4: specialised categories ride alone (temperature-controlled may still batch)
    for (const r of NO_BATCH_CATEGORIES) if (!cfg.excludeRequirements.includes(r) && (carried.requirements.includes(r) || next.requirements.includes(r))) why.push(`${r} orders are not batched`);
    const temp = (j: BatchCandidate) => (j.requirements.includes('COLD_BAG') ? 'COLD' : j.requirements.includes('HOT_BAG') ? 'HOT' : null);
    if (!cfg.allowMixedTemperature && temp(carried) && temp(next) && temp(carried) !== temp(next)) why.push('Hot and cold orders are not mixed');
    const p = carried.pickup, a = carried.dropoff, b = next.dropoff;
    if (p.lat === undefined || p.lng === undefined || a.lat === undefined || a.lng === undefined || b.lat === undefined || b.lng === undefined) {
      why.push('Missing coordinates');
    } else {
      const diff = bearingDiff(bearing({ lat: p.lat, lng: p.lng }, { lat: a.lat, lng: a.lng }), bearing({ lat: p.lat, lng: p.lng }, { lat: b.lat, lng: b.lng }));
      if (diff > cfg.maxBearingDiff) why.push(`Different directions (${Math.round(diff)}° apart, max ${cfg.maxBearingDiff}°)`);
      const spread = haversineKm(a.lat, a.lng, b.lat, b.lng);
      if (spread > cfg.maxDropoffSpreadKm) why.push(`Drop-offs ${spread.toFixed(1)} km apart (max ${cfg.maxDropoffSpreadKm} km)`);
      const extra = spread * travelMinutesPerKm;
      if (extra > cfg.maxExtraMinutes) why.push(`Detour of ${Math.round(extra)} min (max ${cfg.maxExtraMinutes})`);
    }
    if (carried.readyAt && next.readyAt && Math.abs(carried.readyAt.getTime() - next.readyAt.getTime()) > cfg.readyWindowMinutes * 60_000) why.push(`Ready times more than ${cfg.readyWindowMinutes} min apart`);
    return why;
  }

  /** Batching candidate view of a job (kitchen key = shared kitchen, else the location). */
  async candidate(job: Job, tx: DbOrTx = this.db): Promise<BatchCandidate> {
    const [loc] = await tx.select({ kitchenId: locations.kitchenId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    return { id: job.id, status: job.status, kitchenKey: loc?.kitchenId ?? `location:${job.locationId}`, pickup: job.pickupAddress as Address, dropoff: job.dropoffAddress as Address, requirements: job.requirements, readyAt: job.estReadyAt };
  }

  /**
   * Multi-brand manifest for a job (or jobs carried together): per brand, the order, its items,
   * bags and handling. Lines without a brand are listed under their location. Bags come from packing; an order with
   * several brands splits its bags across them (at least one each).
   */
  async manifest(jobs: Job[], tx: DbOrTx = this.db): Promise<Manifest> {
    const orderIds = jobs.map((j) => j.orderId).filter((x): x is string => !!x);
    const out: ManifestBrand[] = [];
    const handling = new Set<string>();
    let hasAlcohol = jobs.some((j) => j.requirements.includes('ALCOHOL'));
    if (orderIds.length) {
      const [os, ls, packs] = await Promise.all([
        tx.select({ id: orders.id, number: orders.number, locationId: orders.locationId, locName: locations.name }).from(orders).innerJoin(locations, eq(locations.id, orders.locationId)).where(inArray(orders.id, orderIds)),
        tx.select({ orderId: orderLines.orderId, brandId: orderLines.brandId, brandName: brands.name, name: orderLines.name, quantity: orderLines.quantity, handling: orderLines.handling }).from(orderLines).leftJoin(brands, eq(brands.id, orderLines.brandId)).where(and(inArray(orderLines.orderId, orderIds), notInArray(orderLines.status, ['UNAVAILABLE', 'CREDITED', 'REPLACED']))),
        tx.select().from(packingTasks).where(inArray(packingTasks.orderId, orderIds)),
      ]);
      for (const o of os) {
        const pack = packs.find((p) => p.orderId === o.id);
        const mine = ls.filter((l) => l.orderId === o.id);
        const keys = Array.from(new Set(mine.map((l) => l.brandId ?? `location:${o.locationId}`)));
        if (!keys.length) keys.push(`location:${o.locationId}`);
        const bags = Math.max(pack?.bagCount ?? 1, 1);
        const codes = ((pack?.bags ?? []) as { code?: string }[]).map((b) => b.code).filter((c): c is string => !!c);
        keys.forEach((key, i) => {
          const lines = mine.filter((l) => (l.brandId ?? `location:${o.locationId}`) === key);
          // split bags evenly, the first brands taking any remainder, never fewer than one each
          const share = Math.max(1, Math.floor(bags / keys.length) + (i < bags % keys.length ? 1 : 0));
          for (const l of lines) for (const h of l.handling ?? []) handling.add(h);
          out.push({
            brandKey: key, brandName: lines.find((l) => l.brandName)?.brandName ?? o.locName, orderId: o.id, orderNumber: o.number,
            items: lines.map((l) => ({ name: l.name, quantity: l.quantity, handling: l.handling ?? [] })), bagCount: share,
            bagCodes: keys.length === 1 ? codes : [],
          });
        });
        for (const h of pack?.handling ?? []) handling.add(h);
      }
    }
    if (handling.has('ALCOHOL')) hasAlcohol = true;
    return { brands: out, totals: { items: out.reduce((s, b) => s + b.items.reduce((t, i) => t + i.quantity, 0), 0), bags: out.reduce((s, b) => s + b.bagCount, 0) }, handling: Array.from(handling).sort(), hasAlcohol };
  }

  /** Courier R2 pickup check for a manifest with several brands: each brand present with its bags, seals intact. */
  checkManifest(m: Manifest | null, brandsSeen: { brandKey: string; bagCount: number; sealIntact: boolean }[] | undefined): { ok: true } | { ok: false; missing: string[]; broken: string[] } {
    if (!m || m.brands.length <= 1) return { ok: true };
    const seen = new Map((brandsSeen ?? []).map((b) => [b.brandKey, b]));
    const missing = m.brands.filter((b) => (seen.get(b.brandKey)?.bagCount ?? 0) < b.bagCount).map((b) => b.brandKey);
    const broken = m.brands.filter((b) => seen.get(b.brandKey)?.sealIntact === false).map((b) => b.brandKey);
    return missing.length || broken.length ? { ok: false, missing, broken } : { ok: true };
  }

  // ───── admin ─────

  async adminPolicies(user: JwtPayload) {
    assertCan(user, 'delivery.read', 'ops.read');
    const [pay, batching, readySync, rows, rs] = await Promise.all([this.globalPay(), this.globalBatching(), this.readySync(), this.db.select().from(courierMarketPolicies), this.db.select({ id: regions.id, name: regions.name, parentId: regions.parentId }).from(regions).orderBy(regions.name)]);
    const name = new Map(rs.map((r) => [r.id, r.name]));
    return {
      global: { pay, batching, readySync },
      markets: rows.map((r) => ({ regionId: r.regionId, regionName: name.get(r.regionId) ?? '(deleted region)', pay: r.pay, batching: r.batching, version: r.version, updatedAt: r.updatedAt, updatedBy: r.updatedById })),
      regions: rs,
    };
  }

  /** Only known keys with sane values are kept; anything else is a 400 so a typo never silently does nothing. */
  private clean(pay: Record<string, unknown> = {}, batching: Record<string, unknown> = {}) {
    const p: Partial<CourierPayPolicy> = {};
    for (const [k, v] of Object.entries(pay)) {
      if (!PAY_KEYS.includes(k as keyof CourierPayPolicy)) throw new BadRequestException(`Unknown pay setting "${k}"`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) throw new BadRequestException(`${k} must be a number ≥ 0`);
      (p as Record<string, number>)[k] = Math.round(v);
    }
    const b: Partial<BatchingConfig> = {};
    for (const [k, v] of Object.entries(batching)) {
      if (BATCH_NUM_KEYS.includes(k as keyof BatchingConfig)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw new BadRequestException(`${k} must be a number ≥ 0`);
        (b as Record<string, number>)[k] = v;
      } else if (BATCH_BOOL_KEYS.includes(k as keyof BatchingConfig)) {
        if (typeof v !== 'boolean') throw new BadRequestException(`${k} must be true or false`);
        (b as Record<string, boolean>)[k] = v;
      } else if (k === 'excludeRequirements') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequestException('excludeRequirements must be a list');
        b.excludeRequirements = v as string[];
      } else throw new BadRequestException(`Unknown batching setting "${k}"`);
    }
    if (b.maxOrders !== undefined && b.maxOrders < 1) throw new BadRequestException('maxOrders must be at least 1');
    return { pay: p, batching: b };
  }

  async upsertMarket(user: JwtPayload, regionId: string, input: { pay?: Record<string, unknown>; batching?: Record<string, unknown>; reason: string }) {
    assertCan(user, 'delivery.manage');
    const [region] = await this.db.select().from(regions).where(eq(regions.id, regionId)).limit(1);
    if (!region) throw new NotFoundException('Region not found');
    const v = this.clean(input.pay, input.batching);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(courierMarketPolicies).where(eq(courierMarketPolicies.regionId, regionId)).limit(1);
      const [row] = before
        ? await tx.update(courierMarketPolicies).set({ pay: v.pay, batching: v.batching, version: before.version + 1, updatedById: user.sub, updatedAt: new Date() }).where(eq(courierMarketPolicies.id, before.id)).returning()
        : await tx.insert(courierMarketPolicies).values({ regionId, pay: v.pay, batching: v.batching, updatedById: user.sub }).returning();
      await this.audit.log({ actorId: user.sub, action: 'courier.market_policy.set', entityType: 'region', entityId: regionId, before: before ? { pay: before.pay, batching: before.batching, version: before.version } : null, after: { pay: row.pay, batching: row.batching, version: row.version }, reason: input.reason }, tx);
      return { ...row, regionName: region.name };
    });
  }

  async deleteMarket(user: JwtPayload, regionId: string, reason: string) {
    assertCan(user, 'delivery.manage');
    return this.db.transaction(async (tx) => {
      const [before] = await tx.delete(courierMarketPolicies).where(eq(courierMarketPolicies.regionId, regionId)).returning();
      if (!before) throw new NotFoundException('No policy for that market');
      await this.audit.log({ actorId: user.sub, action: 'courier.market_policy.delete', entityType: 'region', entityId: regionId, before: { pay: before.pay, batching: before.batching, version: before.version }, reason }, tx);
      return { ok: true };
    });
  }

  async adminEffective(user: JwtPayload, q: { locationId?: string; regionId?: string }) {
    assertCan(user, 'delivery.read', 'ops.read');
    const e = q.locationId ? await this.effectiveForLocation(q.locationId) : await this.effectiveForRegion(q.regionId ?? null);
    return { market: e.market, pay: e.pay, batching: e.batching, readySync: e.readySync };
  }

  /** "Why not batched?" for two jobs, with the rules of the first job's market. */
  async previewBatch(user: JwtPayload, jobId: string, withJobId: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const js = await this.db.select().from(deliveryJobs).where(inArray(deliveryJobs.id, [jobId, withJobId]));
    const a = js.find((j) => j.id === jobId), b = js.find((j) => j.id === withJobId);
    if (!a || !b) throw new NotFoundException('Delivery job not found');
    const e = await this.effectiveForLocation(a.locationId);
    const ca = await this.candidate(a), cb = await this.candidate(b);
    // preview the rules as if the first job were assigned and waiting at the kitchen
    const reasons = this.batchReasons({ ...ca, status: a.status === 'PICKED_UP' ? 'PICKED_UP' : 'ASSIGNED' }, cb, e.batching, e.dispatch.travelMinutesPerKm);
    return { batchable: reasons.length === 0, reasons, market: e.market };
  }
}
