import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { brands, kitchenBrands, kitchens, legalSellers, locationClosures, locationLaunchItems, locations, menuCategories, menuItems, menus, merchantAgreementAcceptances, merchantContracts, openingHours, orders, orgMemberships, regions, stations } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { assertCan, assertOrgAccess, can, isPlatformStaff, JwtPayload, MANAGER_ROLES, staffCovers } from '../../common/auth';
import { brandBlockReason } from '../../common/brand-rules';
import { OnboardingService } from '../onboarding/onboarding.service';
import { AlertsService } from '../ops/alerts.service';

/** Launch checklist: automatic items are computed from live data; manual items need a person's sign-off. */
export const LAUNCH_ITEMS: { key: string; label: string; auto: boolean; required: boolean }[] = [
  { key: 'AGREEMENT', label: 'Merchant Agreement accepted', auto: true, required: true },
  { key: 'ORDER_FORM', label: 'Order Form signed', auto: true, required: true },
  { key: 'DOCUMENTS', label: 'Required documents approved', auto: true, required: true },
  { key: 'PAYOUTS', label: 'Payout account connected', auto: true, required: true },
  { key: 'VERIFIED', label: 'Operator verified', auto: true, required: true },
  { key: 'MENU', label: 'Menu imported (at least one item)', auto: true, required: true },
  { key: 'HOURS', label: 'Opening hours set', auto: true, required: true },
  { key: 'PICKUP_INFO', label: 'Pickup instructions for customers and couriers', auto: true, required: false },
  { key: 'TEAM', label: 'Staff invited', auto: true, required: false },
  { key: 'TEST_ORDER', label: 'Test order completed end to end', auto: true, required: true },
  { key: 'TRAINING', label: 'Staff trained on tablet, kitchen screens and handoff', auto: false, required: true },
  { key: 'EQUIPMENT', label: 'Tablet, printer and kitchen screens installed and online', auto: false, required: true },
  { key: 'PHOTOS', label: 'Menu photos and brand assets approved', auto: false, required: false },
  { key: 'SIGNAGE', label: 'Pickup shelf and courier signage in place', auto: false, required: false },
];

type Loc = typeof locations.$inferSelect;

/** 3 — location details, closures, channels, stations, launch checklist & readiness, emergency pause & controlled restart. */
@Injectable()
export class LocationsAdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly redis: RedisService, private readonly onboarding: OnboardingService, private readonly alerts: AlertsService) {}

  private async loc(id: string): Promise<Loc> {
    const [l] = await this.db.select().from(locations).where(eq(locations.id, id)).limit(1);
    if (!l) throw new NotFoundException('Location not found');
    return l;
  }

  private async bust(l: Loc) {
    await this.redis.del(`loc:${l.slug}`, `loc:${l.id}`);
  }

  async list(user: JwtPayload, q: { regionId?: string; status?: string; q?: string }) {
    assertCan(user, 'merchants.read', 'ops.read');
    const rows = await this.db.select().from(locations).orderBy(asc(locations.name)).limit(2000);
    const regs = await this.db.select().from(regions);
    const items = await this.db.select({ locationId: locationLaunchItems.locationId, n: sql<number>`count(*) filter (where ${locationLaunchItems.doneAt} is not null)::int` }).from(locationLaunchItems).groupBy(locationLaunchItems.locationId);
    return rows
      .filter((l) => staffCovers(user, l.organizationId, l.id) && (!q.regionId || l.regionId === q.regionId) && (!q.status || l.status === q.status) && (!q.q || l.name.toLowerCase().includes(q.q.toLowerCase()) || l.city.toLowerCase().includes(q.q.toLowerCase())))
      .map((l) => ({ id: l.id, name: l.name, city: l.city, organizationId: l.organizationId, status: l.status, isPaused: l.isPaused, pausedReason: l.pausedReason, pausedUntil: l.pausedUntil, platformOperated: l.platformOperated, regionId: l.regionId, regionName: regs.find((r) => r.id === l.regionId)?.name || null, readinessApprovedAt: l.readinessApprovedAt, rampUntil: l.rampUntil, manualSignoffs: items.find((i) => i.locationId === l.id)?.n || 0, acceptsKiosk: l.acceptsKiosk, acceptsDelivery: l.acceptsDelivery, acceptsPickup: l.acceptsPickup, acceptsDineIn: l.acceptsDineIn }));
  }

  /** Everything an operator needs about one location: details, contacts, hours, closures, channels, brands & menus, stations, checklist. */
  async detail(user: JwtPayload, id: string) {
    const l = await this.loc(id);
    assertOrgAccess(user, l.organizationId, l.id);
    const [hours, closures, menuRows, sts, kb, region] = await Promise.all([
      this.db.select().from(openingHours).where(eq(openingHours.locationId, id)).orderBy(openingHours.dayOfWeek),
      this.db.select().from(locationClosures).where(and(eq(locationClosures.locationId, id), gt(locationClosures.endsAt, new Date(Date.now() - 7 * 86400_000)))).orderBy(locationClosures.startsAt),
      this.db.select({ m: menus, items: sql<number>`(select count(*) from menu_items mi join menu_categories c on c.id = mi.category_id where c.menu_id = "menus"."id")::int`, soldOut: sql<number>`(select count(*) from menu_items mi join menu_categories c on c.id = mi.category_id where c.menu_id = "menus"."id" and mi.sold_out)::int` }).from(menus).where(eq(menus.locationId, id)),
      l.kitchenId ? this.db.select().from(stations).where(eq(stations.kitchenId, l.kitchenId)).orderBy(stations.code) : Promise.resolve([]),
      l.kitchenId ? this.db.select({ brandId: kitchenBrands.brandId, isActive: kitchenBrands.isActive }).from(kitchenBrands).where(eq(kitchenBrands.kitchenId, l.kitchenId)) : Promise.resolve([]),
      l.regionId ? this.db.select().from(regions).where(eq(regions.id, l.regionId)).limit(1) : Promise.resolve([]),
    ]);
    const brandIds = [...new Set([...menuRows.map((x) => x.m.brandId).filter(Boolean), ...kb.map((k) => k.brandId)])] as string[];
    const brandRows = brandIds.length ? await this.db.select().from(brands).where(inArray(brands.id, brandIds)) : [];
    const kitchen = l.kitchenId ? (await this.db.select().from(kitchens).where(eq(kitchens.id, l.kitchenId)).limit(1))[0] : null;
    return {
      location: l,
      region: region[0] || null,
      hours,
      closures,
      kitchen,
      stations: sts,
      menus: menuRows.map((x) => ({ id: x.m.id, name: x.m.name, brandId: x.m.brandId, brandName: brandRows.find((b) => b.id === x.m.brandId)?.name || null, isActive: x.m.isActive, channels: x.m.channels, daysOfWeek: x.m.daysOfWeek, availableFrom: x.m.availableFrom, availableUntil: x.m.availableUntil, items: x.items, soldOut: x.soldOut })),
      brands: brandRows.map((b) => ({ id: b.id, name: b.name, ownershipType: b.ownershipType, rightsStatus: b.rightsStatus, authorizedHere: !l.kitchenId || kb.some((k) => k.brandId === b.id && k.isActive), blockedReason: brandBlockReason(b, l.regionId) })),
      checklist: await this.checklist(l),
    };
  }

  // ───── 3.2 closures ─────

  async closures(user: JwtPayload, locationId: string) {
    const l = await this.loc(locationId);
    assertOrgAccess(user, l.organizationId, l.id);
    return this.db.select().from(locationClosures).where(and(eq(locationClosures.locationId, locationId), gt(locationClosures.endsAt, new Date()))).orderBy(locationClosures.startsAt);
  }

  async addClosure(user: JwtPayload, locationId: string, input: { kind: 'CLOSED' | 'SPECIAL_HOURS'; startsAt: string; endsAt: string; opens?: string; closes?: string; service?: 'ALL' | 'ORDERING' | 'RESERVATIONS'; reason?: string }) {
    const l = await this.loc(locationId);
    assertOrgAccess(user, l.organizationId, l.id, MANAGER_ROLES);
    const s = new Date(input.startsAt), e = new Date(input.endsAt);
    if (!(e > s)) throw new BadRequestException('The closure must end after it starts');
    if (input.kind === 'SPECIAL_HOURS' && !(input.opens && input.closes)) throw new BadRequestException('Special hours need opening and closing times');
    const [row] = await this.db.insert(locationClosures).values({ locationId, kind: input.kind, startsAt: s, endsAt: e, opens: input.opens ?? null, closes: input.closes ?? null, service: input.service || 'ALL', reason: input.reason ?? null, createdById: user.sub }).returning();
    await this.bust(l);
    await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: 'location.closure_add', entityType: 'location', entityId: locationId, after: row, reason: input.reason });
    return row;
  }

  async removeClosure(user: JwtPayload, closureId: string) {
    const [c] = await this.db.select().from(locationClosures).where(eq(locationClosures.id, closureId)).limit(1);
    if (!c) throw new NotFoundException();
    const l = await this.loc(c.locationId);
    assertOrgAccess(user, l.organizationId, l.id, MANAGER_ROLES);
    await this.db.delete(locationClosures).where(eq(locationClosures.id, closureId));
    await this.bust(l);
    await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: 'location.closure_remove', entityType: 'location', entityId: l.id, before: c });
    return { ok: true };
  }

  /** Public: upcoming closures and special hours shown on the restaurant page. */
  async publicClosures(locationId: string) {
    return this.db.select({ kind: locationClosures.kind, startsAt: locationClosures.startsAt, endsAt: locationClosures.endsAt, opens: locationClosures.opens, closes: locationClosures.closes, service: locationClosures.service, reason: locationClosures.reason }).from(locationClosures).where(and(eq(locationClosures.locationId, locationId), gt(locationClosures.endsAt, new Date()), lt(locationClosures.startsAt, new Date(Date.now() + 45 * 86400_000)))).orderBy(locationClosures.startsAt);
  }

  // ───── 3.5 stations ─────

  async upsertStation(user: JwtPayload, kitchenId: string, input: { id?: string; code: string; name: string; maxConcurrent?: number | null; isAvailable?: boolean; equipment?: string[]; targetMinutes?: number; requiredSkill?: string | null }) {
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, kitchenId)).limit(1);
    if (!k) throw new NotFoundException('Kitchen not found');
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const v = { kitchenId, code: input.code.toUpperCase(), name: input.name, maxConcurrent: input.maxConcurrent ?? null, isAvailable: input.isAvailable ?? true, equipment: input.equipment || [], ...(input.targetMinutes ? { targetMinutes: input.targetMinutes } : {}), ...(input.requiredSkill !== undefined ? { requiredSkill: input.requiredSkill ? input.requiredSkill.toUpperCase() : null } : {}) };
    const [row] = input.id ? await this.db.update(stations).set(v).where(and(eq(stations.id, input.id), eq(stations.kitchenId, kitchenId))).returning() : await this.db.insert(stations).values(v).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'station.upsert', entityType: 'station', entityId: row.id, after: row });
    return row;
  }

  // ───── 3.6 launch checklist & readiness ─────

  async checklist(l: Loc) {
    const orgId = l.organizationId;
    const [acc] = await this.db.select({ id: merchantAgreementAcceptances.id }).from(merchantAgreementAcceptances).where(eq(merchantAgreementAcceptances.organizationId, orgId)).limit(1);
    const [contract] = await this.db.select({ signedAt: merchantContracts.signedAt }).from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version)).limit(1);
    const blockers = await this.onboarding.blockers(orgId);
    const [seller] = l.legalSellerId ? await this.db.select({ state: legalSellers.payoutOnboardingState }).from(legalSellers).where(eq(legalSellers.id, l.legalSellerId)).limit(1) : await this.db.select({ state: legalSellers.payoutOnboardingState }).from(legalSellers).where(eq(legalSellers.organizationId, orgId)).limit(1);
    const [menuCount] = await this.db.select({ n: sql<number>`count(*)::int` }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(eq(menus.locationId, l.id));
    const [hoursCount] = await this.db.select({ n: sql<number>`count(*)::int` }).from(openingHours).where(eq(openingHours.locationId, l.id));
    const [team] = await this.db.select({ n: sql<number>`count(*)::int` }).from(orgMemberships).where(eq(orgMemberships.organizationId, orgId));
    const [test] = await this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.locationId, l.id), inArray(orders.status, ['COMPLETED', 'COLLECTED'])));
    const manual = await this.db.select().from(locationLaunchItems).where(eq(locationLaunchItems.locationId, l.id));
    const autoDone: Record<string, boolean> = {
      AGREEMENT: !!acc,
      ORDER_FORM: !!contract?.signedAt,
      DOCUMENTS: !blockers.some((b) => !b.startsWith('Merchant Agreement') && !b.includes('Order Form')),
      PAYOUTS: seller?.state === 'COMPLETE',
      VERIFIED: !!l.verifiedAt,
      MENU: menuCount.n > 0,
      HOURS: hoursCount.n > 0,
      PICKUP_INFO: !!(l.pickupInstructions || l.courierInstructions),
      TEAM: team.n > 1,
      TEST_ORDER: test.n > 0,
    };
    const items = LAUNCH_ITEMS.map((i) => {
      const m = manual.find((x) => x.key === i.key);
      const done = (i.auto && autoDone[i.key]) || !!m?.doneAt;
      return { ...i, done, doneAt: m?.doneAt || null, doneById: m?.doneById || null, note: m?.note || null, signedOff: !!m?.doneAt };
    });
    const required = items.filter((i) => i.required);
    return { items, done: items.filter((i) => i.done).length, total: items.length, requiredOpen: required.filter((i) => !i.done).map((i) => i.label), progressPct: Math.round((items.filter((i) => i.done).length / items.length) * 100), readinessApprovedAt: l.readinessApprovedAt, readinessApprovedById: l.readinessApprovedById, blockers };
  }

  /** Manual sign-off (or a manual override of an automatic item, e.g. a test order run off-platform). */
  async signOff(user: JwtPayload, locationId: string, key: string, done: boolean, note?: string) {
    const l = await this.loc(locationId);
    if (!LAUNCH_ITEMS.some((i) => i.key === key)) throw new BadRequestException('Unknown checklist item');
    if (key === 'TRAINING') assertOrgAccess(user, l.organizationId, l.id, MANAGER_ROLES);
    else if (!can(user, 'merchants.manage') && !can(user, 'ops.manage')) throw new ForbiddenException('Gutad operations signs off this item');
    const [existing] = await this.db.select().from(locationLaunchItems).where(and(eq(locationLaunchItems.locationId, locationId), eq(locationLaunchItems.key, key))).limit(1);
    const v = { doneAt: done ? new Date() : null, doneById: done ? user.sub : null, note: note ?? null };
    if (existing) await this.db.update(locationLaunchItems).set(v).where(eq(locationLaunchItems.id, existing.id));
    else await this.db.insert(locationLaunchItems).values({ locationId, key, ...v });
    await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: done ? 'launch.signoff' : 'launch.reopen', entityType: 'location', entityId: locationId, after: { key, note } });
    return this.checklist(await this.loc(locationId));
  }

  async approveReadiness(user: JwtPayload, locationId: string, approve: boolean, note: string) {
    assertCan(user, 'merchants.manage', 'ops.manage');
    const l = await this.loc(locationId);
    if (!staffCovers(user, l.organizationId, l.id)) throw new ForbiddenException('Outside your access scope');
    if (approve) {
      const c = await this.checklist(l);
      if (c.requiredOpen.length) throw new BadRequestException({ message: `Still open: ${c.requiredOpen.join('; ')}`, code: 'CHECKLIST_OPEN' });
    }
    const [row] = await this.db.update(locations).set({ readinessApprovedAt: approve ? new Date() : null, readinessApprovedById: approve ? user.sub : null }).where(eq(locations.id, locationId)).returning();
    await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: approve ? 'launch.readiness_approve' : 'launch.readiness_revoke', entityType: 'location', entityId: locationId, reason: note });
    return row;
  }

  // ───── 3.8 emergency pause & controlled restart ─────

  async emergencyPause(user: JwtPayload, input: { locationIds?: string[]; regionId?: string; reason: string; minutes?: number }) {
    assertCan(user, 'ops.manage');
    if (!input.reason || input.reason.trim().length < 5) throw new BadRequestException({ message: 'A reason is required', code: 'REASON_REQUIRED' });
    const conds = [];
    if (input.locationIds?.length) conds.push(inArray(locations.id, input.locationIds));
    if (input.regionId) conds.push(eq(locations.regionId, input.regionId));
    if (!conds.length) throw new BadRequestException('Choose locations or a region');
    const targets = (await this.db.select().from(locations).where(and(...conds))).filter((l) => staffCovers(user, l.organizationId, l.id));
    const until = input.minutes ? new Date(Date.now() + input.minutes * 60_000) : null;
    for (const l of targets) {
      await this.db.update(locations).set({ isPaused: true, pausedReason: `Emergency: ${input.reason}`, pausedUntil: until, rampUntil: null, rampThrottlePer15m: null }).where(eq(locations.id, l.id));
      await this.bust(l);
      await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: 'location.emergency_pause', entityType: 'location', entityId: l.id, after: { until }, reason: input.reason });
    }
    if (targets.length) await this.alerts.create(user, { title: `Emergency pause: ${targets.length} location(s)`, detail: `${input.reason} — ${targets.map((t) => t.name).join(', ')}`, severity: 'CRITICAL', subjectType: input.regionId ? 'region' : 'location', subjectId: input.regionId || targets[0].id, ownerRole: 'OPERATIONS' });
    return { paused: targets.length, locations: targets.map((t) => ({ id: t.id, name: t.name })) };
  }

  /** Reopen gradually: resume selling with a temporary lower throttle that lifts itself after `rampMinutes`. */
  async restart(user: JwtPayload, locationId: string, input: { rampThrottlePer15m?: number; rampMinutes?: number; reason: string }) {
    const l = await this.loc(locationId);
    assertOrgAccess(user, l.organizationId, l.id, isPlatformStaff(user) ? undefined : MANAGER_ROLES);
    if (l.pausedReason?.startsWith('Emergency:') && !isPlatformStaff(user)) throw new ForbiddenException('Gutad operations restarts locations after an emergency pause');
    const throttle = input.rampThrottlePer15m ?? Math.max(2, Math.round((l.orderThrottlePer15m || 12) / 3));
    const minutes = input.rampMinutes ?? 60;
    const [row] = await this.db.update(locations).set({ isPaused: false, pausedReason: null, pausedUntil: null, rampThrottlePer15m: throttle, rampUntil: new Date(Date.now() + minutes * 60_000) }).where(eq(locations.id, locationId)).returning();
    await this.bust(l);
    await this.audit.log({ organizationId: l.organizationId, actorId: user.sub, action: 'location.restart', entityType: 'location', entityId: locationId, before: { pausedReason: l.pausedReason }, after: { rampThrottlePer15m: throttle, rampMinutes: minutes }, reason: input.reason });
    return row;
  }

  /** Worker: clear finished ramps so the regular throttle applies again. */
  async clearRamps() {
    const r = await this.db.update(locations).set({ rampThrottlePer15m: null, rampUntil: null }).where(and(isNotNull(locations.rampUntil), lt(locations.rampUntil, new Date()))).returning({ id: locations.id });
    return { cleared: r.length };
  }
}
