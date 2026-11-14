// Admin platform, phase H checks: payments operations, settlement controls, accounting.
export async function adminPhaseH({ call, check, A, O, C, locId, demoOrgId, API }) {
  console.log('\n── Admin platform H: payments, settlement, accounting');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const me = (await call('GET', '/auth/me', undefined, C)).json;
  const items = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const quote = (extra = {}, qty = 2) => call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: qty }], ...extra }, C);
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke H' }, A);

  // 18.2 enabled payment methods
  const pm = (await call('GET', `/public/locations/${locId}/payment-methods?channel=DIRECT`)).json;
  await set('payments.methods', { default: ['CARD', 'APPLE_PAY'], byChannel: {}, byRegion: {} });
  await call('POST', '/payments/credits', { userId: me.id, cents: 300, reason: 'Smoke H credit' }, A);
  const noCredits = await quote({ useCreditsCents: 300 });
  await set('payments.methods', { default: ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'CREDITS', 'LOYALTY', 'GIFT_CARD'], byChannel: { PHONE: ['CARD'], WALK_IN: ['CARD'] }, byRegion: {} });
  check('enabled payment methods are configurable and enforced at checkout', pm.methods.includes('CARD') && noCredits.status === 400 && noCredits.json.code === 'METHOD_DISABLED', { pm, noCredits: noCredits.json });

  // 18.1 failures are recorded even though the order rolls back
  const qd = (await quote()).json;
  await call('POST', '/orders', { quoteId: qd.id, paymentMethodId: 'mock_pm_0002' }, C, idem());
  const fails = (await call('GET', '/admin/payments/failures?days=1', undefined, A)).json;
  const cons = (await call('GET', '/admin/payments', undefined, A)).json;
  check('payments console with failures; no client secrets or raw method ids', fails.failures.some((f) => f.quoteId === qd.id && f.purpose === 'ORDER') && cons.payments.length > 0 && cons.payments.every((p) => p.clientSecret === undefined && (!p.paymentMethodId || p.paymentMethodId.startsWith('…'))) && cons.summary30d.capturedCents > 0, { fails: fails.failures.length });

  // 18.3 split + 18.5 refund allocated to card and credits
  const q = (await quote({ useCreditsCents: 300 })).json;
  const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
  await call('POST', `/orders/${o.id}/accept`, {}, O);
  const pay = (await call('GET', '/admin/payments?q=' + o.number, undefined, A)).json.payments[0];
  const det = (await call('GET', `/admin/payments/${pay.id}`, undefined, A)).json;
  const ref = (await call('POST', `/admin/payments/${pay.id}/refund`, { amountCents: 400, reason: 'Smoke H partial refund', funder: 'PLATFORM' }, A)).json;
  check('payment split recorded; partial refund allocated back to card and credits', det.payment.split?.creditsCents === 300 && det.payment.split.cardCents > 0 && ref.toCardCents + ref.toCreditsCents === 400 && ref.toCreditsCents > 0 && ref.toCardCents > 0, { split: det.payment.split, ref });

  // 18.4 retry & duplicates
  const retryBad = await call('POST', `/admin/payments/${pay.id}/retry-capture`, {}, A);
  const dups = await call('GET', '/admin/payments/duplicates?days=1', undefined, A);
  check('capture retry only for open authorizations; duplicate-charge report', retryBad.status === 409 && dups.status === 200 && Array.isArray(dups.json), { retry: retryBad.json });

  // 18.6 settlement file
  const file = (await call('POST', '/admin/payments/settlement-file', { csv: `charge_id,amount_cents,fee_cents\n${det.payment.providerChargeId},${det.payment.capturedCents},${det.payment.processingFeeCents || 30}\nch_unknown_${stamp},999,10` }, A)).json;
  const unres = (await call('GET', '/admin/payments/unresolved', undefined, A)).json;
  check('processor settlement file matches charges; unknown lines queue as unresolved', file.lines === 2 && file.matched === 1 && file.unmatched.length === 1 && unres.unmatched.some((u) => u.externalId === `ch_unknown_${stamp}`), file);

  // 18.7 dispute: webhook → table + ledger; evidence; lost (merchant liable)
  const pay2 = (await call('GET', `/admin/payments/${pay.id}`, undefined, A)).json.payment;
  const disputeEvt = `evt_dispute_${stamp}`;
  await fetch(`${API}/webhooks/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: disputeEvt, type: 'dispute.created', providerIntentId: pay2.providerIntentId, amountCents: 500, reason: 'fraudulent' }) });
  const dl = (await call('GET', '/admin/disputes', undefined, A)).json.find((d) => d.paymentId === pay.id);
  const ev = (await call('POST', `/admin/disputes/${dl?.id}/evidence`, { note: 'Pickup code verified at handoff' }, A)).json;
  const balBefore = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  const lost = (await call('POST', `/admin/disputes/${dl?.id}/outcome`, { outcome: 'LOST', liability: 'MERCHANT', note: 'Issuer sided with the cardholder' }, A)).json;
  const balAfter = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  check('disputes: deadline, evidence packet, outcome posted to the liable party', dl && dl.evidenceDueAt && ev.status === 'UNDER_REVIEW' && ev.evidence?.orderNumber && lost.status === 'LOST' && balBefore - balAfter === 500, { dl, balBefore, balAfter });

  // 18.8 webhook monitor & dry-run replay
  const wh = (await call('GET', '/admin/webhooks?hours=1', undefined, A)).json;
  const inboxId = (await call('GET', '/admin/webhooks?hours=1', undefined, A)).json; // monitor lists failures; replay a processed event as a dry run
  const anyEvt = wh.providers.find((p) => p.provider === 'mock');
  check('webhook monitor shows rate, failures and lag', anyEvt && anyEvt.received >= 1 && 'avgLagSeconds' in anyEvt && Array.isArray(inboxId.failed), wh.providers);

  // 19.4 payout batch over the release limit needs a second person; 19.9 cooling-off after the Phase A bank change holds it
  const finEmail = `finance-h-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: finEmail, password: 'staffpass12345', name: 'finance h' });
  await call('POST', '/admin/security/staff/roles', { email: finEmail, roles: ['FINANCE'], reason: 'Smoke H finance' }, A);
  const F = (await call('POST', '/auth/login', { email: finEmail, password: 'staffpass12345' })).json.accessToken;
  const limit = (await call('GET', '/accounting/approval-limits', undefined, A)).json.thresholds.payoutCents;
  await call('POST', '/finance/adjustments', { organizationId: demoOrgId, cents: limit + 100000, reason: 'Smoke H catering settlement' }, A);
  const close = (await call('POST', '/finance/close-period', { periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: new Date(Date.now() + 60000).toISOString(), organizationId: demoOrgId }, A)).json;
  const batch = (await call('POST', '/finance/payout-batches', { partyType: 'MERCHANT', reason: 'Weekly merchant payouts incl. catering' }, A)).json;
  const self = await call('POST', `/approvals/${batch.approval?.id}/approve`, { note: 'self' }, A);
  const approved = (await call('POST', `/approvals/${batch.approval?.id}/approve`, { note: 'Checked the statement' }, F)).json;
  const po = (await call('GET', `/finance/payouts?batchId=${batch.batchId}`, undefined, A)).json[0];
  check('payout batch above the limit waits for a second approver', close[0]?.payoutId && batch.status === 'PENDING_APPROVAL' && self.status === 403 && approved.status === 'EXECUTED', { batch: batch.status, self: self.status, approved: approved.status });
  check('bank-detail change cooling-off holds the payout', po?.status === 'HELD' && /Bank details changed/.test(po.failureReason || ''), po);

  // 19.5 transfer report: a returned transfer re-opens the payable; 19.6 reprocess respects the hold
  const paid = (await call('GET', '/finance/payouts?status=PAID&partyType=MERCHANT', undefined, A)).json.find((p) => p.providerTransferId);
  const pbBefore = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  const tr = (await call('POST', '/finance/reconcile/transfers', { lines: [{ transferId: paid.providerTransferId, amountCents: paid.amountCents, status: 'failed', failureReason: 'Account closed' }, { transferId: `tr_unknown_${stamp}`, amountCents: 100, status: 'paid' }] }, A)).json;
  const pbAfter = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  const rep = (await call('POST', `/finance/payouts/${paid.id}/reprocess`, { reason: 'Owner confirmed the new account' }, A)).json;
  check('returned transfer re-opens the payable and can be reprocessed (still held during cooling-off)', tr.matched === 1 && tr.unmatched.length === 1 && pbAfter - pbBefore === paid.amountCents && rep.payout.status === 'HELD', { tr, diff: pbAfter - pbBefore, rep: rep.payout?.status });

  // 16.7-P courier payouts through batches
  await call('POST', '/finance/close-driver-period', { periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: new Date(Date.now() + 60000).toISOString() }, A);
  const db = (await call('POST', '/finance/payout-batches', { partyType: 'DRIVER' }, A)).json;
  check('courier payouts are released in batches', db.status === 'SUBMITTED' && db.submitted >= 1, db);

  // 19.7 statement dispute → accepted with an adjustment; 19.2 itemized statement; 19.1 ledger explorer; 19.8 liabilities
  const stmts = (await call('GET', `/organizations/${demoOrgId}/statements`, undefined, O)).json;
  const sd = (await call('POST', `/statements/${stmts[0].id}/dispute`, { reason: 'Commission charged on a canceled order', amountCents: 250 }, O)).json;
  const res = (await call('POST', `/finance/statement-disputes/${sd.id}/resolve`, { accept: true, resolution: 'Commission reversed', adjustmentCents: 250 }, A)).json;
  const lines = (await call('GET', `/statements/${stmts[stmts.length - 1].id}/lines`, undefined, O)).json;
  const led = (await call('GET', `/finance/ledger?account=MERCHANT_PAYABLE&partyId=${demoOrgId}&limit=20`, undefined, A)).json;
  const liab = (await call('GET', '/finance/liabilities', undefined, A)).json;
  check('merchant statement disputes, itemized statements, ledger explorer, liabilities', sd.status === 'OPEN' && res.status === 'RESOLVED' && res.adjustmentCents === 250 && lines.lines.some((l) => l.category === 'SALES') && led.entries.length > 0 && led.totals.count > 0 && liab.liabilities.some((l) => l.account === 'MERCHANT_PAYABLE') && liab.totalRevenueCents > 0, { lines: lines.lines?.map((l) => l.category) });
  const roy = await call('GET', '/finance/royalties?from=2020-01-01', undefined, A);
  check('brand royalty statements from royalty rules', roy.status === 200 && Array.isArray(roy.json), roy.status);

  // 20.1 chart of accounts + journal export
  await call('POST', '/accounting/gl-map', { ledgerAccount: 'PLATFORM_REVENUE_COMMISSION', glCode: '4001', glName: 'Marketplace commission' }, A);
  const gl = (await call('GET', '/accounting/gl-map', undefined, A)).json;
  const jr = await fetch(`${API}/accounting/journal.csv?from=2020-01-01`, { headers: { Authorization: `Bearer ${A}` } });
  const csv = await jr.text();
  check('chart-of-accounts mapping and journal export', gl.find((g) => g.ledgerAccount === 'PLATFORM_REVENUE_COMMISSION')?.glCode === '4001' && csv.startsWith('Date,JournalNo,AccountCode') && csv.includes('4001,Marketplace commission') && !csv.includes('UNMAPPED'), csv.slice(0, 200));

  // 20.2 P&L, 20.3 costs (COGS from recipes at Gutad kitchens), 20.4 credit liability, 20.5 deferred revenue
  const pnlLoc = (await call('GET', '/accounting/pnl?by=location&from=2020-01-01', undefined, A)).json;
  const pnlBrand = (await call('GET', '/accounting/pnl?by=brand&from=2020-01-01', undefined, A)).json;
  const costs = (await call('GET', '/accounting/costs?from=2020-01-01', undefined, A)).json;
  const cl = (await call('GET', '/accounting/credit-liability', undefined, A)).json;
  const dr = (await call('GET', '/accounting/deferred-revenue', undefined, A)).json;
  const tu = await call('POST', '/accounting/deferred-revenue/true-up', {}, A);
  const dr2 = (await call('GET', '/accounting/deferred-revenue', undefined, A)).json;
  check('P&L by location and brand; cost report with recipe COGS', pnlLoc.rows.length > 0 && pnlLoc.rows.some((r) => r.lines.find((l) => l.key === 'commission').cents > 0) && pnlBrand.rows.length > 0 && costs.foodCostCents > 0 && costs.processingCents >= 0, { costs, loc: pnlLoc.rows.map((r) => r.key) });
  check('credit liability report and deferred-revenue true-up', cl.outstandingCents > 0 && cl.ledgerLiabilityCents > 0 && tu.status === 201 && dr2.trueUpCents === 0 && 'requiredDeferredCents' in dr, { cl, dr: dr.trueUpCents, dr2: dr2.trueUpCents });

  // 20.6 AP (supplier bill at a Gutad kitchen) and AR aging
  const org = (await call('GET', `/organizations/${demoOrgId}`, undefined, O)).json;
  const kitchenId = org.locations.find((l) => l.kitchenId)?.kitchenId;
  const stock = (await call('GET', `/kitchens/${kitchenId}/stock`, undefined, O)).json;
  const poRes = (await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: `Smoke Produce ${stamp}`, lines: [{ ingredientId: stock[0].ingredient.id, quantity: 10, unitCostCents: 120 }] }, O)).json;
  await call('POST', `/purchase-orders/${poRes.id}/receive`, { received: [] }, O);
  const ap = (await call('GET', '/accounting/payables', undefined, A)).json;
  const bill = ap.bills.find((b) => b.id === poRes.id);
  const paidBill = (await call('POST', `/accounting/payables/${poRes.id}/pay`, { reference: 'ACH-1' }, A)).json;
  const ar = (await call('GET', '/accounting/receivables', undefined, A)).json;
  check('supplier bills (payables) and receivables aging', bill && bill.totalCents === 1200 && paidBill.ok && Array.isArray(ar.buckets) && ar.buckets.length === 5, { bill });

  // 20.7 cash forecast, bank rec, close checklist; 20.8 budgets & audit export
  const cash = (await call('GET', '/accounting/cash-forecast', undefined, A)).json;
  const br = (await call('GET', '/accounting/bank-reconciliation', undefined, A)).json;
  const period = new Date().toISOString().slice(0, 7);
  const cs = (await call('GET', `/accounting/close/${period}`, undefined, A)).json;
  const autoTick = await call('POST', `/accounting/close/${period}/tick`, { key: 'ledger_balanced', done: true }, A);
  await call('POST', `/accounting/close/${period}/tick`, { key: 'journal_exported', done: true }, A);
  const early = await call('POST', `/accounting/close/${period}`, {}, A);
  check('cash forecast, bank reconciliation, month-end checklist blocks an early close', 'projectedCents' in cash && Array.isArray(br.unreconciledBankEntries) && cs.checklist.length === 8 && cs.checklist.find((c) => c.key === 'ledger_balanced').done === true && autoTick.status === 400 && early.status === 409 && early.json.code === 'CLOSE_NOT_READY', { early: early.json?.open });
  await call('POST', '/accounting/budgets', { costCenter: 'platform', period, category: 'REFUNDS', amountCents: 1000 }, A);
  const bva = (await call('GET', `/accounting/budgets/${period}`, undefined, A)).json;
  const ax = (await call('GET', '/accounting/audit-export?from=2020-01-01', undefined, A)).json;
  const integ = (await call('GET', '/finance/integrity', undefined, A)).json;
  check('budget vs actual, financial audit export, ledger still balanced', bva.some((b) => b.costCenter === 'platform' && b.category === 'REFUNDS' && b.budgetCents === 1000) && ax.auditCsv.includes('finance.adjustment') && ax.journalLines > 0 && integ.unbalancedBatches.length === 0, { bva: bva.slice(0, 3), unbalanced: integ.unbalancedBatches });
}
