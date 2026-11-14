// 25 Growth: promotion redemptions, referrals, reward challenges, gift cards, campaign holdouts
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { organizations, users } from './accounts';
import { campaigns, coupons } from './crm';

/** 25.4 one row per promotion applied to an accepted order: who funded what. */
export const offerRedemptions = pgTable(
  'offer_redemptions',
  {
    id: id(),
    promotionId: uuid('promotion_id').notNull().references(() => coupons.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id'),
    orderId: uuid('order_id').notNull(),
    userId: uuid('user_id'),
    organizationId: uuid('organization_id'),
    discountCents: integer('discount_cents').notNull(),
    platformFundedCents: integer('platform_funded_cents').notNull().default(0),
    merchantFundedCents: integer('merchant_funded_cents').notNull().default(0),
    orderSubtotalCents: integer('order_subtotal_cents').notNull().default(0),
    /** set when the order is canceled or refunded in full */
    reversedAt: ts('reversed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('offer_redemptions_promo_order_key').on(t.promotionId, t.orderId), index('offer_redemptions_user_idx').on(t.userId)],
);

/** 25.5 referrals: rewarded only after the referee's first completed order; suspicious pairs go to review. */
export const referrals = pgTable(
  'referrals',
  {
    id: id(),
    referrerId: uuid('referrer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    refereeId: uuid('referee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    /** PENDING | REVIEW | REWARDED | REJECTED */
    status: text('status').notNull().default('PENDING'),
    qualifyingOrderId: uuid('qualifying_order_id'),
    rewardPoints: integer('reward_points').notNull().default(500),
    /** [{ kind: DEVICE|PAYMENT|ADDRESS, detail }] */
    signals: jsonb('signals').notNull().default([]),
    reviewedById: uuid('reviewed_by_id'),
    reviewNote: text('review_note'),
    rewardedAt: ts('rewarded_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('referrals_referee_key').on(t.refereeId), index('referrals_referrer_idx').on(t.referrerId)],
);

/** 25.6 reward challenges, e.g. 3 orders in 14 days → $5 credit. */
export const challenges = pgTable('challenges', {
  id: id(),
  /** null = Gutad-wide (platform-funded) */
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  goalOrders: integer('goal_orders').notNull(),
  windowDays: integer('window_days').notNull(),
  minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
  locationIds: uuid('location_ids').array().notNull().default([]),
  rewardCents: integer('reward_cents').notNull(),
  rewardExpiresDays: integer('reward_expires_days').notNull().default(30),
  /** at most this many completions per customer (0 = unlimited) */
  maxCompletions: integer('max_completions').notNull().default(1),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  isActive: boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
});

export const challengeProgress = pgTable(
  'challenge_progress',
  {
    id: id(),
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    windowStart: ts('window_start').notNull(),
    windowEnd: ts('window_end').notNull(),
    count: integer('count').notNull().default(0),
    orderIds: uuid('order_ids').array().notNull().default([]),
    /** ACTIVE | COMPLETED | EXPIRED */
    status: text('status').notNull().default('ACTIVE'),
    completedAt: ts('completed_at'),
    creditId: uuid('credit_id'),
    createdAt: createdAt(),
  },
  (t) => [index('challenge_progress_user_idx').on(t.userId, t.challengeId)],
);

/** 25.9 gift cards. Balances are a liability (GIFT_CARD_LIABILITY) until redeemed. */
export const giftCards = pgTable(
  'gift_cards',
  {
    id: id(),
    code: text('code').notNull().unique(),
    /** PURCHASED (customer paid) | PROMOTIONAL (Gutad-funded) */
    kind: text('kind').notNull().default('PURCHASED'),
    currency: text('currency').notNull().default('USD'),
    initialCents: integer('initial_cents').notNull(),
    balanceCents: integer('balance_cents').notNull(),
    /** PENDING_REVIEW | ACTIVE | LOCKED | VOID */
    status: text('status').notNull().default('ACTIVE'),
    purchaserId: uuid('purchaser_id'),
    ownerId: uuid('owner_id'),
    recipientEmail: text('recipient_email'),
    recipientName: text('recipient_name'),
    message: text('message'),
    paymentId: uuid('payment_id'),
    issuedById: uuid('issued_by_id'),
    reason: text('reason'),
    lockedReason: text('locked_reason'),
    expiresAt: ts('expires_at'),
    claimedAt: ts('claimed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('gift_cards_owner_idx').on(t.ownerId), index('gift_cards_purchaser_idx').on(t.purchaserId)],
);

export const giftCardTxns = pgTable(
  'gift_card_txns',
  {
    id: id(),
    giftCardId: uuid('gift_card_id').notNull().references(() => giftCards.id, { onDelete: 'cascade' }),
    /** ISSUE | REDEEM | RESTORE | REFUND | VOID | ADJUST */
    kind: text('kind').notNull(),
    /** signed: + adds balance, − spends it */
    cents: integer('cents').notNull(),
    orderId: uuid('order_id'),
    actorId: uuid('actor_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('gift_card_txns_card_idx').on(t.giftCardId), index('gift_card_txns_order_idx').on(t.orderId)],
);

/** 25.10 treatment / holdout assignment per campaign and customer (stable, hash-based). */
export const campaignAssignments = pgTable(
  'campaign_assignments',
  {
    id: id(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** TREATMENT | HOLDOUT */
    grp: text('grp').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('campaign_assignments_key').on(t.campaignId, t.userId)],
);
