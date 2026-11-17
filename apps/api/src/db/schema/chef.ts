// Gutad Chef Network — independent chefs, their applications, documents and public profiles
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';
import { locations } from './merchants';

/** A chef's guided, resumable application. `data` holds the per-step draft (ChefApplicationData). */
export const chefApplications = pgTable(
  'chef_applications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** DRAFT | SUBMITTED | IN_REVIEW | CHANGES_REQUESTED | APPROVED | REJECTED | WAITLISTED | APPEALED */
    status: text('status').notNull().default('DRAFT'),
    data: jsonb('data').notNull().default({}),
    /** denormalized from data for filtering */
    displayName: text('display_name'),
    region: text('region'),
    city: text('city'),
    kitchenType: text('kitchen_type'),
    percentComplete: integer('percent_complete').notNull().default(0),
    /** last automated completeness check: { at, missing: { step: [labels] } } */
    autoCheck: jsonb('auto_check'),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    /** steps the reviewer asked to correct, with a note */
    correctionSteps: text('correction_steps').array().notNull().default([]),
    reviewNote: text('review_note'),
    decisionReason: text('decision_reason'),
    appealNote: text('appeal_note'),
    /** [{ at, by, action, note }] */
    history: jsonb('history').notNull().default([]),
    organizationId: uuid('organization_id').references(() => organizations.id),
    submittedAt: ts('submitted_at'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('chef_applications_user_uq').on(t.userId), index('chef_applications_status_idx').on(t.status)],
);

/** Which documents a chef must provide, by state/region and kitchen type (empty arrays = all). */
export const chefDocRequirements = pgTable(
  'chef_doc_requirements',
  {
    id: id(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    regions: text('regions').array().notNull().default([]),
    kitchenTypes: text('kitchen_types').array().notNull().default([]),
    required: boolean('required').notNull().default(true),
    needsExpiry: boolean('needs_expiry').notNull().default(false),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chef_doc_requirements_key_uq').on(t.key)],
);

/** A document a chef uploaded (file in stored_files), reviewed by Gutad staff; expiry drives alerts. */
export const chefDocuments = pgTable(
  'chef_documents',
  {
    id: id(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => chefApplications.id, { onDelete: 'cascade' }),
    requirementKey: text('requirement_key').notNull(),
    fileId: uuid('file_id').notNull(),
    /** SUBMITTED | APPROVED | REJECTED | EXPIRED */
    status: text('status').notNull().default('SUBMITTED'),
    expiresAt: ts('expires_at'),
    note: text('note'),
    reviewedById: uuid('reviewed_by_id'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('chef_documents_app_idx').on(t.applicationId)],
);

/** The public chef identity (one per chef organization). Gutad sells; the chef stays visible. */
export const chefProfiles = pgTable(
  'chef_profiles',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    applicationId: uuid('application_id').references(() => chefApplications.id),
    /** approved kitchen location (locations.chef_kitchen = true) */
    locationId: uuid('location_id').references(() => locations.id),
    displayName: text('display_name').notNull(),
    slug: text('slug').notNull(),
    legalName: text('legal_name').notNull(),
    businessType: text('business_type').notNull().default('INDIVIDUAL'),
    bio: text('bio'),
    portraitFileId: uuid('portrait_file_id'),
    portfolioFileIds: uuid('portfolio_file_ids').array().notNull().default([]),
    cuisines: text('cuisines').array().notNull().default([]),
    languages: text('languages').array().notNull().default([]),
    experienceYears: integer('experience_years'),
    serviceCity: text('service_city'),
    serviceRegion: text('service_region'),
    serviceRadiusKm: integer('service_radius_km'),
    kitchenType: text('kitchen_type'),
    /** operating preferences: cookingDays, cutoffHour, minLeadDays, dailyCapacity, instantOrders, scheduledOrders, maxAdvanceDays */
    operating: jsonb('operating').notNull().default({}),
    /** ACTIVE | PAUSED | SUSPENDED */
    status: text('status').notNull().default('ACTIVE'),
    statusReason: text('status_reason'),
    /** chef switch: dishes appear only while true (and status ACTIVE) */
    acceptingOrders: boolean('accepting_orders').notNull().default(false),
    verifiedCredentials: text('verified_credentials').array().notNull().default([]),
    brandAgreementAcceptedAt: ts('brand_agreement_accepted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('chef_profiles_org_uq').on(t.organizationId), uniqueIndex('chef_profiles_slug_uq').on(t.slug), index('chef_profiles_user_idx').on(t.userId)],
);
