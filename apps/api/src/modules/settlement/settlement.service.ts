import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { deliveryJobs, drivers, invoices, journalEntries, legalSellers, locations, merchantStatements, organizations, payments, payouts, providerInvoices, refunds, reservations, unmatchedItems, orders } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { loadConfig } from '../../config/config';

@Injectable()
export class SettlementService {
  private readonly log = new Logger(SettlementService.name);

  constructor(@Inject(DB) private readonly db: Db, private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly payments: PaymentsService) {}

  /** Live merchant balance: what the platform owes (or is owed by) the merchant right now. */
  async merchantBalance(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const payable = await this.ledger.balance('MERCHANT_PAYABLE', orgId);
    const unpaid = await this.ledger.balance('MERCHANT_PAYABLE', orgId, { unreconciledOnly: true });
    const pending = await this.db.select().from(payouts).where(and(eq(payouts.partyId, orgId), inArray(payouts.status, ['ACCRUED', 'ELIGIBLE', 'SUBMITTED', 'HELD', 'FAILED'])));
    return { payableCents: payable, unreconciledCents: unpaid, pendingPayouts: pending, negativeBalance: payable < 0 };
  }

  /**
   * Weekly statement + payout per organization. Builds the statement from the ledger (not from orders) so refunds
   * after payout, cover fees, subscriptions and adjustments all net correctly.
   */
  async closePeriod(periodStart: Date, periodEnd: Date, orgId?: string) {
    const orgs = orgId ? await this.db.select().from(organizations).where(eq(organizations.id, orgId)) : await this.db.select().from(organizations).where(eq(organizations.kind, 'MERCHANT'));
    const out: { organizationId: string; statementId: string; payoutId: string | null; netCents: number }[] = [];
    for (const org of orgs) {
      const entries = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'MERCHANT_PAYABLE'), eq(journalEntries.partyId, org.id), isNull(journalEntries.reconciledAt), lt(journalEntries.createdAt, periodEnd)));
      if (!entries.length) continue;
      const net = entries.reduce((a, e) => a + e.creditCents - e.debitCents, 0);
      const orderIds = Array.from(new Set(entries.map((e) => e.orderId).filter((x): x is string => !!x)));
      const [sales] = orderIds.length ? await this.db.select({ gross: sql<number>`coalesce(sum(${orders.subtotalCents} - ${orders.discountCents}),0)::int`, tax: sql<number>`coalesce(sum(${orders.taxCents}),0)::int`, tips: sql<number>`coalesce(sum(case when ${orders.fulfillmentType} <> 'DELIVERY' then ${orders.tipCents} else 0 end),0)::int`, commission: sql<number>`coalesce(sum(${orders.commissionCents}),0)::int`, n: sql<number>`count(*)::int` }).from(orders).where(inArray(orders.id, orderIds)) : [{ gross: 0, tax: 0, tips: 0, commission: 0, n: 0 }];
      const [rf] = orderIds.length ? await this.db.select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}),0)::int` }).from(refunds).where(and(inArray(refunds.orderId, orderIds), eq(refunds.funder, 'MERCHANT'), eq(refunds.status, 'SUCCEEDED'))) : [{ cents: 0 }];
      const coverFees = entries.filter((e) => e.memo?.startsWith('Cover fee')).reduce((a, e) => a + e.debitCents, 0);
      const covers = entries.filter((e) => e.reservationId).length;
      const processing = 0; // processor fees are borne by the platform in this model
      const subscriptionCents = 0; // billed independently via invoices
      const adjustments = net - (sales.gross + sales.tax + sales.tips - sales.commission - rf.cents - coverFees);
      const stmtId = await this.db.transaction(async (tx) => {
        const [stmt] = await tx.insert(merchantStatements).values({ organizationId: org.id, periodStart, periodEnd, currency: loadConfig().DEFAULT_CURRENCY, grossSalesCents: sales.gross, taxCents: sales.tax, tipsCents: sales.tips, commissionCents: sales.commission, processingCents: processing, refundsCents: rf.cents, adjustmentsCents: adjustments, subscriptionCents, coverFeesCents: coverFees, netPayableCents: net, orderCount: sales.n, coverCount: covers }).returning();
        let payoutId: string | null = null;
        if (net > 0) {
          const [po] = await tx.insert(payouts).values({ organizationId: org.id, partyType: 'MERCHANT', partyId: org.id, provider: this.payments.providerName, status: 'ELIGIBLE', currency: stmt.currency, amountCents: net, periodStart, periodEnd, statementId: stmt.id }).returning();
          payoutId = po.id;
          await tx.update(merchantStatements).set({ payoutId }).where(eq(merchantStatements.id, stmt.id));
        }
        // mark entries as reconciled into this statement; a negative balance carries forward (not reconciled)
        if (net >= 0) await tx.update(journalEntries).set({ reconciledAt: new Date() }).where(inArray(journalEntries.id, entries.map((e) => e.id)));
        out.push({ organizationId: org.id, statementId: stmt.id, payoutId, netCents: net });
        return stmt.id;
      });
      this.log.log(`statement ${stmtId} for ${org.name}: net ${net}`);
    }
    return out;
  }

  /** Submit eligible payouts to the processor (bank transfer). Failures are retried with backoff by the worker. */
  async submitPayouts() {
    const eligible = await this.db.select().from(payouts).where(inArray(payouts.status, ['ELIGIBLE', 'FAILED']));
    let paid = 0;
    for (const po of eligible) {
      if (po.status === 'FAILED' && po.attempts >= 5) continue;
      if (po.status === 'FAILED' && po.submittedAt && Date.now() - po.submittedAt.getTime() < po.attempts * 3_600_000) continue; // backoff
      let accountId: string | null = null;
      if (po.partyType === 'MERCHANT') {
        const [seller] = await this.db.select({ acct: legalSellers.payoutAccountId, state: legalSellers.payoutOnboardingState }).from(legalSellers).where(eq(legalSellers.organizationId, po.partyId)).limit(1);
        accountId = seller?.state === 'COMPLETE' ? seller.acct : null;
      } else {
        const [d] = await this.db.select().from(drivers).where(eq(drivers.id, po.partyId)).limit(1);
        accountId = d?.payoutAccountId ?? null;
      }
      if (!accountId) {
        await this.db.update(payouts).set({ status: 'HELD', failureReason: 'Payout account not onboarded' }).where(eq(payouts.id, po.id));
        continue;
      }
      await this.db.update(payouts).set({ status: 'SUBMITTED', submittedAt: new Date(), attempts: po.attempts + 1 }).where(eq(payouts.id, po.id));
      const res = await this.payments.transfer({ accountId, amountCents: po.amountCents, currency: po.currency, idempotencyKey: `payout:${po.id}`, description: `Gutad payout ${po.periodStart.toISOString().slice(0, 10)}–${po.periodEnd.toISOString().slice(0, 10)}` });
      if (res.status === 'failed') {
        await this.db.update(payouts).set({ status: 'FAILED', failureReason: res.failureReason ?? 'Transfer failed' }).where(eq(payouts.id, po.id));
        await this.outbox.publish('payout.failed', po.id, { organizationId: po.organizationId, partyId: po.partyId, reason: res.failureReason });
        continue;
      }
      await this.db.transaction(async (tx) => {
        await tx.update(payouts).set({ status: res.status === 'paid' ? 'PAID' : 'SUBMITTED', providerTransferId: res.transferId, paidAt: res.status === 'paid' ? new Date() : null }).where(eq(payouts.id, po.id));
        await this.ledger.post({ payoutId: po.id, currency: po.currency }, [
          { account: po.partyType === 'MERCHANT' ? 'MERCHANT_PAYABLE' : 'DRIVER_PAYABLE', partyId: po.partyId, organizationId: po.organizationId, debitCents: po.amountCents, memo: `Payout ${po.id}`, },
          { account: 'BANK', creditCents: po.amountCents, memo: `Transfer ${res.transferId}` },
        ], tx);
        await this.outbox.publish('payout.paid', po.id, { organizationId: po.organizationId, partyId: po.partyId, amountCents: po.amountCents }, tx);
      });
      paid++;
    }
    return { submitted: paid, considered: eligible.length };
  }

  /** Driver payouts: accrue DRIVER_PAYABLE balances into weekly payouts. */
  async closeDriverPeriod(periodStart: Date, periodEnd: Date) {
    const ds = await this.db.select().from(drivers);
    const out: string[] = [];
    for (const d of ds) {
      const entries = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'DRIVER_PAYABLE'), eq(journalEntries.partyId, d.id), isNull(journalEntries.reconciledAt)));
      const net = entries.reduce((a, e) => a + e.creditCents - e.debitCents, 0);
      if (net <= 0) continue;
      await this.db.transaction(async (tx) => {
        const [po] = await tx.insert(payouts).values({ partyType: 'DRIVER', partyId: d.id, provider: this.payments.providerName, status: 'ELIGIBLE', currency: loadConfig().DEFAULT_CURRENCY, amountCents: net, periodStart, periodEnd }).returning();
        await tx.update(journalEntries).set({ reconciledAt: new Date() }).where(inArray(journalEntries.id, entries.map((e) => e.id)));
        out.push(po.id);
      });
    }
    return out;
  }

  /** Bank reconciliation: mark a payout reconciled when the bank line matches; else queue an unmatched item. */
  async reconcileBankLine(user: JwtPayload, input: { externalId: string; amountCents: number; currency: string; description?: string; payoutId?: string }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [po] = input.payoutId ? await this.db.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1) : await this.db.select().from(payouts).where(and(eq(payouts.amountCents, input.amountCents), eq(payouts.status, 'PAID'), isNull(payouts.reconciledAt))).limit(1);
    if (po && po.amountCents === input.amountCents) {
      await this.db.update(payouts).set({ status: 'RECONCILED', reconciledAt: new Date() }).where(eq(payouts.id, po.id));
      await this.db.update(journalEntries).set({ reconciledAt: new Date() }).where(and(eq(journalEntries.payoutId, po.id), eq(journalEntries.account, 'BANK')));
      return { matched: true, payoutId: po.id };
    }
    const [u] = await this.db.insert(unmatchedItems).values({ source: 'BANK', externalId: input.externalId, amountCents: input.amountCents, currency: input.currency, description: input.description ?? null }).returning();
    return { matched: false, unmatchedItemId: u.id };
  }

  /** Processor settlement file: match captured charges by provider id; anything else goes to the unmatched queue. */
  async reconcileProcessorLines(user: JwtPayload, lines: { providerChargeId: string; amountCents: number; feeCents: number }[]) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    let matched = 0;
    const unmatched: string[] = [];
    for (const l of lines) {
      const [p] = await this.db.select().from(payments).where(eq(payments.providerChargeId, l.providerChargeId)).limit(1);
      if (p && p.capturedCents === l.amountCents) {
        await this.db.update(payments).set({ status: p.status === 'CAPTURED' ? 'SETTLED' : p.status, processingFeeCents: l.feeCents }).where(eq(payments.id, p.id));
        matched++;
      } else {
        const [u] = await this.db.insert(unmatchedItems).values({ source: 'PROCESSOR', externalId: l.providerChargeId, amountCents: l.amountCents, currency: loadConfig().DEFAULT_CURRENCY, description: p ? `Amount mismatch: ours ${p.capturedCents}` : 'Unknown charge' }).returning();
        unmatched.push(u.id);
      }
    }
    return { matched, unmatched };
  }

  /** Provider (courier) invoice: match lines to delivery jobs by provider job id. */
  async ingestProviderInvoice(user: JwtPayload, input: { provider: string; externalId: string; periodStart: string; periodEnd: string; lines: { providerJobId: string; cents: number }[] }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const total = input.lines.reduce((a, l) => a + l.cents, 0);
    const [inv] = await this.db.insert(providerInvoices).values({ provider: input.provider, externalId: input.externalId, periodStart: new Date(input.periodStart), periodEnd: new Date(input.periodEnd), totalCents: total, lines: input.lines }).onConflictDoNothing().returning();
    if (!inv) throw new BadRequestException('Invoice already ingested');
    let matchedCents = 0;
    for (const l of input.lines) {
      const [job] = await this.db.select().from(deliveryJobs).where(eq(deliveryJobs.providerJobId, l.providerJobId)).limit(1);
      if (job && job.providerCostCents + job.tipCents === l.cents) {
        await this.db.update(deliveryJobs).set({ providerInvoiceId: inv.id }).where(eq(deliveryJobs.id, job.id));
        matchedCents += l.cents;
      } else {
        await this.db.insert(unmatchedItems).values({ source: 'PROVIDER', externalId: l.providerJobId, amountCents: l.cents, currency: loadConfig().DEFAULT_CURRENCY, description: job ? `Expected ${job.providerCostCents + job.tipCents}` : 'Unknown job' });
      }
    }
    const status = matchedCents === total ? 'MATCHED' : 'DISPUTED';
    await this.db.update(providerInvoices).set({ matchedCents, status }).where(eq(providerInvoices.id, inv.id));
    if (matchedCents > 0) {
      await this.ledger.post({ currency: loadConfig().DEFAULT_CURRENCY }, [{ account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', debitCents: matchedCents, memo: `Provider invoice ${input.externalId}` }, { account: 'BANK', creditCents: matchedCents, memo: `Pay ${input.provider}` }]);
    }
    return { ...inv, matchedCents, status };
  }

  async unmatchedQueue(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select().from(unmatchedItems).where(isNull(unmatchedItems.resolvedAt)).orderBy(desc(unmatchedItems.createdAt));
  }

  async resolveUnmatched(user: JwtPayload, id: string, resolution: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [u] = await this.db.update(unmatchedItems).set({ resolvedAt: new Date(), resolution }).where(eq(unmatchedItems.id, id)).returning();
    if (!u) throw new NotFoundException();
    await this.audit.log({ actorId: user.sub, action: 'unmatched.resolve', entityType: 'unmatched_item', entityId: id, after: { resolution } });
    return u;
  }

  async statements(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(merchantStatements).where(eq(merchantStatements.organizationId, orgId)).orderBy(desc(merchantStatements.periodEnd));
  }

  async statementDetail(user: JwtPayload, statementId: string) {
    const [s] = await this.db.select().from(merchantStatements).where(eq(merchantStatements.id, statementId)).limit(1);
    if (!s) throw new NotFoundException();
    assertOrgAccess(user, s.organizationId);
    const entries = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'MERCHANT_PAYABLE'), eq(journalEntries.partyId, s.organizationId), gte(journalEntries.createdAt, s.periodStart), lt(journalEntries.createdAt, s.periodEnd))).orderBy(journalEntries.createdAt);
    const payout = s.payoutId ? (await this.db.select().from(payouts).where(eq(payouts.id, s.payoutId)))[0] : null;
    return { ...s, entries, payout };
  }

  async invoicesFor(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(invoices).where(eq(invoices.organizationId, orgId)).orderBy(desc(invoices.createdAt));
  }

  async payInvoice(user: JwtPayload, invoiceId: string, paymentMethodId?: string) {
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!inv) throw new NotFoundException();
    assertOrgAccess(user, inv.organizationId);
    if (inv.status === 'PAID') return inv;
    return this.db.transaction(async (tx) => {
      await this.payments.chargeNow({ purpose: 'INVOICE', referenceId: inv.id, userId: user.sub, amountCents: inv.totalCents, currency: inv.currency, customerEmail: user.email, paymentMethodId, idempotencyKey: `invoice:${inv.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: inv.totalCents }, { account: 'CUSTOMER_RECEIVABLE', partyId: inv.organizationId, organizationId: inv.organizationId, creditCents: inv.totalCents, memo: `Invoice ${inv.number} paid` }] }, tx);
      const [u] = await tx.update(invoices).set({ status: 'PAID', paidAt: new Date() }).where(eq(invoices.id, inv.id)).returning();
      return u;
    });
  }

  /** Daily integrity checks surfaced to finance. */
  async integrity() {
    const unbalanced = await this.ledger.unbalancedBatches();
    const clearing = await this.ledger.accountTotals('PROCESSOR_CLEARING');
    const [held] = await this.db.select({ n: sql<number>`count(*)::int` }).from(payouts).where(inArray(payouts.status, ['HELD', 'FAILED']));
    const [unmatched] = await this.db.select({ n: sql<number>`count(*)::int` }).from(unmatchedItems).where(isNull(unmatchedItems.resolvedAt));
    return { unbalancedBatches: unbalanced, processorClearingNet: clearing.debits - clearing.credits, heldOrFailedPayouts: held?.n || 0, unmatchedItems: unmatched?.n || 0 };
  }

  async markPastDueInvoices(now = new Date()) {
    const r = await this.db.update(invoices).set({ status: 'PAST_DUE' }).where(and(eq(invoices.status, 'OPEN'), lt(invoices.dueAt, now))).returning({ id: invoices.id });
    return r.length;
  }

  async reservationsBillable(orgId: string, from: Date, to: Date) {
    return this.db.select({ n: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(${reservations.billableCovers}),0)::int` }).from(reservations).innerJoin(locations, eq(locations.id, reservations.locationId)).where(and(eq(locations.organizationId, orgId), eq(reservations.status, 'COMPLETED'), gte(reservations.completedAt, from), lt(reservations.completedAt, to)));
  }
}
