// Follow-ups B: location auto-throttle (13.7-L), network ticket printers (13.8-P), stored files for courier documents (16.2-U).
import { boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { locations } from './merchants';

/** 13.7-L auto-throttle for a restaurant without a production kitchen: load from open orders × prep time. */
export const locationLoadSettings = pgTable('location_load_settings', {
  locationId: uuid('location_id')
    .primaryKey()
    .references(() => locations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  /** open ASAP orders (submitted, accepted, preparing) at which new quotes get extra minutes */
  busyAtOpenOrders: integer('busy_at_open_orders').notNull().default(8),
  /** open ASAP orders at which ASAP ordering stops (scheduled orders still allowed) */
  overloadAtOpenOrders: integer('overload_at_open_orders').notNull().default(14),
  /** backlog minutes (open orders × prep minutes ÷ orders cooked in parallel) that also trigger BUSY / OVERLOADED; null = off */
  busyAtBacklogMinutes: integer('busy_at_backlog_minutes'),
  overloadAtBacklogMinutes: integer('overload_at_backlog_minutes'),
  parallelOrders: integer('parallel_orders').notNull().default(3),
  busyExtraMinutes: integer('busy_extra_minutes').notNull().default(10),
  /** last level seen by the sweep (alerts and history); quotes compute live */
  lastLevel: text('last_level').notNull().default('NORMAL'),
  lastChangedAt: ts('last_changed_at'),
  updatedById: uuid('updated_by_id'),
  updatedAt: updatedAt(),
});

/** 13.8-P network ticket printers per location (and optionally per station). */
export const printers = pgTable('printers', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** station code this printer serves (null = every station / the pass) */
  stationCode: text('station_code'),
  /** TICKETS | LABELS | BOTH */
  role: text('role').notNull().default('TICKETS'),
  /** LOG (default, prints to the server log — safe in tests) | RAW_TCP (ESC/POS over TCP, usually port 9100) */
  protocol: text('protocol').notNull().default('LOG'),
  host: text('host'),
  port: integer('port').notNull().default(9100),
  /** characters per line (58 mm ≈ 32, 80 mm ≈ 48) */
  width: integer('width').notNull().default(42),
  /** print new station tickets automatically when an order is accepted */
  autoPrint: boolean('auto_print').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  /** OK | ERROR | UNKNOWN */
  lastStatus: text('last_status').notNull().default('UNKNOWN'),
  lastError: text('last_error'),
  lastPrintedAt: ts('last_printed_at'),
  createdAt: createdAt(),
}, (t) => [index('printers_location_idx').on(t.locationId)]);

/** 13.8-P print queue: station tickets, bag labels and test pages with retry and failure status. */
export const printJobs = pgTable('print_jobs', {
  id: id(),
  printerId: uuid('printer_id')
    .notNull()
    .references(() => printers.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
  /** STATION_TICKET | BAG_LABEL | TEST */
  kind: text('kind').notNull(),
  /** kitchen ticket id or packing task id */
  refId: uuid('ref_id'),
  orderId: uuid('order_id'),
  title: text('title').notNull(),
  /** rendered plain text; the adapter turns it into ESC/POS */
  body: text('body').notNull(),
  /** QUEUED | PRINTING | PRINTED | FAILED */
  status: text('status').notNull().default('QUEUED'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(4),
  lastError: text('last_error'),
  nextAttemptAt: ts('next_attempt_at'),
  printedAt: ts('printed_at'),
  requestedById: uuid('requested_by_id'),
  createdAt: createdAt(),
}, (t) => [index('print_jobs_status_idx').on(t.status, t.nextAttemptAt), index('print_jobs_location_idx').on(t.locationId, t.createdAt)]);

/** 16.2-U files uploaded to storage (local disk or S3-compatible); served only to the owner and authorized staff. */
export const storedFiles = pgTable('stored_files', {
  id: id(),
  /** COURIER_DOCUMENT | … */
  purpose: text('purpose').notNull(),
  /** local | s3 */
  driver: text('driver').notNull(),
  storageKey: text('storage_key').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  ownerUserId: uuid('owner_user_id'),
  driverId: uuid('driver_id'),
  createdAt: createdAt(),
}, (t) => [index('stored_files_owner_idx').on(t.ownerUserId)]);
