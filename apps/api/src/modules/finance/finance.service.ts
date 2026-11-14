import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { giftOutstanding, restoreGift } from '../growth/gift-tender';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DEFAULT_FINANCE_CONTROLS, DEFAULT_PAYMENT_METHODS, enabledMethods, type FinanceControls, type PaymentMethodsConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { disputes, inboxEvents, locations, orders, paymentFailures, payments, refunds, unmatchedItems, users } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { SettingsService } from '../../core/settings.service';
import { PaymentsService } from '../payments/payments.service';
import { SupportService } from '../support/support.service';

const n = (x: unknown) => (x == null ? 0 : Number(x));

/** Phase H, section 18: payments operations. */
@Injectable()
export class FinanceService {
  constructor(@Inject(DB) private readonly db: Db, private readonly payments: PaymentsService, private readonly ledger: LedgerService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly moduleRef: ModuleRef) {}

  controls() { return this.settings.getObject<FinanceControls>('finance.controls', DEFAULT_FINANCE_CONTROLS); }

  /** 18.2 payment methods enabled for a location's region and channel. */
  async methodsFor(locationId: string, channel?: string) {
    const [loc] = await this.db.select({ regionId: locations.regionId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    const cfg = await this.settings.getObject<PaymentMethodsConfig>('payments.methods', DEFAULT_PAYMENT_METHODS);
    return { methods: enabledMethods(cfg, channel, loc?.regionId), provider: this.payments.providerName };
  }

  /** 18.1 payments console. */
  async console(user: JwtPayload, f: { status?: string; purpose?: string; q?: string; from?: string; to?: string; disputed?: string }) {
    assertCan(user, 'finance.read', 'support.read');
    const list = await this.db.select({ p: payments, number: orders.number, email: users.email }).from(payments).leftJoin(orders, eq(orders.id, payments.orderId)).leftJoin(users, eq(users.id, payments.userId)).where(and(
      ...(f.status ? [eq(payments.status, f.status as never)] : []), ...(f.purpose ? [eq(payments.purpose, f.purpose)] : []), ...(f.disputed === 'true' ? [sql`${payments.disputeId} is not null`] : []),
      ...(f.from ? [gte(payments.createdAt, new Date(f.from))] : []), ...(f.to ? [lt(payments.createdAt, new Date(f.to))] : []),
      ...(f.q ? [sql`(${orders.number} ilike ${'%' + f.q + '%'} or ${payments.providerIntentId} ilike ${'%' + f.q + '%'} or ${payments.providerChargeId} ilike ${'%' + f.q + '%'} or ${payments.id}::text = ${f.q})`] : []))).orderBy(desc(payments.createdAt)).limit(200);
    const [sum] = await this.db.select({ authorized: sql<number>`coalesce(sum(${payments.authorizedCents}) filter (where ${payments.status} = 'AUTHORIZED'),0)::bigint`, captured: sql<number>`coalesce(sum(${payments.capturedCents}),0)::bigint`, refunded: sql<number>`coalesce(sum(${payments.refundedCents}),0)::bigint`, fees: sql<number>`coalesce(sum(${payments.processingFeeCents}),0)::bigint`, voided: sql<number>`count(*) filter (where ${payments.status} = 'VOIDED')::int` }).from(payments).where(gte(payments.createdAt, new Date(Date.now() - 30 * 86400_000)));
    const [fail] = await this.db.select({ n: sql<number>`count(*)::int` }).from(paymentFailures).where(gte(paymentFailures.createdAt, new Date(Date.now() - 30 * 86400_000)));
    // 18.9 never return secrets: client secrets and full payment-method ids are stripped
    return { summary30d: { authorizedOpenCents: n(sum.authorized), capturedCents: n(sum.captured), refundedCents: n(sum.refunded), feesCents: n(sum.fees), voided: sum.voided, failures: fail.n }, payments: list.map((x) => ({ ...x.p, clientSecret: undefined, paymentMethodId: x.p.paymentMethodId ? `…${x.p.paymentMethodId.slice(-4)}` : null, orderNumber: x.number, customerEmail: x.email })) };
  }

  async paymentDetail(user: JwtPayload, id: string) {
    assertCan(user, 'finance.read', 'support.read');
    const [p] = await this.db.select().from(payments).where(eq(payments.id, id)).limit(1);
    if (!p) throw new NotFoundException();
    const rf = await this.db.select().from(refunds).where(eq(refunds.paymentId, id)).orderBy(desc(refunds.createdAt));
    const [d] = await this.db.select().from(disputes).where(eq(disputes.paymentId, id)).limit(1);
    const journal = await this.db.execute(sql`select account, debit_cents, credit_cents, memo, created_at from journal_entries where payment_id = ${id} order by created_at`).then((r) => (r as unknown as { rows: unknown[] }).rows);
    return { payment: { ...p, clientSecret: undefined, paymentMethodId: p.paymentMethodId ? `…${p.paymentMethodId.slice(-4)}` : null }, refunds: rf, dispute: d ?? null, journal };
  }

  async failures(user: JwtPayload, days = 7) {
    assertCan(user, 'finance.read', 'support.read');
    const rowsF = await this.db.select({ f: paymentFailures, email: users.email, loc: locations.name }).from(paymentFailures).leftJoin(users, eq(users.id, paymentFailures.userId)).leftJoin(locations, eq(locations.id, paymentFailures.locationId)).where(gte(paymentFailures.createdAt, new Date(Date.now() - days * 86400_000))).orderBy(desc(paymentFailures.createdAt)).limit(200);
    const byReason = new Map<string, number>();
    for (const r of rowsF) byReason.set(r.f.reason, (byReason.get(r.f.reason) || 0) + 1);
    return { failures: rowsF.map((r) => ({ ...r.f, customerEmail: r.email, location: r.loc })), byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
  }

  async recordFailure(input: { purpose: string; paymentId?: string | null; orderId?: string | null; quoteId?: string | null; userId?: string | null; locationId?: string | null; amountCents: number; reason: string }) {
    await this.db.insert(paymentFailures).values({ ...input, provider: this.payments.providerName }).catch(() => undefined);
  }

  /** 18.4 retry a capture that did not go through (capped). */
  async retryCapture(user: JwtPayload, paymentId: string) {
    assertCan(user, 'finance.manage');
    const [p] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!p || !p.orderId) throw new NotFoundException();
    if (p.status !== 'AUTHORIZED') throw new ConflictException(`Payment is ${p.status.toLowerCase()}`);
    const [o] = await this.db.select({ status: orders.status }).from(orders).where(eq(orders.id, p.orderId)).limit(1);
    if (!o || ['SUBMITTED', 'REJECTED', 'CANCELED'].includes(o.status)) throw new ConflictException('Only accepted orders are captured');
    const cfg = await this.controls();
    if (p.retryCount >= cfg.maxCaptureRetries) throw new ConflictException({ message: `Retry limit (${cfg.maxCaptureRetries}) reached; contact the customer for another card`, code: 'RETRY_LIMIT' });
    await this.db.update(payments).set({ retryCount: p.retryCount + 1 }).where(eq(payments.id, p.id));
    await this.audit.log({ actorId: user.sub, action: 'payment.retry_capture', entityType: 'payment', entityId: p.id });
    try {
      const u = await this.db.transaction((tx) => this.payments.captureForOrder(p.orderId!, null, tx));
      return { ok: true, payment: { ...u, clientSecret: undefined } };
    } catch (e) {
      await this.db.update(payments).set({ lastFailureReason: (e as Error).message }).where(eq(payments.id, p.id));
      await this.recordFailure({ purpose: 'CAPTURE', paymentId: p.id, orderId: p.orderId, userId: p.userId, amountCents: p.authorizedCents, reason: (e as Error).message });
      return { ok: false, reason: (e as Error).message, retriesLeft: cfg.maxCaptureRetries - p.retryCount - 1 };
    }
  }

  /** 18.4 duplicate-charge report: same customer and amount within a few minutes on different orders. */
  async duplicates(user: JwtPayload, days = 30, windowMinutes = 5) {
    assertCan(user, 'finance.read', 'support.read');
    const r = await this.db.execute(sql`select a.id as a_id, b.id as b_id, a.user_id, a.amount_cents, a.created_at as a_at, b.created_at as b_at, oa.number as a_number, ob.number as b_number, a.status as a_status, b.status as b_status
      from payments a join payments b on a.user_id = b.user_id and a.amount_cents = b.amount_cents and a.id < b.id and b.created_at between a.created_at and a.created_at + make_interval(mins => ${windowMinutes})
      left join orders oa on oa.id = a.order_id left join orders ob on ob.id = b.order_id
      where a.user_id is not null and a.amount_cents > 0 and a.created_at > now() - make_interval(days => ${days}) and a.status not in ('VOIDED') and b.status not in ('VOIDED') limit 100`);
    return (r as unknown as { rows: Record<string, unknown>[] }).rows;
  }

  /**
   * 18.5 / 18.3-G partial refund allocated back to how the order was paid: the card share goes back to the card,
   * the credits share is restored as credits (same expiry rules) and the gift share goes back to the gift card(s)
   * it came from, in proportion to the original split. What one tender can't take moves to the next.
   */
  async refundAllocated(user: JwtPayload, paymentId: string, input: { amountCents: number; reason: string; funder: 'MERCHANT' | 'PLATFORM' }) {
    assertCan(user, 'finance.manage', 'support.manage');
    const [p] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!p) throw new NotFoundException();
    const [o] = p.orderId ? await this.db.select().from(orders).where(eq(orders.id, p.orderId)).limit(1) : [null];
    const split = (p.split as { cardCents?: number; creditsCents?: number; giftCents?: number } | null) || { cardCents: p.capturedCents, creditsCents: 0, giftCents: 0 };
    const card = split.cardCents ?? p.capturedCents, credits = split.creditsCents ?? 0, gift = split.giftCents ?? 0;
    const prior = await this.db.select({ a: refunds.allocation }).from(refunds).where(eq(refunds.paymentId, p.id));
    const creditsBack = prior.reduce((a, r) => a + ((r.a as { creditsCents?: number } | null)?.creditsCents || 0), 0);
    const cardLeft = p.capturedCents - p.refundedCents;
    const creditsLeft = Math.max(0, credits - creditsBack);
    const giftLeft = p.orderId && gift ? (await giftOutstanding(this.db, p.orderId)).total : 0;
    const max = cardLeft + creditsLeft + giftLeft;
    if (input.amountCents <= 0 || input.amountCents > max) throw new BadRequestException(`Refund must be between 1 and ${max} cents`);
    const whole = card + credits + gift;
    let toCredits = whole > 0 ? Math.min(Math.round((input.amountCents * credits) / whole), creditsLeft) : 0;
    let toGift = whole > 0 ? Math.min(Math.round((input.amountCents * gift) / whole), giftLeft) : 0;
    let toCard = input.amountCents - toCredits - toGift;
    if (toCard > cardLeft) {
      let over = toCard - cardLeft;
      toCard = cardLeft;
      const g = Math.min(over, giftLeft - toGift); toGift += g; over -= g;
      const c = Math.min(over, creditsLeft - toCredits); toCredits += c; over -= c;
    }
    return this.db.transaction(async (tx) => {
      let refundId: string | null = null;
      if (toCard > 0) refundId = (await this.payments.refund({ paymentId: p.id, amountCents: toCard, reason: input.reason, funder: input.funder, approvedById: user.sub }, tx)).id;
      if (toCredits > 0 && p.userId) await this.payments.issueCredit({ userId: p.userId, cents: toCredits, reason: `Refund to credits: ${input.reason}`, funder: input.funder, orderId: p.orderId, organizationId: o?.organizationId ?? null }, tx);
      if (toGift > 0 && p.orderId) await restoreGift(tx, this.ledger, { orderId: p.orderId, cents: toGift, kind: 'REFUND', actorId: user.sub, note: input.reason, funder: { account: input.funder === 'MERCHANT' ? 'MERCHANT_PAYABLE' : 'PLATFORM_EXPENSE_REFUND', organizationId: o?.organizationId ?? null }, currency: p.currency });
      const allocation = { cardCents: toCard, creditsCents: toCredits, giftCents: toGift };
      if (refundId) await tx.update(refunds).set({ allocation }).where(eq(refunds.id, refundId));
      else if (toCredits + toGift > 0) await tx.insert(refunds).values({ paymentId: p.id, orderId: p.orderId, amountCents: 0, reason: input.reason, funder: input.funder, status: 'SUCCEEDED', approvedById: user.sub, allocation });
      await this.audit.log({ actorId: user.sub, action: 'payment.refund_allocated', entityType: 'payment', entityId: p.id, after: allocation, reason: input.reason }, tx);
      return { toCardCents: toCard, toCreditsCents: toCredits, toGiftCents: toGift };
    });
  }

  /** 18.6 processor settlement file (CSV: charge_id,amount_cents,fee_cents). */
  async settlementFile(user: JwtPayload, csv: string, settlement: { reconcileProcessorLines: (u: JwtPayload, l: { providerChargeId: string; amountCents: number; feeCents: number }[]) => Promise<{ matched: number; unmatched: string[] }> }) {
    assertCan(user, 'finance.manage');
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^charge/i.test(l)).map((l) => { const [id, amt, fee] = l.split(',').map((x) => x.trim()); return { providerChargeId: id, amountCents: Number(amt), feeCents: Number(fee || 0) }; });
    const bad = lines.filter((l) => !l.providerChargeId || !Number.isFinite(l.amountCents));
    if (bad.length) throw new BadRequestException(`${bad.length} line(s) could not be read; expected charge_id,amount_cents,fee_cents`);
    const r = await settlement.reconcileProcessorLines(user, lines);
    await this.audit.log({ actorId: user.sub, action: 'finance.settlement_file', entityType: 'payment', entityId: 'file', after: { lines: lines.length, matched: r.matched } });
    return { lines: lines.length, ...r };
  }

  /** 18.6 unresolved payments: captured long ago but never settled, authorizations left open, unmatched processor lines. */
  async unresolved(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const old = new Date(Date.now() - 3 * 86400_000);
    const unsettled = await this.db.select({ id: payments.id, orderId: payments.orderId, capturedCents: payments.capturedCents, createdAt: payments.createdAt, providerChargeId: payments.providerChargeId }).from(payments).where(and(eq(payments.status, 'CAPTURED'), lt(payments.createdAt, old))).limit(200);
    const staleAuth = await this.db.select({ id: payments.id, orderId: payments.orderId, authorizedCents: payments.authorizedCents, createdAt: payments.createdAt }).from(payments).where(and(eq(payments.status, 'AUTHORIZED'), lt(payments.createdAt, new Date(Date.now() - 86400_000)))).limit(200);
    const unmatched = await this.db.select().from(unmatchedItems).where(and(isNull(unmatchedItems.resolvedAt), eq(unmatchedItems.source, 'PROCESSOR'))).orderBy(desc(unmatchedItems.createdAt));
    return { unsettled, staleAuthorizations: staleAuth, unmatched };
  }

  // ───── 18.7 disputes ─────

  async disputesList(user: JwtPayload, status?: string) {
    assertCan(user, 'finance.read', 'support.read');
    const list = await this.db.select({ d: disputes, number: orders.number }).from(disputes).leftJoin(orders, eq(orders.id, disputes.orderId)).where(status ? eq(disputes.status, status) : sql`true`).orderBy(disputes.evidenceDueAt);
    const now = Date.now();
    return list.map((x) => ({ ...x.d, orderNumber: x.number, overdue: !!x.d.evidenceDueAt && x.d.evidenceDueAt.getTime() < now && x.d.status === 'NEEDS_RESPONSE' }));
  }

  /** Build the evidence packet from the order timeline (staff only; proof access is audited) and record the submission. */
  async submitEvidence(user: JwtPayload, id: string, note?: string) {
    assertCan(user, 'finance.manage', 'support.manage');
    const [d] = await this.db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
    if (!d) throw new NotFoundException();
    if (d.status !== 'NEEDS_RESPONSE') throw new ConflictException(`Dispute is ${d.status.toLowerCase().replace('_', ' ')}`);
    const packet = await this.moduleRef.get(SupportService, { strict: false }).chargebackEvidence(user, d.paymentId);
    const [u] = await this.db.update(disputes).set({ status: 'UNDER_REVIEW', evidence: { ...packet.evidence, note: note ?? null }, evidenceSubmittedAt: new Date() }).where(eq(disputes.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'dispute.evidence', entityType: 'dispute', entityId: id, reason: note });
    return u;
  }

  /** Outcome: WON returns the funds; LOST/ACCEPTED books the loss to the platform or the merchant. */
  async disputeOutcome(user: JwtPayload, id: string, input: { outcome: 'WON' | 'LOST' | 'ACCEPTED'; liability?: 'PLATFORM' | 'MERCHANT'; note: string }) {
    assertCan(user, 'finance.manage');
    const [d] = await this.db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
    if (!d) throw new NotFoundException();
    if (['WON', 'LOST', 'ACCEPTED'].includes(d.status)) throw new ConflictException('Outcome already recorded');
    const liability = input.liability || d.liability;
    return this.db.transaction(async (tx) => {
      if (input.outcome === 'WON') {
        await this.ledger.post({ paymentId: d.paymentId, orderId: d.orderId, currency: d.currency }, [{ account: 'PROCESSOR_CLEARING', debitCents: d.amountCents, memo: 'Dispute won: funds returned' }, { account: 'DISPUTE_RECEIVABLE', creditCents: d.amountCents, memo: 'Dispute won' }], tx);
      } else {
        await this.ledger.post({ paymentId: d.paymentId, orderId: d.orderId, currency: d.currency }, [
          liability === 'MERCHANT' && d.organizationId
            ? { account: 'MERCHANT_PAYABLE', partyId: d.organizationId, organizationId: d.organizationId, debitCents: d.amountCents, memo: 'Chargeback lost (merchant liable)' }
            : { account: 'PLATFORM_EXPENSE_REFUND', debitCents: d.amountCents, organizationId: d.organizationId, memo: 'Chargeback lost' },
          { account: 'DISPUTE_RECEIVABLE', creditCents: d.amountCents, memo: `Dispute ${input.outcome.toLowerCase()}` },
        ], tx);
      }
      await tx.update(payments).set({ disputeStatus: input.outcome, status: input.outcome === 'WON' ? 'CAPTURED' : 'DISPUTED' }).where(eq(payments.id, d.paymentId));
      const [u] = await tx.update(disputes).set({ status: input.outcome, liability, outcomeAt: new Date(), outcomeNote: input.note }).where(eq(disputes.id, id)).returning();
      await this.audit.log({ organizationId: d.organizationId, actorId: user.sub, action: 'dispute.outcome', entityType: 'dispute', entityId: id, after: { outcome: input.outcome, liability }, reason: input.note }, tx);
      return u;
    });
  }

  // ───── 18.8 webhook monitor ─────

  async webhooks(user: JwtPayload, hours = 24) {
    assertCan(user, 'finance.read', 'integrations.manage');
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const stats = (await this.db.execute(sql`select provider, count(*)::int as received, count(*) filter (where error is not null and processed_at is null)::int as failed, count(*) filter (where processed_at is null and error is null)::int as pending,
      avg(extract(epoch from processed_at - created_at)) filter (where processed_at is not null) as lag_s, max(extract(epoch from processed_at - created_at)) filter (where processed_at is not null) as max_lag_s
      from inbox_events where created_at >= ${since} group by provider order by 2 desc`) as unknown as { rows: { provider: string; received: number; failed: number; pending: number; lag_s: number | null; max_lag_s: number | null }[] }).rows;
    const failed = await this.db.select().from(inboxEvents).where(and(sql`${inboxEvents.error} is not null`, isNull(inboxEvents.processedAt))).orderBy(desc(inboxEvents.receivedAt)).limit(100);
    return { hours, providers: stats.map((s) => ({ ...s, ratePerHour: Math.round((s.received / hours) * 10) / 10, avgLagSeconds: s.lag_s == null ? null : Math.round(Number(s.lag_s) * 10) / 10, maxLagSeconds: s.max_lag_s == null ? null : Math.round(Number(s.max_lag_s)) })), failed: failed.map((f) => ({ id: f.id, provider: f.provider, eventId: f.eventId, type: f.type, error: f.error, receivedAt: f.receivedAt })) };
  }

  /** Dry run shows what a replay would touch without changing anything; a real replay is audited. */
  async replay(user: JwtPayload, id: string, dryRun: boolean) {
    assertCan(user, 'finance.manage', 'integrations.manage');
    const [row] = await this.db.select().from(inboxEvents).where(eq(inboxEvents.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    const ev = row.payload as { type?: string; providerIntentId?: string; providerTransferId?: string };
    const [p] = ev.providerIntentId ? await this.db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.providerIntentId, ev.providerIntentId)).limit(1) : [null];
    const plan = { event: row.type, provider: row.provider, alreadyProcessed: !!row.processedAt, lastError: row.error, payment: p ?? null, transferId: ev.providerTransferId ?? null, wouldApply: !row.processedAt && (!!p || !!ev.providerTransferId || ev.type === 'account.updated') };
    if (dryRun) return { dryRun: true, ...plan };
    if (!row.provider.startsWith('delivery:')) await this.payments.replayInbox(id);
    else throw new BadRequestException('Replay delivery webhooks from the delivery console');
    await this.audit.log({ actorId: user.sub, action: 'webhook.replay', entityType: 'inbox_event', entityId: id, before: plan });
    return { dryRun: false, replayed: true, ...plan };
  }
}
