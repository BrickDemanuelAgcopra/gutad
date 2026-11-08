// 12 Delivery orchestration, 13 Driver operations
import { boolean, doublePrecision, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { deliveryFleetEnum, deliveryStatusEnum } from './enums';
import { users } from './accounts';
import { locations } from './merchants';
import { orders } from './orders';

export const deliveryZones = pgTable('delivery_zones', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** GeoJSON polygon; null = use location radius */
  polygon: jsonb('polygon'),
  feeCents: integer('fee_cents').notNull(),
  minOrderCents: integer('min_order_cents').notNull().default(0),
  etaMinutes: integer('eta_minutes').notNull().default(40),
  isActive: boolean('is_active').notNull().default(true),
});

export const drivers = pgTable('drivers', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | SUSPENDED
  vehicle: text('vehicle'),
  licenseVerified: boolean('license_verified').notNull().default(false),
  isAvailable: boolean('is_available').notNull().default(false),
  lastLat: doublePrecision('last_lat'),
  lastLng: doublePrecision('last_lng'),
  lastSeenAt: ts('last_seen_at'),
  payoutProvider: text('payout_provider').notNull().default('mock'),
  payoutAccountId: text('payout_account_id'),
  createdAt: createdAt(),
});

export const deliveryJobs = pgTable('delivery_jobs', {
  id: id(),
  orderId: uuid('order_id')
    .unique()
    .references(() => orders.id),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id),
  externalOrderId: text('external_order_id'),
  fleet: deliveryFleetEnum('fleet').notNull(),
  provider: text('provider').notNull(), // mock | doordash | uber | merchant | platform
  providerQuoteId: text('provider_quote_id'),
  providerJobId: text('provider_job_id').unique(),
  status: deliveryStatusEnum('status').notNull().default('QUOTED'),
  quoteExpiresAt: ts('quote_expires_at'),
  retailFeeCents: integer('retail_fee_cents').notNull().default(0),
  providerCostCents: integer('provider_cost_cents').notNull().default(0),
  platformSubsidyCents: integer('platform_subsidy_cents').notNull().default(0),
  tipCents: integer('tip_cents').notNull().default(0),
  pickupAddress: jsonb('pickup_address').notNull(),
  dropoffAddress: jsonb('dropoff_address').notNull(),
  driverId: uuid('driver_id').references(() => drivers.id),
  etaAt: ts('eta_at'),
  assignedAt: ts('assigned_at'),
  pickedUpAt: ts('picked_up_at'),
  deliveredAt: ts('delivered_at'),
  canceledAt: ts('canceled_at'),
  cancelReason: text('cancel_reason'),
  costOwner: text('cost_owner'), // CUSTOMER | MERCHANT | PLATFORM | PROVIDER | DRIVER
  proofPhotoUrl: text('proof_photo_url'),
  proofSignature: text('proof_signature'),
  trackingUrl: text('tracking_url'),
  providerInvoiceId: text('provider_invoice_id'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deliveryEvents = pgTable('delivery_events', {
  id: id(),
  deliveryJobId: uuid('delivery_job_id')
    .notNull()
    .references(() => deliveryJobs.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').notNull().default({}),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  createdAt: createdAt(),
});

export const driverOffers = pgTable('driver_offers', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  deliveryJobId: uuid('delivery_job_id')
    .notNull()
    .references(() => deliveryJobs.id, { onDelete: 'cascade' }),
  payCents: integer('pay_cents').notNull(),
  expiresAt: ts('expires_at').notNull(),
  status: text('status').notNull().default('OFFERED'), // OFFERED | ACCEPTED | DECLINED | EXPIRED
  createdAt: createdAt(),
});

export const driverEarnings = pgTable('driver_earnings', {
  id: id(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  deliveryJobId: uuid('delivery_job_id'),
  baseCents: integer('base_cents').notNull(),
  tipCents: integer('tip_cents').notNull().default(0),
  bonusCents: integer('bonus_cents').notNull().default(0),
  payoutId: uuid('payout_id'),
  createdAt: createdAt(),
});
