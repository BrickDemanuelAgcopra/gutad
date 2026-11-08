// 14 Reservation inventory, 15 Booking & policy, 16 Host stand & waitlist, 17 Experiences & private events
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { channelEnum, eventInquiryStatusEnum, reservationStatusEnum, waitlistStatusEnum } from './enums';
import { users } from './accounts';
import { locations } from './merchants';

export const rooms = pgTable('rooms', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isPrivate: boolean('is_private').notNull().default(false),
});

export const tables = pgTable('tables', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id').references(() => rooms.id),
  name: text('name').notNull(),
  section: text('section'),
  minSeats: integer('min_seats').notNull(),
  maxSeats: integer('max_seats').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  posTableId: text('pos_table_id'),
});

export const tableCombinations = pgTable('table_combinations', {
  id: id(),
  locationId: uuid('location_id').notNull(),
  name: text('name').notNull(),
  minSeats: integer('min_seats').notNull(),
  maxSeats: integer('max_seats').notNull(),
});

export const tableComboMembers = pgTable(
  'table_combo_members',
  {
    combinationId: uuid('combination_id')
      .notNull()
      .references(() => tableCombinations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.combinationId, t.tableId] })],
);

export const shifts = pgTable('shifts', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  daysOfWeek: integer('days_of_week').array().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  slotMinutes: integer('slot_minutes').notNull().default(15),
  turnMinutesSmall: integer('turn_minutes_small').notNull().default(75),
  turnMinutesMedium: integer('turn_minutes_medium').notNull().default(90),
  turnMinutesLarge: integer('turn_minutes_large').notNull().default(120),
  maxPartySize: integer('max_party_size').notNull().default(8),
  maxCoversPerSlot: integer('max_covers_per_slot').notNull().default(20),
  maxBookingsPerSlot: integer('max_bookings_per_slot').notNull().default(6),
  isActive: boolean('is_active').notNull().default(true),
});

export const blackoutDates = pgTable('blackout_dates', {
  id: id(),
  locationId: uuid('location_id').notNull(),
  date: ts('date').notNull(),
  reason: text('reason'),
  closed: boolean('closed').notNull().default(true),
});

export const reservationPolicies = pgTable('reservation_policies', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .unique()
    .references(() => locations.id, { onDelete: 'cascade' }),
  cancellationHours: integer('cancellation_hours').notNull().default(2),
  requiresCardAbove: integer('requires_card_above'),
  noShowFeeCents: integer('no_show_fee_cents').notNull().default(0),
  depositCents: integer('deposit_cents').notNull().default(0),
  depositAppliesToCheck: boolean('deposit_applies_to_check').notNull().default(true),
  holdMinutes: integer('hold_minutes').notNull().default(10),
  reminderHoursBefore: integer('reminder_hours_before').notNull().default(24),
  largePartyThreshold: integer('large_party_threshold').notNull().default(6),
});

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    userId: uuid('user_id').references(() => users.id),
    guestProfileId: uuid('guest_profile_id'),
    channel: channelEnum('channel').notNull(),
    status: reservationStatusEnum('status').notNull().default('HELD'),
    confirmationCode: text('confirmation_code').notNull().unique(),
    partySize: integer('party_size').notNull(),
    actualPartySize: integer('actual_party_size'),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    holdExpiresAt: ts('hold_expires_at'),
    guestName: text('guest_name').notNull(),
    guestPhone: text('guest_phone'),
    guestEmail: text('guest_email'),
    notes: text('notes'),
    occasion: text('occasion'),
    guaranteePaymentMethodId: text('guarantee_payment_method_id'),
    depositPaymentId: uuid('deposit_payment_id'),
    depositCents: integer('deposit_cents').notNull().default(0),
    depositAppliedCents: integer('deposit_applied_cents').notNull().default(0),
    noShowChargedCents: integer('no_show_charged_cents').notNull().default(0),
    arrivedAt: ts('arrived_at'),
    seatedAt: ts('seated_at'),
    completedAt: ts('completed_at'),
    canceledAt: ts('canceled_at'),
    noShowAt: ts('no_show_at'),
    reminderSentAt: ts('reminder_sent_at'),
    posCheckId: text('pos_check_id'),
    checkTotalCents: integer('check_total_cents'),
    billableCovers: integer('billable_covers'),
    coverFeeCents: integer('cover_fee_cents'),
    coverInvoiceId: uuid('cover_invoice_id'),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('reservations_location_start_idx').on(t.locationId, t.startAt), index('reservations_user_idx').on(t.userId)],
);

export const reservationTables = pgTable(
  'reservation_tables',
  {
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.reservationId, t.tableId] })],
);

export const reservationEvents = pgTable('reservation_events', {
  id: id(),
  reservationId: uuid('reservation_id')
    .notNull()
    .references(() => reservations.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  actorId: uuid('actor_id'),
  data: jsonb('data').notNull().default({}),
  createdAt: createdAt(),
});

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id),
    guestName: text('guest_name').notNull(),
    guestPhone: text('guest_phone'),
    partySize: integer('party_size').notNull(),
    status: waitlistStatusEnum('status').notNull().default('WAITING'),
    quotedMinutes: integer('quoted_minutes').notNull(),
    position: integer('position').notNull(),
    notifiedAt: ts('notified_at'),
    offerExpiresAt: ts('offer_expires_at'),
    seatedAt: ts('seated_at'),
    reservationId: uuid('reservation_id'),
    createdAt: createdAt(),
  },
  (t) => [index('waitlist_location_status_idx').on(t.locationId, t.status)],
);

// ───── 17 Experiences & private events ─────

export const experiences = pgTable('experiences', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  pricingMode: text('pricing_mode').notNull(), // FREE | PREPAID_PER_PERSON | PREPAID_PER_PARTY | PAY_AT_VENUE
  priceCents: integer('price_cents').notNull().default(0),
  serviceFeeBps: integer('service_fee_bps').notNull().default(200),
  serviceFeePayer: text('service_fee_payer').notNull().default('DINER'),
  refundPolicy: text('refund_policy').notNull().default('Refundable up to 48 hours before the session.'),
  refundCutoffHours: integer('refund_cutoff_hours').notNull().default(48),
  isActive: boolean('is_active').notNull().default(true),
});

export const experienceSessions = pgTable('experience_sessions', {
  id: id(),
  experienceId: uuid('experience_id')
    .notNull()
    .references(() => experiences.id, { onDelete: 'cascade' }),
  startAt: ts('start_at').notNull(),
  capacity: integer('capacity').notNull(),
  sold: integer('sold').notNull().default(0),
  held: integer('held').notNull().default(0),
  closedAt: ts('closed_at'),
});

export const experienceAddOns = pgTable('experience_add_ons', {
  id: id(),
  experienceId: uuid('experience_id')
    .notNull()
    .references(() => experiences.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
});

export const experienceTickets = pgTable('experience_tickets', {
  id: id(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => experienceSessions.id),
  userId: uuid('user_id'),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email'),
  spots: integer('spots').notNull(),
  addOns: jsonb('add_ons').notNull().default([]),
  status: text('status').notNull().default('HELD'), // HELD | CONFIRMED | ATTENDED | CANCELED | REFUNDED | TRANSFERRED | EXPIRED
  holdExpiresAt: ts('hold_expires_at'),
  ticketCents: integer('ticket_cents').notNull(),
  serviceFeeCents: integer('service_fee_cents').notNull().default(0),
  extrasOnsiteCents: integer('extras_onsite_cents').notNull().default(0),
  paymentId: uuid('payment_id'),
  attendedAt: ts('attended_at'),
  confirmationCode: text('confirmation_code').notNull().unique(),
  createdAt: createdAt(),
});

export const eventInquiries = pgTable('event_inquiries', {
  id: id(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactPhone: text('contact_phone'),
  eventDate: ts('event_date').notNull(),
  partySize: integer('party_size').notNull(),
  finalHeadcount: integer('final_headcount'),
  budgetCents: integer('budget_cents'),
  notes: text('notes'),
  status: eventInquiryStatusEnum('status').notNull().default('INQUIRY'),
  proposalCents: integer('proposal_cents'),
  proposalExpiresAt: ts('proposal_expires_at'),
  contractUrl: text('contract_url'),
  depositCents: integer('deposit_cents').notNull().default(0),
  depositPaymentId: uuid('deposit_payment_id'),
  balanceCents: integer('balance_cents').notNull().default(0),
  balancePaymentId: uuid('balance_payment_id'),
  roomId: uuid('room_id'),
  holdExpiresAt: ts('hold_expires_at'),
  invoiceId: uuid('invoice_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
