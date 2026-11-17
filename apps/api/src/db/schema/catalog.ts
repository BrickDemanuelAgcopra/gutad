// 05 Menu & offer catalog, 06 Quotes, 10 Kitchen supply & costing
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { channelEnum, fulfillmentTypeEnum } from './enums';
import { organizations } from './accounts';
import { brands, kitchens, locations } from './merchants';

// ───── 10 Supply & costing (defined first: menu items reference recipes) ─────

export const ingredients = pgTable('ingredients', {
  id: id(),
  name: text('name').notNull(),
  unit: text('unit').notNull(), // g, ml, each
  costCentsPerUnit: integer('cost_cents_per_unit').notNull().default(0),
  /** allergens this ingredient contains (milk, egg, fish, shellfish, tree_nuts, peanuts, wheat, soy, sesame, …) */
  allergens: text('allergens').array().notNull().default([]),
  /** owner of a merchant-specific ingredient; null = shared catalog */
  organizationId: uuid('organization_id'),
  /** 21.1 INGREDIENT | COMPONENT | PACKAGING | CONSUMABLE */
  kind: text('kind').notNull().default('INGREDIENT'),
  /** 21.2 purchase unit (case, kg, l…) and how many base units it holds */
  purchaseUnit: text('purchase_unit'),
  purchaseUnitFactor: doublePrecision('purchase_unit_factor').notNull().default(1),
  supplierId: uuid('supplier_id'),
  shelfLifeDays: integer('shelf_life_days'),
  /** 22.1 storage spec */
  minTempC: doublePrecision('min_temp_c'),
  maxTempC: doublePrecision('max_temp_c'),
});

export const ingredientStock = pgTable(
  'ingredient_stock',
  {
    kitchenId: uuid('kitchen_id')
      .notNull()
      .references(() => kitchens.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'cascade' }),
    onHand: doublePrecision('on_hand').notNull().default(0),
    parLevel: doublePrecision('par_level').notNull().default(0),
    /** 21.6 minimum buffer kept on hand */
    safetyStock: doublePrecision('safety_stock').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.kitchenId, t.ingredientId] })],
);

export const recipes = pgTable('recipes', {
  id: id(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  yieldPortions: doublePrecision('yield_portions').notNull().default(1),
  laborMinutes: doublePrecision('labor_minutes').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  organizationId: uuid('organization_id'),
  portionSize: text('portion_size'),
  /** [{ n, text, stationCode?, minutes? }] */
  steps: jsonb('steps').notNull().default([]),
  /** [{ ingredientId, substituteId, ratio, approved }] */
  substitutions: jsonb('substitutions').notNull().default([]),
  equipment: text('equipment').array().notNull().default([]),
  prepMinutes: doublePrecision('prep_minutes').notNull().default(0),
  batchMaxPortions: integer('batch_max_portions'),
  /** DRAFT | TRIAL | APPROVED | RETIRED — only APPROVED recipes go live on menu items */
  status: text('status').notNull().default('APPROVED'),
  /** [{ at, by, notes, score }] */
  trials: jsonb('trials').notNull().default([]),
  approvedById: uuid('approved_by_id'),
  approvedAt: ts('approved_at'),
  trainingUrl: text('training_url'),
  trainingNotes: text('training_notes'),
  changeSummary: text('change_summary'),
  previousRecipeId: uuid('previous_recipe_id'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
});

export const recipeLines = pgTable('recipe_lines', {
  id: id(),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id')
    .notNull()
    .references(() => ingredients.id),
  quantity: doublePrecision('quantity').notNull(),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: id(),
  kitchenId: uuid('kitchen_id')
    .notNull()
    .references(() => kitchens.id, { onDelete: 'cascade' }),
  supplier: text('supplier').notNull(),
  status: text('status').notNull().default('DRAFT'), // DRAFT | ORDERED | RECEIVED | CANCELED
  totalCents: integer('total_cents').notNull().default(0),
  receivedAt: ts('received_at'),
  /** 20.6 supplier bill: due date and payment */
  billDueAt: ts('bill_due_at'),
  billPaidAt: ts('bill_paid_at'),
  /** 21.7 supplier record and delivery schedule */
  supplierId: uuid('supplier_id'),
  expectedAt: ts('expected_at'),
  /** 21.8 supplier invoice and three-way match */
  invoiceNumber: text('invoice_number'),
  invoiceTotalCents: integer('invoice_total_cents'),
  invoiceLines: jsonb('invoice_lines'),
  matchStatus: text('match_status'), // MATCHED | VARIANCE
  matchDetail: jsonb('match_detail'),
  createdAt: createdAt(),
});

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: id(),
  purchaseOrderId: uuid('purchase_order_id')
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id')
    .notNull()
    .references(() => ingredients.id),
  quantity: doublePrecision('quantity').notNull(),
  unitCostCents: integer('unit_cost_cents').notNull(),
  receivedQty: doublePrecision('received_qty'),
  /** 21.7 receiving discrepancy note */
  discrepancyNote: text('discrepancy_note'),
});

export const wasteEvents = pgTable('waste_events', {
  id: id(),
  kitchenId: uuid('kitchen_id')
    .notNull()
    .references(() => kitchens.id, { onDelete: 'cascade' }),
  ingredientId: uuid('ingredient_id')
    .notNull()
    .references(() => ingredients.id),
  quantity: doublePrecision('quantity').notNull(),
  reason: text('reason'),
  createdAt: createdAt(),
});

export const laborEntries = pgTable('labor_entries', {
  id: id(),
  kitchenId: uuid('kitchen_id')
    .notNull()
    .references(() => kitchens.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  hours: doublePrecision('hours').notNull(),
  rateCents: integer('rate_cents').notNull(),
  date: ts('date').notNull(),
});

// ───── 05 Catalog ─────

export const menus = pgTable('menus', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  brandId: uuid('brand_id').references(() => brands.id),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  availableFrom: text('available_from'),
  availableUntil: text('available_until'),
  daysOfWeek: integer('days_of_week').array().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  channels: channelEnum('channels').array().notNull().default(['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR']),
  posExternalId: text('pos_external_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const menuCategories = pgTable('menu_categories', {
  id: id(),
  menuId: uuid('menu_id')
    .notNull()
    .references(() => menus.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const menuItems = pgTable('menu_items', {
  id: id(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => menuCategories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  priceCents: integer('price_cents').notNull(),
  imageUrl: text('image_url'),
  allergens: text('allergens').array().notNull().default([]),
  dietaryTags: text('dietary_tags').array().notNull().default([]),
  soldOut: boolean('sold_out').notNull().default(false),
  soldOutUntil: ts('sold_out_until'),
  /** 21.10 / 22.6 / 23.6 why it is sold out: MANUAL | STOCKOUT | RECALL | EQUIPMENT (only automatic reasons auto-restore) */
  soldOutSource: text('sold_out_source'),
  isActive: boolean('is_active').notNull().default(true),
  posExternalId: text('pos_external_id'),
  /** per-channel price overrides, e.g. {"MARKETPLACE": 1299} */
  channelPrices: jsonb('channel_prices').notNull().default({}),
  stationCode: text('station_code'),
  servingSize: text('serving_size'),
  photos: text('photos').array().notNull().default([]),
  /** { calories, proteinG, carbsG, fatG, sodiumMg, sugarG } */
  nutrition: jsonb('nutrition').notNull().default({}),
  /** ITEM | BUNDLE | BEVERAGE | EXTRA | PACKAGING */
  kind: text('kind').notNull().default('ITEM'),
  taxCategory: text('tax_category').notNull().default('STANDARD'),
  maxPerOrder: integer('max_per_order'),
  /** 13.3 minutes to cook; drives fire-at sequencing (null = recipe prep minutes or station default) */
  cookMinutes: integer('cook_minutes'),
  /** 14.3 HOT | COLD | FRAGILE | ALLERGEN */
  handling: text('handling').array().notNull().default([]),
  /** set when a recipe change adds allergens the item does not list */
  allergenReviewNeeded: boolean('allergen_review_needed').notNull().default(false),
  recipeId: uuid('recipe_id').references(() => recipes.id),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const modifierGroups = pgTable('modifier_groups', {
  id: id(),
  name: text('name').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  required: boolean('required').notNull().default(false),
  /** CHOICE (legacy) | SINGLE | LEVEL | MULTI | QUANTITY | INCLUDED — see @gutad/shared customization */
  selectionType: text('selection_type').notNull().default('CHOICE'),
  /** conditional group: applies only when this option is chosen */
  parentOptionId: uuid('parent_option_id'),
  description: text('description'),
  templateKey: text('template_key'),
  /** a chef dish's approved extras, found through ingredient search */
  isExtras: boolean('is_extras').notNull().default(false),
});

export const modifierOptions = pgTable('modifier_options', {
  id: id(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => modifierGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull().default(0),
  soldOut: boolean('sold_out').notNull().default(false),
  ingredientId: uuid('ingredient_id'),
  isDefault: boolean('is_default').notNull().default(false),
  maxQty: integer('max_qty').notNull().default(1),
  /** e.g. "one mushroom portion = 30 g" */
  portionDesc: text('portion_desc'),
  prepMinutesDelta: integer('prep_minutes_delta').notNull().default(0),
  addsAllergens: text('adds_allergens').array().notNull().default([]),
  removesDietaryTags: text('removes_dietary_tags').array().notNull().default([]),
  /** shown but not removable (mixed into a batch) */
  locked: boolean('locked').notNull().default(false),
  /** { [otherOptionId]: { maxQty?, priceCents?, hidden? } } while that option is chosen */
  rules: jsonb('rules').notNull().default({}),
  description: text('description'),
  searchTerms: text('search_terms').array().notNull().default([]),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const itemModifierGroups = pgTable(
  'item_modifier_groups',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => modifierGroups.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.groupId] })],
);

// ───── 06 Quotes ─────

export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    userId: uuid('user_id'),
    channel: channelEnum('channel').notNull(),
    fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull(),
    currency: text('currency').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull(),
    serviceFeeCents: integer('service_fee_cents').notNull().default(0),
    deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
    tipCents: integer('tip_cents').notNull().default(0),
    smallOrderFeeCents: integer('small_order_fee_cents').notNull().default(0),
    packagingFeeCents: integer('packaging_fee_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    promoCode: text('promo_code'),
    promotionFunder: text('promotion_funder'),
    deliveryQuoteId: text('delivery_quote_id'),
    deliveryProviderCostCents: integer('delivery_provider_cost_cents').notNull().default(0),
    scheduledFor: ts('scheduled_for'),
    promiseAt: ts('promise_at'),
    expiresAt: ts('expires_at').notNull(),
    consumedByOrderId: uuid('consumed_by_order_id').unique(),
    createdAt: createdAt(),
  },
  (t) => [index('quotes_location_created_idx').on(t.locationId, t.createdAt)],
);
