import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { DEFAULT_LOCATION_THROTTLE, locationLoadLevel, type LoadLevel, type LocationThrottle } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { locationLoadSettings, locations, opsAlerts } from '../../db/schema';
import { assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { RedisService } from '../../core/redis.service';

/**
 * 13.7-L auto-throttle for restaurants without a production kitchen. Kitchens step their load level from fired
 * tickets (KitchenService.loadSweep); an independent restaurant has no station queue, so its load is the number of
 * open ASAP orders and the backlog they represent (open orders × prep minutes ÷ orders cooked in parallel).
 * BUSY adds minutes to new quotes; OVERLOADED stops ASAP orders (scheduled orders are still taken).
 */
@Injectable()
export class LocationLoadService {
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  private async defaults() {
    return this.settings.getObject<LocationThrottle>('orders.locationThrottle', DEFAULT_LOCATION_THROTTLE);
  }

  async config(locationId: string, tx: DbOrTx = this.db): Promise<LocationThrottle & { custom: boolean }> {
    const base = await this.defaults();
    const [row] = await tx.select().from(locationLoadSettings).where(eq(locationLoadSettings.locationId, locationId)).limit(1);
    if (!row) return { ...base, custom: false };
    return { enabled: row.enabled, busyAtOpenOrders: row.busyAtOpenOrders, overloadAtOpenOrders: row.overloadAtOpenOrders, busyAtBacklogMinutes: row.busyAtBacklogMinutes, overloadAtBacklogMinutes: row.overloadAtBacklogMinutes, parallelOrders: row.parallelOrders, busyExtraMinutes: row.busyExtraMinutes, custom: true };
  }

  /** Open ASAP orders (and scheduled ones due within 30 minutes) and the backlog in minutes. */
  async measure(loc: { id: string; defaultPrepMinutes: number }, parallel: number, tx: DbOrTx = this.db) {
    const r = (await tx.execute(sql`select count(*)::int as n,
        coalesce(sum(greatest(1, least(${loc.defaultPrepMinutes * 2}, case when status = 'SUBMITTED' or promise_at is null then ${loc.defaultPrepMinutes} else extract(epoch from promise_at - now()) / 60 end))), 0)::float as minutes
      from orders where location_id = ${loc.id} and status in ('SUBMITTED','ACCEPTED','PREPARING')
        and (scheduled_for is null or scheduled_for <= now() + interval '30 minutes')`)) as unknown as { rows: { n: number; minutes: number }[] };
    const openOrders = Number(r.rows[0]?.n ?? 0);
    const backlogMinutes = Math.round(Number(r.rows[0]?.minutes ?? 0) / Math.max(1, parallel));
    return { openOrders, backlogMinutes };
  }

  /** Load for a quote: null when the location has a kitchen (the kitchen throttle applies) or the level is NORMAL. */
  async loadFor(loc: { id: string; kitchenId: string | null; defaultPrepMinutes: number }, tx: DbOrTx = this.db): Promise<{ level: LoadLevel; extraMinutes: number; openOrders: number; backlogMinutes: number } | null> {
    if (loc.kitchenId) return null;
    const cfg = await this.config(loc.id, tx);
    if (!cfg.enabled) return null;
    const m = await this.measure(loc, cfg.parallelOrders, tx);
    const level = locationLoadLevel(cfg, m.openOrders, m.backlogMinutes);
    if (level === 'NORMAL') return null;
    return { level, extraMinutes: cfg.busyExtraMinutes, ...m };
  }

  private async requireLoc(user: JwtPayload, locationId: string, roles?: typeof MANAGER_ROLES) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    assertOrgAccess(user, loc.organizationId, loc.id, roles);
    return loc;
  }

  /** Merchant settings card: thresholds plus the live measurement. */
  async status(user: JwtPayload, locationId: string) {
    const loc = await this.requireLoc(user, locationId);
    const cfg = await this.config(loc.id);
    const m = await this.measure(loc, cfg.parallelOrders);
    const [row] = await this.db.select({ lastLevel: locationLoadSettings.lastLevel, lastChangedAt: locationLoadSettings.lastChangedAt }).from(locationLoadSettings).where(eq(locationLoadSettings.locationId, loc.id)).limit(1);
    return { locationId: loc.id, hasKitchen: !!loc.kitchenId, settings: cfg, ...m, level: loc.kitchenId ? 'NORMAL' : locationLoadLevel(cfg, m.openOrders, m.backlogMinutes), defaultPrepMinutes: loc.defaultPrepMinutes, lastLevel: row?.lastLevel ?? 'NORMAL', lastChangedAt: row?.lastChangedAt ?? null };
  }

  async update(user: JwtPayload, locationId: string, input: Partial<LocationThrottle>) {
    const loc = await this.requireLoc(user, locationId, MANAGER_ROLES);
    const before = await this.config(loc.id);
    const next = { ...before, ...input };
    if (next.overloadAtOpenOrders <= next.busyAtOpenOrders) next.overloadAtOpenOrders = next.busyAtOpenOrders + 1;
    const v = { enabled: next.enabled, busyAtOpenOrders: next.busyAtOpenOrders, overloadAtOpenOrders: next.overloadAtOpenOrders, busyAtBacklogMinutes: next.busyAtBacklogMinutes, overloadAtBacklogMinutes: next.overloadAtBacklogMinutes, parallelOrders: next.parallelOrders, busyExtraMinutes: next.busyExtraMinutes, updatedById: user.sub };
    await this.db.insert(locationLoadSettings).values({ locationId: loc.id, ...v }).onConflictDoUpdate({ target: locationLoadSettings.locationId, set: v });
    await this.audit.log({ organizationId: loc.organizationId, actorId: user.sub, action: 'location.auto_throttle', entityType: 'location', entityId: loc.id, before, after: v });
    return this.status(user, locationId);
  }

  /** Worker sweep: record level changes and raise / resolve an ops alert, like the kitchen sweep. */
  async sweep() {
    const rows = await this.db.select({ s: locationLoadSettings, loc: locations }).from(locationLoadSettings).innerJoin(locations, eq(locations.id, locationLoadSettings.locationId)).where(isNull(locations.kitchenId));
    const changed: { locationId: string; from: string; to: string }[] = [];
    for (const { s, loc } of rows) {
      const cfg = await this.config(loc.id);
      const m = await this.measure(loc, cfg.parallelOrders);
      const level = locationLoadLevel(cfg, m.openOrders, m.backlogMinutes);
      if (level === s.lastLevel) continue;
      await this.db.update(locationLoadSettings).set({ lastLevel: level, lastChangedAt: new Date() }).where(eq(locationLoadSettings.locationId, loc.id));
      changed.push({ locationId: loc.id, from: s.lastLevel, to: level });
      await this.audit.log({ organizationId: loc.organizationId, actorId: null, action: 'location.load', entityType: 'location', entityId: loc.id, before: { level: s.lastLevel }, after: { level, ...m } });
      const key = `location-load:${loc.id}`;
      if (level === 'OVERLOADED') await this.db.insert(opsAlerts).values({ type: 'KITCHEN_OVERLOAD', severity: 'HIGH', title: `${loc.name} is at capacity`, detail: `${m.openOrders} open orders (~${m.backlogMinutes} min backlog). ASAP orders are paused and prep times extended until it recovers.`, subjectType: 'location', subjectId: loc.id, organizationId: loc.organizationId, locationId: loc.id, dedupeKey: key, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + 20 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'Auto-throttle engaged' }] }).onConflictDoNothing();
      if (level === 'NORMAL') await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: 'Restaurant load recovered' }).where(and(eq(opsAlerts.dedupeKey, key), ne(opsAlerts.status, 'RESOLVED')));
    }
    return { locations: rows.length, changed };
  }

  /** Runs only in the worker (the scheduler is not loaded in the API process). */
  @Interval(60_000) async locationLoadJob() {
    const release = await this.redis.lock('job:location-load', 60_000).catch(() => null);
    if (!release) return;
    try { await this.sweep(); } catch (e) { new Logger('LocationLoad').warn((e as Error).message); } finally { await release(); }
  }
}
