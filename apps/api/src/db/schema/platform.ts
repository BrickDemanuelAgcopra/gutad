// 27 Integrations, 28 Support & trust, 29 Reporting, 30 Platform administration
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { incidentStatusEnum, integrationTypeEnum } from './enums';
import { organizations, users } from './accounts';
import { locations } from './merchants';
import { orders } from './orders';
import { reservations } from './reservations';

// ───── 27 Integrations ─────

export const integrationAccounts = pgTable('integration_accounts', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  type: integrationTypeEnum('type').notNull(),
  provider: text('provider').notNull(),
  /** encrypted at the application layer (see CryptoService) */
  credentials: jsonb('credentials').notNull().default({}),
  externalIds: jsonb('external_ids').notNull().default({}),
  webhookSecret: text('webhook_secret'),
  status: text('status').notNull().default('PENDING'), // PENDING | ACTIVE | ERROR | DISABLED
  lastHealthAt: ts('last_health_at'),
  lastError: text('last_error'),
  createdAt: createdAt(),
});

export const integrationMappings = pgTable(
  'integration_mappings',
  {
    id: id(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // MENU_ITEM | TABLE | LOCATION | MODIFIER
    internalId: text('internal_id').notNull(),
    externalId: text('external_id').notNull(),
  },
  (t) => [uniqueIndex('integration_mappings_key').on(t.integrationId, t.entityType, t.externalId)],
);

// ───── 28 Support & trust ─────

export const incidents = pgTable('incidents', {
  id: id(),
  orderId: uuid('order_id').references(() => orders.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  deliveryJobId: uuid('delivery_job_id'),
  reporterId: uuid('reporter_id').references(() => users.id),
  category: text('category').notNull(), // MISSING_ITEM | LATE | DAMAGED | NO_HANDOFF | WRONG_ADDRESS | CHARGEBACK | NO_SHOW_DISPUTE | OTHER
  description: text('description').notNull(),
  status: incidentStatusEnum('status').notNull().default('OPEN'),
  owner: text('owner'), // MERCHANT | PLATFORM | PROVIDER | DRIVER | CUSTOMER
  remedy: text('remedy'), // REFUND | CREDIT | REMAKE | REDELIVERY | REASSIGN | NONE
  remedyCents: integer('remedy_cents').notNull().default(0),
  evidence: jsonb('evidence').notNull().default([]),
  assigneeId: uuid('assignee_id'),
  resolvedAt: ts('resolved_at'),
  appealNote: text('appeal_note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const policyStrikes = pgTable('policy_strikes', {
  id: id(),
  subjectType: text('subject_type').notNull(), // MERCHANT | DRIVER | CUSTOMER
  subjectId: text('subject_id').notNull(),
  reason: text('reason').notNull(),
  severity: integer('severity').notNull().default(1),
  createdAt: createdAt(),
});

export const dataRequests = pgTable('data_requests', {
  id: id(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').notNull(), // ACCESS | DELETE
  status: text('status').notNull().default('OPEN'),
  fulfilledAt: ts('fulfilled_at'),
  createdAt: createdAt(),
});

// ───── 29 Reporting ─────

export const shiftSummaries = pgTable('shift_summaries', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  date: ts('date').notNull(),
  closedById: uuid('closed_by_id'),
  ordersCompleted: integer('orders_completed').notNull().default(0),
  ordersCanceled: integer('orders_canceled').notNull().default(0),
  coversSeated: integer('covers_seated').notNull().default(0),
  noShows: integer('no_shows').notNull().default(0),
  openChecks: integer('open_checks').notNull().default(0),
  cashCents: integer('cash_cents').notNull().default(0),
  wasteNotes: text('waste_notes'),
  unresolvedIncidentIds: uuid('unresolved_incident_ids').array().notNull().default([]),
  carriedForward: jsonb('carried_forward').notNull().default([]),
  signedAt: ts('signed_at'),
});

// ───── 30 Platform administration ─────

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    /** why the change was made (required for sensitive actions) */
    reason: text('reason'),
    requestId: text('request_id'),
    /** emergency or support grant the actor was using */
    grantId: uuid('grant_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_org_idx').on(t.organizationId, t.createdAt),
  ],
);

export const configChanges = pgTable('config_changes', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  key: text('key').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  actorId: uuid('actor_id'),
  approvedById: uuid('approved_by_id'),
  createdAt: createdAt(),
});

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

export const idempotencyRecords = pgTable('idempotency_records', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  responseCode: integer('response_code').notNull(),
  response: jsonb('response').notNull(),
  createdAt: createdAt(),
});
