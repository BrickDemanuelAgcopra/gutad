import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { chefCalendarDays, chefDishes, chefPauses, chefProfiles, kitchenCapacityLedger, locations, menuItems, openingHours, orgMemberships, orders } from '../../db/schema';
import { addDaysYmd, chefNoticeText, DEFAULT_CHEF_POLICY, type ChefPolicy, weekdayYmd, type ChefAvailability, type ChefAvailabilityDay, type ChefCalendarDay, type ChefDayStatus, type ChefOperatingSettings, type ChefPause } from '@gutad/shared';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { localParts, zonedTimeToUtc } from '../../common/utils';

type Loc = typeof locations.$inferSelect;
type Profile = typeof chefProfiles.$inferSelect;
type Override = typeof chefCalendarDays.$inferSelect;
type Pause = typeof chefPauses.$inferSelect;

/** Date rules and the per-dish daily limit of one dish (or the chef's defaults when no dish is involved). */
interface DishRule { menuItemId: string; name: string; minLeadDays: number; cutoffHour: number; maxAdvanceDays: number; limit: number | null; soldOut: boolean }

interface Ctx {
  loc: Loc;
  profile: Profile | null;
  op: ChefOperatingSettings;
  hours: (typeof openingHours.$inferSelect)[];
  overrides: Map<string, Override>;
  pauses: Pause[];
  /** admin cap on how far ahead anyone can order (setting chefs.max_advance_days) */
  cap: number;
  today: string;
  now: Date;
}

interface Usage { total: number; held: number; booked: number; orders: Set<string>; items: Map<string, number> }

const SLOT_MINUTES = 30;
/** same-day orders need at least this much time before the first slot */
const SAME_DAY_BUFFER_MINUTES = 60;
const MAX_RANGE_DAYS = 120;

export function chefOperating(p: Profile | null, hours: (typeof openingHours.$inferSelect)[] = []): ChefOperatingSettings {
  const op = (p?.operating || {}) as Partial<ChefOperatingSettings>;
  const first = hours[0];
  return {
    cookingDays: op.cookingDays?.length ? op.cookingDays : hours.length ? [...new Set(hours.map((h) => h.dayOfWeek))].sort() : [1, 2, 3, 4, 5],
    cutoffHour: op.cutoffHour ?? 12,
    minLeadDays: op.minLeadDays ?? 1,
    dailyCapacity: op.dailyCapacity ?? 10,
    maxAdvanceDays: op.maxAdvanceDays ?? 30,
    opens: op.opens || first?.opens || '09:00',
    closes: op.closes || first?.closes || '20:00',
    lateRefundPct: op.lateRefundPct,
  };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
const isYmd = (s: string | undefined | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Gutad Chef Network advance ordering: cooking calendars (weekly days, per-date overrides, holiday pauses),
 * notice periods and cutoff hours, per-dish and per-kitchen daily limits, and short capacity holds during checkout.
 *
 * A date D can be ordered until (D − minLeadDays days) at cutoffHour, kitchen time; e.g. 1 day / 12 → noon the day
 * before. Capacity is counted in units (dish quantity) per kitchen location and date in `kitchen_capacity_ledger`.
 */
@Injectable()
export class ChefCalendarService {
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  // ───── context and rules ─────

  private async context(locationId: string, from: string, to: string, tx: DbOrTx = this.db): Promise<Ctx> {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Kitchen not found');
    const [profile] = await tx.select().from(chefProfiles).where(eq(chefProfiles.locationId, locationId)).limit(1);
    const hours = await tx.select().from(openingHours).where(eq(openingHours.locationId, locationId)).orderBy(asc(openingHours.dayOfWeek));
    const overrides = profile ? await tx.select().from(chefCalendarDays).where(and(eq(chefCalendarDays.chefProfileId, profile.id), gte(chefCalendarDays.date, from), lte(chefCalendarDays.date, to))) : [];
    const pauses = profile ? await tx.select().from(chefPauses).where(and(eq(chefPauses.chefProfileId, profile.id), lte(chefPauses.startDate, to), gte(chefPauses.endDate, from))).orderBy(asc(chefPauses.startDate)) : [];
    const cap = Number(await this.settings.get<number>('chefs.max_advance_days', 60)) || 60;
    const now = new Date();
    return { loc, profile: profile ?? null, op: chefOperating(profile ?? null, hours.filter((h) => h.service === 'ALL' || h.service === 'ORDERING')), hours, overrides: new Map(overrides.map((o) => [o.date, o])), pauses, cap, today: localParts(now, loc.timezone).ymd, now };
  }

  private defaultsRule(ctx: Ctx): DishRule {
    return { menuItemId: '', name: '', minLeadDays: ctx.op.minLeadDays, cutoffHour: ctx.op.cutoffHour, maxAdvanceDays: ctx.op.maxAdvanceDays, limit: null, soldOut: false };
  }

  private async dishRules(ctx: Ctx, menuItemIds: string[], tx: DbOrTx = this.db): Promise<DishRule[]> {
    const ids = [...new Set(menuItemIds)];
    if (!ids.length) return [];
    const rows = await tx.select({ i: menuItems, d: chefDishes }).from(menuItems).leftJoin(chefDishes, eq(chefDishes.menuItemId, menuItems.id)).where(inArray(menuItems.id, ids));
    return rows.map(({ i, d }) => ({
      menuItemId: i.id,
      name: d?.dishName || i.name,
      minLeadDays: d?.minLeadDays ?? ctx.op.minLeadDays,
      cutoffHour: d?.cutoffHour ?? ctx.op.cutoffHour,
      maxAdvanceDays: d?.maxAdvanceDays ?? ctx.op.maxAdvanceDays,
      limit: d?.dailyCapacity ?? null,
      soldOut: i.soldOut,
    }));
  }

  /** Last moment to order for `date` under a rule (the kitchen's local cutoff hour, minLeadDays before). */
  private deadline(ctx: Ctx, date: string, r: DishRule) {
    return zonedTimeToUtc(addDaysYmd(date, -r.minLeadDays), hhmm(r.cutoffHour * 60), ctx.loc.timezone);
  }

  private kitchenCapacity(ctx: Ctx, date: string) {
    return ctx.overrides.get(date)?.capacity ?? ctx.op.dailyCapacity;
  }

  private isCookingDay(ctx: Ctx, date: string) {
    const ov = ctx.overrides.get(date);
    return ov?.open ?? ctx.op.cookingDays.includes(weekdayYmd(date));
  }

  private pauseOn(ctx: Ctx, date: string) {
    return ctx.pauses.find((p) => p.startDate <= date && date <= p.endDate) ?? null;
  }

  /** 30-minute pickup/delivery times for a date: the weekday's ordering hours, or the chef's default window. */
  private slots(ctx: Ctx, date: string) {
    const wd = weekdayYmd(date);
    const rows = ctx.hours.filter((h) => h.dayOfWeek === wd && (h.service === 'ALL' || h.service === 'ORDERING'));
    const windows = rows.length ? rows.map((h) => [h.opens, h.closes]) : [[ctx.op.opens, ctx.op.closes]];
    const out = new Set<string>();
    let earliest = -1;
    if (date === ctx.today) {
      const lp = localParts(new Date(ctx.now.getTime() + SAME_DAY_BUFFER_MINUTES * 60_000), ctx.loc.timezone);
      earliest = lp.ymd === date ? toMin(lp.hhmm) : 24 * 60;
    }
    for (const [o, c] of windows) {
      const start = Math.ceil(toMin(o) / SLOT_MINUTES) * SLOT_MINUTES;
      const end = toMin(c) <= toMin(o) ? 24 * 60 : toMin(c);
      for (let t = start; t + SLOT_MINUTES <= end; t += SLOT_MINUTES) if (t >= earliest) out.add(hhmm(t));
    }
    return [...out].sort();
  }

  /** Units counted per date: unexpired holds (except the caller's own checkout session) and confirmed live orders. */
  private async usage(locationId: string, from: string, to: string, excludeHoldKey: string | null | undefined, tx: DbOrTx = this.db, excludeOrderId?: string | null) {
    const rows = await tx
      .select({ date: kitchenCapacityLedger.serviceDate, item: kitchenCapacityLedger.menuItemId, units: kitchenCapacityLedger.units, status: kitchenCapacityLedger.status, orderId: kitchenCapacityLedger.orderId })
      .from(kitchenCapacityLedger)
      .leftJoin(orders, eq(orders.id, kitchenCapacityLedger.orderId))
      .where(
        and(
          eq(kitchenCapacityLedger.locationId, locationId),
          gte(kitchenCapacityLedger.serviceDate, from),
          lte(kitchenCapacityLedger.serviceDate, to),
          sql`((${kitchenCapacityLedger.status} = 'HELD' and ${kitchenCapacityLedger.expiresAt} > now() and ${kitchenCapacityLedger.holdKey} is distinct from ${excludeHoldKey ?? null}) or (${kitchenCapacityLedger.status} = 'CONFIRMED' and ${orders.status} not in ('CANCELED', 'REJECTED')${excludeOrderId ? sql` and ${kitchenCapacityLedger.orderId} <> ${excludeOrderId}::uuid` : sql``}))`,
        ),
      );
    const m = new Map<string, Usage>();
    for (const r of rows) {
      const u = m.get(r.date) ?? { total: 0, held: 0, booked: 0, orders: new Set<string>(), items: new Map<string, number>() };
      u.total += r.units;
      if (r.status === 'HELD') u.held += r.units;
      else u.booked += r.units;
      if (r.orderId) u.orders.add(r.orderId);
      u.items.set(r.item, (u.items.get(r.item) ?? 0) + r.units);
      m.set(r.date, u);
    }
    return m;
  }

  /**
   * One date for a set of dishes and quantities (an empty set = the kitchen alone). The strictest dish decides the
   * notice period, cutoff and advance window; every dish's own limit and the kitchen's shared limit must fit.
   */
  private day(ctx: Ctx, date: string, rules: DishRule[], qty: Map<string, number>, usage: Map<string, Usage>): ChefAvailabilityDay {
    const rs = rules.length ? rules : [this.defaultsRule(ctx)];
    const orderBy = new Date(Math.min(...rs.map((r) => this.deadline(ctx, date, r).getTime())));
    const maxAdvance = Math.min(ctx.cap, ...rs.map((r) => r.maxAdvanceDays));
    const ov = ctx.overrides.get(date);
    let status: ChefDayStatus = 'AVAILABLE';
    let remaining: number | null = null;
    if (date > addDaysYmd(ctx.today, maxAdvance)) status = 'TOO_FAR';
    else if (this.pauseOn(ctx, date)) status = 'PAUSED';
    else if (ov?.open === false) status = 'CLOSED';
    else if (!this.isCookingDay(ctx, date)) status = 'NOT_COOKING';
    else if (ctx.now >= orderBy) status = 'CUTOFF_PASSED';
    else {
      const u = usage.get(date);
      const kitchenLeft = Math.max(0, this.kitchenCapacity(ctx, date) - (u?.total ?? 0));
      const need = [...qty.values()].reduce((a, n) => a + n, 0);
      let fits = need <= kitchenLeft;
      remaining = kitchenLeft;
      for (const r of rules) {
        const dishLeft = r.limit === null ? Infinity : Math.max(0, r.limit - (u?.items.get(r.menuItemId) ?? 0));
        remaining = Math.min(remaining, dishLeft);
        if (r.soldOut || (qty.get(r.menuItemId) ?? 1) > dishLeft) fits = false;
      }
      if (rules.some((r) => r.soldOut)) remaining = 0;
      if (!fits || remaining === 0) status = 'SOLD_OUT';
    }
    const slots = status === 'AVAILABLE' ? this.slots(ctx, date) : [];
    if (status === 'AVAILABLE' && !slots.length) status = 'CUTOFF_PASSED';
    return { date, status, orderBy: ['TOO_FAR', 'PAUSED', 'CLOSED', 'NOT_COOKING'].includes(status) ? null : orderBy.toISOString(), remaining, slots };
  }

  // ───── customer availability ─────

  /** Per-date availability for a kitchen and a set of dishes (the date picker on the dish page and at checkout). */
  async availability(input: { locationId: string; lines?: { menuItemId: string; quantity: number }[]; from?: string; to?: string; holdKey?: string | null; excludeOrderId?: string | null }): Promise<ChefAvailability> {
    const [loc] = await this.db.select({ id: locations.id, timezone: locations.timezone, chefKitchen: locations.chefKitchen }).from(locations).where(eq(locations.id, input.locationId)).limit(1);
    if (!loc?.chefKitchen) throw new NotFoundException('Not a chef kitchen');
    const today = localParts(new Date(), loc.timezone).ymd;
    const from = isYmd(input.from) && input.from > today ? input.from : today;
    const cap = Number(await this.settings.get<number>('chefs.max_advance_days', 60)) || 60;
    const lastAllowed = addDaysYmd(today, cap);
    let to = isYmd(input.to) ? input.to : addDaysYmd(from, 62);
    if (to > lastAllowed) to = lastAllowed;
    if (to > addDaysYmd(from, MAX_RANGE_DAYS)) to = addDaysYmd(from, MAX_RANGE_DAYS);
    const ctx = await this.context(input.locationId, from, to);
    const lines = input.lines || [];
    const rules = await this.dishRules(ctx, lines.map((l) => l.menuItemId));
    const qty = new Map<string, number>();
    for (const l of lines) qty.set(l.menuItemId, (qty.get(l.menuItemId) ?? 0) + Math.max(1, l.quantity));
    const usage = await this.usage(ctx.loc.id, from, to, input.holdKey, this.db, input.excludeOrderId);
    const days: ChefAvailabilityDay[] = [];
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) days.push(this.day(ctx, d, rules, qty, usage));
    const rs = rules.length ? rules : [this.defaultsRule(ctx)];
    const minLeadDays = Math.max(...rs.map((r) => r.minLeadDays));
    const cutoffHour = rules.length ? Math.min(...rs.map((r) => r.cutoffHour)) : ctx.op.cutoffHour;
    const maxAdvanceDays = Math.min(cap, ...rs.map((r) => r.maxAdvanceDays));
    return { locationId: ctx.loc.id, timezone: ctx.loc.timezone, today, earliestDate: days.find((d) => d.status === 'AVAILABLE')?.date ?? null, latestDate: addDaysYmd(today, maxAdvanceDays), rules: { minLeadDays, cutoffHour, maxAdvanceDays }, days };
  }

  async dishAvailability(dishId: string, q: { from?: string; to?: string; quantity?: number; holdKey?: string }) {
    const [d] = await this.db.select({ d: chefDishes, active: menuItems.isActive }).from(chefDishes).innerJoin(menuItems, eq(menuItems.id, chefDishes.menuItemId)).where(eq(chefDishes.id, dishId)).limit(1);
    if (!d || d.d.reviewStatus !== 'PUBLISHED' || !d.active) throw new NotFoundException('Dish not available');
    return this.availability({ locationId: d.d.locationId, lines: [{ menuItemId: d.d.menuItemId, quantity: Math.min(50, Math.max(1, q.quantity || 1)) }], from: q.from, to: q.to, holdKey: q.holdKey });
  }

  /** Kitchen-level open days and times (the location page's pickup times for a chef kitchen). */
  async kitchenTimes(locationId: string, days = 21) {
    const a = await this.availability({ locationId, to: addDaysYmd(localParts(new Date(), (await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, locationId)).limit(1))[0]?.tz || 'America/New_York').ymd, days - 1) });
    return a.days.map((d) => ({ date: d.date, slots: d.slots }));
  }

  /** Whether the user placed this order at this kitchen (changing an order excludes its own portions). */
  async ownsOrder(userId: string, orderId: string, locationId: string) {
    const [o] = await this.db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId), eq(orders.locationId, locationId))).limit(1);
    return !!o;
  }

  /** The chef's public name for a kitchen location (order pages and receipts). */
  async chefNameFor(locationId: string) {
    const [p] = await this.db.select({ n: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.locationId, locationId)).limit(1);
    return p?.n ?? null;
  }

  async chefSlugFor(locationId: string) {
    const [p] = await this.db.select({ s: chefProfiles.slug }).from(chefProfiles).where(eq(chefProfiles.locationId, locationId)).limit(1);
    return p?.s ?? null;
  }

  // ───── quote holds and checkout ─────

  private lock(tx: DbOrTx, locationId: string, date: string) {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chefcap:${locationId}:${date}`}))`);
  }

  /** Throws a customer-facing error when the cart can't be made for that date. */
  private explain(ctx: Ctx, day: ChefAvailabilityDay, rules: DishRule[], qty: Map<string, number>, usage: Map<string, Usage>): never | void {
    if (day.status === 'AVAILABLE') return;
    const rs = rules.length ? rules : [this.defaultsRule(ctx)];
    const strict = rs.reduce((a, r) => (this.deadline(ctx, day.date, r) < this.deadline(ctx, day.date, a) ? r : a), rs[0]);
    switch (day.status) {
      case 'CUTOFF_PASSED':
        throw new BadRequestException({ message: `Ordering for that day has closed. ${chefNoticeText(strict.minLeadDays, strict.cutoffHour)}.`, code: 'CHEF_CUTOFF_PASSED', orderBy: day.orderBy });
      case 'TOO_FAR':
        throw new BadRequestException({ message: `That date is too far ahead; orders open ${Math.min(ctx.cap, ...rs.map((r) => r.maxAdvanceDays))} days in advance.`, code: 'CHEF_TOO_FAR' });
      case 'PAUSED':
        throw new BadRequestException({ message: 'The chef is away on that date. Pick another day.', code: 'CHEF_PAUSED' });
      case 'CLOSED':
      case 'NOT_COOKING':
        throw new BadRequestException({ message: 'The chef isn’t cooking on that day. Pick another day.', code: 'CHEF_NOT_COOKING' });
      default: {
        const u = usage.get(day.date);
        const kitchenLeft = Math.max(0, this.kitchenCapacity(ctx, day.date) - (u?.total ?? 0));
        for (const r of rules) {
          if (r.soldOut) throw new BadRequestException({ message: `${r.name} is sold out`, code: 'SOLD_OUT' });
          const left = r.limit === null ? Infinity : Math.max(0, r.limit - (u?.items.get(r.menuItemId) ?? 0));
          if ((qty.get(r.menuItemId) ?? 0) > left) throw new BadRequestException({ message: left ? `Only ${left} ${r.name} left for that day` : `${r.name} is sold out for that day`, code: 'DISH_CAPACITY_FULL', menuItemId: r.menuItemId, remaining: left });
        }
        throw new BadRequestException({ message: kitchenLeft ? `The chef can make only ${kitchenLeft} more portion${kitchenLeft === 1 ? '' : 's'} that day` : 'The chef is fully booked that day', code: 'KITCHEN_CAPACITY_FULL', remaining: kitchenLeft });
      }
    }
  }

  /** Validates an order date and time for a chef kitchen cart (no hold). Returns the kitchen's service date. */
  async assertOrderable(locationId: string, scheduledFor: Date, lines: { menuItemId: string; quantity: number }[], holdKey?: string | null, tx: DbOrTx = this.db, excludeOrderId?: string | null) {
    const r = await this.evaluate(locationId, scheduledFor, lines, holdKey, tx, excludeOrderId);
    this.explain(r.ctx, r.day, r.rules, r.qty, r.usage);
    return r.date;
  }

  private async evaluate(locationId: string, scheduledFor: Date, lines: { menuItemId: string; quantity: number }[], holdKey: string | null | undefined, tx: DbOrTx, excludeOrderId?: string | null) {
    const [loc] = await tx.select({ timezone: locations.timezone }).from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    const lp = localParts(scheduledFor, loc.timezone);
    const ctx = await this.context(locationId, lp.ymd, lp.ymd, tx);
    const rules = await this.dishRules(ctx, lines.map((l) => l.menuItemId), tx);
    const qty = new Map<string, number>();
    for (const l of lines) qty.set(l.menuItemId, (qty.get(l.menuItemId) ?? 0) + l.quantity);
    const usage = await this.usage(locationId, lp.ymd, lp.ymd, holdKey, tx, excludeOrderId);
    const day = this.day(ctx, lp.ymd, rules, qty, usage);
    // the chosen time must be one of that day's times
    if (day.status === 'AVAILABLE' && !day.slots.includes(lp.hhmm) && !day.slots.some((s) => toMin(s) <= toMin(lp.hhmm) && toMin(lp.hhmm) < toMin(s) + SLOT_MINUTES)) {
      throw new BadRequestException({ message: `Pick a time between ${day.slots[0]} and ${day.slots[day.slots.length - 1]}`, code: 'CHEF_TIME_UNAVAILABLE', slots: day.slots });
    }
    return { date: lp.ymd, ctx, rules, qty, usage, day };
  }

  /**
   * Validates the cart for its date and holds the capacity until the quote expires. A new quote from the same
   * checkout session (holdKey) replaces that session's earlier hold, so re-pricing never double-counts.
   */
  async hold(input: { locationId: string; scheduledFor: Date; lines: { menuItemId: string; quantity: number }[]; quoteId: string; holdKey?: string | null; expiresAt: Date; excludeOrderId?: string | null }) {
    return this.db.transaction(async (tx) => {
      const lp = localParts(input.scheduledFor, (await tx.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, input.locationId)).limit(1))[0]?.tz || 'UTC');
      await this.lock(tx, input.locationId, lp.ymd);
      if (input.holdKey) await tx.update(kitchenCapacityLedger).set({ status: 'RELEASED' }).where(and(eq(kitchenCapacityLedger.locationId, input.locationId), eq(kitchenCapacityLedger.holdKey, input.holdKey), eq(kitchenCapacityLedger.status, 'HELD')));
      const r = await this.evaluate(input.locationId, input.scheduledFor, input.lines, null, tx, input.excludeOrderId);
      this.explain(r.ctx, r.day, r.rules, r.qty, r.usage);
      await tx.insert(kitchenCapacityLedger).values([...r.qty.entries()].map(([menuItemId, units]) => ({ locationId: input.locationId, menuItemId, serviceDate: r.date, units, status: 'HELD', holdKey: input.holdKey ?? null, quoteId: input.quoteId, expiresAt: input.expiresAt })));
      return { serviceDate: r.date, orderBy: r.day.orderBy, remaining: r.day.remaining === null ? null : r.day.remaining - [...r.qty.values()].reduce((a, n) => a + n, 0) };
    });
  }

  /**
   * Checkout: turns the quote's hold into confirmed capacity for the order (inside the checkout transaction). When
   * the hold was replaced or lapsed, capacity is checked again, so an over-sold date is refused before payment.
   */
  async confirm(tx: DbOrTx, input: { locationId: string; scheduledFor: Date; lines: { menuItemId: string; quantity: number }[]; quoteId: string; orderId: string }) {
    const [loc] = await tx.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, input.locationId)).limit(1);
    const date = localParts(input.scheduledFor, loc?.tz || 'UTC').ymd;
    await this.lock(tx, input.locationId, date);
    await tx.update(kitchenCapacityLedger).set({ status: 'RELEASED' }).where(and(eq(kitchenCapacityLedger.quoteId, input.quoteId), eq(kitchenCapacityLedger.status, 'HELD')));
    const ctx = await this.context(input.locationId, date, date, tx);
    const rules = await this.dishRules(ctx, input.lines.map((l) => l.menuItemId), tx);
    const qty = new Map<string, number>();
    for (const l of input.lines) qty.set(l.menuItemId, (qty.get(l.menuItemId) ?? 0) + l.quantity);
    const usage = await this.usage(input.locationId, date, date, null, tx);
    // the quote already passed the date rules; at checkout only capacity can have changed (and a cutoff passing
    // during the 10-minute quote is honoured, like a price quote)
    const u = usage.get(date);
    const kitchenLeft = this.kitchenCapacity(ctx, date) - (u?.total ?? 0);
    const need = [...qty.values()].reduce((a, n) => a + n, 0);
    for (const r of rules) {
      const left = r.limit === null ? Infinity : r.limit - (u?.items.get(r.menuItemId) ?? 0);
      if ((qty.get(r.menuItemId) ?? 0) > left) throw new ConflictException({ message: left > 0 ? `Only ${left} ${r.name} left for that day. Update your cart and try again.` : `${r.name} sold out for that day while you were checking out. Pick another day.`, code: 'DISH_CAPACITY_FULL', menuItemId: r.menuItemId });
    }
    if (need > kitchenLeft) throw new ConflictException({ message: 'The chef became fully booked for that day while you were checking out. Pick another day.', code: 'KITCHEN_CAPACITY_FULL' });
    await tx.insert(kitchenCapacityLedger).values([...qty.entries()].map(([menuItemId, units]) => ({ locationId: input.locationId, menuItemId, serviceDate: date, units, status: 'CONFIRMED', quoteId: input.quoteId, orderId: input.orderId })));
    return { serviceDate: date };
  }

  /** Housekeeping: mark lapsed holds released (they already stopped counting when they expired). */
  async releaseExpired() {
    const r = await this.db.update(kitchenCapacityLedger).set({ status: 'RELEASED' }).where(and(eq(kitchenCapacityLedger.status, 'HELD'), lt(kitchenCapacityLedger.expiresAt, new Date()))).returning({ id: kitchenCapacityLedger.id });
    return { released: r.length };
  }

  // ───── chef portal ─────

  private async myProfile(user: JwtPayload) {
    const [row] = await this.db.select({ p: chefProfiles }).from(chefProfiles).innerJoin(orgMemberships, and(eq(orgMemberships.organizationId, chefProfiles.organizationId), eq(orgMemberships.userId, user.sub))).limit(1);
    if (!row) throw new NotFoundException({ message: 'You are not an approved Gutad Bestie yet', code: 'NOT_A_CHEF' });
    if (!row.p.locationId) throw new ConflictException('No approved kitchen');
    return row.p as Profile & { locationId: string };
  }

  /** The chef's calendar: settings, pauses and per-date status with booked, held and per-dish units. */
  async chefCalendar(user: JwtPayload, from?: string, to?: string) {
    return this.calendarFor(await this.myProfile(user), from, to);
  }

  async adminCalendar(user: JwtPayload, chefProfileId: string, from?: string, to?: string) {
    assertCan(user, 'chefs.read');
    const [p] = await this.db.select().from(chefProfiles).where(eq(chefProfiles.id, chefProfileId)).limit(1);
    if (!p?.locationId) throw new NotFoundException('Chef not found');
    return this.calendarFor(p as Profile & { locationId: string }, from, to);
  }

  private async calendarFor(p: Profile & { locationId: string }, from?: string, to?: string) {
    const [loc] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, p.locationId)).limit(1);
    const today = localParts(new Date(), loc.tz).ymd;
    const start = isYmd(from) ? from : today;
    let end = isYmd(to) ? to : addDaysYmd(start, 41);
    if (end > addDaysYmd(start, MAX_RANGE_DAYS)) end = addDaysYmd(start, MAX_RANGE_DAYS);
    const ctx = await this.context(p.locationId, start, end);
    const usage = await this.usage(p.locationId, start, end, null);
    const dishes = await this.db.select({ menuItemId: chefDishes.menuItemId, name: chefDishes.dishName, limit: chefDishes.dailyCapacity, status: chefDishes.reviewStatus }).from(chefDishes).where(eq(chefDishes.chefProfileId, p.id));
    const names = new Map(dishes.map((d) => [d.menuItemId, d]));
    const days: ChefCalendarDay[] = [];
    const rule = this.defaultsRule(ctx);
    for (let d = start; d <= end; d = addDaysYmd(d, 1)) {
      const ov = ctx.overrides.get(d);
      const pause = this.pauseOn(ctx, d);
      const u = usage.get(d);
      const open = !pause && ov?.open !== false && this.isCookingDay(ctx, d);
      const orderBy = this.deadline(ctx, d, rule);
      const ids = new Set([...(u?.items.keys() ?? [])]);
      days.push({
        date: d,
        weekday: weekdayYmd(d),
        cookingDay: ctx.op.cookingDays.includes(weekdayYmd(d)),
        open,
        override: ov ? { open: ov.open, capacity: ov.capacity, note: ov.note } : null,
        pause: pause ? { id: pause.id, reason: pause.reason } : null,
        capacity: this.kitchenCapacity(ctx, d),
        booked: u?.booked ?? 0,
        held: u?.held ?? 0,
        orders: u?.orders.size ?? 0,
        closedForOrders: ctx.now >= orderBy,
        orderBy: open ? orderBy.toISOString() : null,
        dishes: [...ids].map((id) => ({ menuItemId: id, name: names.get(id)?.name ?? 'Dish', units: u?.items.get(id) ?? 0, limit: names.get(id)?.limit ?? null })),
      });
    }
    const pauses = await this.db.select().from(chefPauses).where(and(eq(chefPauses.chefProfileId, p.id), gte(chefPauses.endDate, today))).orderBy(asc(chefPauses.startDate));
    return {
      timezone: ctx.loc.timezone,
      today,
      maxAdvanceCap: ctx.cap,
      policy: await this.settings.getObject<ChefPolicy>('chefs.policy', DEFAULT_CHEF_POLICY),
      settings: ctx.op,
      pauses: pauses.map((x): ChefPause => ({ id: x.id, startDate: x.startDate, endDate: x.endDate, reason: x.reason })),
      dishLimits: dishes.filter((d) => d.status !== 'ARCHIVED').map((d) => ({ menuItemId: d.menuItemId, name: d.name, limit: d.limit })),
      days,
    };
  }

  /** Weekly settings: cooking days, pickup window, cutoff hour, notice, kitchen capacity and advance window. */
  async setOperating(user: JwtPayload, input: Partial<ChefOperatingSettings>) {
    const p = await this.myProfile(user);
    const cap = Number(await this.settings.get<number>('chefs.max_advance_days', 60)) || 60;
    const hours = await this.db.select().from(openingHours).where(eq(openingHours.locationId, p.locationId));
    const cur = chefOperating(p, hours);
    const next: ChefOperatingSettings = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ChefOperatingSettings;
    if (!next.cookingDays.length) throw new BadRequestException({ message: 'Choose at least one cooking day (use a pause for time away)', code: 'NO_COOKING_DAYS' });
    if (toMin(next.closes) - toMin(next.opens) < SLOT_MINUTES) throw new BadRequestException({ message: 'The pickup window must be at least 30 minutes', code: 'WINDOW_TOO_SHORT' });
    if (next.maxAdvanceDays > cap) throw new BadRequestException({ message: `Orders can open at most ${cap} days ahead`, code: 'ADVANCE_TOO_FAR', max: cap });
    if (input.lateRefundPct !== undefined) {
      const pol = await this.settings.getObject<ChefPolicy>('chefs.policy', DEFAULT_CHEF_POLICY);
      if (input.lateRefundPct < pol.lateRefundMinPct || input.lateRefundPct > pol.lateRefundMaxPct) throw new BadRequestException({ message: `Late-cancellation refunds must be between ${pol.lateRefundMinPct}% and ${pol.lateRefundMaxPct}%`, code: 'LATE_REFUND_OUT_OF_RANGE', min: pol.lateRefundMinPct, max: pol.lateRefundMaxPct });
    }
    if (next.maxAdvanceDays <= next.minLeadDays) throw new BadRequestException({ message: 'How far ahead customers can order must be longer than your notice period', code: 'ADVANCE_TOO_SHORT' });
    next.cookingDays = [...new Set(next.cookingDays)].sort();
    const operating = { ...((p.operating as object) || {}), ...next };
    await this.db.transaction(async (tx) => {
      await tx.update(chefProfiles).set({ operating }).where(eq(chefProfiles.id, p.id));
      // opening hours mirror the cooking days and pickup window (kitchen screens and the location page use them)
      await tx.delete(openingHours).where(eq(openingHours.locationId, p.locationId));
      await tx.insert(openingHours).values(next.cookingDays.map((dayOfWeek) => ({ locationId: p.locationId, dayOfWeek, opens: next.opens, closes: next.closes })));
      await tx.update(locations).set({ scheduleLeadMinutes: next.minLeadDays * 24 * 60 }).where(eq(locations.id, p.locationId));
    });
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.calendar.settings', entityType: 'chef_profile', entityId: p.id, before: cur, after: next });
    return this.chefCalendar(user);
  }

  /** Per-date override: open an extra day, close a cooking day, or change that day's capacity. Both null = remove. */
  async setDay(user: JwtPayload, date: string, input: { open?: boolean | null; capacity?: number | null; note?: string | null; acknowledgeOrders?: boolean }) {
    const p = await this.myProfile(user);
    if (!isYmd(date)) throw new BadRequestException('Use a YYYY-MM-DD date');
    const [loc] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, p.locationId)).limit(1);
    if (date < localParts(new Date(), loc.tz).ymd) throw new BadRequestException({ message: 'That date has passed', code: 'DATE_PASSED' });
    const usage = (await this.usage(p.locationId, date, date, null)).get(date);
    const booked = usage?.booked ?? 0;
    if (input.open === false && booked && !input.acknowledgeOrders) throw new ConflictException({ message: `You have ${usage?.orders.size} order(s) for ${date}. Closing the day stops new orders only; confirm to continue, then cook or cancel the existing ones.`, code: 'HAS_ORDERS', orders: usage?.orders.size, units: booked });
    if (input.capacity !== undefined && input.capacity !== null && input.capacity < booked) throw new BadRequestException({ message: `${booked} portions are already booked for ${date}; capacity can’t go below that`, code: 'CAPACITY_BELOW_BOOKED', booked });
    const [existing] = await this.db.select().from(chefCalendarDays).where(and(eq(chefCalendarDays.chefProfileId, p.id), eq(chefCalendarDays.date, date))).limit(1);
    const open = input.open !== undefined ? input.open : existing?.open ?? null;
    const capacity = input.capacity !== undefined ? input.capacity : existing?.capacity ?? null;
    const note = input.note !== undefined ? input.note : existing?.note ?? null;
    if (open === null && capacity === null && !note) {
      if (existing) await this.db.delete(chefCalendarDays).where(eq(chefCalendarDays.id, existing.id));
    } else if (existing) await this.db.update(chefCalendarDays).set({ open, capacity, note }).where(eq(chefCalendarDays.id, existing.id));
    else await this.db.insert(chefCalendarDays).values({ chefProfileId: p.id, date, open, capacity, note });
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.calendar.day', entityType: 'chef_profile', entityId: p.id, before: existing ? { open: existing.open, capacity: existing.capacity } : null, after: { date, open, capacity } });
    return this.chefCalendar(user, date, date).then((c) => c.days[0]);
  }

  /** Holiday pause over a date range. Existing orders in the range are reported (they still need cooking or a cancel). */
  async addPause(user: JwtPayload, input: { startDate: string; endDate: string; reason?: string | null; acknowledgeOrders?: boolean }) {
    const p = await this.myProfile(user);
    if (!isYmd(input.startDate) || !isYmd(input.endDate)) throw new BadRequestException('Use YYYY-MM-DD dates');
    if (input.endDate < input.startDate) throw new BadRequestException({ message: 'The pause must end on or after its start', code: 'BAD_RANGE' });
    if (input.endDate > addDaysYmd(input.startDate, 365)) throw new BadRequestException({ message: 'A pause can be at most a year', code: 'BAD_RANGE' });
    const [loc] = await this.db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, p.locationId)).limit(1);
    if (input.endDate < localParts(new Date(), loc.tz).ymd) throw new BadRequestException({ message: 'That range has passed', code: 'DATE_PASSED' });
    const usage = await this.usage(p.locationId, input.startDate, input.endDate, null);
    const orderIds = new Set<string>();
    for (const u of usage.values()) for (const o of u.orders) orderIds.add(o);
    if (orderIds.size && !input.acknowledgeOrders) throw new ConflictException({ message: `You have ${orderIds.size} order(s) in those dates. A pause stops new orders only; confirm to continue, then cook or cancel the existing ones.`, code: 'HAS_ORDERS', orders: orderIds.size });
    const [row] = await this.db.insert(chefPauses).values({ chefProfileId: p.id, startDate: input.startDate, endDate: input.endDate, reason: input.reason || null, createdById: user.sub }).returning();
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.calendar.pause', entityType: 'chef_pause', entityId: row.id, after: { startDate: row.startDate, endDate: row.endDate, reason: row.reason, existingOrders: orderIds.size } });
    return { id: row.id, startDate: row.startDate, endDate: row.endDate, reason: row.reason, existingOrders: orderIds.size };
  }

  async removePause(user: JwtPayload, id: string) {
    const p = await this.myProfile(user);
    const [row] = await this.db.delete(chefPauses).where(and(eq(chefPauses.id, id), eq(chefPauses.chefProfileId, p.id))).returning();
    if (!row) throw new NotFoundException();
    await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: 'chef.calendar.pause.remove', entityType: 'chef_pause', entityId: id, before: { startDate: row.startDate, endDate: row.endDate } });
    return { ok: true };
  }
}
