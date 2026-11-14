// 21 CRM, 22 Growth & loyalty, 23 Notifications (outbox/inbox)
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { channelEnum, notificationChannelEnum, notificationKindEnum } from './enums';
import { organizations, users } from './accounts';
import { locations } from './merchants';
import { orders } from './orders';

// ───── 21 CRM ─────

export const guestProfiles = pgTable(
  'guest_profiles',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id),
    userId: uuid('user_id').references(() => users.id),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** protected guest notes — never exposed to customers */
    notes: text('notes'),
    tags: text('tags').array().notNull().default([]),
    visitCount: integer('visit_count').notNull().default(0),
    orderCount: integer('order_count').notNull().default(0),
    lifetimeSpendCents: integer('lifetime_spend_cents').notNull().default(0),
    lastVisitAt: ts('last_visit_at'),
    favorites: jsonb('favorites').notNull().default([]),
    contactPrefs: jsonb('contact_prefs').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('guest_profiles_org_email_key').on(t.organizationId, t.email),
    index('guest_profiles_org_phone_idx').on(t.organizationId, t.phone),
  ],
);

export const segments = pgTable('segments', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rules: jsonb('rules').notNull(), // {minVisits, minSpendCents, lastVisitWithinDays, tags}
  createdAt: createdAt(),
});

export const reviews = pgTable('reviews', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  orderId: uuid('order_id').references(() => orders.id),
  rating: integer('rating').notNull(),
  body: text('body'),
  verified: boolean('verified').notNull().default(false),
  status: text('status').notNull().default('PENDING'), // PENDING | PUBLISHED | REJECTED
  merchantReply: text('merchant_reply'),
  createdAt: createdAt(),
});

// ───── 22 Growth & loyalty ─────

export const campaigns = pgTable('campaigns', {
  id: id(),
  /** null = a Gutad-wide (platform) campaign */
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // EMAIL | SMS | COUPON | SPONSORED | REFERRAL
  funder: text('funder').notNull().default('MERCHANT'), // MERCHANT | PLATFORM
  budgetCents: integer('budget_cents').notNull().default(0),
  spentCents: integer('spent_cents').notNull().default(0),
  segmentId: uuid('segment_id'),
  content: jsonb('content').notNull().default({}),
  status: text('status').notNull().default('DRAFT'), // DRAFT | ACTIVE | PAUSED | EXHAUSTED | ENDED
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  sentCount: integer('sent_count').notNull().default(0),
  conversions: integer('conversions').notNull().default(0),
  attributedRevenueCents: integer('attributed_revenue_cents').notNull().default(0),
  /** 25.10 share of the audience held out (0–50%) to measure incremental orders */
  holdoutPct: integer('holdout_pct').notNull().default(0),
  createdAt: createdAt(),
});

export const coupons = pgTable('coupons', {
  id: id(),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  code: text('code').notNull().unique(),
  kind: text('kind').notNull(), // PERCENT | FIXED | FREE_DELIVERY
  value: integer('value').notNull(), // bps for PERCENT, cents for FIXED
  funder: text('funder').notNull().default('MERCHANT'),
  minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  /** share of the discount the platform funds (0–100); null = all by `funder` */
  platformSharePct: integer('platform_share_pct'),
  perUserLimit: integer('per_user_limit').notNull().default(1),
  locationIds: uuid('location_ids').array().notNull().default([]),
  channels: channelEnum('channels').array().notNull().default([]),
  startsAt: ts('starts_at'),
  expiresAt: ts('expires_at'),
  isActive: boolean('is_active').notNull().default(true),
  // ── 25.1–25.3 promotions engine
  name: text('name'),
  /** owner; null = Gutad-wide */
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  /** codeless offer applied automatically when eligible */
  automatic: boolean('automatic').notNull().default(false),
  /** platform segment the customer must be in */
  segmentId: uuid('segment_id'),
  firstOrderOnly: boolean('first_order_only').notNull().default(false),
  /** discount applies only to these items / categories (empty = whole cart) */
  itemIds: uuid('item_ids').array().notNull().default([]),
  categoryIds: uuid('category_ids').array().notNull().default([]),
  /** 0 = Sunday … 6 = Saturday, location-local; empty = every day */
  daysOfWeek: integer('days_of_week').array().notNull().default([]),
  /** daypart HH:MM–HH:MM, location-local */
  startTime: text('start_time'),
  endTime: text('end_time'),
  maxDiscountCents: integer('max_discount_cents'),
  /** EXCLUSIVE (alone) | STACKABLE (combines with other stackable offers) */
  stacking: text('stacking').notNull().default('EXCLUSIVE'),
  priority: integer('priority').notNull().default(0),
  /** 25.1-B BOGO: buy `buyQty` eligible units, get `getQty` of them free (cheapest first). FREE_ITEM uses itemIds. */
  buyQty: integer('buy_qty'),
  getQty: integer('get_qty'),
  createdAt: ts('created_at').defaultNow(),
});

export const loyaltyEntries = pgTable(
  'loyalty_entries',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // EARN | REDEEM | EXPIRE | REVERSE | REFERRAL
    points: integer('points').notNull(),
    cents: integer('cents').notNull().default(0),
    funder: text('funder').notNull().default('PLATFORM'),
    orderId: uuid('order_id'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('loyalty_user_idx').on(t.userId, t.createdAt)],
);

export const membershipPlans = pgTable('membership_plans', {
  id: id(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  interval: text('interval').notNull(), // MONTH | YEAR
  benefits: jsonb('benefits').notNull(), // {freeDeliveryAboveCents, priorityWaitlist, creditCentsPerMonth}
  isActive: boolean('is_active').notNull().default(true),
  /** 25.7 free trial for first-time members (card on file, charged when the trial ends) */
  trialDays: integer('trial_days').notNull().default(0),
});

export const memberSubscriptions = pgTable('member_subscriptions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id')
    .notNull()
    .references(() => membershipPlans.id),
  status: text('status').notNull().default('ACTIVE'), // TRIALING | ACTIVE | PAST_DUE | SUSPENDED | CANCELED
  currentPeriodEnd: ts('current_period_end').notNull(),
  renewalFailures: integer('renewal_failures').notNull().default(0),
  canceledAt: ts('canceled_at'),
  createdAt: createdAt(),
  // ── 25.7 / 25.8
  trialEndsAt: ts('trial_ends_at'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  paymentMethodId: text('payment_method_id'),
  /** PAST_DUE: when the next retry runs; benefits continue until `graceUntil` */
  nextRetryAt: ts('next_retry_at'),
  graceUntil: ts('grace_until'),
  lastFailureReason: text('last_failure_reason'),
  /** 25.7-P downgrade scheduled for the next renewal */
  pendingPlanId: uuid('pending_plan_id'),
});

// ───── 23 Notifications ─────

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id),
    recipient: text('recipient').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    kind: notificationKindEnum('kind').notNull().default('TRANSACTIONAL'),
    template: text('template').notNull(),
    payload: jsonb('payload').notNull().default({}),
    dedupeKey: text('dedupe_key').unique(),
    status: text('status').notNull().default('QUEUED'), // QUEUED | SENT | FAILED | SUPPRESSED
    sentAt: ts('sent_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_status_idx').on(t.status, t.createdAt)],
);

/** Transactional outbox: domain events committed with business state, relayed by the worker. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    topic: text('topic').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: ts('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_published_idx').on(t.publishedAt, t.createdAt)],
);

/** Durable inbox for provider callbacks, unique per provider/event id. */
export const inboxEvents = pgTable(
  'inbox_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: createdAt(),
    processedAt: ts('processed_at'),
    error: text('error'),
  },
  (t) => [uniqueIndex('inbox_provider_event_key').on(t.provider, t.eventId)],
);
