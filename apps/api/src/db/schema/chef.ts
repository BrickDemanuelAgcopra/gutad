// Gutad Chef Network — independent chefs, their applications, documents and public profiles
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';
import { locations } from './merchants';
import { menuItems } from './catalog';

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

/**
 * A chef's dish: the sellable `menu_items` row plus Chef Network details. The customer-facing title is always
 * "Gutad's <dishName> — by <chef>" (chefDishTitle). Material edits to a live dish wait in `pendingChanges` for review.
 */
export const chefDishes = pgTable(
  'chef_dishes',
  {
    id: id(),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    dishName: text('dish_name').notNull(),
    description: text('description'),
    cuisine: text('cuisine'),
    portionDesc: text('portion_desc').notNull().default(''),
    ingredients: text('ingredients').array().notNull().default([]),
    allergensConfirmed: boolean('allergens_confirmed').notNull().default(false),
    /** FIXED | CUSTOMIZABLE */
    mode: text('mode').notNull().default('FIXED'),
    acceptsSpecialRequests: boolean('accepts_special_requests').notNull().default(false),
    /** HOT | CHILLED_REHEAT | FROZEN | ROOM_TEMP */
    fulfillmentFormat: text('fulfillment_format').notNull().default('HOT'),
    prepMinutes: integer('prep_minutes').notNull().default(45),
    /** null = the chef's defaults */
    dailyCapacity: integer('daily_capacity'),
    minLeadDays: integer('min_lead_days'),
    cutoffHour: integer('cutoff_hour'),
    maxAdvanceDays: integer('max_advance_days'),
    photos: text('photos').array().notNull().default([]),
    /** DRAFT | IN_REVIEW | CHANGES_REQUESTED | PUBLISHED | SUSPENDED | ARCHIVED */
    reviewStatus: text('review_status').notNull().default('DRAFT'),
    reviewNote: text('review_note'),
    /** material edits to a live dish waiting for review */
    pendingChanges: jsonb('pending_changes'),
    /** customer options as the chef configured them (OptionsConfigGroup[]); materialized into modifier groups when approved */
    optionsConfig: jsonb('options_config').notNull().default([]),
    /** modifier groups generated from the approved configuration (and the extras group) */
    modifierGroupIds: uuid('modifier_group_ids').array().notNull().default([]),
    submittedAt: ts('submitted_at'),
    publishedAt: ts('published_at'),
    reviewedById: uuid('reviewed_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('chef_dishes_item_uq').on(t.menuItemId), index('chef_dishes_chef_idx').on(t.chefProfileId), index('chef_dishes_status_idx').on(t.reviewStatus)],
);

/**
 * A chef's approved extras catalog: ingredients the chef will add on request at a set price per portion.
 * New extras (and allergen changes) are reviewed by Gutad; approved extras are offered instantly only on the
 * dishes the chef allows (all customizable dishes, or selected ones). Anything else becomes a special request.
 */
export const chefExtras = pgTable(
  'chef_extras',
  {
    id: id(),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** search synonyms, e.g. "prawn" for shrimp */
    synonyms: text('synonyms').array().notNull().default([]),
    portionDesc: text('portion_desc'),
    priceCents: integer('price_cents').notNull().default(0),
    maxQty: integer('max_qty').notNull().default(2),
    prepMinutesDelta: integer('prep_minutes_delta').notNull().default(0),
    allergens: text('allergens').array().notNull().default([]),
    removesDietaryTags: text('removes_dietary_tags').array().notNull().default([]),
    /** true = every customizable dish of the chef; otherwise only dishIds */
    allDishes: boolean('all_dishes').notNull().default(false),
    dishIds: uuid('dish_ids').array().notNull().default([]),
    /** PENDING | APPROVED | REJECTED */
    status: text('status').notNull().default('PENDING'),
    reviewNote: text('review_note'),
    soldOut: boolean('sold_out').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chef_extras_chef_idx').on(t.chefProfileId)],
);

/** Modifier option generated for an extra on one dish (keeps option ids stable across syncs). */
export const chefDishExtras = pgTable(
  'chef_dish_extras',
  {
    dishId: uuid('dish_id')
      .notNull()
      .references(() => chefDishes.id, { onDelete: 'cascade' }),
    extraId: uuid('extra_id')
      .notNull()
      .references(() => chefExtras.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id').notNull(),
  },
  (t) => [uniqueIndex('chef_dish_extras_uq').on(t.dishId, t.extraId)],
);
