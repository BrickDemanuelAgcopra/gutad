// Admin platform, phase G: delivery restrictions, courier documents, shifts, records, provider connections.
import { doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { drivers } from './delivery';

/** 15.5 weather / disruption restrictions with expiry. Scope: a zone, a location, a region, or everywhere (all null). */
export const deliveryRestrictions = pgTable('delivery_restrictions', {
  id: id(),
  zoneId: uuid('zone_id'),
  locationId: uuid('location_id'),
  regionId: uuid('region_id'),
  kind: text('kind').notNull(), // PAUSE | SHRINK_RADIUS | ADD_MINUTES
  /** SHRINK_RADIUS: max km; ADD_MINUTES: minutes */
  value: integer('value'),
  reason: text('reason').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  liftedAt: ts('lifted_at'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('delivery_restrictions_ends_idx').on(t.endsAt)]);

/** 16.2 courier onboarding documents with review and expiry. */
export const courierDocuments = pgTable('courier_documents', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // LICENSE | INSURANCE | BACKGROUND_CHECK | VEHICLE_REGISTRATION | ID
  fileUrl: text('file_url').notNull(),
  /** 16.2-U uploaded file in storage (stored_files.id); null when the courier gave a link */
  fileId: uuid('file_id'),
  status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | REJECTED | EXPIRED
  expiresAt: ts('expires_at'),
  reviewedById: uuid('reviewed_by_id'),
  reviewNote: text('review_note'),
  reviewedAt: ts('reviewed_at'),
  createdAt: createdAt(),
}, (t) => [index('courier_documents_driver_idx').on(t.driverId)]);

/** 16.4 courier shifts / availability blocks. */
export const courierShifts = pgTable('courier_shifts', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  zoneId: uuid('zone_id'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  status: text('status').notNull().default('SCHEDULED'), // SCHEDULED | CHECKED_IN | NO_SHOW | CANCELED
  checkedInAt: ts('checked_in_at'),
  createdAt: createdAt(),
}, (t) => [index('courier_shifts_driver_idx').on(t.driverId, t.startsAt)]);

/** 16.6 courier incidents, training records and support notes. */
export const courierRecords = pgTable('courier_records', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // INCIDENT | TRAINING | SUPPORT_NOTE
  title: text('title').notNull(),
  detail: text('detail'),
  severity: integer('severity'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
});

/** 16.4 / 17.9 delivery providers connected per region, in failover order (PLATFORM = own fleet). */
export const providerConnections = pgTable('provider_connections', {
  id: id(),
  regionId: uuid('region_id'),
  provider: text('provider').notNull(),
  priority: integer('priority').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

/** Courier R1: independent eligibility checks (identity, vehicle, screening, payout, agreement, training, equipment). */
export const courierEligibility = pgTable('courier_eligibility', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  check: text('check').notNull(),
  status: text('status').notNull().default('NOT_STARTED'), // NOT_STARTED | PENDING | PASSED | NEEDS_ACTION | FAILED | EXPIRED
  /** screening / payout provider and its reference */
  provider: text('provider'),
  providerRef: text('provider_ref'),
  note: text('note'),
  expiresAt: ts('expires_at'),
  decidedById: uuid('decided_by_id'),
  /** [{ at, status, by, note }] */
  history: jsonb('history').notNull().default([]),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('courier_eligibility_driver_check_uq').on(t.driverId, t.check)]);

/** Courier R1: online, break and reserved time (active delivery and waiting time come from the jobs). */
export const courierTimeEntries = pgTable('courier_time_entries', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // ONLINE | BREAK
  mode: text('mode'), // ON_DEMAND | RESERVED
  shiftId: uuid('shift_id'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
  createdAt: createdAt(),
}, (t) => [index('courier_time_driver_idx').on(t.driverId, t.startedAt)]);

/** Courier R1: a customer's review of a delivery (one per customer and delivery job). */
export const deliveryReviews = pgTable('delivery_reviews', {
  id: id(),
  deliveryJobId: uuid('delivery_job_id').notNull(),
  orderId: uuid('order_id'),
  customerId: uuid('customer_id').notNull(),
  driverId: uuid('driver_id'),
  rating: integer('rating').notNull(),
  tags: text('tags').array().notNull().default([]),
  comment: text('comment'),
  foodRating: integer('food_rating'),
  packagingRating: integer('packaging_rating'),
  issues: text('issues').array().notNull().default([]),
  /** VISIBLE | PENDING_MODERATION | HIDDEN (comment hidden from the courier) */
  status: text('status').notNull().default('VISIBLE'),
  /** kept out of the courier's average (kitchen delay, sealed-bag error, moderation) */
  excluded: boolean('excluded').notNull().default(false),
  excludedReason: text('excluded_reason'),
  disputeStatus: text('dispute_status').notNull().default('NONE'), // NONE | PENDING | UPHELD | REJECTED
  disputeNote: text('dispute_note'),
  incidentIds: uuid('incident_ids').array().notNull().default([]),
  /** [{ at, by, action, note, before }] edits and moderation */
  history: jsonb('history').notNull().default([]),
  waitMinutes: doublePrecision('wait_minutes'),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('delivery_reviews_job_customer_uq').on(t.deliveryJobId, t.customerId), index('delivery_reviews_driver_idx').on(t.driverId)]);
