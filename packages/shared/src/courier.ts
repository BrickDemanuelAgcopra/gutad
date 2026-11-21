/**
 * Courier Release 1: onboarding, eligibility, lifecycle, offers, pay policy, pickup checks and delivery reviews.
 * Shared by the API, web and mobile.
 */
import type { VehicleType } from './delivery';

// ───── onboarding ─────

/** Application status, before a courier may work. */
export const APPLICATION_STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFICATION_PENDING', 'NEEDS_ACTION', 'APPROVED', 'WAITLISTED', 'REJECTED'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: 'Application in progress',
  SUBMITTED: 'Submitted',
  VERIFICATION_PENDING: 'Being verified',
  NEEDS_ACTION: 'Needs your attention',
  APPROVED: 'Approved',
  WAITLISTED: 'On the waitlist',
  REJECTED: 'Not approved',
};

/** Account lifecycle, after approval. Kept separate from the application. */
export const LIFECYCLE_STATUSES = ['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED', 'REACTIVATION_PENDING'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  ACTIVE: 'Active',
  RESTRICTED: 'Temporarily restricted',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
  REACTIVATION_PENDING: 'Reactivation pending',
};

/** Independent eligibility checks. Each can pass, fail or expire on its own. */
export const ELIGIBILITY_CHECKS = ['IDENTITY', 'VEHICLE', 'SCREENING', 'PAYOUT', 'AGREEMENT', 'TRAINING', 'EQUIPMENT'] as const;
export type EligibilityCheck = (typeof ELIGIBILITY_CHECKS)[number];
export const ELIGIBILITY_LABELS: Record<EligibilityCheck, string> = {
  IDENTITY: 'Identity',
  VEHICLE: 'Vehicle & licence',
  SCREENING: 'Background screening',
  PAYOUT: 'Payout account',
  AGREEMENT: 'Courier agreement',
  TRAINING: 'Training',
  EQUIPMENT: 'Equipment',
};
export const CHECK_STATUSES = ['NOT_STARTED', 'PENDING', 'PASSED', 'NEEDS_ACTION', 'FAILED', 'EXPIRED'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** The onboarding wizard, in order. `checks` lists the eligibility checks a step feeds. */
export const ONBOARDING_STEPS = [
  { key: 'location', label: 'Where you’ll deliver', help: 'Country, city, delivery areas and how you get around.' },
  { key: 'account', label: 'Verify your contact details', help: 'Confirm your email so we can reach you.' },
  { key: 'profile', label: 'Your profile', help: 'Legal name, address, photo and languages.' },
  { key: 'identity', label: 'Identity', help: 'Upload a government photo ID.' },
  { key: 'vehicle', label: 'Vehicle', help: 'Vehicle details and the documents your vehicle type needs.' },
  { key: 'screening', label: 'Background screening', help: 'Consent to a background check.' },
  { key: 'payout', label: 'Payouts', help: 'Where we send your earnings, and tax details.' },
  { key: 'agreement', label: 'Courier agreement', help: 'Read and accept the agreement and policies.' },
  { key: 'training', label: 'Training', help: 'Food handling, pickup, customers, proof and problems.' },
  { key: 'equipment', label: 'Equipment', help: 'Confirm your insulated bag and other gear.' },
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];

export const COURIER_AGREEMENT_VERSION = 'courier-agreement-2026-11';
export const SCREENING_CONSENT_VERSION = 'screening-consent-2026-11';
export const COURIER_OPERATING_MODEL = 'INDEPENDENT_CONTRACTOR';
export const COURIER_AGREEMENT_SUMMARY = [
  'You choose when to go online and which offers to accept.',
  'Each offer shows its guaranteed pay before you accept; tips are shown separately and are always 100% yours.',
  'Keep food sealed, upright and at the right temperature; never open a sealed bag.',
  'Hand off only with the required proof (photo, PIN, signature or ID check).',
  'Report problems in the app as they happen; do not reassign or hand an order to someone else.',
  'Treat customers, kitchen staff and other couriers with respect; harassment ends your access.',
  'Your data is used to run deliveries, pay you and keep everyone safe, as set out in the Privacy Policy.',
];

/** Documents a vehicle type needs (photo ID is always required, under the identity step). */
export function requiredDocsFor(vehicle: VehicleType | string): string[] {
  return ['CAR', 'VAN', 'SCOOTER'].includes(vehicle) ? ['ID', 'LICENSE', 'INSURANCE', 'VEHICLE_REGISTRATION'] : ['ID'];
}
export const MOTOR_VEHICLES = ['CAR', 'VAN', 'SCOOTER'];

export const EQUIPMENT_ITEMS = ['INSULATED_BAG', 'DRINK_CARRIER', 'COLD_BAG', 'PHONE_MOUNT'] as const;
export type EquipmentItem = (typeof EQUIPMENT_ITEMS)[number];
export const EQUIPMENT_LABELS: Record<EquipmentItem, string> = { INSULATED_BAG: 'Insulated delivery bag', DRINK_CARRIER: 'Drink carrier', COLD_BAG: 'Cold bag', PHONE_MOUNT: 'Phone mount' };
export const REQUIRED_EQUIPMENT: EquipmentItem[] = ['INSULATED_BAG'];

/** Training modules: read, then answer one question correctly. */
export const TRAINING_MODULES = [
  { key: 'FOOD_HANDLING', title: 'Food handling', body: 'Keep hot food in the insulated bag and cold items in a cold bag, upright and apart. Never open a sealed bag, eat, or add anything. Go straight from pickup to the customer.', question: 'The bag seal is broken when the kitchen hands it to you. What do you do?', options: ['Take it anyway', 'Report it before leaving', 'Reseal it yourself'], answer: 1 },
  { key: 'PICKUP', title: 'Picking up', body: 'Check the order code, the number of bags and drinks, and that every seal is intact. If something is missing or the order is not ready, report it in the app before you leave.', question: 'Which of these must you check at pickup?', options: ['Only the customer name', 'Order code, bag count and seals', 'Nothing, the kitchen checks'], answer: 1 },
  { key: 'CUSTOMER_COMMUNICATION', title: 'Customers', body: 'Use the in-app contact options; your number and theirs stay private. Follow the delivery instructions, be polite, and never ask for a rating or a tip.', question: 'How do you contact a customer?', options: ['Through the app', 'Your personal phone number', 'Social media'], answer: 0 },
  { key: 'DELIVERY_EVIDENCE', title: 'Proof of delivery', body: 'Complete every handoff with the required proof: a clear photo showing the order at the door, the customer’s PIN, a signature, or an ID check for restricted items.', question: 'An order contains alcohol and the customer has no ID. What happens?', options: ['Leave it at the door', 'Do not hand it over; report the failed ID check', 'Hand it to a neighbour'], answer: 1 },
  { key: 'EXCEPTIONS', title: 'When things go wrong', body: 'Report problems in the app: order not ready, restaurant closed, missing items, customer unreachable, unsafe location, vehicle breakdown. After pickup, never pass the order to another courier; we will tell you what to do.', question: 'Your bike breaks down after pickup. What do you do?', options: ['Ask a friend to deliver it', 'Report it in the app and wait for instructions', 'Go home'], answer: 1 },
] as const;
export type TrainingModuleKey = (typeof TRAINING_MODULES)[number]['key'];

/** Setting `delivery.recruitment`: where new couriers can sign up. City keys are lower case. */
export interface RecruitmentConfig { open: boolean; requireVerifiedContact: boolean; cities: Record<string, { open?: boolean; maxActive?: number | null }> }
export const DEFAULT_RECRUITMENT: RecruitmentConfig = { open: true, requireVerifiedContact: true, cities: {} };

// ───── availability & dispatch ─────

export const AVAILABILITY_MODES = ['ON_DEMAND', 'RESERVED'] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];
/** Setting `delivery.availability`. */
export interface AvailabilityConfig { locationFreshMinutes: number; checkInEarlyMinutes: number; noShowAfterMinutes: number }
export const DEFAULT_AVAILABILITY: AvailabilityConfig = { locationFreshMinutes: 15, checkInEarlyMinutes: 15, noShowAfterMinutes: 15 };

/** Reasons a courier cannot receive offers right now. */
export const NOT_DISPATCHABLE_LABELS: Record<string, string> = {
  NOT_APPROVED: 'Your application is not approved yet',
  LIFECYCLE: 'Your account is not active',
  DOCS_EXPIRED: 'A required document has expired',
  CHECK_EXPIRED: 'An eligibility check has expired or failed',
  OFFLINE: 'You are offline',
  ON_BREAK: 'You are on a break',
  FINISHING: 'You asked to stop after your current delivery',
  NO_LOCATION: 'We have no recent location for you',
  AT_CAPACITY: 'You are carrying as many orders as you can',
};

// ───── pay ─────

/** Setting `delivery.pay`: the versioned courier pay policy. Each accepted offer keeps a snapshot. */
export interface CourierPayPolicy {
  version: number;
  baseCents: number;
  perKmCents: number;
  perMinuteCents: number;
  /** waiting at pickup beyond the grace period is paid per minute */
  waitingGraceMinutes: number;
  waitingPerMinuteCents: number;
  /** returning an order to the kitchen */
  returnCents: number;
  /** canceled after the courier arrived at pickup */
  cancelAfterArrivalCents: number;
  /** hours before earnings become available for payout */
  holdHours: number;
}
export const DEFAULT_PAY_POLICY: CourierPayPolicy = { version: 1, baseCents: 500, perKmCents: 80, perMinuteCents: 0, waitingGraceMinutes: 5, waitingPerMinuteCents: 15, returnCents: 300, cancelAfterArrivalCents: 300, holdHours: 24 };

export interface OfferPay { baseCents: number; distanceCents: number; timeCents: number; totalCents: number }
/** Guaranteed pay for a trip. Distance and time are already inside it; waiting, return and cancellation pay are added later. */
export function offerPay(policy: CourierPayPolicy, km: number, minutes: number): OfferPay {
  const distanceCents = Math.round(Math.max(0, km) * policy.perKmCents);
  const timeCents = Math.round(Math.max(0, minutes) * policy.perMinuteCents);
  return { baseCents: policy.baseCents, distanceCents, timeCents, totalCents: policy.baseCents + distanceCents + timeCents };
}
export function waitingPay(policy: CourierPayPolicy, waitedMinutes: number) {
  const paid = Math.max(0, Math.floor(waitedMinutes - policy.waitingGraceMinutes));
  return { minutes: paid, cents: paid * policy.waitingPerMinuteCents };
}

export const EARNING_KINDS = ['DELIVERY', 'CANCEL_COMP', 'BONUS', 'DEDUCTION'] as const;

// ───── pickup, handoff and trip problems ─────

export interface PickupCheck { orderCode?: string; bagCount: number; drinkCount?: number; sealIntact: boolean; note?: string }

/** Problems a courier can raise on a trip (besides customer-unreachable, which has its own wait-timer flow). */
export const TRIP_ISSUES = {
  ORDER_NOT_READY: { label: 'Order not ready', stage: 'PICKUP' },
  RESTAURANT_CLOSED: { label: 'Restaurant closed', stage: 'PICKUP' },
  MISSING_ITEMS: { label: 'Missing items or bags', stage: 'PICKUP' },
  DAMAGED_PACKAGING: { label: 'Damaged packaging or broken seal', stage: 'PICKUP' },
  ALREADY_COLLECTED: { label: 'Order already collected', stage: 'PICKUP' },
  VEHICLE_BREAKDOWN: { label: 'Vehicle breakdown', stage: 'ANY' },
  CANNOT_CONTINUE: { label: 'I can’t continue this delivery', stage: 'ANY' },
  UNSAFE: { label: 'Unsafe situation', stage: 'ANY' },
  ID_CHECK_FAILED: { label: 'ID check failed (restricted items)', stage: 'DROPOFF' },
} as const;
export type TripIssue = keyof typeof TRIP_ISSUES;

export const HANDOFF_METHODS = ['PHOTO', 'PIN', 'SIGNATURE'] as const;

// ───── delivery reviews ─────

export const REVIEW_TAGS_POSITIVE = ['GREAT_COMMUNICATION', 'HANDLED_WITH_CARE', 'FOLLOWED_INSTRUCTIONS', 'PROFESSIONAL', 'FAST'] as const;
export const REVIEW_TAGS_NEGATIVE = ['POOR_COMMUNICATION', 'CARELESS_HANDLING', 'IGNORED_INSTRUCTIONS', 'UNPROFESSIONAL', 'LATE'] as const;
export const REVIEW_TAG_LABELS: Record<string, string> = {
  GREAT_COMMUNICATION: 'Great communication', HANDLED_WITH_CARE: 'Handled with care', FOLLOWED_INSTRUCTIONS: 'Followed instructions', PROFESSIONAL: 'Professional', FAST: 'Fast',
  POOR_COMMUNICATION: 'Poor communication', CARELESS_HANDLING: 'Careless handling', IGNORED_INSTRUCTIONS: 'Ignored instructions', UNPROFESSIONAL: 'Unprofessional', LATE: 'Late',
};
/** Serious problems go to support as a case, not into the star average. */
export const REVIEW_ISSUES = { MISSING_ITEMS: 'Items were missing', NOT_RECEIVED: 'I didn’t receive my order', DAMAGED: 'Food or packaging was damaged', SAFETY: 'Safety concern' } as const;
export type ReviewIssue = keyof typeof REVIEW_ISSUES;
export const REVIEW_STATUSES = ['VISIBLE', 'PENDING_MODERATION', 'HIDDEN'] as const;
export const REVIEW_EDIT_DAYS = 7;

/** Photos a courier uploads (stored privately; referenced as `/files/<id>`). */
export const COURIER_PHOTO_PURPOSES = ['HANDOFF', 'SAFE_PLACE', 'PROFILE', 'EQUIPMENT', 'ISSUE'] as const;
export type CourierPhotoPurpose = (typeof COURIER_PHOTO_PURPOSES)[number];
