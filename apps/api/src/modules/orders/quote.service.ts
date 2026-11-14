import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { brands, taxRates, customerRestrictions, menuCategories, menuItems, menus, orders, locationClosures, locations, openingHours, platformSettings, quotes } from '../../db/schema';
import { brandSellable } from '../../common/brand-rules';
import { DEFAULT_PAYMENT_METHODS, enabledMethods, type PaymentMethodsConfig } from '@gutad/shared';
import { cartCompatibility, computeCustomerFees, DEFAULT_CUSTOMER_FEES, type CustomerFeeRules } from '@gutad/shared';
import { SettingsService } from '../../core/settings.service';
import { CatalogService, ResolvedItem } from '../catalog/catalog.service';
import { ContractsService } from '../contracts/contracts.service';
import { DeliveryService } from '../delivery/delivery.service';
import { GrowthService } from '../growth/growth.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PaymentsService } from '../payments/payments.service';
import { addMinutes, bps, isWithin, localParts, zonedTimeToUtc } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

export type Channel = 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR' | 'PARTNER' | 'PHONE' | 'WALK_IN' | 'CAMPUS' | 'CORPORATE' | 'API' | 'KIOSK';
export type Fulfillment = 'PICKUP' | 'DELIVERY' | 'DINE_IN' | 'CATERING';

export interface QuoteInput {
  locationId: string;
  channel: Channel;
  fulfillmentType: Fulfillment;
  lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[]; specialInstructions?: string }[];
  scheduledFor?: string | null;
  tipCents?: number;
  promoCode?: string;
  deliveryAddress?: Address;
  useCreditsCents?: number;
  useLoyaltyPoints?: number;
  userId?: string | null;
}

export interface QuoteSnapshotLine {
  menuItemId: string;
  name: string;
  brandId: string | null;
  stationCode: string | null;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  lineTotalCents: number;
  modifiers: { id: string; name: string; priceCents: number }[];
  specialInstructions?: string;
  taxCategory?: string;
}

/** Simulation inputs (9.8): draft fee rules, tax rates and item prices; nothing is stored. */
export interface SimulationResult { subtotalCents: number; discountCents: number; taxCents: number; serviceFeeCents: number; smallOrderFeeCents: number; packagingFeeCents: number; deliveryFeeCents: number; tipCents: number; creditsCents: number; loyaltyCents: number; totalCents: number; commissionCents: number; promotionFunder: string | null; promotionPlatformShareCents: number; taxLines: { category: string; rateBps: number; taxableCents: number; taxCents: number }[]; lines: QuoteSnapshotLine[]; warnings: string[] }
export interface QuoteSimulation { feeRules?: CustomerFeeRules; taxRates?: Record<string, number>; priceOverrides?: Record<string, number>; ignoreHours?: boolean }

const QUOTE_TTL_MINUTES = 10;

/** Prices a cart deterministically and stores an immutable snapshot that checkout consumes. */
@Injectable()
export class QuoteService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly contracts: ContractsService,
    private readonly delivery: DeliveryService,
    private readonly growth: GrowthService,
    private readonly kitchen: KitchenService,
    private readonly payments: PaymentsService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SettingsService,
  ) {}

  async quote(input: QuoteInput, tx: DbOrTx = this.db) {
    return this.quoteImpl(input, tx) as Promise<ReturnType<QuoteService['present']>>;
  }

  /** 9.8 — price a cart with draft fee rules, tax rates or item prices; nothing is stored and hours/pauses are ignored. */
  async simulate(input: QuoteInput, sim: QuoteSimulation) {
    return this.quoteImpl(input, this.db, { ignoreHours: true, ...sim }) as Promise<SimulationResult>;
  }

  private async quoteImpl(input: QuoteInput, tx: DbOrTx = this.db, sim?: QuoteSimulation): Promise<unknown> {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
    if (!loc) throw new NotFoundException('Restaurant not found');
    const warnings: string[] = [];
    if (!sim && !['LIVE', 'VERIFIED'].includes(loc.status)) throw new BadRequestException('Restaurant is not accepting orders');
    // plan gating: ordering for every order, delivery on top for delivery orders
    await this.entitlements.assertLocation(loc.id, 'ordering', 'customer', tx);
    if (input.fulfillmentType === 'DELIVERY') await this.entitlements.assertLocation(loc.id, 'delivery', 'customer', tx);
    if (!sim && loc.isPaused && (!loc.pausedUntil || loc.pausedUntil > new Date())) throw new BadRequestException({ message: loc.pausedReason || 'Restaurant is temporarily paused', code: 'PAUSED', reopensAt: loc.pausedUntil });
    // 10.8 — account restrictions
    const restr = input.userId && !sim ? await tx.select({ kind: customerRestrictions.kind, reason: customerRestrictions.reason }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, input.userId), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), gt(customerRestrictions.expiresAt, new Date())))) : [];
    if (restr.some((r) => r.kind === 'ORDERING_BLOCKED')) throw new ForbiddenException({ message: 'Ordering is paused on this account. See Account → Help to appeal.', code: 'ACCOUNT_RESTRICTED' });
    if (input.promoCode && restr.some((r) => r.kind === 'PROMOTIONS_BLOCKED')) throw new BadRequestException({ message: 'Promotions are not available on this account', code: 'PROMOTIONS_BLOCKED' });
    // 18.2 payment methods enabled for this region and channel
    if (!sim && (input.useCreditsCents || input.useLoyaltyPoints)) {
      const methods = enabledMethods(await this.settings.getObject<PaymentMethodsConfig>('payments.methods', DEFAULT_PAYMENT_METHODS), input.channel, loc.regionId);
      if (input.useCreditsCents && !methods.includes('CREDITS')) throw new BadRequestException({ message: 'Credits can’t be used for this order', code: 'METHOD_DISABLED' });
      if (input.useLoyaltyPoints && !methods.includes('LOYALTY')) throw new BadRequestException({ message: 'Points can’t be used for this order', code: 'METHOD_DISABLED' });
    }
    if (input.channel === 'KIOSK' && !loc.acceptsKiosk) throw new BadRequestException({ message: 'Kiosk ordering is not enabled here', code: 'CHANNEL_UNAVAILABLE' });
    if (input.fulfillmentType === 'PICKUP' && !loc.acceptsPickup) throw new BadRequestException('Pickup not offered');
    if (input.fulfillmentType === 'DELIVERY' && !loc.acceptsDelivery) throw new BadRequestException('Delivery not offered');
    if (input.fulfillmentType === 'CATERING' && !loc.acceptsCatering) throw new BadRequestException('Catering not offered');
    if (!input.lines.length) throw new BadRequestException('Cart is empty');

    // schedule / promise
    const now = new Date();
    let scheduledFor: Date | null = null;
    if (input.scheduledFor) {
      scheduledFor = new Date(input.scheduledFor);
      if (isNaN(scheduledFor.getTime())) throw new BadRequestException('Invalid scheduledFor');
      // 11.5 — lead time and slot capacity for scheduled orders
      const lead = Math.max(loc.defaultPrepMinutes, loc.scheduleLeadMinutes ?? 0);
      if (scheduledFor < addMinutes(now, lead)) throw new BadRequestException({ message: `Schedule at least ${lead} minutes ahead`, code: 'SCHEDULE_TOO_SOON', earliestAt: addMinutes(now, lead) });
      if (!sim?.ignoreHours && !(await this.openAt(loc, scheduledFor, tx))) throw new BadRequestException({ message: 'Restaurant is closed at the scheduled time', code: 'CLOSED', nextOpenAt: await this.nextOpenAt(loc, scheduledFor, tx) });
      if (!sim && loc.scheduledSlotCapacity) {
        const slot = new Date(Math.floor(scheduledFor.getTime() / 900_000) * 900_000);
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.locationId, loc.id), sql`${orders.scheduledFor} >= ${slot.toISOString()} and ${orders.scheduledFor} < ${new Date(slot.getTime() + 900_000).toISOString()}`, sql`${orders.status} not in ('CANCELED','REJECTED')`));
        if (n >= loc.scheduledSlotCapacity) throw new BadRequestException({ message: 'That time is fully booked; pick another slot', code: 'SLOT_FULL' });
      }
    } else if (!sim?.ignoreHours && !(await this.openAt(loc, now, tx))) {
      throw new BadRequestException({ message: 'Restaurant is closed right now; schedule for later', code: 'CLOSED', nextOpenAt: await this.nextOpenAt(loc, now, tx) });
    }
    // 13.7 kitchen auto-throttle
    const load = sim ? null : await this.kitchen.loadFor(loc.kitchenId, tx);
    if (load?.level === 'OVERLOADED' && !scheduledFor) throw new BadRequestException({ message: 'The kitchen is at capacity right now; schedule for later', code: 'KITCHEN_BUSY' });

    // items & modifiers
    const items = await this.catalog.resolveItems(loc.id, input.channel, input.lines.map((l) => l.menuItemId), sim?.ignoreHours ? undefined : scheduledFor ?? now);
    if (sim?.priceOverrides) for (const [id, cents] of Object.entries(sim.priceOverrides)) { const it = items.get(id); if (it) it.priceCents = cents; }
    const eligibleBrands = await this.kitchen.eligibleBrands(loc.id, tx);
    const brandIds = [...new Set([...items.values()].map((i) => i.brandId).filter((x): x is string => !!x))];
    const brandRows = new Map((brandIds.length ? await tx.select().from(brands).where(inArray(brands.id, brandIds)) : []).map((b) => [b.id, b]));
    const snapLines: QuoteSnapshotLine[] = [];
    for (const l of input.lines) {
      const item = items.get(l.menuItemId);
      if (!item) {
        // 11.3 / 11.4 — an item from another place means a separate order (Gutad mixing rule)
        const [elsewhere] = await tx.select({ locationId: menus.locationId, name: locations.name, platformOperated: locations.platformOperated }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).innerJoin(locations, eq(locations.id, menus.locationId)).where(eq(menuItems.id, l.menuItemId)).limit(1);
        if (elsewhere && elsewhere.locationId && elsewhere.locationId !== loc.id) {
          const c = cartCompatibility({ locationId: loc.id, name: loc.name, platformOperated: loc.platformOperated }, { locationId: elsewhere.locationId, name: elsewhere.name, platformOperated: elsewhere.platformOperated });
          if (!c.ok) throw new BadRequestException({ message: c.reason, code: c.code });
        }
        throw new BadRequestException({ message: `Item ${l.menuItemId} is not available on this menu right now`, code: 'ITEM_UNAVAILABLE' });
      }
      if (item.soldOut) throw new BadRequestException(`${item.name} is sold out`);
      if (l.quantity < 1 || l.quantity > 50) throw new BadRequestException('Quantity must be 1–50');
      const totalQty = input.lines.filter((x) => x.menuItemId === l.menuItemId).reduce((a, x) => a + x.quantity, 0);
      if (item.maxPerOrder && totalQty > item.maxPerOrder) throw new BadRequestException({ message: `${item.name}: at most ${item.maxPerOrder} per order`, code: 'QUANTITY_LIMIT' });
      if (item.brandId && eligibleBrands.length && !eligibleBrands.some((b) => b.id === item.brandId)) throw new BadRequestException(`${item.name} is from a brand not served at this kitchen`);
      if (item.brandId) {
        const b = brandRows.get(item.brandId);
        if (b && !brandSellable(b, loc.regionId, input.channel)) throw new BadRequestException({ message: `${item.name} (${b.name}) is not available here right now`, code: 'BRAND_NOT_AVAILABLE' });
      }
      const mods = this.resolveModifiers(item, l.modifierOptionIds || []);
      const modifiersCents = mods.reduce((a, m) => a + m.priceCents, 0);
      snapLines.push({ menuItemId: item.id, name: item.name, brandId: item.brandId, stationCode: item.stationCode, quantity: l.quantity, unitPriceCents: item.priceCents, modifiersCents, lineTotalCents: (item.priceCents + modifiersCents) * l.quantity, modifiers: mods, specialInstructions: l.specialInstructions, taxCategory: item.taxCategory });
    }
    const subtotalCents = snapLines.reduce((a, l) => a + l.lineTotalCents, 0);
    if (subtotalCents < loc.minOrderCents) throw new BadRequestException(`Minimum order is ${loc.minOrderCents} cents`);

    // promotions
    let discountCents = 0;
    let promotionFunder: 'MERCHANT' | 'PLATFORM' | 'SPLIT' | null = null;
    let promotionPlatformShareCents = 0;
    let couponId: string | null = null;
    let freeDelivery = false;
    if (input.promoCode) {
      const promo = await this.growth.validateCoupon(input.promoCode, { locationId: loc.id, channel: input.channel, subtotalCents, userId: input.userId }, tx);
      discountCents = promo.discountCents;
      promotionFunder = promo.platformSharePct !== null && promo.platformSharePct !== undefined && promo.platformSharePct > 0 && promo.platformSharePct < 100 ? 'SPLIT' : promo.funder;
      // 9.6 — who pays for the discount: all platform, all merchant, or a split
      promotionPlatformShareCents = promotionFunder === 'SPLIT' ? Math.round((discountCents * promo.platformSharePct!) / 100) : promotionFunder === 'PLATFORM' ? discountCents : 0;
      couponId = promo.couponId;
      freeDelivery = promo.freeDelivery;
    }

    // membership benefits
    const membership = input.userId ? await this.growth.activeMembership(input.userId, tx) : null;

    // delivery
    let deliveryFeeCents = 0;
    let deliveryProviderCostCents = 0;
    let deliveryQuoteId: string | null = null;
    let deliveryExpiresAt: Date | null = null;
    let deliveryFleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM' = loc.deliveryFleet;
    let etaMinutes = loc.defaultPrepMinutes + (load?.level === 'BUSY' ? load.extraMinutes : 0);
    if (load?.level === 'BUSY') warnings.push(`The kitchen is busy: about ${load.extraMinutes} extra minutes`);
    if (input.fulfillmentType === 'DELIVERY') {
      if (!input.deliveryAddress) throw new BadRequestException('Delivery address required');
      if (scheduledFor && !sim) await this.delivery.assertWindow(loc, scheduledFor, tx);
      const q = await this.delivery.quoteForLocation(loc.id, input.deliveryAddress, subtotalCents, input.tipCents || 0, tx, scheduledFor).catch((e: Error) => { const r = (e as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined; throw new BadRequestException({ message: e.message, code: r?.code || 'DELIVERY_UNAVAILABLE' }); });
      if (q.etaParts.courierWait >= 10) warnings.push('Couriers are busy nearby; delivery may take a little longer');
      if (q.etaParts.restriction) warnings.push(`Delivery times are extended by ${q.etaParts.restriction} minutes right now`);
      deliveryFeeCents = q.retailFeeCents;
      deliveryProviderCostCents = q.providerCostCents;
      deliveryQuoteId = q.providerQuoteId;
      deliveryExpiresAt = q.expiresAt;
      deliveryFleet = q.fleet;
      etaMinutes = etaMinutes + q.etaMinutes;
      if (await this.freeDeliveryForAll(tx)) {
        // platform-wide $0 delivery: the diner pays nothing, the full courier cost is a platform subsidy
        deliveryFeeCents = 0;
      } else if (freeDelivery || (membership?.benefits.freeDeliveryAboveCents !== undefined && subtotalCents >= membership.benefits.freeDeliveryAboveCents)) {
        warnings.push('Delivery fee waived');
        deliveryFeeCents = 0;
      }
    }

    // fees, tax, tip
    const terms = await this.contracts.termsFor(loc.id, input.channel, now, tx, input.fulfillmentType === 'DELIVERY' || input.fulfillmentType === 'PICKUP' || input.fulfillmentType === 'DINE_IN' ? input.fulfillmentType : undefined);
    // service fee applies to marketplace delivery orders only (pickup never carries it); members have it waived
    // 9.2 — configurable customer fees (setting `fees.customer`); members can have the service fee waived
    const feeRules = sim?.feeRules || (await this.settings.getObject('fees.customer', DEFAULT_CUSTOMER_FEES));
    const fees = computeCustomerFees(feeRules, { channel: input.channel, fulfillmentType: input.fulfillmentType, subtotalCents, itemCount: snapLines.reduce((a, l) => a + l.quantity, 0), locationPackagingCents: loc.packagingFeeCents, serviceFeeWaived: !!membership?.benefits.serviceFeeWaived });
    const serviceFeeCents = fees.serviceFeeCents;
    const smallOrderFeeCents = fees.smallOrderFeeCents;
    const packagingFeeCents = fees.packagingFeeCents;
    if (smallOrderFeeCents) warnings.push(`Small-order fee applies under ${(feeRules.smallOrder.thresholdCents / 100).toFixed(2)}`);
    const taxableCents = Math.max(0, subtotalCents - discountCents);
    // 9.5 — tax by item category (discount spread across lines); one category at the location rate = the old flat calculation
    const tax = await this.taxForLines(loc, snapLines, discountCents, subtotalCents, tx, sim?.taxRates);
    const taxCents = tax.taxCents;
    const tipCents = Math.max(0, input.tipCents || 0);
    const commissionCents = bps(taxableCents, terms.commissionBps);

    // credits & loyalty (reduce what the card pays; recorded as platform-funded discount lines)
    let creditsCents = 0;
    let loyaltyCents = 0;
    if (input.userId) {
      if (input.useCreditsCents) creditsCents = Math.min(input.useCreditsCents, await this.payments.availableCredit(input.userId, tx));
      if (input.useLoyaltyPoints) loyaltyCents = Math.min(input.useLoyaltyPoints, await this.growth.loyaltyBalance(input.userId, tx)); // 1 point = 1 cent
    }
    const grossTotal = taxableCents + taxCents + serviceFeeCents + smallOrderFeeCents + packagingFeeCents + deliveryFeeCents + tipCents;
    const totalCents = Math.max(0, grossTotal - creditsCents - loyaltyCents);

    const promiseAt = scheduledFor ? scheduledFor : addMinutes(now, etaMinutes);
    const expiresAt = deliveryExpiresAt && deliveryExpiresAt < addMinutes(now, QUOTE_TTL_MINUTES) ? deliveryExpiresAt : addMinutes(now, QUOTE_TTL_MINUTES);

    const snapshot = {
      lines: snapLines,
      currency: loc.currency,
      taxRateBps: loc.taxRateBps,
      terms: { contractId: terms.contractId, planCode: terms.planCode, commissionBps: terms.commissionBps, processingBps: terms.processingBps, processingFixedCents: terms.processingFixedCents },
      commissionCents,
      couponId,
      promotionFunder,
      promotionPlatformShareCents,
      taxLines: tax.lines,
      fees: { serviceFeeCents, smallOrderFeeCents, packagingFeeCents, rules: feeRules },
      menuVersions: [...new Set(snapLines.map((l) => l.menuItemId))].length ? await this.catalog.menuVersionsFor([...items.values()].map((i) => i.id)) : {},
      creditsCents,
      loyaltyCents,
      deliveryFleet,
      deliveryProviderCostCents,
      platformDeliverySubsidyCents: Math.max(0, deliveryProviderCostCents - deliveryFeeCents),
      deliveryAddress: input.deliveryAddress || null,
      etaMinutes,
      membershipId: membership?.id || null,
      // 11.8 — the policies the customer accepted with this order
      policies: await this.settings.getObject('policies.versions', { cancellation: '2026-11-01', refund: '2026-11-01', terms: '2026-11-01' }),
    };
    if (sim) return { subtotalCents, discountCents, taxCents, serviceFeeCents, smallOrderFeeCents, packagingFeeCents, deliveryFeeCents, tipCents, creditsCents, loyaltyCents, totalCents, commissionCents, promotionFunder, promotionPlatformShareCents, taxLines: tax.lines, lines: snapLines, warnings };
    const [q] = await tx
      .insert(quotes)
      .values({ locationId: loc.id, userId: input.userId ?? null, channel: input.channel, fulfillmentType: input.fulfillmentType, currency: loc.currency, snapshot, subtotalCents, discountCents, taxCents, serviceFeeCents, smallOrderFeeCents, packagingFeeCents, deliveryFeeCents, tipCents, totalCents, promoCode: input.promoCode?.toUpperCase() ?? null, promotionFunder, deliveryQuoteId, deliveryProviderCostCents, scheduledFor, promiseAt, expiresAt })
      .returning();
    return this.present(q, warnings);
  }

  present(q: typeof quotes.$inferSelect, warnings: string[] = []) {
    const s = q.snapshot as { lines: QuoteSnapshotLine[]; creditsCents: number; loyaltyCents: number; commissionCents: number };
    return {
      id: q.id,
      locationId: q.locationId,
      channel: q.channel,
      fulfillmentType: q.fulfillmentType,
      currency: q.currency,
      lines: s.lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifierOptionIds: l.modifiers.map((m) => m.id), specialInstructions: l.specialInstructions })),
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      taxCents: q.taxCents,
      serviceFeeCents: q.serviceFeeCents,
      smallOrderFeeCents: q.smallOrderFeeCents,
      packagingFeeCents: q.packagingFeeCents,
      deliveryFeeCents: q.deliveryFeeCents,
      tipCents: q.tipCents,
      creditsCents: s.creditsCents,
      loyaltyCents: s.loyaltyCents,
      totalCents: q.totalCents,
      promiseAt: q.promiseAt?.toISOString() ?? null,
      scheduledFor: q.scheduledFor?.toISOString() ?? null,
      expiresAt: q.expiresAt.toISOString(),
      deliveryQuoteId: q.deliveryQuoteId,
      warnings,
    };
  }

  /** Re-price an expired quote with the same inputs (quote expiry and revalidation). */
  async revalidate(quoteId: string, userId?: string | null) {
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    const s = q.snapshot as { lines: QuoteSnapshotLine[]; deliveryAddress: Address | null; creditsCents: number; loyaltyCents: number };
    return this.quote({
      locationId: q.locationId,
      channel: q.channel as Channel,
      fulfillmentType: q.fulfillmentType as Fulfillment,
      lines: s.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifiers.map((m) => m.id), specialInstructions: l.specialInstructions })),
      scheduledFor: q.scheduledFor?.toISOString() ?? null,
      tipCents: q.tipCents,
      promoCode: q.promoCode ?? undefined,
      deliveryAddress: s.deliveryAddress ?? undefined,
      useCreditsCents: s.creditsCents,
      useLoyaltyPoints: s.loyaltyCents,
      userId: userId ?? q.userId,
    });
  }

  async get(quoteId: string) {
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    return this.present(q, q.expiresAt < new Date() ? ['Quote expired; revalidate before checkout'] : []);
  }

  private resolveModifiers(item: ResolvedItem, optionIds: string[]) {
    const chosen: { id: string; name: string; priceCents: number }[] = [];
    for (const g of item.modifierGroups) {
      const picked = g.options.filter((o) => optionIds.includes(o.id));
      if (g.required && picked.length < Math.max(1, g.minSelect)) throw new BadRequestException(`${item.name}: choose ${g.name}`);
      if (picked.length < g.minSelect) throw new BadRequestException(`${item.name}: choose at least ${g.minSelect} ${g.name}`);
      if (picked.length > g.maxSelect) throw new BadRequestException(`${item.name}: choose at most ${g.maxSelect} ${g.name}`);
      for (const o of picked) {
        if (o.soldOut) throw new BadRequestException(`${o.name} is sold out`);
        chosen.push({ id: o.id, name: o.name, priceCents: o.priceCents });
      }
    }
    const known = new Set(item.modifierGroups.flatMap((g) => g.options.map((o) => o.id)));
    const unknown = optionIds.filter((id) => !known.has(id));
    if (unknown.length) throw new BadRequestException(`Unknown modifier option for ${item.name}`);
    return chosen;
  }

  private async openAt(loc: typeof locations.$inferSelect, at: Date, tx: DbOrTx): Promise<boolean> {
    // holiday closures, temporary closures and special hours override regular hours
    const closure = (await tx.select().from(locationClosures).where(and(eq(locationClosures.locationId, loc.id), lte(locationClosures.startsAt, at), gt(locationClosures.endsAt, at), inArray(locationClosures.service, ['ALL', 'ORDERING']))).orderBy(locationClosures.createdAt))[0];
    if (closure?.kind === 'CLOSED') return false;
    if (closure?.kind === 'SPECIAL_HOURS' && closure.opens && closure.closes) return isWithin(localParts(at, loc.timezone).hhmm, closure.opens, closure.closes);
    const hours = await tx.select().from(openingHours).where(and(eq(openingHours.locationId, loc.id)));
    if (!hours.length) return true; // no hours configured = always open (pilot default)
    const lp = localParts(at, loc.timezone);
    const todays = hours.filter((h) => h.dayOfWeek === lp.dayOfWeek && (h.service === 'ALL' || h.service === 'ORDERING'));
    if (todays.some((h) => isWithin(lp.hhmm, h.opens, h.closes))) return true;
    // overnight window from previous day
    const prevDay = (lp.dayOfWeek + 6) % 7;
    const prev = hours.filter((h) => h.dayOfWeek === prevDay && h.closes <= h.opens);
    return prev.some((h) => lp.hhmm < h.closes);
  }

  /** 11.1 — next time ordering opens (regular hours, closures and special hours), scanning up to 7 days in 15-minute steps. */
  private async nextOpenAt(loc: typeof locations.$inferSelect, from: Date, tx: DbOrTx): Promise<string | null> {
    const hours = await tx.select().from(openingHours).where(eq(openingHours.locationId, loc.id));
    const closures = await tx.select().from(locationClosures).where(and(eq(locationClosures.locationId, loc.id), gt(locationClosures.endsAt, from), inArray(locationClosures.service, ['ALL', 'ORDERING'])));
    if (!hours.length && !closures.length) return null;
    let t = new Date(Math.ceil(from.getTime() / 900_000) * 900_000);
    for (let i = 0; i < 7 * 96; i++, t = new Date(t.getTime() + 900_000)) {
      const c = closures.find((x) => x.startsAt <= t && x.endsAt > t);
      const lp = localParts(t, loc.timezone);
      if (c?.kind === 'CLOSED') continue;
      if (c?.kind === 'SPECIAL_HOURS' && c.opens && c.closes) { if (isWithin(lp.hhmm, c.opens, c.closes)) return t.toISOString(); continue; }
      if (!hours.length) return t.toISOString();
      if (hours.some((h) => h.dayOfWeek === lp.dayOfWeek && (h.service === 'ALL' || h.service === 'ORDERING') && isWithin(lp.hhmm, h.opens, h.closes))) return t.toISOString();
    }
    return null;
  }

  /** Tax per category: location rate → tax_rates (location, then region, then platform) → simulation overrides. */
  private async taxForLines(loc: typeof locations.$inferSelect, lines: QuoteSnapshotLine[], discountCents: number, subtotalCents: number, tx: DbOrTx, simRates?: Record<string, number>) {
    const cats = [...new Set(lines.map((l) => l.taxCategory || 'STANDARD'))];
    const rates = await tx.select().from(taxRates).where(and(inArray(taxRates.category, cats), or(eq(taxRates.locationId, loc.id), and(isNull(taxRates.locationId), or(eq(taxRates.region, loc.region), isNull(taxRates.region))))));
    const rateFor = (c: string) => {
      if (simRates && simRates[c] !== undefined) return simRates[c];
      if (c === 'EXEMPT') return 0;
      const pick = rates.find((r) => r.category === c && r.locationId === loc.id) || rates.find((r) => r.category === c && !r.locationId && r.region === loc.region) || rates.find((r) => r.category === c && !r.locationId && !r.region);
      return pick ? pick.rateBps : loc.taxRateBps;
    };
    const out: { category: string; rateBps: number; taxableCents: number; taxCents: number }[] = [];
    for (const c of cats) {
      const gross = lines.filter((l) => (l.taxCategory || 'STANDARD') === c).reduce((a, l) => a + l.lineTotalCents, 0);
      const share = subtotalCents ? Math.round((discountCents * gross) / subtotalCents) : 0;
      const taxable = Math.max(0, gross - share);
      const rate = rateFor(c);
      out.push({ category: c, rateBps: rate, taxableCents: taxable, taxCents: bps(taxable, rate) });
    }
    if (out.length === 1) { out[0].taxableCents = Math.max(0, subtotalCents - discountCents); out[0].taxCents = bps(out[0].taxableCents, out[0].rateBps); }
    return { taxCents: out.reduce((a, t) => a + t.taxCents, 0), lines: out };
  }

  /** Helper used by UI: convert a local "YYYY-MM-DD HH:MM" at the location into an ISO instant. */
  /** Platform setting `fees.free_delivery` (default on): diners pay a $0 delivery fee on every order. */
  private async freeDeliveryForAll(tx: DbOrTx) {
    const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.key, 'fees.free_delivery')).limit(1);
    return row ? row.value !== false : true;
  }

  async localToIso(locationId: string, ymd: string, hhmm: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    return { iso: zonedTimeToUtc(ymd, hhmm, loc.timezone).toISOString() };
  }
}
