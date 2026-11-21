// 12 Delivery orchestration, 13 Driver operations
import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  /** 15.1 SERVICE | EXCLUSION (an exclusion polygon carves an area out of service) */
  kind: text('kind').notNull().default('SERVICE'),
  /** 15.2 other locations this zone serves (the owner location is `locationId`) */
  locationIds: uuid('location_ids').array().notNull().default([]),
  kitchenId: uuid('kitchen_id'),
  regionId: uuid('region_id'),
  /** 15.3 travel minutes per km (null = 3), deliveries per hour (null = no cap), opening hours [{ dayOfWeek, opens, closes }] */
  travelMinutesPerKm: doublePrecision('travel_minutes_per_km'),
  capacityPerHour: integer('capacity_per_hour'),
  hours: jsonb('hours'),
  /** 15.7 distance tiers [{ upToKm, feeCents }] (first match wins; else feeCents) */
  feeTiers: jsonb('fee_tiers').notNull().default([]),
  updatedAt: updatedAt(),
});

export const drivers = pgTable('drivers', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | SUSPENDED
  vehicle: text('vehicle'),
  /** 16.3 BIKE | EBIKE | SCOOTER | CAR | VAN | WALK */
  vehicleType: text('vehicle_type').notNull().default('BIKE'),
  /** 16.3 ALCOHOL | LARGE_ORDER | COLD_BAG | HOT_BAG */
  capabilities: text('capabilities').array().notNull().default([]),
  /** 16.1 service area */
  regionId: uuid('region_id'),
  zoneIds: uuid('zone_ids').array().notNull().default([]),
  /** 17.4 orders carried at once */
  maxConcurrent: integer('max_concurrent').notNull().default(2),
  /** 16.8 suspension, appeal and human review */
  suspendedReason: text('suspended_reason'),
  suspendedAt: ts('suspended_at'),
  suspendedById: uuid('suspended_by_id'),
  appealStatus: text('appeal_status').notNull().default('NONE'), // NONE | PENDING | UPHELD | REINSTATED
  appealNote: text('appeal_note'),
  appealDecisionNote: text('appeal_decision_note'),
  reviewedById: uuid('reviewed_by_id'),
  licenseVerified: boolean('license_verified').notNull().default(false),
  isAvailable: boolean('is_available').notNull().default(false),
  lastLat: doublePrecision('last_lat'),
  lastLng: doublePrecision('last_lng'),
  lastSeenAt: ts('last_seen_at'),
  payoutProvider: text('payout_provider').notNull().default('mock'),
  payoutAccountId: text('payout_account_id'),
  /** Courier R1: application (DRAFT … APPROVED | WAITLISTED | REJECTED), separate from the lifecycle after approval */
  applicationStatus: text('application_status').notNull().default('DRAFT'),
  /** ACTIVE | RESTRICTED | SUSPENDED | DEACTIVATED | REACTIVATION_PENDING (null before approval) */
  lifecycleStatus: text('lifecycle_status'),
  /** { location, profile, vehicle, screening, payout, agreement, training, equipment } as entered in the wizard */
  onboarding: jsonb('onboarding').notNull().default({}),
  city: text('city'),
  submittedAt: ts('submitted_at'),
  decidedAt: ts('decided_at'),
  decidedById: uuid('decided_by_id'),
  decisionNote: text('decision_note'),
  lifecycleReason: text('lifecycle_reason'),
  /** ON_DEMAND | RESERVED */
  availabilityMode: text('availability_mode').notNull().default('ON_DEMAND'),
  onBreak: boolean('on_break').notNull().default(false),
  finishAfterCurrent: boolean('finish_after_current').notNull().default(false),
  firstDeliveryAt: ts('first_delivery_at'),
  ratingAvg: doublePrecision('rating_avg'),
  ratingCount: integer('rating_count').notNull().default(0),
  updatedAt: updatedAt(),
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
  /** 17.8 retention: proof removed after the retention period */
  proofPurgedAt: ts('proof_purged_at'),
  /** 17.6 arrival timestamps */
  arrivedPickupAt: ts('arrived_pickup_at'),
  arrivedDropoffAt: ts('arrived_dropoff_at'),
  /** 17.4 jobs carried together share a batch id */
  batchId: uuid('batch_id'),
  /** 17.5 offer rounds so far */
  offerAttempts: integer('offer_attempts').notNull().default(0),
  /** 16.3 ALCOHOL | LARGE_ORDER | COLD_BAG */
  requirements: text('requirements').array().notNull().default([]),
  /** 17.7 { kind, attempts: [{ at, method, note }], waitUntil, resolution, resolvedAt } */
  exception: jsonb('exception'),
  /** 17.9 providers tried, in order */
  providerChain: text('provider_chain').array().notNull().default([]),
  zoneId: uuid('zone_id'),
  distanceKm: doublePrecision('distance_km'),
  trackingUrl: text('tracking_url'),
  providerInvoiceId: text('provider_invoice_id'),
  idempotencyKey: text('idempotency_key').unique(),
  /** Courier R1: customer PIN accepted as handoff proof */
  handoffPin: text('handoff_pin'),
  /** { orderCode, bagCount, drinkCount, sealIntact, note, at } confirmed at pickup */
  pickupCheck: jsonb('pickup_check'),
  /** who holds the food: KITCHEN | COURIER | CUSTOMER | RETURNED | DISPOSED */
  custody: text('custody').notNull().default('KITCHEN'),
  /** pay policy + guaranteed pay accepted with the offer: { policy, pay: { baseCents, distanceCents, timeCents, totalCents }, estMinutes } */
  payPolicy: jsonb('pay_policy'),
  /** trip problems raised by the courier: [{ kind, note, at, incidentId, outcome }] */
  issues: jsonb('issues').notNull().default([]),
  /** how the handoff was proven: PHOTO | PIN | SIGNATURE */
  handoffMethod: text('handoff_method'),
  idCheckedAt: ts('id_checked_at'),
  /** Courier R2 kitchen-ready sync: estimated (kitchen-updated) and actual ready time */
  estReadyAt: ts('est_ready_at'),
  readyAt: ts('ready_at'),
  /** own-fleet offers are held until then (null = not held) */
  holdUntil: ts('hold_until'),
  /** the ready estimate the courier saw when accepting; pickup waiting counts from max(arrival, this) */
  acceptedReadyAt: ts('accepted_ready_at'),
  kitchenDelayMinutes: integer('kitchen_delay_minutes'),
  /** multi-brand manifest: { brands: [{ brandKey, brandName, orderId, orderNumber, items, bagCount, bagCodes }], totals, handling, hasAlcohol } */
  manifest: jsonb('manifest'),
  /** market (region with a courier policy) used for pay and batching */
  marketId: uuid('market_id'),
  /** partner fees read back from the provider (reconciliation) */
  providerFeeCents: integer('provider_fee_cents'),
  providerCancelFeeCents: integer('provider_cancel_fee_cents'),
  /** last ready time sent to the partner */
  providerSyncedReadyAt: ts('provider_synced_ready_at'),
  /** Courier R3: variance (actual + cancel fee − quoted) booked to the ledger */
  reconciledAt: ts('reconciled_at'),
  reconVarianceCents: integer('recon_variance_cents'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('delivery_jobs_hold_idx').on(t.status, t.holdUntil)]);

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
  status: text('status').notNull().default('OFFERED'), // OFFERED | ACCEPTED | DECLINED | EXPIRED | RELEASED
  /** Courier R1 guaranteed pay breakdown + estimates shown with the offer */
  payBreakdown: jsonb('pay_breakdown'),
  /** 17.2 assignment score (lower is better) and why */
  score: doublePrecision('score'),
  scoreDetail: jsonb('score_detail'),
  respondedAt: ts('responded_at'),
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
  /** Courier R1 itemized pay (base_cents is the base part only for R1 rows) */
  distanceCents: integer('distance_cents').notNull().default(0),
  timeCents: integer('time_cents').notNull().default(0),
  waitingCents: integer('waiting_cents').notNull().default(0),
  returnCents: integer('return_cents').notNull().default(0),
  policyVersion: integer('policy_version'),
  /** Courier R2: { pickupWaitMinutes, dropoffWaitMinutes, kitchenDelayMinutes, extraOrders, marketId, marketVersion } */
  detail: jsonb('detail'),
  /** earnings in hold until then (pending), available afterwards */
  availableAt: ts('available_at'),
  /** 16.7 DELIVERY | CANCEL_COMP | BONUS | DEDUCTION */
  kind: text('kind').notNull().default('DELIVERY'),
  reason: text('reason'),
  createdById: uuid('created_by_id'),
  payoutId: uuid('payout_id'),
  /** Courier R3: incentive campaign (kind INCENTIVE) */
  campaignId: uuid('campaign_id'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('driver_earnings_job_kind_uq').on(t.deliveryJobId, t.kind).where(sql`delivery_job_id is not null and kind in ('DELIVERY','CANCEL_COMP')`),
  uniqueIndex('driver_earnings_job_campaign_uq').on(t.deliveryJobId, t.campaignId).where(sql`kind = 'INCENTIVE' and delivery_job_id is not null`),
  uniqueIndex('driver_earnings_driver_campaign_uq').on(t.driverId, t.campaignId).where(sql`kind = 'INCENTIVE' and delivery_job_id is null`),
]);

/** Courier R2: per-market overrides of `delivery.pay` and `delivery.batching`. A market is an operating region. */
export const courierMarketPolicies = pgTable('courier_market_policies', {
  id: id(),
  regionId: uuid('region_id').notNull().unique(),
  pay: jsonb('pay').notNull().default({}),
  batching: jsonb('batching').notNull().default({}),
  version: integer('version').notNull().default(1),
  updatedById: uuid('updated_by_id'),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
});
