// Admin platform, phase H: payments operations, settlement controls, accounting.
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_common';

/** 18.1 / 18.4 failed payment attempts (declines, capture failures) — the order itself may not exist. */
export const paymentFailures = pgTable('payment_failures', {
  id: id(),
  purpose: text('purpose').notNull(), // ORDER | CAPTURE | INVOICE | MEMBERSHIP
  paymentId: uuid('payment_id'),
  orderId: uuid('order_id'),
  quoteId: uuid('quote_id'),
  userId: uuid('user_id'),
  locationId: uuid('location_id'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  provider: text('provider').notNull(),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
}, (t) => [index('payment_failures_created_idx').on(t.createdAt)]);

/** 18.7 card disputes / chargebacks. */
export const disputes = pgTable('disputes', {
  id: id(),
  paymentId: uuid('payment_id').notNull(),
  orderId: uuid('order_id'),
  organizationId: uuid('organization_id'),
  providerDisputeId: text('provider_dispute_id').notNull(),
  reason: text('reason'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  status: text('status').notNull().default('NEEDS_RESPONSE'), // NEEDS_RESPONSE | UNDER_REVIEW | WON | LOST | ACCEPTED
  evidenceDueAt: ts('evidence_due_at'),
  evidence: jsonb('evidence'),
  evidenceSubmittedAt: ts('evidence_submitted_at'),
  /** who bears a lost dispute: PLATFORM | MERCHANT */
  liability: text('liability').notNull().default('PLATFORM'),
  outcomeAt: ts('outcome_at'),
  outcomeNote: text('outcome_note'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('disputes_provider_key').on(t.providerDisputeId)]);

/** 19.4 payout batches released through approval. */
export const payoutBatches = pgTable('payout_batches', {
  id: id(),
  status: text('status').notNull().default('DRAFT'), // DRAFT | PENDING_APPROVAL | APPROVED | SUBMITTED | DONE | CANCELED
  partyType: text('party_type'), // MERCHANT | DRIVER | null = both
  payoutCount: integer('payout_count').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  createdById: uuid('created_by_id'),
  approvalId: uuid('approval_id'),
  approvedById: uuid('approved_by_id'),
  submittedAt: ts('submitted_at'),
  note: text('note'),
  createdAt: createdAt(),
});

/** 19.7 merchant disputes a statement line. */
export const statementDisputes = pgTable('statement_disputes', {
  id: id(),
  statementId: uuid('statement_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  raisedById: uuid('raised_by_id'),
  reason: text('reason').notNull(),
  amountCents: integer('amount_cents'),
  status: text('status').notNull().default('OPEN'), // OPEN | RESOLVED | REJECTED
  resolution: text('resolution'),
  adjustmentCents: integer('adjustment_cents'),
  resolvedById: uuid('resolved_by_id'),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
});

/** 20.1 chart-of-accounts mapping: ledger account → GL code per legal entity. */
export const glAccounts = pgTable('gl_accounts', {
  id: id(),
  legalEntity: text('legal_entity').notNull().default('GUTAD'),
  ledgerAccount: text('ledger_account').notNull(),
  glCode: text('gl_code').notNull(),
  glName: text('gl_name').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('gl_accounts_entity_account').on(t.legalEntity, t.ledgerAccount)]);

/** 20.7 month-end close checklist. */
export const closePeriods = pgTable('close_periods', {
  id: id(),
  period: text('period').notNull(), // YYYY-MM
  status: text('status').notNull().default('OPEN'), // OPEN | CLOSED
  checklist: jsonb('checklist').notNull().default([]),
  closedById: uuid('closed_by_id'),
  closedAt: ts('closed_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('close_periods_period').on(t.period)]);

/** 20.8 budgets by cost center (a location, a department) and category. */
export const budgets = pgTable('budgets', {
  id: id(),
  costCenter: text('cost_center').notNull(),
  period: text('period').notNull(), // YYYY-MM
  category: text('category').notNull(), // REVENUE | COGS | LABOR | DELIVERY | PROCESSING | PROMOTION | REFUNDS | OTHER
  amountCents: integer('amount_cents').notNull(),
  createdById: uuid('created_by_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('budgets_key').on(t.costCenter, t.period, t.category)]);
