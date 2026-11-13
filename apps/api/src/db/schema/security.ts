// Admin platform, phase A: organization hierarchy (regions), staff access scopes, sessions,
// emergency and support access grants, and the approval engine.
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';

/** Operating regions (e.g. "NYC Metro"), nestable. Locations point at one via `locations.region_id`. */
export const regions = pgTable(
  'regions',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    timezone: text('timezone').notNull().default('America/New_York'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('regions_code_key').on(t.code)],
);

/** Restricts what a staff member can reach. No row = unrestricted within their role's permissions. */
export const staffScopes = pgTable('staff_scopes', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  regionIds: uuid('region_ids').array().notNull().default([]),
  organizationIds: uuid('organization_ids').array().notNull().default([]),
  locationIds: uuid('location_ids').array().notNull().default([]),
  /** highest data sensitivity this person may see: PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED */
  maxSensitivity: text('max_sensitivity').notNull().default('RESTRICTED'),
  note: text('note'),
  updatedById: uuid('updated_by_id'),
  updatedAt: updatedAt(),
});

/** A signed-in session (one per login). Access tokens carry its id (`sid`) so it can be revoked. */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** how the person signed in: pwd, mfa, sso */
    amr: text('amr').array().notNull().default([]),
    client: text('client'), // web | mobile | api
    userAgent: text('user_agent'),
    ip: text('ip'),
    lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Time-limited access: EMERGENCY (break-glass elevation to extra staff roles) or SUPPORT
 * (audited "view as merchant" access to one organization). A reason is always required.
 */
export const accessGrants = pgTable(
  'access_grants',
  {
    id: id(),
    kind: text('kind').notNull(), // EMERGENCY | SUPPORT
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roles: text('roles').array().notNull().default([]),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    readOnly: integer('read_only').notNull().default(1),
    reason: text('reason').notNull(),
    ticketRef: text('ticket_ref'),
    startsAt: ts('starts_at').defaultNow().notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedById: uuid('revoked_by_id'),
    reviewedAt: ts('reviewed_at'),
    reviewedById: uuid('reviewed_by_id'),
    reviewNote: text('review_note'),
    actionCount: integer('action_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('access_grants_user_idx').on(t.userId, t.expiresAt)],
);

/** One engine for every action that needs a threshold check or a second person. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: id(),
    kind: text('kind').notNull(), // REFUND | BANK_ACCOUNT_CHANGE | SETTING_CHANGE | PURCHASE_ORDER | PRICE_CHANGE | PAYOUT_RELEASE
    status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | REJECTED | CANCELED | EXPIRED | EXECUTED | FAILED
    summary: text('summary').notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    amountCents: integer('amount_cents'),
    payload: jsonb('payload').notNull().default({}),
    reason: text('reason').notNull(),
    requestedById: uuid('requested_by_id').notNull(),
    requiredApprovals: integer('required_approvals').notNull().default(1),
    approvals: jsonb('approvals').notNull().default([]),
    decidedById: uuid('decided_by_id'),
    decisionNote: text('decision_note'),
    decidedAt: ts('decided_at'),
    executedAt: ts('executed_at'),
    result: jsonb('result'),
    /** a pending request for the same subject blocks duplicates */
    dedupeKey: text('dedupe_key'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('approval_requests_status_idx').on(t.status, t.createdAt), index('approval_requests_subject_idx').on(t.subjectType, t.subjectId)],
);
