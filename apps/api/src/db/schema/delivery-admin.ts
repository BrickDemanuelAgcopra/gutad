// Admin platform, phase G: delivery restrictions, courier documents, shifts, records, provider connections.
import { index, integer, pgTable, text, uuid, boolean } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
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
  status: text('status').notNull().default('SCHEDULED'), // SCHEDULED | CANCELED
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
