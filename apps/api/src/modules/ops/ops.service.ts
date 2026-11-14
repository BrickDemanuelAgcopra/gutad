import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { brands, devices, drivers, incidents, locations, messageTemplates, notifications, orderEvents, orderNotes, orders, organizations, refunds, regions, approvalRequests, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { assertCan, assertOrgAccess, can, JwtPayload, staffCovers } from '../../common/auth';
import { OrdersService } from '../orders/orders.service';
import { SupportService } from '../support/support.service';

export interface OpsFilter { from?: string; to?: string; regionId?: string; organizationId?: string; locationId?: string; brandId?: string; channel?: string }
type Dim = 'region' | 'location' | 'merchant' | 'brand' | 'channel';
const TERMINAL_BAD = sql`('CANCELED','REJECTED')`;
const n = (v: unknown) => Number(v || 0);
const NONE = '00000000-0000-0000-0000-000000000000';
/** Postgres array literal: drizzle would otherwise expand a JS array into a parameter list. */
const pgArr = (a: string[]) => `{${a.map((x) => `"${x.replace(/"/g, '')}"`).join(',')}}`;
const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];

/** Labor rate used for contribution when a kitchen has no labor entries (setting `ops.labor_rate_cents_per_hour`). */
const DEFAULT_LABOR_RATE = 1800;

/**
 * 1 & 12 — executive dashboard, live operations board, capacity, contribution margin, drill-down,
 * platform-wide order search and order detail, notes and customer messages.
 */
@Injectable()
export class OpsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly notify: NotifyService, private readonly settings: SettingsService, private readonly orders: OrdersService, private readonly support: SupportService) {}

  // ───── scope & filters ─────

  /** Locations this person may see, narrowed by the filter. */
  async scopeLocations(user: JwtPayload, f: OpsFilter) {
    const conds: SQL[] = [];
    if (f.locationId) conds.push(eq(locations.id, f.locationId));
    if (f.organizationId) conds.push(eq(locations.organizationId, f.organizationId));
    if (f.regionId) conds.push(eq(locations.regionId, f.regionId));
    const all = await this.db
      .select({ id: locations.id, name: locations.name, city: locations.city, organizationId: locations.organizationId, regionId: locations.regionId, platformOperated: locations.platformOperated, isPaused: locations.isPaused, pausedReason: locations.pausedReason, status: locations.status, throttle: locations.orderThrottlePer15m, prep: locations.defaultPrepMinutes, kitchenId: locations.kitchenId })
      .from(locations)
      .where(conds.length ? and(...conds) : undefined)
      .limit(5000);
    return all.filter((l) => staffCovers(user, l.organizationId, l.id));
  }

  private window(f: OpsFilter) {
    const to = f.to ? new Date(f.to) : new Date();
    const from = f.from ? new Date(f.from) : new Date(to.getTime() - 30 * 86400_000);
    const span = to.getTime() - from.getTime();
    return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from };
  }

  /** SQL predicate on `o` (orders alias) for the scope and filter. */
  private orderWhere(locIds: string[], f: OpsFilter, from: Date, to: Date): SQL {
    const parts: SQL[] = [sql`o.location_id = any(${pgArr(locIds.length ? locIds : [NONE])}::uuid[])`, sql`o.created_at >= ${from.toISOString()}`, sql`o.created_at < ${to.toISOString()}`];
    if (f.channel) parts.push(sql`o.channel = ${f.channel}`);
    if (f.brandId) parts.push(sql`exists (select 1 from order_lines bl where bl.order_id = o.id and bl.brand_id = ${f.brandId})`);
    return sql.join(parts, sql` and `);
  }

  private async metrics(locIds: string[], f: OpsFilter, from: Date, to: Date) {
    const w = this.orderWhere(locIds, f, from, to);
    const [m] = rows<Record<string, unknown>>(await this.db.execute(sql`
      select count(*)::int as orders,
        count(*) filter (where o.status in ('COMPLETED','COLLECTED'))::int as completed,
        count(*) filter (where o.status = 'CANCELED')::int as canceled,
        count(*) filter (where o.status = 'REJECTED')::int as rejected,
        count(*) filter (where o.partial_fulfillment)::int as partial,
        coalesce(sum(o.subtotal_cents) filter (where o.status not in ${TERMINAL_BAD}), 0)::bigint as food_sales,
        coalesce(sum(o.total_cents) filter (where o.status not in ${TERMINAL_BAD}), 0)::bigint as gross,
        coalesce(sum(o.discount_cents) filter (where o.status not in ${TERMINAL_BAD}), 0)::bigint as discounts,
        coalesce(sum(o.tax_cents) filter (where o.status not in ${TERMINAL_BAD}), 0)::bigint as tax,
        coalesce(sum(o.tip_cents) filter (where o.status not in ${TERMINAL_BAD}), 0)::bigint as tips
      from orders o where ${w}`));
    const [r] = rows<Record<string, unknown>>(await this.db.execute(sql`select coalesce(sum(rf.amount_cents),0)::bigint as refunds, count(*)::int as refund_count from refunds rf join orders o on o.id = rf.order_id where ${w} and rf.status <> 'FAILED'`));
    const ledger = rows<{ account: string; net: string }>(await this.db.execute(sql`select je.account, sum(je.credit_cents - je.debit_cents)::bigint as net from journal_entries je join orders o on o.id = je.order_id where ${w} group by je.account`));
    const acct = (pred: (a: string) => boolean) => ledger.filter((x) => pred(x.account)).reduce((a, x) => a + n(x.net), 0);
    const kept = n(m.orders) - n(m.canceled) - n(m.rejected);
    return {
      orders: n(m.orders),
      completed: n(m.completed),
      canceled: n(m.canceled),
      rejected: n(m.rejected),
      partial: n(m.partial),
      cancellationRate: n(m.orders) ? (n(m.canceled) + n(m.rejected)) / n(m.orders) : 0,
      grossSalesCents: n(m.gross),
      foodSalesCents: n(m.food_sales),
      discountsCents: n(m.discounts),
      taxCents: n(m.tax),
      tipsCents: n(m.tips),
      refundsCents: n(r.refunds),
      refundCount: n(r.refund_count),
      aovCents: kept ? Math.round(n(m.gross) / kept) : 0,
      platformRevenueCents: acct((a) => a.startsWith('PLATFORM_REVENUE_')),
      platformExpenseCents: -acct((a) => a.startsWith('PLATFORM_EXPENSE_')),
      merchantPayableCents: acct((a) => a === 'MERCHANT_PAYABLE'),
      revenueByStream: Object.fromEntries(ledger.filter((x) => x.account.startsWith('PLATFORM_REVENUE_')).map((x) => [x.account.replace('PLATFORM_REVENUE_', ''), n(x.net)])),
    };
  }

  // ───── 1.1–1.3 executive dashboard ─────

  async executive(user: JwtPayload, f: OpsFilter) {
    assertCan(user, 'overview.read');
    const locs = await this.scopeLocations(user, f);
    const ids = locs.map((l) => l.id);
    const w = this.window(f);
    const [cur, prev] = await Promise.all([this.metrics(ids, f, w.from, w.to), this.metrics(ids, f, w.prevFrom, w.prevTo)]);
    const trend = rows<{ day: string; orders: number; gross: string }>(await this.db.execute(sql`select to_char(date_trunc('day', o.created_at), 'YYYY-MM-DD') as day, count(*)::int as orders, coalesce(sum(o.total_cents) filter (where o.status not in ${TERMINAL_BAD}),0)::bigint as gross from orders o where ${this.orderWhere(ids, f, w.from, w.to)} group by 1 order by 1`)).map((x) => ({ day: x.day, orders: n(x.orders), grossCents: n(x.gross) }));
    return { window: { from: w.from, to: w.to, prevFrom: w.prevFrom }, current: cur, previous: prev, trend, locations: locs.length };
  }

  async breakdown(user: JwtPayload, dim: Dim, f: OpsFilter) {
    assertCan(user, 'overview.read');
    const locs = await this.scopeLocations(user, f);
    const ids = locs.map((l) => l.id);
    const w = this.window(f);
    const where = this.orderWhere(ids, f, w.from, w.to);
    if (dim === 'brand') {
      const r = rows<Record<string, unknown>>(await this.db.execute(sql`select ol.brand_id as key, count(distinct o.id)::int as orders, coalesce(sum(ol.line_total_cents) filter (where o.status not in ${TERMINAL_BAD}),0)::bigint as sales, count(distinct o.id) filter (where o.status in ${TERMINAL_BAD})::int as lost from order_lines ol join orders o on o.id = ol.order_id where ${where} group by ol.brand_id order by sales desc`));
      const names = await this.db.select({ id: brands.id, name: brands.name }).from(brands);
      return r.map((x) => ({ key: x.key as string | null, label: names.find((b) => b.id === x.key)?.name || 'No brand (restaurant menu)', orders: n(x.orders), salesCents: n(x.sales), canceled: n(x.lost), aovCents: n(x.orders) ? Math.round(n(x.sales) / n(x.orders)) : 0 }));
    }
    const col = dim === 'location' ? sql`o.location_id::text` : dim === 'merchant' ? sql`o.organization_id::text` : dim === 'channel' ? sql`o.channel::text` : sql`coalesce(l.region_id::text, 'none')`;
    const r = rows<Record<string, unknown>>(await this.db.execute(sql`select ${col} as key, count(*)::int as orders, coalesce(sum(o.total_cents) filter (where o.status not in ${TERMINAL_BAD}),0)::bigint as sales, count(*) filter (where o.status in ${TERMINAL_BAD})::int as lost, count(*) filter (where o.status not in ${TERMINAL_BAD})::int as kept from orders o join locations l on l.id = o.location_id where ${where} group by 1 order by sales desc`));
    const orgNames = dim === 'merchant' ? await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, r.map((x) => x.key as string).filter(Boolean).length ? r.map((x) => x.key as string) : ['00000000-0000-0000-0000-000000000000'])) : [];
    const regionNames = dim === 'region' ? await this.db.select().from(regions) : [];
    const label = (k: string) => (dim === 'location' ? locs.find((l) => l.id === k)?.name || k : dim === 'merchant' ? orgNames.find((o) => o.id === k)?.name || k : dim === 'region' ? regionNames.find((g) => g.id === k)?.name || 'No region' : k);
    return r.map((x) => ({ key: x.key as string, label: label(x.key as string), orders: n(x.orders), salesCents: n(x.sales), canceled: n(x.lost), aovCents: n(x.kept) ? Math.round(n(x.sales) / n(x.kept)) : 0 }));
  }

  // ───── 1.4 live board ─────

  async live(user: JwtPayload, f: OpsFilter) {
    assertCan(user, 'ops.read');
    const locs = await this.scopeLocations(user, f);
    const ids = locs.length ? locs.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000'];
    const list = rows<Record<string, unknown>>(await this.db.execute(sql`
      select o.id, o.number, o.status, o.fulfillment_type, o.channel, o.location_id, o.organization_id, o.total_cents, o.created_at, o.accepted_at, o.ready_at, o.promise_at, o.scheduled_for,
        dj.status as job_status, dj.driver_id, dj.eta_at, dj.provider,
        extract(epoch from (now() - coalesce(o.promise_at, o.created_at)))::int as late_seconds
      from orders o left join delivery_jobs dj on dj.order_id = o.id
      where o.location_id = any(${pgArr(ids)}::uuid[]) and o.status in ('SUBMITTED','ACCEPTED','PREPARING','READY','COLLECTED')
        and (o.scheduled_for is null or o.scheduled_for <= now() + interval '45 minutes')
        and o.created_at > now() - interval '2 days'
      order by coalesce(o.promise_at, o.created_at) asc limit 500`));
    const bucketOf = (o: Record<string, unknown>) => {
      const st = o.status as string;
      const job = o.job_status as string | null;
      if (st === 'SUBMITTED') return 'awaitingAcceptance';
      if (o.fulfillment_type === 'DELIVERY') {
        if (job === 'PICKED_UP' || st === 'COLLECTED') return 'outForDelivery';
        if (st === 'READY') return 'awaitingCourier';
      }
      if (st === 'READY') return 'ready';
      return 'cooking';
    };
    const items = list.map((o) => {
      const loc = locs.find((l) => l.id === o.location_id);
      const late = o.promise_at && n(o.late_seconds) > 0 && o.status !== 'COLLECTED';
      return { id: o.id as string, number: o.number as string, status: o.status as string, fulfillmentType: o.fulfillment_type as string, channel: o.channel as string, locationId: o.location_id as string, locationName: loc?.name, totalCents: n(o.total_cents), createdAt: o.created_at, promiseAt: o.promise_at, deliveryStatus: o.job_status as string | null, bucket: bucketOf(o), overdue: !!late, minutesLate: late ? Math.round(n(o.late_seconds) / 60) : 0 };
    });
    const buckets = ['awaitingAcceptance', 'cooking', 'ready', 'awaitingCourier', 'outForDelivery'] as const;
    return {
      counts: { ...Object.fromEntries(buckets.map((b) => [b, items.filter((i) => i.bucket === b).length])), overdue: items.filter((i) => i.overdue).length } as Record<(typeof buckets)[number] | 'overdue', number>,
      items,
      at: new Date(),
    };
  }

  // ───── 1.5 capacity ─────

  async capacity(user: JwtPayload, f: OpsFilter) {
    assertCan(user, 'ops.read');
    const locs = await this.scopeLocations(user, f);
    const ids = locs.length ? locs.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000'];
    const load = rows<{ location_id: string; active: number; last15: number }>(await this.db.execute(sql`select location_id, count(*) filter (where status in ('ACCEPTED','PREPARING'))::int as active, count(*) filter (where created_at > now() - interval '15 minutes')::int as last15 from orders where location_id = any(${pgArr(ids)}::uuid[]) and created_at > now() - interval '1 day' group by location_id`));
    const stock = rows<{ location_id: string; sold_out: number }>(await this.db.execute(sql`select m.location_id, count(*)::int as sold_out from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id where m.location_id = any(${pgArr(ids)}::uuid[]) and mi.sold_out group by m.location_id`));
    const devs = await this.db.select({ locationId: devices.locationId, kind: devices.kind, isOnline: devices.isOnline, lastHeartbeatAt: devices.lastHeartbeatAt, name: devices.name }).from(devices).where(inArray(devices.locationId, ids));
    const [drv] = rows<Record<string, unknown>>(await this.db.execute(sql`select count(*) filter (where status = 'APPROVED')::int as approved, count(*) filter (where status = 'APPROVED' and is_available and last_seen_at > now() - interval '10 minutes')::int as available from drivers`));
    const [busy] = rows<Record<string, unknown>>(await this.db.execute(sql`select count(distinct driver_id)::int as busy, count(*) filter (where status in ('REQUESTED','UNASSIGNED'))::int as waiting from delivery_jobs where status in ('REQUESTED','UNASSIGNED','ASSIGNED','PICKED_UP') and location_id = any(${pgArr(ids)}::uuid[])`));
    const perLoc = locs.map((l) => {
      const ld = load.find((x) => x.location_id === l.id);
      const throttle = l.throttle || null;
      const ds = devs.filter((d) => d.locationId === l.id);
      return {
        id: l.id, name: l.name, city: l.city, status: l.status, platformOperated: l.platformOperated,
        isPaused: l.isPaused, pausedReason: l.pausedReason,
        activeOrders: n(ld?.active), ordersLast15m: n(ld?.last15), throttlePer15m: throttle,
        loadPct: throttle ? Math.round((n(ld?.last15) / throttle) * 100) : null,
        soldOutItems: n(stock.find((x) => x.location_id === l.id)?.sold_out),
        devices: ds.length, devicesOffline: ds.filter((d) => !d.isOnline).length,
      };
    });
    return {
      couriers: { approved: n(drv.approved), available: n(drv.available), busy: n(busy.busy), jobsWaitingForCourier: n(busy.waiting) },
      totals: { locations: perLoc.length, paused: perLoc.filter((l) => l.isPaused).length, overloaded: perLoc.filter((l) => (l.loadPct || 0) >= 90).length, stockouts: perLoc.reduce((a, l) => a + l.soldOutItems, 0), devicesOffline: perLoc.reduce((a, l) => a + l.devicesOffline, 0) },
      locations: perLoc.sort((a, b) => Number(b.isPaused) - Number(a.isPaused) || (b.loadPct || 0) - (a.loadPct || 0) || b.activeOrders - a.activeOrders),
    };
  }

  // ───── 1.6 contribution margin ─────

  /** Per-order contribution after food, labor, delivery, processing and promotions; averaged, with the worst orders listed. */
  async contribution(user: JwtPayload, f: OpsFilter) {
    assertCan(user, 'overview.read');
    const locs = await this.scopeLocations(user, f);
    const w = this.window(f);
    const rate = await this.settings.get<number>('ops.labor_rate_cents_per_hour', DEFAULT_LABOR_RATE);
    const where = this.orderWhere(locs.map((l) => l.id), f, w.from, w.to);
    const r = rows<Record<string, unknown>>(await this.db.execute(sql`
      with base as (select o.* from orders o where ${where} and o.status in ('COMPLETED','COLLECTED')),
      lc as (
        select ol.order_id,
          sum(ol.quantity * coalesce(rc.food, 0)) as food,
          sum(ol.quantity * coalesce(rc.labor_min, 0)) as labor_min
        from order_lines ol join base b on b.id = ol.order_id
        left join menu_items mi on mi.id = ol.menu_item_id
        left join lateral (
          select sum(rl.quantity * i.cost_cents_per_unit) / greatest(max(r.yield_portions), 1) as food, max(r.labor_minutes) / greatest(max(r.yield_portions), 1) as labor_min
          from recipes r join recipe_lines rl on rl.recipe_id = r.id join ingredients i on i.id = rl.ingredient_id where r.id = mi.recipe_id
        ) rc on true
        where ol.status not in ('CREDITED','UNAVAILABLE')
        group by ol.order_id
      ),
      dl as (select dj.order_id, sum(dj.provider_cost_cents)::bigint as provider, sum(coalesce(de.base_cents, 0))::bigint as driver from delivery_jobs dj join base b on b.id = dj.order_id left join driver_earnings de on de.delivery_job_id = dj.id group by dj.order_id),
      pm as (select p.order_id, sum(p.processing_fee_cents)::bigint as processing from payments p join base b on b.id = p.order_id group by p.order_id),
      -- 1.6-L actual labor: a kitchen's recorded labor for the day spread over that day's orders there
      ok as (select b.id, l.kitchen_id, date_trunc('day', b.created_at) as day from base b join locations l on l.id = b.location_id where l.kitchen_id is not null),
      kd as (select kitchen_id, day, count(*) as n from ok group by 1, 2),
      al as (select kitchen_id, date_trunc('day', date) as day, sum(hours * rate_cents) as cents from labor_entries group by 1, 2),
      la as (select ok.id as order_id, al.cents / kd.n as cents from ok join kd on kd.kitchen_id = ok.kitchen_id and kd.day = ok.day join al on al.kitchen_id = ok.kitchen_id and al.day = ok.day),
      led as (select je.order_id, sum(case when je.account::text like 'PLATFORM_REVENUE_%' then je.credit_cents - je.debit_cents else 0 end)::bigint as plat_rev, sum(case when je.account::text like 'PLATFORM_EXPENSE_%' then je.debit_cents - je.credit_cents else 0 end)::bigint as plat_exp from journal_entries je join base b on b.id = je.order_id group by je.order_id)
      select b.id, b.number, b.location_id, b.channel, b.fulfillment_type, b.subtotal_cents, b.discount_cents, b.delivery_fee_cents, b.service_fee_cents,
        coalesce(lc.food,0)::bigint as food, coalesce(round(la.cents), round(coalesce(lc.labor_min,0) * ${rate} / 60.0))::bigint as labor, (la.cents is not null) as labor_actual,
        (coalesce(dl.provider,0) + coalesce(dl.driver,0))::bigint as delivery, coalesce(pm.processing,0)::bigint as processing,
        coalesce(led.plat_rev,0)::bigint as plat_rev, coalesce(led.plat_exp,0)::bigint as plat_exp
      from base b left join lc on lc.order_id = b.id left join dl on dl.order_id = b.id left join pm on pm.order_id = b.id left join led on led.order_id = b.id left join la on la.order_id = b.id
      limit 5000`));
    const per = r.map((x) => {
      const revenue = n(x.subtotal_cents) + n(x.delivery_fee_cents) + n(x.service_fee_cents);
      const promo = n(x.discount_cents);
      const cost = { food: n(x.food), labor: n(x.labor), delivery: n(x.delivery), processing: n(x.processing), promotions: promo };
      const contribution = revenue - cost.food - cost.labor - cost.delivery - cost.processing - cost.promotions;
      return { id: x.id as string, number: x.number as string, locationName: locs.find((l) => l.id === x.location_id)?.name, channel: x.channel as string, fulfillmentType: x.fulfillment_type as string, revenueCents: revenue, ...Object.fromEntries(Object.entries(cost).map(([k, v]) => [`${k}Cents`, v])), contributionCents: contribution, marginPct: revenue ? contribution / revenue : 0, platformContributionCents: n(x.plat_rev) - n(x.plat_exp) } as { id: string; number: string; revenueCents: number; foodCents: number; laborCents: number; deliveryCents: number; processingCents: number; promotionsCents: number; contributionCents: number; marginPct: number; platformContributionCents: number; locationName?: string; channel: string; fulfillmentType: string };
    });
    const avg = (k: keyof (typeof per)[number]) => (per.length ? Math.round(per.reduce((a, p) => a + (p[k] as number), 0) / per.length) : 0);
    return {
      orders: per.length,
      laborRateCentsPerHour: rate,
      ordersWithActualLabor: r.filter((x) => x.labor_actual === true).length,
      average: { revenueCents: avg('revenueCents'), foodCents: avg('foodCents'), laborCents: avg('laborCents'), deliveryCents: avg('deliveryCents'), processingCents: avg('processingCents'), promotionsCents: avg('promotionsCents'), contributionCents: avg('contributionCents'), platformContributionCents: avg('platformContributionCents') },
      marginPct: per.length ? per.reduce((a, p) => a + p.contributionCents, 0) / Math.max(1, per.reduce((a, p) => a + p.revenueCents, 0)) : 0,
      negative: per.filter((p) => p.contributionCents < 0).length,
      worst: [...per].sort((a, b) => a.contributionCents - b.contributionCents).slice(0, 25),
      note: 'Food comes from recipe costs (ingredients at last purchase price). Labor uses the hours a kitchen actually recorded (attendance or labor entries) spread over that day’s orders; where none are recorded it falls back to recipe labor minutes at the configured hourly rate.',
    };
  }

  // ───── 1.8 drill-down & 12.1 search ─────

  async searchOrders(user: JwtPayload, q: OpsFilter & { q?: string; status?: string; bucket?: string; overdue?: boolean; driverId?: string; customer?: string; partial?: boolean; limit?: number; offset?: number }) {
    assertCan(user, 'orders.read');
    const locs = await this.scopeLocations(user, q);
    const ids = locs.length ? locs.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000'];
    const parts: SQL[] = [sql`o.location_id = any(${pgArr(ids)}::uuid[])`];
    if (q.from) parts.push(sql`o.created_at >= ${new Date(q.from).toISOString()}`);
    if (q.to) parts.push(sql`o.created_at < ${new Date(q.to).toISOString()}`);
    if (q.channel) parts.push(sql`o.channel = ${q.channel}`);
    if (q.status) parts.push(sql`o.status = any(${pgArr(q.status.split(','))}::order_status[])`);
    if (q.partial) parts.push(sql`o.partial_fulfillment`);
    if (q.brandId) parts.push(sql`exists (select 1 from order_lines bl where bl.order_id = o.id and bl.brand_id = ${q.brandId})`);
    if (q.driverId) parts.push(sql`exists (select 1 from delivery_jobs dj2 where dj2.order_id = o.id and dj2.driver_id = ${q.driverId})`);
    if (q.overdue) parts.push(sql`o.promise_at < now() and o.status in ('SUBMITTED','ACCEPTED','PREPARING','READY')`);
    if (q.customer) parts.push(sql`(o.guest_email ilike ${'%' + q.customer + '%'} or o.guest_phone ilike ${'%' + q.customer + '%'} or o.guest_name ilike ${'%' + q.customer + '%'} or exists (select 1 from users u where u.id = o.user_id and (u.email ilike ${'%' + q.customer + '%'} or u.phone ilike ${'%' + q.customer + '%'})))`);
    if (q.q) {
      const t = q.q.trim();
      parts.push(sql`(o.number ilike ${'%' + t + '%'} or o.id::text = ${t} or o.external_order_id = ${t} or o.pos_ticket_id = ${t}
        or exists (select 1 from payments p where p.order_id = o.id and (p.provider_intent_id = ${t} or p.provider_charge_id = ${t} or p.id::text = ${t}))
        or exists (select 1 from delivery_jobs dj3 where dj3.order_id = o.id and (dj3.provider_job_id = ${t} or dj3.id::text = ${t})))`);
    }
    if (q.bucket) {
      const b = q.bucket;
      if (b === 'awaitingAcceptance') parts.push(sql`o.status = 'SUBMITTED'`);
      if (b === 'cooking') parts.push(sql`o.status in ('ACCEPTED','PREPARING')`);
      if (b === 'ready') parts.push(sql`o.status = 'READY' and o.fulfillment_type <> 'DELIVERY'`);
      if (b === 'awaitingCourier') parts.push(sql`o.status = 'READY' and o.fulfillment_type = 'DELIVERY'`);
      if (b === 'outForDelivery') parts.push(sql`o.fulfillment_type = 'DELIVERY' and (o.status = 'COLLECTED' or exists (select 1 from delivery_jobs dj4 where dj4.order_id = o.id and dj4.status = 'PICKED_UP'))`);
      if (b === 'canceled') parts.push(sql`o.status in ('CANCELED','REJECTED')`);
      if (b === 'refunded') parts.push(sql`exists (select 1 from refunds rf where rf.order_id = o.id)`);
    }
    const limit = Math.min(q.limit || 50, 200);
    const where = sql.join(parts, sql` and `);
    const list = rows<Record<string, unknown>>(await this.db.execute(sql`
      select o.id, o.number, o.status, o.channel, o.fulfillment_type, o.location_id, o.organization_id, o.total_cents, o.subtotal_cents, o.created_at, o.promise_at, o.partial_fulfillment,
        coalesce(u.email, o.guest_email) as customer_email, coalesce(u.name, o.guest_name) as customer_name,
        (select dj.status from delivery_jobs dj where dj.order_id = o.id limit 1) as delivery_status,
        (select p.status from payments p where p.order_id = o.id and p.purpose = 'ORDER' limit 1) as payment_status,
        (select coalesce(sum(rf.amount_cents),0) from refunds rf where rf.order_id = o.id)::int as refunded_cents
      from orders o left join users u on u.id = o.user_id
      where ${where} order by o.created_at desc limit ${limit} offset ${q.offset || 0}`));
    const [cnt] = rows<{ n: number }>(await this.db.execute(sql`select count(*)::int as n from orders o where ${where}`));
    const pii = can(user, 'customers.pii');
    return {
      total: n(cnt.n),
      items: list.map((o) => ({
        id: o.id, number: o.number, status: o.status, channel: o.channel, fulfillmentType: o.fulfillment_type, locationId: o.location_id, locationName: locs.find((l) => l.id === o.location_id)?.name, organizationId: o.organization_id,
        totalCents: n(o.total_cents), createdAt: o.created_at, promiseAt: o.promise_at, partialFulfillment: !!o.partial_fulfillment, deliveryStatus: o.delivery_status, paymentStatus: o.payment_status, refundedCents: n(o.refunded_cents),
        customer: pii ? { name: o.customer_name, email: o.customer_email } : { name: o.customer_name ? String(o.customer_name).split(' ')[0] : null, email: o.customer_email ? String(o.customer_email).replace(/^(.).*(@.*)$/, '$1•••$2') : null },
      })),
    };
  }

  // ───── 12.2 / 12.3 order detail ─────

  async orderDetail(user: JwtPayload, orderId: string) {
    assertCan(user, 'orders.read');
    const t = await this.orders.timeline(user, orderId);
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const [loc] = await this.db.select({ id: locations.id, name: locations.name, organizationId: locations.organizationId, kitchenId: locations.kitchenId, platformOperated: locations.platformOperated }).from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const [org] = await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, o.organizationId)).limit(1);
    const refundRows = await this.db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.createdAt));
    const notes = await this.db.select({ n: orderNotes, email: users.email }).from(orderNotes).leftJoin(users, eq(users.id, orderNotes.authorId)).where(eq(orderNotes.orderId, orderId)).orderBy(orderNotes.createdAt);
    const incs = await this.db.select().from(incidents).where(eq(incidents.orderId, orderId)).orderBy(desc(incidents.createdAt));
    const approvals = await this.db.select().from(approvalRequests).where(and(eq(approvalRequests.subjectType, 'incident'), inArray(approvalRequests.subjectId, incs.length ? incs.map((i) => i.id) : ['none'])));
    const msgs = o.userId || o.guestEmail ? await this.db.select({ id: notifications.id, template: notifications.template, channel: notifications.channel, status: notifications.status, createdAt: notifications.createdAt, sentAt: notifications.sentAt }).from(notifications).where(sql`(${notifications.payload}->>'orderId' = ${orderId} or ${notifications.payload}->>'number' = ${o.number})`).orderBy(notifications.createdAt).limit(100) : [];
    const pii = can(user, 'customers.pii');
    const [cust] = o.userId ? await this.db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone }).from(users).where(eq(users.id, o.userId)).limit(1) : [null];
    const customer = { id: cust?.id || null, name: cust?.name || o.guestName, email: pii ? cust?.email || o.guestEmail : null, phone: pii ? cust?.phone || o.guestPhone : null, masked: !pii };
    const issues = await this.issuesFor(orderId);
    return { ...t, location: loc, organization: org, customer, refunds: refundRows, notes: notes.map((x) => ({ ...x.n, authorEmail: x.email })), incidents: incs, approvals, messages: msgs, issues, partialFulfillment: o.partialFulfillment };
  }

  /** Conflicting statuses and duplicate events for one order (also used by the detectors). */
  async issuesFor(orderId: string) {
    const [x] = rows<Record<string, unknown>>(await this.db.execute(sql`
      select o.status, o.fulfillment_type, dj.status as job, p.status as pay, p.captured_cents, p.refunded_cents
      from orders o left join delivery_jobs dj on dj.order_id = o.id left join payments p on p.order_id = o.id and p.purpose = 'ORDER' where o.id = ${orderId} limit 1`));
    const out: string[] = [];
    if (!x) return out;
    if (x.job === 'DELIVERED' && !['COLLECTED', 'COMPLETED'].includes(x.status as string)) out.push(`Delivery is DELIVERED but the order is ${x.status}`);
    if (x.status === 'COMPLETED' && x.fulfillment_type === 'DELIVERY' && x.job && !['DELIVERED', 'CANCELED', 'FAILED', 'RETURNED'].includes(x.job as string)) out.push(`Order is COMPLETED but the delivery is ${x.job}`);
    if (['CANCELED', 'REJECTED'].includes(x.status as string) && x.pay === 'CAPTURED' && n(x.refunded_cents) < n(x.captured_cents)) out.push(`Order is ${x.status} but ${n(x.captured_cents) - n(x.refunded_cents)}¢ captured is not refunded`);
    if (['COMPLETED', 'COLLECTED', 'READY'].includes(x.status as string) && x.pay === 'AUTHORIZED') out.push(`Order is ${x.status} but payment is only AUTHORIZED (not captured)`);
    if (['CANCELED', 'REJECTED'].includes(x.status as string) && ['REQUESTED', 'ASSIGNED', 'PICKED_UP'].includes(x.job as string)) out.push(`Order is ${x.status} but a courier job is still ${x.job}`);
    const dup = rows<{ type: string; n: number }>(await this.db.execute(sql`select type, count(*)::int as n from order_events where order_id = ${orderId} and type in ('ACCEPTED','READY','REJECTED','CANCELED','COLLECTED','COMPLETED') group by type having count(*) > 1`));
    for (const d of dup) out.push(`Event ${d.type} recorded ${d.n} times`);
    return out;
  }

  // ───── 12.9 notes & customer messages ─────

  async addNote(user: JwtPayload, orderId: string, input: { body: string; visibility: 'INTERNAL' | 'CUSTOMER'; templateKey?: string }) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    assertOrgAccess(user, o.organizationId, o.locationId);
    let body = input.body;
    if (input.templateKey) {
      const [tpl] = await this.db.select().from(messageTemplates).where(eq(messageTemplates.key, input.templateKey)).limit(1);
      if (tpl && !input.body.trim()) body = tpl.body;
    }
    body = body.replace(/\{\{number\}\}/g, o.number).replace(/\{\{name\}\}/g, (o.guestName || '').split(' ')[0] || 'there');
    const [row] = await this.db.insert(orderNotes).values({ orderId, authorId: user.sub, visibility: input.visibility, body, templateKey: input.templateKey ?? null }).returning();
    if (input.visibility === 'CUSTOMER') {
      await this.notify.queue({ userId: o.userId, email: o.userId ? null : o.guestEmail, phone: o.userId ? null : o.guestPhone, template: 'order.message', payload: { orderId, number: o.number, body }, channels: ['EMAIL', 'PUSH', 'IN_APP'] });
    }
    await this.audit.log({ organizationId: o.organizationId, actorId: user.sub, action: input.visibility === 'CUSTOMER' ? 'order.message' : 'order.note', entityType: 'order', entityId: orderId, after: { body } });
    return row;
  }

  async listTemplates() {
    return this.db.select().from(messageTemplates).where(eq(messageTemplates.isActive, true)).orderBy(messageTemplates.category, messageTemplates.title);
  }

  async upsertTemplate(user: JwtPayload, input: { key: string; title: string; body: string; category?: string; isActive?: boolean }) {
    assertCan(user, 'support.manage');
    const v = { key: input.key, title: input.title, body: input.body, category: input.category || 'GENERAL', isActive: input.isActive ?? true, updatedById: user.sub };
    const [row] = await this.db.insert(messageTemplates).values(v).onConflictDoUpdate({ target: messageTemplates.key, set: v }).returning();
    await this.audit.log({ actorId: user.sub, action: 'template.upsert', entityType: 'message_template', entityId: input.key, after: row });
    return row;
  }

  // ───── 12.7 controlled remedies from the order page ─────

  /** Opens a ticket for the order and resolves it through the support flow, so approval limits and duplicate checks apply. */
  async remedy(user: JwtPayload, orderId: string, input: { remedy: 'REFUND' | 'CREDIT' | 'REMAKE' | 'REDELIVERY'; remedyCents?: number; owner: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER' | 'CUSTOMER'; category?: string; reason: string }) {
    assertCan(user, 'orders.manage');
    const inc = await this.support.open(user, { orderId, category: (input.category as never) || 'OTHER', description: `Ops action: ${input.remedy.toLowerCase()} — ${input.reason}` });
    return this.support.resolve(user, inc.id, { owner: input.owner, remedy: input.remedy, remedyCents: input.remedyCents, note: input.reason });
  }

  /** Re-routes the kitchen tickets of an order to another station (e.g. when a station is down). */
  async rerouteTickets(user: JwtPayload, orderId: string, fromStation: string, toStation: string) {
    assertCan(user, 'orders.manage');
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    assertOrgAccess(user, o.organizationId, o.locationId);
    const r = rows<{ id: string }>(await this.db.execute(sql`update kitchen_tickets set station_code = ${toStation} where order_id = ${orderId} and station_code = ${fromStation} and status in ('QUEUED','IN_PROGRESS') returning id`));
    await this.db.insert(orderEvents).values({ orderId, type: 'REROUTED', actorId: user.sub, actorRole: 'OPERATIONS', data: { fromStation, toStation, tickets: r.length } });
    await this.audit.log({ organizationId: o.organizationId, actorId: user.sub, action: 'order.reroute', entityType: 'order', entityId: orderId, after: { fromStation, toStation, tickets: r.length } });
    return { rerouted: r.length };
  }

  async filterOptions(user: JwtPayload) {
    const locs = await this.scopeLocations(user, {});
    const orgIds = Array.from(new Set(locs.map((l) => l.organizationId)));
    const [regs, orgs, brandRows, drv] = await Promise.all([
      this.db.select().from(regions).orderBy(regions.name),
      orgIds.length ? this.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)).orderBy(organizations.name) : Promise.resolve([]),
      orgIds.length ? this.db.select({ id: brands.id, name: brands.name }).from(brands).where(inArray(brands.organizationId, orgIds)) : Promise.resolve([]),
      this.db.select({ id: drivers.id, email: users.email, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).limit(500),
    ]);
    return { regions: regs, organizations: orgs, locations: locs.map((l) => ({ id: l.id, name: l.name, organizationId: l.organizationId, regionId: l.regionId })), brands: brandRows, couriers: can(user, 'delivery.read') ? drv : [], channels: ['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER', 'PHONE', 'WALK_IN', 'CAMPUS', 'CORPORATE', 'API'] };
  }
}

