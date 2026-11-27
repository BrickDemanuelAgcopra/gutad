// Packaged goods: shelf-stable, chilled and frozen products sold by merchants and by Gutad itself next to cooked food.
// A packaged product is a menu item of kind PACKAGED with a product record, stock in dated batches per location,
// first-expiry-first reservation at checkout, expiry and recall controls. Policy lives in setting `catalog.packaged`.

export const PACKAGED_KIND = 'PACKAGED';

export const PACKAGED_CATEGORIES = ['PANTRY', 'SNACKS', 'BEVERAGES', 'SAUCES', 'BAKERY', 'CHILLED', 'FROZEN', 'HOUSE_MADE', 'ALCOHOL', 'OTHER'] as const;
export type PackagedCategory = (typeof PACKAGED_CATEGORIES)[number];
export const PACKAGED_CATEGORY_LABELS: Record<PackagedCategory, string> = {
  PANTRY: 'Pantry & dry goods',
  SNACKS: 'Snacks & sweets',
  BEVERAGES: 'Drinks (non-alcoholic)',
  SAUCES: 'Sauces, condiments & spreads',
  BAKERY: 'Packaged bakery',
  CHILLED: 'Chilled (dairy, deli, ready-to-eat)',
  FROZEN: 'Frozen',
  HOUSE_MADE: 'House-made packaged (own jars, bottles, mixes)',
  ALCOHOL: 'Alcohol (sealed)',
  OTHER: 'Other packaged food',
};

export const PACKAGED_STORAGE = ['AMBIENT', 'CHILLED', 'FROZEN'] as const;
export type PackagedStorage = (typeof PACKAGED_STORAGE)[number];
export const PACKAGED_STORAGE_LABELS: Record<PackagedStorage, string> = { AMBIENT: 'Room temperature', CHILLED: 'Keep chilled', FROZEN: 'Keep frozen' };

export const PACKAGED_DATE_TYPES = ['BEST_BEFORE', 'USE_BY', 'NONE'] as const;
export type PackagedDateType = (typeof PACKAGED_DATE_TYPES)[number];
export const PACKAGED_DATE_LABELS: Record<PackagedDateType, string> = { BEST_BEFORE: 'Best before', USE_BY: 'Use by', NONE: 'No date' };

export const SIZE_UOMS = ['g', 'kg', 'ml', 'l', 'oz', 'lb', 'fl oz', 'ct'] as const;
export type SizeUom = (typeof SIZE_UOMS)[number];

export const PACKAGED_REVIEW_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
export type PackagedReviewStatus = (typeof PACKAGED_REVIEW_STATUSES)[number];
export const PACKAGED_REVIEW_LABELS: Record<PackagedReviewStatus, string> = { DRAFT: 'Draft', PENDING: 'Waiting for review', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended by Gutad' };

export const LOT_STATUSES = ['ACTIVE', 'EXPIRED', 'RECALLED', 'QUARANTINED', 'DEPLETED'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

/** Store-side stock changes (reservations and sales are made by checkout and the order lifecycle). */
export const LOT_ADJUST_KINDS = ['COUNT', 'ADJUSTMENT', 'WASTE', 'RETURN'] as const;
export type LotAdjustKind = (typeof LOT_ADJUST_KINDS)[number];
export const LOT_ADJUST_LABELS: Record<LotAdjustKind, string> = {
  COUNT: 'Stock count (set the number on the shelf)',
  ADJUSTMENT: 'Correction (+/−)',
  WASTE: 'Waste / damaged / disposed (−)',
  RETURN: 'Return to stock (+, e.g. a sealed customer return)',
};

export const RECALL_SCOPES = ['LOT', 'PRODUCT', 'GTIN'] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

export interface PackagedCategoryRule {
  allowed: boolean;
  /** staff review before sale (only when the policy's requireReview is on) */
  review: boolean;
  /** default tax category for new products in this category */
  taxCategory: string;
}

export interface PackagedGoodsPolicy {
  /** Kill switch: off sells out every packaged product and checkout refuses them. */
  enabled: boolean;
  requireReview: boolean;
  /** Gutad's own (first-party) products go through the same review as merchants'. */
  reviewFirstParty: boolean;
  categories: Record<PackagedCategory, PackagedCategoryRule>;
  /** a batch sells only while at least this many days remain before its date (per storage type) */
  minRemainingDays: Record<PackagedStorage, number>;
  /** batches within this many days of their sell-by point show on the store's "Expiring soon" list */
  nearExpiryDays: Record<PackagedStorage, number>;
  requireGtin: boolean;
  requireLabelImage: boolean;
  /** show "Only N left" at or below this many units (0 = never) */
  showStockBelow: number;
  /** cap on units of one product per order */
  maxPerOrder: number;
  sellers: 'ALL' | 'ALLOW_LIST';
  allowOrgIds: string[];
  blockedOrgIds: string[];
}

export const DEFAULT_PACKAGED_POLICY: PackagedGoodsPolicy = {
  enabled: true,
  requireReview: true,
  reviewFirstParty: true,
  categories: {
    PANTRY: { allowed: true, review: true, taxCategory: 'GROCERY' },
    SNACKS: { allowed: true, review: true, taxCategory: 'GROCERY' },
    BEVERAGES: { allowed: true, review: true, taxCategory: 'BEVERAGE' },
    SAUCES: { allowed: true, review: true, taxCategory: 'GROCERY' },
    BAKERY: { allowed: true, review: true, taxCategory: 'GROCERY' },
    CHILLED: { allowed: true, review: true, taxCategory: 'GROCERY' },
    FROZEN: { allowed: true, review: true, taxCategory: 'GROCERY' },
    HOUSE_MADE: { allowed: true, review: true, taxCategory: 'GROCERY' },
    ALCOHOL: { allowed: false, review: true, taxCategory: 'ALCOHOL' },
    OTHER: { allowed: true, review: true, taxCategory: 'GROCERY' },
  },
  minRemainingDays: { AMBIENT: 30, CHILLED: 2, FROZEN: 14 },
  nearExpiryDays: { AMBIENT: 45, CHILLED: 3, FROZEN: 30 },
  requireGtin: false,
  requireLabelImage: false,
  showStockBelow: 5,
  maxPerOrder: 20,
  sellers: 'ALL',
  allowOrgIds: [],
  blockedOrgIds: [],
};

/** Merges a stored (partial) policy over the defaults, category by category. */
export function packagedPolicy(p?: Partial<PackagedGoodsPolicy> | null): PackagedGoodsPolicy {
  const d = DEFAULT_PACKAGED_POLICY;
  const v = p || {};
  const categories = { ...d.categories };
  for (const c of PACKAGED_CATEGORIES) categories[c] = { ...d.categories[c], ...(v.categories?.[c] || {}) };
  return {
    ...d,
    ...v,
    categories,
    minRemainingDays: { ...d.minRemainingDays, ...(v.minRemainingDays || {}) },
    nearExpiryDays: { ...d.nearExpiryDays, ...(v.nearExpiryDays || {}) },
    allowOrgIds: v.allowOrgIds || [],
    blockedOrgIds: v.blockedOrgIds || [],
  };
}

/** Whether an organization may sell packaged goods under the policy. */
export function sellerAllowed(p: PackagedGoodsPolicy, orgId: string): boolean {
  if (p.blockedOrgIds.includes(orgId)) return false;
  return p.sellers === 'ALL' || p.allowOrgIds.includes(orgId);
}

/** Whether a product in this category needs staff approval before it can be sold. */
export function needsReview(p: PackagedGoodsPolicy, category: PackagedCategory, firstParty: boolean): boolean {
  if (!p.requireReview) return false;
  if (firstParty && !p.reviewFirstParty) return false;
  return p.categories[category]?.review !== false;
}

/**
 * GTIN (UPC-A 12, EAN-8, EAN-13, GTIN-14) → 14 digits with a valid check digit, or null when invalid.
 * Spaces and dashes are ignored.
 */
export function normalizeGtin(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '');
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return null;
  const g = s.padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(g[13]) ? g : null;
}

/** "340 g", "12 fl oz × 8" */
export function sizeLabel(size: number | null | undefined, uom: string | null | undefined, unitCount?: number | null): string | null {
  if (!size || !uom) return unitCount && unitCount > 1 ? `${unitCount} pack` : null;
  const base = `${Number(size.toFixed(3))} ${uom}`;
  return unitCount && unitCount > 1 ? `${base} × ${unitCount}` : base;
}

/** Customer-facing product facts carried on a menu item of kind PACKAGED. */
export interface PackagedFacts {
  brandName: string | null;
  size: string | null;
  category: PackagedCategory;
  storage: PackagedStorage;
  dateType: PackagedDateType;
  /** units leave the store with at least this many days before their date (null = no date) */
  minShelfLifeDays: number | null;
  ingredients: string | null;
  countryOfOrigin: string | null;
  labelImageUrl: string | null;
  /** set only when stock is low (at or below the policy's showStockBelow) */
  onlyLeft: number | null;
}

/** Plain-language promise shown to customers. */
export function shelfLifePromise(f: Pick<PackagedFacts, 'dateType' | 'minShelfLifeDays'>): string | null {
  if (f.dateType === 'NONE' || f.minShelfLifeDays == null) return null;
  return `Arrives with at least ${f.minShelfLifeDays} day${f.minShelfLifeDays === 1 ? '' : 's'} before its ${f.dateType === 'USE_BY' ? 'use-by' : 'best-before'} date`;
}
