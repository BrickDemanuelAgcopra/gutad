// 18 Group/corporate/catering, 19 Meal kits, 20 Institutional & brand programs
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { fulfillmentTypeEnum, programTypeEnum, shipmentStatusEnum } from './enums';
import { organizations, users } from './accounts';
import { locations } from './merchants';

// ───── 18 Group orders ─────

export const corporateBudgets = pgTable('corporate_budgets', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  perPersonCents: integer('per_person_cents').notNull(),
  periodCents: integer('period_cents'),
  spentCents: integer('spent_cents').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const groupOrders = pgTable('group_orders', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id),
  organizerUserId: uuid('organizer_user_id').notNull(),
  budgetId: uuid('budget_id').references(() => corporateBudgets.id),
  mode: text('mode').notNull(), // SHARED_BASKET | INDIVIDUAL | CATERING_TRAYS
  name: text('name').notNull(),
  joinCode: text('join_code').notNull().unique(),
  cutoffAt: ts('cutoff_at').notNull(),
  deliverAt: ts('deliver_at').notNull(),
  fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull().default('DELIVERY'),
  deliveryAddress: jsonb('delivery_address'),
  headcount: integer('headcount'),
  dietaryNotes: text('dietary_notes'),
  payer: text('payer').notNull().default('ORGANIZER'), // ORGANIZER | EMPLOYER_INVOICE | INDIVIDUAL
  status: text('status').notNull().default('OPEN'), // OPEN | LOCKED | SUBMITTED | FULFILLED | CANCELED
  consolidatedOrderId: uuid('consolidated_order_id'),
  invoiceId: uuid('invoice_id'),
  createdAt: createdAt(),
});

export const groupOrderParticipants = pgTable('group_order_participants', {
  id: id(),
  groupOrderId: uuid('group_order_id')
    .notNull()
    .references(() => groupOrders.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  email: text('email'),
  allowanceCents: integer('allowance_cents'),
  overageCents: integer('overage_cents').notNull().default(0),
  lines: jsonb('lines').notNull().default([]),
  submittedAt: ts('submitted_at'),
  lateJoin: boolean('late_join').notNull().default(false),
});

// ───── 19 Meal kits ─────

export const mealKitProducts = pgTable('meal_kit_products', {
  id: id(),
  locationId: uuid('location_id').references(() => locations.id),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  priceCents: integer('price_cents').notNull(),
  weightGrams: integer('weight_grams').notNull().default(0),
  shipRegions: text('ship_regions').array().notNull().default([]),
  leadDays: integer('lead_days').notNull().default(2),
  stockOnHand: integer('stock_on_hand').notNull().default(0),
  stockReserved: integer('stock_reserved').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const shipments = pgTable('shipments', {
  id: id(),
  userId: uuid('user_id'),
  orderNumber: text('order_number').notNull().unique(),
  status: shipmentStatusEnum('status').notNull().default('RESERVED'),
  deliveryDate: ts('delivery_date').notNull(),
  address: jsonb('address').notNull(),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  batchId: uuid('batch_id'),
  totalCents: integer('total_cents').notNull(),
  paymentId: uuid('payment_id'),
  packedAt: ts('packed_at'),
  shippedAt: ts('shipped_at'),
  deliveredAt: ts('delivered_at'),
  createdAt: createdAt(),
});

export const shipmentLines = pgTable('shipment_lines', {
  id: id(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => mealKitProducts.id),
  quantity: integer('quantity').notNull(),
  unitCents: integer('unit_cents').notNull(),
});

export const shipmentCases = pgTable('shipment_cases', {
  id: id(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id, { onDelete: 'cascade' }),
  lineId: uuid('line_id'),
  kind: text('kind').notNull(), // MISSING | DAMAGED | FAILED_DELIVERY
  remedy: text('remedy'), // REPLACEMENT | CREDIT | REFUND
  creditCents: integer('credit_cents').notNull().default(0),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
});

export const packingBatches = pgTable('packing_batches', {
  id: id(),
  deliveryDate: ts('delivery_date').notNull(),
  status: text('status').notNull().default('OPEN'), // OPEN | PACKING | SHIPPED
  shipmentIds: uuid('shipment_ids').array().notNull().default([]),
  createdAt: createdAt(),
});

// ───── 20 Programs ─────

export const programs = pgTable('programs', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  type: programTypeEnum('type').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('APPLIED'), // APPLIED | QUALIFIED | CONTRACTED | TESTING | ACTIVE | OFFBOARDED
  config: jsonb('config').notNull().default({}),
  contractRef: text('contract_ref'),
  compensationBps: integer('compensation_bps').notNull().default(0),
  activatedAt: ts('activated_at'),
  offboardedAt: ts('offboarded_at'),
  createdAt: createdAt(),
});

export const campusLocations = pgTable(
  'campus_locations',
  {
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.programId, t.locationId] })],
);

export const campusAccounts = pgTable(
  'campus_accounts',
  {
    id: id(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campusUserId: text('campus_user_id').notNull(),
    balanceCents: integer('balance_cents').notNull().default(0),
    mealSwipes: integer('meal_swipes').notNull().default(0),
    isEligible: boolean('is_eligible').notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('campus_accounts_program_user_key').on(t.programId, t.userId)],
);

export const b2bOrders = pgTable('b2b_orders', {
  id: id(),
  programId: uuid('program_id')
    .notNull()
    .references(() => programs.id, { onDelete: 'cascade' }),
  items: jsonb('items').notNull(),
  totalCents: integer('total_cents').notNull(),
  status: text('status').notNull().default('PLACED'), // PLACED | FULFILLED | INVOICED | PAID
  invoiceId: uuid('invoice_id'),
  createdAt: createdAt(),
});
