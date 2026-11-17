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
