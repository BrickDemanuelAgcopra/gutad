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
