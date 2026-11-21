import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { DEFAULT_COURIER_FORECAST, type CourierForecastConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { courierCampaigns, courierForecasts, courierShifts, deliveryJobs, deliveryZones } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { SettingsService } from '../../core/settings.service';

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;
const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

/**
 * Courier R3 demand forecast: expected jobs per zone and hour from the same weekday/hour over the last weeks
 * (recent weeks weigh more), scaled by the recent trend. Supply is booked shifts plus the on-demand couriers who
 * usually work that hour. A gap of `gapAlertCouriers` or more shows to couriers as a busy time.
 */
@Injectable()
export class CourierForecastService {
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService) {}

  cfg() { return this.settings.getObject<CourierForecastConfig>('delivery.forecast', DEFAULT_COURIER_FORECAST); }

  async rebuild(now = new Date()) {
    const cfg = await this.cfg();
    const weeks = Math.max(1, Math.min(26, cfg.lookbackWeeks));
    const since = new Date(now.getTime() - weeks * WEEK);
    const zones = await this.db.select({ id: deliveryZones.id }).from(deliveryZones).where(and(eq(deliveryZones.isActive, true), eq(deliveryZones.kind, 'SERVICE')));
    // history: jobs and distinct own-fleet couriers per zone and hour
    const hist = await this.db.select({
      zoneId: deliveryJobs.zoneId,
      h: sql<string>`date_trunc('hour', ${deliveryJobs.createdAt})`,
      jobs: sql<number>`count(*)::int`,
      couriers: sql<number>`count(distinct ${deliveryJobs.driverId})::int`,
    }).from(deliveryJobs).where(and(isNotNull(deliveryJobs.zoneId), gte(deliveryJobs.createdAt, since), lt(deliveryJobs.createdAt, now))).groupBy(deliveryJobs.zoneId, sql`date_trunc('hour', ${deliveryJobs.createdAt})`);
    const byZone = new Map<string, Map<number, { jobs: number; couriers: number }>>();
    for (const r of hist) {
      const m = byZone.get(r.zoneId!) ?? new Map();
      m.set(new Date(r.h).getTime(), { jobs: r.jobs, couriers: r.couriers });
      byZone.set(r.zoneId!, m);
    }
    const start = hourOf(now.getTime()) + HOUR;
    const end = start + cfg.horizonDays * 24 * HOUR;
    const shifts = await this.db.select({ zoneId: courierShifts.zoneId, startsAt: courierShifts.startsAt, endsAt: courierShifts.endsAt }).from(courierShifts).where(and(inArray(courierShifts.status, ['SCHEDULED', 'CHECKED_IN']), lt(courierShifts.startsAt, new Date(end)), gte(courierShifts.endsAt, new Date(start))));
    const generatedAt = new Date();
    const cells: (typeof courierForecasts.$inferInsert)[] = [];
    const weightSum = (weeks * (weeks + 1)) / 2;
    for (const z of zones) {
      const m = byZone.get(z.id) ?? new Map<number, { jobs: number; couriers: number }>();
      // trend: last 14 days per day vs the whole lookback per day (bounded)
      let recent = 0, all = 0;
      for (const [t, v] of m) { all += v.jobs; if (t >= now.getTime() - 14 * 24 * HOUR) recent += v.jobs; }
      const trend = all > 0 && weeks * 7 > 14 ? Math.min(2, Math.max(0.5, (recent / 14) / (all / (weeks * 7)))) : 1;
      for (let h = start; h < end; h += HOUR) {
        let jobs = 0, couriers = 0;
        for (let w = 1; w <= weeks; w++) {
          const v = m.get(h - w * WEEK);
          const weight = weeks - w + 1;
          if (v) { jobs += v.jobs * weight; couriers += v.couriers * weight; }
        }
        const expected = Math.round(((jobs / weightSum) * trend) * 100) / 100;
        const onDemand = couriers / weightSum;
        const booked = shifts.filter((s) => (s.zoneId === z.id || !s.zoneId) && s.startsAt.getTime() < h + HOUR && s.endsAt.getTime() > h).length;
        const needed = expected > 0 ? Math.ceil(expected / cfg.jobsPerCourierHour) : 0;
        cells.push({ zoneId: z.id, hourStart: new Date(h), expectedJobs: expected, supplyCouriers: Math.round((booked + onDemand) * 100) / 100, neededCouriers: needed, generatedAt });
      }
    }
    for (let i = 0; i < cells.length; i += 500) {
      await this.db.insert(courierForecasts).values(cells.slice(i, i + 500)).onConflictDoUpdate({ target: [courierForecasts.zoneId, courierForecasts.hourStart], set: { expectedJobs: sql`excluded.expected_jobs`, supplyCouriers: sql`excluded.supply_couriers`, neededCouriers: sql`excluded.needed_couriers`, generatedAt: sql`excluded.generated_at` } });
    }
    const actuals = await this.fillActuals(now);
    return { cells: cells.length, zones: zones.length, actualsFilled: actuals, generatedAt };
  }

  /** Record what really happened for past forecast hours (accuracy). */
  async fillActuals(now = new Date()) {
    const r = await this.db.execute(sql`
      update courier_forecasts f set actual_jobs = coalesce((
        select count(*)::int from delivery_jobs j where j.zone_id = f.zone_id and j.created_at >= f.hour_start and j.created_at < f.hour_start + interval '1 hour'
      ), 0)
      where f.actual_jobs is null and f.hour_start + interval '1 hour' <= ${now}`);
    return (r as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  /** Mean absolute percentage error over the last days (hours with demand only). */
  async accuracy(days = 7, zoneId?: string) {
    const since = new Date(Date.now() - days * 24 * HOUR);
    const rows = await this.db.select({ e: courierForecasts.expectedJobs, a: courierForecasts.actualJobs }).from(courierForecasts).where(and(gte(courierForecasts.hourStart, since), isNotNull(courierForecasts.actualJobs), ...(zoneId ? [eq(courierForecasts.zoneId, zoneId)] : [])));
    const used = rows.filter((r) => (r.a ?? 0) > 0 || r.e > 0);
    const mape = used.length ? used.reduce((t, r) => t + Math.abs((r.a ?? 0) - r.e) / Math.max(r.a ?? 0, 1), 0) / used.length : null;
    return { mape: mape === null ? null : Math.round(mape * 1000) / 10, hours: used.length, days };
  }

  async adminForecast(user: JwtPayload, q: { zoneId?: string; from?: string; to?: string }) {
    assertCan(user, 'delivery.read', 'ops.read');
    const from = q.from ? new Date(q.from) : new Date(hourOf(Date.now()));
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 7 * 24 * HOUR);
    const rows = await this.db.select({ f: courierForecasts, zoneName: deliveryZones.name }).from(courierForecasts).innerJoin(deliveryZones, eq(deliveryZones.id, courierForecasts.zoneId)).where(and(gte(courierForecasts.hourStart, from), lt(courierForecasts.hourStart, to), ...(q.zoneId ? [eq(courierForecasts.zoneId, q.zoneId)] : []))).orderBy(courierForecasts.hourStart);
    const cfg = await this.cfg();
    const generatedAt = rows.reduce<Date | null>((m, r) => (!m || r.f.generatedAt > m ? r.f.generatedAt : m), null);
    return {
      cells: rows.map(({ f, zoneName }) => ({ zoneId: f.zoneId, zoneName, hourStart: f.hourStart, expectedJobs: f.expectedJobs, supplyCouriers: f.supplyCouriers, neededCouriers: f.neededCouriers, gap: Math.round((f.neededCouriers - f.supplyCouriers) * 10) / 10, actualJobs: f.actualJobs })),
      accuracy: await this.accuracy(7, q.zoneId),
      config: cfg,
      generatedAt,
    };
  }

  /** Busy hours ahead in the courier's zones (all zones when the courier has none), with a running boost if any. */
  async busyTimes(zoneIds: string[], days = 3) {
    const cfg = await this.cfg();
    const now = new Date();
    const to = new Date(now.getTime() + Math.min(7, Math.max(1, days)) * 24 * HOUR);
    const rows = await this.db.select({ f: courierForecasts, zoneName: deliveryZones.name }).from(courierForecasts).innerJoin(deliveryZones, eq(deliveryZones.id, courierForecasts.zoneId)).where(and(gte(courierForecasts.hourStart, new Date(hourOf(now.getTime()))), lt(courierForecasts.hourStart, to), sql`${courierForecasts.neededCouriers} - ${courierForecasts.supplyCouriers} >= ${cfg.gapAlertCouriers}`, ...(zoneIds.length ? [inArray(courierForecasts.zoneId, zoneIds)] : []))).orderBy(courierForecasts.hourStart).limit(200);
    const boosts = await this.db.select().from(courierCampaigns).where(and(eq(courierCampaigns.kind, 'BOOST'), inArray(courierCampaigns.status, ['SCHEDULED', 'ACTIVE']), gte(courierCampaigns.windowEnd, now), lte(courierCampaigns.windowStart, to)));
    return rows.map(({ f, zoneName }) => {
      const c = boosts.find((b) => (!b.zoneIds.length || b.zoneIds.includes(f.zoneId)) && b.windowStart.getTime() < f.hourStart.getTime() + HOUR && b.windowEnd > f.hourStart);
      return { zoneId: f.zoneId, zoneName, hourStart: f.hourStart, expectedJobs: f.expectedJobs, gapCouriers: Math.round((f.neededCouriers - f.supplyCouriers) * 10) / 10, campaignId: c?.id ?? null, campaignName: c?.name ?? null };
    });
  }

  /** Nightly guard: rebuild when the newest forecast is older than ~20 hours. */
  async rebuildIfStale(now = new Date()) {
    const [r] = await this.db.select({ g: sql<Date | null>`max(${courierForecasts.generatedAt})` }).from(courierForecasts);
    if (r?.g && now.getTime() - new Date(r.g).getTime() < 20 * HOUR) return { skipped: true, actualsFilled: await this.fillActuals(now) };
    return this.rebuild(now);
  }
}
