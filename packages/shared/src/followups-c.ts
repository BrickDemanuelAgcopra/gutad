/** 20.7-L ledger lock: what happens to a posting dated in a closed month (setting `accounting.ledgerLock`). */
export interface LedgerLockConfig {
  /** redirect = post into the current open month with a memo naming the original date; reject = refuse (PERIOD_CLOSED) */
  mode: 'redirect' | 'reject';
}
export const DEFAULT_LEDGER_LOCK: LedgerLockConfig = { mode: 'redirect' };

/** 20.1-L general-ledger push adapters (CSV export stays the default; MOCK is for tests and demos). */
export const GL_PROVIDERS = [
  { key: 'MOCK', label: 'Mock ledger (testing)' },
  { key: 'QBO', label: 'QuickBooks Online' },
  { key: 'XERO', label: 'Xero' },
] as const;
export type GlProvider = (typeof GL_PROVIDERS)[number]['key'];
export type GlPushStatus = 'PENDING' | 'PUSHING' | 'PUSHED' | 'FAILED';

/** 21.6-S demand forecast: seasonal / trend factors and promotion uplift (setting `inventory.forecast`). */
export interface ForecastConfig {
  /** recent-weeks trend: last 2 weeks vs the 2 weeks before, blended in by `trendWeight` (0 = off, 1 = full) */
  trend: { enabled: boolean; weight: number };
  /** same weeks last year (364 days back, weekday aligned) vs the 4 weeks before them */
  yearOverYear: { enabled: boolean; weight: number };
  /** clamp for the combined seasonal factor */
  minFactor: number;
  maxFactor: number;
  /** active automatic offers / campaign coupons touching an ingredient's items lift demand on the days they run */
  promotions: { enabled: boolean; upliftPct: number; maxUpliftPct: number };
}
export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  trend: { enabled: true, weight: 0.5 },
  yearOverYear: { enabled: true, weight: 1 },
  minFactor: 0.5,
  maxFactor: 2,
  promotions: { enabled: true, upliftPct: 20, maxUpliftPct: 60 },
};

/** 21.8-P supplier invoice submissions (portal page, EDI 810, CSV). */
export const SUPPLIER_INVOICE_SOURCES = ['PORTAL', 'EDI_810', 'CSV'] as const;
export type SupplierInvoiceSource = (typeof SUPPLIER_INVOICE_SOURCES)[number];

/** 22.2-S wireless temperature sensors (setting `safety.sensors`). */
export interface SensorConfig {
  /** a sensor silent this long is flagged offline with one alert per outage */
  offlineAfterMinutes: number;
  /** in-range readings are kept as temperature logs at most this often per sensor; out-of-range ones always are */
  logEveryMinutes: number;
}
export const DEFAULT_SENSOR_CONFIG: SensorConfig = { offlineAfterMinutes: 30, logEveryMinutes: 15 };

/** 23.3-P payroll providers (CSV export stays available; MOCK is the default adapter). */
export const PAYROLL_PROVIDERS = [
  { key: 'MOCK', label: 'Mock payroll (testing)' },
  { key: 'GUSTO', label: 'Gusto' },
  { key: 'ADP', label: 'ADP Workforce Now' },
] as const;
export type PayrollProvider = (typeof PAYROLL_PROVIDERS)[number]['key'];

/** 23.8-V equipment vendor feeds: telemetry & maintenance in, status pulled; never commands out. */
export const EQUIPMENT_VENDORS = [
  { key: 'MOCK', label: 'Mock vendor (testing)' },
  { key: 'GENERIC', label: 'Generic webhook (push only)' },
  { key: 'RATIONAL', label: 'Rational ConnectedCooking' },
  { key: 'WELBILT', label: 'Welbilt KitchenConnect' },
] as const;
export type EquipmentVendor = (typeof EQUIPMENT_VENDORS)[number]['key'];
export const EQUIPMENT_EVENT_KINDS = ['TELEMETRY', 'MAINTENANCE', 'FAULT', 'STATUS'] as const;
