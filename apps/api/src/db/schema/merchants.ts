// 02 Merchant & location registry, 03 Publishing, 04 Discovery, 27 Devices
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { channelEnum, deliveryFleetEnum, merchantStatusEnum } from './enums';
import { organizations, users } from './accounts';

/** The legal entity that earns food revenue and receives payout. */
export const legalSellers = pgTable('legal_sellers', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  legalName: text('legal_name').notNull(),
  taxId: text('tax_id'),
  country: text('country').notNull().default('US'),
  payoutProvider: text('payout_provider').notNull().default('mock'),
  payoutAccountId: text('payout_account_id'),
  payoutOnboardingState: text('payout_onboarding_state').notNull().default('NOT_STARTED'),
  bankLast4: text('bank_last4'),
  beneficiaryName: text('beneficiary_name'),
  billingContact: text('billing_contact'),
  createdAt: createdAt(),
});

export const kitchens = pgTable('kitchens', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  addressLine1: text('address_line1').notNull(),
  city: text('city').notNull(),
  region: text('region').notNull(),
  postalCode: text('postal_code').notNull(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  isShared: boolean('is_shared').notNull().default(true),
  createdAt: createdAt(),
});

/** Consumer-facing brand (may be virtual and produced in a shared kitchen). */
export const brands = pgTable('brands', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  legalSellerId: uuid('legal_seller_id').references(() => legalSellers.id),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  logoUrl: text('logo_url'),
  contentRightsOk: boolean('content_rights_ok').notNull().default(true),
  royaltyBps: integer('royalty_bps').notNull().default(0),
  createdAt: createdAt(),
});

export const locations = pgTable(
  'locations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalSellerId: uuid('legal_seller_id').references(() => legalSellers.id),
    kitchenId: uuid('kitchen_id').references(() => kitchens.id),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    cuisine: text('cuisine').array().notNull().default([]),
    phone: text('phone'),
    email: text('email'),
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    city: text('city').notNull(),
    region: text('region').notNull(),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull().default('US'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    timezone: text('timezone').notNull().default('America/New_York'),
    currency: text('currency').notNull().default('USD'),
    heroImageUrl: text('hero_image_url'),
    photos: text('photos').array().notNull().default([]),
    amenities: text('amenities').array().notNull().default([]),
    status: merchantStatusEnum('status').notNull().default('CLAIMED'),
    verifiedAt: ts('verified_at'),
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id),
    duplicateOfId: uuid('duplicate_of_id'),
    acceptsPickup: boolean('accepts_pickup').notNull().default(true),
    acceptsDelivery: boolean('accepts_delivery').notNull().default(false),
    acceptsDineIn: boolean('accepts_dine_in').notNull().default(false),
    acceptsReservations: boolean('accepts_reservations').notNull().default(false),
    acceptsEvents: boolean('accepts_events').notNull().default(false),
    acceptsCatering: boolean('accepts_catering').notNull().default(false),
    isPaused: boolean('is_paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    pausedUntil: ts('paused_until'),
    orderThrottlePer15m: integer('order_throttle_per_15m'),
    defaultPrepMinutes: integer('default_prep_minutes').notNull().default(20),
    taxRateBps: integer('tax_rate_bps').notNull().default(800),
    minOrderCents: integer('min_order_cents').notNull().default(0),
    deliveryFleet: deliveryFleetEnum('delivery_fleet').notNull().default('PARTNER'),
    /** Pending merchant request to change who delivers; platform staff approve or decline it. */
    deliveryFleetRequested: deliveryFleetEnum('delivery_fleet_requested'),
    deliveryFleetRequestedAt: ts('delivery_fleet_requested_at'),
    deliveryFleetRequestNote: text('delivery_fleet_request_note'),
    /** Gutad's own culinary team prepares this location's menus ("Made at Gutad"); set by platform staff only. */
    platformOperated: boolean('platform_operated').notNull().default(false),
    deliveryRadiusKm: doublePrecision('delivery_radius_km').notNull().default(5),
    deliveryBaseFeeCents: integer('delivery_base_fee_cents').notNull().default(399),
    deliveryPerKmCents: integer('delivery_per_km_cents').notNull().default(50),
    rating: doublePrecision('rating'),
    ratingCount: integer('rating_count').notNull().default(0),
    posProvider: text('pos_provider'),
    posExternalId: text('pos_external_id'),
    tabletFallbackPhone: text('tablet_fallback_phone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('locations_city_idx').on(t.city, t.region), index('locations_geo_idx').on(t.lat, t.lng)],
);

export const openingHours = pgTable('opening_hours', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: integer('day_of_week').notNull(),
  opens: text('opens').notNull(),
  closes: text('closes').notNull(),
  service: text('service').notNull().default('ALL'),
});

/** 03 Publishing & distribution */
export const publications = pgTable('publications', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // LISTING | BRANDED_SITE | ORDER_LINK | QR | BOOKING_WIDGET | PARTNER_LINK
  channel: channelEnum('channel').notNull(),
  slug: text('slug').notNull().unique(),
  config: jsonb('config').notNull().default({}),
  partnerName: text('partner_name'),
  partnerUrl: text('partner_url'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const referralEvents = pgTable('referral_events', {
  id: id(),
  publicationId: uuid('publication_id')
    .notNull()
    .references(() => publications.id, { onDelete: 'cascade' }),
  referralCode: text('referral_code').notNull(),
  partnerOrderId: text('partner_order_id'),
  convertedAt: ts('converted_at'),
  payableCents: integer('payable_cents').notNull().default(0),
  agreementRef: text('agreement_ref'),
  createdAt: createdAt(),
});

/** 04 Discovery — sponsored placements */
export const sponsoredPlacements = pgTable('sponsored_placements', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id'),
  keyword: text('keyword'),
  city: text('city'),
  bidCents: integer('bid_cents').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  spentCents: integer('spent_cents').notNull().default(0),
});

/** 27 Devices: tablets, printers, KDS, host & packing screens */
export const devices = pgTable('devices', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  token: text('token').notNull().unique(),
  lastHeartbeatAt: ts('last_heartbeat_at'),
  isOnline: boolean('is_online').notNull().default(false),
  fallbackOwner: text('fallback_owner'),
  config: jsonb('config').notNull().default({}),
  createdAt: createdAt(),
});
