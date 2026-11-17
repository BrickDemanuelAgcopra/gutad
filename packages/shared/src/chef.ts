import { validateOptionsConfig, type ModGroup, type OptionsConfigGroup } from './customization';
import type { CustomerFeeRules } from './pricing';

/**
 * Gutad Chef Network — contracts shared by the API, web and mobile.
 * Independent chefs apply, are approved with an eligible kitchen, and sell dishes branded
 * "Gutad's <dish> — by <chef>". Gutad is the customer-facing seller.
 */

export const PLATFORM_BRAND = 'Gutad';

/** "Gutad's Spaghetti — by Chef Carlos". One helper so listings, receipts, tickets and labels always agree. */
export function chefDishTitle(dishName: string, chefDisplayName: string, platformBrand = PLATFORM_BRAND): string {
  const dish = dishName.trim();
  const chef = chefDisplayName.trim();
  return chef ? `${platformBrand}’s ${dish} — by ${chef}` : `${platformBrand}’s ${dish}`;
}

export const CHEF_KITCHEN_TYPES = {
  COMMERCIAL: 'Commercial kitchen (licensed food establishment)',
  SHARED_COMMISSARY: 'Shared / commissary kitchen',
  RESTAURANT: 'Restaurant kitchen (after hours or partner)',
  COTTAGE_HOME: 'Home kitchen under a cottage-food or home-kitchen permit',
} as const;
export type ChefKitchenType = keyof typeof CHEF_KITCHEN_TYPES;

export const CHEF_BUSINESS_TYPES = { INDIVIDUAL: 'Individual / sole proprietor', BUSINESS: 'Registered business (LLC, corporation…)' } as const;
export type ChefBusinessType = keyof typeof CHEF_BUSINESS_TYPES;

export const CHEF_CUISINES = ['American', 'BBQ', 'Bakery & desserts', 'Caribbean', 'Chinese', 'Ethiopian', 'Filipino', 'French', 'Greek', 'Indian', 'Italian', 'Japanese', 'Korean', 'Lebanese', 'Mexican', 'Nigerian', 'Ghanaian', 'Soul food', 'Spanish', 'Thai', 'Vegan', 'Vietnamese', 'West African', 'Halal', 'Kosher'] as const;

export const CHEF_FULFILLMENT_FORMATS = {
  HOT: 'Hot — ready to eat',
  CHILLED_REHEAT: 'Chilled — ready to reheat',
  FROZEN: 'Frozen — keep frozen, reheat',
  ROOM_TEMP: 'Room temperature (baked goods, snacks)',
} as const;
export type ChefFulfillmentFormat = keyof typeof CHEF_FULFILLMENT_FORMATS;

export const CHEF_APPLICATION_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'WAITLISTED', 'APPEALED'] as const;
export type ChefApplicationStatus = (typeof CHEF_APPLICATION_STATUSES)[number];
export const CHEF_APPLICATION_STATUS_LABELS: Record<ChefApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
  WAITLISTED: 'Waitlisted',
  APPEALED: 'Appeal under review',
};

export const CHEF_DOC_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;

/** Application draft, saved step by step (autosave). Every field is optional until submission. */
export interface ChefApplicationData {
  account?: { phone?: string; agreementVersion?: string; agreedAt?: string; smsConsent?: boolean };
  identity?: { legalName?: string; displayName?: string; businessType?: ChefBusinessType; businessName?: string; businessRegistration?: string; dateOfBirth?: string };
  profile?: { bio?: string; cuisines?: string[]; experienceYears?: number; languages?: string[]; portraitFileId?: string; portfolioFileIds?: string[]; serviceCity?: string; serviceRegion?: string; serviceRadiusKm?: number; instagram?: string };
  kitchen?: { kitchenType?: ChefKitchenType; name?: string; operatorName?: string; addressLine1?: string; addressLine2?: string; city?: string; region?: string; postalCode?: string; pickupAccess?: string; equipment?: string[]; storage?: string[]; dailyCapacity?: number };
  operating?: { cookingDays?: number[]; cutoffHour?: number; minLeadDays?: number; dailyCapacity?: number; instantOrders?: boolean; scheduledOrders?: boolean; pickup?: boolean; delivery?: boolean; maxAdvanceDays?: number };
  payments?: { country?: string; earningsAgreementAccepted?: boolean; taxFormsByProvider?: boolean };
  menu?: { dishes?: ChefStarterDish[] };
  readiness?: { packagingAck?: boolean; handlingTrainingAck?: boolean; allergenTrainingAck?: boolean; sampleReviewOk?: boolean };
}

export interface ChefStarterDish {
  name: string;
  description?: string;
  priceCents?: number;
  portion?: string;
  allergens?: string[];
  mode?: 'FIXED' | 'CUSTOMIZABLE';
  photoFileId?: string;
}

export type ChefStepKey = 'account' | 'identity' | 'profile' | 'kitchen' | 'documents' | 'operating' | 'payments' | 'menu' | 'readiness';

export interface ChefStepDef {
  key: ChefStepKey;
  label: string;
  description: string;
}

export const CHEF_APPLICATION_STEPS: ChefStepDef[] = [
  { key: 'account', label: 'Account', description: 'Contact phone and the Chef Partner Agreement' },
  { key: 'identity', label: 'Identity & business', description: 'Legal name, public chef name, individual or business' },
  { key: 'profile', label: 'Public profile', description: 'Portrait, biography, cuisines, experience and service area' },
  { key: 'kitchen', label: 'Kitchen', description: 'Where you cook, who operates it, pickup access and capacity' },
  { key: 'documents', label: 'Documents', description: 'Permits, food-safety certificates and insurance for your kitchen' },
  { key: 'operating', label: 'Operating preferences', description: 'Cooking days, cutoff, lead time, capacity, delivery and pickup' },
  { key: 'payments', label: 'Payments', description: 'Earnings agreement; payouts connect securely after approval' },
  { key: 'menu', label: 'First menu', description: 'At least one dish with price, portion and allergens' },
  { key: 'readiness', label: 'Readiness', description: 'Packaging, order handling and allergen training' },
];

export const CHEF_AGREEMENT_VERSION = '2026-11-16';

/** A document Gutad needs, by region (state) and kitchen type. Empty lists mean "everywhere" / "every kitchen type". */
export interface ChefDocRequirement {
  key: string;
  label: string;
  description?: string | null;
  regions: string[];
  kitchenTypes: string[];
  required: boolean;
  needsExpiry: boolean;
}

export function requirementsFor(all: ChefDocRequirement[], region: string | undefined, kitchenType: string | undefined): ChefDocRequirement[] {
  const r = (region || '').toUpperCase();
  return all.filter((q) => (!q.regions.length || q.regions.map((x) => x.toUpperCase()).includes(r)) && (!q.kitchenTypes.length || (!!kitchenType && q.kitchenTypes.includes(kitchenType))));
}

export interface ChefDocSummary { requirementKey: string; status: string; expiresAt?: string | null }

/** Which fields are still missing per step. Used for the progress bar, the "submit" gate and the automated completeness check. */
export function chefApplicationMissing(d: ChefApplicationData, docs: ChefDocSummary[], reqs: ChefDocRequirement[]): Record<ChefStepKey, string[]> {
  const m: Record<ChefStepKey, string[]> = { account: [], identity: [], profile: [], kitchen: [], documents: [], operating: [], payments: [], menu: [], readiness: [] };
  const need = (step: ChefStepKey, ok: unknown, label: string) => { if (!ok) m[step].push(label); };
  need('account', d.account?.phone && d.account.phone.replace(/\D/g, '').length >= 10, 'Mobile phone');
  need('account', d.account?.agreedAt && d.account.agreementVersion === CHEF_AGREEMENT_VERSION, 'Chef Partner Agreement');
  need('identity', (d.identity?.legalName || '').trim().length >= 3, 'Legal name');
  need('identity', (d.identity?.displayName || '').trim().length >= 2, 'Public chef name');
  need('identity', d.identity?.businessType, 'Individual or business');
  if (d.identity?.businessType === 'BUSINESS') need('identity', (d.identity?.businessName || '').trim(), 'Registered business name');
  need('profile', (d.profile?.bio || '').trim().length >= 40, 'Biography (40+ characters)');
  need('profile', d.profile?.cuisines?.length, 'Cuisines');
  need('profile', d.profile?.portraitFileId, 'Portrait photo');
  need('profile', d.profile?.serviceCity && d.profile?.serviceRegion, 'Service area');
  need('kitchen', d.kitchen?.kitchenType, 'Kitchen type');
  need('kitchen', d.kitchen?.addressLine1 && d.kitchen?.city && d.kitchen?.region && d.kitchen?.postalCode, 'Kitchen address');
  need('kitchen', (d.kitchen?.operatorName || '').trim(), 'Kitchen operator');
  need('kitchen', (d.kitchen?.pickupAccess || '').trim(), 'Pickup access instructions');
  need('kitchen', (d.kitchen?.dailyCapacity || 0) > 0, 'Daily production capacity');
  const valid = (k: string) => docs.some((x) => x.requirementKey === k && x.status !== 'REJECTED' && x.status !== 'EXPIRED' && (!x.expiresAt || new Date(x.expiresAt) > new Date()));
  for (const r of requirementsFor(reqs, d.kitchen?.region, d.kitchen?.kitchenType)) if (r.required) need('documents', valid(r.key), r.label);
  if (!d.kitchen?.kitchenType) m.documents.push('Choose your kitchen type first');
  need('operating', d.operating?.cookingDays?.length, 'Cooking days');
  need('operating', d.operating?.cutoffHour !== undefined && d.operating.cutoffHour !== null, 'Order cutoff');
  need('operating', d.operating?.minLeadDays !== undefined && d.operating.minLeadDays !== null, 'Minimum lead time');
  need('operating', (d.operating?.dailyCapacity || 0) > 0, 'Daily order capacity');
  need('operating', d.operating?.pickup || d.operating?.delivery, 'Pickup or delivery');
  need('operating', d.operating?.instantOrders || d.operating?.scheduledOrders, 'Instant or scheduled orders');
  need('payments', d.payments?.earningsAgreementAccepted, 'Earnings agreement');
  const dishes = d.menu?.dishes || [];
  need('menu', dishes.length, 'At least one dish');
  dishes.forEach((x, i) => {
    if (!(x.name || '').trim() || !(x.priceCents && x.priceCents > 0) || !(x.portion || '').trim()) m.menu.push(`Dish ${i + 1}: name, price and portion`);
    if (!Array.isArray(x.allergens)) m.menu.push(`Dish ${i + 1}: allergens (choose "none" if none)`);
  });
  need('readiness', d.readiness?.packagingAck, 'Packaging standards');
  need('readiness', d.readiness?.handlingTrainingAck, 'Order-handling training');
  need('readiness', d.readiness?.allergenTrainingAck, 'Allergen training');
  return m;
}

export function chefApplicationProgress(missing: Record<ChefStepKey, string[]>) {
  const steps = CHEF_APPLICATION_STEPS.map((s) => ({ ...s, missing: missing[s.key], complete: missing[s.key].length === 0 }));
  const done = steps.filter((s) => s.complete).length;
  return { steps, done, total: steps.length, percent: Math.round((done / steps.length) * 100), ready: done === steps.length };
}

/** Default documents (admins edit these in Admin → Chef Network → Requirements). */
export const DEFAULT_CHEF_DOC_REQUIREMENTS: (ChefDocRequirement & { sortOrder: number })[] = [
  { key: 'GOV_ID', label: 'Government photo ID', description: 'Driver license, passport or state ID of the chef', regions: [], kitchenTypes: [], required: true, needsExpiry: true, sortOrder: 1 },
  { key: 'FOOD_HANDLER', label: 'Food handler or food protection manager certificate', description: 'ServSafe, state food handler card or equivalent', regions: [], kitchenTypes: [], required: true, needsExpiry: true, sortOrder: 2 },
  { key: 'KITCHEN_PERMIT', label: 'Food establishment / kitchen permit', description: 'Health permit of the kitchen you cook in (yours or the operator’s)', regions: [], kitchenTypes: ['COMMERCIAL', 'SHARED_COMMISSARY', 'RESTAURANT'], required: true, needsExpiry: true, sortOrder: 3 },
  { key: 'KITCHEN_USE_AGREEMENT', label: 'Kitchen use / rental agreement', description: 'Agreement with the commissary or restaurant that lets you produce there', regions: [], kitchenTypes: ['SHARED_COMMISSARY', 'RESTAURANT'], required: true, needsExpiry: false, sortOrder: 4 },
  { key: 'HOME_KITCHEN_PERMIT', label: 'Cottage-food or home-kitchen operation permit', description: 'Only where your state or county allows selling meals from a home kitchen', regions: [], kitchenTypes: ['COTTAGE_HOME'], required: true, needsExpiry: true, sortOrder: 5 },
  { key: 'INSPECTION_REPORT', label: 'Latest health inspection report', description: 'Most recent inspection of the kitchen', regions: [], kitchenTypes: [], required: false, needsExpiry: false, sortOrder: 6 },
  { key: 'LIABILITY_INSURANCE', label: 'General / product liability insurance', description: 'Certificate of insurance', regions: [], kitchenTypes: [], required: true, needsExpiry: true, sortOrder: 7 },
  { key: 'BUSINESS_REGISTRATION', label: 'Business registration', description: 'Articles of organization or business license, if you sell as a business', regions: [], kitchenTypes: [], required: false, needsExpiry: false, sortOrder: 8 },
];

// ───────────────────────── Dishes ─────────────────────────

export const CHEF_DISH_MODES = {
  FIXED: { label: 'Fixed dish', customer: 'Choose quantity and an available fulfillment time. Recipe changes are unavailable.', chef: 'Prepare the published dish.' },
  CUSTOMIZABLE: { label: 'Customizable dish', customer: 'Adjust only the ingredients, quantities and substitutions you enable. Price updates immediately.', chef: 'Prepare the configured dish without negotiating every order.' },
} as const;
export type ChefDishMode = keyof typeof CHEF_DISH_MODES;

export const CHEF_DISH_STATUSES = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED'] as const;
export type ChefDishStatus = (typeof CHEF_DISH_STATUSES)[number];
export const CHEF_DISH_STATUS_LABELS: Record<ChefDishStatus, string> = { DRAFT: 'Draft', IN_REVIEW: 'In review', CHANGES_REQUESTED: 'Changes requested', PUBLISHED: 'Live', SUSPENDED: 'Suspended', ARCHIVED: 'Archived' };

export const DIETARY_TAGS = ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'nut_free', 'halal', 'kosher', 'keto', 'spicy'] as const;

/** Fields that change what the customer eats or is told; on a live dish they wait for Gutad review. */
export const CHEF_DISH_MATERIAL_FIELDS = ['dishName', 'description', 'ingredients', 'allergens', 'dietaryTags', 'portionDesc', 'mode', 'acceptsSpecialRequests', 'fulfillmentFormat', 'photos', 'optionsConfig'] as const;

export interface ChefDishInput {
  dishName?: string;
  description?: string | null;
  cuisine?: string | null;
  portionDesc?: string;
  ingredients?: string[];
  allergens?: string[];
  allergensConfirmed?: boolean;
  dietaryTags?: string[];
  priceCents?: number;
  mode?: ChefDishMode;
  acceptsSpecialRequests?: boolean;
  fulfillmentFormat?: ChefFulfillmentFormat;
  prepMinutes?: number;
  dailyCapacity?: number | null;
  minLeadDays?: number | null;
  cutoffHour?: number | null;
  maxAdvanceDays?: number | null;
  photos?: string[];
  sectionId?: string;
  /** customer options of a customizable dish */
  optionsConfig?: OptionsConfigGroup[];
}

/** What a dish still needs before it can be submitted for review. */
export function chefDishMissing(d: ChefDishInput & { photos?: string[] }): string[] {
  const m: string[] = [];
  if ((d.dishName || '').trim().length < 2) m.push('Dish name');
  if (!d.priceCents || d.priceCents < 100) m.push('Price (at least $1)');
  if (!(d.portionDesc || '').trim()) m.push('Portion (e.g. “1 bowl, 450 g”)');
  if (!d.ingredients?.length) m.push('Ingredients');
  if (!d.allergensConfirmed) m.push('Allergen declaration');
  if (!d.photos?.length) m.push('At least one photo');
  if (!d.fulfillmentFormat) m.push('Fulfillment format');
  if (d.mode === 'FIXED' && d.acceptsSpecialRequests) m.push('Special requests are only for customizable dishes');
  if (d.mode === 'CUSTOMIZABLE') {
    const cfg = d.optionsConfig || [];
    if (!cfg.some((g) => g.selectionType !== 'INCLUDED')) m.push('At least one customer option (or make it a fixed dish)');
    m.push(...validateOptionsConfig(cfg));
  }
  return m;
}

/** Public dish card (storefront, dish page). */
export interface PublicChefDish {
  id: string;
  menuItemId: string;
  title: string;
  dishName: string;
  description: string | null;
  priceCents: number;
  portionDesc: string;
  ingredients: string[];
  allergens: string[];
  dietaryTags: string[];
  photos: string[];
  mode: ChefDishMode;
  acceptsSpecialRequests: boolean;
  fulfillmentFormat: ChefFulfillmentFormat;
  soldOut: boolean;
  minLeadDays: number;
  maxAdvanceDays: number;
  cutoffHour: number;
  section: string | null;
  /** customer options (materialized modifier groups), dish page only */
  groups?: ModGroup[];
  chef: { id: string; slug: string; displayName: string; portraitUrl: string | null };
  location: { id: string; slug: string; name: string };
}

// ───── Phase 4: advance ordering and capacity ─────

/** Why a date can or cannot be ordered for (chef cooking calendar). */
export type ChefDayStatus = 'AVAILABLE' | 'SOLD_OUT' | 'NOT_COOKING' | 'PAUSED' | 'CLOSED' | 'CUTOFF_PASSED' | 'TOO_FAR';

export const CHEF_DAY_STATUS_LABEL: Record<ChefDayStatus, string> = {
  AVAILABLE: 'Available',
  SOLD_OUT: 'Sold out',
  NOT_COOKING: 'Not a cooking day',
  PAUSED: 'Chef is away',
  CLOSED: 'Closed',
  CUTOFF_PASSED: 'Ordering closed',
  TOO_FAR: 'Not open yet',
};

/** One date in a customer-facing availability calendar. */
export interface ChefAvailabilityDay {
  date: string;
  status: ChefDayStatus;
  /** last moment to order for this date (ISO), from the notice period and cutoff hour */
  orderBy: string | null;
  /** units still available for the dish (or the tightest dish of a cart); null = no limit */
  remaining: number | null;
  /** pickup/delivery times (local HH:MM) */
  slots: string[];
}

export interface ChefAvailability {
  locationId: string;
  timezone: string;
  /** today at the kitchen (YYYY-MM-DD) */
  today: string;
  earliestDate: string | null;
  latestDate: string;
  rules: { minLeadDays: number; cutoffHour: number; maxAdvanceDays: number };
  days: ChefAvailabilityDay[];
}

/** A chef's weekly operating settings (the cooking calendar's defaults). */
export interface ChefOperatingSettings {
  /** 0 = Sunday … 6 = Saturday */
  cookingDays: number[];
  cutoffHour: number;
  minLeadDays: number;
  /** units per cooking day across all dishes (the kitchen limit) */
  dailyCapacity: number;
  maxAdvanceDays: number;
  /** pickup/delivery window on cooking days (local HH:MM) */
  opens: string;
  closes: string;
  /** refund (%) when a customer cancels after the date's cutoff; within Gutad's range (chefs.policy) */
  lateRefundPct?: number;
}

/** One date in the chef's own calendar view. */
export interface ChefCalendarDay {
  date: string;
  weekday: number;
  /** a weekly cooking day */
  cookingDay: boolean;
  /** after overrides and pauses */
  open: boolean;
  override: { open: boolean | null; capacity: number | null; note: string | null } | null;
  pause: { id: string; reason: string | null } | null;
  capacity: number;
  booked: number;
  held: number;
  orders: number;
  /** ordering for this date has closed (cutoff passed) */
  closedForOrders: boolean;
  orderBy: string | null;
  dishes: { menuItemId: string; name: string; units: number; limit: number | null }[];
}

export interface ChefPause { id: string; startDate: string; endDate: string; reason: string | null }

/** "12 PM", "9 AM" */
export function formatHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** Customer-facing notice rule, e.g. "Order by 12 PM, 1 day before". */
export function chefNoticeText(minLeadDays: number, cutoffHour: number): string {
  if (!minLeadDays) return `Order by ${formatHour(cutoffHour)} on the day`;
  return `Order by ${formatHour(cutoffHour)}, ${minLeadDays} day${minLeadDays > 1 ? 's' : ''} before`;
}

/** Add days to a YYYY-MM-DD date (calendar arithmetic, no time zone). */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD date. */
export function weekdayYmd(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ───── Phase 5: checkout, payments and multi-chef ─────

/** Platform setting `fees.chef_network` (changes go through approvals): commission and customer fees for chef orders. */
export interface ChefNetworkFees {
  /** Gutad's commission on the food subtotal (after discounts) */
  commissionBps: number;
  /** customer fees on chef orders (replaces `fees.customer` at chef kitchens) */
  customer: CustomerFeeRules;
}

export const DEFAULT_CHEF_NETWORK_FEES: ChefNetworkFees = {
  commissionBps: 1500,
  customer: {
    service: { bps: 800, minCents: 199, capCents: 799, channels: [], fulfillments: ['DELIVERY', 'PICKUP'] },
    smallOrder: { thresholdCents: 1500, feeCents: 299, channels: [], fulfillments: ['DELIVERY', 'PICKUP'] },
    packaging: { perOrderCents: 0, perItemCents: 0, fulfillments: ['DELIVERY', 'PICKUP'] },
  },
};

/** Platform setting `chefs.policy`: acceptance window and the range chefs may choose for late-cancellation refunds. */
export interface ChefPolicy {
  /** hours a chef has to accept a new order (never later than 2 hours before the order's time) */
  acceptHours: number;
  lateRefundMinPct: number;
  lateRefundMaxPct: number;
  /** used when the chef hasn't chosen */
  lateRefundDefaultPct: number;
}

export const DEFAULT_CHEF_POLICY: ChefPolicy = { acceptHours: 12, lateRefundMinPct: 0, lateRefundMaxPct: 100, lateRefundDefaultPct: 0 };

/**
 * Refund for a customer cancellation of a prepaid chef order: in full before the date's cutoff, then the chef's
 * late-refund percentage of what was charged. Nothing once the chef has started cooking.
 */
export function chefCancellationRefund(o: { chargedCents: number; freeCancelUntil: string | Date | null; lateRefundPct: number | null; status: string }, now: Date = new Date()) {
  if (!['SUBMITTED', 'ACCEPTED'].includes(o.status)) return { allowed: false, refundCents: 0, full: false, reason: 'The chef has started on this order' };
  const until = o.freeCancelUntil ? new Date(o.freeCancelUntil) : null;
  if (o.status === 'SUBMITTED' || !until || now < until) return { allowed: true, refundCents: o.chargedCents, full: true, reason: 'Full refund' };
  const pct = Math.max(0, Math.min(100, o.lateRefundPct ?? 0));
  return { allowed: true, refundCents: Math.round((o.chargedCents * pct) / 100), full: pct === 100, reason: pct ? `${pct}% refund after the cutoff` : 'No refund after the cutoff' };
}

// ───── Phase 6: special requests and chef quotes ─────

/**
 * A customer's special request for a chef dish. The chef answers with a versioned quote (or a suggested
 * alternative), asks a question, or declines; the customer accepts and pays, asks for a revision, or withdraws.
 */
export const CHEF_REQUEST_STATUSES = ['PENDING', 'NEEDS_INFO', 'QUOTED', 'ACCEPTED', 'ORDERED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CLOSED'] as const;
export type ChefRequestStatus = (typeof CHEF_REQUEST_STATUSES)[number];
export const CHEF_REQUEST_STATUS_LABELS: Record<ChefRequestStatus, string> = {
  PENDING: 'Waiting for the chef',
  NEEDS_INFO: 'Chef has a question',
  QUOTED: 'Quote ready',
  ACCEPTED: 'Accepted, ready to pay',
  ORDERED: 'Ordered',
  DECLINED: 'Declined by the chef',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'Expired',
  CLOSED: 'Closed by Gutad',
};
/** statuses in which the request is still open */
export const CHEF_REQUEST_OPEN: ChefRequestStatus[] = ['PENDING', 'NEEDS_INFO', 'QUOTED', 'ACCEPTED'];

export const CHEF_REQUEST_TYPES = { ADD: 'Add an ingredient', REMOVE: 'Leave something out', SWAP: 'Swap an ingredient', PORTION: 'Different size or servings', OTHER: 'Something else' } as const;
export type ChefRequestType = keyof typeof CHEF_REQUEST_TYPES;
export const CHEF_REQUEST_REASONS = { PREFERENCE: 'Preference', ALLERGY: 'Allergy', DIETARY: 'Dietary need', OCCASION: 'Special occasion' } as const;
export type ChefRequestReason = keyof typeof CHEF_REQUEST_REASONS;

export type ChefRequestQuoteKind = 'QUOTE' | 'ALTERNATIVE';
export type ChefRequestQuoteStatus = 'SENT' | 'ACCEPTED' | 'SUPERSEDED' | 'REVISION_REQUESTED' | 'DECLINED' | 'EXPIRED' | 'ORDERED';

export interface ChefRequestQuote {
  id: string;
  version: number;
  kind: ChefRequestQuoteKind;
  status: ChefRequestQuoteStatus;
  /** the exact changes the chef will make */
  changes: string;
  portionDesc: string;
  /** food price per serving, confirmed by the chef */
  unitPriceCents: number;
  quantity: number;
  totalCents: number;
  allergens: string[];
  dietaryTags: string[];
  prepMinutes: number | null;
  serviceDate: string;
  serviceTime: string | null;
  note: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  /** the dish this quote sells (a suggested alternative can be another dish, even another chef's) */
  dish: { id: string; menuItemId: string; title: string; dishName: string; photo: string | null };
  chef: { id: string; slug: string; displayName: string };
  location: { id: string; slug: string; name: string };
  createdAt: string;
}

export interface ChefRequestMessage { id: string; authorRole: 'CUSTOMER' | 'CHEF' | 'STAFF' | 'SYSTEM'; authorName: string | null; body: string; createdAt: string }

export interface ChefRequestSummary {
  id: string;
  code: string;
  status: ChefRequestStatus;
  requestType: ChefRequestType;
  details: string;
  ingredient: string | null;
  servings: number;
  requestedDate: string;
  requestedTime: string | null;
  reason: ChefRequestReason;
  budgetCents: number | null;
  alternativesOk: boolean;
  respondBy: string | null;
  orderId: string | null;
  dish: { id: string; menuItemId: string; title: string; dishName: string; photo: string | null; priceCents: number };
  chef: { id: string; slug: string; displayName: string };
  customer?: { name: string | null };
  latestQuote: ChefRequestQuote | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface ChefRequestDetail extends ChefRequestSummary {
  baseOptionIds: string[];
  baseOptionNames: string[];
  alternativesNote: string | null;
  quotes: ChefRequestQuote[];
  messages: ChefRequestMessage[];
  /** what the viewer may do now */
  can: { quote: boolean; ask: boolean; decline: boolean; accept: boolean; revise: boolean; withdraw: boolean; message: boolean; close: boolean };
  viewerRole: 'CUSTOMER' | 'CHEF' | 'STAFF';
}

/** The cart line an accepted quote becomes (priced from the quote; quantity and date are fixed). */
export interface ChefQuoteCartLine {
  chefRequestQuoteId: string;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifierOptionIds: string[];
  modifierNames: string[];
  serviceDate: string;
  serviceTime: string | null;
  location: { id: string; slug: string; name: string };
  chefName: string;
}

/** Response and validity windows for special requests (setting `chefs.requests`). */
export interface ChefRequestPolicy {
  /** hours the chef has to answer a new request (or a revision) */
  chefResponseHours: number;
  /** default hours a quote stays valid for the customer */
  quoteValidHours: number;
  /** hours a customer has to answer the chef's question */
  customerReplyHours: number;
  /** open requests one customer may have at a time */
  maxOpenPerCustomer: number;
  /** escalation: remind the chef once this share (%) of their reply window has passed */
  reminderAtPct: number;
  /** escalation: alert Gutad operations when this many hours are left and the chef still hasn't answered */
  escalateHoursBefore: number;
}
export const DEFAULT_CHEF_REQUEST_POLICY: ChefRequestPolicy = { chefResponseHours: 24, quoteValidHours: 48, customerReplyHours: 72, maxOpenPerCustomer: 5, reminderAtPct: 50, escalateHoursBefore: 4 };

/** Short human code for a request ("R-7F3K2A") derived from its id. */
export function chefRequestCode(id: string) { return `R-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`; }

// ───── Phase 7: operations, quality and analytics ─────

/** Quality and compliance rules (setting `chefs.quality`). */
export interface ChefQualityPolicy {
  /** rolling window for quality metrics */
  windowDays: number;
  /** rates are judged only once a chef has this many orders in the window */
  minOrders: number;
  /** incidents (customer problems the chef owns) per 100 orders */
  maxIncidentRatePct: number;
  /** declined + unconfirmed orders per 100 orders */
  maxDeclineRatePct: number;
  /** a food-safety report on a chef order: suspend the dish (or pause the chef when the dish is unknown), pause the chef, or only alert */
  foodSafetyAction: 'SUSPEND_DISH' | 'PAUSE_CHEF' | 'ALERT';
  /** a required document expires: pause the chef until a renewal is approved, or only alert */
  expiredDocumentAction: 'PAUSE_CHEF' | 'ALERT';
  /** reminder days before a document expires */
  documentReminderDays: number[];
}
export const DEFAULT_CHEF_QUALITY_POLICY: ChefQualityPolicy = { windowDays: 30, minOrders: 10, maxIncidentRatePct: 10, maxDeclineRatePct: 20, foodSafetyAction: 'SUSPEND_DISH', expiredDocumentAction: 'PAUSE_CHEF', documentReminderDays: [30, 7] };

export const CHEF_QUALITY_EVENT_LABELS: Record<string, string> = {
  WARNING: 'Warning',
  PROBATION: 'Probation',
  NOTE: 'Note',
  THRESHOLD_BREACH: 'Quality threshold crossed',
  DISH_SUSPENDED: 'Dish suspended',
  DISH_REINSTATED: 'Dish reinstated',
  CHEF_PAUSED: 'Chef paused',
  CHEF_SUSPENDED: 'Chef suspended',
  CHEF_REINSTATED: 'Chef reinstated',
  DOCUMENT_EXPIRED: 'Document expired',
};

/** Staff quality actions (the API applies the suspension or reinstatement and records it). */
export const CHEF_QUALITY_ACTIONS = ['WARNING', 'PROBATION', 'NOTE', 'DISH_SUSPENDED', 'DISH_REINSTATED', 'CHEF_PAUSED', 'CHEF_SUSPENDED', 'CHEF_REINSTATED'] as const;
export type ChefQualityAction = (typeof CHEF_QUALITY_ACTIONS)[number];

/** A required document's state for a chef kitchen. */
export type ChefDocState = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'MISSING' | 'IN_REVIEW' | 'REJECTED';
export const CHEF_DOC_STATE_LABELS: Record<ChefDocState, string> = { VALID: 'Valid', EXPIRING: 'Expiring soon', EXPIRED: 'Expired', MISSING: 'Missing', IN_REVIEW: 'Renewal in review', REJECTED: 'Rejected' };
