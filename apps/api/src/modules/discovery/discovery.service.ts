import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FirstPartyService } from '../../core/first-party.service';
import { applyFirstPartyRanking, standardDeliveryFee, withDeliveryDefaults, type DeliveryPricing, type FirstPartyRules } from '@gutad/shared';
import { SettingsService } from '../../core/settings.service';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { brands, deliveryZones, experiences, locations, menus, openingHours, publications, shifts, sponsoredPlacements, locationClosures } from '../../db/schema';
import { RedisService } from '../../core/redis.service';
import { haversineKm, isWithin, localParts, pointInPolygon } from '../../common/utils';
import { can, EntitlementsService, type Entitlements } from '../entitlements/entitlements.service';
import { ChefCalendarService } from '../chefs/chef-calendar.service';

export interface SearchParams {
  q?: string;
  city?: string;
  cuisine?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  service?: 'pickup' | 'delivery' | 'reservations' | 'events' | 'catering';
  openNow?: boolean;
  /** gutad = only food Gutad sells itself; merchants = only restaurants */
  seller?: 'gutad' | 'merchants';
  page?: number;
  pageSize?: number;
}

@Injectable()
export class DiscoveryService {
  constructor(@Inject(DB) private readonly db: Db, private readonly redis: RedisService, private readonly entitlements: EntitlementsService, private readonly chefCalendar: ChefCalendarService, private readonly firstParty: FirstPartyService, private readonly settings: SettingsService) {}

  /** Customers only see services the restaurant's plan includes (and the restaurant has switched on). */
  private masked<T extends { acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean; acceptsEvents: boolean; acceptsCatering: boolean }>(s: T, e: Entitlements | undefined): T {
    if (!e) return s;
    return { ...s, acceptsPickup: s.acceptsPickup && can(e, 'ordering'), acceptsDelivery: s.acceptsDelivery && can(e, 'ordering') && can(e, 'delivery'), acceptsReservations: s.acceptsReservations && can(e, 'reservations'), acceptsEvents: s.acceptsEvents && can(e, 'private_events'), acceptsCatering: s.acceptsCatering && can(e, 'group_orders') };
  }

  /** `opts` is for the admin preview: draft first-party rules and the reason each Gutad result moved. */
  async search(p: SearchParams, opts: { rules?: FirstPartyRules; explain?: boolean } = {}) {
    const page = Math.max(1, p.page || 1);
    const pageSize = Math.min(50, p.pageSize || 20);
    const conds = [inArray(locations.status, ['LIVE', 'VERIFIED'])];
    if (p.city) conds.push(sql`lower(${locations.city}) = ${p.city.toLowerCase()}`);
    if (p.cuisine) conds.push(sql`${p.cuisine.toLowerCase()} = any(${locations.cuisine})`);
    if (p.q) {
      const like = '%' + p.q + '%';
      // a Made at Gutad food hall also matches on the names/descriptions of the brands it prepares
      const brandMatch = sql`exists (select 1 from ${menus} m join ${brands} b on b.id = m.brand_id where m.location_id = ${locations.id} and m.is_active and (b.name ilike ${like} or coalesce(b.description, '') ilike ${like}))`;
      conds.push(or(sql`${locations.name} ilike ${like}`, sql`array_to_string(${locations.cuisine}, ' ') ilike ${like}`, sql`(${locations.platformOperated} and ${brandMatch})`)!);
    }
    if (p.service === 'pickup') conds.push(eq(locations.acceptsPickup, true));
    if (p.service === 'delivery') conds.push(eq(locations.acceptsDelivery, true));
    if (p.service === 'reservations') conds.push(eq(locations.acceptsReservations, true));
    if (p.service === 'events') conds.push(eq(locations.acceptsEvents, true));
    if (p.service === 'catering') conds.push(eq(locations.acceptsCatering, true));
    if (p.lat !== undefined && p.lng !== undefined) {
      const r = p.radiusKm || 15;
      const dLat = r / 111;
      const dLng = r / (111 * Math.cos((p.lat * Math.PI) / 180));
      conds.push(gte(locations.lat, p.lat - dLat), lte(locations.lat, p.lat + dLat), gte(locations.lng, p.lng - dLng), lte(locations.lng, p.lng + dLng));
    }
    const found = await this.db.select().from(locations).where(and(...conds)).limit(500);
    const ents = await this.entitlements.forLocations(found.map((r) => r.id));
    // only plans with a marketplace listing appear in Gutad search
    // Gutad first-party: off in a city (kill switch) = not listed there; the seller filter narrows to one side
    const fpIds = await this.firstParty.firstPartyLocationIds(found.map((r) => r.id));
    const rules = opts.rules || (await this.firstParty.rulesFor(p.city));
    const fpOn = new Map<string, boolean>();
    for (const r of found) if (fpIds.has(r.id)) fpOn.set(r.id, opts.rules ? opts.rules.enabled : (await this.firstParty.rulesFor(r.city)).enabled);
    const rows = found.filter((r) => {
      const e = ents.get(r.id);
      if (e && !can(e, 'marketplace_listing')) return false;
      if (fpIds.has(r.id) && !fpOn.get(r.id)) return false;
      if (p.seller === 'gutad' && !fpIds.has(r.id)) return false;
      if (p.seller === 'merchants' && fpIds.has(r.id)) return false;
      return true;
    });
    const ids = rows.map((r) => r.id);
    const hours = ids.length ? await this.db.select().from(openingHours).where(inArray(openingHours.locationId, ids)) : [];
    const now = new Date();
    const sponsored = await this.activeSponsored(p.city, p.q);

    const closedIds = new Set(ids.length ? (await this.db.select({ id: locationClosures.locationId }).from(locationClosures).where(and(inArray(locationClosures.locationId, ids), sql`${locationClosures.startsAt} <= now()`, sql`${locationClosures.endsAt} > now()`, eq(locationClosures.kind, 'CLOSED')))).map((c) => c.id) : []);
    let items = rows.map((loc) => {
      const lp = localParts(now, loc.timezone);
      const todays = hours.filter((h) => h.locationId === loc.id && h.dayOfWeek === lp.dayOfWeek);
      const isOpenNow = !loc.isPaused && !closedIds.has(loc.id) && todays.some((h) => isWithin(lp.hhmm, h.opens, h.closes));
      const distanceKm = p.lat !== undefined && p.lng !== undefined && loc.lat !== null && loc.lng !== null ? haversineKm(p.lat, p.lng, loc.lat, loc.lng) : null;
      const fp = fpIds.has(loc.id);
      // Gutad's own locations take sponsored placements only when the policy allows it
      const sp = fp && !rules.allowSponsored ? undefined : sponsored.find((s) => s.locationId === loc.id);
      const e = ents.get(loc.id);
      return { ...this.masked(this.summary(loc), e), isOpenNow, distanceKm, sponsored: !!sp, firstParty: fp, sellerLabel: fp ? rules.label : null, _bid: sp?.bidCents || 0, _spId: sp?.id, _boost: e && can(e, 'marketplace_boost') && !e.unrestricted ? 1 : 0 };
    });
    // a requested service must survive plan masking
    if (p.service === 'pickup') items = items.filter((i) => i.acceptsPickup);
    if (p.service === 'delivery') items = items.filter((i) => i.acceptsDelivery);
    if (p.service === 'reservations') items = items.filter((i) => i.acceptsReservations);
    if (p.service === 'events') items = items.filter((i) => i.acceptsEvents);
    if (p.service === 'catering') items = items.filter((i) => i.acceptsCatering);
    if (p.radiusKm && p.lat !== undefined) items = items.filter((i) => i.distanceKm === null || i.distanceKm <= p.radiusKm!);
    if (p.openNow) items = items.filter((i) => i.isOpenNow);
    items = await this.expandFoodHalls(items, p.q);
    // ranking: sponsored first (by bid), then plans with a marketplace boost, then open, then rating, then distance
    items.sort((a, b) => b._bid - a._bid || b._boost - a._boost || Number(b.isOpenNow) - Number(a.isOpenNow) || (b.rating || 0) - (a.rating || 0) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    // then the first-party marketplace policy (neutral by default): boost, pinned slots, first-page cap, exclusion
    const ranked = applyFirstPartyRanking(items, rules, pageSize);
    items = ranked.items;
    const total = items.length;
    const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
    // count impressions for sponsored placements shown (best-effort)
    const shownSp = pageItems.filter((i) => i._spId).map((i) => i._spId!);
    if (shownSp.length) void this.db.update(sponsoredPlacements).set({ impressions: sql`${sponsoredPlacements.impressions} + 1` }).where(inArray(sponsoredPlacements.id, shownSp));
    if (opts.explain) return { items: pageItems.map((it) => { const { _bid, _spId, _boost, ...rest } = it; return { ...rest, why: ranked.why.get(it) || [] }; }), total, page, pageSize, rules };
    return { items: pageItems.map(({ _bid, _spId, _boost, ...rest }) => rest), total, page, pageSize };
  }

  /**
   * Made at Gutad food halls are listed as one result per brand they prepare (each links to the food hall page,
   * where dishes from all of its brands go into one order). Independent restaurants stay one result each.
   */
  private async expandFoodHalls<T extends { id: string; name: string; cuisine: string[]; platformOperated: boolean }>(items: T[], q?: string) {
    const hallIds = items.filter((i) => i.platformOperated).map((i) => i.id);
    if (!hallIds.length) return items.map((i) => ({ ...i, brand: null, foodHallName: null }));
    const rows = await this.db
      .selectDistinct({ locationId: menus.locationId, id: brands.id, slug: brands.slug, name: brands.name, description: brands.description, logoUrl: brands.logoUrl })
      .from(menus)
      .innerJoin(brands, eq(brands.id, menus.brandId))
      .where(and(inArray(menus.locationId, hallIds), eq(menus.isActive, true)));
    const needle = q?.toLowerCase();
    const out: (T & { brand: { id: string; slug: string; name: string; description: string | null; logoUrl: string | null } | null; foodHallName: string | null })[] = [];
    for (const i of items) {
      const hallBrands = rows.filter((r) => r.locationId === i.id).sort((a, b) => a.name.localeCompare(b.name));
      if (!i.platformOperated || !hallBrands.length) {
        out.push({ ...i, brand: null, foodHallName: null });
        continue;
      }
      // a query that names specific brands shows only those; otherwise (no query, or the hall's own
      // name/cuisine matched) every brand in the hall is listed
      const matching = needle ? hallBrands.filter((b) => b.name.toLowerCase().includes(needle) || (b.description || '').toLowerCase().includes(needle)) : [];
      for (const b of matching.length ? matching : hallBrands) {
        out.push({ ...i, name: b.name, description: b.description, brand: { id: b.id, slug: b.slug, name: b.name, description: b.description, logoUrl: b.logoUrl }, foodHallName: i.name });
      }
    }
    return out;
  }

  private async activeSponsored(city?: string, q?: string) {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(sponsoredPlacements)
      .where(and(lte(sponsoredPlacements.startsAt, now), gte(sponsoredPlacements.endsAt, now)));
    return rows.filter((s) => (!s.city || !city || s.city.toLowerCase() === city.toLowerCase()) && (!s.keyword || !q || q.toLowerCase().includes(s.keyword.toLowerCase())));
  }

  async clickSponsored(id: string) {
    const [sp] = await this.db.select().from(sponsoredPlacements).where(eq(sponsoredPlacements.id, id)).limit(1);
    if (!sp) throw new NotFoundException();
    await this.db.update(sponsoredPlacements).set({ clicks: sql`${sponsoredPlacements.clicks} + 1`, spentCents: sql`${sponsoredPlacements.spentCents} + ${sp.bidCents}` }).where(eq(sponsoredPlacements.id, id));
    return { ok: true };
  }

  summary(loc: typeof locations.$inferSelect) {
    return {
      id: loc.id,
      merchantId: loc.organizationId,
      slug: loc.slug,
      name: loc.name,
      description: loc.description,
      cuisine: loc.cuisine,
      addressLine1: loc.addressLine1,
      city: loc.city,
      region: loc.region,
      postalCode: loc.postalCode,
      lat: loc.lat,
      lng: loc.lng,
      heroImageUrl: loc.heroImageUrl,
      photos: loc.photos,
      amenities: loc.amenities,
      rating: loc.rating,
      ratingCount: loc.ratingCount,
      acceptsPickup: loc.acceptsPickup,
      acceptsDelivery: loc.acceptsDelivery,
      acceptsReservations: loc.acceptsReservations,
      acceptsEvents: loc.acceptsEvents,
      acceptsCatering: loc.acceptsCatering,
      platformOperated: loc.platformOperated,
      chefKitchen: loc.chefKitchen,
      isPaused: loc.isPaused,
      pausedReason: loc.pausedReason,
      minOrderCents: loc.minOrderCents,
      defaultPrepMinutes: loc.defaultPrepMinutes,
      timezone: loc.timezone,
      currency: loc.currency,
      phone: loc.phone,
    };
  }

  /** Public location page: hours, services, eligible pickup/delivery times, dining shifts, experiences. */
  async locationPage(slugOrId: string) {
    const cached = await this.redis.getJson<{ firstParty?: boolean; city?: string }>(`loc:${slugOrId}`);
    if (cached) {
      if (cached.firstParty && !(await this.firstParty.rulesFor(cached.city)).enabled) throw new NotFoundException('Restaurant not found');
      return cached;
    }
    const [loc] = await this.db.select().from(locations).where(or(eq(locations.slug, slugOrId), sql`${locations.id}::text = ${slugOrId}`)).limit(1);
    if (!loc || ['PROSPECT', 'OFFBOARDED', 'SUSPENDED'].includes(loc.status)) throw new NotFoundException('Restaurant not found');
    const firstParty = await this.firstParty.isFirstPartyOrg(loc.organizationId);
    const fpRules = firstParty ? await this.firstParty.rulesFor(loc.city) : null;
    if (fpRules && !fpRules.enabled) throw new NotFoundException('Restaurant not found');
    const hours = await this.db.select().from(openingHours).where(eq(openingHours.locationId, loc.id));
    const shiftRows = await this.db.select().from(shifts).where(and(eq(shifts.locationId, loc.id), eq(shifts.isActive, true)));
    const exps = await this.db.select().from(experiences).where(and(eq(experiences.locationId, loc.id), eq(experiences.isActive, true)));
    const pubs = await this.db.select().from(publications).where(and(eq(publications.locationId, loc.id), eq(publications.isActive, true)));
    const lp = localParts(new Date(), loc.timezone);
    const todays = hours.filter((h) => h.dayOfWeek === lp.dayOfWeek);
    const [closedNow] = await this.db.select({ kind: locationClosures.kind }).from(locationClosures).where(and(eq(locationClosures.locationId, loc.id), sql`${locationClosures.startsAt} <= now()`, sql`${locationClosures.endsAt} > now()`, eq(locationClosures.kind, 'CLOSED'))).limit(1);
    const isOpenNow = !loc.isPaused && !closedNow && todays.some((h) => isWithin(lp.hhmm, h.opens, h.closes));
    const e = await this.entitlements.forLocation(loc.id);
    // chef kitchens: open cooking days and times from the chef's calendar (notice, cutoff, pauses, capacity)
    const times = loc.chefKitchen ? await this.chefCalendar.kitchenTimes(loc.id) : await this.withoutFullSlots(loc, this.eligibleTimes(loc, hours, 'ORDERING'));
    const result = {
      ...this.masked(this.summary(loc), e),
      firstParty,
      sellerLabel: fpRules?.label ?? null,
      isOpenNow,
      hours,
      pickupTimes: times,
      deliveryTimes: loc.acceptsDelivery && can(e, 'delivery') ? times : [],
      diningShifts: (can(e, 'reservations') ? shiftRows : []).map((s) => ({ id: s.id, name: s.name, daysOfWeek: s.daysOfWeek, startTime: s.startTime, endTime: s.endTime, maxPartySize: s.maxPartySize })),
      experiences: (can(e, 'experiences') ? exps : []).map((e) => ({ id: e.id, name: e.name, description: e.description, pricingMode: e.pricingMode, priceCents: e.priceCents, imageUrl: e.imageUrl })),
      partnerLinks: pubs.filter((p) => p.kind === 'PARTNER_LINK').map((p) => ({ id: p.id, partnerName: p.partnerName })),
      pickupInstructions: loc.pickupInstructions,
      parkingInfo: loc.parkingInfo,
      acceptsKiosk: loc.acceptsKiosk,
      closures: await this.db.select({ kind: locationClosures.kind, startsAt: locationClosures.startsAt, endsAt: locationClosures.endsAt, opens: locationClosures.opens, closes: locationClosures.closes, service: locationClosures.service, reason: locationClosures.reason }).from(locationClosures).where(and(eq(locationClosures.locationId, loc.id), sql`${locationClosures.endsAt} > now()`, sql`${locationClosures.startsAt} < now() + interval '30 days'`)).orderBy(locationClosures.startsAt),
    };
    await this.redis.setJson(`loc:${slugOrId}`, result, 30);
    return result;
  }

  /** Next 7 days of 15-minute ordering windows inside opening hours (used by "schedule for later"). */
  /** 11.5 — hide 15-minute slots already at the location's scheduled-order capacity. */
  private async withoutFullSlots(loc: typeof locations.$inferSelect, days: { date: string; slots: string[] }[]) {
    if (!loc.scheduledSlotCapacity) return days;
    const r = await this.db.execute(sql`select to_timestamp(floor(extract(epoch from scheduled_for) / 900) * 900) as slot, count(*)::int as n from orders where location_id = ${loc.id} and scheduled_for > now() and scheduled_for < now() + interval '22 days' and status not in ('CANCELED','REJECTED') group by 1 having count(*) >= ${loc.scheduledSlotCapacity}`);
    const full = new Set(((r as unknown as { rows: { slot: string }[] }).rows || []).map((x) => { const lp = localParts(new Date(x.slot), loc.timezone); return `${lp.ymd} ${lp.hhmm}`; }));
    return full.size ? days.map((d) => ({ ...d, slots: d.slots.filter((t) => !full.has(`${d.date} ${t}`)) })) : days;
  }

  private eligibleTimes(loc: typeof locations.$inferSelect, hours: (typeof openingHours.$inferSelect)[], service: string) {
    const out: { date: string; slots: string[] }[] = [];
    const now = new Date();
    // scheduled-order notice (e.g. a chef's minimum lead days): no slot before now + lead
    const lead = loc.scheduleLeadMinutes ? localParts(new Date(now.getTime() + loc.scheduleLeadMinutes * 60_000), loc.timezone) : null;
    const days = loc.chefKitchen ? 21 : 7;
    for (let d = 0; d < days; d++) {
      const day = new Date(now.getTime() + d * 86_400_000);
      const lp = localParts(day, loc.timezone);
      const todays = hours.filter((h) => h.dayOfWeek === lp.dayOfWeek && (h.service === 'ALL' || h.service === service));
      const slots: string[] = [];
      for (const h of todays) {
        let [hh, mm] = h.opens.split(':').map(Number);
        const [ch, cm] = h.closes.split(':').map(Number);
        const closeMin = (ch < hh || (ch === hh && cm <= mm) ? ch + 24 : ch) * 60 + cm;
        for (let t = hh * 60 + mm; t + loc.defaultPrepMinutes <= closeMin; t += 15) {
          const s = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
          if (d === 0 && s < lp.hhmm) continue;
          if (lead && `${lp.ymd} ${s}` < `${lead.ymd} ${lead.hhmm}`) continue;
          slots.push(s);
        }
        hh = 0;
        mm = 0;
      }
      out.push({ date: lp.ymd, slots });
    }
    return out;
  }

  /** Address serviceability: inside a delivery zone polygon, else within radius. */
  async serviceability(locationId: string, lat: number, lng: number) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (!loc.acceptsDelivery) return { deliverable: false, reason: 'Delivery not offered' };
    const zones = await this.db.select().from(deliveryZones).where(and(eq(deliveryZones.locationId, locationId), eq(deliveryZones.isActive, true)));
    for (const z of zones) {
      if (z.polygon && pointInPolygon(lng, lat, z.polygon as { coordinates: number[][][] })) {
        return { deliverable: true, zoneId: z.id, feeCents: z.feeCents, minOrderCents: z.minOrderCents, etaMinutes: z.etaMinutes };
      }
    }
    if (loc.lat === null || loc.lng === null) return { deliverable: false, reason: 'Restaurant has no coordinates' };
    const km = haversineKm(lat, lng, loc.lat, loc.lng);
    if (km > loc.deliveryRadiusKm) return { deliverable: false, reason: `Outside ${loc.deliveryRadiusKm} km delivery radius`, distanceKm: km };
    return {
      deliverable: true,
      zoneId: null,
      ...(await (async () => {
        // same policy as checkout (partner prices are only known at checkout, so the distance fee stands in)
        const dp = withDeliveryDefaults(await this.settings.getObject<Partial<DeliveryPricing>>('fees.delivery', {}));
        const fee = standardDeliveryFee(dp, loc.deliveryFleet, { km, providerCostCents: 0, zoneFeeCents: null, store: { baseCents: loc.deliveryBaseFeeCents, perKmCents: loc.deliveryPerKmCents } });
        const freeFrom = dp.storeFreeDelivery.allowed && loc.freeDeliveryMinCents !== null ? Math.max(loc.freeDeliveryMinCents, dp.storeFreeDelivery.minThresholdCents) : null;
        return { feeCents: dp.platformFreeDelivery || freeFrom === 0 ? 0 : fee, freeDeliveryMinCents: dp.platformFreeDelivery ? 0 : freeFrom };
      })()),
      minOrderCents: loc.minOrderCents,
      etaMinutes: loc.defaultPrepMinutes + Math.round(km * 4) + 10,
      distanceKm: km,
    };
  }
}
