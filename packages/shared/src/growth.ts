/** Growth contracts shared by API, web and mobile (Phase J): offers, gift cards, memberships, challenges, referrals. */

/** Setting `giftcards.limits` (25.9 fraud controls). */
export interface GiftCardLimits {
  minCardCents: number;
  maxCardCents: number;
  /** purchases per buyer in a rolling 24 hours */
  maxPurchasesPerDay: number;
  maxCentsPerDay: number;
  /** purchased cards above this wait for a second person before delivery */
  reviewAboveCents: number;
  /** wrong codes per customer per hour before gift cards are locked for them */
  maxFailedRedeemsPerHour: number;
}
export const DEFAULT_GIFT_CARD_LIMITS: GiftCardLimits = { minCardCents: 500, maxCardCents: 50000, maxPurchasesPerDay: 3, maxCentsPerDay: 50000, reviewAboveCents: 25000, maxFailedRedeemsPerHour: 5 };

/** Setting `membership.dunning` (25.8): retry schedule after a failed renewal and the grace period. */
export interface MembershipDunning {
  /** days after each failure until the next retry; after the last one the membership is suspended */
  retryDays: number[];
  /** benefits continue this many days after the first failure */
  graceDays: number;
}
export const DEFAULT_MEMBERSHIP_DUNNING: MembershipDunning = { retryDays: [1, 3, 5], graceDays: 7 };

/** Setting `growth.referrals` (25.5). */
export interface ReferralRules { rewardPoints: number; reviewOnSignals: boolean }
export const DEFAULT_REFERRAL_RULES: ReferralRules = { rewardPoints: 500, reviewOnSignals: true };

export const OFFER_KINDS = ['PERCENT', 'FIXED', 'FREE_DELIVERY', 'BOGO', 'FREE_ITEM'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];
export const OFFER_STACKING = ['EXCLUSIVE', 'STACKABLE'] as const;
export type OfferStacking = (typeof OFFER_STACKING)[number];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** A promotion applied to a quote (codeless offer or a code). */
export interface AppliedPromotion {
  promotionId: string;
  code: string | null;
  name: string;
  automatic: boolean;
  kind: OfferKind;
  discountCents: number;
  freeDelivery: boolean;
  funder: 'MERCHANT' | 'PLATFORM';
  platformShareCents: number;
  campaignId: string | null;
}

/** 11.6 how the order total is paid, in the order tenders are applied. */
export interface PaymentMix {
  creditsCents: number;
  loyaltyCents: number;
  giftCents: number;
  cardCents: number;
}

export const MEMBERSHIP_STATUS_LABELS: Record<string, string> = { TRIALING: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment failed', SUSPENDED: 'Suspended', CANCELED: 'Canceled' };
export const REFERRAL_STATUS_LABELS: Record<string, string> = { PENDING: 'Waiting for first order', REVIEW: 'Under review', REWARDED: 'Rewarded', REJECTED: 'Not eligible' };

/** Setting `giftcards.escheat` (25.9-E): dormancy before a balance is reportable, by US state (default otherwise). */
export interface EscheatRules { defaultDormancyYears: number; byState: Record<string, number> }
export const DEFAULT_ESCHEAT_RULES: EscheatRules = { defaultDormancyYears: 5, byState: { CA: 3, NY: 5, NJ: 3, TX: 3, FL: 5, IL: 5 } };
