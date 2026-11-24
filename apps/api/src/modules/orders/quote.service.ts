import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FirstPartyService } from '../../core/first-party.service';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { brands, chefProfiles, taxRates, customerRestrictions, menuCategories, menuItems, menus, orders, locationClosures, locations, openingHours, platformSettings, quotes } from '../../db/schema';
import { brandSellable } from '../../common/brand-rules';
import { DEFAULT_PAYMENT_METHODS, enabledMethods, type AppliedPromotion, type PaymentMethodsConfig } from '@gutad/shared';
import { giftBalance } from '../growth/gift-tender';
import { assertCashLimit, creditAllowance } from '../customers/limits';
import { cartCompatibility, chefDishTitle, chefRequestCode, DEFAULT_CHEF_NETWORK_FEES, DEFAULT_CHEF_POLICY, type ChefNetworkFees, type ChefPolicy, evaluateCustomization, modifierLabel, computeCustomerFees, DEFAULT_CUSTOMER_FEES, type CustomerFeeRules } from '@gutad/shared';
import { SettingsService } from '../../core/settings.service';
import { CatalogService, ResolvedItem } from '../catalog/catalog.service';
import { ContractsService } from '../contracts/contracts.service';
import { DeliveryService } from '../delivery/delivery.service';
import { GrowthService } from '../growth/growth.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { LocationLoadService } from '../kitchen/location-load.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PaymentsService } from '../payments/payments.service';
import { ChefCalendarService } from '../chefs/chef-calendar.service';
import { acceptedChefQuote } from '../chefs/chef-requests.service';
import { randomUUID } from 'node:crypto';
import { addMinutes, bps, isWithin, localParts, zonedTimeToUtc } from '../../common/utils';
import { taxEngine } from './tax-provider';
import type { Address } from '../delivery/providers/delivery-provider';

export type Channel = 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR' | 'PARTNER' | 'PHONE' | 'WALK_IN' | 'CAMPUS' | 'CORPORATE' | 'API' | 'KIOSK';
export type Fulfillment = 'PICKUP' | 'DELIVERY' | 'DINE_IN' | 'CATERING';

export interface QuoteInput {
  locationId: string;
  channel: Channel;
  fulfillmentType: Fulfillment;
  /** chefRequestQuoteId: a line from an accepted Chef Network special-request quote (priced from the quote) */
  lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[]; specialInstructions?: string; chefRequestQuoteId?: string }[];
  scheduledFor?: string | null;
  tipCents?: number;
  promoCode?: string;
  deliveryAddress?: Address;
  useCreditsCents?: number;
  useLoyaltyPoints?: number;
  /** 25.9 / 11.6 pay part of the order from the gift balance in the customer's wallet */
  useGiftBalance?: boolean;
  userId?: string | null;
  /** Chef Network: the checkout session; a new quote replaces this session's earlier capacity hold */
  holdKey?: string | null;
  /** Chef Network: price a change to this paid order (its portions don't count against the new date) */
  replacesOrderId?: string | null;
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
  modifiers: { id: string; name: string; priceCents: number; qty?: number }[];
  specialInstructions?: string;
  taxCategory?: string;
  /** effective allergens and dietary labels after customization (Chef Network dishes) */
  allergens?: string[];
  dietaryTags?: string[];
  prepMinutesDelta?: number;
  /** Gutad Chef Network special request: the accepted chef quote this line was sold from */
  chefRequestQuoteId?: string;
}

/** Simulation inputs (9.8): draft fee rules, tax rates and item prices; nothing is stored. */
export interface SimulationResult { promotions: AppliedPromotion[]; giftCents: number; subtotalCents: number; discountCents: number; taxCents: number; serviceFeeCents: number; smallOrderFeeCents: number; packagingFeeCents: number; deliveryFeeCents: number; tipCents: number; creditsCents: number; loyaltyCents: number; totalCents: number; commissionCents: number; promotionFunder: string | null; promotionPlatformShareCents: number; taxLines: { category: string; rateBps: number; taxableCents: number; taxCents: number }[]; lines: QuoteSnapshotLine[]; warnings: string[] }
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
    private readonly locationLoad: LocationLoadService,
    private readonly payments: PaymentsService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SettingsService,
    private readonly chefCalendar: ChefCalendarService,
    private readonly firstParty: FirstPartyService,
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
    // Gutad first-party: the kill switch stops new orders; the seller label is shown at checkout
    const firstParty = await this.firstParty.isFirstPartyOrg(loc.organizationId, tx);
    const fpRules = firstParty ? await this.firstParty.rulesFor(loc.city) : null;
    if (!sim && fpRules && !fpRules.enabled) throw new BadRequestException({ message: 'This kitchen is not taking orders right now', code: 'FIRST_PARTY_OFF' });
    // plan gating: ordering for every order, delivery on top for delivery orders
    await this.entitlements.assertLocation(loc.id, 'ordering', 'customer', tx);
    if (input.fulfillmentType === 'DELIVERY') await this.entitlements.assertLocation(loc.id, 'delivery', 'customer', tx);
    if (!sim && loc.isPaused && (!loc.pausedUntil || loc.pausedUntil > new Date())) throw new BadRequestException({ message: loc.pausedReason || 'Restaurant is temporarily paused', code: 'PAUSED', reopensAt: loc.pausedUntil });
    // 10.8 — account restrictions
    const restr = input.userId && !sim ? await tx.select({ kind: customerRestrictions.kind, reason: customerRestrictions.reason }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, input.userId), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), gt(customerRestrictions.expiresAt, new Date())))) : [];
    if (restr.some((r) => r.kind === 'ORDERING_BLOCKED')) throw new ForbiddenException({ message: 'Ordering is paused on this account. See Account → Help to appeal.', code: 'ACCOUNT_RESTRICTED' });
    if (input.promoCode && restr.some((r) => r.kind === 'PROMOTIONS_BLOCKED')) throw new BadRequestException({ message: 'Promotions are not available on this account', code: 'PROMOTIONS_BLOCKED' });
    // 18.2 payment methods enabled for this region and channel
    if (!sim && (input.useCreditsCents || input.useLoyaltyPoints || input.useGiftBalance)) {
      const methods = enabledMethods(await this.settings.getObject<PaymentMethodsConfig>('payments.methods', DEFAULT_PAYMENT_METHODS), input.channel, loc.regionId);
      if (input.useCreditsCents && !methods.includes('CREDITS')) throw new BadRequestException({ message: 'Credits can’t be used for this order', code: 'METHOD_DISABLED' });
      if (input.useLoyaltyPoints && !methods.includes('LOYALTY')) throw new BadRequestException({ message: 'Points can’t be used for this order', code: 'METHOD_DISABLED' });
      if (input.useGiftBalance && !methods.includes('GIFT_CARD')) throw new BadRequestException({ message: 'Gift cards can’t be used for this order', code: 'METHOD_DISABLED' });
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
      // Gutad Chef Network: the chef's cooking calendar decides (notice, cutoff, cooking days, pauses, times, capacity)
      if (loc.chefKitchen && !sim) {
        // checked with the cart below
      } else {
      // 11.5 — lead time and slot capacity for scheduled orders
      const lead = Math.max(loc.defaultPrepMinutes, loc.scheduleLeadMinutes ?? 0);
      if (scheduledFor < addMinutes(now, lead)) throw new BadRequestException({ message: `Schedule at least ${lead} minutes ahead`, code: 'SCHEDULE_TOO_SOON', earliestAt: addMinutes(now, lead) });
      if (!sim?.ignoreHours && !(await this.openAt(loc, scheduledFor, tx))) throw new BadRequestException({ message: 'Restaurant is closed at the scheduled time', code: 'CLOSED', nextOpenAt: await this.nextOpenAt(loc, scheduledFor, tx) });
      if (!sim && loc.scheduledSlotCapacity) {
        const slot = new Date(Math.floor(scheduledFor.getTime() / 900_000) * 900_000);
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.locationId, loc.id), sql`${orders.scheduledFor} >= ${slot.toISOString()} and ${orders.scheduledFor} < ${new Date(slot.getTime() + 900_000).toISOString()}`, sql`${orders.status} not in ('CANCELED','REJECTED')`));
        if (n >= loc.scheduledSlotCapacity) throw new BadRequestException({ message: 'That time is fully booked; pick another slot', code: 'SLOT_FULL' });
      }
      }
    } else if (loc.chefKitchen && !sim) {
      throw new BadRequestException({ message: 'Chef dishes are cooked to order. Choose a day and time.', code: 'SCHEDULE_REQUIRED' });
    } else if (!sim?.ignoreHours && !(await this.openAt(loc, now, tx))) {
      throw new BadRequestException({ message: 'Restaurant is closed right now; schedule for later', code: 'CLOSED', nextOpenAt: await this.nextOpenAt(loc, now, tx) });
    }
    // 13.7 kitchen auto-throttle
    // 13.7-L restaurants without a production kitchen: load from open orders × prep time
    const load = sim ? null : (await this.kitchen.loadFor(loc.kitchenId, tx)) ?? (await this.locationLoad.loadFor(loc, tx));
    if (load?.level === 'OVERLOADED' && !scheduledFor) throw new BadRequestException({ message: loc.kitchenId ? 'The kitchen is at capacity right now; schedule for later' : 'The restaurant is at capacity right now; schedule for later', code: 'KITCHEN_BUSY' });

    // items & modifiers
    const items = await this.catalog.resolveItems(loc.id, input.channel, input.lines.map((l) => l.menuItemId), sim?.ignoreHours ? undefined : scheduledFor ?? now);
    if (sim?.priceOverrides) for (const [id, cents] of Object.entries(sim.priceOverrides)) { const it = items.get(id); if (it) it.priceCents = cents; }
    const eligibleBrands = await this.kitchen.eligibleBrands(loc.id, tx);
    const brandIds = [...new Set([...items.values()].map((i) => i.brandId).filter((x): x is string => !!x))];
    const brandRows = new Map((brandIds.length ? await tx.select().from(brands).where(inArray(brands.id, brandIds)) : []).map((b) => [b.id, b]));
    const snapLines: QuoteSnapshotLine[] = [];
    // Gutad Chef Network: lines carry the branded title ("Gutad's Spaghetti — by Bestie Carlos") onto orders, tickets and receipts
    const chefName = loc.chefKitchen ? ((await tx.select({ n: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.locationId, loc.id)).limit(1))[0]?.n ?? null) : null;
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
      // Gutad Chef Network special request: price, quantity, date and labels come from the chef's accepted quote
      if (l.chefRequestQuoteId) {
        const sq = await this.specialRequestLine(tx, l, item, loc, scheduledFor, input.userId ?? null, !!sim);
        snapLines.push({ ...sq, name: `${chefName ? chefDishTitle(item.name, chefName) : item.name} · special request`, brandId: item.brandId, stationCode: item.stationCode, taxCategory: item.taxCategory });
        continue;
      }
      const ev = this.resolveModifiers(item, l.modifierOptionIds || []);
      const mods = ev.mods;
      const modifiersCents = mods.reduce((a, m) => a + m.priceCents, 0);
      snapLines.push({ menuItemId: item.id, name: chefName ? chefDishTitle(item.name, chefName) : item.name, brandId: item.brandId, stationCode: item.stationCode, quantity: l.quantity, unitPriceCents: item.priceCents, modifiersCents, lineTotalCents: (item.priceCents + modifiersCents) * l.quantity, modifiers: mods, specialInstructions: l.specialInstructions, taxCategory: item.taxCategory, ...(ev.customized ? { allergens: ev.allergens, dietaryTags: ev.dietaryTags, prepMinutesDelta: ev.prepMinutesDelta } : {}) });
    }
    const subtotalCents = snapLines.reduce((a, l) => a + l.lineTotalCents, 0);
    const capacityLines = snapLines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity }));
    // a change to a paid order: only its customer, at the same kitchen; its own portions don't count
    if (input.replacesOrderId && !sim) {
      const [orig] = await tx.select({ userId: orders.userId, locationId: orders.locationId, prepaid: orders.prepaid }).from(orders).where(eq(orders.id, input.replacesOrderId)).limit(1);
      if (!orig || !input.userId || orig.userId !== input.userId || orig.locationId !== loc.id || !orig.prepaid) throw new BadRequestException({ message: 'This order can’t be changed here', code: 'NOT_AMENDABLE' });
      if (input.lines.some((l) => l.chefRequestQuoteId)) throw new BadRequestException({ message: 'A special request can’t be added to a changed order. Order it on its own.', code: 'HAS_SPECIAL_REQUEST' });
    }
    if (loc.chefKitchen && scheduledFor && !sim) await this.chefCalendar.assertOrderable(loc.id, scheduledFor, capacityLines, input.holdKey, tx, input.replacesOrderId);
    if (subtotalCents < loc.minOrderCents) throw new BadRequestException(`Minimum order is ${loc.minOrderCents} cents`);

    // 25.1–25.3 promotions: automatic offers and the typed code, with eligibility and stacking rules
    // 9.6 / 25.4 — each promotion carries its funding: all platform, all merchant, or a split share
    const promo = await this.growth.evaluatePromotions({ loc, channel: input.channel, lines: snapLines, subtotalCents, userId: input.userId, code: input.promoCode, blocked: restr.some((r) => r.kind === 'PROMOTIONS_BLOCKED'), simulate: !!sim }, tx);
    const discountCents = promo.discountCents;
    const promotionFunder = promo.funder;
    const promotionPlatformShareCents = promo.platformShareCents;
    const couponId = promo.applied[0]?.promotionId ?? null;
    const freeDelivery = promo.freeDelivery;
    for (const p of promo.applied) if (p.automatic) warnings.push(`${p.name} applied`);
    warnings.push(...promo.warnings);

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
    const terms = { ...(await this.contracts.termsFor(loc.id, input.channel, now, tx, input.fulfillmentType === 'DELIVERY' || input.fulfillmentType === 'PICKUP' || input.fulfillmentType === 'DINE_IN' ? input.fulfillmentType : undefined)) };
    // service fee applies to marketplace delivery orders only (pickup never carries it); members have it waived
    // 9.2 — configurable customer fees (setting `fees.customer`); members can have the service fee waived
    // Gutad Chef Network orders use their own fee scope and commission (setting fees.chef_network)
    const chefFees = loc.chefKitchen ? await this.settings.getObject<ChefNetworkFees>('fees.chef_network', DEFAULT_CHEF_NETWORK_FEES) : null;
    if (chefFees) terms.commissionBps = chefFees.commissionBps;
    // Gutad is the seller of record for its own food: no commission to itself
    if (firstParty) terms.commissionBps = 0;
    const feeRules = sim?.feeRules || chefFees?.customer || (await this.settings.getObject('fees.customer', DEFAULT_CUSTOMER_FEES));
    const fees = computeCustomerFees(feeRules, { channel: input.channel, fulfillmentType: input.fulfillmentType, subtotalCents, itemCount: snapLines.reduce((a, l) => a + l.quantity, 0), locationPackagingCents: loc.packagingFeeCents, serviceFeeWaived: !!membership?.benefits.serviceFeeWaived });
    const serviceFeeCents = fees.serviceFeeCents;
    const smallOrderFeeCents = fees.smallOrderFeeCents;
    const packagingFeeCents = fees.packagingFeeCents;
    if (smallOrderFeeCents) warnings.push(`Small-order fee applies under ${(feeRules.smallOrder.thresholdCents / 100).toFixed(2)}`);
    const taxableCents = Math.max(0, subtotalCents - discountCents);
    // 9.5 — tax by item category (discount spread across lines); one category at the location rate = the old flat calculation
    const builtinTax = await this.taxForLines(loc, snapLines, discountCents, subtotalCents, tx, sim?.taxRates);
    // 9.5-X — external tax engine (TAX_PROVIDER) when configured; simulations keep the draft rate table
    const tax = sim ? { ...builtinTax, engine: 'builtin' as string, warning: undefined as string | undefined } : await taxEngine().resolve({ locationId: loc.id, currency: loc.currency, from: { line1: loc.addressLine1, city: loc.city, region: loc.region, postalCode: loc.postalCode, country: loc.country }, to: input.fulfillmentType === 'DELIVERY' && input.deliveryAddress ? input.deliveryAddress : { line1: loc.addressLine1, city: loc.city, region: loc.region, postalCode: loc.postalCode, country: loc.country }, lines: builtinTax.lines.map((l) => ({ category: l.category, taxableCents: l.taxableCents })) }, builtinTax);
    if (tax.warning) warnings.push(tax.warning);
    const taxCents = tax.taxCents;
    const tipCents = Math.max(0, input.tipCents || 0);
    const commissionCents = bps(taxableCents, terms.commissionBps);

    // 11.6 payment mix: credits, then points, then gift balance; the card pays what is left
    let creditsCents = 0;
    let loyaltyCents = 0;
    let giftCents = 0;
    const grossTotal = taxableCents + taxCents + serviceFeeCents + smallOrderFeeCents + packagingFeeCents + deliveryFeeCents + tipCents;
    if (input.userId) {
      if (input.useCreditsCents) creditsCents = Math.min(input.useCreditsCents, await this.payments.availableCredit(input.userId, tx), grossTotal);
      // 10.8-L per-customer credit limit: cap what this order may use and say so
      if (creditsCents && !sim) { const allow = await creditAllowance(tx, input.userId); if (creditsCents > allow) { creditsCents = allow; warnings.push(`Credits on this account are limited; up to $${(allow / 100).toFixed(2)} applied`); } }
      if (input.useLoyaltyPoints) loyaltyCents = Math.min(input.useLoyaltyPoints, await this.growth.loyaltyBalance(input.userId, tx), grossTotal - creditsCents); // 1 point = 1 cent
      if (input.useGiftBalance) giftCents = Math.min(await giftBalance(tx, input.userId), grossTotal - creditsCents - loyaltyCents);
    }
    const totalCents = Math.max(0, grossTotal - creditsCents - loyaltyCents - giftCents);
    // 10.8-L per-customer cash / pay-later limit on what the customer owes
    if (input.userId && !sim) await assertCashLimit(tx, input.userId, totalCents);

    const promiseAt = scheduledFor ? scheduledFor : addMinutes(now, etaMinutes);
    const expiresAt = deliveryExpiresAt && deliveryExpiresAt < addMinutes(now, QUOTE_TTL_MINUTES) ? deliveryExpiresAt : addMinutes(now, QUOTE_TTL_MINUTES);

    const snapshot = {
      lines: snapLines,
      currency: loc.currency,
      taxRateBps: loc.taxRateBps,
      terms: { contractId: terms.contractId, planCode: terms.planCode, commissionBps: terms.commissionBps, processingBps: terms.processingBps, processingFixedCents: terms.processingFixedCents },
      commissionCents,
      seller: firstParty ? { firstParty: true, label: fpRules?.label || 'Sold by Gutad' } : null,
      couponId,
      promotions: promo.applied,
      promotionIds: promo.applied.map((p) => p.promotionId),
      promotionFunder,
      promotionPlatformShareCents,
      grossTotalCents: grossTotal,
      giftCents,
      taxLines: tax.lines,
      taxEngine: tax.engine,
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
      ...(input.replacesOrderId ? { replacesOrderId: input.replacesOrderId } : {}),
      policies: await this.settings.getObject('policies.versions', { cancellation: '2026-11-01', refund: '2026-11-01', terms: '2026-11-01' }),
    };
    const quoteId = randomUUID();
    // Chef Network: hold the date's capacity while the customer checks out (released when the quote lapses)
    if (loc.chefKitchen && scheduledFor && !sim) {
      const h = await this.chefCalendar.hold({ locationId: loc.id, scheduledFor, lines: capacityLines, quoteId, holdKey: input.holdKey, expiresAt, excludeOrderId: input.replacesOrderId });
      // the cancellation terms the customer accepts: full refund until the date's cutoff, then the chef's late refund
      const policy = await this.settings.getObject<ChefPolicy>('chefs.policy', DEFAULT_CHEF_POLICY);
      const [cp] = await tx.select({ operating: chefProfiles.operating }).from(chefProfiles).where(eq(chefProfiles.locationId, loc.id)).limit(1);
      const chosen = (cp?.operating as { lateRefundPct?: number } | undefined)?.lateRefundPct;
      const lateRefundPct = Math.max(policy.lateRefundMinPct, Math.min(policy.lateRefundMaxPct, chosen ?? policy.lateRefundDefaultPct));
      Object.assign(snapshot, { chef: { freeCancelUntil: h.orderBy, lateRefundPct, acceptHours: policy.acceptHours } });
      if (h.remaining !== null && h.remaining <= 3) warnings.push(h.remaining ? `Only ${h.remaining} more portion${h.remaining === 1 ? '' : 's'} left for that day` : 'You’re getting the last portions for that day');
    }
    if (sim) return { promotions: promo.applied, giftCents, subtotalCents, discountCents, taxCents, serviceFeeCents, smallOrderFeeCents, packagingFeeCents, deliveryFeeCents, tipCents, creditsCents, loyaltyCents, totalCents, commissionCents, promotionFunder, promotionPlatformShareCents, taxLines: tax.lines, lines: snapLines, warnings };
    const [q] = await tx
      .insert(quotes)
      .values({ id: quoteId, locationId: loc.id, userId: input.userId ?? null, channel: input.channel, fulfillmentType: input.fulfillmentType, currency: loc.currency, snapshot, subtotalCents, discountCents, taxCents, serviceFeeCents, smallOrderFeeCents, packagingFeeCents, deliveryFeeCents, tipCents, totalCents, promoCode: input.promoCode?.toUpperCase() ?? null, promotionFunder, deliveryQuoteId, deliveryProviderCostCents, scheduledFor, promiseAt, expiresAt })
      .returning();
    return this.present(q, warnings);
  }

  present(q: typeof quotes.$inferSelect, warnings: string[] = []) {
    const s = q.snapshot as { seller?: { firstParty: boolean; label: string } | null; chef?: { freeCancelUntil: string | null; lateRefundPct: number }; lines: QuoteSnapshotLine[]; creditsCents: number; loyaltyCents: number; giftCents?: number; commissionCents: number; promotions?: AppliedPromotion[] };
    return {
      id: q.id,
      locationId: q.locationId,
      channel: q.channel,
      fulfillmentType: q.fulfillmentType,
      currency: q.currency,
      lines: s.lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiersCents: l.modifiersCents, lineTotalCents: l.lineTotalCents, modifierOptionIds: l.modifiers.map((m) => m.id), specialInstructions: l.specialInstructions, ...(l.chefRequestQuoteId ? { chefRequestQuoteId: l.chefRequestQuoteId } : {}) })),
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
      giftCents: s.giftCents || 0,
      totalCents: q.totalCents,
      // customers see the name, code and amount of each promotion (not the funding split)
      promotions: (s.promotions || []).map(({ platformShareCents: _p, funder: _f, ...p }) => p),
      paymentMix: { creditsCents: s.creditsCents || 0, loyaltyCents: s.loyaltyCents || 0, giftCents: s.giftCents || 0, cardCents: q.totalCents },
      promiseAt: q.promiseAt?.toISOString() ?? null,
      scheduledFor: q.scheduledFor?.toISOString() ?? null,
      expiresAt: q.expiresAt.toISOString(),
      deliveryQuoteId: q.deliveryQuoteId,
      // Gutad Chef Network: charged now; full refund until freeCancelUntil, then lateRefundPct
      seller: s.seller ?? null,
      chefTerms: s.chef ? { chargedNow: true, freeCancelUntil: s.chef.freeCancelUntil, lateRefundPct: s.chef.lateRefundPct } : null,
      warnings,
    };
  }

  /** Re-price an expired quote with the same inputs (quote expiry and revalidation). */
  async revalidate(quoteId: string, userId?: string | null) {
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    const s = q.snapshot as { lines: QuoteSnapshotLine[]; deliveryAddress: Address | null; creditsCents: number; loyaltyCents: number; giftCents?: number };
    return this.quote({
      locationId: q.locationId,
      channel: q.channel as Channel,
      fulfillmentType: q.fulfillmentType as Fulfillment,
      lines: s.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifiers.map((m) => m.id), specialInstructions: l.chefRequestQuoteId ? undefined : l.specialInstructions, chefRequestQuoteId: l.chefRequestQuoteId })),
      scheduledFor: q.scheduledFor?.toISOString() ?? null,
      tipCents: q.tipCents,
      promoCode: q.promoCode ?? undefined,
      deliveryAddress: s.deliveryAddress ?? undefined,
      useCreditsCents: s.creditsCents,
      useLoyaltyPoints: s.loyaltyCents,
      useGiftBalance: (s.giftCents || 0) > 0,
      userId: userId ?? q.userId,
    });
  }

  async get(quoteId: string) {
    const [q] = await this.db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    if (!q) throw new NotFoundException('Quote not found');
    return this.present(q, q.expiresAt < new Date() ? ['Quote expired; revalidate before checkout'] : []);
  }

  /**
   * Validates and prices customizations with the shared engine (defaults, quantities as repeated ids, conditional
   * groups, per-context rules, locked components) and returns the effective allergens and dietary labels.
   */
  private resolveModifiers(item: ResolvedItem, optionIds: string[]) {
    const r = evaluateCustomization(item.name, item.modifierGroups, optionIds, { allergens: item.allergens, dietaryTags: item.dietaryTags || [] });
    if (!r.ok) {
      const e = r.errors[0];
      throw new BadRequestException(/^Unknown option/.test(e) ? { message: `Unknown modifier option for ${item.name}`, code: 'OPTION_UNKNOWN' } : /sold out/.test(e) ? e : { message: e, code: 'CUSTOMIZATION_INVALID', errors: r.errors });
    }
    const customized = item.modifierGroups.some((g) => g.selectionType && g.selectionType !== 'CHOICE');
    const mods = r.chosen.map((c) => ({ id: c.id, name: modifierLabel(c), priceCents: c.priceCents, ...(c.qty > 1 ? { qty: c.qty } : {}) }));
    return { mods, customized, allergens: r.allergens, dietaryTags: r.dietaryTags, prepMinutesDelta: r.prepMinutesDelta };
  }

  /**
   * Reorder: rebuild a past order's lines as cart lines against today's menu. Unavailable or sold-out items and
   * special-request lines are removed (with the reason); options that no longer fit fall back to the dish's
   * defaults; current prices are used and changes are flagged. Chef kitchens get the next open date.
   */
  async rebuildCart(locationId: string, channel: Channel, lines: { menuItemId: string | null; name: string; quantity: number; unitPriceCents: number; modifierIds: string[]; specialInstructions: string | null; chefRequestQuoteId?: string }[]) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Restaurant not found');
    const ids = lines.map((l) => l.menuItemId).filter((x): x is string => !!x);
    const items = ids.length ? await this.catalog.resolveItems(loc.id, channel, ids, undefined) : new Map<string, ResolvedItem>();
    const chefName = loc.chefKitchen ? ((await this.db.select({ n: chefProfiles.displayName }).from(chefProfiles).where(eq(chefProfiles.locationId, loc.id)).limit(1))[0]?.n ?? null) : null;
    const out: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string }[] = [];
    const removed: { name: string; reason: string; code: string }[] = [];
    const warnings: string[] = [];
    for (const l of lines) {
      const label = l.name.replace(/ · special request$/, '');
      if (l.chefRequestQuoteId || /^Special request R-/.test(l.specialInstructions || '')) { removed.push({ name: label, reason: 'Special requests are quoted for one order. Ask the chef again from the dish page.', code: 'SPECIAL_REQUEST' }); continue; }
      const item = l.menuItemId ? items.get(l.menuItemId) : undefined;
      if (!item) { removed.push({ name: label, reason: 'No longer on the menu', code: 'UNAVAILABLE' }); continue; }
      if (item.soldOut) { removed.push({ name: label, reason: 'Sold out right now', code: 'SOLD_OUT' }); continue; }
      let ev = evaluateCustomization(item.name, item.modifierGroups, l.modifierIds, { allergens: item.allergens, dietaryTags: item.dietaryTags || [] });
      if (!ev.ok) {
        ev = evaluateCustomization(item.name, item.modifierGroups, [], { allergens: item.allergens, dietaryTags: item.dietaryTags || [] });
        if (!ev.ok) { removed.push({ name: label, reason: 'Its options changed; choose them again', code: 'OPTIONS_CHANGED' }); continue; }
        warnings.push(`${item.name}: some options changed, so the defaults were used`);
      }
      const title = chefName ? chefDishTitle(item.name, chefName) : item.name;
      const unit = item.priceCents + ev.modifiersCents;
      if (unit !== l.unitPriceCents) warnings.push(`${item.name} is now $${(unit / 100).toFixed(2)} (was $${(l.unitPriceCents / 100).toFixed(2)})`);
      out.push({ menuItemId: item.id, name: title, quantity: Math.min(l.quantity, item.maxPerOrder || 50), unitPriceCents: item.priceCents, modifierOptionIds: ev.optionIds, modifierNames: ev.chosen.map(modifierLabel), modifiersCents: ev.modifiersCents, ...(l.specialInstructions ? { specialInstructions: l.specialInstructions } : {}) });
    }
    let earliestDate: string | null = null;
    if (loc.chefKitchen && out.length) earliestDate = (await this.chefCalendar.availability({ locationId: loc.id, lines: out.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })) }).catch(() => null))?.earliestDate ?? null;
    if (loc.chefKitchen && out.length && !earliestDate) warnings.push('The chef has no open dates for these dishes right now');
    return { location: { id: loc.id, slug: loc.slug, name: chefName ? `${chefName} (Gutad Besties)` : loc.name, chefKitchen: loc.chefKitchen }, channel, lines: out, removed, warnings, earliestDate };
  }

  /**
   * A cart line from an accepted special-request quote: only its customer, at the quoted kitchen, dish, quantity and
   * date (and time, when the chef fixed one), while the quote is valid. The chef's price replaces the menu price.
   */
  private async specialRequestLine(tx: DbOrTx, l: QuoteInput['lines'][number], item: ResolvedItem, loc: typeof locations.$inferSelect, scheduledFor: Date | null, userId: string | null, sim: boolean): Promise<Omit<QuoteSnapshotLine, 'name' | 'brandId' | 'stationCode' | 'taxCategory'>> {
    const x = await acceptedChefQuote(tx, l.chefRequestQuoteId!);
    const bad = (message: string, code = 'CHEF_QUOTE_INVALID') => new BadRequestException({ message, code });
    if (!x || !userId || x.r.userId !== userId) throw bad('This special-request quote isn’t available. Open the request from My requests.');
    const { q } = x;
    if (q.status === 'ORDERED') throw bad('This special request was already ordered', 'CHEF_QUOTE_USED');
    if (q.status !== 'ACCEPTED' || x.r.currentQuoteId !== q.id) throw bad('Accept the chef’s current quote before checking out', 'CHEF_QUOTE_NOT_ACCEPTED');
    if (!sim && q.expiresAt < new Date()) throw bad('The chef’s quote has expired. Ask for a new one from My requests.', 'CHEF_QUOTE_EXPIRED');
    if (q.locationId !== loc.id || q.menuItemId !== l.menuItemId) throw bad('This quote is for a different dish or kitchen');
    if (l.quantity !== q.quantity) throw bad(`The chef quoted ${q.quantity}; the quantity can’t be changed`, 'CHEF_QUOTE_QUANTITY');
    if (scheduledFor) {
      const lp = localParts(scheduledFor, loc.timezone);
      if (lp.ymd !== q.serviceDate || (q.serviceTime && lp.hhmm !== q.serviceTime)) throw bad(`The chef quoted this for ${q.serviceDate}${q.serviceTime ? ` at ${q.serviceTime}` : ''}. Choose that ${q.serviceTime ? 'day and time' : 'day'}.`, 'CHEF_QUOTE_DATE');
    }
    let mods: QuoteSnapshotLine['modifiers'] = [];
    if (q.optionIds.length) {
      const r = evaluateCustomization(item.name, item.modifierGroups, q.optionIds, { allergens: item.allergens, dietaryTags: item.dietaryTags || [] });
      if (!r.ok) throw bad('The dish changed since the chef quoted. Ask for a new quote from My requests.', 'CHEF_QUOTE_STALE');
      mods = r.chosen.map((c) => ({ id: c.id, name: modifierLabel(c), priceCents: 0, ...(c.qty > 1 ? { qty: c.qty } : {}) }));
    }
    return { menuItemId: item.id, quantity: q.quantity, unitPriceCents: q.unitPriceCents, modifiersCents: 0, lineTotalCents: q.unitPriceCents * q.quantity, modifiers: mods, specialInstructions: `Special request ${chefRequestCode(x.r.id)}: ${q.changes}`, allergens: q.allergens, dietaryTags: q.dietaryTags, prepMinutesDelta: 0, chefRequestQuoteId: q.id };
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
