// Gutad Chef Network — independent chefs, their applications, documents and public profiles
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { organizations, users } from './accounts';
import { locations } from './merchants';
import { menuItems } from './catalog';
import { orders } from './orders';

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
    /** why the chef isn't active: DOCUMENTS (auto, lifted when renewed documents are approved) | QUALITY | ADMIN */
    statusCause: text('status_cause'),
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

/**
 * Per-date overrides of a chef's weekly cooking calendar: open an extra day, close a cooking day, or change the
 * kitchen's capacity for that date. `open` null = follow the weekly cooking days.
 */
export const chefCalendarDays = pgTable(
  'chef_calendar_days',
  {
    id: id(),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    open: boolean('open'),
    capacity: integer('capacity'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('chef_calendar_days_uq').on(t.chefProfileId, t.date)],
);

/** A holiday or time away: no orders for any date in [startDate, endDate]. */
export const chefPauses = pgTable(
  'chef_pauses',
  {
    id: id(),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    reason: text('reason'),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [index('chef_pauses_chef_idx').on(t.chefProfileId, t.startDate)],
);

/**
 * Units promised per kitchen location and service date. A quote briefly HOLDs capacity (until the quote expires);
 * checkout turns it into CONFIRMED rows tied to the order. Confirmed rows of canceled or rejected orders stop
 * counting automatically, and expired holds are ignored (and later marked RELEASED). Shared kitchens count once.
 */
export const kitchenCapacityLedger = pgTable(
  'kitchen_capacity_ledger',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    menuItemId: uuid('menu_item_id').notNull(),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    units: integer('units').notNull(),
    /** HELD | CONFIRMED | RELEASED */
    status: text('status').notNull().default('HELD'),
    /** the customer's checkout session: a new quote replaces the same session's earlier hold */
    holdKey: text('hold_key'),
    quoteId: uuid('quote_id'),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('kitchen_capacity_ledger_day_idx').on(t.locationId, t.serviceDate), index('kitchen_capacity_ledger_quote_idx').on(t.quoteId), index('kitchen_capacity_ledger_order_idx').on(t.orderId)],
);

/**
 * A customer's special request for a chef dish (Phase 6). The chef answers with a quote (`chef_request_quotes`),
 * asks a question (`chef_request_messages`) or declines. `respondBy` is the deadline of whoever must act next
 * (the chef while PENDING, the customer while NEEDS_INFO); open requests past it expire.
 */
export const chefRequests = pgTable(
  'chef_requests',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    chefDishId: uuid('chef_dish_id')
      .notNull()
      .references(() => chefDishes.id),
    /** ADD | REMOVE | SWAP | PORTION | OTHER */
    requestType: text('request_type').notNull(),
    details: text('details').notNull(),
    ingredient: text('ingredient'),
    servings: integer('servings').notNull().default(1),
    requestedDate: date('requested_date', { mode: 'string' }).notNull(),
    requestedTime: text('requested_time'),
    /** PREFERENCE | ALLERGY | DIETARY | OCCASION */
    reason: text('reason').notNull().default('PREFERENCE'),
    budgetCents: integer('budget_cents'),
    alternativesOk: boolean('alternatives_ok').notNull().default(true),
    alternativesNote: text('alternatives_note'),
    /** the customization the customer had chosen when asking (modifier option ids) */
    baseOptionIds: uuid('base_option_ids').array().notNull().default([]),
    /** PENDING | NEEDS_INFO | QUOTED | ACCEPTED | ORDERED | DECLINED | WITHDRAWN | EXPIRED | CLOSED */
    status: text('status').notNull().default('PENDING'),
    respondBy: ts('respond_by'),
    /** escalation rules: the chef was reminded, then Gutad was alerted before the deadline */
    remindedAt: ts('reminded_at'),
    escalatedAt: ts('escalated_at'),
    currentQuoteId: uuid('current_quote_id'),
    orderId: uuid('order_id').references(() => orders.id),
    /** first chef response (quote, question or decline), for response-time metrics */
    firstResponseAt: ts('first_response_at'),
    closedReason: text('closed_reason'),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chef_requests_user_idx').on(t.userId, t.createdAt), index('chef_requests_chef_idx').on(t.chefProfileId, t.status), index('chef_requests_status_idx').on(t.status, t.respondBy)],
);

/**
 * Versioned chef quotes for a request. Each new version supersedes the previous one. A quote fixes the exact
 * changes, portion, food price per serving, quantity, allergens and dietary labels, and the date (and time) it is
 * cooked for. An ALTERNATIVE can sell a different dish (shown with that dish's chef; never swapped in silently).
 */
export const chefRequestQuotes = pgTable(
  'chef_request_quotes',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => chefRequests.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** QUOTE | ALTERNATIVE */
    kind: text('kind').notNull().default('QUOTE'),
    /** SENT | ACCEPTED | SUPERSEDED | REVISION_REQUESTED | DECLINED | EXPIRED | ORDERED */
    status: text('status').notNull().default('SENT'),
    chefDishId: uuid('chef_dish_id')
      .notNull()
      .references(() => chefDishes.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    menuItemId: uuid('menu_item_id').notNull(),
    optionIds: uuid('option_ids').array().notNull().default([]),
    changes: text('changes').notNull(),
    portionDesc: text('portion_desc').notNull().default(''),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
    allergens: text('allergens').array().notNull().default([]),
    dietaryTags: text('dietary_tags').array().notNull().default([]),
    prepMinutes: integer('prep_minutes'),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    serviceTime: text('service_time'),
    note: text('note'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    orderId: uuid('order_id').references(() => orders.id),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chef_request_quotes_version_uq').on(t.requestId, t.version), index('chef_request_quotes_status_idx').on(t.status, t.expiresAt)],
);

/** Clarification messages on a request (customer, chef, Gutad staff, or system notes). */
export const chefRequestMessages = pgTable(
  'chef_request_messages',
  {
    id: id(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => chefRequests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id'),
    /** CUSTOMER | CHEF | STAFF | SYSTEM */
    authorRole: text('author_role').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('chef_request_messages_req_idx').on(t.requestId, t.createdAt)],
);

/**
 * A chef's quality record (Phase 7): automatic actions (food-safety report → dish suspended, expired document →
 * paused, threshold breach) and staff actions (warning, probation, suspension, reinstatement, notes).
 */
export const chefQualityEvents = pgTable(
  'chef_quality_events',
  {
    id: id(),
    chefProfileId: uuid('chef_profile_id')
      .notNull()
      .references(() => chefProfiles.id, { onDelete: 'cascade' }),
    /** WARNING | PROBATION | NOTE | THRESHOLD_BREACH | DISH_SUSPENDED | DISH_REINSTATED | CHEF_PAUSED | CHEF_SUSPENDED | CHEF_REINSTATED | DOCUMENT_EXPIRED */
    kind: text('kind').notNull(),
    /** AUTO | STAFF */
    source: text('source').notNull().default('STAFF'),
    incidentId: uuid('incident_id'),
    chefDishId: uuid('chef_dish_id'),
    /** the metrics at the time (threshold breaches) */
    data: jsonb('data'),
    note: text('note').notNull(),
    createdById: uuid('created_by_id'),
    createdAt: createdAt(),
  },
  (t) => [index('chef_quality_events_chef_idx').on(t.chefProfileId, t.createdAt), uniqueIndex('chef_quality_events_incident_uq').on(t.incidentId, t.kind)],
);
