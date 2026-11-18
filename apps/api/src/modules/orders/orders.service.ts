import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx, Tx } from '../../db/db.module';
import { checkoutGroups, journalEntries, orderPaymentAllocations, paymentFailures, deliveryJobs, devices, drivers, users, locations, orderEvents, orderLines, orders, packingTasks, payments, quotes, customerRestrictions, paymentMethods } from '../../db/schema';
import { chefCancellationRefund, DEFAULT_PICKUP_POLICY, type PickupPolicy } from '@gutad/shared';
import { SettingsService } from '../../core/settings.service';
import { assertOrgAccess, isPlatformStaff, JwtPayload, staffCovers } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { LedgerService } from '../../core/ledger.service';
import { redeemGift, restoreGift } from '../growth/gift-tender';
import { assertCashLimit } from '../customers/limits';
import { PaymentsService } from '../payments/payments.service';
import { DeliveryService } from '../delivery/delivery.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { GrowthService } from '../growth/growth.service';
import { CrmService } from '../crm/crm.service';
import { ChefCalendarService } from '../chefs/chef-calendar.service';
import { markChefQuotesOrdered } from '../chefs/chef-requests.service';
import { QuoteService, QuoteSnapshotLine } from './quote.service';
import { addMinutes, orderNumber, shortCode } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

type OrderStatus = (typeof orders.status.enumValues)[number];

export interface CheckoutInput {
  quoteId: string;
  paymentMethodId?: string | null;
  /** a saved card (payment_methods.id) of the signed-in customer */
  savedPaymentMethodId?: string | null;
  guest?: { name: string; email: string; phone?: string } | null;
  specialInstructions?: string;
  idempotencyKey?: string;
  groupOrderId?: string | null;
  campusAccountId?: string | null;
  /** 14.8 dine-in table or kiosk pager */
  tableNumber?: string | null;
  /** 14.1 include utensils */
  utensils?: boolean;
}

/** Internal actor for automatic transitions (auto-accept). */
const SYSTEM_ACTOR = { sub: null as unknown as string, email: 'system', roles: ['PLATFORM_ADMIN'], orgs: {} } as JwtPayload;

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
    private readonly settings: SettingsService,
    private readonly ledger: LedgerService,
    private readonly chefCalendar: ChefCalendarService,
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
    input = await this.precheck(user, input, [q]);
    const loc = await this.placeAllowed(q.locationId);
    const orderId = await this.db.transaction(async (tx) => {
      const o = await this.placeInTx(tx, user, input, q, loc, null);
      if (loc.chefKitchen) await this.chargeChef(tx, user, input, [o], q.id, null);
      else await this.payForOrder(tx, user, input, q, loc, o);
      return o.id;
    });
    // merchants can switch on auto-accept for immediate (not scheduled) orders
    if (loc.autoAccept && !q.scheduledFor) {
      await this.accept(SYSTEM_ACTOR, orderId).catch((e) => this.log.warn(`auto-accept ${orderId} failed: ${(e as Error).message}`));
    }
    return this.present(orderId);
  }

  /**
   * Gutad Chef Network: one checkout across several chefs. Each quote (one per kitchen, each with its own day and
   * time) becomes a child order; the customer is charged once for all of them, and allocations split the payment so
   * a decline or cancellation refunds the right order. Everything happens in one transaction: a failed card or a
   * date that filled up places nothing.
   */
  async checkoutGroup(user: JwtPayload | null, input: Omit<CheckoutInput, 'quoteId'> & { quoteIds: string[] }) {
    if (input.idempotencyKey) {
      const [g] = await this.db.select().from(checkoutGroups).where(eq(checkoutGroups.idempotencyKey, input.idempotencyKey)).limit(1);
      if (g) return this.presentGroup(g.id);
    }
    const ids = [...new Set(input.quoteIds)];
    if (ids.length < 1 || ids.length > 6) throw new BadRequestException('Check out 1 to 6 chefs at a time');
    const qs = await this.db.select().from(quotes).where(inArray(quotes.id, ids));
    if (qs.length !== ids.length) throw new NotFoundException('Quote not found');
    if (qs.some((q) => q.consumedByOrderId)) throw new ConflictException({ message: 'Part of this checkout was already placed. Refresh your cart.', code: 'QUOTE_CONSUMED' });
    if (new Set(qs.map((q) => q.locationId)).size !== qs.length) throw new BadRequestException('One quote per chef kitchen');
    if (new Set(qs.map((q) => q.currency)).size > 1) throw new BadRequestException('All orders must be in one currency');
    const locs: (typeof locations.$inferSelect)[] = [];
    for (const q of qs) {
      const loc = await this.placeAllowed(q.locationId);
      if (!loc.chefKitchen) throw new BadRequestException({ message: 'Only Gutad Bestie orders can be checked out together', code: 'NOT_CHEF_ORDER' });
      if (!q.scheduledFor) throw new BadRequestException({ message: 'Each chef order needs a day and time', code: 'SCHEDULE_REQUIRED' });
      locs.push(loc);
    }
    const checked = await this.precheck(user, { ...input, quoteId: qs[0].id }, qs);
    const total = qs.reduce((a, q) => a + q.totalCents, 0);
    const groupId = await this.db.transaction(async (tx) => {
      const [g] = await tx.insert(checkoutGroups).values({ userId: user?.sub ?? null, guestEmail: user ? null : input.guest?.email ?? null, currency: qs[0].currency, totalCents: total, orderCount: qs.length, idempotencyKey: input.idempotencyKey ?? null }).returning();
      const placed: (typeof orders.$inferSelect)[] = [];
      for (let i = 0; i < qs.length; i++) placed.push(await this.placeInTx(tx, user, { ...checked, quoteId: qs[i].id, idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${i}` : undefined }, qs[i], locs[i], g.id));
      const p = await this.chargeChef(tx, user, checked, placed, qs[0].id, g.id);
      await tx.update(checkoutGroups).set({ paymentId: p.id }).where(eq(checkoutGroups.id, g.id));
      return g.id;
    });
    return this.presentGroup(groupId);
  }

  /** The checkout's orders. Internal callers pass no viewer; customers must own it (guests: the checkout email). */
  async presentGroup(groupId: string, viewer?: { user: JwtPayload | null; email?: string }) {
    const [g] = await this.db.select().from(checkoutGroups).where(eq(checkoutGroups.id, groupId)).limit(1);
    if (!g) throw new NotFoundException();
    if (viewer) {
      const u = viewer.user;
      const ok = u ? g.userId === u.sub || isPlatformStaff(u) : !g.userId && !!viewer.email && g.guestEmail?.toLowerCase() === viewer.email.toLowerCase();
      if (!ok) throw new ForbiddenException();
    }
    const rows = await this.db.select({ id: orders.id }).from(orders).where(eq(orders.checkoutGroupId, groupId)).orderBy(orders.scheduledFor);
    const list = [];
    for (const r of rows) list.push(await this.present(r.id));
    return { id: g.id, totalCents: g.totalCents, currency: g.currency, deliveries: g.orderCount, createdAt: g.createdAt, orders: list };
  }

  /** Customer-level checks shared by single and group checkout; resolves a saved card. */
  private async precheck(user: JwtPayload | null, input: CheckoutInput, qs: (typeof quotes.$inferSelect)[]) {
    for (const q of qs) {
      if (q.expiresAt < new Date()) throw new ConflictException({ message: 'Quote expired; request a new quote', code: 'QUOTE_EXPIRED', quoteId: q.id });
      if (q.userId && user && q.userId !== user.sub) throw new ForbiddenException('Quote belongs to another user');
    }
    if (!user && !input.guest) throw new BadRequestException('Guest details required for guest checkout');
    if (user) {
      const [blocked] = await this.db.select({ id: customerRestrictions.id }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, user.sub), eq(customerRestrictions.kind, 'ORDERING_BLOCKED'), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), sql`${customerRestrictions.expiresAt} > now()`))).limit(1);
      if (blocked) throw new ForbiddenException({ message: 'Ordering is paused on this account. See Account → Help to appeal.', code: 'ACCOUNT_RESTRICTED' });
      await assertCashLimit(this.db, user.sub, qs.reduce((a, q) => a + q.totalCents, 0)); // 10.8-L limit set after the quote was priced
      if (input.savedPaymentMethodId) {
        const [pm] = await this.db.select().from(paymentMethods).where(and(eq(paymentMethods.id, input.savedPaymentMethodId), eq(paymentMethods.userId, user.sub))).limit(1);
        if (!pm) throw new BadRequestException('Saved card not found');
        input = { ...input, paymentMethodId: pm.providerRef };
      }
    }
    return input;
  }

  /** The place can take this order right now (pause and the merchant's 15-minute throttle). */
  private async placeAllowed(locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (loc.isPaused && (!loc.pausedUntil || loc.pausedUntil > new Date())) throw new ConflictException(loc.pausedReason || 'Restaurant paused');
    // merchant throttle: max orders per 15 minutes
    const ramp = loc.rampUntil && loc.rampUntil > new Date() && loc.rampThrottlePer15m ? loc.rampThrottlePer15m : null;
    const throttle = ramp && loc.orderThrottlePer15m ? Math.min(ramp, loc.orderThrottlePer15m) : ramp || loc.orderThrottlePer15m;
    if (throttle) {
      const n = await this.redis.incrWindow(`throttle:${loc.id}:${Math.floor(Date.now() / 900_000)}`, 900);
      if (n > throttle) throw new ConflictException(ramp ? 'Restaurant is reopening gradually; try scheduling for later' : 'Restaurant is at capacity; try scheduling for later');
    }
    return loc;
  }

  /**
   * Creates the order, its lines, capacity confirmation, credits/points/gift redemption, the delivery job and the
   * SUBMITTED event. Payment is handled by the caller (authorization, or the chef charge for one or more orders).
   */
  private async placeInTx(tx: Tx, user: JwtPayload | null, input: CheckoutInput, q: typeof quotes.$inferSelect, loc: typeof locations.$inferSelect, groupId: string | null, amendedFrom?: { id: string; number: string }) {
    const snap = q.snapshot as { lines: QuoteSnapshotLine[]; commissionCents: number; terms: { contractId: string | null; commissionBps: number }; couponId: string | null; creditsCents: number; loyaltyCents: number; giftCents?: number; deliveryFleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM'; deliveryProviderCostCents: number; platformDeliverySubsidyCents: number; deliveryAddress: Address | null; chef?: { freeCancelUntil: string | null; lateRefundPct: number; acceptHours: number } };
    const userId = user?.sub ?? null;
    const number = orderNumber(q.fulfillmentType === 'DELIVERY' ? 'D' : 'P');
    // Gutad Chef Network: prepaid, with an acceptance deadline and the cancellation terms shown at checkout
    const chef = loc.chefKitchen && q.scheduledFor ? snap.chef : undefined;
    const now = new Date();
    const acceptBy = chef && q.scheduledFor ? new Date(Math.max(now.getTime() + 30 * 60_000, Math.min(now.getTime() + chef.acceptHours * 3_600_000, q.scheduledFor.getTime() - 2 * 3_600_000))) : null;
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
        smallOrderFeeCents: q.smallOrderFeeCents,
        packagingFeeCents: q.packagingFeeCents,
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
        // 14.8-K a kiosk order keeps its pager number for take-away too
        tableNumber: q.fulfillmentType === 'DINE_IN' || q.channel === 'KIOSK' ? input.tableNumber ?? null : null,
        utensils: !!input.utensils,
        deliveryAddress: snap.deliveryAddress,
        groupOrderId: input.groupOrderId ?? null,
        campusAccountId: input.campusAccountId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        checkoutGroupId: groupId,
        amendedFromOrderId: amendedFrom?.id ?? null,
        prepaid: !!chef,
        acceptBy,
        freeCancelUntil: chef?.freeCancelUntil ? new Date(chef.freeCancelUntil) : null,
        lateRefundPct: chef ? chef.lateRefundPct : null,
      })
      .returning();
    await tx.insert(orderLines).values(
      snap.lines.map((l) => ({ orderId: o.id, menuItemId: l.menuItemId, brandId: l.brandId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifiers: l.modifiers, specialInstructions: l.specialInstructions ?? null, stationCode: l.stationCode, allergens: l.allergens ?? null, dietaryTags: l.dietaryTags ?? null })),
    );
    await tx.update(quotes).set({ consumedByOrderId: o.id }).where(eq(quotes.id, q.id));
    // Gutad Chef Network special requests: each accepted chef quote is used once
    const chefQuoteIds = snap.lines.map((l) => l.chefRequestQuoteId).filter((x): x is string => !!x);
    if (chefQuoteIds.length) await markChefQuotesOrdered(tx, chefQuoteIds, o.id);
    // Gutad Chef Network: the quote's capacity hold becomes the order's confirmed portions for its cooking day
    if (loc.chefKitchen && q.scheduledFor) await this.chefCalendar.confirm(tx, { locationId: loc.id, scheduledFor: q.scheduledFor, lines: snap.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })), quoteId: q.id, orderId: o.id });

    // credits / loyalty applied before the card
    if (userId && snap.creditsCents) await this.payments.redeemCredit(userId, snap.creditsCents, o.id, tx);
    if (userId && snap.loyaltyCents) await this.growth.redeemPoints(userId, snap.loyaltyCents, o.id, tx);
    // 25.9 gift balance (re-checked under a row lock: a card spent elsewhere since the quote is caught here)
    if (userId && snap.giftCents) {
      const used = await redeemGift(tx, userId, snap.giftCents, o.id);
      if (used < snap.giftCents) throw new BadRequestException({ message: 'Your gift card balance changed since this price was calculated. Review the total and try again.', code: 'GIFT_BALANCE_CHANGED', quoteId: q.id });
    }
    if (q.fulfillmentType === 'DELIVERY' && snap.deliveryAddress) {
      await this.delivery.createJobForOrder({ orderId: o.id, locationId: loc.id, dropoff: { ...snap.deliveryAddress, contactName: user ? undefined : input.guest?.name, contactPhone: input.guest?.phone }, retailFeeCents: o.deliveryFeeCents, providerCostCents: snap.deliveryProviderCostCents, providerQuoteId: q.deliveryQuoteId, tipCents: o.tipCents, subsidyCents: snap.platformDeliverySubsidyCents, expiresAt: q.expiresAt, fleet: snap.deliveryFleet }, tx);
    }
    await this.event(o.id, 'SUBMITTED', userId, 'CUSTOMER', { number, ...(groupId ? { checkoutGroupId: groupId } : {}) }, tx);
    const chefName = chef ? await this.chefCalendar.chefNameFor(loc.id) : null;
    await this.outbox.publish('order.submitted', o.id, { number, locationId: loc.id, userId, totalCents: o.totalCents, ...(chefName ? { chefName, scheduledFor: o.scheduledFor, acceptBy: o.acceptBy, freeCancelUntil: o.freeCancelUntil } : {}), ...(amendedFrom ? { amendedFromNumber: amendedFrom.number } : {}) }, tx);
    return o;
  }

  /** Card authorization (manual capture) for a regular order; captured when the merchant accepts. */
  private async payForOrder(tx: Tx, user: JwtPayload | null, input: CheckoutInput, q: typeof quotes.$inferSelect, loc: typeof locations.$inferSelect, o: typeof orders.$inferSelect) {
    const snap = q.snapshot as { creditsCents: number; loyaltyCents: number; giftCents?: number };
    const userId = user?.sub ?? null;
    const split = { cardCents: o.totalCents, creditsCents: snap.creditsCents || 0, loyaltyCents: snap.loyaltyCents || 0, giftCents: snap.giftCents || 0 };
    if (o.totalCents > 0) {
      // 11.7 — a declined card rolls the order back but keeps the quote, so the customer retries with another card (no duplicate order)
      try {
        await this.payments.authorizeForOrder({ orderId: o.id, userId, amountCents: o.totalCents, currency: o.currency, locationId: loc.id, applicationFeeCents: o.commissionCents + o.serviceFeeCents + (q.fulfillmentType === 'DELIVERY' ? o.deliveryFeeCents : 0), customerEmail: user?.email || input.guest?.email, paymentMethodId: input.paymentMethodId, idempotencyKey: input.idempotencyKey ? `pay:${input.idempotencyKey}` : `pay:${o.id}` }, tx);
        // 18.3 record how the order was paid
        await tx.update(payments).set({ split }).where(eq(payments.orderId, o.id));
      } catch (e) {
        // 18.1 the failed attempt is kept even though the order rolls back
        await this.db.insert(paymentFailures).values({ purpose: 'ORDER', quoteId: q.id, userId, locationId: loc.id, amountCents: o.totalCents, currency: o.currency, provider: this.payments.providerName, reason: (e as Error).message }).catch(() => undefined);
        throw new BadRequestException({ message: `Payment failed: ${(e as Error).message}. Try another card.`, code: 'PAYMENT_DECLINED', quoteId: q.id });
      }
    } else {
      await tx.insert(payments).values({ orderId: o.id, userId, purpose: 'ORDER', provider: 'none', status: 'CAPTURED', currency: o.currency, amountCents: 0, split, idempotencyKey: `pay:${o.id}` });
    }
  }

  /** Gutad Chef Network: one charge now for one or more chef orders (decline and cutoff refunds come out of it). */
  private async chargeChef(tx: Tx, user: JwtPayload | null, input: CheckoutInput, placed: (typeof orders.$inferSelect)[], quoteId: string, groupId: string | null) {
    const userId = user?.sub ?? null;
    const total = placed.reduce((a, o) => a + o.totalCents, 0);
    try {
      const p = await this.payments.chargeChefOrders({ orders: placed.map((o) => ({ id: o.id, number: o.number, totalCents: o.totalCents, organizationId: o.organizationId })), userId, currency: placed[0].currency, customerEmail: user?.email || input.guest?.email, paymentMethodId: input.paymentMethodId, idempotencyKey: input.idempotencyKey ? `pay:${input.idempotencyKey}` : `pay:${groupId || placed[0].id}`, groupId }, tx);
      const snaps = placed.map((o) => o.priceSnapshot as { creditsCents?: number; loyaltyCents?: number; giftCents?: number });
      await tx.update(payments).set({ split: { cardCents: total, creditsCents: snaps.reduce((a, s) => a + (s.creditsCents || 0), 0), loyaltyCents: snaps.reduce((a, s) => a + (s.loyaltyCents || 0), 0), giftCents: snaps.reduce((a, s) => a + (s.giftCents || 0), 0) } }).where(eq(payments.id, p.id));
      return p;
    } catch (e) {
      await this.db.insert(paymentFailures).values({ purpose: groupId ? 'ORDER_GROUP' : 'ORDER', quoteId, userId, locationId: placed[0].locationId, amountCents: total, currency: placed[0].currency, provider: this.payments.providerName, reason: (e as Error).message }).catch(() => undefined);
      throw new BadRequestException({ message: `Payment failed: ${(e as Error).message}. Try another card.`, code: 'PAYMENT_DECLINED', quoteId });
    }
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
      // Gutad Chef Network orders were charged at checkout; regular orders capture their authorization now
      if (!o.prepaid) await this.payments.captureForOrder(orderId, null, tx);
      await this.growth.consumePromotions(o, tx);
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
      // a chef decline refunds the full charge automatically
      if (o.prepaid) await this.payments.refundPrepaidOrder(orderId, o.totalCents, `Chef declined: ${reason}`, tx);
      else await this.payments.voidForOrder(orderId, tx);
      if (o.userId) await this.payments.reverseOrderCredits(orderId, tx);
      await this.restoreCreditsAndPoints(o, tx);
      await this.event(orderId, 'REJECTED', user.sub, 'MERCHANT', { reason }, tx);
      await this.outbox.publish('order.rejected', orderId, { number: o.number, reason, userId: o.userId, ...(o.prepaid ? { prepaid: true, refundCents: o.totalCents } : {}) }, tx);
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
    // 14.4 where packing verification is required, the order becomes ready only by releasing the bag
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const [pack] = await this.db.select().from(packingTasks).where(eq(packingTasks.orderId, orderId)).limit(1);
    if (loc && pack && pack.status !== 'RELEASED' && this.kitchen.requiresPackVerification(loc)) throw new ConflictException({ message: 'Verify the bag on the packing screen before marking this order ready', code: 'PACK_VERIFICATION_REQUIRED' });
    await this.db.transaction(async (tx) => {
      await tx.update(orderLines).set({ status: 'READY', readyAt: new Date() }).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.status, ['PENDING', 'PREPARING'])));
      await tx.execute(sql`update kitchen_tickets set status='DONE', done_at=now() where order_id=${orderId} and status in ('QUEUED','IN_PROGRESS')`);
      await this.kitchen.markOrderReady(o, tx, user.sub);
      await this.event(orderId, 'READY', user.sub, 'MERCHANT', {}, tx);
    });
    return this.present(orderId);
  }

  // ───── 11 pickup & on-site handoff ─────

  /** 14.6 handoff records who received the order: the customer (code checked), the courier, or a table. */
  async handoff(user: JwtPayload, orderId: string, pickupCode?: string, receiver?: { receiverName?: string; courierId?: string; tableNumber?: string }) {
    const o = await this.requireStaffOrder(user, orderId);
    if (o.status !== 'READY') throw new ConflictException(`Order is ${o.status}, not READY`);
    if (o.fulfillmentType === 'PICKUP' && o.pickupCode && pickupCode && pickupCode.toUpperCase() !== o.pickupCode) throw new BadRequestException('Pickup code does not match');
    let courierId = receiver?.courierId ?? null;
    if (o.fulfillmentType === 'DELIVERY' && !courierId) {
      const [j] = await this.db.select({ driverId: deliveryJobs.driverId }).from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
      courierId = j?.driverId ?? null;
    }
    const [courier] = courierId ? await this.db.select({ id: drivers.id, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, courierId)).limit(1) : [null];
    const handoff = o.fulfillmentType === 'DELIVERY'
      ? { type: 'COURIER', courierId: courier?.id ?? null, name: courier?.name ?? receiver?.receiverName ?? null }
      : o.fulfillmentType === 'DINE_IN'
        ? { type: 'TABLE', tableNumber: receiver?.tableNumber ?? o.tableNumber }
        : { type: 'CUSTOMER', name: receiver?.receiverName ?? o.guestName ?? null, codeVerified: !!(pickupCode && o.pickupCode && pickupCode.toUpperCase() === o.pickupCode) };
    await this.db.transaction(async (tx) => {
      const now = new Date();
      const final = o.fulfillmentType === 'DELIVERY' ? 'COLLECTED' : 'COMPLETED'; // courier collected vs customer collected
      await tx.update(orders).set({ status: final, collectedAt: now, completedAt: final === 'COMPLETED' ? now : null, handoff: { ...handoff, by: user.sub, at: now.toISOString() }, shelfSlot: null }).where(eq(orders.id, orderId));
      await this.event(orderId, 'COLLECTED', user.sub, 'MERCHANT', { pickupCode, handoff }, tx);
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
    if (o.prepaid) await this.payments.recognizePrepaidOrder(o.id, tx);
    await this.crm.recordOrder(o.organizationId, { locationId: o.locationId, userId: o.userId, name: o.guestName || 'Customer', email: o.guestEmail, phone: o.guestPhone, spendCents: o.subtotalCents - o.discountCents }, tx);
    await this.growth.onOrderCompleted(o, tx);
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
    if (o.prepaid) return this.cancelPrepaid(user, o, reason);
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

  /** What cancelling a prepaid chef order would refund right now (shown before the customer confirms). */
  async cancellationPreview(user: JwtPayload | null, orderId: string, guestEmail?: string) {
    await this.getForCustomer(user, orderId, guestEmail);
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o.prepaid) return { allowed: o.status === 'SUBMITTED', refundCents: o.status === 'SUBMITTED' ? o.totalCents : 0, full: o.status === 'SUBMITTED', reason: o.status === 'SUBMITTED' ? 'Nothing is charged until the restaurant accepts' : 'Contact support for changes', freeCancelUntil: null };
    const alloc = await this.payments.allocationFor(orderId);
    const charged = alloc ? alloc.a.amountCents - alloc.a.refundedCents : 0;
    return { ...chefCancellationRefund({ chargedCents: charged, freeCancelUntil: o.freeCancelUntil, lateRefundPct: o.lateRefundPct, status: o.status }), chargedCents: charged, freeCancelUntil: o.freeCancelUntil?.toISOString() ?? null };
  }

  /**
   * Customer cancels a prepaid chef order: full refund before the date's cutoff (or while the chef hasn't accepted),
   * then the chef's late-refund percentage. Whatever is kept goes to the chef (net of commission) like a completed
   * order. The portions return to the calendar and any tickets and courier booking are voided.
   */
  private async cancelPrepaid(user: JwtPayload, o: typeof orders.$inferSelect, reason: string) {
    await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
      const alloc = await this.payments.allocationFor(o.id, tx);
      const charged = alloc ? alloc.a.amountCents - alloc.a.refundedCents : 0;
      const r = chefCancellationRefund({ chargedCents: charged, freeCancelUntil: cur.freeCancelUntil, lateRefundPct: cur.lateRefundPct, status: cur.status });
      if (!r.allowed) throw new ConflictException({ message: `${r.reason}; contact support for changes`, code: 'CANCEL_NOT_ALLOWED' });
      await tx.update(orders).set({ status: 'CANCELED', cancelReason: reason, canceledAt: new Date() }).where(eq(orders.id, o.id));
      if (r.refundCents > 0) await this.payments.refundPrepaidOrder(o.id, r.refundCents, `Customer canceled: ${reason}`, tx);
      if (r.full) await this.restoreCreditsAndPoints(cur, tx);
      else await this.payments.recognizePrepaidOrder(o.id, tx); // the kept part pays the chef
      await this.voidFulfillment(tx, o.id, reason);
      await this.event(o.id, 'CANCELED', user.sub, 'CUSTOMER', { reason, refundCents: r.refundCents, policy: r.reason }, tx);
      await this.outbox.publish('order.canceled', o.id, { number: o.number, reason, userId: o.userId, prepaid: true, refundCents: r.refundCents }, tx);
    });
    return this.present(o.id);
  }

  /** Voids kitchen tickets and the courier booking of a canceled order. */
  private async voidFulfillment(tx: DbOrTx, orderId: string, reason: string, costOwner: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER' = 'PLATFORM') {
    const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    if (job && !['DELIVERED', 'CANCELED', 'FAILED'].includes(job.status)) await this.delivery.transition(job.id, 'CANCELED', { reason, costOwner }, tx);
    await tx.execute(sql`update kitchen_tickets set status='VOID' where order_id=${orderId} and status in ('QUEUED','IN_PROGRESS')`);
  }

  /** Gutad Chef Network: a chef who doesn't accept by the deadline has the order declined and fully refunded. */
  async expireUnacceptedChefOrders(now = new Date()) {
    const due = await this.db.select().from(orders).where(and(eq(orders.status, 'SUBMITTED'), eq(orders.prepaid, true), lt(orders.acceptBy, now)));
    for (const o of due) {
      const reason = 'The chef didn’t confirm in time';
      await this.db.transaction(async (tx) => {
        const [cur] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, o.id)).for('update');
        if (cur.status !== 'SUBMITTED') return;
        await tx.update(orders).set({ status: 'REJECTED', rejectReason: reason, canceledAt: now }).where(eq(orders.id, o.id));
        await this.payments.refundPrepaidOrder(o.id, o.totalCents, reason, tx);
        if (o.userId) await this.payments.reverseOrderCredits(o.id, tx);
        await this.restoreCreditsAndPoints(o, tx);
        await this.voidFulfillment(tx, o.id, reason);
        await this.event(o.id, 'REJECTED', null, 'SYSTEM', { reason: 'accept_deadline' }, tx);
        await this.outbox.publish('order.rejected', o.id, { number: o.number, reason, userId: o.userId, prepaid: true, refundCents: o.totalCents }, tx);
      });
    }
    return { declined: due.length };
  }

  /** Completed prepaid chef orders (pickup, delivery or no-show) credit the chef; settlement pays it out weekly. */
  async recognizeCompletedChefOrders() {
    const due = await this.db.select({ id: orders.id }).from(orders).where(and(eq(orders.prepaid, true), eq(orders.status, 'COMPLETED'), isNull(orders.recognizedAt))).limit(200);
    let n = 0;
    for (const o of due) if (await this.db.transaction((tx) => this.payments.recognizePrepaidOrder(o.id, tx))) n++;
    return { recognized: n };
  }

  /** Support/merchant cancel after acceptance: refund captured money with an explicit cost owner. */
  async cancelByStaff(user: JwtPayload, orderId: string, reason: string, funder: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER') {
    const o = await this.requireStaffOrder(user, orderId);
    if (['COMPLETED', 'CANCELED', 'REJECTED'].includes(o.status)) throw new ConflictException(`Order is ${o.status}`);
    await this.db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'CANCELED', cancelReason: reason, canceledAt: new Date() }).where(eq(orders.id, orderId));
      const alloc = o.prepaid ? await this.payments.allocationFor(orderId, tx) : null;
      const [p] = alloc ? [alloc.p] : await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
      // prepaid chef orders not yet recognized: the money is still Gutad's to return (no funder involved)
      if (alloc && !o.recognizedAt) await this.payments.refundPrepaidOrder(orderId, alloc.a.amountCents - alloc.a.refundedCents, reason, tx, user.sub);
      else if (alloc) { const amt = Math.min(alloc.a.amountCents - alloc.a.refundedCents, p.capturedCents - p.refundedCents); if (amt > 0) { await this.payments.refund({ paymentId: p.id, amountCents: amt, reason, funder, approvedById: user.sub, idempotencyKey: `cancel:${orderId}` }, tx); await tx.update(orderPaymentAllocations).set({ refundedCents: alloc.a.refundedCents + amt }).where(eq(orderPaymentAllocations.id, alloc.a.id)); } }
      else if (p && (p.status === 'AUTHORIZED' || p.status === 'REQUIRES_ACTION')) await this.payments.voidForOrder(orderId, tx);
      else if (p && p.capturedCents - p.refundedCents > 0) await this.payments.refund({ paymentId: p.id, amountCents: p.capturedCents - p.refundedCents, reason, funder, approvedById: user.sub, idempotencyKey: `cancel:${orderId}` }, tx);
      await this.restoreCreditsAndPoints(o, tx, funder);
      await this.growth.reverseRedemptions(orderId, tx);
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
        await tx.update(orders).set({ partialFulfillment: true }).where(eq(orders.id, orderId));
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
  /** Reorder into the cart: the past order's lines checked against today's menu (see QuoteService.rebuildCart). */
  async reorderCart(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, user.sub))).limit(1);
    if (!o) throw new NotFoundException();
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const snapLines = ((o.priceSnapshot as { lines?: QuoteSnapshotLine[] } | null)?.lines || []);
    return this.quotesSvc.rebuildCart(o.locationId, ['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR'].includes(o.channel) ? (o.channel as 'MARKETPLACE') : 'MARKETPLACE', lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents + l.modifiersCents, modifierIds: ((l.modifiers as { id: string; qty?: number }[]) || []).flatMap((m) => Array(m.qty || 1).fill(m.id)), specialInstructions: l.specialInstructions, chefRequestQuoteId: snapLines.find((s) => s.menuItemId === l.menuItemId && s.name === l.name)?.chefRequestQuoteId })));
  }

  /**
   * Whether a paid chef order can still be changed: its customer, before the date's order cutoff (the full-refund
   * window), while the chef hasn't started, and without a special-request line (those are quoted for one order).
   */
  async amendment(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, user.sub))).limit(1);
    if (!o) throw new NotFoundException();
    return this.amendCheck(o);
  }

  private amendCheck(o: typeof orders.$inferSelect, now = new Date()) {
    const lines = ((o.priceSnapshot as { lines?: QuoteSnapshotLine[] } | null)?.lines || []);
    const base = { until: o.freeCancelUntil?.toISOString() ?? null, scheduledFor: o.scheduledFor?.toISOString() ?? null, chargedCents: o.totalCents };
    if (!o.prepaid) return { ...base, allowed: false, code: 'NOT_AMENDABLE', reason: 'Only Gutad Bestie orders can be changed after payment. Cancel and order again.' };
    if (!['SUBMITTED', 'ACCEPTED'].includes(o.status)) return { ...base, allowed: false, code: 'NOT_AMENDABLE', reason: `This order is ${o.status.toLowerCase()}` };
    if (!o.freeCancelUntil || o.freeCancelUntil <= now) return { ...base, allowed: false, code: 'AMEND_WINDOW_CLOSED', reason: 'Changes close at the order cutoff for the day' };
    if (lines.some((l) => l.chefRequestQuoteId)) return { ...base, allowed: false, code: 'HAS_SPECIAL_REQUEST', reason: 'Orders with a special request can’t be changed. Cancel for a full refund and ask the chef again.' };
    return { ...base, allowed: true, code: 'OK', reason: 'You can add dishes, change quantities, remove dishes, and change the day and time until the cutoff. We charge the new total and refund the original in full; the chef confirms the changed order again.' };
  }

  /**
   * Change a paid chef order before its cutoff: the new quote (made with `replacesOrderId`) becomes a new order that
   * is charged, and the original is cancelled and refunded in full, in one transaction. A declined card changes
   * nothing. The chef confirms the new order like any order (declined or unconfirmed → refunded in full).
   */
  async amend(user: JwtPayload, orderId: string, input: CheckoutInput) {
    if (input.idempotencyKey) {
      const [existing] = await this.db.select().from(orders).where(eq(orders.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return this.present(existing.id);
    }
    const [o] = await this.db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, user.sub))).limit(1);
    if (!o) throw new NotFoundException();
    const check = this.amendCheck(o);
    if (!check.allowed) throw new ConflictException({ message: check.reason, code: check.code });
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, input.quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    if (q.consumedByOrderId) throw new ConflictException({ message: 'This change was already placed', code: 'QUOTE_CONSUMED' });
    if ((q.snapshot as { replacesOrderId?: string }).replacesOrderId !== o.id || q.userId !== user.sub || q.locationId !== o.locationId) throw new BadRequestException({ message: 'Price the change for this order first', code: 'QUOTE_NOT_FOR_ORDER' });
    input = await this.precheck(user, input, [q]);
    const loc = await this.placeAllowed(q.locationId);
    const newId = await this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
      const again = this.amendCheck(cur);
      if (!again.allowed) throw new ConflictException({ message: again.reason, code: again.code });
      const alloc = await this.payments.allocationFor(o.id, tx);
      const charged = alloc ? alloc.a.amountCents - alloc.a.refundedCents : 0;
      // the original stops counting against the kitchen's capacity before the new order confirms its portions
      await tx.update(orders).set({ status: 'CANCELED', cancelReason: 'Changed by the customer', canceledAt: new Date() }).where(eq(orders.id, o.id));
      const n = await this.placeInTx(tx, user, input, q, loc, null, { id: o.id, number: o.number });
      await this.chargeChef(tx, user, input, [n], q.id, null);
      // only after the new charge succeeded: refund the original in full and restore its credits and points
      if (charged > 0) await this.payments.refundPrepaidOrder(o.id, charged, `Order changed: replaced by ${n.number}`, tx);
      await this.restoreCreditsAndPoints(cur, tx);
      await this.voidFulfillment(tx, o.id, 'Order changed by the customer');
      await tx.update(orders).set({ cancelReason: `Changed by the customer: replaced by ${n.number}` }).where(eq(orders.id, o.id));
      await this.event(o.id, 'AMENDED', user.sub, 'CUSTOMER', { replacedBy: n.id, number: n.number, refundCents: charged }, tx);
      return n.id;
    });
    return this.present(newId);
  }

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
    const alloc = o.prepaid ? await this.payments.allocationFor(orderId) : null;
    const [p] = alloc ? [alloc.p] : await this.db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.orderId, orderId)).limit(1);
    const [loc] = await this.db.select({ name: locations.name, slug: locations.slug, phone: locations.phone }).from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const { priceSnapshot: _ps, ...rest } = o;
    return {
      ...rest,
      locationName: loc?.name,
      locationSlug: loc?.slug,
      locationPhone: loc?.phone,
      lines: lines.map((l) => ({ id: l.id, menuItemId: l.menuItemId, handling: l.handling, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifiers: l.modifiers, specialInstructions: l.specialInstructions, status: l.status, replacementNote: l.replacementNote, brandId: l.brandId, allergens: l.allergens, dietaryTags: l.dietaryTags })),
      payment: alloc ? { status: alloc.a.refundedCents >= alloc.a.amountCents && alloc.a.amountCents > 0 ? 'REFUNDED' : alloc.a.refundedCents ? 'PARTIALLY_REFUNDED' : 'CAPTURED', amountCents: alloc.a.amountCents, capturedCents: alloc.a.amountCents, refundedCents: alloc.a.refundedCents, chargedAt: alloc.p.createdAt, sharedWithOrders: alloc.p.amountCents !== alloc.a.amountCents } : p ? { status: p.status, amountCents: p.amountCents, capturedCents: p.capturedCents, refundedCents: p.refundedCents, clientSecret: p.status === 'REQUIRES_ACTION' ? p.clientSecret : undefined } : null,
      delivery: job ? { id: job.id, status: job.status, etaAt: job.etaAt, trackingUrl: job.trackingUrl, hasProof: !!(job.proofPhotoUrl || job.proofSignature), fleet: job.fleet, arrivedAt: job.arrivedDropoffAt, exception: job.exception ? { kind: (job.exception as { kind: string }).kind, waitUntil: (job.exception as { waitUntil?: string }).waitUntil, resolution: (job.exception as { resolution?: string }).resolution ?? null } : null } : null,
      canCancel: o.prepaid ? ['SUBMITTED', 'ACCEPTED'].includes(o.status) : o.status === 'SUBMITTED',
      // Gutad Chef Network: a paid order can be changed until its cutoff (see amendCheck)
      amendable: o.prepaid ? this.amendCheck(o).allowed : false,
      // Gutad Chef Network: sold by Gutad, prepared by the chef; the cancellation terms accepted at checkout
      chefNetwork: o.prepaid ? { chefName: await this.chefCalendar.chefNameFor(o.locationId), chefSlug: await this.chefCalendar.chefSlugFor(o.locationId), freeCancelUntil: o.freeCancelUntil, lateRefundPct: o.lateRefundPct, acceptBy: o.acceptBy, checkoutGroupId: o.checkoutGroupId } : null,
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

  private async restoreCreditsAndPoints(o: typeof orders.$inferSelect, tx: DbOrTx, funder?: string) {
    const snap = o.priceSnapshot as { creditsCents?: number; loyaltyCents?: number; giftCents?: number };
    if (!o.userId) return;
    if (snap.giftCents) {
      // before capture nothing was posted; after capture the redemption sits in the capture journal, so the give-back is charged to the funder
      const [p] = await tx.select({ status: payments.status, provider: payments.provider, id: payments.id }).from(payments).where(eq(payments.orderId, o.id)).limit(1);
      const [posted] = p ? await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.paymentId, p.id), eq(journalEntries.account, 'GIFT_CARD_LIABILITY'))).limit(1) : [];
      await restoreGift(tx, this.ledger, { orderId: o.id, cents: null, kind: posted ? 'REFUND' : 'RESTORE', note: `Order ${o.number} canceled`, funder: posted ? { account: funder === 'MERCHANT' ? 'MERCHANT_PAYABLE' : 'PLATFORM_EXPENSE_REFUND', organizationId: o.organizationId } : null, currency: o.currency });
    }
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
  /**
   * 14.7 pickup no-shows: remind the customer after `noShowNotifyMinutes`, then after `noShowResolveMinutes`
   * resolve per policy: CHARGE (treated as collected; payment kept) or REFUND (canceled, merchant-funded refund).
   */
  async noShowSweep(now = new Date()) {
    const policy = await this.settings.getObject<PickupPolicy>('pickup.policy', DEFAULT_PICKUP_POLICY);
    const remind = await this.db.select().from(orders).where(and(eq(orders.status, 'READY'), eq(orders.fulfillmentType, 'PICKUP'), isNull(orders.noShowStage), lt(orders.readyAt, new Date(now.getTime() - policy.noShowNotifyMinutes * 60_000))));
    for (const o of remind) {
      await this.db.update(orders).set({ noShowStage: 'NOTIFIED', noShowNotifiedAt: now }).where(eq(orders.id, o.id));
      await this.outbox.publish('order.pickup_reminder', o.id, { number: o.number, userId: o.userId, email: o.guestEmail, readyAt: o.readyAt, holdUntil: new Date(o.readyAt!.getTime() + policy.noShowResolveMinutes * 60_000), resolution: policy.noShowResolution });
      await this.event(o.id, 'PICKUP_REMINDER', null, 'SYSTEM', {});
    }
    const resolve = await this.db.select().from(orders).where(and(eq(orders.status, 'READY'), eq(orders.fulfillmentType, 'PICKUP'), eq(orders.noShowStage, 'NOTIFIED'), lt(orders.readyAt, new Date(now.getTime() - policy.noShowResolveMinutes * 60_000))));
    for (const o of resolve) {
      if (policy.noShowResolution === 'REFUND') {
        await this.cancelByStaff(SYSTEM_ACTOR, o.id, 'Not picked up (no-show)', 'MERCHANT');
      } else {
        await this.db.transaction(async (tx) => {
          await tx.update(orders).set({ status: 'COMPLETED', completedAt: now, handoff: { type: 'NO_SHOW', at: now.toISOString() }, shelfSlot: null }).where(eq(orders.id, o.id));
          await this.event(o.id, 'NO_SHOW', null, 'SYSTEM', { resolution: 'CHARGE' }, tx);
        });
      }
      await this.db.update(orders).set({ noShowStage: 'RESOLVED' }).where(eq(orders.id, o.id));
    }
    return { reminded: remind.length, resolved: resolve.length };
  }

  async escalateUnacknowledged(now = new Date()) {
    // per-location acceptance timeout (default 5 min); auto-reject at 4× the timeout
    const stale = await this.db.select({ o: orders, timeout: locations.acceptTimeoutMinutes }).from(orders).innerJoin(locations, eq(locations.id, orders.locationId)).where(and(eq(orders.status, 'SUBMITTED'), sql`${orders.createdAt} < ${now.toISOString()}::timestamptz - make_interval(mins => ${locations.acceptTimeoutMinutes})`, sql`${orders.scheduledFor} is null`)).then((r) => r.map((x) => Object.assign(x.o, { _timeout: x.timeout })));
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
      if (ageMin > (o as typeof o & { _timeout: number })._timeout * 4) {
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
