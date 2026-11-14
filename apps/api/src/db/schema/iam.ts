// Users, Roles & Permissions (IAM): database-backed roles and their permission matrix, role assignments
// (scheduled, temporary, acting), staff profiles and invitations, access requests and reviews, sign-in events,
// service accounts with API keys, and security alerts.
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { users } from './accounts';

/** A role: built-in (SYSTEM, key = the platform role enum value) or custom. `permissions` are `resource:action` strings. */
export const accessRoles = pgTable(
  'access_roles',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind').notNull().default('CUSTOM'), // SYSTEM | CUSTOM
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | ARCHIVED
    permissions: text('permissions').array().notNull().default([]),
    /** approval authority in cents per kind: { REFUND, DISCOUNT, PURCHASE_ORDER, PAYOUT_RELEASE, SELF_REFUND } */
    approvalLimits: jsonb('approval_limits').notNull().default({}),
    mfaRequired: boolean('mfa_required').notNull().default(false),
    /** people may ask for this role through an access request */
    requestable: boolean('requestable').notNull().default(true),
    createdById: uuid('created_by_id'),
    updatedById: uuid('updated_by_id'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('access_roles_key_key').on(t.key)],
);

/** A person holding a role, optionally from a future start and/or until an end (temporary, acting, emergency). */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => accessRoles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('STANDARD'), // STANDARD | TEMPORARY | ACTING | EMERGENCY
    isPrimary: boolean('is_primary').notNull().default(false),
    /** primary responsibility in plain words, e.g. "Owns refunds for NYC" */
    responsibility: text('responsibility'),
    /** acting-manager cover: whose access this mirrors */
    actingForUserId: uuid('acting_for_user_id'),
    startsAt: ts('starts_at').defaultNow().notNull(),
    endsAt: ts('ends_at'),
    reason: text('reason'),
    assignedById: uuid('assigned_by_id'),
    sourceRequestId: uuid('source_request_id'),
    revokedAt: ts('revoked_at'),
    revokedById: uuid('revoked_by_id'),
    revokeReason: text('revoke_reason'),
    /** set by the worker once the end passed and roles were re-synced */
    expiredAt: ts('expired_at'),
    /** set by the worker once a scheduled start passed and roles were re-synced */
    activatedAt: ts('activated_at'),
    createdAt: createdAt(),
  },
  (t) => [index('role_assignments_user_idx').on(t.userId), index('role_assignments_role_idx').on(t.roleId)],
);

/** Staff-only facts about a person. */
export const staffProfiles = pgTable('staff_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('STAFF'), // STAFF | SERVICE
  title: text('title'),
  department: text('department'),
  team: text('team'),
  managerId: uuid('manager_id'),
  employeeId: text('employee_id'),
  invitedById: uuid('invited_by_id'),
  invitedAt: ts('invited_at'),
  inviteAcceptedAt: ts('invite_accepted_at'),
  lastLoginAt: ts('last_login_at'),
  lastLoginIp: text('last_login_ip'),
  suspendedUntil: ts('suspended_until'),
  archivedAt: ts('archived_at'),
  offboardedAt: ts('offboarded_at'),
  offboardedById: uuid('offboarded_by_id'),
  inactiveFlaggedAt: ts('inactive_flagged_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const staffInvitations = pgTable(
  'staff_invitations',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    roleIds: uuid('role_ids').array().notNull().default([]),
    expiresAt: ts('expires_at').notNull(),
    sentCount: integer('sent_count').notNull().default(1),
    lastSentAt: ts('last_sent_at').defaultNow().notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
    invitedById: uuid('invited_by_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('staff_invitations_token_key').on(t.tokenHash), index('staff_invitations_user_idx').on(t.userId)],
);

/** Staff asking for more access: a role, why, and for how long. */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: id(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => accessRoles.id, { onDelete: 'cascade' }),
    justification: text('justification').notNull(),
    /** requested duration; null = permanent */
    durationHours: integer('duration_hours'),
    status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | REJECTED | CANCELED | EXPIRED
    decidedById: uuid('decided_by_id'),
    decisionNote: text('decision_note'),
    decidedAt: ts('decided_at'),
    assignmentId: uuid('assignment_id'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('access_requests_status_idx').on(t.status, t.createdAt)],
);

export const accessReviews = pgTable('access_reviews', {
  id: id(),
  name: text('name').notNull(),
  status: text('status').notNull().default('OPEN'), // OPEN | COMPLETED | CANCELED
  dueAt: ts('due_at').notNull(),
  /** { roleIds?: string[], inactiveDays: number, automatic?: boolean } */
  criteria: jsonb('criteria').notNull().default({}),
  createdById: uuid('created_by_id'),
  completedAt: ts('completed_at'),
  createdAt: createdAt(),
});

export const accessReviewItems = pgTable(
  'access_review_items',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => accessReviews.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** roles held when the review opened: [{ roleId, key, name, kind, endsAt }] */
    snapshot: jsonb('snapshot').notNull().default([]),
    /** INACTIVE | NEVER_SIGNED_IN | NO_MFA | PRIVILEGED | TEMPORARY | SUPERADMIN */
    flags: text('flags').array().notNull().default([]),
    decision: text('decision').notNull().default('PENDING'), // PENDING | KEEP | REVOKE | SUSPEND
    reviewerId: uuid('reviewer_id'),
    note: text('note'),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('access_review_items_review_idx').on(t.reviewId)],
);

/** Every sign-in attempt (password, MFA, SSO, invitation, API key failures). */
export const loginEvents = pgTable(
  'login_events',
  {
    id: id(),
    userId: uuid('user_id'),
    email: text('email'),
    outcome: text('outcome').notNull(), // SUCCESS | FAILURE | LOCKED | BLOCKED | MFA_FAILURE
    method: text('method').notNull().default('pwd'), // pwd | mfa | sso | invite | api_key
    reason: text('reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    suspicious: boolean('suspicious').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('login_events_user_idx').on(t.userId, t.createdAt), index('login_events_created_idx').on(t.createdAt)],
);

/** An integration identity. It acts through a shadow user row (`user_id`) so audit and ownership columns keep working. */
export const serviceAccounts = pgTable('service_accounts', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerId: uuid('owner_id'),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | DISABLED | ARCHIVED
  permissions: text('permissions').array().notNull().default([]),
  /** organizations it may reach; empty = all */
  organizationIds: uuid('organization_ids').array().notNull().default([]),
  ipAllowlist: text('ip_allowlist').array().notNull().default([]),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    serviceAccountId: uuid('service_account_id')
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** first characters, shown to identify the key */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    revokedAt: ts('revoked_at'),
    revokedById: uuid('revoked_by_id'),
    revokeReason: text('revoke_reason'),
    rotatedFromId: uuid('rotated_from_id'),
    expiryWarnedAt: ts('expiry_warned_at'),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_key').on(t.keyHash), index('api_keys_account_idx').on(t.serviceAccountId)],
);

export const securityAlerts = pgTable(
  'security_alerts',
  {
    id: id(),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('MEDIUM'), // LOW | MEDIUM | HIGH | CRITICAL
    title: text('title').notNull(),
    detail: text('detail'),
    subjectUserId: uuid('subject_user_id'),
    actorId: uuid('actor_id'),
    data: jsonb('data').notNull().default({}),
    dedupeKey: text('dedupe_key'),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedById: uuid('acknowledged_by_id'),
    createdAt: createdAt(),
  },
  (t) => [index('security_alerts_created_idx').on(t.createdAt), uniqueIndex('security_alerts_dedupe_key').on(t.dedupeKey)],
);
