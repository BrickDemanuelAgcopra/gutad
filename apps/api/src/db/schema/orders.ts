// 07 Orders, 08 Intake, 09 Shared-kitchen production, 11 Pickup
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  boolean,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { channelEnum, fulfillmentTypeEnum, orderStatusEnum } from './enums';
import { users } from './accounts';
import { brands, kitchens, locations } from './merchants';
import { menuItems } from './catalog';

export const orders = pgTable(
  'orders',
  {
    id: id(),
    number: text('number').notNull().unique(),
    organizationId: uuid('organization_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    userId: uuid('user_id').references(() => users.id),
    guestName: text('guest_name'),
    guestEmail: text('guest_email'),
    guestPhone: text('guest_phone'),
    channel: channelEnum('channel').notNull(),
    fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull(),
    status: orderStatusEnum('status').notNull().default('SUBMITTED'),
    currency: text('currency').notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull(),
    serviceFeeCents: integer('service_fee_cents').notNull().default(0),
    deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
    tipCents: integer('tip_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    commissionCents: integer('commission_cents').notNull().default(0),
    commissionBps: integer('commission_bps').notNull().default(0),
    contractId: uuid('contract_id'),
    promoCode: text('promo_code'),
    promotionFunder: text('promotion_funder'),
    priceSnapshot: jsonb('price_snapshot').notNull(),
    scheduledFor: ts('scheduled_for'),
    promiseAt: ts('promise_at'),
    acceptedAt: ts('accepted_at'),
    readyAt: ts('ready_at'),
    collectedAt: ts('collected_at'),
    completedAt: ts('completed_at'),
    /** true when the order finished with some lines credited or unavailable */
    partialFulfillment: boolean('partial_fulfillment').notNull().default(false),
    canceledAt: ts('canceled_at'),
    cancelReason: text('cancel_reason'),
    rejectReason: text('reject_reason'),
    pickupCode: text('pickup_code'),
    specialInstructions: text('special_instructions'),
    deliveryAddress: jsonb('delivery_address'),
    posTicketId: text('pos_ticket_id'),
    externalOrderId: text('external_order_id'),
    parentOrderId: uuid('parent_order_id').references((): AnyPgColumn => orders.id),
    groupOrderId: uuid('group_order_id'),
    campusAccountId: uuid('campus_account_id'),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('orders_location_status_idx').on(t.locationId, t.status, t.createdAt),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_external_idx').on(t.externalOrderId),
  ],
);

export const orderLines = pgTable('order_lines', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: uuid('menu_item_id').references(() => menuItems.id),
  brandId: uuid('brand_id').references(() => brands.id),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  modifiersCents: integer('modifiers_cents').notNull().default(0),
  lineTotalCents: integer('line_total_cents').notNull(),
  modifiers: jsonb('modifiers').notNull().default([]),
  specialInstructions: text('special_instructions'),
  stationCode: text('station_code'),
  status: text('status').notNull().default('PENDING'), // PENDING | PREPARING | READY | UNAVAILABLE | REPLACED | CREDITED
  replacementNote: text('replacement_note'),
  participantId: uuid('participant_id'),
  label: text('label'),
});

export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorId: uuid('actor_id'),
    actorRole: text('actor_role'),
    data: jsonb('data').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

// ───── 09 Shared kitchen ─────

export const kitchenBrands = pgTable(
  'kitchen_brands',
  {
    kitchenId: uuid('kitchen_id')
      .notNull()
      .references(() => kitchens.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.kitchenId, t.brandId] })],
);

export const stations = pgTable('stations', {
  id: id(),
  kitchenId: uuid('kitchen_id')
    .notNull()
    .references(() => kitchens.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
});

export const kitchenTickets = pgTable('kitchen_tickets', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  stationId: uuid('station_id').references(() => stations.id),
  stationCode: text('station_code'),
  lineIds: uuid('line_ids').array().notNull().default([]),
  status: text('status').notNull().default('QUEUED'), // QUEUED | IN_PROGRESS | DONE | VOID
  startedAt: ts('started_at'),
  doneAt: ts('done_at'),
  printedAt: ts('printed_at'),
  createdAt: createdAt(),
});

export const packingTasks = pgTable('packing_tasks', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .unique()
    .references(() => orders.id, { onDelete: 'cascade' }),
  bagCode: text('bag_code').notNull(),
  status: text('status').notNull().default('WAITING'), // WAITING | VERIFYING | RELEASED | BLOCKED
  verifiedLineIds: uuid('verified_line_ids').array().notNull().default([]),
  blockedReason: text('blocked_reason'),
  releasedAt: ts('released_at'),
});
