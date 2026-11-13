import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { locations, openingHours, platformSettings, quotes } from '../../db/schema';
import { CatalogService, ResolvedItem } from '../catalog/catalog.service';
import { ContractsService } from '../contracts/contracts.service';
import { DeliveryService } from '../delivery/delivery.service';
import { GrowthService } from '../growth/growth.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { PaymentsService } from '../payments/payments.service';
import { addMinutes, bps, isWithin, localParts, zonedTimeToUtc } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

export type Channel = 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR' | 'PARTNER' | 'PHONE' | 'WALK_IN' | 'CAMPUS' | 'CORPORATE' | 'API';
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
}

const SERVICE_FEE_BPS_MARKETPLACE = 500; // diner service fee on marketplace delivery orders (capped); pickup has none
const SERVICE_FEE_CAP_CENTS = 400;
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
  ) {}

  async quote(input: QuoteInput, tx: DbOrTx = this.db) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
    if (!loc) throw new NotFoundException('Restaurant not found');
    const warnings: string[] = [];
    if (!['LIVE', 'VERIFIED'].includes(loc.status)) throw new BadRequestException('Restaurant is not accepting orders');
    if (loc.isPaused && (!loc.pausedUntil || loc.pausedUntil > new Date())) throw new BadRequestException(loc.pausedReason || 'Restaurant is temporarily paused');
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
      if (scheduledFor < addMinutes(now, loc.defaultPrepMinutes)) throw new BadRequestException('Scheduled time is too soon');
      if (!(await this.openAt(loc, scheduledFor, tx))) throw new BadRequestException('Restaurant is closed at the scheduled time');
    } else if (!(await this.openAt(loc, now, tx))) {
      throw new BadRequestException('Restaurant is closed right now; schedule for later');
    }

    // items & modifiers
    const items = await this.catalog.resolveItems(loc.id, input.channel, input.lines.map((l) => l.menuItemId));
    const eligibleBrands = await this.kitchen.eligibleBrands(loc.id, tx);
    const snapLines: QuoteSnapshotLine[] = [];
    for (const l of input.lines) {
      const item = items.get(l.menuItemId);
      if (!item) throw new BadRequestException(`Item ${l.menuItemId} is not available on this menu/channel`);
      if (item.soldOut) throw new BadRequestException(`${item.name} is sold out`);
      if (l.quantity < 1 || l.quantity > 50) throw new BadRequestException('Quantity must be 1–50');
      if (item.brandId && eligibleBrands.length && !eligibleBrands.some((b) => b.id === item.brandId)) throw new BadRequestException(`${item.name} is from a brand not served at this kitchen`);
      const mods = this.resolveModifiers(item, l.modifierOptionIds || []);
      const modifiersCents = mods.reduce((a, m) => a + m.priceCents, 0);
      snapLines.push({ menuItemId: item.id, name: item.name, brandId: item.brandId, stationCode: item.stationCode, quantity: l.quantity, unitPriceCents: item.priceCents, modifiersCents, lineTotalCents: (item.priceCents + modifiersCents) * l.quantity, modifiers: mods, specialInstructions: l.specialInstructions });
    }
    const subtotalCents = snapLines.reduce((a, l) => a + l.lineTotalCents, 0);
    if (subtotalCents < loc.minOrderCents) throw new BadRequestException(`Minimum order is ${loc.minOrderCents} cents`);

    // promotions
    let discountCents = 0;
    let promotionFunder: 'MERCHANT' | 'PLATFORM' | null = null;
    let couponId: string | null = null;
    let freeDelivery = false;
    if (input.promoCode) {
      const promo = await this.growth.validateCoupon(input.promoCode, { locationId: loc.id, channel: input.channel, subtotalCents, userId: input.userId }, tx);
      discountCents = promo.discountCents;
      promotionFunder = promo.funder;
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
    let etaMinutes = loc.defaultPrepMinutes;
    if (input.fulfillmentType === 'DELIVERY') {
      if (!input.deliveryAddress) throw new BadRequestException('Delivery address required');
      const q = await this.delivery.quoteForLocation(loc.id, input.deliveryAddress, subtotalCents, input.tipCents || 0, tx);
      deliveryFeeCents = q.retailFeeCents;
      deliveryProviderCostCents = q.providerCostCents;
      deliveryQuoteId = q.providerQuoteId;
      deliveryExpiresAt = q.expiresAt;
      deliveryFleet = q.fleet;
      etaMinutes = loc.defaultPrepMinutes + q.etaMinutes;
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
    let serviceFeeCents = input.channel === 'MARKETPLACE' && input.fulfillmentType === 'DELIVERY' ? Math.min(bps(subtotalCents, SERVICE_FEE_BPS_MARKETPLACE), SERVICE_FEE_CAP_CENTS) : 0;
    if (membership?.benefits.serviceFeeWaived) serviceFeeCents = 0;
    const taxableCents = Math.max(0, subtotalCents - discountCents);
    const taxCents = bps(taxableCents, loc.taxRateBps);
    const tipCents = Math.max(0, input.tipCents || 0);
    const commissionCents = bps(taxableCents, terms.commissionBps);

    // credits & loyalty (reduce what the card pays; recorded as platform-funded discount lines)
    let creditsCents = 0;
    let loyaltyCents = 0;
    if (input.userId) {
      if (input.useCreditsCents) creditsCents = Math.min(input.useCreditsCents, await this.payments.availableCredit(input.userId, tx));
      if (input.useLoyaltyPoints) loyaltyCents = Math.min(input.useLoyaltyPoints, await this.growth.loyaltyBalance(input.userId, tx)); // 1 point = 1 cent
    }
    const grossTotal = taxableCents + taxCents + serviceFeeCents + deliveryFeeCents + tipCents;
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
      creditsCents,
      loyaltyCents,
      deliveryFleet,
      deliveryProviderCostCents,
      platformDeliverySubsidyCents: Math.max(0, deliveryProviderCostCents - deliveryFeeCents),
      deliveryAddress: input.deliveryAddress || null,
      etaMinutes,
      membershipId: membership?.id || null,
    };
    const [q] = await tx
      .insert(quotes)
      .values({ locationId: loc.id, userId: input.userId ?? null, channel: input.channel, fulfillmentType: input.fulfillmentType, currency: loc.currency, snapshot, subtotalCents, discountCents, taxCents, serviceFeeCents, deliveryFeeCents, tipCents, totalCents, promoCode: input.promoCode?.toUpperCase() ?? null, promotionFunder, deliveryQuoteId, deliveryProviderCostCents, scheduledFor, promiseAt, expiresAt })
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
