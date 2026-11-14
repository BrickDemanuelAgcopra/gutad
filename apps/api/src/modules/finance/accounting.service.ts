import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { agingBucket, AGING_BUCKETS, CLOSE_CHECKLIST, DEFAULT_GL_MAP, PNL_LINES } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { auditLogs, budgets, closePeriods, customerCredits, disputes, glAccounts, invoices, journalEntries, kitchens, laborEntries, locations, payments, payouts, purchaseOrders, unmatchedItems } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { ApprovalsService } from '../security/approvals.service';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const n = (x: unknown) => (x == null ? 0 : Number(x));
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const monthRange = (period: string) => { const [y, m] = period.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) }; };

/** Phase H, section 20: accounting, treasury and financial control. */
@Injectable()
export class AccountingService {
  constructor(@Inject(DB) private readonly db: Db, private readonly ledger: LedgerService, private readonly audit: AuditService, private readonly approvals: ApprovalsService) {}

  // ───── 20.1 chart of accounts & journal export ─────

  async glMap(user: JwtPayload, legalEntity = 'GUTAD') {
    assertCan(user, 'finance.read');
    const custom = await this.db.select().from(glAccounts).where(eq(glAccounts.legalEntity, legalEntity));
    return Object.entries(DEFAULT_GL_MAP).map(([account, d]) => { const c = custom.find((x) => x.ledgerAccount === account); return { ledgerAccount: account, glCode: c?.glCode ?? d.code, glName: c?.glName ?? d.name, type: d.type, custom: !!c, legalEntity }; });
  }

  async setGl(user: JwtPayload, input: { legalEntity?: string; ledgerAccount: string; glCode: string; glName: string }) {
    assertCan(user, 'finance.manage');
    if (!DEFAULT_GL_MAP[input.ledgerAccount]) throw new BadRequestException('Unknown ledger account');
    const v = { legalEntity: input.legalEntity || 'GUTAD', ledgerAccount: input.ledgerAccount, glCode: input.glCode, glName: input.glName };
    const [r] = await this.db.insert(glAccounts).values(v).onConflictDoUpdate({ target: [glAccounts.legalEntity, glAccounts.ledgerAccount], set: { glCode: v.glCode, glName: v.glName } }).returning();
    await this.audit.log({ actorId: user.sub, action: 'finance.gl_map', entityType: 'gl_account', entityId: r.id, after: r });
    return r;
  }

  /** Journal export in a general-journal layout (date, journal no, account code/name, debit, credit, memo, class). */
  async journalExport(user: JwtPayload, from: Date, to: Date, legalEntity = 'GUTAD') {
    assertCan(user, 'finance.read');
    const map = new Map((await this.glMap(user, legalEntity)).map((g) => [g.ledgerAccount, g]));
    const entries = await this.db.select({ e: journalEntries, loc: locations.name }).from(journalEntries).leftJoin(locations, eq(locations.id, journalEntries.locationId)).where(and(gte(journalEntries.createdAt, from), lt(journalEntries.createdAt, to))).orderBy(journalEntries.createdAt, journalEntries.batchId);
    const head = ['Date', 'JournalNo', 'AccountCode', 'AccountName', 'Debit', 'Credit', 'Description', 'Class', 'Party', 'Order', 'Currency', 'LegalEntity'];
    const lines = entries.map(({ e, loc }) => { const g = map.get(e.account); return [e.createdAt.toISOString().slice(0, 10), e.batchId.slice(0, 8), g?.glCode ?? 'UNMAPPED', g?.glName ?? e.account, (e.debitCents / 100).toFixed(2), (e.creditCents / 100).toFixed(2), e.memo ?? '', loc ?? '', e.partyId ?? '', e.orderId ?? '', e.currency, legalEntity]; });
    await this.audit.log({ actorId: user.sub, action: 'finance.journal_export', entityType: 'journal', entityId: `${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`, after: { lines: lines.length } });
    return { csv: [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n'), lines: lines.length, unmapped: lines.filter((l) => l[2] === 'UNMAPPED').length };
  }

  // ───── 20.2 P&L ─────

  /** P&L by location, legal entity (seller), channel or brand. Brand splits order-level revenue by the brand's share of the order. */
  async pnl(user: JwtPayload, by: 'location' | 'entity' | 'channel' | 'brand' | 'total', from: Date, to: Date) {
    assertCan(user, 'finance.read');
    const accounts = PNL_LINES.flatMap((l) => l.accounts);
    const arr = `{${accounts.join(',')}}`;
    const key = by === 'location' ? sql`coalesce(l.name, '(platform)')` : by === 'entity' ? sql`coalesce(ls.legal_name, 'Gutad')` : by === 'channel' ? sql`coalesce(o.channel::text, '(no order)')` : sql`'total'`;
    let data: { key: string; account: string; net: number }[];
    if (by === 'brand') {
      data = rows<{ key: string; account: string; net: string }>(await this.db.execute(sql`with share as (select ol.order_id, coalesce(b.name, '(no brand)') as brand, sum(ol.line_total_cents)::numeric / nullif(sum(sum(ol.line_total_cents)) over (partition by ol.order_id), 0) as s from order_lines ol left join brands b on b.id = ol.brand_id group by 1, 2)
        select coalesce(sh.brand, '(no order)') as key, j.account::text as account, sum((j.credit_cents - j.debit_cents) * coalesce(sh.s, 1))::bigint as net
        from journal_entries j left join share sh on sh.order_id = j.order_id where j.account::text = any(${arr}::text[]) and j.created_at >= ${from.toISOString()} and j.created_at < ${to.toISOString()} group by 1, 2`)).map((x) => ({ key: x.key, account: x.account, net: n(x.net) }));
    } else {
      data = rows<{ key: string; account: string; net: string }>(await this.db.execute(sql`select ${key} as key, j.account::text as account, sum(j.credit_cents - j.debit_cents)::bigint as net
        from journal_entries j left join orders o on o.id = j.order_id left join locations l on l.id = coalesce(j.location_id, o.location_id) left join legal_sellers ls on ls.id = l.legal_seller_id
        where j.account::text = any(${arr}::text[]) and j.created_at >= ${from.toISOString()} and j.created_at < ${to.toISOString()} group by 1, 2`)).map((x) => ({ key: x.key, account: x.account, net: n(x.net) }));
    }
    const keys = [...new Set(data.map((d) => d.key))];
    const out = keys.map((k) => {
      const lines = PNL_LINES.map((l) => ({ key: l.key, label: l.label, cents: data.filter((d) => d.key === k && l.accounts.includes(d.account)).reduce((a, d) => a + d.net, 0) }));
      const revenue = lines.filter((l) => PNL_LINES.find((x) => x.key === l.key)!.sign === 1).reduce((a, l) => a + l.cents, 0);
      const costs = lines.filter((l) => PNL_LINES.find((x) => x.key === l.key)!.sign === -1).reduce((a, l) => a - l.cents, 0);
      return { key: k, lines, revenueCents: revenue, costsCents: costs, contributionCents: revenue - costs, marginPct: revenue ? Math.round(((revenue - costs) / revenue) * 1000) / 10 : null };
    }).sort((a, b) => b.revenueCents - a.revenueCents);
    return { by, from, to, rows: out };
  }

  // ───── 20.3 cost reporting ─────

  async costs(user: JwtPayload, from: Date, to: Date) {
    assertCan(user, 'finance.read');
    const acct = rows<{ account: string; net: string }>(await this.db.execute(sql`select account::text, sum(debit_cents - credit_cents)::bigint as net from journal_entries where account in ('PLATFORM_EXPENSE_COGS','PLATFORM_EXPENSE_DELIVERY_SUBSIDY','PLATFORM_EXPENSE_PROCESSING') and created_at >= ${from.toISOString()} and created_at < ${to.toISOString()} group by 1`));
    const a = (k: string) => n(acct.find((x) => x.account === k)?.net);
    const [labor] = await this.db.select({ cents: sql<number>`coalesce(sum(${laborEntries.hours} * ${laborEntries.rateCents}),0)::bigint` }).from(laborEntries).where(and(gte(laborEntries.date, from), lt(laborEntries.date, to)));
    const [proc] = await this.db.select({ fees: sql<number>`coalesce(sum(${payments.processingFeeCents}),0)::bigint`, captured: sql<number>`coalesce(sum(${payments.capturedCents}),0)::bigint` }).from(payments).where(and(gte(payments.createdAt, from), lt(payments.createdAt, to)));
    const byLoc = rows<{ name: string; cogs: string }>(await this.db.execute(sql`select coalesce(l.name,'(none)') as name, sum(j.debit_cents - j.credit_cents)::bigint as cogs from journal_entries j left join locations l on l.id = j.location_id where j.account = 'PLATFORM_EXPENSE_COGS' and j.created_at >= ${from.toISOString()} and j.created_at < ${to.toISOString()} group by 1 order by 2 desc`));
    return { foodCostCents: a('PLATFORM_EXPENSE_COGS'), laborCents: n(labor.cents), deliveryCents: a('PLATFORM_EXPENSE_DELIVERY_SUBSIDY'), processingCents: n(proc.fees), processingRatePct: n(proc.captured) ? Math.round((n(proc.fees) / n(proc.captured)) * 10000) / 100 : null, cogsByLocation: byLoc.map((x) => ({ location: x.name, cents: n(x.cogs) })) };
  }

  // ───── 20.4 credit liability & breakage ─────

  async creditLiability(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const now = new Date();
    const [open] = await this.db.select({ cents: sql<number>`coalesce(sum(${customerCredits.cents} - ${customerCredits.redeemedCents}),0)::bigint`, n: sql<number>`count(*)::int` }).from(customerCredits).where(and(sql`${customerCredits.cents} > ${customerCredits.redeemedCents}`, sql`(${customerCredits.expiresAt} is null or ${customerCredits.expiresAt} > ${now.toISOString()})`));
    const [soon] = await this.db.select({ cents: sql<number>`coalesce(sum(${customerCredits.cents} - ${customerCredits.redeemedCents}),0)::bigint` }).from(customerCredits).where(and(sql`${customerCredits.cents} > ${customerCredits.redeemedCents}`, sql`${customerCredits.expiresAt} between ${now.toISOString()} and ${new Date(now.getTime() + 30 * 86400_000).toISOString()}`));
    const ledgerBal = await this.ledger.accountTotals('CUSTOMER_CREDIT_LIABILITY');
    const breakage = await this.ledger.accountTotals('PLATFORM_REVENUE_BREAKAGE');
    const byFunder = rows<{ funder: string; cents: string }>(await this.db.execute(sql`select funder, coalesce(sum(cents - redeemed_cents),0)::bigint as cents from customer_credits where cents > redeemed_cents and (expires_at is null or expires_at > now()) group by 1`));
    return { outstandingCents: n(open.cents), credits: open.n, expiringIn30dCents: n(soon.cents), ledgerLiabilityCents: ledgerBal.credits - ledgerBal.debits, breakageToDateCents: breakage.credits - breakage.debits, byFunder: byFunder.map((x) => ({ funder: x.funder, cents: n(x.cents) })), giftCards: { note: 'Gift-card liability arrives with gift cards (Phase J, 25.9).' } };
  }

  // ───── 20.5 revenue recognition ─────

  /**
   * Straight-line recognition of membership and subscription revenue over the paid period. Returns what should be
   * deferred at `asOf`; `trueUp` posts the difference against the DEFERRED_REVENUE balance (idempotent).
   */
  async deferredSchedule(user: JwtPayload, asOf = new Date()) {
    assertCan(user, 'finance.read');
    const subs = rows<{ id: string; kind: string; org: string | null; total: string; refunded: string; start: string; end: string }>(await this.db.execute(sql`
      select i.id, 'SUBSCRIPTION' as kind, i.organization_id as org, i.total_cents as total, 0 as refunded, i.paid_at as start, i.paid_at + interval '1 month' as "end" from invoices i where i.kind = 'SUBSCRIPTION' and i.status = 'PAID' and i.paid_at is not null
      union all
      select p.id, 'MEMBERSHIP', null, p.captured_cents, p.refunded_cents, p.created_at, p.created_at + interval '1 month' from payments p where p.purpose = 'MEMBERSHIP' and p.captured_cents > 0`));
    const lines = subs.map((s) => {
      const start = new Date(s.start).getTime(), end = new Date(s.end).getTime(), now = asOf.getTime();
      const net = n(s.total) - n(s.refunded);
      const frac = now <= start ? 0 : now >= end ? 1 : (now - start) / (end - start);
      const recognized = Math.round(net * frac);
      return { id: s.id, kind: s.kind, organizationId: s.org, netCents: net, recognizedCents: recognized, deferredCents: net - recognized, periodStart: new Date(start), periodEnd: new Date(end) };
    }).filter((l) => l.deferredCents > 0 || l.periodEnd > asOf);
    const required = lines.reduce((a, l) => a + l.deferredCents, 0);
    const t = await this.ledger.accountTotals('DEFERRED_REVENUE');
    const booked = t.credits - t.debits;
    return { asOf, requiredDeferredCents: required, bookedDeferredCents: booked, trueUpCents: required - booked, byKind: ['SUBSCRIPTION', 'MEMBERSHIP'].map((k) => ({ kind: k, deferredCents: lines.filter((l) => l.kind === k).reduce((a, l) => a + l.deferredCents, 0) })), lines: lines.slice(0, 200) };
  }

  async trueUpDeferred(user: JwtPayload | null, asOf = new Date()) {
    if (user) assertCan(user, 'finance.manage');
    const s = await this.deferredSchedule(user ?? ({ roles: ['PLATFORM_ADMIN'], permissions: ['finance.read'] } as unknown as JwtPayload), asOf);
    if (!s.trueUpCents) return { postedCents: 0 };
    const sub = s.byKind.find((k) => k.kind === 'SUBSCRIPTION')!.deferredCents, mem = s.byKind.find((k) => k.kind === 'MEMBERSHIP')!.deferredCents;
    const share = sub + mem ? sub / (sub + mem) : 1;
    const amt = Math.abs(s.trueUpCents), subPart = Math.round(amt * share), memPart = amt - subPart;
    const defer = s.trueUpCents > 0;
    await this.ledger.post({ currency: 'USD' }, defer
      ? [{ account: 'PLATFORM_REVENUE_SUBSCRIPTION', debitCents: subPart, memo: 'Deferral true-up' }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', debitCents: memPart, memo: 'Deferral true-up' }, { account: 'DEFERRED_REVENUE', creditCents: amt, memo: `Deferred revenue as of ${asOf.toISOString().slice(0, 10)}` }]
      : [{ account: 'DEFERRED_REVENUE', debitCents: amt, memo: `Revenue recognized as of ${asOf.toISOString().slice(0, 10)}` }, { account: 'PLATFORM_REVENUE_SUBSCRIPTION', creditCents: subPart, memo: 'Recognition true-up' }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: memPart, memo: 'Recognition true-up' }]);
    if (user) await this.audit.log({ actorId: user.sub, action: 'finance.deferral_trueup', entityType: 'journal', entityId: asOf.toISOString().slice(0, 10), after: { cents: s.trueUpCents } });
    return { postedCents: s.trueUpCents };
  }

  // ───── 20.6 AR / AP ─────

  async receivablesAging(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const open = await this.db.select().from(invoices).where(inArray(invoices.status, ['OPEN', 'PAST_DUE'])).orderBy(invoices.dueAt);
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) as Record<string, number>;
    for (const i of open) buckets[agingBucket(i.dueAt)] += i.totalCents;
    return { totalCents: open.reduce((a, i) => a + i.totalCents, 0), buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, cents: buckets[b.key] })), invoices: open.map((i) => ({ id: i.id, number: i.number, organizationId: i.organizationId, kind: i.kind, totalCents: i.totalCents, dueAt: i.dueAt, bucket: agingBucket(i.dueAt) })) };
  }

  /** Supplier bills: received purchase orders (net 30 unless set), unpaid. */
  async payablesAging(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const bills = await this.db.select({ po: purchaseOrders, kitchen: kitchens.name }).from(purchaseOrders).innerJoin(kitchens, eq(kitchens.id, purchaseOrders.kitchenId)).where(and(eq(purchaseOrders.status, 'RECEIVED'), isNull(purchaseOrders.billPaidAt))).orderBy(purchaseOrders.receivedAt);
    const list = bills.map(({ po, kitchen }) => { const due = po.billDueAt ?? new Date((po.receivedAt ?? po.createdAt).getTime() + 30 * 86400_000); return { id: po.id, supplier: po.supplier, kitchen, totalCents: po.totalCents, receivedAt: po.receivedAt, dueAt: due, bucket: agingBucket(due) }; });
    return { totalCents: list.reduce((a, b) => a + b.totalCents, 0), buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, cents: list.filter((x) => x.bucket === b.key).reduce((a, x) => a + x.totalCents, 0) })), bills: list };
  }

  async payBill(user: JwtPayload, poId: string, reference: string) {
    assertCan(user, 'finance.manage');
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
    if (!po || po.status !== 'RECEIVED') throw new BadRequestException('Only received purchase orders can be paid');
    if (po.billPaidAt) throw new ConflictException('Already paid');
    await this.db.transaction(async (tx) => {
      await tx.update(purchaseOrders).set({ billPaidAt: new Date() }).where(eq(purchaseOrders.id, poId));
      await this.ledger.post({ currency: 'USD' }, [{ account: 'SUPPLIER_PAYABLE', partyId: po.supplier, debitCents: po.totalCents, memo: `Bill paid: ${po.supplier} (${reference})` }, { account: 'BANK', creditCents: po.totalCents, memo: `Supplier payment ${reference}` }], tx);
      await this.audit.log({ actorId: user.sub, action: 'finance.bill_paid', entityType: 'purchase_order', entityId: poId, reason: reference }, tx);
    });
    return { ok: true };
  }

  // ───── 20.7 treasury & close ─────

  /** 14-day cash forecast: expected processor settlements in, payouts / provider / supplier payments out. */
  async cashForecast(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const bank = await this.ledger.accountTotals('BANK');
    const clearing = await this.ledger.accountTotals('PROCESSOR_CLEARING');
    const [elig] = await this.db.select({ cents: sql<number>`coalesce(sum(${payouts.amountCents}),0)::bigint` }).from(payouts).where(inArray(payouts.status, ['ELIGIBLE', 'SUBMITTED', 'HELD', 'FAILED']));
    const provider = await this.ledger.accountTotals('PROVIDER_PAYABLE');
    const ap = await this.payablesAging(user);
    const ar = await this.receivablesAging(user);
    const inflow = clearing.debits - clearing.credits;
    const outflow = n(elig.cents) + (provider.credits - provider.debits) + ap.bills.filter((b) => b.dueAt.getTime() < Date.now() + 14 * 86400_000).reduce((a, b) => a + b.totalCents, 0);
    const opening = bank.debits - bank.credits;
    return { openingBankCents: opening, expectedInflowsCents: inflow + ar.invoices.filter((i) => i.dueAt.getTime() < Date.now() + 14 * 86400_000).reduce((a, i) => a + i.totalCents, 0), expectedOutflowsCents: outflow, projectedCents: opening + inflow - outflow, detail: { processorClearingCents: inflow, pendingPayoutsCents: n(elig.cents), providerPayableCents: provider.credits - provider.debits, supplierBillsDue14dCents: ap.bills.filter((b) => b.dueAt.getTime() < Date.now() + 14 * 86400_000).reduce((a, b) => a + b.totalCents, 0) } };
  }

  async bankReconciliation(user: JwtPayload) {
    assertCan(user, 'finance.read');
    const open = await this.db.select().from(journalEntries).where(and(eq(journalEntries.account, 'BANK'), isNull(journalEntries.reconciledAt))).orderBy(desc(journalEntries.createdAt)).limit(200);
    const unmatched = await this.db.select().from(unmatchedItems).where(and(eq(unmatchedItems.source, 'BANK'), isNull(unmatchedItems.resolvedAt)));
    const paidNotRec = await this.db.select().from(payouts).where(and(eq(payouts.status, 'PAID'), isNull(payouts.reconciledAt))).limit(200);
    return { unreconciledBankEntries: open, unmatchedBankLines: unmatched, paidPayoutsNotReconciled: paidNotRec };
  }

  private async autoChecks(period: string) {
    const { to } = monthRange(period);
    const unbalanced = await this.ledger.unbalancedBatches();
    const [um] = await this.db.select({ c: sql<number>`count(*)::int` }).from(unmatchedItems).where(and(isNull(unmatchedItems.resolvedAt), lt(unmatchedItems.createdAt, to)));
    const [pr] = await this.db.select({ c: sql<number>`count(*)::int` }).from(payouts).where(and(eq(payouts.status, 'PAID'), isNull(payouts.reconciledAt), lt(payouts.paidAt, to)));
    const [dp] = await this.db.select({ c: sql<number>`count(*)::int` }).from(disputes).where(and(eq(disputes.status, 'NEEDS_RESPONSE'), lt(disputes.evidenceDueAt, new Date())));
    const s = await this.deferredSchedule({ roles: ['PLATFORM_ADMIN'], permissions: ['finance.read'] } as unknown as JwtPayload, to < new Date() ? to : new Date());
    const [exp] = await this.db.select({ c: sql<number>`count(*)::int` }).from(customerCredits).where(and(lt(customerCredits.expiresAt, to < new Date() ? to : new Date()), sql`${customerCredits.redeemedCents} < ${customerCredits.cents}`));
    return { ledger_balanced: unbalanced.length === 0, unmatched_resolved: um.c === 0, payouts_reconciled: pr.c === 0, disputes_reviewed: dp.c === 0, deferral_trueup: s.trueUpCents === 0, breakage_posted: exp.c === 0 } as Record<string, boolean>;
  }

  async closeStatus(user: JwtPayload, period: string) {
    assertCan(user, 'finance.read');
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('Period is YYYY-MM');
    let [row] = await this.db.select().from(closePeriods).where(eq(closePeriods.period, period)).limit(1);
    if (!row) [row] = await this.db.insert(closePeriods).values({ period, checklist: CLOSE_CHECKLIST.map((c) => ({ key: c.key, label: c.label, done: false })) }).onConflictDoNothing().returning();
    if (!row) [row] = await this.db.select().from(closePeriods).where(eq(closePeriods.period, period)).limit(1);
    const auto = await this.autoChecks(period);
    const list = (row.checklist as { key: string; label: string; done: boolean; by?: string; at?: string }[]).map((c) => (c.key in auto ? { ...c, done: auto[c.key], auto: true } : { ...c, auto: false }));
    return { ...row, checklist: list, ready: list.every((c) => c.done) };
  }

  async tickClose(user: JwtPayload, period: string, key: string, done: boolean) {
    assertCan(user, 'finance.manage');
    const st = await this.closeStatus(user, period);
    if (st.status === 'CLOSED') throw new ConflictException('Period is closed');
    const item = st.checklist.find((c) => c.key === key);
    if (!item || item.auto) throw new BadRequestException('This step is checked automatically');
    const list = st.checklist.map((c) => (c.key === key ? { key: c.key, label: c.label, done, by: user.sub, at: new Date().toISOString() } : { key: c.key, label: c.label, done: c.done }));
    await this.db.update(closePeriods).set({ checklist: list }).where(eq(closePeriods.period, period));
    return this.closeStatus(user, period);
  }

  async closeMonth(user: JwtPayload, period: string) {
    assertCan(user, 'finance.manage');
    const st = await this.closeStatus(user, period);
    if (st.status === 'CLOSED') throw new ConflictException('Already closed');
    const open = st.checklist.filter((c) => !c.done);
    if (open.length) throw new ConflictException({ message: `Not ready to close: ${open.map((c) => c.label).join('; ')}`, code: 'CLOSE_NOT_READY', open: open.map((c) => c.key) });
    const [u] = await this.db.update(closePeriods).set({ status: 'CLOSED', closedById: user.sub, closedAt: new Date() }).where(eq(closePeriods.period, period)).returning();
    await this.audit.log({ actorId: user.sub, action: 'finance.month_close', entityType: 'close_period', entityId: period });
    return u;
  }

  // ───── 20.8 budgets, approval limits, audit export ─────

  async setBudget(user: JwtPayload, input: { costCenter: string; period: string; category: string; amountCents: number }) {
    assertCan(user, 'finance.manage');
    const [r] = await this.db.insert(budgets).values({ ...input, createdById: user.sub }).onConflictDoUpdate({ target: [budgets.costCenter, budgets.period, budgets.category], set: { amountCents: input.amountCents } }).returning();
    return r;
  }

  /** Budget vs actual per cost center (a location name or "platform") and category for a month. */
  async budgetVsActual(user: JwtPayload, period: string) {
    assertCan(user, 'finance.read');
    const { from, to } = monthRange(period);
    const plan = await this.db.select().from(budgets).where(eq(budgets.period, period));
    const cat = (a: string) => (a.startsWith('PLATFORM_REVENUE') ? 'REVENUE' : a === 'PLATFORM_EXPENSE_COGS' ? 'COGS' : a === 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY' ? 'DELIVERY' : a === 'PLATFORM_EXPENSE_PROCESSING' ? 'PROCESSING' : a === 'PLATFORM_EXPENSE_PROMOTION' ? 'PROMOTION' : a === 'PLATFORM_EXPENSE_REFUND' ? 'REFUNDS' : a.startsWith('PLATFORM_EXPENSE') || a === 'PLATFORM_ADJUSTMENTS' ? 'OTHER' : null);
    const act = rows<{ cc: string; account: string; net: string }>(await this.db.execute(sql`select coalesce(l.name, 'platform') as cc, j.account::text as account, sum(j.credit_cents - j.debit_cents)::bigint as net from journal_entries j left join orders o on o.id = j.order_id left join locations l on l.id = coalesce(j.location_id, o.location_id) where (j.account::text like 'PLATFORM_%') and j.created_at >= ${from.toISOString()} and j.created_at < ${to.toISOString()} group by 1, 2`));
    const labor = rows<{ cc: string; cents: string }>(await this.db.execute(sql`select coalesce(l.name, k.name) as cc, sum(le.hours * le.rate_cents)::bigint as cents from labor_entries le join kitchens k on k.id = le.kitchen_id left join locations l on l.kitchen_id = k.id where le.date >= ${from.toISOString()} and le.date < ${to.toISOString()} group by 1`));
    const actual = new Map<string, number>();
    for (const a of act) { const c = cat(a.account); if (!c) continue; const k = `${a.cc}|${c}`; actual.set(k, (actual.get(k) || 0) + (c === 'REVENUE' ? n(a.net) : -n(a.net))); }
    for (const l of labor) actual.set(`${l.cc}|LABOR`, (actual.get(`${l.cc}|LABOR`) || 0) + n(l.cents));
    const keys = new Set([...plan.map((p) => `${p.costCenter}|${p.category}`), ...actual.keys()]);
    return [...keys].map((k) => { const [costCenter, category] = k.split('|'); const b = plan.find((p) => p.costCenter === costCenter && p.category === category)?.amountCents ?? null; const a = actual.get(k) ?? 0; return { costCenter, category, budgetCents: b, actualCents: a, varianceCents: b == null ? null : a - b, variancePct: b ? Math.round(((a - b) / b) * 1000) / 10 : null }; }).sort((x, y) => x.costCenter.localeCompare(y.costCenter) || x.category.localeCompare(y.category));
  }

  async approvalLimits(user: JwtPayload) {
    assertCan(user, 'finance.read', 'security.read');
    return { thresholds: await this.approvals.thresholds() };
  }

  /** Financial audit export: ledger lines and finance-related audit entries for a period, as two CSV documents. */
  async auditExport(user: JwtPayload, from: Date, to: Date) {
    assertCan(user, 'finance.read');
    const j = await this.journalExport(user, from, to);
    const a = await this.db.select().from(auditLogs).where(and(gte(auditLogs.createdAt, from), lt(auditLogs.createdAt, to), sql`(${auditLogs.action} like 'finance.%' or ${auditLogs.action} like 'payout.%' or ${auditLogs.action} like 'payment.%' or ${auditLogs.action} like 'dispute.%' or ${auditLogs.action} like 'seller.%' or ${auditLogs.action} like 'approval.%' or ${auditLogs.action} like 'courier.bonus' or ${auditLogs.action} like 'courier.deduction')`)).orderBy(auditLogs.createdAt).limit(10000);
    const head = ['At', 'Actor', 'Action', 'Entity', 'EntityId', 'Reason', 'After'];
    const auditCsv = [head, ...a.map((x) => [x.createdAt.toISOString(), x.actorId ?? 'system', x.action, x.entityType, x.entityId, x.reason ?? '', JSON.stringify(x.after ?? {})])].map((r) => r.map(csvCell).join(',')).join('\n');
    return { journalCsv: j.csv, auditCsv, journalLines: j.lines, auditLines: a.length };
  }

  async postBreakageAs(user: JwtPayload) { assertCan(user, 'finance.manage'); const r = await this.postBreakage(); await this.audit.log({ actorId: user.sub, action: 'finance.breakage', entityType: 'journal', entityId: new Date().toISOString().slice(0, 10), after: r }); return r; }

  /** 20.4 breakage: expired, unredeemed credits leave the liability as breakage revenue. */
  async postBreakage(now = new Date()) {
    const exp = await this.db.select().from(customerCredits).where(and(isNotNull(customerCredits.expiresAt), lt(customerCredits.expiresAt, now), sql`${customerCredits.redeemedCents} < ${customerCredits.cents}`));
    let cents = 0;
    for (const c of exp) {
      const amt = c.cents - c.redeemedCents;
      await this.db.transaction(async (tx) => {
        await tx.update(customerCredits).set({ redeemedCents: c.cents }).where(eq(customerCredits.id, c.id));
        await this.ledger.post({ currency: 'USD' }, [{ account: 'CUSTOMER_CREDIT_LIABILITY', partyId: c.userId, debitCents: amt, memo: `Credit expired: ${c.reason}` }, { account: 'PLATFORM_REVENUE_BREAKAGE', creditCents: amt, memo: 'Credit breakage' }], tx);
      });
      cents += amt;
    }
    return { credits: exp.length, cents };
  }
}
