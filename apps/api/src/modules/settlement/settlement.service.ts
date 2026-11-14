import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { classifyMerchantEntry } from '@gutad/shared';
import { ApprovalsService } from '../security/approvals.service';
import { computeRoyalty, type RoyaltyRule } from '../merchant-admin/brands-admin.service';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { deliveryJobs, drivers, invoices, journalEntries, legalSellers, locations, merchantStatements, organizations, payments, payoutBatches, payouts, providerInvoices, refunds, reservations, statementDisputes, unmatchedItems, orders } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { loadConfig } from '../../config/config';

@Injectable()
export class SettlementService implements OnModuleInit {
  private readonly log = new Logger(SettlementService.name);

  constructor(@Inject(DB) private readonly db: Db, private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly payments: PaymentsService, private readonly approvals: ApprovalsService) {}

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
      // payout postings settle an already-statemented balance (and a returned transfer re-opens that same payout), so they are never re-counted
      const entries = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'MERCHANT_PAYABLE'), eq(journalEntries.partyId, org.id), isNull(journalEntries.reconciledAt), isNull(journalEntries.payoutId), lt(journalEntries.createdAt, periodEnd)));
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

  onModuleInit() {
    // 2.6-P / 19.4 a payout batch above the threshold is released only after a second person approves it
    this.approvals.register('PAYOUT_RELEASE', {
      execute: async (req) => {
        const [b] = await this.db.update(payoutBatches).set({ status: 'APPROVED', approvedById: req.decidedById }).where(and(eq(payoutBatches.id, req.subjectId), eq(payoutBatches.status, 'PENDING_APPROVAL'))).returning();
        if (!b) return { batchId: req.subjectId, note: 'Batch no longer pending' };
        const r = await this.submitPayouts({ batchId: b.id });
        await this.db.update(payoutBatches).set({ status: 'SUBMITTED', submittedAt: new Date() }).where(eq(payoutBatches.id, b.id));
        return { batchId: b.id, ...r };
      },
    });
  }

  /**
   * Submit payouts of approved batches to the processor (bank transfer). Failures are retried with backoff by the
   * worker. Payouts of a seller whose bank details changed recently are held until the cooling-off ends (19.9).
   */
  async submitPayouts(opts?: { batchId?: string }) {
    const eligible = await this.db.select({ po: payouts }).from(payouts).innerJoin(payoutBatches, eq(payoutBatches.id, payouts.batchId)).where(and(inArray(payouts.status, ['ELIGIBLE', 'FAILED']), inArray(payoutBatches.status, ['APPROVED', 'SUBMITTED']), ...(opts?.batchId ? [eq(payouts.batchId, opts.batchId)] : []))).then((r) => r.map((x) => x.po));
    let paid = 0, held = 0;
    for (const po of eligible) {
      if (po.status === 'FAILED' && po.attempts >= 5) continue;
      if (po.status === 'FAILED' && po.submittedAt && Date.now() - po.submittedAt.getTime() < po.attempts * 3_600_000) continue; // backoff
      let accountId: string | null = null;
      if (po.partyType === 'MERCHANT') {
        const [seller] = await this.db.select({ acct: legalSellers.payoutAccountId, state: legalSellers.payoutOnboardingState, hold: legalSellers.payoutHoldUntil }).from(legalSellers).where(eq(legalSellers.organizationId, po.partyId)).limit(1);
        if (seller?.hold && seller.hold > new Date()) {
          await this.db.update(payouts).set({ status: 'HELD', failureReason: `Bank details changed recently; held until ${seller.hold.toISOString().slice(0, 16).replace('T', ' ')} UTC` }).where(eq(payouts.id, po.id));
          held++;
          continue;
        }
        accountId = seller?.state === 'COMPLETE' ? seller.acct : null;
      } else {
        const [d] = await this.db.select().from(drivers).where(eq(drivers.id, po.partyId)).limit(1);
        accountId = d?.payoutAccountId ?? null;
      }
      if (!accountId) {
        await this.db.update(payouts).set({ status: 'HELD', failureReason: 'Payout account not onboarded' }).where(eq(payouts.id, po.id));
        held++;
        continue;
      }
      await this.db.update(payouts).set({ status: 'SUBMITTED', submittedAt: new Date(), attempts: po.attempts + 1 }).where(eq(payouts.id, po.id));
      const res = await this.payments.transfer({ accountId, amountCents: po.amountCents, currency: po.currency, idempotencyKey: `payout:${po.id}:${po.attempts + 1}`, description: `Gutad payout ${po.periodStart.toISOString().slice(0, 10)}–${po.periodEnd.toISOString().slice(0, 10)}` });
      if (res.status === 'failed') {
        await this.db.update(payouts).set({ status: 'FAILED', failureReason: res.failureReason ?? 'Transfer failed' }).where(eq(payouts.id, po.id));
        await this.outbox.publish('payout.failed', po.id, { organizationId: po.organizationId, partyId: po.partyId, reason: res.failureReason });
        continue;
      }
      await this.db.transaction(async (tx) => {
        await tx.update(payouts).set({ status: res.status === 'paid' ? 'PAID' : 'SUBMITTED', providerTransferId: res.transferId, paidAt: res.status === 'paid' ? new Date() : null, failureReason: null }).where(eq(payouts.id, po.id));
        await this.ledger.post({ payoutId: po.id, currency: po.currency }, [
          { account: po.partyType === 'MERCHANT' ? 'MERCHANT_PAYABLE' : 'DRIVER_PAYABLE', partyId: po.partyId, organizationId: po.organizationId, debitCents: po.amountCents, memo: `Payout ${po.id}` },
          { account: 'BANK', creditCents: po.amountCents, memo: `Transfer ${res.transferId}` },
        ], tx);
        await this.outbox.publish('payout.paid', po.id, { organizationId: po.organizationId, partyId: po.partyId, amountCents: po.amountCents }, tx);
      });
      paid++;
    }
    if (opts?.batchId) {
      const left = await this.db.select({ n: sql<number>`count(*)::int` }).from(payouts).where(and(eq(payouts.batchId, opts.batchId), inArray(payouts.status, ['ELIGIBLE', 'SUBMITTED', 'FAILED', 'HELD'])));
      if (!left[0].n) await this.db.update(payoutBatches).set({ status: 'DONE' }).where(eq(payoutBatches.id, opts.batchId));
    }
    return { submitted: paid, held, considered: eligible.length };
  }

  /** Driver payouts: accrue DRIVER_PAYABLE balances into payouts (16.7-P: released through the same batches). */
  async closeDriverPeriod(periodStart: Date, periodEnd: Date) {
    const ds = await this.db.select().from(drivers);
    const out: string[] = [];
    for (const d of ds) {
      const entries = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'DRIVER_PAYABLE'), eq(journalEntries.partyId, d.id), isNull(journalEntries.reconciledAt), isNull(journalEntries.payoutId)));
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

  // ───── 19.4 payout batches ─────

  /**
   * Gather eligible payouts (not yet in a batch) into a batch. Below `approvals.thresholds.payoutCents` the batch is
   * released at once; above it, a PAYOUT_RELEASE approval is requested and a second person releases it.
   */
  async createBatch(user: JwtPayload | null, input: { partyType?: 'MERCHANT' | 'DRIVER'; payoutIds?: string[]; note?: string; reason?: string }) {
    if (user) assertCan(user, 'finance.manage');
    const rowsP = await this.db.select().from(payouts).where(and(eq(payouts.status, 'ELIGIBLE'), isNull(payouts.batchId), ...(input.partyType ? [eq(payouts.partyType, input.partyType)] : []), ...(input.payoutIds?.length ? [inArray(payouts.id, input.payoutIds)] : [])));
    if (!rowsP.length) return { status: 'EMPTY' as const, submitted: 0, considered: 0 };
    const total = rowsP.reduce((a, p) => a + p.amountCents, 0);
    const t = await this.approvals.thresholds();
    const needsApproval = t.payoutCents > 0 && total > t.payoutCents;
    const [b] = await this.db.insert(payoutBatches).values({ status: needsApproval ? (user ? 'PENDING_APPROVAL' : 'DRAFT') : 'APPROVED', partyType: input.partyType ?? null, payoutCount: rowsP.length, totalCents: total, createdById: user?.sub ?? null, note: input.note ?? null }).returning();
    await this.db.update(payouts).set({ batchId: b.id }).where(inArray(payouts.id, rowsP.map((p) => p.id)));
    if (user) await this.audit.log({ actorId: user.sub, action: 'payout.batch', entityType: 'payout_batch', entityId: b.id, after: { total, count: rowsP.length, needsApproval } });
    if (needsApproval) {
      if (!user) return { status: 'DRAFT' as const, batchId: b.id, totalCents: total, submitted: 0, considered: rowsP.length };
      const r = await this.approvals.submit(user, { kind: 'PAYOUT_RELEASE', summary: `Payout batch: ${rowsP.length} payout(s), $${(total / 100).toFixed(2)}`, subjectType: 'payout_batch', subjectId: b.id, amountCents: total, payload: { batchId: b.id }, reason: input.reason || `Payout batch over the $${(t.payoutCents / 100).toFixed(0)} release limit`, dedupeKey: `payout-batch:${b.id}` });
      await this.db.update(payoutBatches).set({ approvalId: r.approval.id }).where(eq(payoutBatches.id, b.id));
      return { status: 'PENDING_APPROVAL' as const, batchId: b.id, approval: r.approval, totalCents: total, submitted: 0, considered: rowsP.length };
    }
    const res = await this.submitPayouts({ batchId: b.id });
    await this.db.update(payoutBatches).set({ status: res.submitted || res.held ? 'SUBMITTED' : 'APPROVED', submittedAt: new Date() }).where(and(eq(payoutBatches.id, b.id), sql`${payoutBatches.status} <> 'DONE'`));
    return { status: 'SUBMITTED' as const, batchId: b.id, totalCents: total, ...res };
  }

  /** A draft batch created by the scheduler (over the limit) is sent for approval by a finance user. */
  async requestBatchRelease(user: JwtPayload, batchId: string, reason: string) {
    assertCan(user, 'finance.manage');
    const [b] = await this.db.select().from(payoutBatches).where(eq(payoutBatches.id, batchId)).limit(1);
    if (!b) throw new NotFoundException();
    if (b.status !== 'DRAFT') throw new BadRequestException(`Batch is ${b.status.toLowerCase()}`);
    const r = await this.approvals.submit(user, { kind: 'PAYOUT_RELEASE', summary: `Payout batch: ${b.payoutCount} payout(s), $${(b.totalCents / 100).toFixed(2)}`, subjectType: 'payout_batch', subjectId: b.id, amountCents: b.totalCents, payload: { batchId: b.id }, reason, dedupeKey: `payout-batch:${b.id}` });
    await this.db.update(payoutBatches).set({ status: 'PENDING_APPROVAL', approvalId: r.approval.id }).where(eq(payoutBatches.id, b.id));
    return r;
  }

  async batches(user: JwtPayload) {
    assertCan(user, 'finance.read');
    return this.db.select().from(payoutBatches).orderBy(desc(payoutBatches.createdAt)).limit(50);
  }

  async payoutList(user: JwtPayload, f: { status?: string; partyType?: string; batchId?: string }) {
    assertCan(user, 'finance.read');
    const rowsP = await this.db.select({ p: payouts, org: organizations.name }).from(payouts).leftJoin(organizations, eq(organizations.id, payouts.organizationId)).where(and(...(f.status ? [eq(payouts.status, f.status as never)] : []), ...(f.partyType ? [eq(payouts.partyType, f.partyType)] : []), ...(f.batchId ? [eq(payouts.batchId, f.batchId)] : []))).orderBy(desc(payouts.createdAt)).limit(200);
    return rowsP.map((x) => ({ ...x.p, organizationName: x.org }));
  }

  /** 19.6 reprocess a failed or held payout (after bank info is fixed); clears the attempt counter. */
  async reprocessPayout(user: JwtPayload, payoutId: string, reason: string) {
    assertCan(user, 'finance.manage');
    const [po] = await this.db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1);
    if (!po) throw new NotFoundException();
    if (!['FAILED', 'HELD'].includes(po.status)) throw new BadRequestException(`Payout is ${po.status.toLowerCase()}`);
    if (!po.batchId) throw new BadRequestException('Add the payout to a batch first');
    await this.db.update(payouts).set({ status: 'ELIGIBLE', attempts: 0, failureReason: null, submittedAt: null }).where(eq(payouts.id, payoutId));
    await this.db.update(payoutBatches).set({ status: 'SUBMITTED' }).where(and(eq(payoutBatches.id, po.batchId), eq(payoutBatches.status, 'DONE')));
    await this.audit.log({ actorId: user.sub, action: 'payout.reprocess', entityType: 'payout', entityId: payoutId, reason });
    const res = await this.submitPayouts({ batchId: po.batchId });
    const [after] = await this.db.select().from(payouts).where(eq(payouts.id, payoutId));
    return { payout: after, ...res };
  }

  /** 19.9 held payouts whose cooling-off has ended become eligible again (worker). */
  async releaseExpiredHolds() {
    const held = await this.db.select({ id: payouts.id, partyId: payouts.partyId }).from(payouts).where(and(eq(payouts.status, 'HELD'), sql`${payouts.failureReason} like 'Bank details changed%'`));
    let released = 0;
    for (const h of held) {
      const [s] = await this.db.select({ hold: legalSellers.payoutHoldUntil }).from(legalSellers).where(eq(legalSellers.organizationId, h.partyId)).limit(1);
      if (!s?.hold || s.hold <= new Date()) { await this.db.update(payouts).set({ status: 'ELIGIBLE', failureReason: null }).where(eq(payouts.id, h.id)); released++; }
    }
    return { released };
  }

  /** 19.5 processor transfer report: match transfers to payouts; status differences go to the unmatched queue. */
  async reconcileTransfers(user: JwtPayload, lines: { transferId: string; amountCents: number; status: 'paid' | 'failed' | 'pending'; failureReason?: string }[]) {
    assertCan(user, 'finance.manage');
    let matched = 0;
    const unmatched: string[] = [];
    for (const l of lines) {
      const [po] = await this.db.select().from(payouts).where(eq(payouts.providerTransferId, l.transferId)).limit(1);
      if (po && po.amountCents === l.amountCents) {
        if (l.status === 'paid' && po.status === 'SUBMITTED') await this.db.update(payouts).set({ status: 'PAID', paidAt: new Date() }).where(eq(payouts.id, po.id));
        if (l.status === 'failed' && ['SUBMITTED', 'PAID'].includes(po.status)) {
          // the money came back: re-open the payable so it is paid again
          await this.db.transaction(async (tx) => {
            await tx.update(payouts).set({ status: 'FAILED', failureReason: l.failureReason || 'Returned by the bank' }).where(eq(payouts.id, po.id));
            await this.ledger.post({ payoutId: po.id, currency: po.currency }, [{ account: 'BANK', debitCents: po.amountCents, memo: `Transfer ${l.transferId} returned` }, { account: po.partyType === 'MERCHANT' ? 'MERCHANT_PAYABLE' : 'DRIVER_PAYABLE', partyId: po.partyId, organizationId: po.organizationId, creditCents: po.amountCents, memo: `Payout ${po.id} returned` }], tx);
          });
        }
        matched++;
      } else {
        const [u] = await this.db.insert(unmatchedItems).values({ source: 'PROCESSOR', externalId: l.transferId, amountCents: l.amountCents, currency: loadConfig().DEFAULT_CURRENCY, description: po ? `Transfer amount mismatch: ours ${po.amountCents}` : 'Unknown transfer' }).returning();
        unmatched.push(u.id);
      }
    }
    await this.audit.log({ actorId: user.sub, action: 'finance.transfer_report', entityType: 'payout', entityId: 'batch', after: { lines: lines.length, matched } });
    return { matched, unmatched };
  }

  // ───── 19.7 adjustments & statement disputes ─────

  /** Manual ledger-posted adjustment for a merchant (+ credits them, − charges them), with a reason. */
  async adjustMerchant(user: JwtPayload, input: { organizationId: string; cents: number; reason: string; statementDisputeId?: string }) {
    assertCan(user, 'finance.manage');
    if (!input.cents) throw new BadRequestException('Amount cannot be zero');
    const amt = Math.abs(input.cents);
    const credit = input.cents > 0;
    return this.db.transaction(async (tx) => {
      const batch = await this.ledger.post({ currency: loadConfig().DEFAULT_CURRENCY }, credit
        ? [{ account: 'PLATFORM_ADJUSTMENTS', debitCents: amt, organizationId: input.organizationId, memo: `Adjustment: ${input.reason}` }, { account: 'MERCHANT_PAYABLE', partyId: input.organizationId, organizationId: input.organizationId, creditCents: amt, memo: `Adjustment: ${input.reason}` }]
        : [{ account: 'MERCHANT_PAYABLE', partyId: input.organizationId, organizationId: input.organizationId, debitCents: amt, memo: `Adjustment: ${input.reason}` }, { account: 'PLATFORM_ADJUSTMENTS', creditCents: amt, organizationId: input.organizationId, memo: `Adjustment: ${input.reason}` }], tx);
      await this.audit.log({ organizationId: input.organizationId, actorId: user.sub, action: 'finance.adjustment', entityType: 'organization', entityId: input.organizationId, after: { cents: input.cents, batch }, reason: input.reason }, tx);
      return { batchId: batch, cents: input.cents };
    });
  }

  async disputeStatement(user: JwtPayload, statementId: string, input: { reason: string; amountCents?: number }) {
    const [s] = await this.db.select().from(merchantStatements).where(eq(merchantStatements.id, statementId)).limit(1);
    if (!s) throw new NotFoundException();
    assertOrgAccess(user, s.organizationId);
    const [d] = await this.db.insert(statementDisputes).values({ statementId, organizationId: s.organizationId, raisedById: user.sub, reason: input.reason, amountCents: input.amountCents ?? null }).returning();
    return d;
  }

  async statementDisputesList(user: JwtPayload, orgId?: string) {
    if (orgId) assertOrgAccess(user, orgId); else assertCan(user, 'finance.read');
    return this.db.select({ d: statementDisputes, org: organizations.name, periodEnd: merchantStatements.periodEnd }).from(statementDisputes).innerJoin(organizations, eq(organizations.id, statementDisputes.organizationId)).innerJoin(merchantStatements, eq(merchantStatements.id, statementDisputes.statementId)).where(orgId ? eq(statementDisputes.organizationId, orgId) : sql`true`).orderBy(desc(statementDisputes.createdAt)).then((r) => r.map((x) => ({ ...x.d, organizationName: x.org, periodEnd: x.periodEnd })));
  }

  async resolveStatementDispute(user: JwtPayload, id: string, input: { accept: boolean; resolution: string; adjustmentCents?: number }) {
    assertCan(user, 'finance.manage');
    const [d] = await this.db.select().from(statementDisputes).where(eq(statementDisputes.id, id)).limit(1);
    if (!d) throw new NotFoundException();
    if (d.status !== 'OPEN') throw new BadRequestException('Already decided');
    if (input.accept && input.adjustmentCents) await this.adjustMerchant(user, { organizationId: d.organizationId, cents: input.adjustmentCents, reason: `Statement dispute: ${input.resolution}`, statementDisputeId: id });
    const [u] = await this.db.update(statementDisputes).set({ status: input.accept ? 'RESOLVED' : 'REJECTED', resolution: input.resolution, adjustmentCents: input.accept ? input.adjustmentCents ?? null : null, resolvedById: user.sub, resolvedAt: new Date() }).where(eq(statementDisputes.id, id)).returning();
    return u;
  }

  // ───── 19.1 / 19.2 / 19.3 / 19.8 ─────

  /** 19.1 ledger explorer. */
  async ledgerExplorer(user: JwtPayload, f: { account?: string; partyId?: string; organizationId?: string; orderId?: string; batchId?: string; from?: string; to?: string; limit?: number }) {
    assertCan(user, 'finance.read');
    const where = and(
      ...(f.account ? [eq(journalEntries.account, f.account as never)] : []), ...(f.partyId ? [eq(journalEntries.partyId, f.partyId)] : []), ...(f.organizationId ? [eq(journalEntries.organizationId, f.organizationId)] : []),
      ...(f.orderId ? [eq(journalEntries.orderId, f.orderId)] : []), ...(f.batchId ? [eq(journalEntries.batchId, f.batchId)] : []),
      ...(f.from ? [gte(journalEntries.createdAt, new Date(f.from))] : []), ...(f.to ? [lt(journalEntries.createdAt, new Date(f.to))] : []));
    const entries = await this.db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.createdAt)).limit(Math.min(f.limit || 200, 1000));
    const [tot] = await this.db.select({ debits: sql<number>`coalesce(sum(${journalEntries.debitCents}),0)::bigint`, credits: sql<number>`coalesce(sum(${journalEntries.creditCents}),0)::bigint`, n: sql<number>`count(*)::int` }).from(journalEntries).where(where);
    return { entries, totals: { debits: Number(tot.debits), credits: Number(tot.credits), count: tot.n } };
  }

  /** 19.2 a statement's ledger lines grouped into itemized categories (sales, tips, commission, refunds…). */
  async statementLines(user: JwtPayload, statementId: string) {
    const detail = await this.statementDetail(user, statementId);
    const groups = new Map<string, { category: string; creditsCents: number; debitsCents: number; count: number }>();
    for (const e of detail.entries) {
      const c = classifyMerchantEntry(e.memo);
      const g = groups.get(c) || { category: c, creditsCents: 0, debitsCents: 0, count: 0 };
      g.creditsCents += e.creditCents; g.debitsCents += e.debitCents; g.count++;
      groups.set(c, g);
    }
    const disputes = await this.db.select().from(statementDisputes).where(eq(statementDisputes.statementId, statementId));
    return { ...detail, lines: [...groups.values()].map((g) => ({ ...g, netCents: g.creditsCents - g.debitsCents })), disputes };
  }

  /** 19.8 liabilities vs revenue. */
  async liabilities(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const r = (await this.db.execute(sql`select account, coalesce(sum(credit_cents - debit_cents),0)::bigint as bal from journal_entries group by account`) as unknown as { rows: { account: string; bal: string }[] }).rows;
    const bal = (a: string) => Number(r.find((x) => x.account === a)?.bal || 0);
    const top = (await this.db.execute(sql`select j.party_id, o.name, sum(j.credit_cents - j.debit_cents)::bigint as bal from journal_entries j left join organizations o on o.id::text = j.party_id where j.account = 'MERCHANT_PAYABLE' group by 1, 2 having sum(j.credit_cents - j.debit_cents) <> 0 order by 3 desc limit 10`) as unknown as { rows: { party_id: string; name: string | null; bal: string }[] }).rows;
    const liab = ['MERCHANT_PAYABLE', 'DRIVER_PAYABLE', 'PROVIDER_PAYABLE', 'SUPPLIER_PAYABLE', 'TAX_PAYABLE', 'CUSTOMER_CREDIT_LIABILITY', 'GIFT_CARD_LIABILITY', 'DEPOSIT_LIABILITY', 'DEFERRED_REVENUE'].map((a) => ({ account: a, balanceCents: bal(a) }));
    const revenue = r.filter((x) => x.account.startsWith('PLATFORM_REVENUE')).map((x) => ({ account: x.account, balanceCents: Number(x.bal) }));
    return { liabilities: liab, totalLiabilitiesCents: liab.reduce((a, l) => a + l.balanceCents, 0), revenue, totalRevenueCents: revenue.reduce((a, l) => a + l.balanceCents, 0), cash: { bankCents: -bal('BANK'), processorClearingCents: -bal('PROCESSOR_CLEARING') }, topMerchants: top.map((t) => ({ organizationId: t.party_id, name: t.name, balanceCents: Number(t.bal) })) };
  }

  /** 19.3 brand royalty statements for a period, from the brand's royalty rules (6.3). */
  async royaltyStatements(user: JwtPayload, from: Date, to: Date) {
    assertCan(user, 'finance.read', 'merchants.read');
    const sales = (await this.db.execute(sql`select b.id, b.name, b.royalty_bps, b.royalty_rules, b.owner_name, o.channel, coalesce(sum(ol.line_total_cents),0)::bigint as sales, coalesce(sum(ol.quantity),0)::int as units
      from order_lines ol join orders o on o.id = ol.order_id join brands b on b.id = ol.brand_id
      where o.status in ('COMPLETED','COLLECTED') and o.created_at >= ${from.toISOString()} and o.created_at < ${to.toISOString()} and ol.status not in ('CREDITED','UNAVAILABLE')
      group by 1, 2, 3, 4, 5, 6`) as unknown as { rows: { id: string; name: string; royalty_bps: number; royalty_rules: RoyaltyRule[]; owner_name: string | null; channel: string; sales: string; units: number }[] }).rows;
    const by = new Map<string, { brandId: string; name: string; ownerName: string | null; rules: RoyaltyRule[]; bps: number; channels: { channel: string; salesCents: number; units: number }[] }>();
    for (const s of sales) { const b = by.get(s.id) || { brandId: s.id, name: s.name, ownerName: s.owner_name, rules: s.royalty_rules || [], bps: s.royalty_bps, channels: [] }; b.channels.push({ channel: s.channel, salesCents: Number(s.sales), units: s.units }); by.set(s.id, b); }
    return [...by.values()].map((b) => { const r = computeRoyalty(b.rules, b.bps, b.channels); return { brandId: b.brandId, name: b.name, ownerName: b.ownerName, salesCents: b.channels.reduce((a, c) => a + c.salesCents, 0), units: b.channels.reduce((a, c) => a + c.units, 0), channels: b.channels, royaltyCents: r.royaltyCents, lines: r.lines }; });
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
