// 24 Payments & adjustments, 25 Contracts & monetization, 26 Settlement & reconciliation
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './_common';
import { ledgerAccountEnum, paymentStatusEnum, payoutStatusEnum } from './enums';
import { organizations } from './accounts';
import { planVersions, type FeeRule } from './plans';
import { locations } from './merchants';
import { orders } from './orders';
import { reservations } from './reservations';

// ───── 24 Payments ─────

export const payments = pgTable('payments', {
  id: id(),
  orderId: uuid('order_id')
    .unique()
    .references(() => orders.id),
  userId: uuid('user_id'),
  purpose: text('purpose').notNull().default('ORDER'), // ORDER | DEPOSIT | GUARANTEE | TICKET | SHIPMENT | MEMBERSHIP | EVENT_BALANCE | NO_SHOW | EVENT_DEPOSIT
  referenceId: text('reference_id'),
  provider: text('provider').notNull(), // mock | stripe
  providerIntentId: text('provider_intent_id').unique(),
  providerChargeId: text('provider_charge_id'),
  paymentMethodId: text('payment_method_id'),
  status: paymentStatusEnum('status').notNull().default('REQUIRES_ACTION'),
  currency: text('currency').notNull(),
  amountCents: integer('amount_cents').notNull(),
  authorizedCents: integer('authorized_cents').notNull().default(0),
  capturedCents: integer('captured_cents').notNull().default(0),
  refundedCents: integer('refunded_cents').notNull().default(0),
  processingFeeCents: integer('processing_fee_cents').notNull().default(0),
  applicationFeeCents: integer('application_fee_cents').notNull().default(0),
  destinationAccountId: text('destination_account_id'),
  clientSecret: text('client_secret'),
  disputeId: text('dispute_id'),
  disputeStatus: text('dispute_status'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const refunds = pgTable('refunds', {
  id: id(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id),
  orderId: uuid('order_id').references(() => orders.id),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  funder: text('funder').notNull(), // MERCHANT | PLATFORM | PROVIDER | DRIVER
  providerRefundId: text('provider_refund_id'),
  status: text('status').notNull().default('PENDING'), // PENDING | SUCCEEDED | FAILED
  approvedById: uuid('approved_by_id'),
  incidentId: uuid('incident_id'),
  createdAt: createdAt(),
});

export const customerCredits = pgTable(
  'customer_credits',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    cents: integer('cents').notNull(),
    reason: text('reason').notNull(),
    funder: text('funder').notNull().default('PLATFORM'),
    orderId: uuid('order_id'),
    expiresAt: ts('expires_at'),
    redeemedCents: integer('redeemed_cents').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('customer_credits_user_idx').on(t.userId)],
);

// ───── 25 Contracts ─────

export const merchantContracts = pgTable('merchant_contracts', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  name: text('name').notNull(),
  planCode: text('plan_code').notNull(),
  billingModels: text('billing_models').array().notNull().default([]),
  subscriptionCents: integer('subscription_cents').notNull().default(0),
  subscriptionInterval: text('subscription_interval').notNull().default('MONTH'),
  marketplaceCommissionBps: integer('marketplace_commission_bps').notNull().default(1500),
  directCommissionBps: integer('direct_commission_bps').notNull().default(0),
  processingBps: integer('processing_bps').notNull().default(295),
  processingFixedCents: integer('processing_fixed_cents').notNull().default(29),
  coverFeeNetworkCents: integer('cover_fee_network_cents').notNull().default(150),
  coverFeeDirectCents: integer('cover_fee_direct_cents').notNull().default(0),
  prepaidServiceFeeBps: integer('prepaid_service_fee_bps').notNull().default(200),
  deliverySubsidyCents: integer('delivery_subsidy_cents').notNull().default(0),
  logisticsFeeCents: integer('logistics_fee_cents').notNull().default(0),
  cancellationRules: jsonb('cancellation_rules').notNull().default({}),
  features: jsonb('features').notNull().default({}),
  regionRules: jsonb('region_rules').notNull().default({}),
  effectiveFrom: ts('effective_from').defaultNow().notNull(),
  effectiveTo: ts('effective_to'),
  signedAt: ts('signed_at'),
  /** Plan version this contract was created from (null for contracts that predate the plan catalog). */
  planVersionId: uuid('plan_version_id').references(() => planVersions.id),
  /** Fee rules copied from the plan version (plus overrides). Empty = use the legacy flat columns above. */
  fees: jsonb('fees').$type<FeeRule[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const contractLocations = pgTable(
  'contract_locations',
  {
    contractId: uuid('contract_id')
      .notNull()
      .references(() => merchantContracts.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    entitlements: jsonb('entitlements').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.contractId, t.locationId] })],
);

export const platformSubscriptions = pgTable('platform_subscriptions', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  contractId: uuid('contract_id')
    .notNull()
    .references(() => merchantContracts.id),
  status: text('status').notNull().default('ACTIVE'), // TRIAL | ACTIVE | PAST_DUE | CANCELED
  currentPeriodStart: ts('current_period_start').notNull(),
  currentPeriodEnd: ts('current_period_end').notNull(),
  locationCount: integer('location_count').notNull().default(1),
  lastInvoiceId: uuid('last_invoice_id'),
  canceledAt: ts('canceled_at'),
});

// ───── 26 Settlement ─────

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    batchId: uuid('batch_id').notNull(),
    account: ledgerAccountEnum('account').notNull(),
    organizationId: uuid('organization_id'),
    locationId: uuid('location_id'),
    partyId: text('party_id'),
    orderId: uuid('order_id').references(() => orders.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    paymentId: uuid('payment_id'),
    refundId: uuid('refund_id'),
    payoutId: uuid('payout_id'),
    invoiceId: uuid('invoice_id'),
    currency: text('currency').notNull(),
    debitCents: integer('debit_cents').notNull().default(0),
    creditCents: integer('credit_cents').notNull().default(0),
    memo: text('memo'),
    reconciledAt: ts('reconciled_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('journal_batch_idx').on(t.batchId),
    index('journal_account_party_idx').on(t.account, t.partyId, t.createdAt),
    index('journal_org_idx').on(t.organizationId, t.createdAt),
  ],
);

export const payouts = pgTable('payouts', {
  id: id(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  partyType: text('party_type').notNull(), // MERCHANT | DRIVER
  partyId: text('party_id').notNull(),
  provider: text('provider').notNull(),
  providerTransferId: text('provider_transfer_id').unique(),
  status: payoutStatusEnum('status').notNull().default('ACCRUED'),
  currency: text('currency').notNull(),
  amountCents: integer('amount_cents').notNull(),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  statementId: uuid('statement_id'),
  failureReason: text('failure_reason'),
  attempts: integer('attempts').notNull().default(0),
  submittedAt: ts('submitted_at'),
  paidAt: ts('paid_at'),
  reconciledAt: ts('reconciled_at'),
  createdAt: createdAt(),
});

export const merchantStatements = pgTable('merchant_statements', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id'),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  currency: text('currency').notNull(),
  grossSalesCents: integer('gross_sales_cents').notNull(),
  taxCents: integer('tax_cents').notNull(),
  tipsCents: integer('tips_cents').notNull(),
  commissionCents: integer('commission_cents').notNull(),
  processingCents: integer('processing_cents').notNull(),
  refundsCents: integer('refunds_cents').notNull(),
  adjustmentsCents: integer('adjustments_cents').notNull().default(0),
  subscriptionCents: integer('subscription_cents').notNull().default(0),
  coverFeesCents: integer('cover_fees_cents').notNull().default(0),
  netPayableCents: integer('net_payable_cents').notNull(),
  orderCount: integer('order_count').notNull(),
  coverCount: integer('cover_count').notNull().default(0),
  payoutId: uuid('payout_id'),
  pdfUrl: text('pdf_url'),
  createdAt: createdAt(),
});

export const invoices = pgTable('invoices', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  number: text('number').notNull().unique(),
  kind: text('kind').notNull(), // SUBSCRIPTION | COVERS | ADS | COMMISSION | PROVIDER | EMPLOYER | EVENT | B2B
  status: text('status').notNull().default('OPEN'), // OPEN | PAID | VOID | PAST_DUE
  currency: text('currency').notNull(),
  lines: jsonb('lines').notNull(),
  totalCents: integer('total_cents').notNull(),
  dueAt: ts('due_at').notNull(),
  paidAt: ts('paid_at'),
  providerInvoiceId: text('provider_invoice_id'),
  createdAt: createdAt(),
});

export const providerInvoices = pgTable('provider_invoices', {
  id: id(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull().unique(),
  periodStart: ts('period_start').notNull(),
  periodEnd: ts('period_end').notNull(),
  totalCents: integer('total_cents').notNull(),
  lines: jsonb('lines').notNull(),
  matchedCents: integer('matched_cents').notNull().default(0),
  status: text('status').notNull().default('RECEIVED'), // RECEIVED | MATCHED | DISPUTED | PAID
  createdAt: createdAt(),
});

export const unmatchedItems = pgTable('unmatched_items', {
  id: id(),
  source: text('source').notNull(), // PROCESSOR | PROVIDER | BANK
  externalId: text('external_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  description: text('description'),
  resolvedAt: ts('resolved_at'),
  resolution: text('resolution'),
  createdAt: createdAt(),
});
