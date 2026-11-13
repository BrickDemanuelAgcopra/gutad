// 25 Contracts & monetization — configurable plan catalog (product lines, versions, fee rules, features)
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';

/** Features a plan can include. BOOLEAN features are on/off; LIMIT features carry a number (e.g. max locations). */
export const features = pgTable('features', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('BOOLEAN'), // BOOLEAN | LIMIT
  productLine: text('product_line').notNull().default('ALL'), // ORDERING | RESERVATIONS | ALL
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const plans = pgTable('plans', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  productLine: text('product_line').notNull(), // ORDERING | RESERVATIONS | SUITE
  tagline: text('tagline'),
  description: text('description'),
  isPublic: boolean('is_public').notNull().default(true),
  isArchived: boolean('is_archived').notNull().default(false),
  highlight: boolean('highlight').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A priced snapshot of a plan. Editing a plan means drafting a new version and publishing it; contracts copy the
 * version they were created from, so existing merchants keep their terms until moved.
 */
export const planVersions = pgTable(
  'plan_versions',
  {
    id: id(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('DRAFT'), // DRAFT | PUBLISHED | RETIRED
    subscriptionCents: integer('subscription_cents').notNull().default(0),
    interval: text('interval').notNull().default('MONTH'), // MONTH | YEAR
    perLocation: boolean('per_location').notNull().default(true),
    setupFeeCents: integer('setup_fee_cents').notNull().default(0),
    trialDays: integer('trial_days').notNull().default(0),
    notes: text('notes'),
    publishedAt: ts('published_at'),
    publishedById: uuid('published_by_id').references(() => users.id),
    approvedById: uuid('approved_by_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('plan_versions_plan_version_uq').on(t.planId, t.version), index('plan_versions_status_idx').on(t.planId, t.status)],
);

/**
 * One fee rule. Resolution picks the most specific match for a channel + fulfillment type:
 * exact channel & fulfillment > exact channel & ANY > NETWORK/ANY channel & exact fulfillment > ANY & ANY.
 */
export const planFees = pgTable('plan_fees', {
  id: id(),
  planVersionId: uuid('plan_version_id')
    .notNull()
    .references(() => planVersions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // COMMISSION | COVER_FEE | PREPAID_SERVICE_FEE | PROCESSING | DELIVERY_SUBSIDY | LOGISTICS_FEE
  channel: text('channel').notNull().default('ANY'), // ANY | NETWORK | MARKETPLACE | PARTNER | DIRECT | WIDGET | QR
  fulfillment: text('fulfillment').notNull().default('ANY'), // ANY | DELIVERY | PICKUP | DINE_IN
  bps: integer('bps').notNull().default(0),
  cents: integer('cents').notNull().default(0),
  capCents: integer('cap_cents'),
  label: text('label'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const planFeatures = pgTable(
  'plan_features',
  {
    planVersionId: uuid('plan_version_id')
      .notNull()
      .references(() => planVersions.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key')
      .notNull()
      .references(() => features.key, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    limitValue: integer('limit_value'),
  },
  (t) => [primaryKey({ columns: [t.planVersionId, t.featureKey] })],
);

/** Shape of a fee rule as copied onto a contract (`merchant_contracts.fees`). */
export interface FeeRule {
  type: 'COMMISSION' | 'COVER_FEE' | 'PREPAID_SERVICE_FEE' | 'PROCESSING' | 'DELIVERY_SUBSIDY' | 'LOGISTICS_FEE';
  channel: string;
  fulfillment: string;
  bps: number;
  cents: number;
  capCents?: number | null;
  label?: string | null;
}

export const planFeatureSnapshot = (rows: { featureKey: string; enabled: boolean; limitValue: number | null }[]) =>
  Object.fromEntries(rows.map((r) => [r.featureKey, r.limitValue ?? r.enabled]));


/** Extras merchants buy on top of a plan; each adds features (booleans) and/or raises limits (numbers are added). */
export const addOns = pgTable('add_ons', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  productLine: text('product_line').notNull().default('ALL'), // ORDERING | RESERVATIONS | ALL
  priceCents: integer('price_cents').notNull().default(0),
  interval: text('interval').notNull().default('MONTH'),
  perLocation: boolean('per_location').notNull().default(false),
  features: jsonb('features').$type<Record<string, boolean | number>>().notNull().default({}),
  isPublic: boolean('is_public').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const orgAddOns = pgTable(
  'org_add_ons',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    addOnId: uuid('add_on_id')
      .notNull()
      .references(() => addOns.id),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | CANCELED
    priceCents: integer('price_cents').notNull(),
    quantity: integer('quantity').notNull().default(1),
    startedAt: ts('started_at').defaultNow().notNull(),
    /** Cancellation takes effect at the end of the billing period; features stay until then. */
    cancelAt: ts('cancel_at'),
    canceledAt: ts('canceled_at'),
    createdById: uuid('created_by_id').references(() => users.id),
  },
  (t) => [index('org_add_ons_org_idx').on(t.organizationId, t.status)],
);

/**
 * Promotion codes merchants redeem from Plan & billing:
 *   PERCENT_OFF        — `percentOff` off the plan subscription on the next `periods` renewal invoices
 *   FREE_PERIODS       — the plan subscription is free for the next `periods` renewals
 *   COMMISSION_HOLIDAY — 0% marketplace commission for `days` days from redemption
 */
export const promotions = pgTable('promotions', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // PERCENT_OFF | FREE_PERIODS | COMMISSION_HOLIDAY
  percentOff: integer('percent_off').notNull().default(0),
  periods: integer('periods').notNull().default(1),
  days: integer('days').notNull().default(0),
  /** Empty = any plan. */
  planCodes: text('plan_codes').array().notNull().default([]),
  maxRedemptions: integer('max_redemptions'),
  newMerchantsOnly: boolean('new_merchants_only').notNull().default(false),
  startsAt: ts('starts_at'),
  expiresAt: ts('expires_at'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: id(),
    promotionId: uuid('promotion_id')
      .notNull()
      .references(() => promotions.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    redeemedById: uuid('redeemed_by_id').references(() => users.id),
    periodsUsed: integer('periods_used').notNull().default(0),
    /** Commission holidays end here; subscription discounts end when periods_used reaches the promotion's periods. */
    endsAt: ts('ends_at'),
    redeemedAt: createdAt(),
  },
  (t) => [uniqueIndex('promotion_redemptions_org_uq').on(t.promotionId, t.organizationId), index('promotion_redemptions_org_idx').on(t.organizationId)],
);
