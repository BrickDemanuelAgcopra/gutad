// Courier Release 3: demand forecast, incentive campaigns, fraud signals and review.
import { index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, id, ts, updatedAt } from './_common';
import { drivers } from './delivery';

/** Expected delivery jobs and courier supply per zone and hour. */
export const courierForecasts = pgTable('courier_forecasts', {
  id: id(),
  zoneId: uuid('zone_id').notNull(),
  hourStart: ts('hour_start').notNull(),
  expectedJobs: real('expected_jobs').notNull(),
  supplyCouriers: real('supply_couriers').notNull(),
  neededCouriers: integer('needed_couriers').notNull(),
  /** filled in once the hour has passed (accuracy) */
  actualJobs: integer('actual_jobs'),
  generatedAt: ts('generated_at').notNull(),
}, (t) => [uniqueIndex('courier_forecasts_zone_hour_uq').on(t.zoneId, t.hourStart), index('courier_forecasts_hour_idx').on(t.hourStart)]);

/** BOOST / QUEST / GUARANTEE incentive campaigns. */
export const courierCampaigns = pgTable('courier_campaigns', {
  id: id(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('DRAFT'), // DRAFT | SCHEDULED | ACTIVE | ENDED | CANCELED
  /** markets (regions); empty = everywhere */
  marketIds: uuid('market_ids').array().notNull().default([]),
  /** delivery zones; empty = every zone in the markets */
  zoneIds: uuid('zone_ids').array().notNull().default([]),
  windowStart: ts('window_start').notNull(),
  windowEnd: ts('window_end').notNull(),
  rules: jsonb('rules').notNull().default({}),
  eligibility: jsonb('eligibility').notNull().default({}),
  enrolment: text('enrolment').notNull().default('AUTO'), // AUTO | OPT_IN
  budgetCents: integer('budget_cents').notNull(),
  spentCents: integer('spent_cents').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdById: uuid('created_by_id'),
  settledAt: ts('settled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('courier_campaigns_status_idx').on(t.status, t.windowEnd)]);

export const courierCampaignEnrolments = pgTable('courier_campaign_enrolments', {
  id: id(),
  campaignId: uuid('campaign_id').notNull().references(() => courierCampaigns.id, { onDelete: 'cascade' }),
  driverId: uuid('driver_id').notNull().references(() => drivers.id, { onDelete: 'cascade' }),
  joinedAt: ts('joined_at').notNull(),
  settledAt: ts('settled_at'),
  payoutCents: integer('payout_cents'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('courier_campaign_enrolments_uq').on(t.campaignId, t.driverId)]);

/** One fraud/risk signal. `dedupe_key` keeps a replayed event from raising it twice. */
export const courierRiskSignals = pgTable('courier_risk_signals', {
  id: id(),
  driverId: uuid('driver_id').notNull().references(() => drivers.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  weight: integer('weight').notNull(),
  deliveryJobId: uuid('delivery_job_id'),
  data: jsonb('data').notNull().default({}),
  status: text('status').notNull().default('OPEN'), // OPEN | DISMISSED | CONFIRMED
  caseId: uuid('case_id'),
  dedupeKey: text('dedupe_key').notNull().unique(),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [index('courier_risk_signals_driver_idx').on(t.driverId, t.createdAt)]);

/** A courier under fraud review. One open case per courier; above the hold threshold, payouts wait. */
export const courierFraudCases = pgTable('courier_fraud_cases', {
  id: id(),
  driverId: uuid('driver_id').notNull().references(() => drivers.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('OPEN'), // OPEN | DECIDED
  score: integer('score').notNull(),
  holdActive: boolean('hold_active').notNull().default(false),
  decision: text('decision'),
  reason: text('reason'),
  /** plain text shown to the courier */
  notice: text('notice'),
  decidedById: uuid('decided_by_id'),
  decidedAt: ts('decided_at'),
  openedAt: ts('opened_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('courier_fraud_cases_open_uq').on(t.driverId).where(sql`status = 'OPEN'`)]);
