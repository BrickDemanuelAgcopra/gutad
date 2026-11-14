// Admin platform, phase C: location closures & launch checklist, merchant applications pipeline,
// change requests, brand reviews, and messages on support cases.
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';
import { brands, locations } from './merchants';

/** Holiday closures, special hours and temporary closures with a reopening time (ordering and reservations). */
export const locationClosures = pgTable(
  'location_closures',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('CLOSED'), // CLOSED | SPECIAL_HOURS
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** SPECIAL_HOURS only: local HH:MM window that replaces regular hours on those days */
    opens: text('opens'),
    closes: text('closes'),
    /** ORDERING | RESERVATIONS | ALL */
    service: text('service').notNull().default('ALL'),
    reason: text('reason'),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [index('location_closures_loc_idx').on(t.locationId, t.endsAt)],
);

/** Manual launch-checklist sign-offs (automatic items are computed from live data). */
export const locationLaunchItems = pgTable(
  'location_launch_items',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    doneAt: ts('done_at'),
    doneById: uuid('done_by_id'),
    note: text('note'),
    updatedAt: updatedAt(),
  },
  (t) => [index('location_launch_items_key').on(t.locationId, t.key)],
);

/** Sales pipeline: a restaurant's application from first contact to live (or lost). */
export const merchantApplications = pgTable(
  'merchant_applications',
  {
    id: id(),
    businessName: text('business_name').notNull(),
    contactName: text('contact_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    city: text('city'),
    cuisine: text('cuisine'),
    locationsCount: integer('locations_count').notNull().default(1),
    website: text('website'),
    interest: text('interest').array().notNull().default([]), // ORDERING, RESERVATIONS, EVENTS, FOOD_HALL
    source: text('source').notNull().default('WEB'), // WEB | REFERRAL | OUTBOUND | EVENT | OTHER
    stage: text('stage').notNull().default('LEAD'), // LEAD | CONTACTED | APPLIED | APPROVED | ONBOARDING | LIVE | LOST
    lostReason: text('lost_reason'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    estMonthlyOrders: integer('est_monthly_orders'),
    history: jsonb('history').notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('merchant_applications_stage_idx').on(t.stage, t.createdAt)],
);

/** Merchant-submitted menu and business-information changes waiting for review (when review is switched on). */
export const changeRequests = pgTable(
  'change_requests',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id'),
    kind: text('kind').notNull(), // MENU_ITEM | LOCATION_INFO
    targetId: text('target_id').notNull(),
    summary: text('summary').notNull(),
    changes: jsonb('changes').notNull(),
    before: jsonb('before'),
    status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | REJECTED | WITHDRAWN
    requestedById: uuid('requested_by_id').notNull(),
    reviewedById: uuid('reviewed_by_id'),
    reviewNote: text('review_note'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('change_requests_status_idx').on(t.status, t.createdAt)],
);

/** Partner recipe approvals and quality reviews for a brand. */
export const brandReviews = pgTable(
  'brand_reviews',
  {
    id: id(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // RECIPE_APPROVAL | QUALITY_REVIEW | MYSTERY_SHOP
    subjectType: text('subject_type'), // recipe | menu_item | location
    subjectId: text('subject_id'),
    locationId: uuid('location_id'),
    score: integer('score'), // 1–5
    result: text('result').notNull(), // PASS | FAIL | NEEDS_WORK
    notes: text('notes'),
    reviewerId: uuid('reviewer_id'),
    createdAt: createdAt(),
  },
  (t) => [index('brand_reviews_brand_idx').on(t.brandId, t.createdAt)],
);

/** Conversation on a support case: customer, merchant, courier and staff replies. */
export const incidentMessages = pgTable(
  'incident_messages',
  {
    id: id(),
    incidentId: uuid('incident_id').notNull(),
    authorId: uuid('author_id'),
    authorRole: text('author_role').notNull(), // CUSTOMER | MERCHANT | DRIVER | STAFF | SYSTEM
    /** PARTIES (everyone on the case) or INTERNAL (staff only) */
    visibility: text('visibility').notNull().default('PARTIES'),
    body: text('body').notNull(),
    templateKey: text('template_key'),
    createdAt: createdAt(),
  },
  (t) => [index('incident_messages_incident_idx').on(t.incidentId, t.createdAt)],
);
