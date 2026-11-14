// Follow-ups C: GL push (20.1-L), supplier portal / EDI (21.8-P), temperature sensors (22.2-S), payroll providers (23.3-P),
// equipment vendor feeds (23.8-V). Ledger lock (20.7-L) adds columns to close_periods in finance-admin.ts.
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';

// ───── 20.1-L general-ledger push ─────

/** One accounting-software connection per legal entity (credentials encrypted with CryptoService). */
export const glConnections = pgTable('gl_connections', {
  id: id(),
  legalEntity: text('legal_entity').notNull().default('GUTAD'),
  provider: text('provider').notNull(), // MOCK | QBO | XERO
  status: text('status').notNull().default('CONNECTED'), // CONNECTED | DISCONNECTED | ERROR
  /** { __enc } — access token / refresh token / client secret, never returned by the API */
  credentials: jsonb('credentials').notNull().default({}),
  /** QBO realm id or Xero tenant id */
  externalTenantId: text('external_tenant_id'),
  /** { journalPrefix?, currency?, autoPush? } */
  config: jsonb('config').notNull().default({}),
  connectedById: uuid('connected_by_id'),
  lastPushAt: ts('last_push_at'),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('gl_connections_entity').on(t.legalEntity)]);

/** A month of journals pushed to the GL; one row per (legal entity, provider, period) keeps the push idempotent. */
export const glPushBatches = pgTable('gl_push_batches', {
  id: id(),
  connectionId: uuid('connection_id').notNull(),
  legalEntity: text('legal_entity').notNull(),
  provider: text('provider').notNull(),
  period: text('period').notNull(), // YYYY-MM
  status: text('status').notNull().default('PENDING'), // PENDING | PUSHING | PUSHED | FAILED
  idempotencyKey: text('idempotency_key').notNull(),
  externalId: text('external_id'),
  lines: integer('lines').notNull().default(0),
  debitCents: integer('debit_cents').notNull().default(0),
  creditCents: integer('credit_cents').notNull().default(0),
  unmapped: integer('unmapped').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextRetryAt: ts('next_retry_at'),
  pushedAt: ts('pushed_at'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('gl_push_batches_key').on(t.legalEntity, t.provider, t.period)]);

// ───── 21.8-P supplier portal & EDI ─────

/** Per-supplier access tokens for the invoice portal / EDI upload (only the SHA-256 hash is stored). */
export const supplierAccessTokens = pgTable('supplier_access_tokens', {
  id: id(),
  supplierId: uuid('supplier_id').notNull(),
  organizationId: uuid('organization_id'),
  label: text('label'),
  tokenHash: text('token_hash').notNull(),
  tokenHint: text('token_hint').notNull(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  revokedById: uuid('revoked_by_id'),
  lastUsedAt: ts('last_used_at'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('supplier_access_tokens_hash').on(t.tokenHash), index('supplier_access_tokens_supplier_idx').on(t.supplierId)]);

/** Every invoice a supplier submits, with the three-way match result it produced. */
export const supplierInvoiceSubmissions = pgTable('supplier_invoice_submissions', {
  id: id(),
  supplierId: uuid('supplier_id').notNull(),
  tokenId: uuid('token_id'),
  purchaseOrderId: uuid('purchase_order_id'),
  source: text('source').notNull(), // PORTAL | EDI_810 | CSV
  invoiceNumber: text('invoice_number'),
  status: text('status').notNull(), // MATCHED | VARIANCE | REJECTED
  totalCents: integer('total_cents'),
  /** parsed lines [{ ingredientId, quantity, unitCostCents }] */
  lines: jsonb('lines').notNull().default([]),
  raw: text('raw'),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [index('supplier_invoice_submissions_supplier_idx').on(t.supplierId, t.createdAt)]);

// ───── 22.2-S wireless temperature sensors ─────

export const temperatureSensors = pgTable('temperature_sensors', {
  id: id(),
  kitchenId: uuid('kitchen_id').notNull(),
  storageAreaId: uuid('storage_area_id').notNull(),
  name: text('name').notNull(),
  vendor: text('vendor'),
  serial: text('serial'),
  tokenHash: text('token_hash').notNull(),
  tokenHint: text('token_hint').notNull(),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | RETIRED
  isOnline: boolean('is_online').notNull().default(false),
  lastReadingAt: ts('last_reading_at'),
  lastTempC: doublePrecision('last_temp_c'),
  lastInRange: boolean('last_in_range'),
  lastLoggedAt: ts('last_logged_at'),
  batteryPct: integer('battery_pct'),
  /** null = platform default (`safety.sensors.offlineAfterMinutes`) */
  offlineAfterMinutes: integer('offline_after_minutes'),
  offlineAlertedAt: ts('offline_alerted_at'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('temperature_sensors_token').on(t.tokenHash), index('temperature_sensors_kitchen_idx').on(t.kitchenId)]);

// ───── 23.3-P payroll providers ─────

export const payrollConnections = pgTable('payroll_connections', {
  id: id(),
  organizationId: uuid('organization_id').notNull(),
  provider: text('provider').notNull(), // MOCK | GUSTO | ADP
  status: text('status').notNull().default('CONNECTED'), // CONNECTED | DISCONNECTED
  credentials: jsonb('credentials').notNull().default({}),
  /** Gusto company uuid / ADP org id */
  externalCompanyId: text('external_company_id'),
  /** { employeeIds: { [userId]: providerEmployeeId } } */
  config: jsonb('config').notNull().default({}),
  connectedById: uuid('connected_by_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('payroll_connections_org').on(t.organizationId)]);

/** Approved hours pushed for one location and pay period; unique per (location, provider, period) so re-pushes are idempotent. */
export const payrollExportBatches = pgTable('payroll_export_batches', {
  id: id(),
  organizationId: uuid('organization_id').notNull(),
  locationId: uuid('location_id').notNull(),
  provider: text('provider').notNull(),
  periodStart: text('period_start').notNull(), // YYYY-MM-DD
  periodEnd: text('period_end').notNull(), // YYYY-MM-DD (exclusive)
  status: text('status').notNull().default('PENDING'), // PENDING | PUSHING | PUSHED | FAILED
  externalId: text('external_id'),
  employees: integer('employees').notNull().default(0),
  regularHours: doublePrecision('regular_hours').notNull().default(0),
  overtimeHours: doublePrecision('overtime_hours').notNull().default(0),
  grossCents: integer('gross_cents').notNull().default(0),
  unapprovedHours: doublePrecision('unapproved_hours').notNull().default(0),
  /** [{ userId, name, email, week, regularHours, overtimeHours, rateCents, grossCents, providerEmployeeId }] */
  payload: jsonb('payload').notNull().default([]),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  pushedAt: ts('pushed_at'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('payroll_export_batches_key').on(t.locationId, t.provider, t.periodStart, t.periodEnd)]);

// ───── 23.8-V equipment vendor feeds ─────

export const equipmentVendorLinks = pgTable('equipment_vendor_links', {
  id: id(),
  equipmentId: uuid('equipment_id').notNull(),
  vendor: text('vendor').notNull(), // MOCK | GENERIC | RATIONAL | WELBILT
  /** the vendor's id for this machine */
  externalId: text('external_id').notNull(),
  /** push feed token (SHA-256 hash only) */
  tokenHash: text('token_hash').notNull(),
  tokenHint: text('token_hint').notNull(),
  /** { __enc } vendor API credentials for status pulls */
  credentials: jsonb('credentials').notNull().default({}),
  /** { telemetryLimits?: { [metric]: { min?, max? } }, mapFaultsToTickets?: boolean } */
  config: jsonb('config').notNull().default({}),
  pollEnabled: boolean('poll_enabled').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  lastEventAt: ts('last_event_at'),
  lastPolledAt: ts('last_polled_at'),
  lastStatus: jsonb('last_status'),
  lastError: text('last_error'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('equipment_vendor_links_equipment').on(t.equipmentId), uniqueIndex('equipment_vendor_links_token').on(t.tokenHash)]);

export const equipmentVendorEvents = pgTable('equipment_vendor_events', {
  id: id(),
  equipmentId: uuid('equipment_id').notNull(),
  linkId: uuid('link_id').notNull(),
  vendor: text('vendor').notNull(),
  kind: text('kind').notNull(), // TELEMETRY | MAINTENANCE | FAULT | STATUS
  /** vendor event id, for de-duplication */
  externalEventId: text('external_event_id'),
  code: text('code'),
  severity: text('severity'), // INFO | LOW | HIGH | CRITICAL
  message: text('message'),
  metrics: jsonb('metrics'),
  alerted: boolean('alerted').notNull().default(false),
  ticketId: uuid('ticket_id'),
  occurredAt: ts('occurred_at').notNull(),
  createdAt: createdAt(),
}, (t) => [index('equipment_vendor_events_eq_idx').on(t.equipmentId, t.occurredAt), uniqueIndex('equipment_vendor_events_ext').on(t.linkId, t.externalEventId)]);
