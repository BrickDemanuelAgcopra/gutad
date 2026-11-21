// Courier Release 3: demand forecast, incentive campaigns, fraud review, reconciliation postings, instant payouts.

/** setting `delivery.forecast` */
export interface CourierForecastConfig {
  lookbackWeeks: number;
  horizonDays: number;
  /** deliveries one courier completes per hour */
  jobsPerCourierHour: number;
  /** a zone/hour shows as a "Busy time" when needed − supply ≥ this */
  gapAlertCouriers: number;
}
export const DEFAULT_COURIER_FORECAST: CourierForecastConfig = { lookbackWeeks: 8, horizonDays: 7, jobsPerCourierHour: 2.2, gapAlertCouriers: 2 };

export const CAMPAIGN_KINDS = ['BOOST', 'QUEST', 'GUARANTEE'] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];
export const CAMPAIGN_KIND_LABELS: Record<CampaignKind, string> = { BOOST: 'Boost per delivery', QUEST: 'Delivery quest', GUARANTEE: 'Hourly guarantee' };
export const CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** rules by kind: BOOST { boostCents?, boostPercent? } · QUEST { tiers: { deliveries, bonusCents }[] } · GUARANTEE { minPerHourCents, minOnlineMinutes } */
export interface CampaignRules {
  boostCents?: number;
  boostPercent?: number;
  tiers?: { deliveries: number; bonusCents: number }[];
  minPerHourCents?: number;
  minOnlineMinutes?: number;
}
export interface CampaignEligibility { minRating?: number | null; vehicleTypes?: string[]; minDeliveries?: number | null }

/** QUEST payout: the highest tier reached. */
export function questPayout(rules: CampaignRules, deliveries: number): { bonusCents: number; reached: number | null; next: { deliveries: number; bonusCents: number } | null } {
  const tiers = [...(rules.tiers ?? [])].sort((a, b) => a.deliveries - b.deliveries);
  const hit = tiers.filter((t) => deliveries >= t.deliveries).pop() ?? null;
  const next = tiers.find((t) => deliveries < t.deliveries) ?? null;
  return { bonusCents: hit?.bonusCents ?? 0, reached: hit?.deliveries ?? null, next };
}
/** GUARANTEE top-up: minimum for the online time less what was earned in the window (never negative). */
export function guaranteeTopUp(rules: CampaignRules, onlineMinutes: number, earnedCents: number): number {
  if (onlineMinutes < (rules.minOnlineMinutes ?? 60)) return 0;
  return Math.max(0, Math.round(((rules.minPerHourCents ?? 0) * onlineMinutes) / 60) - earnedCents);
}
/** BOOST amount for a delivery paying `payCents`. */
export function boostCents(rules: CampaignRules, payCents: number): number {
  return Math.max(0, Math.round((rules.boostCents ?? 0) + (payCents * (rules.boostPercent ?? 0)) / 100));
}

export const RISK_SIGNAL_TYPES = ['GPS_JUMP', 'DROPOFF_FAR', 'PROOF_REUSED', 'RELEASE_PATTERN', 'SHARED_PAYOUT', 'SHARED_PHONE', 'COLLUSION', 'INCENTIVE_GAMING', 'UNREACHABLE_PATTERN', 'MANUAL'] as const;
export type RiskSignalType = (typeof RISK_SIGNAL_TYPES)[number];
export const RISK_SIGNAL_LABELS: Record<RiskSignalType, string> = {
  GPS_JUMP: 'Impossible location jump',
  DROPOFF_FAR: 'Delivered far from the drop-off',
  PROOF_REUSED: 'Proof photo used before',
  RELEASE_PATTERN: 'Repeated releases after arriving',
  SHARED_PAYOUT: 'Payout account shared with another courier',
  SHARED_PHONE: 'Phone shared with another courier',
  COLLUSION: 'Repeated deliveries to one customer with unusual tips',
  INCENTIVE_GAMING: 'Unusual pattern during an incentive',
  UNREACHABLE_PATTERN: 'Repeated "customer unreachable" returns',
  MANUAL: 'Raised by staff',
};
export const FRAUD_DECISIONS = ['CLEAR', 'WARN', 'CLAWBACK', 'RESTRICT', 'SUSPEND'] as const;
export type FraudDecision = (typeof FRAUD_DECISIONS)[number];

/** setting `delivery.fraud` */
export interface FraudConfig {
  reviewThreshold: number;
  holdThreshold: number;
  weights: Record<RiskSignalType, number>;
  dropoffFarMeters: number;
  maxSpeedKmh: number;
  windowDays: number;
}
export const DEFAULT_FRAUD: FraudConfig = {
  reviewThreshold: 40,
  holdThreshold: 70,
  weights: { GPS_JUMP: 15, DROPOFF_FAR: 20, PROOF_REUSED: 40, RELEASE_PATTERN: 15, SHARED_PAYOUT: 50, SHARED_PHONE: 25, COLLUSION: 30, INCENTIVE_GAMING: 30, UNREACHABLE_PATTERN: 20, MANUAL: 40 },
  dropoffFarMeters: 300,
  maxSpeedKmh: 200,
  windowDays: 30,
};

/** setting `payouts.instant` */
export interface InstantPayoutConfig { enabled: boolean; feeCents: number; minCents: number; dailyCount: number; dailyMaxCents: number; minAccountAgeDays: number }
export const DEFAULT_INSTANT_PAYOUT: InstantPayoutConfig = { enabled: true, feeCents: 50, minCents: 500, dailyCount: 3, dailyMaxCents: 50000, minAccountAgeDays: 7 };

/** setting `delivery.recon` */
export interface ReconConfig { toleranceCents: number }
export const DEFAULT_RECON: ReconConfig = { toleranceCents: 50 };
