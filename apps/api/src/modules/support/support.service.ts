import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { dataRequests, deliveryJobs, incidents, orders, payments, policyStrikes, reservations, users, orderLines, addresses, loyaltyEntries, reviews, guestProfiles, orgMemberships, opsAlerts, customerRestrictions, paymentMethods } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrdersService } from '../orders/orders.service';
import { ApprovalsService } from '../security/approvals.service';
import { SettingsService } from '../../core/settings.service';
import { LedgerService } from '../../core/ledger.service';
import { DEFAULT_GOODWILL, DEFAULT_SUPPORT_SLA, SUPPORT_CATEGORIES, type SupportCategory } from '@gutad/shared';

type ResolveInput = { owner: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER' | 'CUSTOMER'; remedy: 'REFUND' | 'CREDIT' | 'REMAKE' | 'REDELIVERY' | 'REASSIGN' | 'NONE'; remedyCents?: number; note?: string; evidence?: unknown[] };
type Category = SupportCategory;

/** 28 — incident queues, order/booking timeline, role-based remedies with evidence, chargebacks, appeals, data requests. */
@Injectable()
export class SupportService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly outbox: OutboxService, private readonly payments: PaymentsService, private readonly delivery: DeliveryService, private readonly orders: OrdersService, private readonly approvals: ApprovalsService, private readonly settings: SettingsService, private readonly ledger: LedgerService) {}

  onModuleInit() {
    this.approvals.register('REFUND', {
      execute: (req, approver) => {
        const p = req.payload as { incidentId: string; input: ResolveInput };
        return this.applyRemedy(approver, p.incidentId, p.input, req.requestedById);
      },
      // the merchant owner may approve a merchant-funded refund raised by their own staff
      canDecide: (user, req) => !!req.organizationId && !!user.orgs?.[req.organizationId]?.roles.includes('MERCHANT_OWNER') && (req.payload as { input: ResolveInput }).input.owner === 'MERCHANT',
    });
  }

  async open(user: JwtPayload, input: { orderId?: string; reservationId?: string; deliveryJobId?: string; paymentId?: string; menuItemId?: string; category: Category; description: string; evidence?: unknown[] }) {
    if (input.orderId) {
      const [o] = await this.db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!o) throw new NotFoundException('Order not found');
      if (o.userId !== user.sub) assertOrgAccess(user, o.organizationId, o.locationId);
    }
    const meta = SUPPORT_CATEGORIES[input.category] || SUPPORT_CATEGORIES.OTHER;
    const [ord] = input.orderId ? await this.db.select({ organizationId: orders.organizationId, userId: orders.userId, locationId: orders.locationId }).from(orders).where(eq(orders.id, input.orderId)).limit(1) : [null];
    const [pay] = input.orderId ? await this.db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, input.orderId), eq(payments.purpose, 'ORDER'))).limit(1) : [null];
    const reporterType = ord && ord.userId === user.sub ? 'CUSTOMER' : ord && user.orgs?.[ord.organizationId] ? 'MERCHANT' : isPlatformStaff(user) ? 'STAFF' : user.roles.includes('DRIVER') ? 'DRIVER' : 'CUSTOMER';
    const sla = (await this.settings.getObject('support.sla', DEFAULT_SUPPORT_SLA))[meta.priority];
    const now = Date.now();
    const [i] = await this.db.insert(incidents).values({ orderId: input.orderId ?? null, reservationId: input.reservationId ?? null, deliveryJobId: input.deliveryJobId ?? null, organizationId: ord?.organizationId ?? null, paymentId: input.paymentId ?? pay?.id ?? null, menuItemId: input.menuItemId ?? null, reporterId: user.sub, reporterType, category: input.category, description: input.description, evidence: input.evidence || [], owner: meta.owner, priority: meta.priority, queue: meta.queue, firstResponseDueAt: new Date(now + sla.firstResponseMinutes * 60_000), resolveDueAt: new Date(now + sla.resolveHours * 3600_000) }).returning();
    if (input.category === 'FOOD_SAFETY') {
      // food-quality or illness reports go straight to the food-safety owner as a critical alert
      await this.db.insert(opsAlerts).values({ type: 'FOOD_SAFETY', severity: 'CRITICAL', title: `Food safety report${ord ? ' on an order' : ''}`, detail: input.description.slice(0, 300), subjectType: 'incident', subjectId: i.id, organizationId: ord?.organizationId ?? null, locationId: ord?.locationId ?? null, dedupeKey: `food-safety:${i.id}`, ownerRole: 'CULINARY', escalateAt: new Date(now + 15 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'Customer food-safety report' }] }).onConflictDoNothing();
    }
    return i;
  }

  async queue(user: JwtPayload, filter?: { status?: string; owner?: string; organizationId?: string; priority?: string; queue?: string; mine?: boolean; breached?: boolean; reporterType?: string }) {
    const conds = [];
    if (filter?.status) conds.push(eq(incidents.status, filter.status as never));
    if (filter?.owner) conds.push(eq(incidents.owner, filter.owner));
    if (filter?.priority) conds.push(eq(incidents.priority, filter.priority));
    if (filter?.queue) conds.push(eq(incidents.queue, filter.queue));
    if (filter?.reporterType) conds.push(eq(incidents.reporterType, filter.reporterType));
    if (filter?.mine) conds.push(eq(incidents.assigneeId, user.sub));
    if (filter?.breached) conds.push(sql`${incidents.slaBreachedAt} is not null`);
    if (!isPlatformStaff(user)) {
      const orgIds = Object.keys(user.orgs || {});
      if (!orgIds.length) return this.db.select().from(incidents).where(eq(incidents.reporterId, user.sub)).orderBy(desc(incidents.createdAt));
      conds.push(sql`(${incidents.organizationId} = any(${'{' + orgIds.join(',') + '}'}::uuid[]) or ${incidents.orderId} in (select id from orders where organization_id = any(${'{' + orgIds.join(',') + '}'}::uuid[])))`);
    }
    return this.db.select().from(incidents).where(conds.length ? and(...conds) : undefined).orderBy(sql`case ${incidents.priority} when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end`, sql`coalesce(${incidents.firstRespondedAt}, ${incidents.firstResponseDueAt}) asc nulls last`, desc(incidents.createdAt)).limit(300);
  }

  /** Take or hand over a ticket; change priority or queue (SLA due times follow the priority). */
  async assign(user: JwtPayload, incidentId: string, input: { assigneeId?: string | null; queue?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' }) {
    assertCan(user, 'support.manage', 'support.read');
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    const set: Partial<typeof incidents.$inferInsert> = {};
    if (input.assigneeId !== undefined) set.assigneeId = input.assigneeId;
    if (input.queue) set.queue = input.queue;
    if (input.priority && input.priority !== i.priority) {
      const sla = (await this.settings.getObject('support.sla', DEFAULT_SUPPORT_SLA))[input.priority];
      set.priority = input.priority;
      set.firstResponseDueAt = i.firstRespondedAt ? i.firstResponseDueAt : new Date(i.createdAt.getTime() + sla.firstResponseMinutes * 60_000);
      set.resolveDueAt = new Date(i.createdAt.getTime() + sla.resolveHours * 3600_000);
    }
    if (i.status === 'OPEN' && input.assigneeId) set.status = 'INVESTIGATING';
    const [u] = await this.db.update(incidents).set(set).where(eq(incidents.id, incidentId)).returning();
    await this.audit.log({ actorId: user.sub, action: 'incident.assign', entityType: 'incident', entityId: incidentId, before: { assigneeId: i.assigneeId, queue: i.queue, priority: i.priority }, after: set });
    return u;
  }

  /** Worker: tickets past their first-response or resolution target are marked breached, bumped and alerted. */
  async slaSweep() {
    const due = await this.db.select().from(incidents).where(and(inArray(incidents.status, ['OPEN', 'INVESTIGATING', 'APPEALED']), sql`${incidents.slaBreachedAt} is null`, sql`((${incidents.firstRespondedAt} is null and ${incidents.firstResponseDueAt} < now()) or ${incidents.resolveDueAt} < now())`)).limit(200);
    for (const i of due) {
      const bumped = i.priority === 'LOW' ? 'NORMAL' : i.priority === 'NORMAL' ? 'HIGH' : 'URGENT';
      await this.db.update(incidents).set({ slaBreachedAt: new Date(), priority: bumped }).where(eq(incidents.id, i.id));
      await this.db.insert(opsAlerts).values({ type: 'SLA_BREACH', severity: bumped === 'URGENT' ? 'HIGH' : 'MEDIUM', title: `Support ticket past its ${i.firstRespondedAt ? 'resolution' : 'first-response'} target`, detail: `${i.category.toLowerCase().replace(/_/g, ' ')}: ${i.description.slice(0, 160)}`, subjectType: 'incident', subjectId: i.id, organizationId: i.organizationId, dedupeKey: `sla:${i.id}`, ownerRole: 'SUPPORT', escalateAt: new Date(Date.now() + 30 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'SLA breached' }] }).onConflictDoNothing();
    }
    return { breached: due.length };
  }

  /** Goodwill given to a customer in the last 90 days (resolved tickets with money, across all orders). */
  async goodwill(userId: string) {
    const [g] = await this.db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${incidents.remedyCents}),0)::int` }).from(incidents).innerJoin(orders, eq(orders.id, incidents.orderId)).where(and(eq(orders.userId, userId), inArray(incidents.status, ['RESOLVED', 'CLOSED']), sql`${incidents.remedyCents} > 0`, sql`${incidents.resolvedAt} > now() - interval '90 days'`));
    const cap = await this.settings.getObject('support.goodwill', DEFAULT_GOODWILL);
    return { count90d: g.n, cents90d: g.cents, ...cap, overCount: g.n >= cap.maxCount90d, overCents: g.cents >= cap.maxCents90d };
  }

  /** What a remedy would do before an agent applies it: money left, prior compensation, goodwill used, approval needed and why. */
  async remedyPreview(user: JwtPayload, incidentId: string, remedy: string, cents: number) {
    assertCan(user, 'support.read');
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    const [o] = i.orderId ? await this.db.select().from(orders).where(eq(orders.id, i.orderId)).limit(1) : [null];
    const [p] = o ? await this.db.select().from(payments).where(and(eq(payments.orderId, o.id), eq(payments.purpose, 'ORDER'))).limit(1) : [null];
    const prior = o ? await this.db.select({ id: incidents.id, remedy: incidents.remedy, cents: incidents.remedyCents, category: incidents.category, resolvedAt: incidents.resolvedAt }).from(incidents).where(and(eq(incidents.orderId, o.id), inArray(incidents.status, ['RESOLVED', 'CLOSED']), sql`${incidents.remedyCents} > 0`)) : [];
    const gw = o?.userId ? await this.goodwill(o.userId) : null;
    const restrictions = o?.userId ? await this.db.select().from(customerRestrictions).where(and(eq(customerRestrictions.userId, o.userId), sql`${customerRestrictions.liftedAt} is null`, sql`(${customerRestrictions.expiresAt} is null or ${customerRestrictions.expiresAt} > now())`)) : [];
    const limit = isPlatformStaff(user) ? await this.approvals.staffRefundLimit(user) : 0;
    const reasons: string[] = [];
    const money = cents > 0 && (remedy === 'REFUND' || remedy === 'CREDIT');
    if (money && cents > limit) reasons.push(`over your ${(limit / 100).toFixed(2)} limit`);
    if (money && prior.length) reasons.push('this order was already compensated');
    if (money && gw && (gw.overCount || gw.overCents || gw.cents90d + cents > gw.maxCents90d)) reasons.push(`customer goodwill in 90 days: ${gw.count90d} times, $${(gw.cents90d / 100).toFixed(2)}`);
    if (money && restrictions.some((r) => r.kind === 'REFUND_REVIEW')) reasons.push('customer refunds are under review');
    const refundable = p ? p.capturedCents - p.refundedCents : 0;
    return { refundableCents: refundable, refundFits: remedy !== 'REFUND' || cents <= refundable, orderTotalCents: o?.totalCents ?? null, priorCompensation: prior, goodwill: gw, restrictions: restrictions.map((r) => r.kind), needsApproval: reasons.length > 0, reasons, willIssue: remedy === 'REFUND' && cents > refundable ? 'CREDIT (refund exceeds what is left on the card)' : remedy };
  }

  // ───── 24.6 responsibility review ─────

  /** A merchant or courier disputes being held responsible for a resolved ticket. */
  async disputeResponsibility(user: JwtPayload, incidentId: string, reason: string) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    let role: string | null = null;
    if (i.owner === 'MERCHANT' && i.organizationId && user.orgs?.[i.organizationId]) role = 'MERCHANT';
    if (i.owner === 'DRIVER' && i.deliveryJobId) {
      const [j] = await this.db.execute(sql`select dj.id from delivery_jobs dj join drivers d on d.id = dj.driver_id where dj.id = ${i.deliveryJobId} and d.user_id = ${user.sub}`).then((r) => (r as unknown as { rows: unknown[] }).rows);
      if (j) role = 'DRIVER';
    }
    if (!role) throw new ForbiddenException('Only the party held responsible can dispute it');
    if (!['RESOLVED', 'CLOSED'].includes(i.status)) throw new BadRequestException('Only resolved tickets can be disputed');
    if ((i.responsibilityDispute as { status?: string } | null)?.status === 'OPEN') throw new BadRequestException('Already disputed');
    const dispute = { by: user.sub, role, reason, at: new Date().toISOString(), status: 'OPEN' };
    const [u] = await this.db.update(incidents).set({ responsibilityDispute: dispute, status: 'APPEALED', appealNote: reason }).where(eq(incidents.id, incidentId)).returning();
    await this.audit.log({ organizationId: i.organizationId, actorId: user.sub, action: 'incident.responsibility_dispute', entityType: 'incident', entityId: incidentId, after: dispute });
    return u;
  }

  /** Staff decide: uphold, or reverse to the platform (a merchant-funded refund or credit is re-credited to the merchant). */
  async decideResponsibility(user: JwtPayload, incidentId: string, reverse: boolean, note: string) {
    assertCan(user, 'support.manage');
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    const d = i.responsibilityDispute as { status?: string; role?: string } | null;
    if (!d || d.status !== 'OPEN') throw new BadRequestException('No open dispute');
    await this.db.transaction(async (tx) => {
      if (reverse && i.owner === 'MERCHANT' && i.remedyCents > 0 && i.organizationId && (i.remedy === 'REFUND' || i.remedy === 'CREDIT')) {
        const [o] = i.orderId ? await tx.select({ locationId: orders.locationId }).from(orders).where(eq(orders.id, i.orderId)).limit(1) : [null];
        await this.ledger.post({ orderId: i.orderId ?? undefined, currency: 'USD' }, [
          { account: 'PLATFORM_EXPENSE_REFUND', debitCents: i.remedyCents, organizationId: i.organizationId, memo: `Responsibility reversed on ticket ${i.id.slice(0, 8)}` },
          { account: 'MERCHANT_PAYABLE', creditCents: i.remedyCents, partyId: i.organizationId, organizationId: i.organizationId, locationId: o?.locationId ?? undefined, memo: 'Re-credit: platform takes responsibility' },
        ], tx);
      }
      await tx.update(incidents).set({ responsibilityDispute: { ...d, status: reverse ? 'REVERSED' : 'UPHELD', decidedById: user.sub, note, decidedAt: new Date().toISOString() }, owner: reverse ? 'PLATFORM' : i.owner, status: 'RESOLVED' }).where(eq(incidents.id, incidentId));
    });
    await this.audit.log({ organizationId: i.organizationId, actorId: user.sub, action: reverse ? 'incident.responsibility_reversed' : 'incident.responsibility_upheld', entityType: 'incident', entityId: incidentId, reason: note });
    return (await this.db.select().from(incidents).where(eq(incidents.id, incidentId)))[0];
  }

  // ───── 24.8 root causes ─────

  async rootCauses(user: JwtPayload, q: { from?: string; to?: string; dim?: string }) {
    assertCan(user, 'support.read', 'ops.read');
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 5 * 60_000);
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400_000);
    const dim = ['category', 'dish', 'merchant', 'location', 'kitchen', 'zone', 'owner'].includes(q.dim || '') ? q.dim! : 'category';
    const key = { category: sql`i.category`, owner: sql`coalesce(i.owner, 'UNASSIGNED')`, dish: sql`coalesce(mi.name, '(dish not specified)')`, merchant: sql`coalesce(org.name, '(no merchant)')`, location: sql`coalesce(l.name, '(no location)')`, kitchen: sql`coalesce(k.name, '(own kitchen)')`, zone: sql`coalesce(l.name || ' · ' || (dj.dropoff_address->>'postalCode'), '(not delivery)')` }[dim]!;
    const r = await this.db.execute(sql`
      select ${key} as key, count(*)::int as tickets, coalesce(sum(i.remedy_cents),0)::int as cost_cents, count(*) filter (where i.sla_breached_at is not null)::int as breached,
        avg(extract(epoch from i.resolved_at - i.created_at)) filter (where i.resolved_at is not null) as resolve_secs
      from incidents i left join orders o on o.id = i.order_id left join locations l on l.id = o.location_id left join kitchens k on k.id = l.kitchen_id
        left join organizations org on org.id = coalesce(i.organization_id, o.organization_id) left join menu_items mi on mi.id = i.menu_item_id left join delivery_jobs dj on dj.id = coalesce(i.delivery_job_id, (select id from delivery_jobs x where x.order_id = o.id limit 1))
      where i.created_at >= ${from.toISOString()} and i.created_at < ${to.toISOString()}
      group by 1 order by tickets desc limit 50`);
    const rows = (r as unknown as { rows: Record<string, unknown>[] }).rows.map((x) => ({ key: String(x.key), tickets: Number(x.tickets), costCents: Number(x.cost_cents), breached: Number(x.breached), avgResolveHours: x.resolve_secs ? Math.round(Number(x.resolve_secs) / 360) / 10 : null }));
    return { dim, from, to, total: rows.reduce((a, x) => a + x.tickets, 0), rows };
  }

  /** Full timeline the agent sees: order, lines, payment, delivery, prior incidents. */
  async timeline(user: JwtPayload, incidentId: string) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    const order = i.orderId ? await this.orders.timeline(user, i.orderId) : null;
    const reservation = i.reservationId ? (await this.db.select().from(reservations).where(eq(reservations.id, i.reservationId)))[0] : null;
    const prior = i.orderId ? await this.db.select().from(incidents).where(eq(incidents.orderId, i.orderId)) : [];
    return { incident: i, order, reservation, priorIncidents: prior.filter((p) => p.id !== i.id) };
  }

  /**
   * Resolve with a remedy. Money remedies above the person's limit become an approval request
   * (staff: per-role limit from `approvals.thresholds`; merchant members: their membership approval limit;
   * owners and platform admins: unlimited). Repeat compensation on the same order always needs approval.
   * Money and inventory effects are posted exactly once via PaymentsService / DeliveryService.
   */
  async resolve(user: JwtPayload, incidentId: string, input: ResolveInput) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    if (i.status === 'RESOLVED' || i.status === 'CLOSED') throw new BadRequestException('Already resolved');
    const [o] = i.orderId ? await this.db.select().from(orders).where(eq(orders.id, i.orderId)).limit(1) : [null];
    const staff = isPlatformStaff(user);
    if (!staff) {
      if (!o) throw new ForbiddenException();
      assertOrgAccess(user, o.organizationId, o.locationId);
      if ((input.remedyCents || 0) > 0 && input.owner !== 'MERCHANT') throw new ForbiddenException('Merchants can only fund merchant-owned remedies');
    } else if (o) assertOrgAccess(user, o.organizationId, o.locationId);
    const cents = input.remedyCents || 0;
    const money = cents > 0 && (input.remedy === 'REFUND' || input.remedy === 'CREDIT');
    if (money) {
      const limit = staff ? await this.approvals.staffRefundLimit(user) : await this.memberLimit(user, o!.organizationId);
      const prior = o ? await this.db.select({ n: sql<number>`coalesce(sum(${incidents.remedyCents}),0)::int` }).from(incidents).where(and(eq(incidents.orderId, o.id), inArray(incidents.status, ['RESOLVED', 'CLOSED']))) : [{ n: 0 }];
      const repeat = prior[0].n > 0;
      const gw = o?.userId ? await this.goodwill(o.userId) : null;
      const overGoodwill = !!gw && (gw.overCount || gw.cents90d + cents > gw.maxCents90d);
      const review = o?.userId ? (await this.db.select({ id: customerRestrictions.id }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, o.userId), eq(customerRestrictions.kind, 'REFUND_REVIEW'), sql`${customerRestrictions.liftedAt} is null`, sql`(${customerRestrictions.expiresAt} is null or ${customerRestrictions.expiresAt} > now())`)).limit(1)).length > 0 : false;
      if (cents > limit || ((repeat || overGoodwill || review) && !user.roles.includes('PLATFORM_ADMIN'))) {
        await this.db.update(incidents).set({ status: 'INVESTIGATING', assigneeId: user.sub }).where(eq(incidents.id, incidentId));
        return this.approvals.submit(user, {
          kind: 'REFUND',
          summary: `${input.remedy === 'REFUND' ? 'Refund' : 'Credit'} $${(cents / 100).toFixed(2)} on ${o?.number || 'incident ' + incidentId.slice(0, 8)} (${i.category.toLowerCase().replace(/_/g, ' ')}${repeat ? `; $${(prior[0].n / 100).toFixed(2)} already compensated` : ''}${overGoodwill ? `; customer goodwill limit reached (${gw!.count90d} in 90 days)` : ''}${review ? '; customer refunds under review' : ''})`,
          organizationId: o?.organizationId,
          subjectType: 'incident',
          subjectId: incidentId,
          amountCents: cents,
          payload: { incidentId, input, priorCompensationCents: prior[0].n, limitCents: limit },
          reason: (input.note || `Incident ${i.category}: ${i.description}`).slice(0, 300),
          dedupeKey: `incident:${incidentId}`,
        });
      }
    }
    return this.applyRemedy(user, incidentId, input);
  }

  private async memberLimit(user: JwtPayload, orgId: string): Promise<number> {
    if (user.orgs?.[orgId]?.roles.includes('MERCHANT_OWNER')) return Number.MAX_SAFE_INTEGER;
    const rows = await this.db.select({ c: orgMemberships.approvalLimitCents }).from(orgMemberships).where(and(eq(orgMemberships.userId, user.sub), eq(orgMemberships.organizationId, orgId)));
    return Math.max(0, ...rows.map((r) => r.c));
  }

  /** Applies the remedy. `actor` is whoever authorized the money (the approver when it went through approval). */
  private async applyRemedy(actor: JwtPayload, incidentId: string, input: ResolveInput, requestedById?: string) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    if (i.status === 'RESOLVED' || i.status === 'CLOSED') return i; // idempotent on approval retry
    const [o] = i.orderId ? await this.db.select().from(orders).where(eq(orders.id, i.orderId)).limit(1) : [null];
    const cents = input.remedyCents || 0;
    await this.db.transaction(async (tx) => {
      if (o && cents > 0 && (input.remedy === 'REFUND' || input.remedy === 'CREDIT')) {
        const [p] = await tx.select().from(payments).where(eq(payments.orderId, o.id)).limit(1);
        if (input.remedy === 'REFUND' && p && p.capturedCents - p.refundedCents >= cents) {
          await this.payments.refund({ paymentId: p.id, amountCents: cents, reason: `Incident ${i.category}`, funder: input.owner === 'CUSTOMER' ? 'PLATFORM' : input.owner, approvedById: actor.sub, incidentId, idempotencyKey: `incident:${incidentId}` }, tx);
        } else if (o.userId) {
          await this.payments.issueCredit({ userId: o.userId, cents, reason: `Incident ${i.category}`, funder: input.owner === 'MERCHANT' ? 'MERCHANT' : 'PLATFORM', orderId: o.id, organizationId: o.organizationId, expiresInDays: 90 }, tx);
        }
      }
      if (o && input.remedy === 'REDELIVERY') {
        const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, o.id)).limit(1);
        if (job) {
          await tx.update(deliveryJobs).set({ status: 'UNASSIGNED', providerJobId: null, driverId: null, costOwner: input.owner }).where(eq(deliveryJobs.id, job.id));
          await this.delivery.dispatch(job.id, tx);
        }
      }
      if (o && input.remedy === 'REMAKE') {
        await tx.update(orders).set({ status: 'ACCEPTED', readyAt: null, collectedAt: null }).where(eq(orders.id, o.id));
        await tx.update(orderLines).set({ status: 'PREPARING' }).where(eq(orderLines.orderId, o.id));
        await tx.execute(sql`insert into kitchen_tickets (order_id, station_code, line_ids, status) select ${o.id}, 'MAIN', array_agg(id), 'QUEUED' from order_lines where order_id = ${o.id}`);
      }
      if (input.remedy === 'REASSIGN' && i.deliveryJobId) {
        await tx.update(deliveryJobs).set({ status: 'UNASSIGNED', providerJobId: null, driverId: null }).where(eq(deliveryJobs.id, i.deliveryJobId));
        await this.delivery.dispatch(i.deliveryJobId, tx);
      }
      const notes = input.note ? [{ note: input.note, by: requestedById || actor.sub, at: new Date(), ...(requestedById ? { approvedBy: actor.sub } : {}) }] : [];
      const [u] = await tx.update(incidents).set({ firstRespondedAt: i.firstRespondedAt ?? new Date(), status: 'RESOLVED', owner: input.owner, remedy: input.remedy, remedyCents: cents, resolvedAt: new Date(), assigneeId: requestedById || actor.sub, evidence: [...(i.evidence as unknown[]), ...(input.evidence || []), ...notes] }).where(eq(incidents.id, incidentId)).returning();
      await this.audit.log({ organizationId: o?.organizationId, actorId: actor.sub, action: 'incident.resolve', entityType: 'incident', entityId: incidentId, before: i, after: u }, tx);
      await this.outbox.publish('incident.resolved', incidentId, { userId: o?.userId ?? i.reporterId, remedy: input.remedy, cents, orderNumber: o?.number }, tx);
    });
    return (await this.db.select().from(incidents).where(eq(incidents.id, incidentId)))[0];
  }

  async appeal(user: JwtPayload, incidentId: string, note: string) {
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    if (!i) throw new NotFoundException();
    if (i.status !== 'RESOLVED') throw new BadRequestException('Only resolved incidents can be appealed');
    const [u] = await this.db.update(incidents).set({ status: 'APPEALED', appealNote: note }).where(eq(incidents.id, incidentId)).returning();
    return u;
  }

  /** Chargeback: evidence packet from the timeline, submitted to the processor (recorded here). */
  async chargebackEvidence(user: JwtPayload, paymentId: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [p] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!p) throw new NotFoundException();
    const order = p.orderId ? await this.orders.timeline(user, p.orderId) : null;
    return { paymentId: p.id, disputeId: p.disputeId, amountCents: p.capturedCents, evidence: { orderNumber: order?.order.number, acceptedAt: order?.order.acceptedAt, readyAt: order?.order.readyAt, collectedAt: order?.order.collectedAt, deliveryProof: order?.delivery?.proofPhotoUrl, events: order?.events, customerEmail: order?.order.guestEmail } };
  }

  /** Policy enforcement: strikes accumulate; 3+ high-severity strikes auto-suspend the subject. */
  async strike(user: JwtPayload, input: { subjectType: 'MERCHANT' | 'DRIVER' | 'CUSTOMER'; subjectId: string; reason: string; severity?: number }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [s] = await this.db.insert(policyStrikes).values({ ...input, severity: input.severity ?? 1 }).returning();
    const [{ total }] = await this.db.select({ total: sql<number>`coalesce(sum(${policyStrikes.severity}),0)::int` }).from(policyStrikes).where(and(eq(policyStrikes.subjectType, input.subjectType), eq(policyStrikes.subjectId, input.subjectId)));
    let suspended = false;
    if (total >= 3) {
      suspended = true;
      if (input.subjectType === 'DRIVER') await this.db.execute(sql`update drivers set status='SUSPENDED', is_available=false where id=${input.subjectId}`);
      if (input.subjectType === 'CUSTOMER') await this.db.insert(customerRestrictions).values({ userId: input.subjectId, kind: 'ORDERING_BLOCKED', reason: `Policy strikes: ${input.reason}`, createdById: user.sub });
      if (input.subjectType === 'MERCHANT') await this.db.execute(sql`update locations set status='SUSPENDED', is_paused=true, paused_reason='Policy suspension' where organization_id=${input.subjectId}`);
    }
    await this.audit.log({ actorId: user.sub, action: 'policy.strike', entityType: input.subjectType.toLowerCase(), entityId: input.subjectId, after: { ...s, total, suspended } });
    return { strike: s, total, suspended };
  }

  /** Data access/erasure: export or anonymize a user's personal data, retaining financial records. */
  async dataRequest(user: JwtPayload, kind: 'ACCESS' | 'DELETE') {
    const [r] = await this.db.insert(dataRequests).values({ userId: user.sub, kind }).returning();
    if (kind === 'ACCESS') {
      const [u] = await this.db.select().from(users).where(eq(users.id, user.sub)).limit(1);
      const addrs = await this.db.select().from(addresses).where(eq(addresses.userId, user.sub));
      const ords = await this.db.select().from(orders).where(eq(orders.userId, user.sub));
      const res = await this.db.select().from(reservations).where(eq(reservations.userId, user.sub));
      const loyalty = await this.db.select().from(loyaltyEntries).where(eq(loyaltyEntries.userId, user.sub));
      const revs = await this.db.select().from(reviews).where(eq(reviews.userId, user.sub));
      await this.db.update(dataRequests).set({ status: 'FULFILLED', fulfilledAt: new Date() }).where(eq(dataRequests.id, r.id));
      const { passwordHash: _ph, ...profile } = u!;
      return { request: r, export: { profile, addresses: addrs, orders: ords, reservations: res, loyalty, reviews: revs } };
    }
    // DELETE requests are scheduled with a grace period by CustomersService.privacyRequest
    await this.anonymize(user.sub);
    await this.db.update(dataRequests).set({ status: 'FULFILLED', fulfilledAt: new Date() }).where(eq(dataRequests.id, r.id));
    return { request: r, anonymized: true };
  }

  /** Anonymize PII; orders and ledger rows stay for financial retention; sessions are revoked. */
  async anonymize(userId: string) {
    const anon = `deleted-${userId.slice(0, 8)}@anon.gutad.io`;
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ email: anon, name: 'Deleted user', phone: null, passwordHash: null, pushTokens: [], dietaryNotes: null, marketingConsent: false, smsConsent: false, notificationPrefs: {}, status: 'DISABLED', statusReason: 'Deleted at the customer\'s request' }).where(eq(users.id, userId));
      await tx.delete(addresses).where(eq(addresses.userId, userId));
      await tx.delete(paymentMethods).where(eq(paymentMethods.userId, userId));
      await tx.update(orders).set({ guestName: null, guestEmail: null, guestPhone: null, deliveryAddress: null }).where(eq(orders.userId, userId));
      await tx.update(reservations).set({ guestName: 'Deleted', guestEmail: null, guestPhone: null, notes: null }).where(eq(reservations.userId, userId));
      await tx.update(guestProfiles).set({ name: 'Deleted', email: null, phone: null, notes: null, favorites: [] }).where(eq(guestProfiles.userId, userId));
      await tx.execute(sql`update refresh_tokens set revoked_at = now() where user_id = ${userId}`);
    });
  }
}
