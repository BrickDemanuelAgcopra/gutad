'use client';
import { useState } from 'react';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, Table, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

const monthAgo = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

export default function Accounting() {
  const [tab, setTab] = useState('pnl');
  return (
    <div className="space-y-4">
      <SectionTitle title="Accounting" hint="Proposed accounting capabilities built on the Gutad ledger; they make no claim about the general-ledger software Gutad uses." />
      <Tabs tabs={[{ id: 'pnl', label: 'P&L' }, { id: 'costs', label: 'Costs' }, { id: 'balances', label: 'Credits & deferred revenue' }, { id: 'arap', label: 'Receivables & payables' }, { id: 'cash', label: 'Cash & bank' }, { id: 'close', label: 'Month-end close' }, { id: 'budgets', label: 'Budgets' }, { id: 'coa', label: 'Chart of accounts & exports' }]} active={tab} onChange={setTab} />
      {tab === 'pnl' && <Pnl />}
      {tab === 'costs' && <Costs />}
      {tab === 'balances' && <Balances />}
      {tab === 'arap' && <ArAp />}
      {tab === 'cash' && <Cash />}
      {tab === 'close' && <Close />}
      {tab === 'budgets' && <Budgets />}
      {tab === 'coa' && <Coa />}
    </div>
  );
}

function Range({ v, set }: { v: { from: string; to: string }; set: (x: { from: string; to: string }) => void }) {
  return <><Input type="date" label="From" value={v.from} onChange={(e) => set({ ...v, from: e.target.value })} /><Input type="date" label="To" value={v.to} onChange={(e) => set({ ...v, to: e.target.value })} /></>;
}

function Pnl() {
  const [by, setBy] = useState('location');
  const [r, setR] = useState({ from: monthAgo(), to: today() });
  const { data } = useApi<{ rows: { key: string; lines: { key: string; label: string; cents: number }[]; revenueCents: number; costsCents: number; contributionCents: number; marginPct: number | null }[] }>(`/accounting/pnl?by=${by}&from=${r.from}&to=${r.to}T23:59:59Z`, { deps: [by, r.from, r.to] });
  const labels = data?.rows[0]?.lines.map((l) => ({ key: l.key, label: l.label })) || [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2"><Select label="By" value={by} onChange={(e) => setBy(e.target.value)}><option value="total">Total</option><option value="location">Location</option><option value="entity">Legal entity</option><option value="channel">Channel</option><option value="brand">Brand</option></Select><Range v={r} set={setR} /></div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th className="py-1">{by}</th>{labels.map((l) => <th key={l.key} className="text-right">{l.label}</th>)}<th className="text-right">Revenue</th><th className="text-right">Costs</th><th className="text-right">Contribution</th><th className="text-right">Margin</th></tr></thead>
        <tbody>{data?.rows.map((row) => <tr key={row.key} className="border-t border-ink-100"><td className="py-1 font-medium">{row.key}</td>{row.lines.map((l) => <td key={l.key} className="text-right">{l.cents ? money(l.cents) : '—'}</td>)}<td className="text-right">{money(row.revenueCents)}</td><td className="text-right">{money(row.costsCents)}</td><td className={`text-right font-semibold ${row.contributionCents < 0 ? 'text-red-700' : ''}`}>{money(row.contributionCents)}</td><td className="text-right">{row.marginPct == null ? '—' : `${row.marginPct}%`}</td></tr>)}</tbody></table></div>
      {by === 'brand' && <p className="text-xs text-ink-500">Order-level revenue and costs are split across brands by each brand’s share of the order’s food total.</p>}
    </div>
  );
}

function Costs() {
  const [r, setR] = useState({ from: monthAgo(), to: today() });
  const { data } = useApi<{ foodCostCents: number; laborCents: number; deliveryCents: number; processingCents: number; processingRatePct: number | null; cogsByLocation: { location: string; cents: number }[] }>(`/accounting/costs?from=${r.from}&to=${r.to}T23:59:59Z`, { deps: [r.from, r.to] });
  return (
    <div className="space-y-3">
      <div className="flex gap-2"><Range v={r} set={setR} /></div>
      {data && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Food (COGS from recipes)" value={money(data.foodCostCents)} /><Stat label="Labor" value={money(data.laborCents)} /><Stat label="Delivery" value={money(data.deliveryCents)} /><Stat label="Processing" value={money(data.processingCents)} hint={data.processingRatePct == null ? undefined : `${data.processingRatePct}% of captured`} /></div>}
      <Card title="Food cost by location (Gutad-operated kitchens)"><Table rows={data?.cogsByLocation || []} empty="No COGS posted yet." cols={[{ key: 'l', label: 'Location', render: (x) => x.location }, { key: 'c', label: 'COGS', render: (x) => money(x.cents) }]} /></Card>
    </div>
  );
}

function Balances() {
  const { can } = useSession();
  const { run, error } = useAction();
  const { data: cl, reload: rc } = useApi<{ outstandingCents: number; credits: number; expiringIn30dCents: number; ledgerLiabilityCents: number; breakageToDateCents: number; byFunder: { funder: string; cents: number }[]; giftCards: { outstandingCents: number; cards: number; ledgerLiabilityCents: number; redeemedLast30dCents: number; unclaimedCents: number } }>('/accounting/credit-liability');
  const { data: dr, reload: rd } = useApi<{ requiredDeferredCents: number; bookedDeferredCents: number; trueUpCents: number; byKind: { kind: string; deferredCents: number }[]; lines: { id: string; kind: string; netCents: number; recognizedCents: number; deferredCents: number; periodEnd: string }[] }>('/accounting/deferred-revenue');
  const [ok, setOk] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <Card title="Customer credit liability">
        {cl && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Outstanding" value={money(cl.outstandingCents)} hint={`${cl.credits} credits`} /><Stat label="Expiring in 30 days" value={money(cl.expiringIn30dCents)} /><Stat label="Ledger liability" value={money(cl.ledgerLiabilityCents)} /><Stat label="Breakage to date" value={money(cl.breakageToDateCents)} /></div>}
        <p className="mt-2 text-xs text-ink-500">{cl?.byFunder.map((f) => `${f.funder.toLowerCase()}-funded ${money(f.cents)}`).join(' · ')}</p>
        {can('finance.manage') && <Button className="mt-2" size="sm" variant="secondary" onClick={() => run(async () => { const r = await api.post<{ credits: number; cents: number }>('/accounting/breakage', {}); setOk(`Breakage posted: ${r.credits} expired credits, ${money(r.cents)}.`); await rc(); })}>Post expired credits as breakage</Button>}
      </Card>
      <Card title="Gift-card liability">
        {cl && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Outstanding balances" value={money(cl.giftCards.outstandingCents)} hint={`${cl.giftCards.cards} cards`} /><Stat label="Ledger liability" value={money(cl.giftCards.ledgerLiabilityCents)} hint={cl.giftCards.ledgerLiabilityCents === cl.giftCards.outstandingCents ? 'matches balances' : 'difference = spent on orders not yet accepted'} /><Stat label="Not yet in a wallet" value={money(cl.giftCards.unclaimedCents)} /><Stat label="Spent in 30 days" value={money(cl.giftCards.redeemedLast30dCents)} /></div>}
        <p className="mt-2 text-xs text-ink-500">Gift cards don’t expire unless issued with an end date; the balance stays a liability until it is spent. Look up and manage cards in Growth → Gift cards.</p>
      </Card>
      <Card title="Deferred revenue (subscriptions & memberships, straight-line)">
        {dr && <div className="grid gap-3 sm:grid-cols-3"><Stat label="Should be deferred" value={money(dr.requiredDeferredCents)} /><Stat label="Booked in the ledger" value={money(dr.bookedDeferredCents)} /><Stat label="True-up needed" value={money(dr.trueUpCents)} /></div>}
        {can('finance.manage') && !!dr?.trueUpCents && <Button className="mt-2" size="sm" onClick={() => run(async () => { const r = await api.post<{ postedCents: number }>('/accounting/deferred-revenue/true-up', {}); setOk(`True-up posted: ${money(r.postedCents)}.`); await rd(); })}>Post true-up</Button>}
        <Table rows={dr?.lines.slice(0, 50) || []} empty="Nothing deferred." cols={[{ key: 'k', label: 'Kind', render: (l) => l.kind.toLowerCase() }, { key: 'n', label: 'Net paid', render: (l) => money(l.netCents) }, { key: 'r', label: 'Recognized', render: (l) => money(l.recognizedCents) }, { key: 'd', label: 'Deferred', render: (l) => money(l.deferredCents) }, { key: 'e', label: 'Period ends', render: (l) => when(l.periodEnd) }]} />
      </Card>
    </div>
  );
}

function Aging({ title, data }: { title: string; data?: { totalCents: number; buckets: { key: string; label: string; cents: number }[] } | null }) {
  return <Card title={`${title} · ${money(data?.totalCents || 0)}`}><div className="grid grid-cols-5 gap-2 text-sm">{data?.buckets.map((b) => <div key={b.key} className="rounded-lg border border-ink-100 p-2"><div className="text-xs text-ink-500">{b.label}</div><div className="font-semibold">{money(b.cents)}</div></div>)}</div></Card>;
}

function ArAp() {
  const { can } = useSession();
  const { run, error } = useAction();
  const { data: ar } = useApi<{ totalCents: number; buckets: { key: string; label: string; cents: number }[]; invoices: { id: string; number: string; kind: string; totalCents: number; dueAt: string; bucket: string }[] }>('/accounting/receivables');
  const { data: ap, reload } = useApi<{ totalCents: number; buckets: { key: string; label: string; cents: number }[]; bills: { id: string; supplier: string; kitchen: string; totalCents: number; dueAt: string; bucket: string }[] }>('/accounting/payables');
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Aging title="Receivables (corporate & merchant invoices)" data={ar} />
      <Table rows={ar?.invoices || []} empty="No open invoices." cols={[{ key: 'n', label: 'Invoice', render: (i) => i.number }, { key: 'k', label: 'Kind', render: (i) => i.kind.toLowerCase() }, { key: 't', label: 'Total', render: (i) => money(i.totalCents) }, { key: 'd', label: 'Due', render: (i) => when(i.dueAt) }, { key: 'b', label: 'Age', render: (i) => <Badge tone={i.bucket === 'current' ? 'neutral' : 'warn'}>{i.bucket}</Badge> }]} />
      <Aging title="Payables (supplier bills)" data={ap} />
      <Table rows={ap?.bills || []} empty="No unpaid bills." cols={[{ key: 's', label: 'Supplier', render: (b) => <span>{b.supplier}<span className="block text-xs text-ink-500">{b.kitchen}</span></span> }, { key: 't', label: 'Total', render: (b) => money(b.totalCents) }, { key: 'd', label: 'Due', render: (b) => when(b.dueAt) }, { key: 'b', label: 'Age', render: (b) => <Badge tone={b.bucket === 'current' ? 'neutral' : 'warn'}>{b.bucket}</Badge> }, { key: 'x', label: '', render: (b) => can('finance.manage') && <Button size="sm" variant="secondary" onClick={() => { const ref = window.prompt('Payment reference (ACH / check no.)'); if (ref) run(async () => { await api.post(`/accounting/payables/${b.id}/pay`, { reference: ref }); await reload(); }); }}>Mark paid</Button> }]} />
    </div>
  );
}

function Cash() {
  const { data: cf } = useApi<{ openingBankCents: number; expectedInflowsCents: number; expectedOutflowsCents: number; projectedCents: number; detail: Record<string, number> }>('/accounting/cash-forecast');
  const { data: br } = useApi<{ unreconciledBankEntries: { id: string; debitCents: number; creditCents: number; memo: string | null; createdAt: string }[]; unmatchedBankLines: { id: string; externalId: string; amountCents: number }[]; paidPayoutsNotReconciled: { id: string; amountCents: number; paidAt: string | null }[] }>('/accounting/bank-reconciliation');
  return (
    <div className="space-y-4">
      {cf && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Bank (ledger)" value={money(cf.openingBankCents)} /><Stat label="Expected in (14 days)" value={money(cf.expectedInflowsCents)} /><Stat label="Expected out (14 days)" value={money(cf.expectedOutflowsCents)} /><Stat label="Projected" value={money(cf.projectedCents)} /></div>}
      {cf && <p className="text-xs text-ink-500">{Object.entries(cf.detail).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(' cents', '')}: ${money(v)}`).join(' · ')}</p>}
      <Card title="Bank reconciliation">
        <p className="text-sm">Unreconciled bank entries: {br?.unreconciledBankEntries.length ?? 0} · unmatched bank lines: {br?.unmatchedBankLines.length ?? 0} · paid payouts not yet seen on the bank statement: {br?.paidPayoutsNotReconciled.length ?? 0}</p>
        <Table rows={br?.unreconciledBankEntries.slice(0, 30) || []} empty="All bank entries reconciled." cols={[{ key: 'd', label: 'When', render: (e) => <span className="text-xs">{when(e.createdAt)}</span> }, { key: 'a', label: 'Amount', render: (e) => (e.creditCents ? `−${money(e.creditCents)}` : `+${money(e.debitCents)}`) }, { key: 'm', label: 'Memo', render: (e) => <span className="text-xs">{e.memo}</span> }]} />
        <p className="mt-1 text-xs text-ink-500">Match bank lines under Settlement → Reconcile.</p>
      </Card>
    </div>
  );
}

function Close() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const { can } = useSession();
  const { run, error } = useAction();
  const { data, reload } = useApi<{ status: string; closedAt: string | null; ready: boolean; checklist: { key: string; label: string; done: boolean; auto: boolean }[] }>(`/accounting/close/${period}`, { deps: [period] });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex items-end gap-2"><Input label="Month (YYYY-MM)" value={period} onChange={(e) => setPeriod(e.target.value)} />{data && <Badge tone={data.status === 'CLOSED' ? 'good' : data.ready ? 'info' : 'warn'}>{data.status === 'CLOSED' ? `closed ${when(data.closedAt)}` : data.ready ? 'ready to close' : 'open'}</Badge>}</div>
      <Card title="Checklist">
        {data?.checklist.map((c) => <label key={c.key} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={c.done} disabled={c.auto || data.status === 'CLOSED' || !can('finance.manage')} onChange={(e) => run(async () => { await api.post(`/accounting/close/${period}/tick`, { key: c.key, done: e.target.checked }); await reload(); })} />{c.label}{c.auto && <span className="text-xs text-ink-500">(checked automatically)</span>}</label>)}
        {can('finance.manage') && data?.status !== 'CLOSED' && <Button className="mt-2" disabled={!data?.ready} onClick={() => run(async () => { await api.post(`/accounting/close/${period}`, {}); await reload(); })}>Close {period}</Button>}
      </Card>
    </div>
  );
}

function Budgets() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const { can } = useSession();
  const { run, error } = useAction();
  const { data, reload } = useApi<{ costCenter: string; category: string; budgetCents: number | null; actualCents: number; varianceCents: number | null; variancePct: number | null }[]>(`/accounting/budgets/${period}`, { deps: [period] });
  const { data: lim } = useApi<{ thresholds: Record<string, unknown> }>('/accounting/approval-limits');
  const [f, setF] = useState({ costCenter: 'platform', category: 'REFUNDS', amount: '' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Input label="Month (YYYY-MM)" value={period} onChange={(e) => setPeriod(e.target.value)} />
      <Table rows={data || []} empty="No budgets or activity." cols={[{ key: 'c', label: 'Cost center', render: (b) => b.costCenter }, { key: 'k', label: 'Category', render: (b) => b.category.toLowerCase() }, { key: 'b', label: 'Budget', render: (b) => (b.budgetCents == null ? '—' : money(b.budgetCents)) }, { key: 'a', label: 'Actual', render: (b) => money(b.actualCents) }, { key: 'v', label: 'Variance', render: (b) => (b.varianceCents == null ? '—' : <span className={b.varianceCents > 0 && b.category !== 'REVENUE' ? 'text-red-700' : ''}>{money(b.varianceCents)}{b.variancePct != null ? ` (${b.variancePct}%)` : ''}</span>) }]} />
      {can('finance.manage') && <div className="flex flex-wrap items-end gap-2"><Input label="Cost center (location name or platform)" value={f.costCenter} onChange={(e) => setF({ ...f, costCenter: e.target.value })} /><Select label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['REVENUE', 'COGS', 'LABOR', 'DELIVERY', 'PROCESSING', 'PROMOTION', 'REFUNDS', 'OTHER'].map((c) => <option key={c}>{c}</option>)}</Select><Input label="Budget $" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /><Button onClick={() => run(async () => { await api.post('/accounting/budgets', { costCenter: f.costCenter, period, category: f.category, amountCents: Math.round(Number(f.amount) * 100) }); await reload(); })}>Set budget</Button></div>}
      <Card title="Approval limits in force"><pre className="text-xs">{JSON.stringify(lim?.thresholds, null, 2)}</pre><p className="text-xs text-ink-500">Change limits in Settings (needs a second approver).</p></Card>
    </div>
  );
}

function Coa() {
  const { can } = useSession();
  const { run, error } = useAction();
  const { data, reload } = useApi<{ ledgerAccount: string; glCode: string; glName: string; type: string; custom: boolean }[]>('/accounting/gl-map');
  const [r, setR] = useState({ from: monthAgo(), to: today() });
  const [edit, setEdit] = useState<Record<string, { glCode: string; glName: string }>>({});
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Card title="Exports">
        <div className="flex flex-wrap items-end gap-2"><Range v={r} set={setR} /><Button onClick={() => run(() => downloadFile(`/accounting/journal.csv?from=${r.from}&to=${r.to}T23:59:59Z`, `gutad-journal-${r.from}-${r.to}.csv`))}>Journal (CSV)</Button><Button variant="secondary" onClick={() => run(async () => { const x = await api.get<{ journalCsv: string; auditCsv: string }>(`/accounting/audit-export?from=${r.from}&to=${r.to}T23:59:59Z`); for (const [name, body] of [['journal', x.journalCsv], ['audit', x.auditCsv]] as const) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' })); a.download = `gutad-${name}-${r.from}-${r.to}.csv`; a.click(); } })}>Financial audit export</Button></div>
        <p className="mt-1 text-xs text-ink-500">General-journal layout (date, journal no., account code/name, debit, credit, description, class). Import it into the general ledger; there is no live push.</p>
      </Card>
      <Table rows={data || []} cols={[
        { key: 'a', label: 'Ledger account', render: (g) => <span className="text-xs">{g.ledgerAccount}</span> }, { key: 't', label: 'Type', render: (g) => g.type.toLowerCase() },
        { key: 'c', label: 'GL code', render: (g) => can('finance.manage') ? <Input className="w-24" value={edit[g.ledgerAccount]?.glCode ?? g.glCode} onChange={(e) => setEdit({ ...edit, [g.ledgerAccount]: { glCode: e.target.value, glName: edit[g.ledgerAccount]?.glName ?? g.glName } })} /> : g.glCode },
        { key: 'n', label: 'GL name', render: (g) => can('finance.manage') ? <Input value={edit[g.ledgerAccount]?.glName ?? g.glName} onChange={(e) => setEdit({ ...edit, [g.ledgerAccount]: { glName: e.target.value, glCode: edit[g.ledgerAccount]?.glCode ?? g.glCode } })} /> : g.glName },
        { key: 'x', label: '', render: (g) => edit[g.ledgerAccount] ? <Button size="sm" onClick={() => run(async () => { await api.post('/accounting/gl-map', { ledgerAccount: g.ledgerAccount, ...edit[g.ledgerAccount] }); const n = { ...edit }; delete n[g.ledgerAccount]; setEdit(n); await reload(); })}>Save</Button> : g.custom ? <Badge tone="info">custom</Badge> : null },
      ]} />
    </div>
  );
}
