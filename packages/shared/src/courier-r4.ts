// Courier Release 4: specialised categories — alcohol / age-restricted, catering, pharmacy / sensitive,
// temperature-controlled and high-value deliveries.

export const SPECIAL_CATEGORIES = ['ALCOHOL', 'CATERING', 'SENSITIVE', 'TEMP_CONTROLLED', 'HIGH_VALUE'] as const;
export type SpecialCategory = (typeof SPECIAL_CATEGORIES)[number];
export const SPECIAL_CATEGORY_LABELS: Record<SpecialCategory, string> = {
  ALCOHOL: 'Alcohol (ID check)',
  CATERING: 'Catering',
  SENSITIVE: 'Pharmacy / sensitive',
  TEMP_CONTROLLED: 'Temperature-controlled',
  HIGH_VALUE: 'High value',
};
/** Categories a courier is certified for (HIGH_VALUE comes from tenure instead). */
export const CERTIFIABLE_CATEGORIES = ['ALCOHOL', 'CATERING', 'SENSITIVE', 'TEMP_CONTROLLED'] as const;
export type CertifiableCategory = (typeof CERTIFIABLE_CATEGORIES)[number];
export const CERTIFICATION_STATUSES = ['NONE', 'TRAINING', 'PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED', 'REVOKED'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];
export const CERTIFICATION_STATUS_LABELS: Record<CertificationStatus, string> = {
  NONE: 'Not started', TRAINING: 'Training passed', PENDING: 'Waiting for review', ACTIVE: 'Active', REJECTED: 'Not approved', EXPIRED: 'Expired', REVOKED: 'Revoked',
};
/** Categories that are never batched with another order (TEMP_CONTROLLED may batch). */
export const NO_BATCH_CATEGORIES: SpecialCategory[] = ['ALCOHOL', 'CATERING', 'SENSITIVE', 'HIGH_VALUE'];

/** Category training: read, then answer every question. CERTIFICATE / SCREENING add staff review. */
export const CATEGORY_TRAINING: Record<CertifiableCategory, { title: string; body: string; needs: ('CERTIFICATE' | 'SCREENING')[]; questions: { q: string; options: string[]; answer: number }[] }> = {
  ALCOHOL: {
    title: 'Delivering alcohol',
    body: 'Alcohol is only handed to the customer named on the order, in person, after you check a valid government photo ID showing they are of legal age. Enter the date of birth and ID type in the app — it works out the age. Never leave alcohol at the door, never hand it to someone who appears intoxicated, and never deliver outside the allowed hours. If you cannot complete the check, tap “Can’t hand over” and return the order to the kitchen.',
    needs: ['CERTIFICATE'],
    questions: [
      { q: 'The customer says they left their ID at work. What do you do?', options: ['Hand it over if they look old enough', 'Refuse the handoff (no ID) and return the order', 'Leave it at the door'], answer: 1 },
      { q: 'The person at the door is clearly drunk but has a valid ID. What do you do?', options: ['Hand it over — the ID is valid', 'Refuse the handoff (intoxicated) and return the order', 'Give it to a neighbour'], answer: 1 },
      { q: 'Where does the returned alcohol go?', options: ['Back to the kitchen, which confirms receipt', 'You keep it', 'The bin'], answer: 0 },
    ],
  },
  CATERING: {
    title: 'Catering orders',
    body: 'Catering orders are large and often scheduled. Bring a car or van with room to keep trays flat. Count every item against the manifest at pickup and again with the customer at drop-off, get a signature, and when setup is requested lay out the food, utensils and labels before you leave. The app times setup and pays you for it.',
    needs: [],
    questions: [
      { q: 'What must happen at drop-off for a catering order?', options: ['Leave it at reception', 'Count the items with the customer and get a signature', 'Take a photo only'], answer: 1 },
      { q: 'Setup was requested. When do you tap “Setup done”?', options: ['Before you start', 'When the food, utensils and labels are laid out', 'Never'], answer: 1 },
    ],
  },
  SENSITIVE: {
    title: 'Pharmacy and sensitive items',
    body: 'Sensitive orders are sealed and may only be handed to the person named on the order. Check the seal before you hand it over, ask the recipient their name, and collect a signature. Never leave a sensitive order in a safe place, never open the seal, and never discuss the contents. If the seal is broken or the right person is not there, tap “Can’t hand over” and return it to the kitchen.',
    needs: ['SCREENING'],
    questions: [
      { q: 'The recipient is out; their flatmate offers to sign. What do you do?', options: ['Let the flatmate sign', 'Refuse the handoff (recipient mismatch) and return it', 'Leave it at the door with a photo'], answer: 1 },
      { q: 'You notice the seal is torn when you arrive. What do you do?', options: ['Hand it over anyway', 'Refuse the handoff (seal broken) and return it', 'Tape it shut'], answer: 1 },
    ],
  },
  TEMP_CONTROLLED: {
    title: 'Temperature-controlled orders',
    body: 'Some items must stay cold the whole way. Use a cold bag, go straight from pickup to the customer, and log a temperature reading when the app asks. If the trip runs long or a reading is too warm, the app flags it so support can sort out a remedy — still hand the order over unless the customer refuses it.',
    needs: [],
    questions: [
      { q: 'Which bag do temperature-controlled orders go in?', options: ['Any bag', 'A cold bag', 'Your backpack'], answer: 1 },
      { q: 'A reading at drop-off is too warm. What happens?', options: ['Throw the order away', 'Log it; the app flags it for support and you complete the handoff', 'Don’t log it'], answer: 1 },
    ],
  },
};

export const REFUSAL_REASONS = ['UNDERAGE', 'NO_ID', 'ID_INVALID', 'INTOXICATED', 'RECIPIENT_MISMATCH', 'OUTSIDE_HOURS', 'SEAL_BROKEN', 'CUSTOMER_REFUSED'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export const REFUSAL_LABELS: Record<RefusalReason, string> = {
  UNDERAGE: 'Customer is under age',
  NO_ID: 'No ID shown',
  ID_INVALID: 'ID invalid or expired',
  INTOXICATED: 'Customer appears intoxicated',
  RECIPIENT_MISMATCH: 'Not the named recipient',
  OUTSIDE_HOURS: 'Outside allowed delivery hours',
  SEAL_BROKEN: 'Seal broken',
  CUSTOMER_REFUSED: 'Customer refused the order',
};
export const ID_TYPES = ['DRIVERS_LICENSE', 'STATE_ID', 'PASSPORT', 'MILITARY_ID'] as const;
export const ID_TYPE_LABELS: Record<string, string> = { DRIVERS_LICENSE: 'Driver’s licence', STATE_ID: 'State / national ID', PASSPORT: 'Passport', MILITARY_ID: 'Military ID' };

/** setting `delivery.special` */
export interface SpecialCategoriesConfig {
  premiumCents: Record<SpecialCategory, number>;
  certValidDays: number;
  returnReceiveHours: number;
  alcohol: { minAge: number; requireDob: boolean; idTypes: string[]; deliveryHours: { start: string; end: string } };
  catering: { minSubtotalCents: number; minItems: number; vehicleTypes: string[]; setupRequired: boolean; setupPerMinuteCents: number; maxSetupMinutes: number; dispatchLeadMinutes: number };
  sensitive: { requireNameMatch: boolean };
  tempControl: { maxTransitMinutes: number; coldMaxC: number; requireReadings: boolean };
  highValue: { thresholdCents: number; minDeliveries: number; minRating: number; minAccountDays: number };
}
export const DEFAULT_SPECIAL: SpecialCategoriesConfig = {
  premiumCents: { ALCOHOL: 100, CATERING: 500, SENSITIVE: 150, TEMP_CONTROLLED: 100, HIGH_VALUE: 200 },
  certValidDays: 365,
  returnReceiveHours: 2,
  alcohol: { minAge: 21, requireDob: true, idTypes: [...ID_TYPES], deliveryHours: { start: '08:00', end: '23:00' } },
  catering: { minSubtotalCents: 30000, minItems: 30, vehicleTypes: ['CAR', 'VAN'], setupRequired: false, setupPerMinuteCents: 20, maxSetupMinutes: 30, dispatchLeadMinutes: 90 },
  sensitive: { requireNameMatch: true },
  tempControl: { maxTransitMinutes: 45, coldMaxC: 5, requireReadings: false },
  highValue: { thresholdCents: 25000, minDeliveries: 50, minRating: 4.7, minAccountDays: 14 },
};
/** Deep-merge a stored partial config over the defaults. */
export function specialConfig(stored: Partial<SpecialCategoriesConfig> | null | undefined): SpecialCategoriesConfig {
  const s = stored ?? {};
  return {
    ...DEFAULT_SPECIAL, ...s,
    premiumCents: { ...DEFAULT_SPECIAL.premiumCents, ...(s.premiumCents ?? {}) },
    alcohol: { ...DEFAULT_SPECIAL.alcohol, ...(s.alcohol ?? {}), deliveryHours: { ...DEFAULT_SPECIAL.alcohol.deliveryHours, ...(s.alcohol?.deliveryHours ?? {}) } },
    catering: { ...DEFAULT_SPECIAL.catering, ...(s.catering ?? {}) },
    sensitive: { ...DEFAULT_SPECIAL.sensitive, ...(s.sensitive ?? {}) },
    tempControl: { ...DEFAULT_SPECIAL.tempControl, ...(s.tempControl ?? {}) },
    highValue: { ...DEFAULT_SPECIAL.highValue, ...(s.highValue ?? {}) },
  };
}

/** Whole years between a date of birth (YYYY-MM-DD) and a local date (YYYY-MM-DD). */
export function ageOn(dob: string, onLocalDate: string): number {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = onLocalDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

/** Recipient check: same last name and first initial, ignoring case and accents. */
export function recipientMatches(expected: string | null | undefined, given: string | null | undefined): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const e = norm(expected ?? ''), g = norm(given ?? '');
  if (!e.length || !g.length) return false;
  if (e.length === 1 || g.length === 1) return e[e.length - 1] === g[g.length - 1];
  return e[e.length - 1] === g[g.length - 1] && e[0][0] === g[0][0];
}

/** What a courier must collect at the drop-off for a job's categories. */
export interface HandoffRequirements {
  categories: SpecialCategory[];
  ageCheck: { minAge: number; idTypes: string[]; requireDob: boolean } | null;
  signature: boolean;
  recipientName: string | null;
  pin: boolean;
  sealCheck: boolean;
  noSafePlace: boolean;
  tempControl: { maxTransitMinutes: number; coldMaxC: number; requireReadings: boolean } | null;
  catering: { setupRequired: boolean; headcount: number | null } | null;
}

/** Customer-facing version (order page). */
export interface CustomerHandoffRequirements { ageCheck: { minAge: number } | null; signature: boolean; recipientName: string | null; pin: boolean; noSafePlace: boolean; temperatureControlled: boolean }

export interface SpecialRecord {
  ageCheck?: { age: number; idType: string; idLast4?: string | null; checkedAt: string; legacy?: boolean };
  recipientName?: string;
  sealIntact?: boolean;
  temps?: { stage: 'PICKUP' | 'DROPOFF'; tempC: number; at: string }[];
  breach?: { kind: 'TRANSIT' | 'TEMPERATURE'; detail: string; at: string; incidentId?: string | null } | null;
  catering?: { setupStartedAt?: string | null; setupDoneAt?: string | null; setupMinutes?: number; checklist?: { itemsCounted?: boolean; utensils?: boolean; labelsShown?: boolean; setupDone?: boolean }; headcount?: number | null; setupRequired?: boolean };
  refusal?: { reason: RefusalReason; note?: string | null; at: string; incidentId?: string | null };
  returnReceived?: { at: string; byId: string; sealIntact: boolean; note?: string | null };
  premium?: { category: SpecialCategory; cents: number }[];
}
