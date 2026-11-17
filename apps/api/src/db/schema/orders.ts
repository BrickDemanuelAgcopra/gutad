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
    smallOrderFeeCents: integer('small_order_fee_cents').notNull().default(0),
    packagingFeeCents: integer('packaging_fee_cents').notNull().default(0),
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
    /** Gutad Chef Network: one checkout across several chefs (one payment, one child order per kitchen) */
    checkoutGroupId: uuid('checkout_group_id'),
    /** charged in full at checkout (no authorization); money sits in DEFERRED_REVENUE until completion */
    prepaid: boolean('prepaid').notNull().default(false),
    /** the chef must accept by then or the order is declined and refunded automatically */
    acceptBy: ts('accept_by'),
    /** full refund on cancellation until then (the date's order cutoff); afterwards lateRefundPct */
    freeCancelUntil: ts('free_cancel_until'),
    lateRefundPct: integer('late_refund_pct'),
    /** when the prepaid money was recognized (chef payable, commission, fees) */
    recognizedAt: ts('recognized_at'),
    campusAccountId: uuid('campus_account_id'),
    idempotencyKey: text('idempotency_key').unique(),
    /** 14.8 dine-in table or kiosk pager number */
    tableNumber: text('table_number'),
    /** 14.1 customer asked for utensils */
    utensils: boolean('utensils').notNull().default(false),
    /** 14.5 pickup shelf slot the order sits in */
    shelfSlot: text('shelf_slot'),
    /** 14.6 who received it: { type: CUSTOMER|COURIER|TABLE, by, name?, courierId?, codeVerified, at } */
    handoff: jsonb('handoff'),
    /** 14.7 NOTIFIED | RESOLVED */
    noShowStage: text('no_show_stage'),
    noShowNotifiedAt: ts('no_show_notified_at'),
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
  /** 14.3 handling flags copied from the item (plus ALLERGEN when the note mentions an allergy) */
  handling: text('handling').array().notNull().default([]),
  readyAt: ts('ready_at'),
  participantId: uuid('participant_id'),
  label: text('label'),
  /** purchase snapshot of a customized dish's effective allergens and dietary labels (null = the item's own) */
  allergens: text('allergens').array(),
  dietaryTags: text('dietary_tags').array(),
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
  /** tickets the station can work at once; null = no limit */
  maxConcurrent: integer('max_concurrent'),
  isAvailable: boolean('is_available').notNull().default(true),
  equipment: text('equipment').array().notNull().default([]),
  /** 13.5 target minutes from fire to done */
  targetMinutes: integer('target_minutes').notNull().default(10),
  /** 23.2 skill needed to work this station */
  requiredSkill: text('required_skill'),
});

/** 13.2 routing: send an item, a category or a brand to a station. Most specific wins (item > category > brand). */
export const stationRoutes = pgTable('station_routes', {
  id: id(),
  kitchenId: uuid('kitchen_id')
    .notNull()
    .references(() => kitchens.id, { onDelete: 'cascade' }),
  matchType: text('match_type').notNull(), // ITEM | CATEGORY | BRAND
  matchId: uuid('match_id').notNull(),
  stationCode: text('station_code').notNull(),
  createdAt: createdAt(),
}, (t) => [index('station_routes_kitchen_idx').on(t.kitchenId)]);

/** 13.6 remakes, missing items and quality failures with reason codes. */
export const kitchenEvents = pgTable('kitchen_events', {
  id: id(),
  kitchenId: uuid('kitchen_id'),
  locationId: uuid('location_id').notNull(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  orderLineId: uuid('order_line_id'),
  stationCode: text('station_code'),
  kind: text('kind').notNull(), // REMAKE | MISSING | QUALITY_FAIL
  reasonCode: text('reason_code').notNull(),
  note: text('note'),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('kitchen_events_loc_idx').on(t.locationId, t.createdAt)]);

export const kitchenTickets = pgTable('kitchen_tickets', {
  id: id(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  stationId: uuid('station_id').references(() => stations.id),
  stationCode: text('station_code'),
  lineIds: uuid('line_ids').array().notNull().default([]),
  status: text('status').notNull().default('QUEUED'), // QUEUED | IN_PROGRESS | DONE | VOID
  /** NORMAL | REMAKE */
  kind: text('kind').notNull().default('NORMAL'),
  /** 13.3 when to start so every station finishes together */
  fireAt: ts('fire_at'),
  readyBy: ts('ready_by'),
  cookMinutes: integer('cook_minutes'),
  /** 13.5 set when the ticket passes its station target */
  delayedAt: ts('delayed_at'),
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
  /** 14.1 [{ key, label, done }] — extras beyond the order lines */
  checklist: jsonb('checklist').notNull().default([]),
  /** 14.2 bags: [{ n, code, handling[] }] */
  bagCount: integer('bag_count').notNull().default(1),
  bags: jsonb('bags').notNull().default([]),
  /** 14.3 union of line handling flags */
  handling: text('handling').array().notNull().default([]),
  verifiedById: uuid('verified_by_id'),
  createdAt: createdAt(),
});

/** Gutad Chef Network checkout across several chefs: one customer payment split into child orders per kitchen. */
export const checkoutGroups = pgTable('checkout_groups', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  guestEmail: text('guest_email'),
  /** PAID | FAILED */
  status: text('status').notNull().default('PAID'),
  currency: text('currency').notNull().default('USD'),
  totalCents: integer('total_cents').notNull(),
  orderCount: integer('order_count').notNull(),
  paymentId: uuid('payment_id'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: createdAt(),
});

/** How one payment is split across orders (multi-chef checkout); refunds are tracked per order. */
export const orderPaymentAllocations = pgTable(
  'order_payment_allocations',
  {
    id: id(),
    paymentId: uuid('payment_id').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    refundedCents: integer('refunded_cents').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('order_payment_allocations_payment_idx').on(t.paymentId), index('order_payment_allocations_order_idx').on(t.orderId)],
);
