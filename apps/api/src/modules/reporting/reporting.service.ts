import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { deliveryJobs, incidents, locations, menuItems, orders, payouts, refunds, reservations, shiftSummaries, waitlistEntries, journalEntries, organizations, menuCategories, menus, kitchenTickets } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { localParts, zonedTimeToUtc, addMinutes } from '../../common/utils';

/** 29 — sales, conversion by channel, acceptance, waits, delivery reliability, covers, refunds, payouts, retention, profitability, exports. */
@Injectable()
export class ReportingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private range(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
    return { start, end };
  }

  async locationDashboard(user: JwtPayload, locationId: string, from?: string, to?: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const { start, end } = this.range(from, to);
    const inRange = and(eq(orders.locationId, locationId), gte(orders.createdAt, start), lt(orders.createdAt, end));
    const byChannel = await this.db.select({ channel: orders.channel, status: orders.status, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${orders.subtotalCents} - ${orders.discountCents}),0)::int`, commission: sql<number>`coalesce(sum(${orders.commissionCents}),0)::int` }).from(orders).where(inRange).groupBy(orders.channel, orders.status);
    const [acceptance] = await this.db.select({ submitted: sql<number>`count(*)::int`, accepted: sql<number>`count(*) filter (where ${orders.acceptedAt} is not null)::int`, rejected: sql<number>`count(*) filter (where ${orders.status} = 'REJECTED')::int`, avgAcceptSec: sql<number>`coalesce(avg(extract(epoch from (${orders.acceptedAt} - ${orders.createdAt}))),0)::int`, avgPrepMin: sql<number>`coalesce(avg(extract(epoch from (${orders.readyAt} - ${orders.acceptedAt}))/60),0)::int`, lateReady: sql<number>`count(*) filter (where ${orders.readyAt} > ${orders.promiseAt})::int` }).from(orders).where(inRange);
    const [delivery] = await this.db.select({ jobs: sql<number>`count(*)::int`, delivered: sql<number>`count(*) filter (where ${deliveryJobs.status} = 'DELIVERED')::int`, failed: sql<number>`count(*) filter (where ${deliveryJobs.status} in ('FAILED','CANCELED','RETURNED'))::int`, onTime: sql<number>`count(*) filter (where ${deliveryJobs.deliveredAt} <= ${deliveryJobs.etaAt})::int`, avgMin: sql<number>`coalesce(avg(extract(epoch from (${deliveryJobs.deliveredAt} - ${deliveryJobs.createdAt}))/60),0)::int`, providerCost: sql<number>`coalesce(sum(${deliveryJobs.providerCostCents}),0)::int`, retail: sql<number>`coalesce(sum(${deliveryJobs.retailFeeCents}),0)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.locationId, locationId), gte(deliveryJobs.createdAt, start), lt(deliveryJobs.createdAt, end)));
    const [resv] = await this.db.select({ bookings: sql<number>`count(*)::int`, seated: sql<number>`count(*) filter (where ${reservations.status} = 'COMPLETED')::int`, noShows: sql<number>`count(*) filter (where ${reservations.status} = 'NO_SHOW')::int`, canceled: sql<number>`count(*) filter (where ${reservations.status} = 'CANCELED')::int`, billableCovers: sql<number>`coalesce(sum(${reservations.billableCovers}),0)::int`, coverFees: sql<number>`coalesce(sum(${reservations.coverFeeCents}),0)::int`, avgWaitMin: sql<number>`coalesce(avg(extract(epoch from (${reservations.seatedAt} - ${reservations.arrivedAt}))/60),0)::int` }).from(reservations).where(and(eq(reservations.locationId, locationId), gte(reservations.createdAt, start), lt(reservations.createdAt, end)));
    const resvByChannel = await this.db.select({ channel: reservations.channel, n: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(${reservations.billableCovers}),0)::int` }).from(reservations).where(and(eq(reservations.locationId, locationId), gte(reservations.createdAt, start), lt(reservations.createdAt, end))).groupBy(reservations.channel);
    const [wl] = await this.db.select({ joined: sql<number>`count(*)::int`, seated: sql<number>`count(*) filter (where ${waitlistEntries.status} = 'SEATED')::int`, abandoned: sql<number>`count(*) filter (where ${waitlistEntries.status} in ('LEFT','EXPIRED'))::int`, avgQuoted: sql<number>`coalesce(avg(${waitlistEntries.quotedMinutes}),0)::int` }).from(waitlistEntries).where(and(eq(waitlistEntries.locationId, locationId), gte(waitlistEntries.createdAt, start), lt(waitlistEntries.createdAt, end)));
    const [rf] = await this.db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${refunds.amountCents}),0)::int`, merchantFunded: sql<number>`coalesce(sum(${refunds.amountCents}) filter (where ${refunds.funder} = 'MERCHANT'),0)::int` }).from(refunds).innerJoin(orders, eq(orders.id, refunds.orderId)).where(inRange);
    const topItems = await this.db.select({ name: orders.number }).from(orders).where(inRange).limit(0);
    void topItems;
    const items = await this.db.execute(sql`select ol.name, sum(ol.quantity)::int as qty, sum(ol.line_total_cents)::int as cents from order_lines ol join orders o on o.id = ol.order_id where o.location_id = ${locationId} and o.created_at >= ${start} and o.created_at < ${end} and o.status in ('COMPLETED','COLLECTED','READY','ACCEPTED','PREPARING') group by ol.name order by qty desc limit 10`);
    const [inc] = await this.db.select({ open: sql<number>`count(*) filter (where ${incidents.status} in ('OPEN','INVESTIGATING','APPEALED'))::int`, total: sql<number>`count(*)::int`, avgResolveHrs: sql<number>`coalesce(avg(extract(epoch from (${incidents.resolvedAt} - ${incidents.createdAt}))/3600),0)::int` }).from(incidents).innerJoin(orders, eq(orders.id, incidents.orderId)).where(inRange);
    const gross = byChannel.filter((r) => ['COMPLETED', 'COLLECTED', 'READY', 'ACCEPTED', 'PREPARING'].includes(r.status)).reduce((a, r) => a + r.cents, 0);
    const commission = byChannel.reduce((a, r) => a + r.commission, 0);
    return {
      period: { start, end },
      sales: { grossCents: gross, orders: byChannel.reduce((a, r) => a + r.n, 0), commissionCents: commission, byChannel: this.rollup(byChannel) },
      acceptance,
      delivery: { ...delivery, onTimeRate: delivery.delivered ? delivery.onTime / delivery.delivered : null, subsidyCents: Math.max(0, delivery.providerCost - delivery.retail) },
      reservations: { ...resv, byChannel: resvByChannel },
      waitlist: wl,
      refunds: rf,
      incidents: inc,
      topItems: items.rows,
      marginHint: { contributionCents: gross - commission - rf.merchantFunded },
    };
  }

  private rollup(rows: { channel: string; status: string; n: number; cents: number; commission: number }[]) {
    const m = new Map<string, { channel: string; orders: number; completed: number; canceled: number; cents: number; commission: number }>();
    for (const r of rows) {
      const cur = m.get(r.channel) || { channel: r.channel, orders: 0, completed: 0, canceled: 0, cents: 0, commission: 0 };
      cur.orders += r.n;
      if (['COMPLETED', 'COLLECTED'].includes(r.status)) cur.completed += r.n;
      if (['CANCELED', 'REJECTED'].includes(r.status)) cur.canceled += r.n;
      cur.cents += r.cents;
      cur.commission += r.commission;
      m.set(r.channel, cur);
    }
    return Array.from(m.values()).map((c) => ({ ...c, conversion: c.orders ? c.completed / c.orders : 0 }));
  }

  /** Platform-wide control panel for finance/ops. */
  async platformDashboard(user: JwtPayload, from?: string, to?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const { start, end } = this.range(from, to);
    const rev = await this.db.select({ account: journalEntries.account, credits: sql<number>`coalesce(sum(${journalEntries.creditCents}),0)::int`, debits: sql<number>`coalesce(sum(${journalEntries.debitCents}),0)::int` }).from(journalEntries).where(and(gte(journalEntries.createdAt, start), lt(journalEntries.createdAt, end), sql`${journalEntries.account}::text like 'PLATFORM_%'`)).groupBy(journalEntries.account);
    const revenue = rev.filter((r) => r.account.startsWith('PLATFORM_REVENUE')).reduce((a, r) => a + r.credits - r.debits, 0);
    const expense = rev.filter((r) => r.account.startsWith('PLATFORM_EXPENSE')).reduce((a, r) => a + r.debits - r.credits, 0);
    const [ord] = await this.db.select({ n: sql<number>`count(*)::int`, gmv: sql<number>`coalesce(sum(${orders.totalCents}),0)::int` }).from(orders).where(and(gte(orders.createdAt, start), lt(orders.createdAt, end), sql`${orders.status} not in ('REJECTED','CANCELED')`));
    const [merchants] = await this.db.select({ live: sql<number>`count(*) filter (where ${locations.status} = 'LIVE')::int`, paused: sql<number>`count(*) filter (where ${locations.isPaused})::int`, churned: sql<number>`count(*) filter (where ${locations.status} = 'OFFBOARDED' and ${locations.updatedAt} >= ${start})::int`, onboarding: sql<number>`count(*) filter (where ${locations.status} in ('CLAIMED','VERIFIED','ONBOARDING'))::int` }).from(locations);
    const [po] = await this.db.select({ paid: sql<number>`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} in ('PAID','RECONCILED')),0)::int`, pending: sql<number>`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} in ('ELIGIBLE','SUBMITTED')),0)::int`, failed: sql<number>`count(*) filter (where ${payouts.status} in ('FAILED','HELD'))::int` }).from(payouts).where(gte(payouts.createdAt, start));
    const [inc] = await this.db.select({ open: sql<number>`count(*) filter (where ${incidents.status} in ('OPEN','INVESTIGATING','APPEALED'))::int`, avgHrs: sql<number>`coalesce(avg(extract(epoch from (${incidents.resolvedAt} - ${incidents.createdAt}))/3600),0)::int` }).from(incidents).where(gte(incidents.createdAt, start));
    const [dl] = await this.db.select({ jobs: sql<number>`count(*)::int`, failed: sql<number>`count(*) filter (where ${deliveryJobs.status} in ('FAILED','RETURNED'))::int`, late: sql<number>`count(*) filter (where ${deliveryJobs.deliveredAt} > ${deliveryJobs.etaAt})::int` }).from(deliveryJobs).where(gte(deliveryJobs.createdAt, start));
    return { period: { start, end }, orders: ord, revenueCents: revenue, expenseCents: expense, contributionCents: revenue - expense, byAccount: rev, merchants, payouts: po, incidents: inc, delivery: dl };
  }

  // ───── shift open / close ─────

  /** Open-shift checklist: only fulfillable offers should be published. */
  async openShift(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const soldOut = await this.db.select({ id: menuItems.id, name: menuItems.name, soldOutUntil: menuItems.soldOutUntil }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).where(and(eq(menus.locationId, locationId), eq(menuItems.soldOut, true)));
    const today = localParts(new Date(), loc.timezone).ymd;
    const dayStart = zonedTimeToUtc(today, '00:00', loc.timezone);
    const scheduled = await this.db.select({ id: orders.id, number: orders.number, scheduledFor: orders.scheduledFor, status: orders.status }).from(orders).where(and(eq(orders.locationId, locationId), gte(orders.scheduledFor, dayStart), lt(orders.scheduledFor, addMinutes(dayStart, 1440))));
    const bookings = await this.db.select({ n: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(${reservations.partySize}),0)::int` }).from(reservations).where(and(eq(reservations.locationId, locationId), gte(reservations.startAt, dayStart), lt(reservations.startAt, addMinutes(dayStart, 1440)), inArray(reservations.status, ['CONFIRMED', 'HELD'])));
    const waiting = await this.db.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(eq(waitlistEntries.locationId, locationId), inArray(waitlistEntries.status, ['WAITING', 'NOTIFIED'])));
    const openIncidents = await this.db.select({ n: sql<number>`count(*)::int` }).from(incidents).innerJoin(orders, eq(orders.id, incidents.orderId)).where(and(eq(orders.locationId, locationId), inArray(incidents.status, ['OPEN', 'INVESTIGATING'])));
    const [lastClose] = await this.db.select().from(shiftSummaries).where(eq(shiftSummaries.locationId, locationId)).orderBy(sql`${shiftSummaries.date} desc`).limit(1);
    return { location: { id: loc.id, name: loc.name, isPaused: loc.isPaused, pausedReason: loc.pausedReason, throttle: loc.orderThrottlePer15m, acceptsDelivery: loc.acceptsDelivery, fleet: loc.deliveryFleet }, soldOut, scheduledOrders: scheduled, bookingsToday: bookings[0], waitlist: waiting[0], openIncidents: openIncidents[0], carriedForward: lastClose?.carriedForward || [], checklist: ['Review sold-outs', 'Confirm capacity/throttle', 'Check table blocks', 'Confirm courier coverage', 'Review cutoffs and scheduled orders', 'Clear waitlist'] };
  }

  /** Shift close: signed summary; unresolved items are explicitly carried forward. */
  async closeShift(user: JwtPayload, locationId: string, input: { cashCents?: number; wasteNotes?: string; carryForward?: string[] }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const today = localParts(new Date(), loc.timezone).ymd;
    const dayStart = zonedTimeToUtc(today, '00:00', loc.timezone);
    const dayEnd = addMinutes(dayStart, 1440);
    const [o] = await this.db.select({ completed: sql<number>`count(*) filter (where ${orders.status} in ('COMPLETED','COLLECTED'))::int`, canceled: sql<number>`count(*) filter (where ${orders.status} in ('CANCELED','REJECTED'))::int`, open: sql<number>`count(*) filter (where ${orders.status} in ('SUBMITTED','ACCEPTED','PREPARING','READY'))::int` }).from(orders).where(and(eq(orders.locationId, locationId), gte(orders.createdAt, dayStart), lt(orders.createdAt, dayEnd)));
    const [r] = await this.db.select({ covers: sql<number>`coalesce(sum(${reservations.actualPartySize}) filter (where ${reservations.status} = 'COMPLETED'),0)::int`, noShows: sql<number>`count(*) filter (where ${reservations.status} = 'NO_SHOW')::int`, openChecks: sql<number>`count(*) filter (where ${reservations.status} = 'SEATED')::int` }).from(reservations).where(and(eq(reservations.locationId, locationId), gte(reservations.startAt, dayStart), lt(reservations.startAt, dayEnd)));
    const unresolved = await this.db.select({ id: incidents.id }).from(incidents).innerJoin(orders, eq(orders.id, incidents.orderId)).where(and(eq(orders.locationId, locationId), inArray(incidents.status, ['OPEN', 'INVESTIGATING'])));
    const pendingDeliveries = await this.db.select({ id: deliveryJobs.id, status: deliveryJobs.status }).from(deliveryJobs).where(and(eq(deliveryJobs.locationId, locationId), inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'PICKED_UP', 'UNASSIGNED'])));
    const carried = [...(input.carryForward || []), ...(o.open ? [`${o.open} open orders`] : []), ...(r.openChecks ? [`${r.openChecks} open checks`] : []), ...pendingDeliveries.map((d) => `Delivery ${d.id} ${d.status}`), ...unresolved.map((i) => `Incident ${i.id}`)];
    const [s] = await this.db.insert(shiftSummaries).values({ locationId, date: dayStart, closedById: user.sub, ordersCompleted: o.completed, ordersCanceled: o.canceled, coversSeated: r.covers, noShows: r.noShows, openChecks: r.openChecks, cashCents: input.cashCents || 0, wasteNotes: input.wasteNotes ?? null, unresolvedIncidentIds: unresolved.map((i) => i.id), carriedForward: carried, signedAt: new Date() }).returning();
    return s;
  }

  // ───── exports ─────

  async exportOrdersCsv(user: JwtPayload, locationId: string, from?: string, to?: string): Promise<string> {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const { start, end } = this.range(from, to);
    const rows = await this.db.select().from(orders).where(and(eq(orders.locationId, locationId), gte(orders.createdAt, start), lt(orders.createdAt, end))).orderBy(orders.createdAt);
    const header = ['number', 'created_at', 'channel', 'fulfillment', 'status', 'subtotal_cents', 'discount_cents', 'tax_cents', 'service_fee_cents', 'delivery_fee_cents', 'tip_cents', 'total_cents', 'commission_cents', 'promo_code'];
    const esc = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [header.join(','), ...rows.map((o) => [o.number, o.createdAt.toISOString(), o.channel, o.fulfillmentType, o.status, o.subtotalCents, o.discountCents, o.taxCents, o.serviceFeeCents, o.deliveryFeeCents, o.tipCents, o.totalCents, o.commissionCents, o.promoCode].map(esc).join(','))].join('\n');
  }

  async merchantRetention(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select({ status: organizations.status, n: sql<number>`count(*)::int` }).from(organizations).where(eq(organizations.kind, 'MERCHANT')).groupBy(organizations.status);
  }

  async kitchenThroughput(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    return this.db.select({ station: kitchenTickets.stationCode, tickets: sql<number>`count(*)::int`, avgMin: sql<number>`coalesce(avg(extract(epoch from (${kitchenTickets.doneAt} - ${kitchenTickets.startedAt}))/60),0)::int`, queued: sql<number>`count(*) filter (where ${kitchenTickets.status} = 'QUEUED')::int` }).from(kitchenTickets).innerJoin(orders, eq(orders.id, kitchenTickets.orderId)).where(and(eq(orders.locationId, locationId), gte(kitchenTickets.createdAt, new Date(Date.now() - 7 * 86_400_000)), isNull(kitchenTickets.printedAt))).groupBy(kitchenTickets.stationCode);
  }
}
