import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DEFAULT_AVAILABILITY, DEFAULT_BATCHING, DEFAULT_DISPATCH, DEFAULT_PAY_POLICY, HARD_REQUIREMENTS, offerPay, REQUIRED_COURIER_DOCS, waitingPay, type AvailabilityConfig, type BatchingConfig, type CourierPayPolicy, type DispatchConfig, type Manifest, type OfferPay, type ReadySyncConfig } from '@gutad/shared';
import { ModuleRef } from '@nestjs/core';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { courierDocuments, courierEligibility, courierRecords, courierTimeEntries, deliveryEvents, deliveryJobs, deliveryRestrictions, deliveryZones, driverEarnings, driverOffers, drivers, inboxEvents, locations, menuItems, opsAlerts, orderLines, orders, providerConnections, regions, storedFiles, users } from '../../db/schema';
import { SettingsService } from '../../core/settings.service';
import { assertCan, assertOrgAccess, hasAnyRole, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { haversineKm, pointInPolygon } from '../../common/utils';
import { DELIVERY_PROVIDER } from './delivery.constants';
import { WebhookAuthError, type Address, type DeliveryProvider, type DeliveryProviderEvent } from './providers/delivery-provider';
import { DeliveryPolicyService, type EffectivePolicy } from './delivery-policy.service';
import { DeliveryProviderRegistry } from './providers/provider-registry';
import { RoutingService } from './routing.service';
import { LiveService } from './live.service';
import { RedisService } from '../../core/redis.service';
import { storedFileId, viewableUrl } from './file-links';
import { CourierIncentivesService, type OfferIncentive } from './courier-incentives.service';
import { CourierFraudService } from './courier-fraud.service';

type Status = (typeof deliveryJobs.status.enumValues)[number];

@Injectable()
export class DeliveryService {
  private readonly log = new Logger(DeliveryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DELIVERY_PROVIDER) private readonly provider: DeliveryProvider,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly moduleRef: ModuleRef,
    private readonly providers: DeliveryProviderRegistry,
    private readonly routing: RoutingService,
    private readonly live: LiveService,
    private readonly redis: RedisService,
    readonly policy: DeliveryPolicyService,
    readonly incentives: CourierIncentivesService,
    readonly fraud: CourierFraudService,
  ) {}

  // ───── 17.9-M partner providers in priority order ─────

  /** Third-party providers for a location, by priority (provider_connections for its region or everywhere); else the configured provider. */
  async partnerChain(loc: { regionId: string | null }, tx: DbOrTx = this.db): Promise<string[]> {
    const conns = await tx.select().from(providerConnections).where(and(eq(providerConnections.isActive, true), loc.regionId ? or(isNull(providerConnections.regionId), eq(providerConnections.regionId, loc.regionId)) : isNull(providerConnections.regionId))).orderBy(providerConnections.priority);
    const names = Array.from(new Set(conns.map((c) => c.provider).filter((p) => p !== 'PLATFORM' && this.providers.has(p))));
    return names.length ? names : [this.provider.name];
  }

  /** 17.1-R push a job change to live maps (best effort). */
  private pushJob(j: typeof deliveryJobs.$inferSelect, organizationId: string | null = null) {
    this.live.publish({ type: 'job', jobId: j.id, orderId: j.orderId, locationId: j.locationId, organizationId, status: j.status, fleet: j.fleet, provider: j.provider, driverId: j.driverId, at: new Date().toISOString() });
  }

  // ───── zones ─────

  async upsertZone(user: JwtPayload, locationId: string, input: { id?: string; name: string; polygon?: unknown; feeCents: number; minOrderCents?: number; etaMinutes?: number; isActive?: boolean }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    if (input.id) {
      const [z] = await this.db.update(deliveryZones).set({ ...input, polygon: input.polygon ?? null }).where(and(eq(deliveryZones.id, input.id), eq(deliveryZones.locationId, locationId))).returning();
      return z;
    }
    const [z] = await this.db.insert(deliveryZones).values({ ...input, locationId, polygon: input.polygon ?? null }).returning();
    return z;
  }

  async zones(locationId: string) {
    return this.db.select().from(deliveryZones).where(eq(deliveryZones.locationId, locationId));
  }

  /** Zones that serve a location: its own, zones shared with it (15.2), and zones of its kitchen. */
  async zonesServing(loc: typeof locations.$inferSelect, tx: DbOrTx = this.db) {
    return tx.select().from(deliveryZones).where(and(eq(deliveryZones.isActive, true), sql`(${deliveryZones.locationId} = ${loc.id} or ${loc.id}::uuid = any(${deliveryZones.locationIds})${loc.kitchenId ? sql` or ${deliveryZones.kitchenId} = ${loc.kitchenId}` : sql``})`));
  }

  /** 15.5 restrictions in force for a zone / location / region (or everywhere) at a time. */
  async activeRestrictions(scope: { zoneId?: string | null; locationId?: string | null; regionId?: string | null }, at = new Date(), tx: DbOrTx = this.db) {
    const iso = at.toISOString();
    return tx.select().from(deliveryRestrictions).where(and(isNull(deliveryRestrictions.liftedAt), sql`${deliveryRestrictions.startsAt} <= ${iso} and ${deliveryRestrictions.endsAt} > ${iso}`, sql`(
      (${deliveryRestrictions.zoneId} is null and ${deliveryRestrictions.locationId} is null and ${deliveryRestrictions.regionId} is null)
      ${scope.zoneId ? sql` or ${deliveryRestrictions.zoneId} = ${scope.zoneId}` : sql``}
      ${scope.locationId ? sql` or ${deliveryRestrictions.locationId} = ${scope.locationId}` : sql``}
      ${scope.regionId ? sql` or ${deliveryRestrictions.regionId} = ${scope.regionId}` : sql``})`));
  }

  async dispatchCfg() { return this.settings.getObject<DispatchConfig>('delivery.dispatch', DEFAULT_DISPATCH); }
  async batchingCfg() { return this.settings.getObject<BatchingConfig>('delivery.batching', DEFAULT_BATCHING); }
  async payPolicy() { return this.settings.getObject<CourierPayPolicy>('delivery.pay', DEFAULT_PAY_POLICY); }
  async availabilityCfg() { return this.settings.getObject<AvailabilityConfig>('delivery.availability', DEFAULT_AVAILABILITY); }

  private unavailable(message: string, code = 'DELIVERY_UNAVAILABLE'): never { throw new BadRequestException({ message, code }); }

  private openAtLocal(hours: { dayOfWeek: number; opens: string; closes: string }[], at: Date, tz: string) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
    const hm = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
    return hours.some((h) => h.dayOfWeek === dow && (h.opens <= h.closes ? hm >= h.opens && hm < h.closes : hm >= h.opens || hm < h.closes));
  }

  /**
   * Retail quote for the diner + provider cost for the platform. Both stored separately on the job.
   * 15.1 exclusion polygons, 15.2 shared zones, 15.3 travel time / zone capacity / zone hours, 15.4 courier availability,
   * 15.5 restrictions, 15.7 distance-tiered fees.
   */
  async quoteForLocation(locationId: string, dropoff: Address, orderValueCents: number, tipCents: number, tx: DbOrTx = this.db, at?: Date | null) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    if (!loc.acceptsDelivery) this.unavailable('This restaurant does not deliver');
    if (dropoff.lat === undefined || dropoff.lng === undefined) throw new BadRequestException('Delivery address needs coordinates');
    const when = at ?? new Date();
    const cfg = await this.dispatchCfg();
    const zoneRows = await this.zonesServing(loc, tx);
    const inside = (z: typeof zoneRows[number]) => !!z.polygon && pointInPolygon(dropoff.lng!, dropoff.lat!, z.polygon as { coordinates: number[][][] });
    if (zoneRows.some((z) => z.kind === 'EXCLUSION' && inside(z))) this.unavailable('We can’t deliver to this address');
    const zone = zoneRows.find((z) => z.kind !== 'EXCLUSION' && inside(z));
    const km = loc.lat !== null && loc.lng !== null ? haversineKm(dropoff.lat, dropoff.lng, loc.lat, loc.lng) : null;
    // 15.5 restrictions
    const restr = await this.activeRestrictions({ zoneId: zone?.id, locationId: loc.id, regionId: loc.regionId }, when, tx);
    const pause = restr.find((r) => r.kind === 'PAUSE');
    if (pause) this.unavailable(`Delivery is paused here right now: ${pause.reason}`, 'DELIVERY_PAUSED');
    const shrink = restr.filter((r) => r.kind === 'SHRINK_RADIUS' && r.value !== null).map((r) => r.value!);
    if (shrink.length && km !== null && km > Math.min(...shrink)) this.unavailable(`Delivery is limited to ${Math.min(...shrink)} km right now (${restr.find((r) => r.kind === 'SHRINK_RADIUS')!.reason})`, 'DELIVERY_RESTRICTED');
    const addMinutes = restr.filter((r) => r.kind === 'ADD_MINUTES').reduce((a, r) => a + (r.value || 0), 0);
    let retailFeeCents: number;
    let minOrder = loc.minOrderCents;
    if (zone) {
      if (zone.hours && Array.isArray(zone.hours) && (zone.hours as unknown[]).length && !this.openAtLocal(zone.hours as { dayOfWeek: number; opens: string; closes: string }[], when, loc.timezone)) this.unavailable(`The ${zone.name} delivery area is closed at that time`, 'ZONE_CLOSED');
      if (zone.capacityPerHour) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.zoneId, zone.id), sql`${deliveryJobs.createdAt} > now() - interval '1 hour'`, sql`${deliveryJobs.status} not in ('CANCELED','QUOTE_EXPIRED','FAILED')`));
        if (n >= zone.capacityPerHour) this.unavailable(`Deliveries to ${zone.name} are at capacity right now; try pickup or schedule for later`, 'ZONE_AT_CAPACITY');
      }
      const tiers = ((zone.feeTiers as { upToKm: number; feeCents: number }[]) || []).slice().sort((a, b) => a.upToKm - b.upToKm);
      const tier = km !== null ? tiers.find((t) => km <= t.upToKm) : undefined;
      retailFeeCents = tier ? tier.feeCents : zone.feeCents;
      minOrder = Math.max(minOrder, zone.minOrderCents);
    } else {
      if (km === null) throw new BadRequestException('Restaurant has no coordinates');
      if (km > loc.deliveryRadiusKm) this.unavailable(`Address is outside the ${loc.deliveryRadiusKm} km delivery radius`);
      retailFeeCents = loc.deliveryBaseFeeCents + Math.round(km * loc.deliveryPerKmCents);
    }
    if (orderValueCents < minOrder) this.unavailable(`Minimum order for delivery is ${minOrder} cents`, 'MIN_ORDER');
    const pickup = this.pickupAddress(loc);
    let providerCostCents = 0;
    let providerQuoteId: string | null = null;
    // 15.3 travel time (15.3-R by road when a routing provider is configured); 15.4 courier availability
    const mpk = zone?.travelMinutesPerKm ?? cfg.travelMinutesPerKm;
    const road = km !== null ? await this.routing.travel({ lat: loc.lat!, lng: loc.lng! }, { lat: dropoff.lat, lng: dropoff.lng }, mpk) : null;
    const travel = Math.round(road ? road.minutes : 3 * mpk) + 5;
    let courierWait = 3;
    let etaMinutes = travel + courierWait + addMinutes;
    let expiresAt = new Date(Date.now() + 5 * 60_000);
    let partner: string | null = null;
    if (loc.deliveryFleet === 'PARTNER') {
      // 17.9-M first provider (by priority) that gives a quote
      let q: Awaited<ReturnType<DeliveryProvider['quote']>> | null = null;
      let lastErr: Error | null = null;
      for (const name of await this.partnerChain(loc, tx)) {
        try { q = await this.providers.get(name).quote({ externalId: `q_${locationId}_${Date.now()}`, pickup, dropoff, orderValueCents, tipCents }); partner = name; break; } catch (e) { lastErr = e as Error; }
      }
      if (!q) this.unavailable(`No delivery partner can take this order right now${lastErr ? ` (${lastErr.message})` : ''}`);
      await this.redis.setJson(`dq:${q.providerQuoteId}`, { provider: partner }, 3600);
      providerCostCents = q.feeCents;
      providerQuoteId = q.providerQuoteId;
      etaMinutes = q.etaMinutes + addMinutes;
      expiresAt = q.expiresAt;
    } else if (loc.deliveryFleet === 'PLATFORM') {
      providerCostCents = 500 + Math.round((km ?? 3) * 80); // own-fleet pay schedule
      if (loc.lat !== null && loc.lng !== null) {
        const near = (await tx.select({ lat: drivers.lastLat, lng: drivers.lastLng }).from(drivers).where(and(eq(drivers.status, 'APPROVED'), eq(drivers.isAvailable, true)))).filter((d) => d.lat !== null && d.lng !== null && haversineKm(d.lat, d.lng, loc.lat!, loc.lng!) <= 5).length;
        const [{ open }] = await tx.select({ open: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.locationId, loc.id), inArray(deliveryJobs.status, ['REQUESTED', 'UNASSIGNED'])));
        courierWait = near === 0 ? 15 : open >= near ? 10 : 3;
        etaMinutes = travel + courierWait + addMinutes;
      }
    }
    return { retailFeeCents, providerCostCents, providerQuoteId, etaMinutes, expiresAt, fleet: loc.deliveryFleet, zoneId: zone?.id ?? null, distanceKm: km, etaParts: { travel, courierWait, restriction: addMinutes, routing: road?.source ?? 'straight' }, pickup, provider: partner };
  }

  /** 15.6 scheduled delivery windows with remaining capacity for a day (location time). */
  async deliveryWindows(locationId: string, date: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    const len = loc.deliveryWindowMinutes || 30;
    const start = new Date(`${date}T00:00:00Z`);
    const rows = await this.db.select({ at: orders.scheduledFor }).from(orders).where(and(eq(orders.locationId, locationId), eq(orders.fulfillmentType, 'DELIVERY'), sql`${orders.scheduledFor} >= ${new Date(start.getTime() - 86400_000).toISOString()} and ${orders.scheduledFor} < ${new Date(start.getTime() + 2 * 86400_000).toISOString()}`, sql`${orders.status} not in ('CANCELED','REJECTED')`));
    const used = new Map<number, number>();
    for (const r of rows) { const k = Math.floor(r.at!.getTime() / (len * 60_000)); used.set(k, (used.get(k) || 0) + 1); }
    return { windowMinutes: len, capacity: loc.deliveryWindowCapacity, used: Array.from(used.entries()).map(([k, n]) => ({ startsAt: new Date(k * len * 60_000), orders: n, remaining: loc.deliveryWindowCapacity ? Math.max(0, loc.deliveryWindowCapacity - n) : null })) };
  }

  /** 15.6 does a scheduled delivery time still have room in its window? */
  async assertWindow(loc: typeof locations.$inferSelect, scheduledFor: Date, tx: DbOrTx = this.db) {
    if (!loc.deliveryWindowCapacity) return;
    const len = (loc.deliveryWindowMinutes || 30) * 60_000;
    const ws = new Date(Math.floor(scheduledFor.getTime() / len) * len);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.locationId, loc.id), eq(orders.fulfillmentType, 'DELIVERY'), sql`${orders.scheduledFor} >= ${ws.toISOString()} and ${orders.scheduledFor} < ${new Date(ws.getTime() + len).toISOString()}`, sql`${orders.status} not in ('CANCELED','REJECTED')`));
    if (n >= loc.deliveryWindowCapacity) throw new BadRequestException({ message: 'That delivery window is full; pick another time', code: 'WINDOW_FULL' });
  }

  pickupAddress(loc: typeof locations.$inferSelect): Address {
    return { line1: loc.addressLine1, line2: loc.addressLine2 || undefined, city: loc.city, region: loc.region, postalCode: loc.postalCode, country: loc.country, lat: loc.lat ?? undefined, lng: loc.lng ?? undefined, contactName: loc.name, contactPhone: loc.phone || undefined };
  }

  /**
   * Create the job record for an order at checkout (status QUOTED). The provider request happens when the
   * merchant accepts (so a rejected order never dispatches a courier). Idempotent per order.
   */
  async createJobForOrder(input: { orderId: string; locationId: string; dropoff: Address; retailFeeCents: number; providerCostCents: number; providerQuoteId: string | null; tipCents: number; subsidyCents: number; expiresAt: Date; fleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM' }, tx: DbOrTx = this.db) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
    const [existing] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, input.orderId)).limit(1);
    if (existing) return existing;
    const zone = input.dropoff.lat !== undefined && input.dropoff.lng !== undefined ? (await this.zonesServing(loc!, tx)).find((z) => z.kind !== 'EXCLUSION' && z.polygon && pointInPolygon(input.dropoff.lng!, input.dropoff.lat!, z.polygon as { coordinates: number[][][] })) : undefined;
    const distanceKm = loc?.lat != null && loc?.lng != null && input.dropoff.lat !== undefined && input.dropoff.lng !== undefined ? haversineKm(loc.lat, loc.lng, input.dropoff.lat, input.dropoff.lng) : null;
    // 17.9-M the partner that priced the quote takes the job
    const quoted = input.fleet === 'PARTNER' && input.providerQuoteId ? (await this.redis.getJson<{ provider: string }>(`dq:${input.providerQuoteId}`))?.provider : null;
    const partner = quoted && this.providers.has(quoted) ? quoted : input.fleet === 'PARTNER' && loc ? (await this.partnerChain(loc, tx))[0] : this.provider.name;
    const [job] = await tx
      .insert(deliveryJobs)
      .values({
        orderId: input.orderId,
        locationId: input.locationId,
        fleet: input.fleet,
        provider: input.fleet === 'PARTNER' ? partner : input.fleet === 'PLATFORM' ? 'platform' : 'merchant',
        providerQuoteId: input.providerQuoteId,
        status: 'QUOTED',
        quoteExpiresAt: input.expiresAt,
        retailFeeCents: input.retailFeeCents,
        providerCostCents: input.providerCostCents,
        platformSubsidyCents: input.subsidyCents,
        tipCents: input.tipCents,
        pickupAddress: this.pickupAddress(loc!),
        dropoffAddress: input.dropoff,
        idempotencyKey: `order:${input.orderId}`,
        zoneId: zone?.id ?? null,
        distanceKm,
        providerChain: [],
      })
      .returning();
    return job;
  }

  /**
   * Dispatch: request the courier. A lost API response triggers lookup by external id before retrying,
   * so two couriers are never dispatched for one job.
   */
  async dispatch(jobId: string, tx: DbOrTx = this.db): Promise<typeof deliveryJobs.$inferSelect> {
    const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException('Delivery job not found');
    if (job.status !== 'QUOTED' && job.status !== 'UNASSIGNED' && job.status !== 'QUOTE_EXPIRED') return job; // already dispatched
    const [o] = job.orderId ? await tx.select().from(orders).where(eq(orders.id, job.orderId)).limit(1) : [null];
    const externalId = job.id;
    // Courier R2: market, ready estimate and manifest go with every dispatch
    const eff = await this.policy.effectiveForLocation(job.locationId, tx);
    const estReadyAt = o?.status === 'READY' ? (o.readyAt ?? new Date()) : (job.estReadyAt ?? this.estimateReady(o ?? null, eff.readySync));
    const requirements = await this.requirementsFor(job, tx);
    const manifest = await this.policy.manifest([{ ...job, requirements }], tx);
    await tx.update(deliveryJobs).set({ estReadyAt, readyAt: o?.status === 'READY' ? estReadyAt : job.readyAt, marketId: eff.market?.id ?? null, manifest, requirements }).where(eq(deliveryJobs.id, job.id));
    if (job.fleet === 'PARTNER') {
      const provider = this.providers.get(job.provider);
      let result = await provider.findByExternalId(externalId);
      if (!result) {
        try {
          const items = manifest.brands.flatMap((b) => b.items.map((i) => ({ name: manifest.brands.length > 1 ? `${b.brandName}: ${i.name}` : i.name, quantity: i.quantity })));
          result = await provider.createJob({ externalId, pickup: job.pickupAddress as Address, dropoff: job.dropoffAddress as Address, orderValueCents: o?.subtotalCents || 0, tipCents: job.tipCents, providerQuoteId: job.providerQuoteId, idempotencyKey: `dispatch:${job.id}`, pickupReadyAt: estReadyAt, items, containsAlcohol: manifest.hasAlcohol || requirements.includes('ALCOHOL') });
        } catch (e) {
          // uncertain response: look up before surfacing the failure
          result = await provider.findByExternalId(externalId);
          if (!result) {
            await this.event(job.id, 'DISPATCH_FAILED', { provider: provider.name, error: (e as Error).message }, tx);
            // 17.9-M fail over to the next configured partner; with none left the job is UNASSIGNED with a dispatcher alert
            return this.failover(job, tx, `${provider.name}: ${(e as Error).message}`);
          }
        }
      }
      const [u] = await tx
        .update(deliveryJobs)
        .set({ status: result.status === 'REQUESTED' ? 'REQUESTED' : (result.status as Status), providerJobId: result.providerJobId, trackingUrl: result.trackingUrl, etaAt: result.etaAt, providerFeeCents: result.feeCents ?? null, providerSyncedReadyAt: estReadyAt })
        .where(eq(deliveryJobs.id, job.id))
        .returning();
      await this.event(job.id, 'REQUESTED', { provider: provider.name, providerJobId: result.providerJobId }, tx);
      await this.outbox.publish('delivery.requested', job.id, { orderId: job.orderId }, tx);
      this.pushJob(u);
      return u;
    }
    if (job.fleet === 'PLATFORM') {
      // Courier R2: offers are held until shortly before the food is due (a courier who must leave now gets it now)
      const ready = o?.status === 'READY';
      const holdUntil = eff.readySync.enabled && !ready ? new Date(estReadyAt.getTime() - (eff.readySync.pickupTravelMinutes + eff.readySync.offerLeadMinutes) * 60_000) : null;
      const held = !!holdUntil && holdUntil.getTime() > Date.now();
      // Courier R1: the customer's handoff PIN (accepted as proof of delivery)
      const [u] = await tx.update(deliveryJobs).set({ status: 'REQUESTED', handoffPin: job.handoffPin ?? String(Math.floor(1000 + Math.random() * 9000)), holdUntil: held ? holdUntil : null }).where(eq(deliveryJobs.id, job.id)).returning();
      await this.event(job.id, 'REQUESTED', { fleet: 'PLATFORM', market: eff.market?.id ?? null }, tx);
      if (held) {
        await this.event(job.id, 'HELD', { until: holdUntil!.toISOString(), estReadyAt: estReadyAt.toISOString() }, tx);
        return u;
      }
      await this.offerRound(u, tx);
      return (await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, job.id)))[0];
    }
    // MERCHANT fleet: staff mark progress manually
    const [u] = await tx.update(deliveryJobs).set({ status: 'REQUESTED' }).where(eq(deliveryJobs.id, job.id)).returning();
    await this.event(job.id, 'REQUESTED', { fleet: 'MERCHANT' }, tx);
    return u;
  }

  /** Delivery-only dispatch for an order sold through the merchant's own checkout (Grubhub Connect-style). */
  async externalDelivery(user: JwtPayload, locationId: string, input: { externalOrderId: string; dropoff: Address; orderValueCents: number; tipCents?: number; idempotencyKey?: string }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const [existing] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.locationId, locationId), eq(deliveryJobs.externalOrderId, input.externalOrderId))).limit(1);
    if (existing) return existing; // lookup by external order id before retrying
    const q = await this.quoteForLocation(locationId, input.dropoff, input.orderValueCents, input.tipCents || 0);
    const job = await this.db.transaction(async (tx) => {
      const [j] = await tx
        .insert(deliveryJobs)
        .values({ locationId, externalOrderId: input.externalOrderId, fleet: q.fleet, provider: q.fleet === 'PARTNER' ? q.provider || this.provider.name : q.fleet.toLowerCase(), providerQuoteId: q.providerQuoteId, status: 'QUOTED', quoteExpiresAt: q.expiresAt, retailFeeCents: q.retailFeeCents, providerCostCents: q.providerCostCents, tipCents: input.tipCents || 0, pickupAddress: q.pickup, dropoffAddress: input.dropoff, idempotencyKey: input.idempotencyKey || `ext:${locationId}:${input.externalOrderId}`, costOwner: 'MERCHANT' })
        .returning();
      // merchant owes the platform the provider cost + logistics fee for delivery-only jobs
      await this.ledger.post({ currency: loc.currency }, [
        { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId, debitCents: q.providerCostCents, memo: `Delivery-only job ${input.externalOrderId}` },
        { account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', creditCents: q.providerCostCents, memo: 'Provider cost' },
      ], tx);
      return this.dispatch(j.id, tx);
    });
    return job;
  }

  // ───── status transitions (provider webhooks, driver app, merchant fleet) ─────

  async transition(jobId: string, status: Status, data: Record<string, unknown> = {}, tx: DbOrTx = this.db) {
    const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (job.status === status) return job;
    const terminal: Status[] = ['DELIVERED', 'CANCELED', 'FAILED', 'RETURNED'];
    if (terminal.includes(job.status)) throw new ConflictException(`Job already ${job.status}`);
    const patch: Partial<typeof deliveryJobs.$inferInsert> = { status };
    const now = new Date();
    if (status === 'ASSIGNED') patch.assignedAt = now;
    if (status === 'PICKED_UP') { patch.pickedUpAt = now; patch.custody = 'COURIER'; }
    if (status === 'DELIVERED') { patch.deliveredAt = now; patch.custody = 'CUSTOMER'; }
    if (status === 'RETURNED') patch.custody = 'RETURNED';
    if (status === 'FAILED' && job.pickedUpAt) patch.custody = 'DISPOSED';
    if (status === 'CANCELED' || status === 'FAILED') {
      patch.canceledAt = now;
      patch.cancelReason = (data.reason as string) || null;
      patch.costOwner = (data.costOwner as string) || this.defaultCostOwner(job, status);
    }
    if (data.etaAt) patch.etaAt = new Date(data.etaAt as string);
    if (data.proofPhotoUrl) patch.proofPhotoUrl = data.proofPhotoUrl as string;
    if (data.proofSignature) patch.proofSignature = data.proofSignature as string;
    if (data.trackingUrl) patch.trackingUrl = data.trackingUrl as string;
    const [u] = await tx.update(deliveryJobs).set(patch).where(eq(deliveryJobs.id, jobId)).returning();
    await this.event(jobId, status, data, tx);
    this.pushJob(u);
    const topic = status === 'ASSIGNED' ? 'delivery.assigned' : status === 'PICKED_UP' ? 'delivery.picked_up' : status === 'DELIVERED' ? 'delivery.delivered' : status === 'FAILED' || status === 'CANCELED' ? 'delivery.failed' : null;
    if (topic) await this.outbox.publish(topic, jobId, { orderId: job.orderId, status, ...data }, tx);
    // Courier R1: own-fleet pay for the outcome (unique per job and kind, so a replayed update never pays twice)
    if (u.fleet === 'PLATFORM' && u.driverId && ['DELIVERED', 'RETURNED', 'FAILED', 'CANCELED'].includes(status)) {
      await this.courierPay(u, status, tx);
      if (status === 'DELIVERED') await this.incentives.payBoosts(u, tx);
      await this.afterJobClosed(u.driverId, tx);
    }
    if (status === 'DELIVERED') {
      await this.settleJob(u, tx);
      if (job.orderId) {
        const [done] = await tx.update(orders).set({ status: 'COMPLETED', completedAt: now }).where(and(eq(orders.id, job.orderId), inArray(orders.status, ['READY', 'COLLECTED']))).returning();
        // points, referral qualification and challenge progress for delivered orders (25.5 / 25.6)
        if (done) {
          const { GrowthService } = await import('../growth/growth.service');
          await this.moduleRef.get(GrowthService, { strict: false }).onOrderCompleted(done, tx);
        }
      }
    }
    return u;
  }

  private defaultCostOwner(job: typeof deliveryJobs.$inferSelect, status: Status): string {
    if (status === 'FAILED') return job.fleet === 'PARTNER' ? 'PROVIDER' : job.fleet === 'PLATFORM' ? 'PLATFORM' : 'MERCHANT';
    return job.pickedUpAt ? 'PLATFORM' : 'MERCHANT';
  }

  /** Post provider cost / driver pay against platform delivery revenue when the job completes. */
  private async settleJob(job: typeof deliveryJobs.$inferSelect, tx: DbOrTx) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
    const currency = loc?.currency || 'USD';
    if (job.fleet === 'PARTNER') {
      await this.ledger.post({ orderId: job.orderId, currency }, [
        { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: job.providerCostCents, memo: `Provider cost job ${job.id}` },
        { account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', creditCents: job.providerCostCents, memo: `Provider cost job ${job.id}` },
      ], tx);
      if (job.tipCents) {
        await this.ledger.post({ orderId: job.orderId, currency }, [
          { account: 'DRIVER_PAYABLE', partyId: `order:${job.orderId}`, debitCents: job.tipCents, memo: 'Tip passed to provider courier' },
          { account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', creditCents: job.tipCents, memo: 'Courier tip' },
        ], tx);
      }
    } else if (job.fleet === 'PLATFORM' && job.driverId) {
      // base, distance, time and waiting pay were posted by courierPay; the tip moves to the courier here
      if (job.tipCents) {
        await this.ledger.post({ orderId: job.orderId, currency }, [
          { account: 'DRIVER_PAYABLE', partyId: `order:${job.orderId}`, debitCents: job.tipCents, memo: 'Tip reassigned to driver' },
          { account: 'DRIVER_PAYABLE', partyId: job.driverId, creditCents: job.tipCents, memo: 'Tip' },
        ], tx);
      }
    }
    // MERCHANT fleet: merchant keeps delivery fee+tip; nothing further to post (retail fee was credited at capture to platform; reverse it to merchant)
    if (job.fleet === 'MERCHANT' && (job.retailFeeCents || job.tipCents)) {
      const amt = job.retailFeeCents + job.tipCents;
      await this.ledger.post({ orderId: job.orderId, currency }, [
        { account: 'PLATFORM_REVENUE_DELIVERY', debitCents: job.retailFeeCents, memo: 'Merchant fleet keeps delivery fee' },
        { account: 'DRIVER_PAYABLE', partyId: `order:${job.orderId}`, debitCents: job.tipCents, memo: 'Merchant fleet keeps tip' },
        { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, locationId: job.locationId, creditCents: amt, memo: 'Delivery fee + tip (merchant fleet)' },
      ], tx);
    }
  }

  /** Guaranteed pay recorded for a job: the accepted offer's snapshot, else the current policy (manual assignment). */
  async jobPay(job: typeof deliveryJobs.$inferSelect): Promise<{ policy: CourierPayPolicy; pay: OfferPay; estMinutes: number; market?: { id: string; version: number } | null }> {
    const snap = job.payPolicy as { policy: CourierPayPolicy; pay: OfferPay; estMinutes: number; market?: { id: string; version: number } | null } | null;
    if (snap?.pay && snap.policy) return { ...snap, policy: { ...DEFAULT_PAY_POLICY, ...snap.policy } };
    // Courier R2: manual assignment uses the job's market policy
    const eff = await this.policy.effectiveForLocation(job.locationId);
    const policy = eff.pay;
    const cfg = eff.dispatch;
    const km = job.distanceKm ?? 3;
    const estMinutes = Math.round(km * cfg.travelMinutesPerKm + 5);
    return { policy, pay: offerPay(policy, km, estMinutes), estMinutes, market: eff.market ? { id: eff.market.id, version: eff.market.version } : null };
  }

  /**
   * Courier R1 itemized earnings for an own-fleet job. DELIVERED / RETURNED / FAILED after pickup earn the guaranteed pay
   * (+ waiting beyond the grace period, + return pay); a cancellation after the courier reached the pickup earns the
   * cancellation pay. Each (job, kind) is written once, and the ledger is posted only when the row is new.
   */
  async courierPay(job: typeof deliveryJobs.$inferSelect, outcome: Status, tx: DbOrTx) {
    if (!job.driverId) return null;
    const { policy, pay, market } = await this.jobPay(job);
    // Courier R2 fair waiting: pickup waiting starts when the food was due (the estimate shown at accept), never before
    // the courier arrived; drop-off waiting after its own grace; both capped by the market policy.
    const from = job.arrivedPickupAt ? new Date(Math.max(job.arrivedPickupAt.getTime(), (job.acceptedReadyAt ?? job.arrivedPickupAt).getTime())) : null;
    const waited = from ? Math.max(0, ((job.pickedUpAt ?? new Date()).getTime() - from.getTime()) / 60_000) : 0;
    const dropWaited = job.arrivedDropoffAt && job.deliveredAt ? Math.max(0, (job.deliveredAt.getTime() - job.arrivedDropoffAt.getTime()) / 60_000) : 0;
    const wait = waitingPay(policy, waited, dropWaited);
    const detail = { pickupWaitMinutes: wait.pickupMinutes, dropoffWaitMinutes: wait.dropoffMinutes, kitchenDelayMinutes: job.kitchenDelayMinutes ?? 0, marketId: market?.id ?? null, marketVersion: market?.version ?? null };
    let row: Omit<typeof driverEarnings.$inferInsert, 'driverId'>;
    if (outcome === 'CANCELED' || (outcome === 'FAILED' && !job.pickedUpAt)) {
      if (!job.arrivedPickupAt) return null; // released or canceled before arriving: nothing earned
      row = { kind: 'CANCEL_COMP', baseCents: policy.cancelAfterArrivalCents, waitingCents: wait.cents, reason: `Canceled after arrival${job.cancelReason ? `: ${job.cancelReason}` : ''}` };
    } else {
      row = { kind: 'DELIVERY', baseCents: pay.baseCents, distanceCents: pay.distanceCents, timeCents: pay.timeCents, waitingCents: wait.cents, returnCents: outcome === 'RETURNED' ? policy.returnCents : 0, tipCents: outcome === 'DELIVERED' ? job.tipCents : 0, reason: outcome === 'DELIVERED' ? null : `${outcome.toLowerCase()}${job.cancelReason ? `: ${job.cancelReason}` : ''}` };
    }
    const total = (row.baseCents || 0) + (row.distanceCents || 0) + (row.timeCents || 0) + (row.waitingCents || 0) + (row.returnCents || 0);
    const availableAt = new Date(Date.now() + policy.holdHours * 3600_000);
    const [e] = await tx.insert(driverEarnings).values({ ...row, driverId: job.driverId, deliveryJobId: job.id, policyVersion: policy.version, availableAt, detail }).onConflictDoNothing().returning();
    if (!e) return null;
    const [loc] = await tx.select({ currency: locations.currency }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    if (total > 0) {
      await this.ledger.post({ orderId: job.orderId, currency: loc?.currency || 'USD' }, [
        { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: total, memo: `Courier pay job ${job.id} (${row.kind})` },
        { account: 'DRIVER_PAYABLE', partyId: job.driverId, creditCents: total, memo: row.kind === 'DELIVERY' ? 'Delivery pay' : 'Cancellation pay' },
      ], tx);
    }
    if (outcome === 'DELIVERED') await tx.update(drivers).set({ firstDeliveryAt: sql`coalesce(${drivers.firstDeliveryAt}, now())` }).where(eq(drivers.id, job.driverId));
    return e;
  }

  /** Courier R1: after the last active job, a courier who asked to finish goes offline. */
  async afterJobClosed(driverId: string, tx: DbOrTx) {
    const [d] = await tx.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
    if (!d?.finishAfterCurrent) return;
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, driverId), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
    if (n > 0) return;
    await tx.update(drivers).set({ isAvailable: false, finishAfterCurrent: false, onBreak: false }).where(eq(drivers.id, driverId));
    await tx.update(courierTimeEntries).set({ endedAt: new Date() }).where(and(eq(courierTimeEntries.driverId, driverId), isNull(courierTimeEntries.endedAt)));
  }

  async cancel(user: JwtPayload | null, jobId: string, reason: string, costOwner?: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (user) {
      const [loc] = await this.db.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
      assertOrgAccess(user, loc!.organizationId, job.locationId);
    }
    let feeCents = 0;
    if (job.fleet === 'PARTNER' && job.providerJobId) feeCents = (await this.providers.get(job.provider).cancel(job.providerJobId)).feeCents;
    return this.db.transaction(async (tx) => {
      const u = await this.transition(jobId, 'CANCELED', { reason, costOwner, lateCancelFeeCents: feeCents }, tx);
      if (job.fleet === 'PARTNER') await tx.update(deliveryJobs).set({ providerCancelFeeCents: feeCents }).where(eq(deliveryJobs.id, jobId));
      if (feeCents > 0) {
        const [loc] = await tx.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
        const owner = costOwner || this.defaultCostOwner(job, 'CANCELED');
        await this.ledger.post({ orderId: job.orderId, currency: loc?.currency || 'USD' }, [
          owner === 'MERCHANT'
            ? { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, debitCents: feeCents, memo: 'Late cancellation fee' }
            : { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: feeCents, memo: 'Late cancellation fee' },
          { account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', creditCents: feeCents, memo: 'Late cancellation fee' },
        ], tx);
      }
      return u;
    });
  }

  async event(jobId: string, type: string, data: Record<string, unknown>, tx: DbOrTx = this.db) {
    await tx.insert(deliveryEvents).values({ deliveryJobId: jobId, type, data, lat: (data.lat as number) ?? null, lng: (data.lng as number) ?? null });
  }

  // ───── provider webhooks ─────

  async ingestWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, providerName?: string) {
    // 17.9-M each partner posts to /webhooks/delivery/:provider; the legacy route is the configured provider
    const provider = providerName ? (this.providers.has(providerName) ? this.providers.get(providerName) : null) : this.provider;
    if (!provider) throw new BadRequestException('Unknown delivery provider');
    let ev: DeliveryProviderEvent | null;
    try {
      ev = await provider.parseWebhook(rawBody, headers);
    } catch (e) {
      if (e instanceof WebhookAuthError) throw new UnauthorizedException('Webhook not authenticated');
      throw e;
    }
    if (!ev) throw new BadRequestException('Invalid delivery webhook');
    const [inserted] = await this.db.insert(inboxEvents).values({ provider: `delivery:${provider.name}`, eventId: ev.id, type: ev.status, payload: ev as unknown as Record<string, unknown> }).onConflictDoNothing().returning();
    if (!inserted) return { duplicate: true };
    try {
      await this.applyProviderEvent(ev);
      await this.db.update(inboxEvents).set({ processedAt: new Date() }).where(eq(inboxEvents.id, inserted.id));
    } catch (e) {
      await this.db.update(inboxEvents).set({ error: (e as Error).message }).where(eq(inboxEvents.id, inserted.id));
    }
    return { ok: true };
  }

  async applyProviderEvent(ev: DeliveryProviderEvent) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.providerJobId, ev.providerJobId)).limit(1);
    if (!job) {
      this.log.warn(`webhook for unknown provider job ${ev.providerJobId}`);
      return;
    }
    // Courier R2 reconciliation: the provider's actual and cancellation fees
    if ((ev.feeCents != null && ev.feeCents !== job.providerFeeCents) || (ev.cancelFeeCents != null && ev.cancelFeeCents !== job.providerCancelFeeCents)) {
      await this.db.update(deliveryJobs).set({ ...(ev.feeCents != null ? { providerFeeCents: ev.feeCents } : {}), ...(ev.cancelFeeCents != null ? { providerCancelFeeCents: ev.cancelFeeCents } : {}) }).where(eq(deliveryJobs.id, job.id));
    }
    // out-of-order protection: never regress
    const order: Status[] = ['QUOTED', 'REQUESTED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'];
    if (order.indexOf(ev.status as Status) !== -1 && order.indexOf(ev.status as Status) <= order.indexOf(job.status)) {
      await this.event(job.id, `IGNORED_${ev.status}`, { lat: ev.lat, lng: ev.lng, etaAt: ev.etaAt });
      return;
    }
    await this.db.transaction((tx) => this.transition(job.id, ev.status as Status, { etaAt: ev.etaAt?.toISOString(), lat: ev.lat, lng: ev.lng, proofPhotoUrl: ev.proofPhotoUrl, driverName: ev.driverName, reason: ev.failureReason }, tx));
  }

  // ───── Courier R2: kitchen-ready sync ─────

  /**
   * The kitchen changed what delivery should know: the order was accepted (new promise), is READY, went back to
   * PREPARING (refire), or the kitchen pushed a new estimate. Updates the job's ready times and manifest, releases a
   * held offer when the food is ready, and moves a partner's pickup time when the estimate shifted enough.
   */
  async onKitchenUpdate(orderId: string, kind: 'READY' | 'REFIRE' | 'ESTIMATE', tx: DbOrTx, opts: { minutes?: number } = {}) {
    const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    if (!job || ['DELIVERED', 'CANCELED', 'FAILED', 'RETURNED', 'PICKED_UP'].includes(job.status)) return null;
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const eff = await this.policy.effectiveForLocation(job.locationId, tx);
    const now = new Date();
    const patch: Partial<typeof deliveryJobs.$inferInsert> = {};
    if (kind === 'READY') {
      patch.readyAt = o?.readyAt ?? now;
      patch.estReadyAt = patch.readyAt;
      patch.manifest = await this.policy.manifest([job], tx); // bags are known once packed
    } else {
      patch.readyAt = null;
      patch.estReadyAt = opts.minutes !== undefined ? new Date(now.getTime() + opts.minutes * 60_000) : kind === 'REFIRE' ? new Date(now.getTime() + eff.readySync.defaultPrepMinutes * 60_000) : this.estimateReady(o ?? null, eff.readySync);
    }
    const [u] = await tx.update(deliveryJobs).set(patch).where(eq(deliveryJobs.id, job.id)).returning();
    await this.event(job.id, kind === 'READY' ? 'KITCHEN_READY' : kind === 'REFIRE' ? 'KITCHEN_REFIRE' : 'KITCHEN_ESTIMATE', { estReadyAt: u.estReadyAt?.toISOString() ?? null, readyAt: u.readyAt?.toISOString() ?? null }, tx);
    this.pushJob(u);
    if (u.fleet === 'PLATFORM' && u.status === 'REQUESTED' && !u.driverId) {
      const live = await tx.select({ id: driverOffers.id }).from(driverOffers).where(and(eq(driverOffers.deliveryJobId, u.id), eq(driverOffers.status, 'OFFERED'))).limit(1);
      if (kind === 'READY' && u.holdUntil && !live.length) {
        await this.event(u.id, 'RELEASED_ON_READY', {}, tx);
        await this.offerRound(u, tx);
      } else if (kind !== 'READY' && eff.readySync.enabled && !live.length) {
        // still waiting for its first offer: re-time the hold
        const hold = new Date(u.estReadyAt!.getTime() - (eff.readySync.pickupTravelMinutes + eff.readySync.offerLeadMinutes) * 60_000);
        if (hold > now) await tx.update(deliveryJobs).set({ holdUntil: hold }).where(eq(deliveryJobs.id, u.id));
      }
    }
    if (u.fleet === 'PARTNER' && u.providerJobId && u.estReadyAt) {
      const synced = u.providerSyncedReadyAt?.getTime() ?? 0;
      if (Math.abs(u.estReadyAt.getTime() - synced) >= eff.readySync.resyncMinutes * 60_000 && u.estReadyAt > now) {
        const provider = this.providers.get(u.provider);
        if (provider.updatePickupTime) {
          const r = await provider.updatePickupTime(u.providerJobId, u.estReadyAt);
          await this.event(u.id, r.ok ? 'PROVIDER_READY_SYNCED' : 'PROVIDER_READY_SYNC_FAILED', { provider: provider.name, at: u.estReadyAt.toISOString() }, tx);
          if (r.ok) await tx.update(deliveryJobs).set({ providerSyncedReadyAt: u.estReadyAt }).where(eq(deliveryJobs.id, u.id));
        }
      }
    }
    if (u.driverId && kind === 'READY') await this.event(u.id, 'COURIER_TOLD_READY', { driverId: u.driverId }, tx);
    return u;
  }

  /** Kitchen staff push a new ready estimate (running late, or early). */
  async setReadyEstimate(user: JwtPayload, orderId: string, minutes: number) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException('Order not found');
    assertOrgAccess(user, o.organizationId, o.locationId);
    if (!['ACCEPTED', 'PREPARING'].includes(o.status)) throw new ConflictException(`Order is ${o.status}`);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) throw new BadRequestException('minutes must be 0–240');
    const u = await this.db.transaction((tx) => this.onKitchenUpdate(orderId, 'ESTIMATE', tx, { minutes }));
    if (!u) throw new ConflictException('This order has no open delivery');
    return { jobId: u.id, estReadyAt: u.estReadyAt, readyAt: u.readyAt, holdUntil: u.holdUntil };
  }

  /** Every minute: held own-fleet jobs whose time has come get their first offer round. */
  async releaseHeld(now = new Date()) {
    const due = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.status, 'REQUESTED'), isNull(deliveryJobs.driverId), isNotNull(deliveryJobs.holdUntil), lte(deliveryJobs.holdUntil, now)));
    let n = 0;
    for (const j of due) {
      await this.db.transaction(async (tx) => {
        const [cur] = await tx.update(deliveryJobs).set({ holdUntil: null }).where(and(eq(deliveryJobs.id, j.id), isNotNull(deliveryJobs.holdUntil))).returning();
        if (!cur) return; // another worker took it
        await this.event(j.id, 'RELEASED', {}, tx);
        await this.offerRound(cur, tx);
        n++;
      });
    }
    return n;
  }

  /** What the kitchen sees: couriers coming for its orders, with readiness and the manifest. */
  async courierArrivals(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    assertOrgAccess(user, loc.organizationId, locationId);
    const locIds = loc.kitchenId ? (await this.db.select({ id: locations.id }).from(locations).where(eq(locations.kitchenId, loc.kitchenId))).map((l) => l.id) : [locationId];
    const rows = await this.db.select({ j: deliveryJobs, number: orders.number, shelfSlot: orders.shelfSlot, lat: drivers.lastLat, lng: drivers.lastLng, name: users.name }).from(deliveryJobs)
      .leftJoin(orders, eq(orders.id, deliveryJobs.orderId)).leftJoin(drivers, eq(drivers.id, deliveryJobs.driverId)).leftJoin(users, eq(users.id, drivers.userId))
      .where(and(inArray(deliveryJobs.locationId, locIds), inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'UNASSIGNED']))).orderBy(deliveryJobs.estReadyAt);
    const cfg = await this.dispatchCfg();
    return rows.map(({ j, number, shelfSlot, lat, lng, name }) => {
      const pu = j.pickupAddress as Address;
      const eta = j.arrivedPickupAt ? 0 : lat != null && lng != null && pu.lat !== undefined && pu.lng !== undefined ? Math.round(haversineKm(lat, lng, pu.lat, pu.lng) * cfg.travelMinutesPerKm) : null;
      return { jobId: j.id, orderId: j.orderId, orderNumber: number, status: j.status, courierFirstName: j.fleet === 'PLATFORM' && name ? name.split(' ')[0] : null, fleet: j.fleet, provider: j.provider, etaToPickupMinutes: j.driverId ? eta : null, arrivedAt: j.arrivedPickupAt, estReadyAt: j.estReadyAt, readyAt: j.readyAt, holdUntil: j.holdUntil, shelfSlot, manifest: j.manifest };
    });
  }

  /** Partner fees: quoted at checkout vs. reported by the provider. Courier R3: posted variance and courier ledger exceptions. */
  async reconciliation(user: JwtPayload, q: { provider?: string; from?: string; to?: string }) {
    assertCan(user, 'delivery.read', 'finance.read');
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
    const to = q.to ? new Date(q.to) : new Date();
    const conds = [eq(deliveryJobs.fleet, 'PARTNER'), gte(deliveryJobs.createdAt, from), lte(deliveryJobs.createdAt, to)];
    if (q.provider) conds.push(eq(deliveryJobs.provider, q.provider));
    const rows = await this.db.select({ j: deliveryJobs, number: orders.number }).from(deliveryJobs).leftJoin(orders, eq(orders.id, deliveryJobs.orderId)).where(and(...conds)).orderBy(desc(deliveryJobs.createdAt)).limit(500);
    const out = rows.map(({ j, number }) => {
      const actual = j.providerFeeCents;
      const cancelFee = j.providerCancelFeeCents ?? 0;
      return { jobId: j.id, orderNumber: number, provider: j.provider, providerJobId: j.providerJobId, tipCents: j.tipCents, quotedCents: j.providerCostCents, actualCents: actual, cancelFeeCents: cancelFee, varianceCents: actual === null ? null : actual + cancelFee - j.providerCostCents, postedCents: j.reconVarianceCents, reconciledAt: j.reconciledAt, status: j.status, createdAt: j.createdAt };
    });
    const known = out.filter((r) => r.actualCents !== null);
    const { CourierPayoutsService } = await import('./courier-payouts.service');
    const exceptions = await this.moduleRef.get(CourierPayoutsService, { strict: false }).integrity();
    return { rows: out, totals: { jobs: out.length, quotedCents: out.reduce((t, r) => t + r.quotedCents, 0), actualCents: known.reduce((t, r) => t + (r.actualCents ?? 0) + r.cancelFeeCents, 0), varianceCents: known.reduce((t, r) => t + (r.varianceCents ?? 0), 0), postedCents: out.reduce((t, r) => t + (r.postedCents ?? 0), 0), unreported: out.length - known.length, unposted: out.filter((r) => !r.reconciledAt).length }, exceptions };
  }

  /** Connectivity check for a partner: one quote between a location and a nearby point. Nothing is created. */
  async testProvider(user: JwtPayload, name: string, locationId?: string) {
    assertCan(user, 'delivery.manage');
    if (!this.providers.has(name)) throw new NotFoundException(`Provider ${name} is not configured`);
    const [loc] = locationId ? await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1) : await this.db.select().from(locations).where(isNotNull(locations.lat)).limit(1);
    if (!loc) throw new BadRequestException('No location to quote from');
    const pickup = this.pickupAddress(loc);
    const dropoff: Address = { ...pickup, line2: undefined, contactName: 'Connectivity test', lat: pickup.lat !== undefined ? pickup.lat + 0.01 : undefined, lng: pickup.lng };
    const t0 = Date.now();
    try {
      const q = await this.providers.get(name).quote({ externalId: `test_${Date.now()}`, pickup, dropoff, orderValueCents: 2000, tipCents: 0 });
      return { ok: true, latencyMs: Date.now() - t0, error: null, quote: { feeCents: q.feeCents, etaMinutes: q.etaMinutes } };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) };
    }
  }

  // ───── tracking & dispatcher ─────

  async track(jobIdOrOrderId: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(sql`${deliveryJobs.id}::text = ${jobIdOrOrderId} or ${deliveryJobs.orderId}::text = ${jobIdOrOrderId}`).limit(1);
    if (!job) throw new NotFoundException();
    const events = await this.db.select().from(deliveryEvents).where(eq(deliveryEvents.deliveryJobId, job.id)).orderBy(deliveryEvents.createdAt);
    const last = [...events].reverse().find((e) => e.lat !== null);
    // 17.8 proof of delivery is never exposed here (public endpoint); staff use GET /delivery-jobs/:id/proof
    return { id: job.id, status: job.status, etaAt: job.etaAt, trackingUrl: job.trackingUrl, fleet: job.fleet, courierLocation: last && ['ASSIGNED', 'PICKED_UP'].includes(job.status) ? { lat: last.lat, lng: last.lng, at: last.createdAt } : null, hasProof: !!(job.proofPhotoUrl || job.proofSignature), arrived: !!job.arrivedDropoffAt, events: events.filter((e) => !e.type.startsWith('IGNORED_') && e.type !== 'LOCATION' && e.type !== 'OFFERED').map((e) => ({ type: e.type, at: e.createdAt })) };
  }

  /** Dispatcher queue: unassigned, late, or failed jobs for a location/org. */
  async dispatcherQueue(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const rows = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.locationId, locationId), inArray(deliveryJobs.status, ['QUOTED', 'REQUESTED', 'ASSIGNED', 'PICKED_UP', 'UNASSIGNED', 'FAILED']))).orderBy(desc(deliveryJobs.createdAt)).limit(200);
    const now = Date.now();
    return rows.map((j) => ({ ...j, isLate: !!j.etaAt && j.etaAt.getTime() < now && !['DELIVERED', 'CANCELED'].includes(j.status), needsAttention: ['UNASSIGNED', 'FAILED'].includes(j.status) || (j.status === 'REQUESTED' && now - j.createdAt.getTime() > 10 * 60_000) }));
  }

  /** Merchant-fleet or dispatcher manual update (e.g. "our driver picked it up"). */
  async manualTransition(user: JwtPayload, jobId: string, status: 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'FAILED' | 'RETURNED', data: Record<string, unknown>) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
    assertOrgAccess(user, loc!.organizationId, job.locationId);
    return this.db.transaction((tx) => this.transition(jobId, status, { ...data, actorId: user.sub }, tx));
  }

  /** Re-dispatch a failed/unassigned job (new provider request or new driver offers). */
  async reassign(user: JwtPayload, jobId: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
    assertOrgAccess(user, loc!.organizationId, job.locationId);
    if (!['UNASSIGNED', 'QUOTE_EXPIRED', 'REQUESTED'].includes(job.status)) throw new ConflictException(`Cannot reassign a ${job.status} job`);
    await this.db.update(deliveryJobs).set({ status: 'UNASSIGNED', providerJobId: null, driverId: null }).where(eq(deliveryJobs.id, jobId));
    await this.audit.log({ organizationId: loc!.organizationId, actorId: user.sub, action: 'delivery.reassign', entityType: 'delivery_job', entityId: jobId });
    return this.db.transaction((tx) => this.dispatch(jobId, tx));
  }

  // ───── own fleet: driver operations (13) ─────

  async applyAsDriver(user: JwtPayload, input: { vehicle: string }) {
    const [existing] = await this.db.select().from(drivers).where(eq(drivers.userId, user.sub)).limit(1);
    if (existing) return existing;
    const [d] = await this.db.insert(drivers).values({ userId: user.sub, vehicle: input.vehicle }).returning();
    return d;
  }

  async approveDriver(user: JwtPayload, driverId: string, approved: boolean) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    if (approved) {
      // 16.2 required documents must be approved and current
      const docs = await this.db.select().from(courierDocuments).where(and(eq(courierDocuments.driverId, driverId), eq(courierDocuments.status, 'APPROVED')));
      const missing = REQUIRED_COURIER_DOCS.filter((k) => !docs.some((x) => x.kind === k && (!x.expiresAt || x.expiresAt > new Date())));
      if (missing.length) throw new BadRequestException({ message: `Approve these documents first: ${missing.map((m) => m.toLowerCase().replace('_', ' ')).join(', ')}`, code: 'DOCS_MISSING' });
    }
    const [d] = await this.db.update(drivers).set({ status: approved ? 'APPROVED' : 'SUSPENDED', licenseVerified: approved, ...(approved ? { suspendedReason: null, suspendedAt: null } : { isAvailable: false, suspendedReason: 'Not approved', suspendedAt: new Date(), suspendedById: user.sub }) }).where(eq(drivers.id, driverId)).returning();
    if (d) await this.audit.log({ actorId: user.sub, action: approved ? 'courier.approve' : 'courier.reject', entityType: 'driver', entityId: driverId });
    if (!d) throw new NotFoundException();
    if (approved) await this.db.update(users).set({ roles: sql`array_append(array_remove(${users.roles}, 'DRIVER'), 'DRIVER')` }).where(eq(users.id, d.userId));
    return d;
  }

  async myDriver(user: JwtPayload) {
    const [d] = await this.db.select().from(drivers).where(eq(drivers.userId, user.sub)).limit(1);
    if (!d) throw new NotFoundException('Not a driver');
    return d;
  }

  async setAvailability(user: JwtPayload, isAvailable: boolean, lat?: number, lng?: number, mode: 'ON_DEMAND' | 'RESERVED' = 'ON_DEMAND', shiftId: string | null = null) {
    const d = await this.myDriver(user);
    if (d.status !== 'APPROVED') throw new ForbiddenException(d.status === 'SUSPENDED' ? `Account suspended: ${d.suspendedReason || 'see your messages'}` : 'Driver not approved');
    if (isAvailable && d.applicationStatus !== 'APPROVED') throw new ForbiddenException({ message: 'Your application is not approved yet', code: 'NOT_APPROVED' });
    if (isAvailable && !['ACTIVE', 'RESTRICTED'].includes(d.lifecycleStatus ?? '')) throw new ForbiddenException({ message: 'Your account is not active', code: 'LIFECYCLE' });
    if (isAvailable && (await this.driversWithExpiredDocs(this.db)).has(d.id)) throw new ForbiddenException({ message: 'A required document has expired. Upload a current one to go online.', code: 'DOCS_EXPIRED' });
    if (isAvailable && (await this.driversWithBadChecks(this.db)).has(d.id)) throw new ForbiddenException({ message: 'An eligibility check has expired or failed. See your account to fix it.', code: 'CHECK_EXPIRED' });
    if (isAvailable && (lat ?? d.lastLat) === null) throw new BadRequestException({ message: 'Share your location to go online', code: 'NO_LOCATION' });
    const [u] = await this.db.update(drivers).set({ isAvailable, lastLat: lat ?? d.lastLat, lastLng: lng ?? d.lastLng, lastSeenAt: lat !== undefined ? new Date() : d.lastSeenAt, ...(isAvailable ? { availabilityMode: mode } : { onBreak: false, finishAfterCurrent: false }) }).where(eq(drivers.id, d.id)).returning();
    // Courier R1 time tracking: one open ONLINE entry while online (breaks are separate entries)
    const open = await this.db.select().from(courierTimeEntries).where(and(eq(courierTimeEntries.driverId, d.id), isNull(courierTimeEntries.endedAt)));
    if (isAvailable && !open.some((e) => e.kind === 'ONLINE')) await this.db.insert(courierTimeEntries).values({ driverId: d.id, kind: 'ONLINE', mode, shiftId, startedAt: new Date() });
    if (!isAvailable && open.length) await this.db.update(courierTimeEntries).set({ endedAt: new Date() }).where(inArray(courierTimeEntries.id, open.map((e) => e.id)));
    if (u.lastLat !== null && u.lastLng !== null) this.live.publish({ type: 'courier', driverId: u.id, lat: u.lastLat, lng: u.lastLng, isAvailable, jobIds: [], locationIds: [], at: new Date().toISOString() });
    return u;
  }

  async updateLocation(user: JwtPayload, lat: number, lng: number) {
    const d = await this.myDriver(user);
    // Courier R3: an impossible jump since the last ping is a fraud signal (the move itself is still recorded)
    await this.fraud.onLocation(d, lat, lng).catch((e) => this.log.warn(`gps check: ${(e as Error).message}`));
    await this.db.update(drivers).set({ lastLat: lat, lastLng: lng, lastSeenAt: new Date() }).where(eq(drivers.id, d.id));
    const active = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
    const cfg = await this.dispatchCfg();
    for (const j of active) {
      const target = (j.status === 'PICKED_UP' ? j.dropoffAddress : j.pickupAddress) as Address;
      const remainingKm = target.lat !== undefined && target.lng !== undefined ? Math.round(haversineKm(lat, lng, target.lat, target.lng) * 100) / 100 : null;
      await this.event(j.id, 'LOCATION', { lat, lng, remainingKm });
      // 17.6 route progress refreshes the ETA once the order is on its way
      // 15.3-R by road when a routing provider is configured
      if (j.status === 'PICKED_UP' && remainingKm !== null) {
        const t = await this.routing.travel({ lat, lng }, { lat: target.lat!, lng: target.lng! }, cfg.travelMinutesPerKm);
        await this.db.update(deliveryJobs).set({ etaAt: new Date(Date.now() + Math.max(1, Math.round(t.minutes)) * 60_000) }).where(eq(deliveryJobs.id, j.id));
      }
    }
    // 17.1-R push the position to live maps
    this.live.publish({ type: 'courier', driverId: d.id, lat, lng, isAvailable: d.isAvailable, jobIds: active.map((j) => j.id), locationIds: Array.from(new Set(active.map((j) => j.locationId))), at: new Date().toISOString() });
    return { ok: true };
  }

  /** 16.3 what a job needs from its courier: alcohol licence, large-order capacity, cold bag (soft). */
  private async requirementsFor(job: typeof deliveryJobs.$inferSelect, tx: DbOrTx) {
    if (!job.orderId) return [] as string[];
    const ls = await tx.select({ q: orderLines.quantity, handling: orderLines.handling, tax: menuItems.taxCategory }).from(orderLines).leftJoin(menuItems, eq(menuItems.id, orderLines.menuItemId)).where(eq(orderLines.orderId, job.orderId));
    const [o] = await tx.select({ sub: orders.subtotalCents }).from(orders).where(eq(orders.id, job.orderId)).limit(1);
    const req: string[] = [];
    if (ls.some((l) => l.tax === 'ALCOHOL')) req.push('ALCOHOL');
    if (ls.reduce((a, l) => a + l.q, 0) > 10 || (o?.sub ?? 0) >= 15000) req.push('LARGE_ORDER');
    if (ls.some((l) => l.handling?.includes('COLD'))) req.push('COLD_BAG');
    if (ls.some((l) => l.handling?.includes('HOT'))) req.push('HOT_BAG');
    return req;
  }

  /** Courier R1: couriers with an expired, failed or reopened eligibility check cannot take work. */
  async driversWithBadChecks(tx: DbOrTx) {
    const rows = await tx.select({ driverId: courierEligibility.driverId }).from(courierEligibility).where(or(inArray(courierEligibility.status, ['EXPIRED', 'FAILED', 'NEEDS_ACTION']), and(eq(courierEligibility.status, 'PASSED'), lt(courierEligibility.expiresAt, new Date()))));
    return new Set(rows.map((r) => r.driverId));
  }

  /** Drivers whose required documents have expired cannot take work (16.2). */
  async driversWithExpiredDocs(tx: DbOrTx) {
    const rows = await tx.select({ driverId: courierDocuments.driverId }).from(courierDocuments).where(and(inArray(courierDocuments.kind, REQUIRED_COURIER_DOCS as string[]), or(eq(courierDocuments.status, 'EXPIRED'), and(eq(courierDocuments.status, 'APPROVED'), lt(courierDocuments.expiresAt, new Date())))));
    return new Set(rows.map((r) => r.driverId));
  }

  /**
   * 17.2 scoring + 17.4 batching + 17.5 rounds: offer the job to the best few couriers. Score (lower is better) adds
   * distance to pickup, the gap between travel time and when the food is ready, current load and vehicle fit; a courier
   * already carrying a compatible order from the same pickup gets a batching bonus. After `maxOfferRounds` without a
   * courier the job fails over to the next provider (17.9).
   */
  async offerRound(job: typeof deliveryJobs.$inferSelect, tx: DbOrTx) {
    const eff = await this.policy.effectiveForLocation(job.locationId, tx);
    const cfg = eff.dispatch;
    const bcfg = eff.batching;
    const policy = eff.pay;
    const pickup = job.pickupAddress as Address;
    const drop = job.dropoffAddress as Address;
    const reqs = job.requirements.length ? job.requirements : await this.requirementsFor(job, tx);
    const [o] = job.orderId ? await tx.select().from(orders).where(eq(orders.id, job.orderId)).limit(1) : [null];
    const readyAt = job.estReadyAt ?? this.estimateReady(o ?? null, eff.readySync);
    const readyIn = o?.status === 'READY' ? 0 : Math.max(0, (readyAt.getTime() - Date.now()) / 60_000);
    // Courier R1 dispatchability: approved, active lifecycle, not on a break or finishing, recent location
    const acfg = await this.availabilityCfg();
    const fresh = new Date(Date.now() - acfg.locationFreshMinutes * 60_000);
    const available = (await tx.select().from(drivers).where(and(eq(drivers.isAvailable, true), eq(drivers.status, 'APPROVED'), eq(drivers.applicationStatus, 'APPROVED'), inArray(drivers.lifecycleStatus, ['ACTIVE', 'RESTRICTED']), eq(drivers.onBreak, false), eq(drivers.finishAfterCurrent, false)))).filter((d) => !d.lastSeenAt || d.lastSeenAt >= fresh);
    const expired = new Set([...(await this.driversWithExpiredDocs(tx)), ...(await this.driversWithBadChecks(tx))]);
    const tried = new Set((await tx.select({ d: driverOffers.driverId }).from(driverOffers).where(eq(driverOffers.deliveryJobId, job.id))).map((x) => x.d));
    const active = await tx.select().from(deliveryJobs).where(and(inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP']), sql`${deliveryJobs.driverId} is not null`));
    const me = await this.policy.candidate({ ...job, requirements: reqs, estReadyAt: readyAt }, tx);
    const kitchens = new Map<string, string>();
    const locIds = Array.from(new Set(active.map((j) => j.locationId)));
    if (locIds.length) for (const l of await tx.select({ id: locations.id, k: locations.kitchenId }).from(locations).where(inArray(locations.id, locIds))) kitchens.set(l.id, l.k ?? `location:${l.id}`);
    const hard = reqs.filter((r) => (HARD_REQUIREMENTS as string[]).includes(r));
    const scored: { d: typeof available[number]; score: number; detail: Record<string, unknown> }[] = [];
    for (const d of available) {
      if (expired.has(d.id) || tried.has(d.id) || d.lastLat === null || d.lastLng === null || pickup.lat === undefined || pickup.lng === undefined) continue;
      if (HARD_REQUIREMENTS.some((r) => reqs.includes(r) && !d.capabilities.includes(r))) continue;
      if (d.zoneIds.length && job.zoneId && !d.zoneIds.includes(job.zoneId)) continue;
      const km = haversineKm(d.lastLat, d.lastLng, pickup.lat, pickup.lng);
      if (km > cfg.radiusKm) continue;
      const mine = active.filter((j) => j.driverId === d.id);
      const trips = mine.length;
      let batchWith: string | null = null;
      if (mine.length) {
        if (!bcfg.enabled || trips >= Math.min(bcfg.maxOrders, d.maxConcurrent)) continue;
        // 17.4 + Courier R2 batching rules (market policy): same kitchen, not picked up, direction, detour, spread, ready window, exclusions
        const mate = mine.find((j) => this.policy.batchReasons({ id: j.id, status: j.status, kitchenKey: kitchens.get(j.locationId) ?? `location:${j.locationId}`, pickup: j.pickupAddress as Address, dropoff: j.dropoffAddress as Address, requirements: j.requirements, readyAt: j.estReadyAt }, me, bcfg, cfg.travelMinutesPerKm).length === 0);
        if (!mate) continue;
        batchWith = mate.id;
      }
      const travel = km * cfg.travelMinutesPerKm;
      const readiness = Math.abs(travel - readyIn);
      const vehicle = (d.vehicleType === 'CAR' || d.vehicleType === 'VAN') && (job.distanceKm ?? 3) < 2 ? 2 : d.vehicleType === 'WALK' && (job.distanceKm ?? 3) > 2 ? 6 : 0;
      const cold = reqs.includes('COLD_BAG') && d.capabilities.includes('COLD_BAG') ? -3 : 0;
      const hot = reqs.includes('HOT_BAG') && d.capabilities.includes('HOT_BAG') ? -1 : 0;
      const score = Math.round((km * 2 + readiness * 0.5 + trips * 5 + vehicle + cold + hot - (batchWith ? 10 : 0)) * 100) / 100;
      // RESTRICTED couriers take single orders without hard requirements only
      if (d.lifecycleStatus === 'RESTRICTED' && (batchWith || hard.length)) continue;
      scored.push({ d, score, detail: { km: Math.round(km * 100) / 100, readinessGap: Math.round(readiness), load: trips, vehicle: d.vehicleType, batchWith } });
    }
    scored.sort((a, b) => a.score - b.score);
    const pick = scored.slice(0, cfg.offersPerRound);
    const attempts = job.offerAttempts + 1;
    await tx.update(deliveryJobs).set({ offerAttempts: attempts, requirements: reqs, holdUntil: null }).where(eq(deliveryJobs.id, job.id));
    if (!pick.length) {
      await this.event(job.id, 'NO_COURIER', { round: attempts }, tx);
      if (attempts >= cfg.maxOfferRounds) await this.failover({ ...job, offerAttempts: attempts }, tx, 'No courier accepted');
      return [];
    }
    // Courier R1 guaranteed pay from the versioned policy (distance and time are inside it, never added again later)
    const tripKm = job.distanceKm ?? (drop.lat !== undefined && drop.lng !== undefined && pickup.lat !== undefined && pickup.lng !== undefined ? haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng) : 3);
    const market = eff.market ? { id: eff.market.id, version: eff.market.version } : null;
    // Courier R3: running BOOST campaigns for this zone/market and courier are shown on the offer and kept at accept
    const rowsOut = [];
    for (const r of pick) {
      const toPickupKm = Number(r.detail.km) || 0;
      const estMinutes = Math.round((toPickupKm + tripKm) * cfg.travelMinutesPerKm + 5);
      const pay = offerPay(policy, tripKm, estMinutes);
      const incentives = await this.incentives.offerBoosts({ zoneId: job.zoneId, marketId: job.marketId ?? eff.market?.id ?? null }, r.d, pay.totalCents, tx);
      const incentiveCents = incentives.reduce((t, i) => t + i.cents, 0);
      rowsOut.push({ driverId: r.d.id, deliveryJobId: job.id, payCents: pay.totalCents + incentiveCents, payBreakdown: { pay, policy, estMinutes, toPickupKm, distanceKm: Math.round(tripKm * 100) / 100, market, incentives }, expiresAt: new Date(Date.now() + cfg.offerSeconds * 1000), score: r.score, scoreDetail: r.detail });
    }
    await tx.insert(driverOffers).values(rowsOut);
    await this.event(job.id, 'OFFERED', { round: attempts, couriers: pick.map((r) => ({ driverId: r.d.id, score: r.score })) }, tx);
    return pick;
  }

  // ───── Courier R2: kitchen-ready estimate ─────

  /** When the food should be ready: the kitchen's promise (less the delivery leg), else now + default prep. */
  estimateReady(o: typeof orders.$inferSelect | null, rs: ReadySyncConfig): Date {
    if (o?.readyAt && o.status === 'READY') return o.readyAt;
    if (o?.promiseAt) return new Date(o.promiseAt.getTime() - (o.fulfillmentType === 'DELIVERY' ? 15 * 60_000 : 0));
    return new Date(Date.now() + rs.defaultPrepMinutes * 60_000);
  }

  /** 17.9 provider failover: own fleet → connected providers in priority order for the region; then a dispatcher alert. */
  async failover(job: typeof deliveryJobs.$inferSelect, tx: DbOrTx, reason: string): Promise<typeof deliveryJobs.$inferSelect> {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
    const conns = await tx.select().from(providerConnections).where(and(eq(providerConnections.isActive, true), loc?.regionId ? or(isNull(providerConnections.regionId), eq(providerConnections.regionId, loc.regionId)) : isNull(providerConnections.regionId))).orderBy(providerConnections.priority);
    const chain = conns.length ? conns.map((c) => c.provider) : ['PLATFORM', this.provider.name];
    const current = job.fleet === 'PLATFORM' ? 'PLATFORM' : job.provider;
    const tried = new Set([...job.providerChain, current]);
    await tx.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.deliveryJobId, job.id), eq(driverOffers.status, 'OFFERED')));
    // 17.9-M next third-party provider by priority (own fleet → partner A → partner B …); a partner that cannot quote is skipped
    const o = job.orderId ? (await tx.select().from(orders).where(eq(orders.id, job.orderId)).limit(1))[0] : null;
    for (const next of chain.filter((p) => p !== 'PLATFORM' && !tried.has(p) && this.providers.has(p))) {
      let q: Awaited<ReturnType<DeliveryProvider['quote']>>;
      try {
        q = await this.providers.get(next).quote({ externalId: `fo_${job.id}`, pickup: job.pickupAddress as Address, dropoff: job.dropoffAddress as Address, orderValueCents: o?.subtotalCents || 0, tipCents: job.tipCents });
      } catch (e) {
        tried.add(next);
        await this.event(job.id, 'FAILOVER_QUOTE_FAILED', { provider: next, error: (e as Error).message }, tx);
        continue;
      }
      await tx.update(deliveryJobs).set({ fleet: 'PARTNER', provider: next, providerCostCents: q.feeCents, providerQuoteId: q.providerQuoteId, providerJobId: null, status: 'QUOTED', driverId: null, providerChain: [...tried], quoteExpiresAt: q.expiresAt }).where(eq(deliveryJobs.id, job.id));
      await this.event(job.id, 'FAILOVER', { from: current, to: next, reason, costCents: q.feeCents }, tx);
      return this.dispatch(job.id, tx);
    }
    const [u] = await tx.update(deliveryJobs).set({ status: 'UNASSIGNED', providerChain: [...tried], cancelReason: reason }).where(eq(deliveryJobs.id, job.id)).returning();
    await this.event(job.id, 'DISPATCH_EXHAUSTED', { reason, tried: [...tried] }, tx);
    await tx.insert(opsAlerts).values({ type: 'DISPATCH_FAILED', severity: 'HIGH', title: 'No courier for a delivery', detail: `${reason}. Tried: ${[...tried].join(' → ')}. Assign a courier manually or cancel.`, subjectType: 'delivery_job', subjectId: job.id, organizationId: loc?.organizationId ?? null, locationId: job.locationId, dedupeKey: `dispatch:${job.id}`, ownerRole: 'DISPATCHER', escalateAt: new Date(Date.now() + 10 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: reason }] }).onConflictDoNothing();
    await this.outbox.publish('delivery.failed', job.id, { orderId: job.orderId, reason, stage: job.fleet === 'PARTNER' ? 'dispatch' : 'offer' }, tx);
    this.pushJob(u, loc?.organizationId ?? null);
    return u;
  }

  async myOffers(user: JwtPayload) {
    const d = await this.myDriver(user);
    const rows = await this.db
      .select({ offer: driverOffers, job: deliveryJobs })
      .from(driverOffers)
      .innerJoin(deliveryJobs, eq(deliveryJobs.id, driverOffers.deliveryJobId))
      .where(and(eq(driverOffers.driverId, d.id), eq(driverOffers.status, 'OFFERED'), sql`${driverOffers.expiresAt} > now()`));
    // Courier R1: full pickup, drop-off area only (street and contact after accepting), pay breakdown with the tip apart
    // Courier R2: readiness, the multi-brand manifest and the market
    const marketIds = Array.from(new Set(rows.map((r) => r.job.marketId).filter((x): x is string => !!x)));
    const marketNames = new Map(marketIds.length ? (await this.db.select({ id: regions.id, name: regions.name }).from(regions).where(inArray(regions.id, marketIds))).map((m) => [m.id, m.name]) : []);
    return rows.map((r) => {
      const b = (r.offer.payBreakdown || {}) as { pay?: OfferPay; policy?: CourierPayPolicy; estMinutes?: number; toPickupKm?: number; distanceKm?: number; incentives?: OfferIncentive[] };
      const incentives = b.incentives ?? [];
      const pu = r.job.pickupAddress as Address;
      const dr = r.job.dropoffAddress as Address;
      const batchWith = (r.offer.scoreDetail as { batchWith?: string } | null)?.batchWith ?? null;
      const equipment = ['INSULATED_BAG', ...(r.job.requirements.includes('COLD_BAG') ? ['COLD_BAG'] : [])];
      return {
        id: r.offer.id, deliveryJobId: r.offer.deliveryJobId, expiresAt: r.offer.expiresAt, payCents: r.offer.payCents,
        pay: { ...(b.pay ?? { baseCents: r.offer.payCents, distanceCents: 0, timeCents: 0, totalCents: r.offer.payCents }), incentiveCents: incentives.reduce((t, i) => t + i.cents, 0), incentives }, tipCents: r.job.tipCents,
        stops: batchWith ? 3 : 2, pickup: { name: pu.contactName ?? null, line1: pu.line1, city: pu.city }, dropoffArea: { city: dr.city, postalCode: dr.postalCode },
        readiness: this.readiness(r.job), manifest: r.job.manifest as Manifest | null,
        market: r.job.marketId ? { id: r.job.marketId, name: marketNames.get(r.job.marketId) ?? null } : null,
        distanceKm: b.distanceKm ?? r.job.distanceKm, toPickupKm: b.toPickupKm ?? null, estMinutes: b.estMinutes ?? null,
        requirements: r.job.requirements, equipment,
        policy: b.policy ? { version: b.policy.version, waitingGraceMinutes: b.policy.waitingGraceMinutes, waitingPerMinuteCents: b.policy.waitingPerMinuteCents, returnCents: b.policy.returnCents, cancelAfterArrivalCents: b.policy.cancelAfterArrivalCents, waitingCapMinutes: b.policy.waitingCapMinutes ?? DEFAULT_PAY_POLICY.waitingCapMinutes, dropoffGraceMinutes: b.policy.dropoffGraceMinutes ?? DEFAULT_PAY_POLICY.dropoffGraceMinutes } : null,
        batchWith, score: r.offer.score, scoreDetail: r.offer.scoreDetail,
      };
    });
  }

  async respondOffer(user: JwtPayload, offerId: string, accept: boolean) {
    const d = await this.myDriver(user);
    if (d.status !== 'APPROVED') throw new ForbiddenException('Courier is not active');
    return this.db.transaction(async (tx) => {
      const [offer] = await tx.select().from(driverOffers).where(and(eq(driverOffers.id, offerId), eq(driverOffers.driverId, d.id))).limit(1);
      if (!offer) throw new NotFoundException();
      if (offer.status !== 'OFFERED' || offer.expiresAt < new Date()) throw new ConflictException('Offer no longer available');
      if (!accept) {
        await tx.update(driverOffers).set({ status: 'DECLINED', respondedAt: new Date() }).where(eq(driverOffers.id, offerId));
        return { ok: true };
      }
      // Courier R2: capacity is checked again at accept (the courier may have taken other work since the offer)
      const mateId = (offer.scoreDetail as { batchWith?: string } | null)?.batchWith;
      const mineNow = await tx.select({ id: deliveryJobs.id }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
      const tripsNow = mineNow.length;
      if (tripsNow && (!mateId || !mineNow.some((j) => j.id === mateId) || tripsNow >= d.maxConcurrent)) throw new ConflictException({ message: 'You already have as many orders as you can carry', code: 'AT_CAPACITY' });
      // first accept wins: the conditional update awards the job to exactly one courier; the accepted pay is kept on the job
      const b = (offer.payBreakdown || null) as { pay: OfferPay; policy: CourierPayPolicy; estMinutes: number; market?: { id: string; version: number } | null; incentives?: OfferIncentive[] } | null;
      const [job] = await tx.update(deliveryJobs).set({ driverId: d.id, holdUntil: null, acceptedReadyAt: sql`${deliveryJobs.estReadyAt}`, ...(b ? { payPolicy: { policy: b.policy, pay: b.pay, estMinutes: b.estMinutes, offerId: offer.id, market: b.market ?? null, incentives: b.incentives ?? [] } } : {}) }).where(and(eq(deliveryJobs.id, offer.deliveryJobId), isNull(deliveryJobs.driverId), inArray(deliveryJobs.status, ['REQUESTED', 'UNASSIGNED']))).returning();
      if (!job) throw new ConflictException('Job already taken');
      await tx.update(driverOffers).set({ status: 'ACCEPTED', respondedAt: new Date() }).where(eq(driverOffers.id, offerId));
      await tx.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.deliveryJobId, job.id), eq(driverOffers.status, 'OFFERED')));
      if (mateId) {
        const [mate] = await tx.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, mateId), eq(deliveryJobs.driverId, d.id))).limit(1);
        if (mate) {
          const batchId = mate.batchId ?? globalThis.crypto.randomUUID();
          await tx.update(deliveryJobs).set({ batchId }).where(inArray(deliveryJobs.id, [mate.id, job.id]));
          await this.event(job.id, 'BATCHED', { batchId, with: mate.id }, tx);
        }
      }
      await this.transition(job.id, 'ASSIGNED', { driverId: d.id }, tx);
      return job;
    });
  }

  /** Courier R2 readiness as shown to couriers and the kitchen. */
  readiness(j: typeof deliveryJobs.$inferSelect) {
    return { status: j.readyAt ? 'READY' as const : 'PREPARING' as const, estReadyAt: j.estReadyAt?.toISOString() ?? null, readyAt: j.readyAt?.toISOString() ?? null };
  }

  async myActiveJobs(user: JwtPayload) {
    const d = await this.myDriver(user);
    const rows = await this.db.select({ j: deliveryJobs, number: orders.number, shelfSlot: orders.shelfSlot }).from(deliveryJobs).leftJoin(orders, eq(orders.id, deliveryJobs.orderId)).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP']))).orderBy(deliveryJobs.batchId, deliveryJobs.createdAt);
    // the PIN itself never goes to the courier; the order code is what the kitchen shows on the bag
    return rows.map(({ j, number, shelfSlot }) => ({ ...j, handoffPin: undefined, pinAvailable: !!j.handoffPin, orderCode: number ? String(number).slice(-4) : j.id.slice(0, 4).toUpperCase(), requiresIdCheck: j.requirements.includes('ALCOHOL'), readiness: this.readiness(j), shelfSlot: j.readyAt ? shelfSlot : null }));
  }

  async driverTransition(user: JwtPayload, jobId: string, status: 'PICKED_UP' | 'DELIVERED' | 'FAILED', data: { proofPhotoUrl?: string; proofSignature?: string; handoffPin?: string; idChecked?: boolean; pickupCheck?: { orderCode?: string; bagCount: number; drinkCount?: number; sealIntact: boolean; note?: string; brands?: { brandKey: string; bagCount: number; sealIntact: boolean }[] }; reason?: string; lat?: number; lng?: number; clientEventId?: string }) {
    const d = await this.myDriver(user);
    const [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.driverId, d.id))).limit(1);
    if (!job) throw new NotFoundException();
    // a retried update from an app that lost its connection: answer with the current state instead of failing
    if (job.status === status) return job;
    const { pickupCheck, handoffPin, idChecked, ...rest } = data;
    const patch: Partial<typeof deliveryJobs.$inferInsert> = {};
    if (status === 'PICKED_UP') {
      if (job.status !== 'ASSIGNED') throw new ConflictException(`Delivery is ${job.status}`);
      if (!pickupCheck) throw new BadRequestException({ message: 'Confirm the pickup check: bag count and seals', code: 'PICKUP_CHECK_REQUIRED' });
      if (!pickupCheck.sealIntact) throw new ConflictException({ message: 'A broken seal must be reported (damaged packaging) before you leave', code: 'SEAL_BROKEN' });
      const [o] = job.orderId ? await this.db.select({ number: orders.number }).from(orders).where(eq(orders.id, job.orderId)).limit(1) : [null];
      const code = o?.number ? String(o.number).slice(-4) : job.id.slice(0, 4).toUpperCase();
      if (pickupCheck.orderCode && pickupCheck.orderCode.trim().toUpperCase() !== code.toUpperCase()) throw new BadRequestException({ message: 'That order code doesn’t match this delivery. Check the bag label.', code: 'ORDER_CODE_MISMATCH' });
      // Courier R2: an order with several brands needs every brand's bags confirmed one by one
      const check = this.policy.checkManifest(job.manifest as Manifest | null, pickupCheck.brands);
      if (!check.ok) throw new ConflictException(check.broken.length ? { message: 'A broken seal must be reported (damaged packaging) before you leave', code: 'SEAL_BROKEN', broken: check.broken } : { message: 'Collect every brand\u2019s bags before leaving', code: 'MANIFEST_INCOMPLETE', missing: check.missing });
      patch.pickupCheck = { ...pickupCheck, orderCodeMatched: !!pickupCheck.orderCode, at: new Date().toISOString() };
      const now = new Date();
      if (!job.arrivedPickupAt) patch.arrivedPickupAt = now;
      // kitchen delay: from when the food was due (or the courier arrived, if later) until it was ready
      const due = Math.max((job.arrivedPickupAt ?? now).getTime(), (job.acceptedReadyAt ?? job.estReadyAt ?? job.arrivedPickupAt ?? now).getTime());
      patch.kitchenDelayMinutes = Math.max(0, Math.round(((job.readyAt ?? now).getTime() - due) / 60_000));
    }
    if (status === 'DELIVERED') {
      if (job.status !== 'PICKED_UP') throw new ConflictException('Pick the order up first');
      if (job.requirements.includes('ALCOHOL') && !idChecked) throw new BadRequestException({ message: 'Check the customer’s ID before handing over restricted items', code: 'ID_CHECK_REQUIRED' });
      if (handoffPin !== undefined && handoffPin !== '') {
        if (!job.handoffPin || handoffPin.trim() !== job.handoffPin) throw new BadRequestException({ message: 'That PIN doesn’t match. Ask the customer to check their order page.', code: 'PIN_MISMATCH' });
        patch.handoffMethod = 'PIN';
      } else if (data.proofPhotoUrl) { await this.assertOwnPhoto(d.id, data.proofPhotoUrl); patch.handoffMethod = 'PHOTO'; }
      else if (data.proofSignature) patch.handoffMethod = 'SIGNATURE';
      else throw new BadRequestException({ message: 'Proof of handoff required: a photo, the customer’s PIN or a signature', code: 'PROOF_REQUIRED' });
      if (idChecked) patch.idCheckedAt = new Date();
      if (!job.arrivedDropoffAt) patch.arrivedDropoffAt = new Date();
    }
    return this.db.transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.update(deliveryJobs).set(patch).where(eq(deliveryJobs.id, jobId));
      const u = await this.transition(jobId, status, { ...rest, handoffMethod: patch.handoffMethod, costOwner: status === 'FAILED' ? 'PLATFORM' : undefined }, tx);
      // Courier R3: handoff far from the drop-off, or a proof photo seen before
      if (status === 'DELIVERED') await this.fraud.onDelivered(u, d.id, { lat: data.lat ?? d.lastLat, lng: data.lng ?? d.lastLng }, tx);
      return u;
    });
  }

  /** 17.6 courier arrived at pickup or drop-off (waiting time starts). */
  async driverArrived(user: JwtPayload, jobId: string, at: 'PICKUP' | 'DROPOFF', lat?: number, lng?: number) {
    const d = await this.myDriver(user);
    const [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.driverId, d.id))).limit(1);
    if (!job) throw new NotFoundException();
    if (at === 'PICKUP' && job.status !== 'ASSIGNED') throw new ConflictException('Already picked up');
    if (at === 'DROPOFF' && job.status !== 'PICKED_UP') throw new ConflictException('Pick the order up first');
    const [u] = await this.db.update(deliveryJobs).set(at === 'PICKUP' ? { arrivedPickupAt: job.arrivedPickupAt ?? new Date() } : { arrivedDropoffAt: job.arrivedDropoffAt ?? new Date() }).where(eq(deliveryJobs.id, jobId)).returning();
    await this.event(jobId, at === 'PICKUP' ? 'ARRIVED_PICKUP' : 'ARRIVED_DROPOFF', { lat, lng });
    if (at === 'DROPOFF') await this.outbox.publish('delivery.arrived', jobId, { orderId: job.orderId });
    return u;
  }

  /**
   * 17.7 delivery exceptions: log each contact attempt (call, text, knock), start a wait timer, notify the customer.
   * A wrong address can be corrected and the delivery continues.
   */
  async driverException(user: JwtPayload | null, jobId: string, input: { kind: string; method?: string; note?: string; correctedAddress?: Address }, staff = false) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (!staff) { const d = await this.myDriver(user!); if (job.driverId !== d.id) throw new NotFoundException(); }
    if (!['ASSIGNED', 'PICKED_UP'].includes(job.status)) throw new ConflictException(`Delivery is ${job.status}`);
    const cfg = await this.dispatchCfg();
    const now = new Date();
    const ex = (job.exception as { kind: string; attempts: { at: string; method?: string; note?: string }[]; waitUntil: string; resolution?: string } | null) || { kind: input.kind, attempts: [], waitUntil: new Date(now.getTime() + cfg.waitMinutes * 60_000).toISOString() };
    if (ex.resolution) throw new ConflictException('Exception already resolved');
    ex.attempts.push({ at: now.toISOString(), method: input.method, note: input.note });
    const patch: Partial<typeof deliveryJobs.$inferInsert> = { exception: ex };
    if (input.kind === 'WRONG_ADDRESS' && input.correctedAddress) {
      patch.dropoffAddress = { ...(job.dropoffAddress as Address), ...input.correctedAddress };
      patch.exception = { ...ex, resolution: 'CORRECTED', resolvedAt: now.toISOString() };
    }
    const [u] = await this.db.update(deliveryJobs).set(patch).where(eq(deliveryJobs.id, jobId)).returning();
    await this.event(jobId, `EXCEPTION_${input.kind}`, { method: input.method, note: input.note, attempt: ex.attempts.length }, this.db);
    await this.outbox.publish('delivery.attempt', jobId, { orderId: job.orderId, kind: input.kind, waitUntil: ex.waitUntil });
    return u;
  }

  /** 17.7 after the wait timer: return to the restaurant, dispose, or leave in a safe place (proof required). Staff can resolve early. */
  /** A `/files/<id>` proof must be a photo this courier uploaded (external links from older app builds pass through). */
  private async assertOwnPhoto(driverId: string, url: string) {
    const id = storedFileId(url);
    if (!id) return;
    const [f] = await this.db.select({ driverId: storedFiles.driverId, purpose: storedFiles.purpose }).from(storedFiles).where(eq(storedFiles.id, id)).limit(1);
    if (!f || f.driverId !== driverId || !f.purpose.startsWith('COURIER_PHOTO_')) throw new BadRequestException({ message: 'Take the handoff photo again', code: 'PHOTO_INVALID' });
  }

  async resolveException(user: JwtPayload | null, jobId: string, input: { resolution: 'RETURN' | 'DISPOSE' | 'SAFE_PLACE'; note?: string; proofPhotoUrl?: string }, staff = false) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (!staff) { const d = await this.myDriver(user!); if (job.driverId !== d.id) throw new NotFoundException(); }
    const ex = job.exception as { kind: string; attempts: unknown[]; waitUntil: string; resolution?: string } | null;
    if (!ex || ex.resolution) throw new ConflictException('No open exception on this delivery');
    if (!staff && new Date(ex.waitUntil) > new Date()) throw new ConflictException({ message: `Keep trying until ${new Date(ex.waitUntil).toLocaleTimeString()}`, code: 'WAIT_TIMER' });
    if (input.resolution === 'SAFE_PLACE' && !input.proofPhotoUrl) throw new BadRequestException('A photo is required when leaving the order');
    if (!staff && input.proofPhotoUrl && job.driverId) await this.assertOwnPhoto(job.driverId, input.proofPhotoUrl);
    return this.db.transaction(async (tx) => {
      await tx.update(deliveryJobs).set({ exception: { ...ex, resolution: input.resolution, resolvedAt: new Date().toISOString(), note: input.note } }).where(eq(deliveryJobs.id, jobId));
      if (input.resolution === 'SAFE_PLACE') return this.transition(jobId, 'DELIVERED', { proofPhotoUrl: input.proofPhotoUrl, note: input.note, exception: ex.kind }, tx);
      if (input.resolution === 'RETURN') return this.transition(jobId, 'RETURNED', { reason: `${ex.kind}: returned to restaurant`, costOwner: 'CUSTOMER' }, tx);
      return this.transition(jobId, 'FAILED', { reason: `${ex.kind}: disposed after ${ex.attempts.length} attempt(s)`, costOwner: 'CUSTOMER' }, tx);
    });
  }

  /** 17.8 proof of delivery: staff (delivery/support) or the merchant only; every view is audited. */
  async proof(user: JwtPayload, jobId: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    const [loc] = await this.db.select({ org: locations.organizationId }).from(locations).where(eq(locations.id, job.locationId)).limit(1);
    if (isPlatformStaff(user)) assertCan(user, 'delivery.read', 'support.read');
    else assertOrgAccess(user, loc!.org, job.locationId);
    await this.audit.log({ organizationId: loc?.org, actorId: user.sub, action: 'delivery.proof_view', entityType: 'delivery_job', entityId: jobId });
    return { jobId, deliveredAt: job.deliveredAt, proofPhotoUrl: viewableUrl(job.proofPhotoUrl), proofSignature: job.proofSignature, purgedAt: job.proofPurgedAt };
  }

  /** 17.8 retention: remove proof after `proofRetentionDays`, unless the order has an open support ticket. */
  async purgeProofs(now = new Date()) {
    const cfg = await this.dispatchCfg();
    const cutoff = new Date(now.getTime() - cfg.proofRetentionDays * 86400_000);
    const r = await this.db.execute(sql`update delivery_jobs j set proof_photo_url = null, proof_signature = null, proof_purged_at = ${now.toISOString()}
      where j.delivered_at < ${cutoff.toISOString()} and j.proof_purged_at is null and (j.proof_photo_url is not null or j.proof_signature is not null)
      and not exists (select 1 from incidents i where i.order_id = j.order_id and i.status in ('OPEN','INVESTIGATING','APPEALED')) returning j.id`);
    return { purged: (r as unknown as { rows: unknown[] }).rows.length };
  }

  /** 16.2 approved documents past their expiry become EXPIRED; a courier missing a required one goes offline. */
  async expireCourierDocs(now = new Date()) {
    const exp = await this.db.update(courierDocuments).set({ status: 'EXPIRED' }).where(and(eq(courierDocuments.status, 'APPROVED'), lt(courierDocuments.expiresAt, now))).returning();
    const ids = Array.from(new Set(exp.filter((d) => (REQUIRED_COURIER_DOCS as string[]).includes(d.kind)).map((d) => d.driverId)));
    if (ids.length) await this.db.update(drivers).set({ isAvailable: false }).where(inArray(drivers.id, ids));
    for (const d of exp) await this.db.insert(courierRecords).values({ driverId: d.driverId, kind: 'SUPPORT_NOTE', title: `${d.kind.toLowerCase().replace('_', ' ')} expired`, detail: 'Upload a current document to go online again.' });
    return { expired: exp.length, offline: ids.length };
  }

  async myEarnings(user: JwtPayload) {
    const d = await this.myDriver(user);
    const rows = await this.db.select().from(driverEarnings).where(eq(driverEarnings.driverId, d.id)).orderBy(desc(driverEarnings.createdAt)).limit(200);
    const payable = await this.ledger.balance('DRIVER_PAYABLE', d.id);
    return { payableCents: payable, entries: rows };
  }

  // ───── worker helpers ─────

  async expireQuotes(now = new Date()) {
    const r = await this.db.update(deliveryJobs).set({ status: 'QUOTE_EXPIRED' }).where(and(eq(deliveryJobs.status, 'QUOTED'), lt(deliveryJobs.quoteExpiresAt, now))).returning({ id: deliveryJobs.id });
    return r.length;
  }

  async expireOffers(now = new Date()) {
    const expired = await this.db.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.status, 'OFFERED'), lt(driverOffers.expiresAt, now))).returning();
    const jobIds = Array.from(new Set(expired.map((e) => e.deliveryJobId)));
    for (const id of jobIds) {
      const live = await this.db.select().from(driverOffers).where(and(eq(driverOffers.deliveryJobId, id), eq(driverOffers.status, 'OFFERED')));
      const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, id)).limit(1);
      if (!live.length && job && job.status === 'REQUESTED' && !job.driverId) {
        await this.db.transaction((tx) => this.offerRound(job, tx));
      }
    }
    return expired.length;
  }

  /** Flags jobs past ETA for dispatcher/support attention. */
  async flagLate(now = new Date()) {
    const late = await this.db.select().from(deliveryJobs).where(and(inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'PICKED_UP']), lt(deliveryJobs.etaAt, new Date(now.getTime() - 10 * 60_000))));
    for (const j of late) {
      const [already] = await this.db.select().from(deliveryEvents).where(and(eq(deliveryEvents.deliveryJobId, j.id), eq(deliveryEvents.type, 'LATE'))).limit(1);
      if (already) continue;
      await this.event(j.id, 'LATE', { etaAt: j.etaAt });
      await this.outbox.publish('delivery.late', j.id, { orderId: j.orderId });
    }
    return late.length;
  }

  /** Mock provider simulation: advance requested jobs so pilots can see tracking end to end. */
  async simulateMock(now = new Date()) {
    if (this.provider.name !== 'mock') return 0;
    const jobs = await this.db.select().from(deliveryJobs).where(and(inArray(deliveryJobs.provider, ['mock', 'mock-b']), inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'PICKED_UP'])));
    let n = 0;
    for (const j of jobs) {
      const ageMin = (now.getTime() - (j.pickedUpAt || j.assignedAt || j.updatedAt).getTime()) / 60_000;
      const next: Status | null = j.status === 'REQUESTED' && ageMin >= 1 ? 'ASSIGNED' : j.status === 'ASSIGNED' && ageMin >= 2 ? 'PICKED_UP' : j.status === 'PICKED_UP' && ageMin >= 3 ? 'DELIVERED' : null;
      if (!next) continue;
      const pickup = j.pickupAddress as Address;
      await this.db.transaction((tx) => this.transition(j.id, next, { lat: pickup.lat, lng: pickup.lng, driverName: 'Mock Courier', proofPhotoUrl: next === 'DELIVERED' ? 'https://placehold.co/600x400?text=Proof+of+handoff' : undefined }, tx));
      n++;
    }
    return n;
  }
}
