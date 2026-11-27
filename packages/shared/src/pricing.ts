/**
 * Customer fee rules and tax categories shared by the quote engine, the admin price simulator and the apps.
 * Platform setting `fees.customer` holds the live rules (changing it needs a second approver).
 */
export interface CustomerFeeRules {
  /** platform service fee: % of subtotal with min/cap, only on the listed channels/fulfillments (empty list = all) */
  service: { bps: number; minCents: number; capCents: number; channels: string[]; fulfillments: string[] };
  /** small-order fee when the subtotal is under the threshold (0 = off) */
  smallOrder: { thresholdCents: number; feeCents: number; channels: string[]; fulfillments: string[] };
  /** packaging fee paid to the merchant: per order and/or per item (a location's own packaging fee replaces per-order) */
  packaging: { perOrderCents: number; perItemCents: number; fulfillments: string[] };
}

/** Today's behaviour: 5% service fee capped at $4 on marketplace delivery only; no small-order or packaging fee. */
export const DEFAULT_CUSTOMER_FEES: CustomerFeeRules = {
  service: { bps: 500, minCents: 0, capCents: 400, channels: ['MARKETPLACE'], fulfillments: ['DELIVERY'] },
  smallOrder: { thresholdCents: 0, feeCents: 0, channels: ['MARKETPLACE'], fulfillments: ['DELIVERY', 'PICKUP'] },
  packaging: { perOrderCents: 0, perItemCents: 0, fulfillments: ['DELIVERY', 'PICKUP'] },
};

const applies = (list: string[], v: string) => !list.length || list.includes(v);

export function computeCustomerFees(
  rules: CustomerFeeRules,
  o: { channel: string; fulfillmentType: string; subtotalCents: number; itemCount: number; locationPackagingCents?: number | null; serviceFeeWaived?: boolean },
) {
  const r = { ...DEFAULT_CUSTOMER_FEES, ...rules };
  let serviceFeeCents = 0;
  if (applies(r.service.channels, o.channel) && applies(r.service.fulfillments, o.fulfillmentType) && r.service.bps > 0) {
    serviceFeeCents = Math.round((o.subtotalCents * r.service.bps) / 10000);
    serviceFeeCents = Math.max(serviceFeeCents, r.service.minCents || 0);
    if (r.service.capCents) serviceFeeCents = Math.min(serviceFeeCents, r.service.capCents);
  }
  if (o.serviceFeeWaived) serviceFeeCents = 0;
  const smallOrderFeeCents = r.smallOrder.thresholdCents > 0 && o.subtotalCents < r.smallOrder.thresholdCents && applies(r.smallOrder.channels, o.channel) && applies(r.smallOrder.fulfillments, o.fulfillmentType) ? r.smallOrder.feeCents : 0;
  let packagingFeeCents = 0;
  if (applies(r.packaging.fulfillments, o.fulfillmentType)) {
    const perOrder = o.locationPackagingCents ?? r.packaging.perOrderCents;
    packagingFeeCents = (perOrder || 0) + (r.packaging.perItemCents || 0) * o.itemCount;
  }
  return { serviceFeeCents, smallOrderFeeCents, packagingFeeCents };
}

export const TAX_CATEGORIES = [
  { key: 'STANDARD', label: 'Standard (prepared food)' },
  { key: 'PREPARED_FOOD', label: 'Prepared food (separate rate)' },
  { key: 'BEVERAGE', label: 'Non-alcoholic beverage' },
  { key: 'ALCOHOL', label: 'Alcohol' },
  { key: 'GROCERY', label: 'Grocery / unprepared food' },
  { key: 'MERCHANDISE', label: 'Merchandise' },
  { key: 'EXEMPT', label: 'Exempt' },
] as const;

export const MENU_ITEM_KINDS = ['ITEM', 'BUNDLE', 'BEVERAGE', 'EXTRA', 'PACKAGING'] as const;
export const ALLERGENS = ['milk', 'egg', 'fish', 'shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soy', 'sesame', 'gluten', 'mustard', 'celery', 'sulphites'] as const;

// ───── delivery fees (setting `fees.delivery`) ─────

/** A distance fee: base + per km, kept between min and max. */
export interface DeliveryFeeRule { baseCents: number; perKmCents: number; minCents: number; maxCents: number }

/**
 * Who sets the diner's delivery fee and how, per courier fleet. Admin → Pricing → Delivery fees. Like DoorDash
 * self-delivery, a store using its own couriers sets its own fee (within Gutad's caps) and keeps it; on Gutad couriers
 * and partner couriers (DoorDash Drive, Uber Direct) Gutad sets the fee. Any store may offer free delivery over an
 * amount: on its own couriers it simply charges nothing, on Gutad or partner couriers it pays the waived fee.
 */
export interface DeliveryPricing {
  /** Gutad pays every delivery fee (a launch promotion): diners see $0 everywhere */
  platformFreeDelivery: boolean;
  /** Gutad couriers: a distance fee (a delivery zone with its own fee overrides it) */
  platform: DeliveryFeeRule;
  /** partner couriers: pass the partner's price through (+ markup), or charge a distance fee */
  partner: DeliveryFeeRule & { mode: 'PASS_THROUGH' | 'DISTANCE'; markupCents: number; markupBps: number };
  /** the store's own couriers: the store sets base + per km, within these caps (otherwise the Gutad-courier fee) */
  merchant: { storeSetsFee: boolean; maxBaseCents: number; maxPerKmCents: number; maxCents: number };
  /** stores may offer free delivery from a basket amount (on Gutad or partner couriers the store pays the fee) */
  storeFreeDelivery: { allowed: boolean; minThresholdCents: number };
}

export const DEFAULT_DELIVERY_PRICING: DeliveryPricing = {
  platformFreeDelivery: false,
  platform: { baseCents: 199, perKmCents: 50, minCents: 199, maxCents: 899 },
  partner: { mode: 'PASS_THROUGH', markupCents: 0, markupBps: 0, baseCents: 199, perKmCents: 50, minCents: 199, maxCents: 1299 },
  merchant: { storeSetsFee: true, maxBaseCents: 999, maxPerKmCents: 200, maxCents: 1499 },
  storeFreeDelivery: { allowed: true, minThresholdCents: 0 },
};

/** Fills missing parts of a stored policy with the defaults (one level deep). */
export function withDeliveryDefaults(p: Partial<DeliveryPricing> | null | undefined): DeliveryPricing {
  const d = DEFAULT_DELIVERY_PRICING;
  return { platformFreeDelivery: p?.platformFreeDelivery ?? d.platformFreeDelivery, platform: { ...d.platform, ...p?.platform }, partner: { ...d.partner, ...p?.partner }, merchant: { ...d.merchant, ...p?.merchant }, storeFreeDelivery: { ...d.storeFreeDelivery, ...p?.storeFreeDelivery } };
}

const clampFee = (c: number, min: number, max: number) => Math.max(min, max > 0 ? Math.min(c, max) : c);

/**
 * The standard delivery fee for one order, before any free-delivery offer. `zoneFeeCents` is the fee of the delivery
 * zone the address falls in (Gutad and partner couriers only); `store` is the store's own fee (its own couriers).
 */
export function standardDeliveryFee(p: DeliveryPricing, fleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM', i: { km: number | null; providerCostCents: number; zoneFeeCents: number | null; store: { baseCents: number; perKmCents: number } }): number {
  const km = i.km ?? 3;
  const rule = (r: DeliveryFeeRule) => clampFee(r.baseCents + Math.round(km * r.perKmCents), r.minCents, r.maxCents);
  if (fleet === 'MERCHANT') {
    if (!p.merchant.storeSetsFee) return rule(p.platform);
    const base = Math.min(i.store.baseCents, p.merchant.maxBaseCents);
    const perKm = Math.min(i.store.perKmCents, p.merchant.maxPerKmCents);
    return clampFee(base + Math.round(km * perKm), 0, p.merchant.maxCents);
  }
  if (i.zoneFeeCents !== null) return i.zoneFeeCents;
  if (fleet === 'PARTNER' && p.partner.mode === 'PASS_THROUGH' && i.providerCostCents > 0) return clampFee(i.providerCostCents + p.partner.markupCents + Math.round((i.providerCostCents * p.partner.markupBps) / 10000), p.partner.minCents, p.partner.maxCents);
  return rule(fleet === 'PARTNER' ? p.partner : p.platform);
}
