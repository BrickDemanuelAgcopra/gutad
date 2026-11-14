/** Kitchen display, packing and handoff contracts shared by API, web and mobile (Phase F). */

export const HANDLING_FLAGS = ['HOT', 'COLD', 'FRAGILE', 'ALLERGEN'] as const;
export type HandlingFlag = (typeof HANDLING_FLAGS)[number];
export const HANDLING_LABELS: Record<HandlingFlag, string> = { HOT: 'Hot', COLD: 'Cold', FRAGILE: 'Fragile', ALLERGEN: 'Allergy order' };

/** 13.6 reason codes for remakes, missing items and quality failures. */
export const KITCHEN_EVENT_KINDS = ['REMAKE', 'MISSING', 'QUALITY_FAIL'] as const;
export type KitchenEventKind = (typeof KITCHEN_EVENT_KINDS)[number];
export const KITCHEN_REASONS: Record<string, string> = {
  WRONG_BUILD: 'Built wrong (modifiers / recipe)',
  UNDERCOOKED: 'Undercooked',
  OVERCOOKED: 'Overcooked or burnt',
  COLD_FOOD: 'Went cold while waiting',
  DROPPED: 'Dropped or spilled',
  FOREIGN_OBJECT: 'Foreign object',
  ALLERGEN_RISK: 'Allergen cross-contact risk',
  PRESENTATION: 'Presentation below standard',
  CUSTOMER_COMPLAINT: 'Customer complaint',
  NOT_PACKED: 'Not packed',
  OUT_OF_STOCK: 'Out of stock',
  OTHER: 'Other',
};

/** 13.7 auto-throttle defaults (setting `kitchen.autoThrottle`, per-kitchen overrides). */
export interface AutoThrottle { enabled: boolean; busyAtActiveTickets: number; overloadAtActiveTickets: number; busyExtraMinutes: number; recoverRatio: number }
export const DEFAULT_AUTO_THROTTLE: AutoThrottle = { enabled: true, busyAtActiveTickets: 12, overloadAtActiveTickets: 20, busyExtraMinutes: 10, recoverRatio: 0.7 };

/** 14.5 / 14.7 pickup policy defaults (setting `pickup.policy`). */
export interface PickupPolicy { waitAlertMinutes: number; noShowNotifyMinutes: number; noShowResolveMinutes: number; noShowResolution: 'CHARGE' | 'REFUND' }
export const DEFAULT_PICKUP_POLICY: PickupPolicy = { waitAlertMinutes: 10, noShowNotifyMinutes: 20, noShowResolveMinutes: 60, noShowResolution: 'CHARGE' };

/** 14.3 a note that mentions an allergy marks the line allergen-sensitive. */
export const mentionsAllergy = (note?: string | null) => !!note && /allerg|anaphyla|celiac|coeliac|epipen|nut[- ]free|gluten[- ]free/i.test(note);

/** 14.2 hot and cold items travel in separate bags. */
export function suggestBags(lineFlags: string[][]): number {
  const all = new Set(lineFlags.flat());
  return all.has('HOT') && all.has('COLD') ? 2 : 1;
}

/** 13.3 when a station should start so the order finishes together. */
export function fireAt(readyBy: Date, cookMinutes: number, now = new Date()): Date {
  const t = new Date(readyBy.getTime() - cookMinutes * 60_000);
  return t < now ? now : t;
}
