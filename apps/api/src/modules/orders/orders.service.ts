import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { deliveryJobs, devices, locations, orderEvents, orderLines, orders, payments, quotes } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, staffCovers } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { PaymentsService } from '../payments/payments.service';
import { DeliveryService } from '../delivery/delivery.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { GrowthService } from '../growth/growth.service';
import { CrmService } from '../crm/crm.service';
import { QuoteService, QuoteSnapshotLine } from './quote.service';
import { addMinutes, orderNumber, shortCode } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

type OrderStatus = (typeof orders.status.enumValues)[number];

export interface CheckoutInput {
  quoteId: string;
  paymentMethodId?: string | null;
  guest?: { name: string; email: string; phone?: string } | null;
  specialInstructions?: string;
  idempotencyKey?: string;
  groupOrderId?: string | null;
  campusAccountId?: string | null;
}

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly quotesSvc: QuoteService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
    private readonly kitchen: KitchenService,
    private readonly growth: GrowthService,
    private readonly crm: CrmService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ───── 07 checkout ─────

  /**
   * Converts a quote into an order: validates expiry, authorizes payment (manual capture), creates the order,
   * lines and (for delivery) a QUOTED delivery job. Everything is in one transaction and keyed by the idempotency
   * key, so a duplicate submit returns the same order and never produces a second kitchen ticket.
   */
  async checkout(user: JwtPayload | null, input: CheckoutInput) {
    if (input.idempotencyKey) {
      const [existing] = await this.db.select().from(orders).where(eq(orders.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return this.present(existing.id);
    }
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, input.quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    if (q.consumedByOrderId) return this.present(q.consumedByOrderId);
    if (q.expiresAt < new Date()) throw new ConflictException('Quote expired; request a new quote');
    if (q.userId && user && q.userId !== user.sub) throw new ForbiddenException('Quote belongs to another user');
    if (!user && !input.guest) throw new BadRequestException('Guest details required for guest checkout');
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, q.locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (loc.isPaused && (!loc.pausedUntil || loc.pausedUntil > new Date())) throw new ConflictException(loc.pausedReason || 'Restaurant paused');
    // merchant throttle: max orders per 15 minutes
    if (loc.orderThrottlePer15m) {
      const n = await this.redis.incrWindow(`throttle:${loc.id}:${Math.floor(Date.now() / 900_000)}`, 900);
      if (n > loc.orderThrottlePer15m) throw new ConflictException('Restaurant is at capacity; try scheduling for later');
    }
    const snap = q.snapshot as { lines: QuoteSnapshotLine[]; commissionCents: number; terms: { contractId: string | null; commissionBps: number }; couponId: string | null; creditsCents: number; loyaltyCents: number; deliveryFleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM'; deliveryProviderCostCents: number; platformDeliverySubsidyCents: number; deliveryAddress: Address | null };
    const userId = user?.sub ?? null;

    const orderId = await this.db.transaction(async (tx) => {
      const number = orderNumber(q.fulfillmentType === 'DELIVERY' ? 'D' : 'P');
      const [o] = await tx
        .insert(orders)
        .values({
          number,
          organizationId: loc.organizationId,
          locationId: loc.id,
          userId,
          guestName: input.guest?.name ?? null,
          guestEmail: input.guest?.email ?? null,
          guestPhone: input.guest?.phone ?? null,
          channel: q.channel,
          fulfillmentType: q.fulfillmentType,
          status: 'SUBMITTED',
          currency: q.currency,
          subtotalCents: q.subtotalCents,
          discountCents: q.discountCents,
          taxCents: q.taxCents,
          serviceFeeCents: q.serviceFeeCents,
          deliveryFeeCents: q.deliveryFeeCents,
          tipCents: q.tipCents,
          totalCents: q.totalCents,
          commissionCents: snap.commissionCents,
          commissionBps: snap.terms.commissionBps,
          contractId: snap.terms.contractId,
          promoCode: q.promoCode,
          promotionFunder: q.promotionFunder,
          priceSnapshot: snap,
          scheduledFor: q.scheduledFor,
          promiseAt: q.promiseAt,
          pickupCode: q.fulfillmentType === 'PICKUP' ? shortCode(4) : null,
          specialInstructions: input.specialInstructions ?? null,
          deliveryAddress: snap.deliveryAddress,
          groupOrderId: input.groupOrderId ?? null,
          campusAccountId: input.campusAccountId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        })
        .returning();
      await tx.insert(orderLines).values(
        snap.lines.map((l) => ({ orderId: o.id, menuItemId: l.menuItemId, brandId: l.brandId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifiers: l.modifiers, specialInstructions: l.specialInstructions ?? null, stationCode: l.stationCode })),
      );
      await tx.update(quotes).set({ consumedByOrderId: o.id }).where(eq(quotes.id, q.id));

      // credits / loyalty applied before the card
      if (userId && snap.creditsCents) await this.payments.redeemCredit(userId, snap.creditsCents, o.id, tx);
      if (userId && snap.loyaltyCents) await this.growth.redeemPoints(userId, snap.loyaltyCents, o.id, tx);

      // card authorization (manual capture)
      if (o.totalCents > 0) {
        await this.payments.authorizeForOrder({ orderId: o.id, userId, amountCents: o.totalCents, currency: o.currency, locationId: loc.id, applicationFeeCents: o.commissionCents + o.serviceFeeCents + (q.fulfillmentType === 'DELIVERY' ? o.deliveryFeeCents : 0), customerEmail: user?.email || input.guest?.email, paymentMethodId: input.paymentMethodId, idempotencyKey: input.idempotencyKey ? `pay:${input.idempotencyKey}` : `pay:${o.id}` }, tx);
      } else {
        await tx.insert(payments).values({ orderId: o.id, userId, purpose: 'ORDER', provider: 'none', status: 'CAPTURED', currency: o.currency, amountCents: 0, idempotencyKey: `pay:${o.id}` });
      }

      if (q.fulfillmentType === 'DELIVERY' && snap.deliveryAddress) {
        await this.delivery.createJobForOrder({ orderId: o.id, locationId: loc.id, dropoff: { ...snap.deliveryAddress, contactName: user ? undefined : input.guest?.name, contactPhone: input.guest?.phone }, retailFeeCents: o.deliveryFeeCents, providerCostCents: snap.deliveryProviderCostCents, providerQuoteId: q.deliveryQuoteId, tipCents: o.tipCents, subsidyCents: snap.platformDeliverySubsidyCents, expiresAt: q.expiresAt, fleet: snap.deliveryFleet }, tx);
      }
      await this.event(o.id, 'SUBMITTED', userId, 'CUSTOMER', { number }, tx);
      await this.outbox.publish('order.submitted', o.id, { number, locationId: loc.id, userId, totalCents: o.totalCents }, tx);
      return o.id;
    });
    return this.present(orderId);
  }

  // ───── 08 merchant intake ─────

  async inbox(user: JwtPayload, locationId: string, status?: OrderStatus[]) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const statuses = status?.length ? status : (['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY'] as OrderStatus[]);
    const rows = await this.db.select().from(orders).where(and(eq(orders.locationId, locationId), inArray(orders.status, statuses))).orderBy(orders.promiseAt).limit(200);
    const ids = rows.map((r) => r.id);
    const lines = ids.length ? await this.db.select().from(orderLines).where(inArray(orderLines.orderId, ids)) : [];
    const jobs = ids.length ? await this.db.select().from(deliveryJobs).where(inArray(deliveryJobs.orderId, ids)) : [];
    return rows.map((o) => ({ ...o, priceSnapshot: undefined, lines: lines.filter((l) => l.orderId === o.id), delivery: jobs.find((j) => j.orderId === o.id) ?? null, ownerChannel: o.channel }));
  }

  /** Accept: capture the payment, fan out tickets, dispatch courier (delivery), set prep time. */
  async accept(user: JwtPayload, orderId: string, prepMinutes?: number) {
    const o = await this.requireStaffOrder(user, orderId);
    if (o.status !== 'SUBMITTED') {
      if (o.status === 'ACCEPTED' || o.status === 'PREPARING') return this.present(orderId); // idempotent
      throw new ConflictException(`Order is ${o.status}`);
    }
    await this.db.transaction(async (tx) => {
      const promiseAt = prepMinutes ? addMinutes(new Date(), prepMinutes) : o.promiseAt;
      await tx.update(orders).set({ status: 'ACCEPTED', acceptedAt: new Date(), promiseAt }).where(eq(orders.id, orderId));
      await this.payments.captureForOrder(orderId, null, tx);
      const snap = o.priceSnapshot as { couponId?: string | null };
      if (snap.couponId) await this.growth.consumeCoupon(snap.couponId, o.discountCents, o.totalCents, tx);
      await this.kitchen.fanOut(orderId, tx);
      if (o.fulfillmentType === 'DELIVERY') {
        const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
        if (job) await this.delivery.dispatch(job.id, tx);
      }
      await this.event(orderId, 'ACCEPTED', user.sub, 'MERCHANT', { prepMinutes }, tx);
      await this.outbox.publish('order.accepted', orderId, { number: o.number, promiseAt, userId: o.userId }, tx);
    });
    return this.present(orderId);
  }

  /** Reject releases the authorization; nothing is captured and no ticket exists. */
  async reject(user: JwtPayload, orderId: string, reason: string) {
    const o = await this.requireStaffOrder(user, orderId);
    if (o.status !== 'SUBMITTED') throw new ConflictException(`Cannot reject a ${o.status} order`);
    await this.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'REJECTED', rejectReason: reason, canceledAt: new Date() }).where(eq(orders.id, orderId));
      await this.payments.voidForOrder(orderId, tx);
      if (o.userId) await this.payments.reverseOrderCredits(orderId, tx);
      await this.restoreCreditsAndPoints(o, tx);
      await this.event(orderId, 'REJECTED', user.sub, 'MERCHANT', { reason }, tx);
      await this.outbox.publish('order.rejected', orderId, { number: o.number, reason, userId: o.userId }, tx);
    });
    return this.present(orderId);
  }

  async adjustTime(user: JwtPayload, orderId: string, prepMinutes: number) {
    const o = await this.requireStaffOrder(user, orderId);
    if (!['ACCEPTED', 'PREPARING'].includes(o.status)) throw new ConflictException('Can only adjust time while preparing');
    const promiseAt = addMinutes(new Date(), prepMinutes);
    await this.db.update(orders).set({ promiseAt }).where(eq(orders.id, orderId));
    await this.event(orderId, 'TIME_ADJUSTED', user.sub, 'MERCHANT', { promiseAt });
    await this.outbox.publish('delivery.late', orderId, { orderId, number: o.number, promiseAt, userId: o.userId, kind: 'order' });
    return this.present(orderId);
  }

  /** Tablet "mark ready" for single-station merchants without KDS. */
  async markReady(user: JwtPayload, orderId: string) {
    const o = await this.requireStaffOrder(user, orderId);
    if (!['ACCEPTED', 'PREPARING'].includes(o.status)) throw new ConflictException(`Order is ${o.status}`);
    await this.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'READY', readyAt: new Date() }).where(eq(orders.id, orderId));
      await tx.update(orderLines).set({ status: 'READY' }).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.status, ['PENDING', 'PREPARING'])));
      await tx.execute(sql`update kitchen_tickets set status='DONE', done_at=now() where order_id=${orderId} and status in ('QUEUED','IN_PROGRESS')`);
      await this.event(orderId, 'READY', user.sub, 'MERCHANT', {}, tx);
      await this.outbox.publish('order.ready', orderId, { number: o.number, pickupCode: o.pickupCode, userId: o.userId }, tx);
    });
    return this.present(orderId);
  }

  // ───── 11 pickup & on-site handoff ─────

  async handoff(user: JwtPayload, orderId: string, pickupCode?: string) {
    const o = await this.requireStaffOrder(user, orderId);
    if (o.status !== 'READY') throw new ConflictException(`Order is ${o.status}, not READY`);
    if (o.fulfillmentType === 'PICKUP' && o.pickupCode && pickupCode && pickupCode.toUpperCase() !== o.pickupCode) throw new BadRequestException('Pickup code does not match');
    await this.db.transaction(async (tx) => {
      const now = new Date();
      const final = o.fulfillmentType === 'DELIVERY' ? 'COLLECTED' : 'COMPLETED'; // courier collected vs customer collected
      await tx.update(orders).set({ status: final, collectedAt: now, completedAt: final === 'COMPLETED' ? now : null }).where(eq(orders.id, orderId));
      await this.event(orderId, 'COLLECTED', user.sub, 'MERCHANT', { pickupCode }, tx);
      await this.outbox.publish('order.collected', orderId, { number: o.number, userId: o.userId }, tx);
      if (final === 'COMPLETED') await this.onCompleted(o, tx);
    });
    return this.present(orderId);
  }

  /** Walk-in / counter intake: staff create an order on the customer's behalf (phone or counter). */
  async counterOrder(user: JwtPayload, locationId: string, input: { lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[] }[]; guestName: string; guestPhone?: string; fulfillmentType?: 'PICKUP' | 'DINE_IN'; channel?: 'PHONE' | 'WALK_IN'; paidOnPos?: boolean }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    const q = await this.quotesSvc.quote({ locationId, channel: input.channel || 'WALK_IN', fulfillmentType: input.fulfillmentType || 'PICKUP', lines: input.lines, userId: null });
    const o = await this.checkout(null, { quoteId: q.id, guest: { name: input.guestName, email: `${shortCode(6).toLowerCase()}@walkin.gutad.io`, phone: input.guestPhone }, idempotencyKey: `counter:${q.id}` });
    return this.accept(user, o.id);
  }

  async onCompleted(o: typeof orders.$inferSelect, tx: DbOrTx) {
    await this.crm.recordOrder(o.organizationId, { locationId: o.locationId, userId: o.userId, name: o.guestName || 'Customer', email: o.guestEmail, phone: o.guestPhone, spendCents: o.subtotalCents - o.discountCents }, tx);
    if (o.userId) await this.growth.earnForOrder(o.userId, o.id, o.subtotalCents - o.discountCents, tx);
    await this.outbox.publish('order.completed', o.id, { number: o.number, userId: o.userId, locationId: o.locationId }, tx);
  }

  // ───── customer-side ─────

  async myOrders(user: JwtPayload) {
    const rows = await this.db.select().from(orders).where(eq(orders.userId, user.sub)).orderBy(desc(orders.createdAt)).limit(100);
    const out = [];
    for (const r of rows) out.push(await this.present(r.id));
    return out;
  }

  async getForCustomer(user: JwtPayload | null, orderId: string, guestEmail?: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    const allowed = (user && (o.userId === user.sub || (isPlatformStaff(user) && staffCovers(user, o.organizationId, o.locationId)) || user.orgs?.[o.organizationId])) || (!o.userId && guestEmail && o.guestEmail?.toLowerCase() === guestEmail.toLowerCase());
    if (!allowed) throw new ForbiddenException();
    return this.present(orderId);
  }

  /** Cancellation eligibility: customers may cancel until the merchant accepts; afterwards support decides. */
  async cancelByCustomer(user: JwtPayload, orderId: string, reason: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o || o.userId !== user.sub) throw new NotFoundException();
    if (o.status !== 'SUBMITTED') throw new ConflictException('Order already accepted; contact support for changes');
    await this.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'CANCELED', cancelReason: reason, canceledAt: new Date() }).where(eq(orders.id, orderId));
      await this.payments.voidForOrder(orderId, tx);
      await this.restoreCreditsAndPoints(o, tx);
      await this.event(orderId, 'CANCELED', user.sub, 'CUSTOMER', { reason }, tx);
      await this.outbox.publish('order.canceled', orderId, { number: o.number, reason, userId: o.userId }, tx);
    });
    return this.present(orderId);
  }

  /** Support/merchant cancel after acceptance: refund captured money with an explicit cost owner. */
  async cancelByStaff(user: JwtPayload, orderId: string, reason: string, funder: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER') {
    const o = await this.requireStaffOrder(user, orderId);
    if (['COMPLETED', 'CANCELED', 'REJECTED'].includes(o.status)) throw new ConflictException(`Order is ${o.status}`);
    await this.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'CANCELED', cancelReason: reason, canceledAt: new Date() }).where(eq(orders.id, orderId));
      const [p] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
      if (p && (p.status === 'AUTHORIZED' || p.status === 'REQUIRES_ACTION')) await this.payments.voidForOrder(orderId, tx);
      else if (p && p.capturedCents - p.refundedCents > 0) await this.payments.refund({ paymentId: p.id, amountCents: p.capturedCents - p.refundedCents, reason, funder, approvedById: user.sub, idempotencyKey: `cancel:${orderId}` }, tx);
      await this.restoreCreditsAndPoints(o, tx);
      await this.growth.reverseForOrder(orderId, tx);
      const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
      if (job && !['DELIVERED', 'CANCELED', 'FAILED'].includes(job.status)) await this.delivery.transition(job.id, 'CANCELED', { reason, costOwner: funder }, tx);
      await tx.execute(sql`update kitchen_tickets set status='VOID' where order_id=${orderId} and status in ('QUEUED','IN_PROGRESS')`);
      await this.event(orderId, 'CANCELED', user.sub, isPlatformStaff(user) ? 'SUPPORT' : 'MERCHANT', { reason, funder }, tx);
      await this.outbox.publish('order.canceled', orderId, { number: o.number, reason, userId: o.userId }, tx);
    });
    return this.present(orderId);
  }

  /** Shared-kitchen flow: one item unavailable → customer approves replacement or takes partial credit. */
  async resolveUnavailableLine(user: JwtPayload, orderId: string, lineId: string, choice: 'REPLACE' | 'CREDIT', replacementNote?: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    const isOwner = o.userId === user.sub;
    if (!isOwner) assertOrgAccess(user, o.organizationId, o.locationId);
    const [line] = await this.db.select().from(orderLines).where(and(eq(orderLines.id, lineId), eq(orderLines.orderId, orderId))).limit(1);
    if (!line || line.status !== 'UNAVAILABLE') throw new ConflictException('Line is not awaiting a decision');
    await this.db.transaction(async (tx) => {
      if (choice === 'REPLACE') {
        await tx.update(orderLines).set({ status: 'READY', replacementNote: replacementNote || line.replacementNote }).where(eq(orderLines.id, lineId));
      } else {
        await tx.update(orderLines).set({ status: 'CREDITED' }).where(eq(orderLines.id, lineId));
        const [p] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
        const creditCents = line.lineTotalCents + Math.round((line.lineTotalCents * o.taxCents) / Math.max(1, o.subtotalCents));
        if (p && p.capturedCents - p.refundedCents >= creditCents) await this.payments.refund({ paymentId: p.id, amountCents: creditCents, reason: `Item unavailable: ${line.name}`, funder: 'MERCHANT', approvedById: user.sub, idempotencyKey: `line-credit:${lineId}` }, tx);
        else if (o.userId) await this.payments.issueCredit({ userId: o.userId, cents: creditCents, reason: `Item unavailable: ${line.name}`, funder: 'MERCHANT', orderId, organizationId: o.organizationId }, tx);
        const remaining = await tx.select().from(orderLines).where(and(eq(orderLines.orderId, orderId), sql`${orderLines.status} not in ('CREDITED','UNAVAILABLE')`));
        if (!remaining.length) await tx.update(orders).set({ status: 'CANCELED', cancelReason: 'All items unavailable', canceledAt: new Date() }).where(eq(orders.id, orderId));
        else await tx.update(orders).set({ status: sql`case when ${orders.status} = 'READY' then 'READY' else ${orders.status} end` }).where(eq(orders.id, orderId));
      }
      // unblock packing
      await tx.execute(sql`update packing_tasks set status='VERIFYING', blocked_reason=null where order_id=${orderId} and status='BLOCKED'`);
      await this.event(orderId, `LINE_${choice}`, user.sub, isOwner ? 'CUSTOMER' : 'MERCHANT', { lineId, replacementNote }, tx);
    });
    return this.present(orderId);
  }

  /** Reorder against the current menu: returns a fresh quote (prices may differ; sold-out items are reported). */
  async reorder(user: JwtPayload, orderId: string, fulfillmentType?: 'PICKUP' | 'DELIVERY') {
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, user.sub))).limit(1);
    if (!o) throw new NotFoundException();
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const snap = o.priceSnapshot as { deliveryAddress?: Address | null };
    const warnings: string[] = [];
    const attempt = async (ls: typeof lines) =>
      this.quotesSvc.quote({ locationId: o.locationId, channel: o.channel as never, fulfillmentType: (fulfillmentType || o.fulfillmentType) as never, lines: ls.map((l) => ({ menuItemId: l.menuItemId!, quantity: l.quantity, modifierOptionIds: (l.modifiers as { id: string }[]).map((m) => m.id), specialInstructions: l.specialInstructions ?? undefined })), tipCents: o.tipCents, deliveryAddress: snap.deliveryAddress ?? undefined, userId: user.sub });
    let remaining = lines.filter((l) => l.menuItemId);
    for (let i = 0; i < lines.length; i++) {
      try {
        const q = await attempt(remaining);
        return { ...q, warnings: [...warnings, ...q.warnings] };
      } catch (e) {
        const msg = (e as Error).message;
        const bad = remaining.find((l) => msg.includes(l.name) || msg.includes(l.menuItemId!));
        if (!bad) throw e;
        warnings.push(`${bad.name} is unavailable and was removed`);
        remaining = remaining.filter((l) => l.id !== bad.id);
        if (!remaining.length) throw new BadRequestException('None of the items are available any more');
      }
    }
    throw new BadRequestException('Could not rebuild the order');
  }

  // ───── presentation, timeline, helpers ─────

  async present(orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException('Order not found');
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const [p] = await this.db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    const [loc] = await this.db.select({ name: locations.name, slug: locations.slug, phone: locations.phone }).from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const { priceSnapshot: _ps, ...rest } = o;
    return {
      ...rest,
      locationName: loc?.name,
      locationSlug: loc?.slug,
      locationPhone: loc?.phone,
      lines: lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifiers: l.modifiers, specialInstructions: l.specialInstructions, status: l.status, replacementNote: l.replacementNote, brandId: l.brandId })),
      payment: p ? { status: p.status, amountCents: p.amountCents, capturedCents: p.capturedCents, refundedCents: p.refundedCents, clientSecret: p.status === 'REQUIRES_ACTION' ? p.clientSecret : undefined } : null,
      delivery: job ? { id: job.id, status: job.status, etaAt: job.etaAt, trackingUrl: job.trackingUrl, proofPhotoUrl: job.proofPhotoUrl, fleet: job.fleet } : null,
      canCancel: o.status === 'SUBMITTED',
    };
  }

  async timeline(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    if (o.userId !== user.sub) assertOrgAccess(user, o.organizationId, o.locationId);
    const events = await this.db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(orderEvents.createdAt);
    const tickets = await this.kitchen.ticketsForOrder(orderId);
    const pay = await this.payments.listForOrder(orderId);
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    const tracking = job ? await this.delivery.track(job.id) : null;
    return { order: await this.present(orderId), events, tickets, ...pay, delivery: tracking };
  }

  private async restoreCreditsAndPoints(o: typeof orders.$inferSelect, tx: DbOrTx) {
    const snap = o.priceSnapshot as { creditsCents?: number; loyaltyCents?: number };
    if (!o.userId) return;
    if (snap.creditsCents) await this.payments.issueCredit({ userId: o.userId, cents: snap.creditsCents, reason: `Credit restored (order ${o.number} canceled)`, orderId: o.id }, tx);
    if (snap.loyaltyCents) await this.growth.redeemPoints(o.userId, -snap.loyaltyCents, o.id, tx).catch(() => undefined);
  }

  async requireStaffOrder(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException('Order not found');
    assertOrgAccess(user, o.organizationId, o.locationId);
    return o;
  }

  async event(orderId: string, type: string, actorId: string | null, actorRole: string, data: Record<string, unknown>, tx: DbOrTx = this.db) {
    await tx.insert(orderEvents).values({ orderId, type, actorId, actorRole, data });
  }

  // ───── worker helpers ─────

  /** Offline merchant escalation: SUBMITTED orders unacknowledged for > N minutes get escalated (and auto-rejected later). */
  async escalateUnacknowledged(now = new Date()) {
    const stale = await this.db.select().from(orders).where(and(eq(orders.status, 'SUBMITTED'), lt(orders.createdAt, addMinutes(now, -5)), sql`${orders.scheduledFor} is null`));
    let escalated = 0;
    let rejected = 0;
    for (const o of stale) {
      const ageMin = (now.getTime() - o.createdAt.getTime()) / 60_000;
      const [esc] = await this.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, o.id), eq(orderEvents.type, 'ESCALATED'))).limit(1);
      if (!esc) {
        const [loc] = await this.db.select().from(locations).where(eq(locations.id, o.locationId)).limit(1);
        const devs = await this.db.select().from(devices).where(eq(devices.locationId, o.locationId));
        const offline = devs.length > 0 && devs.every((d) => !d.isOnline);
        await this.event(o.id, 'ESCALATED', null, 'SYSTEM', { reason: offline ? 'Merchant devices offline' : 'Unacknowledged', fallbackPhone: loc?.tabletFallbackPhone });
        await this.outbox.publish('integration.failed', o.id, { kind: 'order.unacknowledged', orderId: o.id, number: o.number, locationId: o.locationId, fallbackPhone: loc?.tabletFallbackPhone, offline });
        escalated++;
      }
      if (ageMin > 20) {
        await this.db.transaction(async (tx) => {
          await tx.update(orders).set({ status: 'REJECTED', rejectReason: 'Restaurant did not respond', canceledAt: now }).where(eq(orders.id, o.id));
          await this.payments.voidForOrder(o.id, tx);
          await this.restoreCreditsAndPoints(o, tx);
          await this.event(o.id, 'REJECTED', null, 'SYSTEM', { reason: 'timeout' }, tx);
          await this.outbox.publish('order.rejected', o.id, { number: o.number, reason: 'Restaurant did not respond', userId: o.userId }, tx);
        });
        rejected++;
      }
    }
    return { escalated, rejected };
  }

  async expireQuotes(now = new Date()) {
    const r = await this.db.delete(quotes).where(and(lt(quotes.expiresAt, addMinutes(now, -60)), sql`${quotes.consumedByOrderId} is null`)).returning({ id: quotes.id });
    return r.length;
  }

  /** Scheduled orders become visible on the tablet when their prep window starts. */
  async releaseScheduled(now = new Date()) {
    const due = await this.db.select().from(orders).where(and(eq(orders.status, 'SUBMITTED'), sql`${orders.scheduledFor} is not null`, lt(orders.scheduledFor, addMinutes(now, 45))));
    for (const o of due) {
      const [ev] = await this.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, o.id), eq(orderEvents.type, 'SCHEDULED_RELEASED'))).limit(1);
      if (ev) continue;
      await this.event(o.id, 'SCHEDULED_RELEASED', null, 'SYSTEM', {});
      await this.outbox.publish('order.submitted', o.id, { number: o.number, locationId: o.locationId, userId: o.userId, scheduled: true });
    }
    return due.length;
  }
}
