import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { COURIER_DOC_KINDS, HARD_REQUIREMENTS, REQUIRED_COURIER_DOCS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { courierDocuments, courierRecords, courierShifts, deliveryJobs, deliveryRestrictions, deliveryZones, driverEarnings, driverOffers, drivers, incidents, locations, providerConnections, users } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { haversineKm, pointInPolygon } from '../../common/utils';
import { DeliveryService } from './delivery.service';
import type { Address } from './providers/delivery-provider';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const n = (x: unknown) => (x == null ? 0 : Number(x));
const r1 = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10) / 10);

/** Phase G admin: delivery areas & restrictions, couriers, dispatch board and analysis. */
@Injectable()
export class DeliveryAdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly delivery: DeliveryService, private readonly audit: AuditService, private readonly ledger: LedgerService) {}

  // ───── 15 zones, restrictions, coverage ─────

  async upsertZone(user: JwtPayload, locationId: string, input: { id?: string; name: string; polygon?: unknown; feeCents: number; minOrderCents?: number; etaMinutes?: number; isActive?: boolean; kind?: 'SERVICE' | 'EXCLUSION'; locationIds?: string[]; kitchenId?: string | null; travelMinutesPerKm?: number | null; capacityPerHour?: number | null; hours?: { dayOfWeek: number; opens: string; closes: string }[] | null; feeTiers?: { upToKm: number; feeCents: number }[] }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const poly = input.polygon as { type?: string; coordinates?: number[][][] } | undefined;
    if (poly && (!Array.isArray(poly.coordinates?.[0]) || poly.coordinates![0].length < 4)) throw new BadRequestException('A zone needs at least three corners');
    // 15.2 a zone may also serve other locations of the same merchant
    if (input.locationIds?.length) {
      const others = await this.db.select({ id: locations.id, org: locations.organizationId }).from(locations).where(inArray(locations.id, input.locationIds));
      if (others.length !== input.locationIds.length || others.some((o) => o.org !== loc.organizationId)) throw new BadRequestException('Zones can only be shared with locations of the same merchant');
    }
    const v = { ...input, polygon: input.polygon ?? null, regionId: loc.regionId, feeTiers: input.feeTiers ?? [], locationIds: input.locationIds ?? [] };
    const [z] = input.id
      ? await this.db.update(deliveryZones).set(v).where(and(eq(deliveryZones.id, input.id), eq(deliveryZones.locationId, locationId))).returning()
      : await this.db.insert(deliveryZones).values({ ...v, locationId }).returning();
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'delivery.zone', entityType: 'delivery_zone', entityId: z.id, after: z });
    return z;
  }

  async zonesFor(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const zones = await this.delivery.zonesServing(loc);
    const all = await this.db.select().from(deliveryZones).where(eq(deliveryZones.locationId, locationId));
    const byId = new Map([...zones, ...all].map((z) => [z.id, z]));
    return { location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng, radiusKm: loc.deliveryRadiusKm, deliveryWindowMinutes: loc.deliveryWindowMinutes, deliveryWindowCapacity: loc.deliveryWindowCapacity }, zones: [...byId.values()], restrictions: await this.delivery.activeRestrictions({ locationId, regionId: loc.regionId }) };
  }

  /** Admin map: every zone and location (optionally one region). */
  async network(user: JwtPayload, regionId?: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const locs = await this.db.select({ id: locations.id, name: locations.name, lat: locations.lat, lng: locations.lng, radiusKm: locations.deliveryRadiusKm, fleet: locations.deliveryFleet, regionId: locations.regionId, acceptsDelivery: locations.acceptsDelivery }).from(locations).where(and(eq(locations.status, 'LIVE'), ...(regionId ? [eq(locations.regionId, regionId)] : [])));
    const zones = await this.db.select().from(deliveryZones).where(regionId ? eq(deliveryZones.regionId, regionId) : sql`true`);
    return { locations: locs, zones };
  }

  async restrictions(user: JwtPayload, all = false) {
    assertCan(user, 'delivery.read', 'ops.read');
    const list = await this.db.select().from(deliveryRestrictions).where(all ? sql`true` : and(isNull(deliveryRestrictions.liftedAt), sql`${deliveryRestrictions.endsAt} > now()`)).orderBy(desc(deliveryRestrictions.createdAt)).limit(200);
    return list;
  }

  async addRestriction(user: JwtPayload, input: { kind: 'PAUSE' | 'SHRINK_RADIUS' | 'ADD_MINUTES'; value?: number | null; reason: string; zoneId?: string | null; locationId?: string | null; regionId?: string | null; startsAt?: string; endsAt: string }) {
    assertCan(user, 'delivery.manage');
    if (input.kind !== 'PAUSE' && !input.value) throw new BadRequestException('A value is required');
    const starts = input.startsAt ? new Date(input.startsAt) : new Date();
    const ends = new Date(input.endsAt);
    if (ends <= starts) throw new BadRequestException('End must be after start');
    if (ends.getTime() - starts.getTime() > 7 * 86400_000) throw new BadRequestException('Restrictions last at most 7 days; renew them if needed');
    const [r] = await this.db.insert(deliveryRestrictions).values({ kind: input.kind, value: input.value ?? null, reason: input.reason, zoneId: input.zoneId ?? null, locationId: input.locationId ?? null, regionId: input.regionId ?? null, startsAt: starts, endsAt: ends, createdById: user.sub }).returning();
    await this.audit.log({ actorId: user.sub, action: 'delivery.restriction', entityType: 'delivery_restriction', entityId: r.id, after: r, reason: input.reason });
    return r;
  }

  async liftRestriction(user: JwtPayload, id: string) {
    assertCan(user, 'delivery.manage');
    const [r] = await this.db.update(deliveryRestrictions).set({ liftedAt: new Date() }).where(and(eq(deliveryRestrictions.id, id), isNull(deliveryRestrictions.liftedAt))).returning();
    if (!r) throw new NotFoundException();
    await this.audit.log({ actorId: user.sub, action: 'delivery.restriction_lift', entityType: 'delivery_restriction', entityId: id });
    return r;
  }

  /**
   * 15.8 coverage simulation for a proposed location: sample a grid inside the radius and report how much is
   * deliverable (minus exclusion zones), how much existing locations already cover, and the travel ETA.
   */
  async coverage(user: JwtPayload, input: { lat: number; lng: number; radiusKm: number; stepKm?: number; prepMinutes?: number }) {
    assertCan(user, 'delivery.read', 'merchants.read');
    const step = Math.max(0.25, input.stepKm ?? Math.max(0.25, input.radiusKm / 12));
    const dLat = step / 111, dLng = step / (111 * Math.cos((input.lat * Math.PI) / 180));
    const pts: { lat: number; lng: number; km: number }[] = [];
    for (let y = -input.radiusKm; y <= input.radiusKm; y += step) for (let x = -input.radiusKm; x <= input.radiusKm; x += step) {
      const p = { lat: input.lat + (y / step) * dLat, lng: input.lng + (x / step) * dLng };
      const km = haversineKm(input.lat, input.lng, p.lat, p.lng);
      if (km <= input.radiusKm) pts.push({ ...p, km });
    }
    const locs = await this.db.select().from(locations).where(and(eq(locations.status, 'LIVE'), eq(locations.acceptsDelivery, true)));
    const zones = await this.db.select().from(deliveryZones).where(eq(deliveryZones.isActive, true));
    const inZone = (z: typeof zones[number], p: { lat: number; lng: number }) => !!z.polygon && pointInPolygon(p.lng, p.lat, z.polygon as { coordinates: number[][][] });
    const excluded = (p: { lat: number; lng: number }) => zones.some((z) => z.kind === 'EXCLUSION' && inZone(z, p));
    const servedBy = (l: typeof locs[number], p: { lat: number; lng: number }) => {
      const own = zones.filter((z) => z.kind !== 'EXCLUSION' && (z.locationId === l.id || z.locationIds.includes(l.id)));
      if (own.length) return own.some((z) => inZone(z, p));
      return l.lat !== null && l.lng !== null && haversineKm(l.lat, l.lng, p.lat, p.lng) <= l.deliveryRadiusKm;
    };
    const ok = pts.filter((p) => !excluded(p));
    const overlap = new Map<string, number>();
    let covered = 0;
    for (const p of ok) {
      let any = false;
      for (const l of locs) if (servedBy(l, p)) { overlap.set(l.id, (overlap.get(l.id) || 0) + 1); any = true; }
      if (any) covered++;
    }
    const travel = ok.map((p) => p.km * 3 + 5);
    return {
      samples: pts.length, deliverablePct: pts.length ? Math.round((ok.length / pts.length) * 100) : 0, excludedPct: pts.length ? Math.round(((pts.length - ok.length) / pts.length) * 100) : 0,
      alreadyCoveredPct: ok.length ? Math.round((covered / ok.length) * 100) : 0,
      avgEtaMinutes: travel.length ? Math.round((input.prepMinutes ?? 20) + travel.reduce((a, b) => a + b, 0) / travel.length) : null,
      maxEtaMinutes: travel.length ? Math.round((input.prepMinutes ?? 20) + Math.max(...travel)) : null,
      overlaps: [...overlap.entries()].map(([id, c]) => ({ id, name: locs.find((l) => l.id === id)!.name, sharedPct: Math.round((c / ok.length) * 100) })).sort((a, b) => b.sharedPct - a.sharedPct),
      points: pts.length <= 600 ? pts.map((p) => ({ lat: p.lat, lng: p.lng, excluded: excluded(p) })) : [],
    };
  }

  // ───── 16 couriers ─────

  private async requireDriver(id: string) {
    const [d] = await this.db.select({ d: drivers, name: users.name, email: users.email, phone: users.phone }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, id)).limit(1);
    if (!d) throw new NotFoundException('Courier not found');
    return d;
  }

  /** 16.5 acceptance, completion, cancellation and on-time rates. */
  async metrics(driverIds: string[], days = 30) {
    if (!driverIds.length) return new Map<string, Record<string, number | null>>();
    const arr = `{${driverIds.join(',')}}`;
    const from = new Date(Date.now() - days * 86400_000).toISOString();
    const offers = rows<{ d: string; total: number; accepted: number; declined: number; expired: number }>(await this.db.execute(sql`select driver_id as d, count(*)::int as total, count(*) filter (where status='ACCEPTED')::int as accepted, count(*) filter (where status='DECLINED')::int as declined, count(*) filter (where status='EXPIRED')::int as expired from driver_offers where driver_id = any(${arr}::uuid[]) and created_at >= ${from} group by 1`));
    const jobs = rows<{ d: string; total: number; delivered: number; failed: number; on_time: number; with_eta: number; avg_wait: number | null }>(await this.db.execute(sql`select driver_id as d, count(*)::int as total, count(*) filter (where status='DELIVERED')::int as delivered, count(*) filter (where status in ('FAILED','RETURNED','CANCELED') and cost_owner in ('DRIVER','PLATFORM'))::int as failed,
      count(*) filter (where status='DELIVERED' and eta_at is not null and delivered_at <= eta_at + interval '5 minutes')::int as on_time, count(*) filter (where status='DELIVERED' and eta_at is not null)::int as with_eta,
      avg(extract(epoch from picked_up_at - arrived_pickup_at)/60) filter (where picked_up_at is not null and arrived_pickup_at is not null) as avg_wait
      from delivery_jobs where driver_id = any(${arr}::uuid[]) and created_at >= ${from} group by 1`));
    const out = new Map<string, Record<string, number | null>>();
    for (const id of driverIds) {
      const o = offers.find((x) => x.d === id);
      const j = jobs.find((x) => x.d === id);
      const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
      out.set(id, { offers: o?.total ?? 0, acceptanceRate: pct(o?.accepted ?? 0, o?.total ?? 0), jobs: j?.total ?? 0, delivered: j?.delivered ?? 0, completionRate: pct(j?.delivered ?? 0, j?.total ?? 0), cancellationRate: pct(j?.failed ?? 0, j?.total ?? 0), onTimeRate: pct(j?.on_time ?? 0, j?.with_eta ?? 0), avgPickupWaitMinutes: r1(j?.avg_wait) });
    }
    return out;
  }

  /** 16.1 directory with operational status and reliability. */
  async couriers(user: JwtPayload, f: { status?: string; regionId?: string; vehicleType?: string; q?: string }) {
    assertCan(user, 'delivery.read', 'ops.read');
    const list = await this.db.select({ d: drivers, name: users.name, email: users.email, phone: users.phone }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(and(...(f.status ? [eq(drivers.status, f.status)] : []), ...(f.regionId ? [eq(drivers.regionId, f.regionId)] : []), ...(f.vehicleType ? [eq(drivers.vehicleType, f.vehicleType)] : []), ...(f.q ? [sql`(${users.name} ilike ${'%' + f.q + '%'} or ${users.email} ilike ${'%' + f.q + '%'})`] : []))).orderBy(users.name).limit(300);
    const ids = list.map((x) => x.d.id);
    const m = await this.metrics(ids);
    const active = ids.length ? await this.db.select({ d: deliveryJobs.driverId, n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(inArray(deliveryJobs.driverId, ids), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP']))).groupBy(deliveryJobs.driverId) : [];
    const docs = ids.length ? await this.db.select().from(courierDocuments).where(inArray(courierDocuments.driverId, ids)) : [];
    return list.map(({ d, name, email, phone }) => {
      const a = active.find((x) => x.d === d.id)?.n ?? 0;
      const myDocs = docs.filter((x) => x.driverId === d.id);
      const docIssue = REQUIRED_COURIER_DOCS.filter((k) => !myDocs.some((x) => x.kind === k && x.status === 'APPROVED' && (!x.expiresAt || x.expiresAt > new Date())));
      return { id: d.id, userId: d.userId, name, email, phone, status: d.status, vehicleType: d.vehicleType, capabilities: d.capabilities, regionId: d.regionId, zoneIds: d.zoneIds, isAvailable: d.isAvailable, lastSeenAt: d.lastSeenAt, appealStatus: d.appealStatus, operational: d.status !== 'APPROVED' ? d.status : a > 0 ? 'ON_DELIVERY' : d.isAvailable ? 'ONLINE' : 'OFFLINE', activeJobs: a, missingDocs: docIssue, pendingDocs: myDocs.filter((x) => x.status === 'PENDING').length, metrics: m.get(d.id) };
    });
  }

  /** 16.1–16.8 courier profile: documents, shifts, metrics, records, support history, earnings & adjustments, jobs. */
  async courier(user: JwtPayload, id: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const { d, name, email, phone } = await this.requireDriver(id);
    const docs = await this.db.select().from(courierDocuments).where(eq(courierDocuments.driverId, id)).orderBy(desc(courierDocuments.createdAt));
    const shifts = await this.db.select().from(courierShifts).where(and(eq(courierShifts.driverId, id), gte(courierShifts.endsAt, new Date(Date.now() - 7 * 86400_000)))).orderBy(courierShifts.startsAt);
    const records = await this.db.select().from(courierRecords).where(eq(courierRecords.driverId, id)).orderBy(desc(courierRecords.createdAt)).limit(100);
    const jobs = await this.db.select({ id: deliveryJobs.id, orderId: deliveryJobs.orderId, status: deliveryJobs.status, createdAt: deliveryJobs.createdAt, deliveredAt: deliveryJobs.deliveredAt, etaAt: deliveryJobs.etaAt, locationId: deliveryJobs.locationId, batchId: deliveryJobs.batchId, exception: deliveryJobs.exception }).from(deliveryJobs).where(eq(deliveryJobs.driverId, id)).orderBy(desc(deliveryJobs.createdAt)).limit(50);
    const jobIds = jobs.map((j) => j.id);
    const support = jobIds.length ? await this.db.select({ id: incidents.id, category: incidents.category, status: incidents.status, owner: incidents.owner, remedyCents: incidents.remedyCents, createdAt: incidents.createdAt }).from(incidents).where(inArray(incidents.deliveryJobId, jobIds)).orderBy(desc(incidents.createdAt)) : [];
    const earnings = await this.db.select().from(driverEarnings).where(eq(driverEarnings.driverId, id)).orderBy(desc(driverEarnings.createdAt)).limit(100);
    const payable = await this.ledger.balance('DRIVER_PAYABLE', id);
    const m = (await this.metrics([id], 30)).get(id);
    return { courier: { ...d, name, email, phone }, documents: docs, shifts, records, jobs, support, earnings, payableCents: payable, metrics: m };
  }

  async updateCourier(user: JwtPayload, id: string, input: { vehicleType?: string; capabilities?: string[]; regionId?: string | null; zoneIds?: string[]; maxConcurrent?: number }) {
    assertCan(user, 'delivery.manage');
    const { d } = await this.requireDriver(id);
    const [u] = await this.db.update(drivers).set(input).where(eq(drivers.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'courier.update', entityType: 'driver', entityId: id, before: { vehicleType: d.vehicleType, capabilities: d.capabilities, regionId: d.regionId, zoneIds: d.zoneIds, maxConcurrent: d.maxConcurrent }, after: input });
    return u;
  }

  // 16.2 documents
  async myDocuments(user: JwtPayload) {
    const d = await this.delivery.myDriver(user);
    return this.db.select().from(courierDocuments).where(eq(courierDocuments.driverId, d.id)).orderBy(desc(courierDocuments.createdAt));
  }

  async uploadDocument(user: JwtPayload, input: { kind: string; fileUrl: string; expiresAt?: string }) {
    const d = await this.delivery.myDriver(user);
    if (!(COURIER_DOC_KINDS as readonly string[]).includes(input.kind)) throw new BadRequestException('Unknown document type');
    if (input.expiresAt && new Date(input.expiresAt) < new Date()) throw new BadRequestException('This document has already expired');
    const [doc] = await this.db.insert(courierDocuments).values({ driverId: d.id, kind: input.kind, fileUrl: input.fileUrl, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }).returning();
    return doc;
  }

  async documentQueue(user: JwtPayload) {
    assertCan(user, 'delivery.manage');
    const soon = new Date(Date.now() + (await this.delivery.dispatchCfg()).docExpiryWarnDays * 86400_000);
    const pending = await this.db.select({ doc: courierDocuments, name: users.name, email: users.email }).from(courierDocuments).innerJoin(drivers, eq(drivers.id, courierDocuments.driverId)).innerJoin(users, eq(users.id, drivers.userId)).where(eq(courierDocuments.status, 'PENDING')).orderBy(courierDocuments.createdAt);
    const expiring = await this.db.select({ doc: courierDocuments, name: users.name, email: users.email }).from(courierDocuments).innerJoin(drivers, eq(drivers.id, courierDocuments.driverId)).innerJoin(users, eq(users.id, drivers.userId)).where(and(eq(courierDocuments.status, 'APPROVED'), sql`${courierDocuments.expiresAt} < ${soon.toISOString()}`)).orderBy(courierDocuments.expiresAt);
    const flat = (x: { doc: typeof courierDocuments.$inferSelect; name: string | null; email: string }) => ({ ...x.doc, courierName: x.name, courierEmail: x.email });
    return { pending: pending.map(flat), expiring: expiring.map(flat) };
  }

  async reviewDocument(user: JwtPayload, docId: string, approve: boolean, note?: string, expiresAt?: string) {
    assertCan(user, 'delivery.manage');
    const [doc] = await this.db.select().from(courierDocuments).where(eq(courierDocuments.id, docId)).limit(1);
    if (!doc) throw new NotFoundException();
    if (doc.status !== 'PENDING') throw new ConflictException(`Document is ${doc.status.toLowerCase()}`);
    if (!approve && !note) throw new BadRequestException('Say why the document is rejected');
    const exp = expiresAt ? new Date(expiresAt) : doc.expiresAt;
    if (approve && (REQUIRED_COURIER_DOCS as string[]).includes(doc.kind) && doc.kind !== 'BACKGROUND_CHECK' && !exp) throw new BadRequestException('Set the expiry date for this document');
    const [u] = await this.db.update(courierDocuments).set({ status: approve ? 'APPROVED' : 'REJECTED', reviewedById: user.sub, reviewNote: note ?? null, reviewedAt: new Date(), expiresAt: exp }).where(eq(courierDocuments.id, docId)).returning();
    await this.audit.log({ actorId: user.sub, action: approve ? 'courier.document_approve' : 'courier.document_reject', entityType: 'courier_document', entityId: docId, reason: note });
    return u;
  }

  // 16.4 shifts
  async myShifts(user: JwtPayload) {
    const d = await this.delivery.myDriver(user);
    return this.db.select().from(courierShifts).where(and(eq(courierShifts.driverId, d.id), gte(courierShifts.endsAt, new Date()), eq(courierShifts.status, 'SCHEDULED'))).orderBy(courierShifts.startsAt);
  }

  async addShift(user: JwtPayload, input: { startsAt: string; endsAt: string; zoneId?: string }) {
    const d = await this.delivery.myDriver(user);
    const s = new Date(input.startsAt), e = new Date(input.endsAt);
    if (e <= s || e.getTime() - s.getTime() > 12 * 3600_000) throw new BadRequestException('Shifts are up to 12 hours');
    const [overlap] = await this.db.select().from(courierShifts).where(and(eq(courierShifts.driverId, d.id), eq(courierShifts.status, 'SCHEDULED'), sql`${courierShifts.startsAt} < ${e.toISOString()} and ${courierShifts.endsAt} > ${s.toISOString()}`)).limit(1);
    if (overlap) throw new ConflictException('This overlaps another shift');
    const [row] = await this.db.insert(courierShifts).values({ driverId: d.id, startsAt: s, endsAt: e, zoneId: input.zoneId ?? null }).returning();
    return row;
  }

  async cancelShift(user: JwtPayload, id: string) {
    const d = await this.delivery.myDriver(user);
    const [row] = await this.db.update(courierShifts).set({ status: 'CANCELED' }).where(and(eq(courierShifts.id, id), eq(courierShifts.driverId, d.id))).returning();
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Staff: shifts scheduled across couriers for a day range (coverage planning). */
  async shiftBoard(user: JwtPayload, days = 2) {
    assertCan(user, 'delivery.read');
    return this.db.select({ s: courierShifts, name: users.name, vehicleType: drivers.vehicleType }).from(courierShifts).innerJoin(drivers, eq(drivers.id, courierShifts.driverId)).innerJoin(users, eq(users.id, drivers.userId)).where(and(eq(courierShifts.status, 'SCHEDULED'), gte(courierShifts.endsAt, new Date()), sql`${courierShifts.startsAt} < ${new Date(Date.now() + days * 86400_000).toISOString()}`)).orderBy(courierShifts.startsAt).then((r) => r.map((x) => ({ ...x.s, name: x.name, vehicleType: x.vehicleType })));
  }

  // 16.6 records
  async addRecord(user: JwtPayload, id: string, input: { kind: 'INCIDENT' | 'TRAINING' | 'SUPPORT_NOTE'; title: string; detail?: string; severity?: number }) {
    assertCan(user, 'delivery.manage', 'support.manage');
    await this.requireDriver(id);
    const [r] = await this.db.insert(courierRecords).values({ driverId: id, ...input, createdById: user.sub }).returning();
    return r;
  }

  /** 16.7 bonus or deduction with a reason; posted to the courier's payable balance. */
  async adjust(user: JwtPayload, id: string, input: { cents: number; reason: string; deliveryJobId?: string }) {
    assertCan(user, 'delivery.manage');
    if (!input.cents) throw new BadRequestException('Amount cannot be zero');
    await this.requireDriver(id);
    const bonus = input.cents > 0;
    return this.db.transaction(async (tx) => {
      const [e] = await tx.insert(driverEarnings).values({ driverId: id, deliveryJobId: input.deliveryJobId ?? null, baseCents: 0, bonusCents: input.cents, kind: bonus ? 'BONUS' : 'DEDUCTION', reason: input.reason, createdById: user.sub }).returning();
      const amt = Math.abs(input.cents);
      await this.ledger.post({ currency: 'USD' }, bonus
        ? [{ account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', debitCents: amt, memo: `Courier bonus: ${input.reason}` }, { account: 'DRIVER_PAYABLE', partyId: id, creditCents: amt, memo: `Bonus: ${input.reason}` }]
        : [{ account: 'DRIVER_PAYABLE', partyId: id, debitCents: amt, memo: `Deduction: ${input.reason}` }, { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', creditCents: amt, memo: `Courier deduction: ${input.reason}` }], tx);
      await this.audit.log({ actorId: user.sub, action: bonus ? 'courier.bonus' : 'courier.deduction', entityType: 'driver', entityId: id, after: e, reason: input.reason }, tx);
      return e;
    });
  }

  /** 16.8 suspension with a reason; open offers are withdrawn and the courier goes offline. */
  async suspend(user: JwtPayload, id: string, reason: string) {
    assertCan(user, 'delivery.manage');
    const { d } = await this.requireDriver(id);
    if (d.status === 'SUSPENDED') throw new ConflictException('Already suspended');
    const active = await this.db.select({ id: deliveryJobs.id }).from(deliveryJobs).where(and(eq(deliveryJobs.driverId, id), inArray(deliveryJobs.status, ['ASSIGNED', 'PICKED_UP'])));
    if (active.length) throw new ConflictException(`Reassign the courier’s ${active.length} active deliver${active.length > 1 ? 'ies' : 'y'} first`);
    const [u] = await this.db.update(drivers).set({ status: 'SUSPENDED', isAvailable: false, suspendedReason: reason, suspendedAt: new Date(), suspendedById: user.sub, appealStatus: 'NONE', appealNote: null, appealDecisionNote: null, reviewedById: null }).where(eq(drivers.id, id)).returning();
    await this.db.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.driverId, id), eq(driverOffers.status, 'OFFERED')));
    await this.db.insert(courierRecords).values({ driverId: id, kind: 'INCIDENT', title: 'Suspended', detail: reason, createdById: user.sub });
    await this.audit.log({ actorId: user.sub, action: 'courier.suspend', entityType: 'driver', entityId: id, reason });
    return u;
  }

  async appeal(user: JwtPayload, note: string) {
    const d = await this.delivery.myDriver(user);
    if (d.status !== 'SUSPENDED') throw new ConflictException('Only a suspended account can appeal');
    if (d.appealStatus === 'PENDING') throw new ConflictException('Your appeal is already being reviewed');
    const [u] = await this.db.update(drivers).set({ appealStatus: 'PENDING', appealNote: note }).where(eq(drivers.id, d.id)).returning();
    return { status: u.status, appealStatus: u.appealStatus };
  }

  /** 16.8 a person other than the one who suspended decides the appeal. */
  async decideAppeal(user: JwtPayload, id: string, reinstate: boolean, note: string) {
    assertCan(user, 'delivery.manage');
    const { d } = await this.requireDriver(id);
    if (d.appealStatus !== 'PENDING') throw new ConflictException('No appeal waiting');
    if (d.suspendedById === user.sub) throw new ForbiddenException('Someone other than the person who suspended the courier must review the appeal');
    const [u] = await this.db.update(drivers).set(reinstate ? { status: 'APPROVED', appealStatus: 'REINSTATED', appealDecisionNote: note, reviewedById: user.sub, suspendedReason: null } : { appealStatus: 'UPHELD', appealDecisionNote: note, reviewedById: user.sub }).where(eq(drivers.id, id)).returning();
    await this.db.insert(courierRecords).values({ driverId: id, kind: 'SUPPORT_NOTE', title: reinstate ? 'Appeal accepted: reinstated' : 'Appeal reviewed: suspension upheld', detail: note, createdById: user.sub });
    await this.audit.log({ actorId: user.sub, action: reinstate ? 'courier.reinstate' : 'courier.appeal_upheld', entityType: 'driver', entityId: id, reason: note });
    return u;
  }

  async myStanding(user: JwtPayload) {
    const d = await this.delivery.myDriver(user);
    const m = (await this.metrics([d.id], 30)).get(d.id);
    const docs = await this.db.select().from(courierDocuments).where(eq(courierDocuments.driverId, d.id));
    const missing = REQUIRED_COURIER_DOCS.filter((k) => !docs.some((x) => x.kind === k && x.status === 'APPROVED' && (!x.expiresAt || x.expiresAt > new Date())));
    return { status: d.status, suspendedReason: d.suspendedReason, appealStatus: d.appealStatus, appealDecisionNote: d.appealDecisionNote, vehicleType: d.vehicleType, capabilities: d.capabilities, missingDocs: missing, metrics: m };
  }

  // ───── 16.4 / 17.9 provider connections ─────
  async providers(user: JwtPayload) {
    assertCan(user, 'delivery.read');
    return this.db.select().from(providerConnections).orderBy(providerConnections.regionId, providerConnections.priority);
  }
  async upsertProvider(user: JwtPayload, input: { id?: string; regionId?: string | null; provider: string; priority: number; isActive?: boolean }) {
    assertCan(user, 'delivery.manage');
    const v = { regionId: input.regionId ?? null, provider: input.provider, priority: input.priority, isActive: input.isActive ?? true };
    const [r] = input.id ? await this.db.update(providerConnections).set(v).where(eq(providerConnections.id, input.id)).returning() : await this.db.insert(providerConnections).values(v).returning();
    await this.audit.log({ actorId: user.sub, action: 'delivery.provider', entityType: 'provider_connection', entityId: r.id, after: r });
    return r;
  }

  // ───── 17 dispatch ─────

  /** 17.1 live map: couriers, pickup points and active deliveries. */
  async live(user: JwtPayload, regionId?: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const jobs = await this.db.select({ j: deliveryJobs, locName: locations.name, regionId: locations.regionId, lat: locations.lat, lng: locations.lng }).from(deliveryJobs).innerJoin(locations, eq(locations.id, deliveryJobs.locationId)).where(and(inArray(deliveryJobs.status, ['QUOTED', 'REQUESTED', 'UNASSIGNED', 'ASSIGNED', 'PICKED_UP']), ...(regionId ? [eq(locations.regionId, regionId)] : [])));
    const ds = await this.db.select({ d: drivers, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(and(eq(drivers.status, 'APPROVED'), sql`${drivers.lastSeenAt} > now() - interval '2 hours'`, ...(regionId ? [eq(drivers.regionId, regionId)] : [])));
    const now = Date.now();
    const pickups = new Map<string, { id: string; name: string; lat: number | null; lng: number | null; jobs: number }>();
    for (const x of jobs) { const p = pickups.get(x.j.locationId) || { id: x.j.locationId, name: x.locName, lat: x.lat, lng: x.lng, jobs: 0 }; p.jobs++; pickups.set(x.j.locationId, p); }
    return {
      couriers: ds.map(({ d, name }) => { const mine = jobs.filter((x) => x.j.driverId === d.id); return { id: d.id, name, lat: d.lastLat, lng: d.lastLng, lastSeenAt: d.lastSeenAt, vehicleType: d.vehicleType, status: mine.length ? 'ON_DELIVERY' : d.isAvailable ? 'ONLINE' : 'OFFLINE', activeJobs: mine.length }; }),
      pickups: [...pickups.values()],
      deliveries: jobs.map(({ j, locName }) => {
        const drop = j.dropoffAddress as Address;
        return { id: j.id, orderId: j.orderId, status: j.status, fleet: j.fleet, provider: j.provider, location: locName, locationId: j.locationId, driverId: j.driverId, batchId: j.batchId, etaAt: j.etaAt, late: !!j.etaAt && j.etaAt.getTime() < now, dropoff: { lat: drop.lat ?? null, lng: drop.lng ?? null, line1: drop.line1 }, requirements: j.requirements, offerAttempts: j.offerAttempts, exception: j.exception ? (j.exception as { kind: string }).kind : null, needsAttention: j.status === 'UNASSIGNED' || (j.status === 'REQUESTED' && now - j.createdAt.getTime() > 10 * 60_000) || !!(j.exception && !(j.exception as { resolution?: string }).resolution) };
      }),
    };
  }

  /** 17.3 manual assignment with an audited reason; the courier must be active and capable. */
  async assign(user: JwtPayload, jobId: string, driverId: string, reason: string) {
    assertCan(user, 'delivery.manage');
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException();
    if (!['QUOTED', 'REQUESTED', 'UNASSIGNED', 'ASSIGNED'].includes(job.status)) throw new ConflictException(`Delivery is ${job.status}`);
    if (job.fleet === 'PARTNER') throw new ConflictException('This delivery is with a partner provider; cancel and re-dispatch to the own fleet first');
    const { d } = await this.requireDriver(driverId);
    if (d.status !== 'APPROVED') throw new BadRequestException('Courier is not active');
    const missing = HARD_REQUIREMENTS.filter((r) => job.requirements.includes(r) && !d.capabilities.includes(r));
    if (missing.length) throw new BadRequestException(`Courier lacks: ${missing.join(', ').toLowerCase()}`);
    return this.db.transaction(async (tx) => {
      await tx.update(driverOffers).set({ status: 'EXPIRED' }).where(and(eq(driverOffers.deliveryJobId, jobId), eq(driverOffers.status, 'OFFERED')));
      await tx.update(deliveryJobs).set({ driverId, fleet: 'PLATFORM', provider: 'platform', status: job.status === 'ASSIGNED' ? 'REQUESTED' : job.status }).where(eq(deliveryJobs.id, jobId));
      const u = await this.delivery.transition(jobId, 'ASSIGNED', { driverId, manual: true, reason, by: user.sub }, tx);
      await this.audit.log({ actorId: user.sub, action: 'delivery.assign', entityType: 'delivery_job', entityId: jobId, before: { driverId: job.driverId }, after: { driverId }, reason }, tx);
      return u;
    });
  }

  /** 17.10 waiting time and cost by zone or provider. */
  async analysis(user: JwtPayload, by: 'zone' | 'provider' | 'location', days = 30) {
    assertCan(user, 'delivery.read', 'finance.read');
    const from = new Date(Date.now() - days * 86400_000).toISOString();
    const key = by === 'zone' ? sql`coalesce(z.name, '(radius)')` : by === 'location' ? sql`l.name` : sql`j.provider`;
    const r = rows<Record<string, unknown>>(await this.db.execute(sql`select ${key} as key, count(*)::int as jobs, count(*) filter (where j.status='DELIVERED')::int as delivered, count(*) filter (where j.status in ('FAILED','RETURNED'))::int as failed,
      count(*) filter (where j.status='DELIVERED' and j.eta_at is not null and j.delivered_at <= j.eta_at + interval '5 minutes')::int as on_time, count(*) filter (where j.status='DELIVERED' and j.eta_at is not null)::int as with_eta,
      avg(extract(epoch from j.picked_up_at - j.arrived_pickup_at)/60) filter (where j.arrived_pickup_at is not null and j.picked_up_at is not null) as pickup_wait,
      avg(extract(epoch from j.delivered_at - j.picked_up_at)/60) filter (where j.delivered_at is not null and j.picked_up_at is not null) as drive,
      avg(j.distance_km) as km, coalesce(sum(j.provider_cost_cents) filter (where j.status='DELIVERED'),0)::bigint as cost, coalesce(sum(j.platform_subsidy_cents),0)::bigint as subsidy, coalesce(sum(j.retail_fee_cents) filter (where j.status='DELIVERED'),0)::bigint as fees
      from delivery_jobs j join locations l on l.id = j.location_id left join delivery_zones z on z.id = j.zone_id where j.created_at >= ${from} group by 1 order by 2 desc`));
    return { by, days, rows: r.map((x) => ({ key: String(x.key), jobs: n(x.jobs), delivered: n(x.delivered), failed: n(x.failed), onTimePct: n(x.with_eta) ? Math.round((n(x.on_time) / n(x.with_eta)) * 100) : null, avgPickupWaitMinutes: r1(x.pickup_wait), avgDriveMinutes: r1(x.drive), avgKm: r1(x.km), costCents: n(x.cost), feesCents: n(x.fees), subsidyCents: n(x.subsidy), costPerDeliveryCents: n(x.delivered) ? Math.round(n(x.cost) / n(x.delivered)) : null })) };
  }

  /** Staff resolve or log delivery exceptions (17.7) on behalf of a courier. */
  async staffException(user: JwtPayload, jobId: string, input: { kind: string; method?: string; note?: string; correctedAddress?: Address }) { assertCan(user, 'delivery.manage'); return this.delivery.driverException(user, jobId, input, true); }
  async staffResolve(user: JwtPayload, jobId: string, input: { resolution: 'RETURN' | 'DISPOSE' | 'SAFE_PLACE'; note?: string; proofPhotoUrl?: string }) { assertCan(user, 'delivery.manage'); return this.delivery.resolveException(user, jobId, input, true); }

  isStaff(user: JwtPayload) { return isPlatformStaff(user); }
}
