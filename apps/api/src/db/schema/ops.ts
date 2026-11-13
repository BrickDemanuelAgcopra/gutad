// Admin platform, phase B: operational alerts, order notes and customer message templates.
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { users } from './accounts';
import { orders } from './orders';

/**
 * An operational alert with an owner, an escalation deadline and a history of every action taken on it.
 * Detectors raise them (deduplicated on `dedupe_key` while open) and auto-resolve them when the condition clears.
 */
export const opsAlerts = pgTable(
  'ops_alerts',
  {
    id: id(),
    type: text('type').notNull(), // ORDER_UNACCEPTED | ORDER_OVERDUE | READY_WAITING | DELIVERY_LATE | STATUS_CONFLICT | DUPLICATE_EVENT | DEVICE_OFFLINE | LOCATION_PAUSED | PAYOUT_FAILED | WEBHOOK_FAILED | STOCKOUT | MANUAL
    severity: text('severity').notNull().default('MEDIUM'), // LOW | MEDIUM | HIGH | CRITICAL
    status: text('status').notNull().default('OPEN'), // OPEN | ACKNOWLEDGED | RESOLVED
    title: text('title').notNull(),
    detail: text('detail'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    organizationId: uuid('organization_id'),
    locationId: uuid('location_id'),
    dedupeKey: text('dedupe_key'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** team that owns it when no person is assigned */
    ownerRole: text('owner_role').notNull().default('OPERATIONS'),
    escalateAt: ts('escalate_at'),
    escalationLevel: integer('escalation_level').notNull().default(0),
    history: jsonb('history').notNull().default([]),
    resolution: text('resolution'),
    autoResolved: boolean('auto_resolved').notNull().default(false),
    acknowledgedAt: ts('acknowledged_at'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ops_alerts_status_idx').on(t.status, t.createdAt), index('ops_alerts_subject_idx').on(t.subjectType, t.subjectId), uniqueIndex('ops_alerts_open_dedupe').on(t.dedupeKey).where(sqlOpen())],
);

/** Notes on an order: INTERNAL (staff only) or CUSTOMER (sent to and visible to the customer). */
export const orderNotes = pgTable(
  'order_notes',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id'),
    visibility: text('visibility').notNull().default('INTERNAL'),
    body: text('body').notNull(),
    templateKey: text('template_key'),
    createdAt: createdAt(),
  },
  (t) => [index('order_notes_order_idx').on(t.orderId, t.createdAt)],
);

/** Approved customer response templates for support and operations. `{{number}}`, `{{name}}` are filled in. */
export const messageTemplates = pgTable('message_templates', {
  key: text('key').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  category: text('category').notNull().default('GENERAL'),
  isActive: boolean('is_active').notNull().default(true),
  updatedById: uuid('updated_by_id'),
  updatedAt: updatedAt(),
});

import { sql } from 'drizzle-orm';
function sqlOpen() {
  return sql`status <> 'RESOLVED'`;
}
