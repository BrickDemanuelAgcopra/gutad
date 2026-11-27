// Packaged goods: product records for menu items of kind PACKAGED, dated stock batches per location,
// checkout reservations (first-expiry-first), the stock movement ledger and recalls.
import { check, date, doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, id, ts, updatedAt } from './_common';
import { menuItems } from './catalog';
import { locations } from './merchants';

/** One per packaged menu item. Price, photos, allergens, nutrition and tax category stay on the menu item. */
export const packagedProducts = pgTable('packaged_products', {
  menuItemId: uuid('menu_item_id').primaryKey().references(() => menuItems.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').notNull(),
  sku: text('sku'),
  /** normalised GTIN-14 (UPC/EAN padded), check digit validated */
  gtin: text('gtin'),
  brandName: text('brand_name'),
  size: doublePrecision('size'),
  sizeUom: text('size_uom'),
  unitCount: integer('unit_count').notNull().default(1),
  /** PackagedCategory */
  category: text('category').notNull().default('OTHER'),
  /** AMBIENT | CHILLED | FROZEN */
  storage: text('storage').notNull().default('AMBIENT'),
  /** BEST_BEFORE | USE_BY | NONE */
  dateType: text('date_type').notNull().default('BEST_BEFORE'),
  /** null = the policy's minimum for the storage type */
  minRemainingDays: integer('min_remaining_days'),
  ingredientsText: text('ingredients_text'),
  countryOfOrigin: text('country_of_origin'),
  labelImageUrl: text('label_image_url'),
  lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
  /** DRAFT | PENDING | APPROVED | REJECTED | SUSPENDED */
  reviewStatus: text('review_status').notNull().default('DRAFT'),
  reviewNote: text('review_note'),
  submittedAt: ts('submitted_at'),
  reviewedAt: ts('reviewed_at'),
  reviewedById: uuid('reviewed_by_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('packaged_products_org_idx').on(t.organizationId), index('packaged_products_review_idx').on(t.reviewStatus), index('packaged_products_gtin_idx').on(t.gtin)]);

/** A dated batch of one product at one location. Available = on_hand − reserved while the batch is sellable. */
export const productLots = pgTable('product_lots', {
  id: id(),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  lotCode: text('lot_code').notNull(),
  /** the date on the pack (null when the product has no date) */
  expiresOn: date('expires_on'),
  receivedQty: integer('received_qty').notNull(),
  onHand: integer('on_hand').notNull(),
  reserved: integer('reserved').notNull().default(0),
  unitCostCents: integer('unit_cost_cents').notNull().default(0),
  /** ACTIVE | EXPIRED | RECALLED | QUARANTINED | DEPLETED */
  status: text('status').notNull().default('ACTIVE'),
  supplierName: text('supplier_name'),
  receivedById: uuid('received_by_id'),
  receivedAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('product_lots_item_loc_idx').on(t.menuItemId, t.locationId, t.status),
  index('product_lots_loc_idx').on(t.locationId, t.expiresOn),
  check('product_lots_qty_ck', sql`${t.reserved} >= 0 AND ${t.onHand} >= ${t.reserved}`),
]);

/** Units of an order line held on a batch: RESERVED at checkout, SOLD when the order leaves, RELEASED when it doesn't. */
export const productAllocations = pgTable('product_allocations', {
  id: id(),
  orderId: uuid('order_id').notNull(),
  orderLineId: uuid('order_line_id').notNull(),
  lotId: uuid('lot_id').notNull().references(() => productLots.id),
  menuItemId: uuid('menu_item_id').notNull(),
  locationId: uuid('location_id').notNull(),
  quantity: integer('quantity').notNull(),
  /** RESERVED | SOLD | RELEASED | SHORT */
  status: text('status').notNull().default('RESERVED'),
  createdAt: createdAt(),
  settledAt: ts('settled_at'),
}, (t) => [index('product_allocations_order_idx').on(t.orderId), index('product_allocations_line_idx').on(t.orderLineId), index('product_allocations_lot_idx').on(t.lotId, t.status)]);

/** Every stock change, signed: + into stock, − out of it (RESERVE/RELEASE change `reserved`, not `on_hand`). */
export const productStockMovements = pgTable('product_stock_movements', {
  id: id(),
  lotId: uuid('lot_id').notNull(),
  menuItemId: uuid('menu_item_id').notNull(),
  locationId: uuid('location_id').notNull(),
  /** RECEIPT | RESERVE | RELEASE | SALE | ADJUSTMENT | COUNT | WASTE | EXPIRED | RECALL | SHORT_PICK | RETURN */
  kind: text('kind').notNull(),
  quantity: integer('quantity').notNull(),
  orderId: uuid('order_id'),
  reason: text('reason'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('product_movements_item_idx').on(t.menuItemId, t.locationId, t.createdAt), index('product_movements_lot_idx').on(t.lotId)]);

/** A recall of batches, one product, or a GTIN across every seller (organization_id null = Gutad-wide). */
export const productRecalls = pgTable('product_recalls', {
  id: id(),
  /** LOT | PRODUCT | GTIN */
  scope: text('scope').notNull(),
  organizationId: uuid('organization_id'),
  menuItemId: uuid('menu_item_id'),
  gtin: text('gtin'),
  lotIds: uuid('lot_ids').array().notNull().default([]),
  reason: text('reason').notNull(),
  /** LOW | HIGH | CRITICAL */
  severity: text('severity').notNull().default('HIGH'),
  /** OPEN | CLOSED */
  status: text('status').notNull().default('OPEN'),
  lotsAffected: integer('lots_affected').notNull().default(0),
  unitsOnHand: integer('units_on_hand').notNull().default(0),
  ordersAffected: integer('orders_affected').notNull().default(0),
  customersNotified: integer('customers_notified').notNull().default(0),
  createdById: uuid('created_by_id'),
  closedAt: ts('closed_at'),
  closedNote: text('closed_note'),
  createdAt: createdAt(),
}, (t) => [index('product_recalls_org_idx').on(t.organizationId, t.createdAt)]);

