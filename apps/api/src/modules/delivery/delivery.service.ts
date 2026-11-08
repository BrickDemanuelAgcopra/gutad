import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { deliveryEvents, deliveryJobs, deliveryZones, driverEarnings, driverOffers, drivers, inboxEvents, locations, orders, users } from '../../db/schema';
import { assertOrgAccess, hasAnyRole, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { haversineKm, pointInPolygon } from '../../common/utils';
import { DELIVERY_PROVIDER } from './delivery.constants';
import type { Address, DeliveryProvider, DeliveryProviderEvent } from './providers/delivery-provider';

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
  ) {}

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

  /** Retail quote for the diner + provider cost for the platform. Both stored separately on the job. */
  async quoteForLocation(locationId: string, dropoff: Address, orderValueCents: number, tipCents: number, tx: DbOrTx = this.db) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    if (!loc.acceptsDelivery) throw new BadRequestException('This restaurant does not deliver');
    if (dropoff.lat === undefined || dropoff.lng === undefined) throw new BadRequestException('Delivery address needs coordinates');
    const zoneRows = await tx.select().from(deliveryZones).where(and(eq(deliveryZones.locationId, locationId), eq(deliveryZones.isActive, true)));
    const zone = zoneRows.find((z) => z.polygon && pointInPolygon(dropoff.lng!, dropoff.lat!, z.polygon as { coordinates: number[][][] }));
    let retailFeeCents: number;
    let minOrder = loc.minOrderCents;
    if (zone) {
      retailFeeCents = zone.feeCents;
      minOrder = Math.max(minOrder, zone.minOrderCents);
    } else {
      if (loc.lat === null || loc.lng === null) throw new BadRequestException('Restaurant has no coordinates');
      const km = haversineKm(dropoff.lat, dropoff.lng, loc.lat, loc.lng);
      if (km > loc.deliveryRadiusKm) throw new BadRequestException(`Address is outside the ${loc.deliveryRadiusKm} km delivery radius`);
      retailFeeCents = loc.deliveryBaseFeeCents + Math.round(km * loc.deliveryPerKmCents);
    }
    if (orderValueCents < minOrder) throw new BadRequestException(`Minimum order for delivery is ${minOrder} cents`);
    const pickup = this.pickupAddress(loc);
    let providerCostCents = 0;
    let providerQuoteId: string | null = null;
    let etaMinutes = zone?.etaMinutes ?? 40;
    let expiresAt = new Date(Date.now() + 5 * 60_000);
    if (loc.deliveryFleet === 'PARTNER') {
      const q = await this.provider.quote({ externalId: `q_${locationId}_${Date.now()}`, pickup, dropoff, orderValueCents, tipCents });
      providerCostCents = q.feeCents;
      providerQuoteId = q.providerQuoteId;
      etaMinutes = q.etaMinutes;
      expiresAt = q.expiresAt;
    } else if (loc.deliveryFleet === 'PLATFORM') {
      providerCostCents = 500 + Math.round(((loc.lat && loc.lng && haversineKm(dropoff.lat, dropoff.lng, loc.lat, loc.lng)) || 3) * 80); // own-fleet pay schedule
    }
    return { retailFeeCents, providerCostCents, providerQuoteId, etaMinutes, expiresAt, fleet: loc.deliveryFleet, zoneId: zone?.id ?? null, pickup };
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
    const [job] = await tx
      .insert(deliveryJobs)
      .values({
        orderId: input.orderId,
        locationId: input.locationId,
        fleet: input.fleet,
        provider: input.fleet === 'PARTNER' ? this.provider.name : input.fleet === 'PLATFORM' ? 'platform' : 'merchant',
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
      })
      .returning();
    return job;
  }

  /**
   * Dispatch: request the courier. A lost API response triggers lookup by external id before retrying,
   * so two couriers are never dispatched for one job.
   */
  async dispatch(jobId: string, tx: DbOrTx = this.db) {
    const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException('Delivery job not found');
    if (job.status !== 'QUOTED' && job.status !== 'UNASSIGNED' && job.status !== 'QUOTE_EXPIRED') return job; // already dispatched
    const [o] = job.orderId ? await tx.select().from(orders).where(eq(orders.id, job.orderId)).limit(1) : [null];
    const externalId = job.id;
    if (job.fleet === 'PARTNER') {
      let result = await this.provider.findByExternalId(externalId);
      if (!result) {
        try {
          result = await this.provider.createJob({ externalId, pickup: job.pickupAddress as Address, dropoff: job.dropoffAddress as Address, orderValueCents: o?.subtotalCents || 0, tipCents: job.tipCents, providerQuoteId: job.providerQuoteId, idempotencyKey: `dispatch:${job.id}`, pickupReadyAt: o?.promiseAt ?? null });
        } catch (e) {
          // uncertain response: look up before surfacing the failure
          result = await this.provider.findByExternalId(externalId);
          if (!result) {
            await this.event(job.id, 'DISPATCH_FAILED', { error: (e as Error).message }, tx);
            await this.outbox.publish('delivery.failed', job.id, { orderId: job.orderId, reason: (e as Error).message, stage: 'dispatch' }, tx);
            const [u] = await tx.update(deliveryJobs).set({ status: 'UNASSIGNED', cancelReason: (e as Error).message }).where(eq(deliveryJobs.id, job.id)).returning();
            return u;
          }
        }
      }
      const [u] = await tx
        .update(deliveryJobs)
        .set({ status: result.status === 'REQUESTED' ? 'REQUESTED' : (result.status as Status), providerJobId: result.providerJobId, trackingUrl: result.trackingUrl, etaAt: result.etaAt })
        .where(eq(deliveryJobs.id, job.id))
        .returning();
      await this.event(job.id, 'REQUESTED', { provider: this.provider.name, providerJobId: result.providerJobId }, tx);
      await this.outbox.publish('delivery.requested', job.id, { orderId: job.orderId }, tx);
      return u;
    }
    if (job.fleet === 'PLATFORM') {
      const [u] = await tx.update(deliveryJobs).set({ status: 'REQUESTED' }).where(eq(deliveryJobs.id, job.id)).returning();
      await this.event(job.id, 'REQUESTED', { fleet: 'PLATFORM' }, tx);
      await this.offerToNearbyDrivers(u, tx);
      return u;
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
        .values({ locationId, externalOrderId: input.externalOrderId, fleet: q.fleet, provider: q.fleet === 'PARTNER' ? this.provider.name : q.fleet.toLowerCase(), providerQuoteId: q.providerQuoteId, status: 'QUOTED', quoteExpiresAt: q.expiresAt, retailFeeCents: q.retailFeeCents, providerCostCents: q.providerCostCents, tipCents: input.tipCents || 0, pickupAddress: q.pickup, dropoffAddress: input.dropoff, idempotencyKey: input.idempotencyKey || `ext:${locationId}:${input.externalOrderId}`, costOwner: 'MERCHANT' })
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
    if (status === 'PICKED_UP') patch.pickedUpAt = now;
    if (status === 'DELIVERED') patch.deliveredAt = now;
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
    const topic = status === 'ASSIGNED' ? 'delivery.assigned' : status === 'PICKED_UP' ? 'delivery.picked_up' : status === 'DELIVERED' ? 'delivery.delivered' : status === 'FAILED' || status === 'CANCELED' ? 'delivery.failed' : null;
    if (topic) await this.outbox.publish(topic, jobId, { orderId: job.orderId, status, ...data }, tx);
    if (status === 'DELIVERED') {
      await this.settleJob(u, tx);
      if (job.orderId) await tx.update(orders).set({ status: 'COMPLETED', completedAt: now }).where(and(eq(orders.id, job.orderId), inArray(orders.status, ['READY', 'COLLECTED'])));
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
      await tx.insert(driverEarnings).values({ driverId: job.driverId, deliveryJobId: job.id, baseCents: job.providerCostCents, tipCents: job.tipCents });
      await this.ledger.post({ orderId: job.orderId, currency }, [
        { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: job.providerCostCents, memo: `Driver base pay job ${job.id}` },
        { account: 'DRIVER_PAYABLE', partyId: job.driverId, creditCents: job.providerCostCents, memo: 'Base pay' },
      ], tx);
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

  async cancel(user: JwtPayload | null, jobId: string, reason: string, costOwner?: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (user) {
      const [loc] = await this.db.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
      if (!isPlatformStaff(user)) assertOrgAccess(user, loc!.organizationId, job.locationId);
    }
    let feeCents = 0;
    if (job.fleet === 'PARTNER' && job.providerJobId) feeCents = (await this.provider.cancel(job.providerJobId)).feeCents;
    return this.db.transaction(async (tx) => {
      const u = await this.transition(jobId, 'CANCELED', { reason, costOwner, lateCancelFeeCents: feeCents }, tx);
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

  async ingestWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    const ev = await this.provider.parseWebhook(rawBody, headers);
    if (!ev) throw new BadRequestException('Invalid delivery webhook');
    const [inserted] = await this.db.insert(inboxEvents).values({ provider: `delivery:${this.provider.name}`, eventId: ev.id, type: ev.status, payload: ev as unknown as Record<string, unknown> }).onConflictDoNothing().returning();
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
    // out-of-order protection: never regress
    const order: Status[] = ['QUOTED', 'REQUESTED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'];
    if (order.indexOf(ev.status as Status) !== -1 && order.indexOf(ev.status as Status) <= order.indexOf(job.status)) {
      await this.event(job.id, `IGNORED_${ev.status}`, { lat: ev.lat, lng: ev.lng, etaAt: ev.etaAt });
      return;
    }
    await this.db.transaction((tx) => this.transition(job.id, ev.status as Status, { etaAt: ev.etaAt?.toISOString(), lat: ev.lat, lng: ev.lng, proofPhotoUrl: ev.proofPhotoUrl, driverName: ev.driverName, reason: ev.failureReason }, tx));
  }

  // ───── tracking & dispatcher ─────

  async track(jobIdOrOrderId: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(sql`${deliveryJobs.id}::text = ${jobIdOrOrderId} or ${deliveryJobs.orderId}::text = ${jobIdOrOrderId}`).limit(1);
    if (!job) throw new NotFoundException();
    const events = await this.db.select().from(deliveryEvents).where(eq(deliveryEvents.deliveryJobId, job.id)).orderBy(deliveryEvents.createdAt);
    const last = [...events].reverse().find((e) => e.lat !== null);
    return { id: job.id, status: job.status, etaAt: job.etaAt, trackingUrl: job.trackingUrl, fleet: job.fleet, courierLocation: last ? { lat: last.lat, lng: last.lng, at: last.createdAt } : null, proofPhotoUrl: job.proofPhotoUrl, events: events.map((e) => ({ type: e.type, at: e.createdAt })) };
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
    if (!isPlatformStaff(user)) assertOrgAccess(user, loc!.organizationId, job.locationId);
    return this.db.transaction((tx) => this.transition(jobId, status, { ...data, actorId: user.sub }, tx));
  }

  /** Re-dispatch a failed/unassigned job (new provider request or new driver offers). */
  async reassign(user: JwtPayload, jobId: string) {
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, job.locationId)).limit(1);
    if (!isPlatformStaff(user)) assertOrgAccess(user, loc!.organizationId, job.locationId);
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
    const [d] = await this.db.update(drivers).set({ status: approved ? 'APPROVED' : 'SUSPENDED', licenseVerified: approved }).where(eq(drivers.id, driverId)).returning();
    if (!d) throw new NotFoundException();
    if (approved) await this.db.update(users).set({ roles: sql`array_append(array_remove(${users.roles}, 'DRIVER'), 'DRIVER')` }).where(eq(users.id, d.userId));
    return d;
  }

  async myDriver(user: JwtPayload) {
    const [d] = await this.db.select().from(drivers).where(eq(drivers.userId, user.sub)).limit(1);
    if (!d) throw new NotFoundException('Not a driver');
    return d;
  }

  async setAvailability(user: JwtPayload, isAvailable: boolean, lat?: number, lng?: number) {
    const d = await this.myDriver(user);
    if (d.status !== 'APPROVED') throw new ForbiddenException('Driver not approved');
    const [u] = await this.db.update(drivers).set({ isAvailable, lastLat: lat ?? d.lastLat, lastLng: lng ?? d.lastLng, lastSeenAt: new Date() }).where(eq(drivers.id, d.id)).returning();
    return u;
  }

  async updateLocation(user: JwtPayload, lat: number, lng: number) {
    const d = await this.myDriver(user);
    await this.db.update(drivers).set({ lastLat: lat, lastLng: lng, lastSeenAt: new Date() }).where(eq(drivers.id, d.id));
    const active = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
    for (const j of active) await this.event(j.id, 'LOCATION', { lat, lng });
    return { ok: true };
  }

  private async offerToNearbyDrivers(job: typeof deliveryJobs.$inferSelect, tx: DbOrTx) {
    const pickup = job.pickupAddress as Address;
    const available = await tx.select().from(drivers).where(and(eq(drivers.isAvailable, true), eq(drivers.status, 'APPROVED')));
    const ranked = available
      .map((d) => ({ d, km: d.lastLat !== null && d.lastLng !== null && pickup.lat !== undefined && pickup.lng !== undefined ? haversineKm(d.lastLat, d.lastLng, pickup.lat, pickup.lng) : 999 }))
      .filter((x) => x.km < 12)
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);
    if (!ranked.length) {
      await tx.update(deliveryJobs).set({ status: 'UNASSIGNED' }).where(eq(deliveryJobs.id, job.id));
      await this.outbox.publish('delivery.failed', job.id, { orderId: job.orderId, reason: 'No drivers available', stage: 'offer' }, tx);
      return;
    }
    await tx.insert(driverOffers).values(ranked.map((r) => ({ driverId: r.d.id, deliveryJobId: job.id, payCents: job.providerCostCents, expiresAt: new Date(Date.now() + 90_000) })));
  }

  async myOffers(user: JwtPayload) {
    const d = await this.myDriver(user);
    const rows = await this.db
      .select({ offer: driverOffers, job: deliveryJobs })
      .from(driverOffers)
      .innerJoin(deliveryJobs, eq(deliveryJobs.id, driverOffers.deliveryJobId))
      .where(and(eq(driverOffers.driverId, d.id), eq(driverOffers.status, 'OFFERED'), sql`${driverOffers.expiresAt} > now()`));
    return rows.map((r) => ({ ...r.offer, pickupAddress: r.job.pickupAddress, dropoffAddress: r.job.dropoffAddress, tipCents: r.job.tipCents }));
  }

  async respondOffer(user: JwtPayload, offerId: string, accept: boolean) {
    const d = await this.myDriver(user);
    return this.db.transaction(async (tx) => {
      const [offer] = await tx.select().from(driverOffers).where(and(eq(driverOffers.id, offerId), eq(driverOffers.driverId, d.id))).limit(1);
      if (!offer) throw new NotFoundException();
      if (offer.status !== 'OFFERED' || offer.expiresAt < new Date()) throw new ConflictException('Offer no longer available');
      if (!accept) {
        await tx.update(driverOffers).set({ status: 'DECLINED' }).where(eq(driverOffers.id, offerId));
        return { ok: true };
      }
      // first accept wins
      const [job] = await tx.update(deliveryJobs).set({ driverId: d.id }).where(and(eq(deliveryJobs.id, offer.deliveryJobId), isNull(deliveryJobs.driverId))).returning();
      if (!job) throw new ConflictException('Job already taken');
      await tx.update(driverOffers).set({ status: 'ACCEPTED' }).where(eq(driverOffers.id, offerId));
      await tx.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.deliveryJobId, job.id), eq(driverOffers.status, 'OFFERED')));
      await this.transition(job.id, 'ASSIGNED', { driverId: d.id }, tx);
      return job;
    });
  }

  async myActiveJobs(user: JwtPayload) {
    const d = await this.myDriver(user);
    return this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.driverId, d.id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
  }

  async driverTransition(user: JwtPayload, jobId: string, status: 'PICKED_UP' | 'DELIVERED' | 'FAILED', data: { proofPhotoUrl?: string; proofSignature?: string; reason?: string; lat?: number; lng?: number }) {
    const d = await this.myDriver(user);
    const [job] = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.id, jobId), eq(deliveryJobs.driverId, d.id))).limit(1);
    if (!job) throw new NotFoundException();
    if (status === 'DELIVERED' && !data.proofPhotoUrl && !data.proofSignature) throw new BadRequestException('Proof of handoff required');
    return this.db.transaction((tx) => this.transition(jobId, status, { ...data, costOwner: status === 'FAILED' ? 'PLATFORM' : undefined }, tx));
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
        await this.db.transaction((tx) => this.offerToNearbyDrivers(job, tx));
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
    const jobs = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.provider, 'mock'), inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'PICKED_UP'])));
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
