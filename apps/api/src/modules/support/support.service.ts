import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { dataRequests, deliveryJobs, incidents, orders, payments, policyStrikes, reservations, users, orderLines, addresses, loyaltyEntries, reviews, guestProfiles, orgMemberships } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrdersService } from '../orders/orders.service';
import { ApprovalsService } from '../security/approvals.service';

type ResolveInput = { owner: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER' | 'CUSTOMER'; remedy: 'REFUND' | 'CREDIT' | 'REMAKE' | 'REDELIVERY' | 'REASSIGN' | 'NONE'; remedyCents?: number; note?: string; evidence?: unknown[] };
type Category = 'MISSING_ITEM' | 'LATE' | 'DAMAGED' | 'NO_HANDOFF' | 'WRONG_ADDRESS' | 'CHARGEBACK' | 'NO_SHOW_DISPUTE' | 'OTHER';

/** 28 — incident queues, order/booking timeline, role-based remedies with evidence, chargebacks, appeals, data requests. */
@Injectable()
export class SupportService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly outbox: OutboxService, private readonly payments: PaymentsService, private readonly delivery: DeliveryService, private readonly orders: OrdersService, private readonly approvals: ApprovalsService) {}

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

  async open(user: JwtPayload, input: { orderId?: string; reservationId?: string; deliveryJobId?: string; category: Category; description: string; evidence?: unknown[] }) {
    if (input.orderId) {
      const [o] = await this.db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!o) throw new NotFoundException('Order not found');
      if (o.userId !== user.sub) assertOrgAccess(user, o.organizationId, o.locationId);
    }
    const defaultOwner = input.category === 'LATE' || input.category === 'NO_HANDOFF' || input.category === 'WRONG_ADDRESS' ? 'PROVIDER' : input.category === 'MISSING_ITEM' || input.category === 'DAMAGED' ? 'MERCHANT' : 'PLATFORM';
    const [i] = await this.db.insert(incidents).values({ orderId: input.orderId ?? null, reservationId: input.reservationId ?? null, deliveryJobId: input.deliveryJobId ?? null, reporterId: user.sub, category: input.category, description: input.description, evidence: input.evidence || [], owner: defaultOwner }).returning();
    return i;
  }

  async queue(user: JwtPayload, filter?: { status?: string; owner?: string; organizationId?: string }) {
    const conds = [];
    if (filter?.status) conds.push(eq(incidents.status, filter.status as never));
    if (filter?.owner) conds.push(eq(incidents.owner, filter.owner));
    if (!isPlatformStaff(user)) {
      const orgIds = Object.keys(user.orgs || {});
      if (!orgIds.length) return this.db.select().from(incidents).where(eq(incidents.reporterId, user.sub)).orderBy(desc(incidents.createdAt));
      const locOrders = await this.db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, orgIds)).limit(5000);
      conds.push(inArray(incidents.orderId, locOrders.map((o) => o.id)));
    }
    return this.db.select().from(incidents).where(conds.length ? and(...conds) : undefined).orderBy(desc(incidents.createdAt)).limit(200);
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
      if (cents > limit || (repeat && !user.roles.includes('PLATFORM_ADMIN'))) {
        await this.db.update(incidents).set({ status: 'INVESTIGATING', assigneeId: user.sub }).where(eq(incidents.id, incidentId));
        return this.approvals.submit(user, {
          kind: 'REFUND',
          summary: `${input.remedy === 'REFUND' ? 'Refund' : 'Credit'} $${(cents / 100).toFixed(2)} on ${o?.number || 'incident ' + incidentId.slice(0, 8)} (${i.category.toLowerCase().replace(/_/g, ' ')}${repeat ? `; $${(prior[0].n / 100).toFixed(2)} already compensated` : ''})`,
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
      const [u] = await tx.update(incidents).set({ status: 'RESOLVED', owner: input.owner, remedy: input.remedy, remedyCents: cents, resolvedAt: new Date(), assigneeId: requestedById || actor.sub, evidence: [...(i.evidence as unknown[]), ...(input.evidence || []), ...notes] }).where(eq(incidents.id, incidentId)).returning();
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
    // DELETE: anonymize PII, keep ledger/orders for retention (financial records), revoke access
    const anon = `deleted-${user.sub.slice(0, 8)}@anon.gutad.io`;
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ email: anon, name: 'Deleted user', phone: null, passwordHash: null, pushTokens: [], dietaryNotes: null, marketingConsent: false, smsConsent: false }).where(eq(users.id, user.sub));
      await tx.delete(addresses).where(eq(addresses.userId, user.sub));
      await tx.update(orders).set({ guestName: null, guestEmail: null, guestPhone: null, deliveryAddress: null }).where(eq(orders.userId, user.sub));
      await tx.update(reservations).set({ guestName: 'Deleted', guestEmail: null, guestPhone: null, notes: null }).where(eq(reservations.userId, user.sub));
      await tx.update(guestProfiles).set({ name: 'Deleted', email: null, phone: null, notes: null, favorites: [] }).where(eq(guestProfiles.userId, user.sub));
      await tx.execute(sql`update refresh_tokens set revoked_at = now() where user_id = ${user.sub}`);
      await tx.update(dataRequests).set({ status: 'FULFILLED', fulfilledAt: new Date() }).where(eq(dataRequests.id, r.id));
    });
    return { request: r, anonymized: true };
  }
}
