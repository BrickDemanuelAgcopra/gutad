// Admin platform, phase D: menu versions (draft → review → publish → rollback), shared menus across
// locations, per-location item overrides, effective-dated price changes, item tax rates, recipe acknowledgments.
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';
import { menuItems, menus, recipes } from './catalog';
import { locations } from './merchants';
import { users } from './accounts';

/** A menu document version. The live tables are what customers see; a version is a snapshot or a proposed draft. */
export const menuVersions = pgTable(
  'menu_versions',
  {
    id: id(),
    menuId: uuid('menu_id')
      .notNull()
      .references(() => menus.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** DRAFT | IN_REVIEW | PUBLISHED | SUPERSEDED | REJECTED */
    status: text('status').notNull().default('DRAFT'),
    /** { categories: [{ id?, name, sortOrder, items: [{ id?, name, description, priceCents, ... }] }] } */
    document: jsonb('document').notNull(),
    note: text('note'),
    createdById: uuid('created_by_id'),
    submittedAt: ts('submitted_at'),
    reviewedById: uuid('reviewed_by_id'),
    reviewNote: text('review_note'),
    publishedAt: ts('published_at'),
    publishedById: uuid('published_by_id'),
    createdAt: createdAt(),
  },
  (t) => [index('menu_versions_menu_idx').on(t.menuId, t.version)],
);

/** A menu owned by one location also offered at other locations of the same merchant. */
export const menuLocationLinks = pgTable(
  'menu_location_links',
  {
    id: id(),
    menuId: uuid('menu_id')
      .notNull()
      .references(() => menus.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('menu_location_links_key').on(t.menuId, t.locationId)],
);

/** Location-specific assortment and price for a shared item. */
export const itemLocationOverrides = pgTable(
  'item_location_overrides',
  {
    id: id(),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents'),
    hidden: boolean('hidden').notNull().default(false),
    soldOut: boolean('sold_out').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('item_location_overrides_key').on(t.menuItemId, t.locationId)],
);

/** Effective-dated price change; applied by the worker at `effective_at` (or held for approval). */
export const priceChanges = pgTable(
  'price_changes',
  {
    id: id(),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    /** null = base price; otherwise the location override */
    locationId: uuid('location_id'),
    /** null = base price; otherwise the channel price */
    channel: text('channel'),
    previousPriceCents: integer('previous_price_cents'),
    newPriceCents: integer('new_price_cents').notNull(),
    effectiveAt: ts('effective_at').notNull(),
    /** SCHEDULED | PENDING_APPROVAL | APPLIED | CANCELED */
    status: text('status').notNull().default('SCHEDULED'),
    reason: text('reason'),
    approvalId: uuid('approval_id'),
    createdById: uuid('created_by_id'),
    appliedAt: ts('applied_at'),
    createdAt: createdAt(),
  },
  (t) => [index('price_changes_due_idx').on(t.status, t.effectiveAt), index('price_changes_item_idx').on(t.menuItemId, t.createdAt)],
);

/** Item tax category rates. Most specific wins: location → region (state) → platform default; else the location's flat rate. */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    region: text('region'),
    /** STANDARD | PREPARED_FOOD | GROCERY | ALCOHOL | BEVERAGE | EXEMPT | ... */
    category: text('category').notNull(),
    rateBps: integer('rate_bps').notNull(),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [index('tax_rates_lookup').on(t.category, t.locationId, t.region)],
);

/** Kitchen staff confirm they have read a recipe version (training / change acknowledgment). */
export const recipeAcknowledgments = pgTable(
  'recipe_acknowledgments',
  {
    id: id(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('recipe_ack_key').on(t.recipeId, t.userId)],
);
