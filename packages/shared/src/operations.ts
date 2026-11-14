/** Inventory, food safety and workforce contracts shared by API, web and mobile (Phase I). */

export const ITEM_KINDS = ['INGREDIENT', 'COMPONENT', 'PACKAGING', 'CONSUMABLE'] as const;
export const STORAGE_KINDS = ['WAREHOUSE', 'DRY', 'COLD', 'FREEZER', 'KITCHEN'] as const;
export const MOVEMENT_KINDS = ['RECEIPT', 'CONSUMPTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT', 'ADJUSTMENT', 'SPOILAGE', 'WITHDRAWAL'] as const;

/** 21.2 unit conversions to a base unit (g, ml, each). */
export const UNIT_FACTORS: Record<string, { base: 'g' | 'ml' | 'each'; factor: number }> = {
  g: { base: 'g', factor: 1 }, kg: { base: 'g', factor: 1000 }, oz: { base: 'g', factor: 28.3495 }, lb: { base: 'g', factor: 453.592 },
  ml: { base: 'ml', factor: 1 }, l: { base: 'ml', factor: 1000 }, floz: { base: 'ml', factor: 29.5735 }, gal: { base: 'ml', factor: 3785.41 },
  each: { base: 'each', factor: 1 }, dozen: { base: 'each', factor: 12 },
};
/** Convert a quantity between units of the same family; null when they cannot be converted. */
export function convertUnits(qty: number, from: string, to: string): number | null {
  const a = UNIT_FACTORS[from], b = UNIT_FACTORS[to];
  if (!a || !b || a.base !== b.base) return from === to ? qty : null;
  return (qty * a.factor) / b.factor;
}

/** 22.2 default safe ranges (°C) by storage kind and log kind. */
export const DEFAULT_TEMP_RANGES: Record<string, { min: number | null; max: number | null }> = {
  COLD: { min: 0, max: 5 }, FREEZER: { min: -25, max: -15 }, RECEIVING_COLD: { min: null, max: 5 }, RECEIVING_FROZEN: { min: null, max: -12 }, HOT_HOLD: { min: 57, max: null }, COOLING: { min: null, max: 21 },
};

/** 22.3 starter checklist templates. */
export const DEFAULT_CHECKLISTS = [
  { name: 'Opening', kind: 'OPENING', frequency: 'DAILY', items: [{ key: 'handwash', label: 'Hand-wash stations stocked' }, { key: 'fridge_temps', label: 'Fridge and freezer temperatures logged', requiresValue: true }, { key: 'sanitizer', label: 'Sanitizer buckets at the right strength' }, { key: 'dates', label: 'Prepared items labelled and in date' }] },
  { name: 'Closing', kind: 'CLOSING', frequency: 'DAILY', items: [{ key: 'surfaces', label: 'Surfaces cleaned and sanitized' }, { key: 'food_stored', label: 'Food covered, labelled and stored' }, { key: 'waste', label: 'Waste logged and bins emptied' }, { key: 'equipment_off', label: 'Equipment off or on overnight setting' }] },
  { name: 'Allergen handling', kind: 'FOOD_HANDLING', frequency: 'SHIFT', items: [{ key: 'separate_tools', label: 'Separate tools for allergy orders' }, { key: 'labels', label: 'Allergy labels on every allergy order' }] },
] as const;

/** 23.x workforce settings (setting `workforce.config`). */
export interface WorkforceConfig { ordersPerStaffHour: number; minStaffPerHour: number; overtimeWeeklyHours: number; overtimeMultiplier: number; defaultRateCents: number }
export const DEFAULT_WORKFORCE: WorkforceConfig = { ordersPerStaffHour: 8, minStaffPerHour: 1, overtimeWeeklyHours: 40, overtimeMultiplier: 1.5, defaultRateCents: 1800 };

export const EQUIPMENT_STATUSES = ['OK', 'DEGRADED', 'DOWN', 'MAINTENANCE'] as const;
export const DEVICE_KINDS = ['TABLET', 'KDS', 'KIOSK', 'PRINTER', 'SCANNER'] as const;
