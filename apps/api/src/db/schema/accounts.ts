// 01 Accounts & access — users, tokens, addresses, organizations (tenants), memberships, devices
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { merchantStatusEnum, roleEnum } from './enums';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash'),
    name: text('name'),
    roles: roleEnum('roles').array().notNull().default(['CUSTOMER']),
    emailVerifiedAt: ts('email_verified_at'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    smsConsent: boolean('sms_consent').notNull().default(false),
    pushTokens: text('push_tokens').array().notNull().default([]),
    locale: text('locale').notNull().default('en-US'),
    timezone: text('timezone').notNull().default('America/New_York'),
    dietaryNotes: text('dietary_notes'),
    isGuest: boolean('is_guest').notNull().default(false),
    /** ACTIVE | DISABLED (staff access removed) | RESTRICTED (customer ordering blocked) */
    status: text('status').notNull().default('ACTIVE'),
    statusReason: text('status_reason'),
    /** TOTP secret, encrypted with CryptoService */
    mfaSecret: text('mfa_secret'),
    mfaEnabledAt: ts('mfa_enabled_at'),
    /** sha256 hashes of one-time recovery codes */
    mfaRecoveryCodes: text('mfa_recovery_codes').array().notNull().default([]),
    /** per-topic channel choices: { orders: { email, sms, push }, reservations: {…}, marketing: {…} } */
    notificationPrefs: jsonb('notification_prefs').notNull().default({}),
    /** processor customer id (e.g. Stripe cus_…) */
    paymentCustomerRef: text('payment_customer_ref'),
    /** set when this account was merged into another one */
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email), index('users_phone_idx').on(t.phone)],
);

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  sessionId: uuid('session_id'),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const accountRecoveryTokens = pgTable('account_recovery_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const addresses = pgTable('addresses', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  label: text('label'),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  region: text('region').notNull(),
  postalCode: text('postal_code').notNull(),
  country: text('country').notNull().default('US'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  instructions: text('instructions'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
});

export const consents = pgTable(
  'consents',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    granted: boolean('granted').notNull(),
    source: text('source'),
    createdAt: createdAt(),
  },
  (t) => [index('consents_user_purpose_idx').on(t.userId, t.purpose)],
);

/** Organization = tenant: merchant company, corporate buyer, campus, partner, creator or the platform. */
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  kind: text('kind').notNull().default('MERCHANT'),
  /** parent company for groups of organizations */
  parentId: uuid('parent_id'),
  /** beneficial owners: [{ name, title, ownershipPct, email }] */
  owners: jsonb('owners').notNull().default([]),
  /** business contacts: [{ name, role, email, phone }] */
  contacts: jsonb('contacts').notNull().default([]),
  website: text('website'),
  accountManagerId: uuid('account_manager_id'),
  statusReason: text('status_reason'),
  statusChangedAt: ts('status_changed_at'),
  /** location statuses saved at suspension, restored on reinstatement */
  suspendedLocationStates: jsonb('suspended_location_states'),
  taxId: text('tax_id'),
  billingEmail: text('billing_email'),
  status: merchantStatusEnum('status').notNull().default('PROSPECT'),
  featureFlags: jsonb('feature_flags').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const orgMemberships = pgTable(
  'org_memberships',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    /** empty = all locations of the organization */
    locationIds: uuid('location_ids').array().notNull().default([]),
    approvalLimitCents: integer('approval_limit_cents').notNull().default(0),
    invitedAt: createdAt(),
    acceptedAt: ts('accepted_at'),
  },
  (t) => [uniqueIndex('org_memberships_user_org_role_key').on(t.userId, t.organizationId, t.role)],
);

export const deviceSessions = pgTable(
  'device_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    kind: text('kind').notNull(),
    locationId: uuid('location_id'),
    lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('device_sessions_user_device_key').on(t.userId, t.deviceId)],
);
