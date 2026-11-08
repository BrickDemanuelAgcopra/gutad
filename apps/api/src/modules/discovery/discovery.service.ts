import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { deliveryZones, experiences, locations, openingHours, publications, shifts, sponsoredPlacements } from '../../db/schema';
import { RedisService } from '../../core/redis.service';
import { haversineKm, isWithin, localParts, pointInPolygon } from '../../common/utils';

export interface SearchParams {
  q?: string;
  city?: string;
  cuisine?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  service?: 'pickup' | 'delivery' | 'reservations' | 'events' | 'catering';
  openNow?: boolean;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class DiscoveryService {
  constructor(@Inject(DB) private readonly db: Db, private readonly redis: RedisService) {}

  async search(p: SearchParams) {
    const page = Math.max(1, p.page || 1);
    const pageSize = Math.min(50, p.pageSize || 20);
    const conds = [inArray(locations.status, ['LIVE', 'VERIFIED'])];
    if (p.city) conds.push(sql`lower(${locations.city}) = ${p.city.toLowerCase()}`);
    if (p.cuisine) conds.push(sql`${p.cuisine.toLowerCase()} = any(${locations.cuisine})`);
    if (p.q) conds.push(or(sql`${locations.name} ilike ${'%' + p.q + '%'}`, sql`array_to_string(${locations.cuisine}, ' ') ilike ${'%' + p.q + '%'}`)!);
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
    const rows = await this.db.select().from(locations).where(and(...conds)).limit(500);
    const ids = rows.map((r) => r.id);
    const hours = ids.length ? await this.db.select().from(openingHours).where(inArray(openingHours.locationId, ids)) : [];
    const now = new Date();
    const sponsored = await this.activeSponsored(p.city, p.q);

    let items = rows.map((loc) => {
      const lp = localParts(now, loc.timezone);
      const todays = hours.filter((h) => h.locationId === loc.id && h.dayOfWeek === lp.dayOfWeek);
      const isOpenNow = !loc.isPaused && todays.some((h) => isWithin(lp.hhmm, h.opens, h.closes));
      const distanceKm = p.lat !== undefined && p.lng !== undefined && loc.lat !== null && loc.lng !== null ? haversineKm(p.lat, p.lng, loc.lat, loc.lng) : null;
      const sp = sponsored.find((s) => s.locationId === loc.id);
      return { ...this.summary(loc), isOpenNow, distanceKm, sponsored: !!sp, _bid: sp?.bidCents || 0, _spId: sp?.id };
    });
    if (p.radiusKm && p.lat !== undefined) items = items.filter((i) => i.distanceKm === null || i.distanceKm <= p.radiusKm!);
    if (p.openNow) items = items.filter((i) => i.isOpenNow);
    // ranking: sponsored first (by bid), then open, then rating, then distance
    items.sort((a, b) => b._bid - a._bid || Number(b.isOpenNow) - Number(a.isOpenNow) || (b.rating || 0) - (a.rating || 0) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const total = items.length;
    const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
    // count impressions for sponsored placements shown (best-effort)
    const shownSp = pageItems.filter((i) => i._spId).map((i) => i._spId!);
    if (shownSp.length) void this.db.update(sponsoredPlacements).set({ impressions: sql`${sponsoredPlacements.impressions} + 1` }).where(inArray(sponsoredPlacements.id, shownSp));
    return { items: pageItems.map(({ _bid, _spId, ...rest }) => rest), total, page, pageSize };
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
    const cached = await this.redis.getJson<unknown>(`loc:${slugOrId}`);
    if (cached) return cached;
    const [loc] = await this.db.select().from(locations).where(or(eq(locations.slug, slugOrId), sql`${locations.id}::text = ${slugOrId}`)).limit(1);
    if (!loc || ['PROSPECT', 'OFFBOARDED', 'SUSPENDED'].includes(loc.status)) throw new NotFoundException('Restaurant not found');
    const hours = await this.db.select().from(openingHours).where(eq(openingHours.locationId, loc.id));
    const shiftRows = await this.db.select().from(shifts).where(and(eq(shifts.locationId, loc.id), eq(shifts.isActive, true)));
    const exps = await this.db.select().from(experiences).where(and(eq(experiences.locationId, loc.id), eq(experiences.isActive, true)));
    const pubs = await this.db.select().from(publications).where(and(eq(publications.locationId, loc.id), eq(publications.isActive, true)));
    const lp = localParts(new Date(), loc.timezone);
    const todays = hours.filter((h) => h.dayOfWeek === lp.dayOfWeek);
    const isOpenNow = !loc.isPaused && todays.some((h) => isWithin(lp.hhmm, h.opens, h.closes));
    const result = {
      ...this.summary(loc),
      isOpenNow,
      hours,
      pickupTimes: this.eligibleTimes(loc, hours, 'ORDERING'),
      deliveryTimes: loc.acceptsDelivery ? this.eligibleTimes(loc, hours, 'ORDERING') : [],
      diningShifts: shiftRows.map((s) => ({ id: s.id, name: s.name, daysOfWeek: s.daysOfWeek, startTime: s.startTime, endTime: s.endTime, maxPartySize: s.maxPartySize })),
      experiences: exps.map((e) => ({ id: e.id, name: e.name, description: e.description, pricingMode: e.pricingMode, priceCents: e.priceCents, imageUrl: e.imageUrl })),
      partnerLinks: pubs.filter((p) => p.kind === 'PARTNER_LINK').map((p) => ({ id: p.id, partnerName: p.partnerName })),
    };
    await this.redis.setJson(`loc:${slugOrId}`, result, 30);
    return result;
  }

  /** Next 7 days of 15-minute ordering windows inside opening hours (used by "schedule for later"). */
  private eligibleTimes(loc: typeof locations.$inferSelect, hours: (typeof openingHours.$inferSelect)[], service: string) {
    const out: { date: string; slots: string[] }[] = [];
    const now = new Date();
    for (let d = 0; d < 7; d++) {
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
      feeCents: loc.deliveryBaseFeeCents + Math.round(km * loc.deliveryPerKmCents),
      minOrderCents: loc.minOrderCents,
      etaMinutes: loc.defaultPrepMinutes + Math.round(km * 4) + 10,
      distanceKm: km,
    };
  }
}
