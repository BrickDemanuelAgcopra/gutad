/**
 * Support categories, routing and SLAs, plus the cart rule for combining menus — shared by API, web and mobile.
 */
export const SUPPORT_CATEGORIES = {
  MISSING_ITEM: { label: 'Missing item', owner: 'MERCHANT', priority: 'HIGH', queue: 'SUPPORT' },
  WRONG_ITEM: { label: 'Wrong item', owner: 'MERCHANT', priority: 'HIGH', queue: 'SUPPORT' },
  QUALITY: { label: 'Food quality', owner: 'MERCHANT', priority: 'NORMAL', queue: 'SUPPORT' },
  DAMAGED: { label: 'Damaged or spilled', owner: 'MERCHANT', priority: 'NORMAL', queue: 'SUPPORT' },
  LATE: { label: 'Late', owner: 'PROVIDER', priority: 'NORMAL', queue: 'DELIVERY' },
  FAILED_DELIVERY: { label: 'Never arrived', owner: 'PROVIDER', priority: 'HIGH', queue: 'DELIVERY' },
  NO_HANDOFF: { label: 'No handoff', owner: 'PROVIDER', priority: 'HIGH', queue: 'DELIVERY' },
  WRONG_ADDRESS: { label: 'Wrong address', owner: 'PROVIDER', priority: 'NORMAL', queue: 'DELIVERY' },
  FOOD_SAFETY: { label: 'Food safety / illness', owner: 'MERCHANT', priority: 'URGENT', queue: 'FOOD_SAFETY' },
  PAYMENT: { label: 'Payment or charge', owner: 'PLATFORM', priority: 'NORMAL', queue: 'FINANCE' },
  CHARGEBACK: { label: 'Chargeback', owner: 'PLATFORM', priority: 'HIGH', queue: 'FINANCE' },
  ACCOUNT: { label: 'Account', owner: 'PLATFORM', priority: 'LOW', queue: 'SUPPORT' },
  NO_SHOW_DISPUTE: { label: 'No-show dispute', owner: 'PLATFORM', priority: 'NORMAL', queue: 'SUPPORT' },
  // merchant-raised cases
  PAYOUT: { label: 'Payouts & statements', owner: 'PLATFORM', priority: 'NORMAL', queue: 'FINANCE' },
  ORDER_DISPUTE: { label: 'Disputed complaint or refund', owner: 'PLATFORM', priority: 'NORMAL', queue: 'SUPPORT' },
  MENU: { label: 'Menu or listing', owner: 'PLATFORM', priority: 'LOW', queue: 'OPERATIONS' },
  TECH: { label: 'Tablet, printer or app', owner: 'PLATFORM', priority: 'HIGH', queue: 'OPERATIONS' },
  DELIVERY: { label: 'Couriers & delivery', owner: 'PLATFORM', priority: 'NORMAL', queue: 'DELIVERY' },
  OTHER: { label: 'Something else', owner: 'PLATFORM', priority: 'NORMAL', queue: 'SUPPORT' },
} as const;
export type SupportCategory = keyof typeof SUPPORT_CATEGORIES;
export const SUPPORT_CATEGORY_KEYS = Object.keys(SUPPORT_CATEGORIES) as SupportCategory[];
export const CUSTOMER_CATEGORIES: SupportCategory[] = ['MISSING_ITEM', 'WRONG_ITEM', 'QUALITY', 'DAMAGED', 'LATE', 'FAILED_DELIVERY', 'FOOD_SAFETY', 'PAYMENT', 'OTHER'];

/** First-response and resolution targets by priority (setting `support.sla` overrides). */
export const DEFAULT_SUPPORT_SLA: Record<'URGENT' | 'HIGH' | 'NORMAL' | 'LOW', { firstResponseMinutes: number; resolveHours: number }> = {
  URGENT: { firstResponseMinutes: 15, resolveHours: 4 },
  HIGH: { firstResponseMinutes: 60, resolveHours: 24 },
  NORMAL: { firstResponseMinutes: 240, resolveHours: 48 },
  LOW: { firstResponseMinutes: 1440, resolveHours: 120 },
};

/** Goodwill limits per customer over 90 days (setting `support.goodwill`); above them compensation needs approval. */
export const DEFAULT_GOODWILL = { maxCount90d: 3, maxCents90d: 5000 };

export interface CartPlace { locationId: string; name: string; platformOperated: boolean }

/**
 * Gutad rule for combining menus in one order:
 * menus from the same Made at Gutad food hall share one cart (one kitchen, one bag); an independent
 * restaurant is always its own order, and two different food halls are two orders.
 */
export function cartCompatibility(current: CartPlace | null, adding: CartPlace): { ok: true } | { ok: false; code: 'SEPARATE_ORDER_REQUIRED'; reason: string } {
  if (!current || current.locationId === adding.locationId) return { ok: true };
  if (current.platformOperated && adding.platformOperated) return { ok: false, code: 'SEPARATE_ORDER_REQUIRED', reason: `${adding.name} is a different Made at Gutad food hall. Menus can be combined only within one food hall, so this is a separate order.` };
  const indie = !adding.platformOperated ? adding.name : current.name;
  return { ok: false, code: 'SEPARATE_ORDER_REQUIRED', reason: `${indie} is an independent restaurant, so it is always a separate order. Made at Gutad menus can be mixed only within the same food hall.` };
}
