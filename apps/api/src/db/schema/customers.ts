// Admin platform, phase E: saved payment methods (masked), customer restrictions with appeals, platform segments.
import { boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { users } from './accounts';

/** A customer's saved card as the processor reports it. Only the token reference and masked details are stored. */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** processor token (pm_…); never a card number */
    providerRef: text('provider_ref').notNull(),
    brand: text('brand'),
    last4: text('last4'),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('payment_methods_user_idx').on(t.userId)],
);

/** A restriction on a customer account (ordering block, promo block, refund review) with a reason and an appeal. */
export const customerRestrictions = pgTable(
  'customer_restrictions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ORDERING_BLOCKED | PROMOTIONS_BLOCKED | REFUND_REVIEW | CASH_LIMIT | CREDIT_LIMIT */
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    /** 10.8-L CASH_LIMIT / CREDIT_LIMIT: the cap in cents (per order, or per rolling window when periodDays is set) */
    limitCents: integer('limit_cents'),
    /** 10.8-L rolling window in days for the cap; null = per order */
    periodDays: integer('period_days'),
    createdById: uuid('created_by_id'),
    expiresAt: ts('expires_at'),
    liftedAt: ts('lifted_at'),
    liftedById: uuid('lifted_by_id'),
    /** NONE | PENDING | UPHELD | LIFTED */
    appealStatus: text('appeal_status').notNull().default('NONE'),
    appealNote: text('appeal_note'),
    appealDecisionNote: text('appeal_decision_note'),
    appealedAt: ts('appealed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('customer_restrictions_user_idx').on(t.userId, t.createdAt)],
);

/** Saved customer filters for the platform (marketing, service recovery, risk). */
export const platformSegments = pgTable('platform_segments', {
  id: id(),
  name: text('name').notNull(),
  /** { minOrders?, minSpendCents?, lastOrderBeforeDays?, lastOrderWithinDays?, hasMembership?, marketingConsent?, status?, city? } */
  rules: jsonb('rules').notNull().default({}),
  createdById: uuid('created_by_id'),
  updatedAt: updatedAt(),
});
