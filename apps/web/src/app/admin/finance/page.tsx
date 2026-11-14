'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, statusTone, Table, Tabs, Textarea } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface Payout { id: string; organizationName: string | null; partyType: string; partyId: string; status: string; amountCents: number; periodEnd: string; failureReason: string | null; batchId: string | null; providerTransferId: string | null; attempts: number }
interface Batch { id: string; status: string; partyType: string | null; payoutCount: number; totalCents: number; approvalId: string | null; createdAt: string; note: string | null }

export default function AdminFinance() {
  const [tab, setTab] = useState('payouts');
  const { data: integ } = useApi<{ unbalancedBatches: string[]; processorClearingNet: number; heldOrFailedPayouts: number; unmatchedItems: number }>('/finance/integrity', { deps: [tab] });
  return (
    <div className="space-y-4">
      <SectionTitle title="Settlement & payouts" hint="Close periods, release payout batches (two people above the limit), handle held and failed payouts, reconcile, adjust and answer statement disputes." />
      {integ && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Unbalanced batches" value={integ.unbalancedBatches.length} hint="must be 0" /><Stat label="Processor clearing" value={money(integ.processorClearingNet)} /><Stat label="Held/failed payouts" value={integ.heldOrFailedPayouts} /><Stat label="Unmatched items" value={integ.unmatchedItems} /></div>}
      <Tabs tabs={[{ id: 'payouts', label: 'Payouts' }, { id: 'reconcile', label: 'Reconcile' }, { id: 'adjust', label: 'Adjustments & disputes' }, { id: 'ledger', label: 'Ledger' }, { id: 'liabilities', label: 'Liabilities' }, { id: 'royalties', label: 'Royalties' }]} active={tab} onChange={setTab} />
      {tab === 'payouts' && <Payouts />}
      {tab === 'reconcile' && <Reconcile />}
      {tab === 'adjust' && <Adjust />}
      {tab === 'ledger' && <Ledger />}
      {tab === 'liabilities' && <Liabilities />}
      {tab === 'royalties' && <Royalties />}
    </div>
  );
}

function Payouts() {
  const { can } = useSession();
  const { run, error } = useAction();
  const [status, setStatus] = useState('');
  const { data: batches, reload: rb } = useApi<Batch[]>('/finance/payout-batches');
  const { data: list, reload: rl } = useApi<Payout[]>(`/finance/payouts${status ? `?status=${status}` : ''}`, { deps: [status] });
  const [period, setPeriod] = useState({ start: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) });
  const [out, setOut] = useState<string | null>(null);
  const reload = async () => { await rb(); await rl(); };
  const manage = can('finance.manage');
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{out && <Alert tone="info">{out}</Alert>}
      {manage && <Card title="Close a period">
        <div className="flex flex-wrap items-end gap-2"><Input type="date" label="Start" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /><Input type="date" label="End" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} />
          <Button onClick={() => run(async () => { const r = await api.post<unknown[]>('/finance/close-period', { periodStart: period.start, periodEnd: period.end }); setOut(`${r.length} merchant statement(s) created.`); await reload(); })}>Close merchant period</Button>
          <Button variant="secondary" onClick={() => run(async () => { const r = await api.post<unknown[]>('/finance/close-driver-period', { periodStart: period.start, periodEnd: period.end }); setOut(`${r.length} courier payout(s) accrued.`); await reload(); })}>Close courier period</Button></div>
      </Card>}
      <Card title="Payout batches" action={manage ? <span className="flex gap-1"><Button size="sm" onClick={() => run(async () => { const r = await api.post<{ status: string; totalCents?: number }>('/finance/payout-batches', { partyType: 'MERCHANT', reason: 'Merchant payouts' }); setOut(r.status === 'PENDING_APPROVAL' ? `Batch of ${money(r.totalCents || 0)} sent for approval.` : r.status === 'EMPTY' ? 'Nothing eligible.' : 'Batch submitted.'); await reload(); })}>Batch merchant payouts</Button><Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api.post<{ status: string }>('/finance/payout-batches', { partyType: 'DRIVER', reason: 'Courier payouts' }); setOut(r.status === 'EMPTY' ? 'Nothing eligible.' : `Courier batch ${r.status.toLowerCase().replace('_', ' ')}.`); await reload(); })}>Batch courier payouts</Button></span> : undefined}>
        <Table rows={batches || []} empty="No batches yet." cols={[
          { key: 'c', label: 'Created', render: (b) => <span className="text-xs">{when(b.createdAt)}</span> }, { key: 'p', label: 'Who', render: (b) => (b.partyType || 'all').toLowerCase() }, { key: 'n', label: 'Payouts', render: (b) => b.payoutCount }, { key: 't', label: 'Total', render: (b) => money(b.totalCents) },
          { key: 's', label: 'Status', render: (b) => <Badge tone={b.status === 'DONE' ? 'good' : b.status === 'PENDING_APPROVAL' || b.status === 'DRAFT' ? 'warn' : 'info'}>{b.status.replace('_', ' ')}</Badge> },
          { key: 'x', label: '', render: (b) => b.status === 'DRAFT' && manage ? <Button size="sm" onClick={() => { const reason = askReason('releasing this payout batch'); if (reason) run(async () => { await api.post(`/finance/payout-batches/${b.id}/request-release`, { reason }); await reload(); }); }}>Request release</Button> : b.status === 'PENDING_APPROVAL' ? <a className="text-xs underline" href="/admin/approvals">Waiting for a second approver</a> : null },
        ]} />
        <p className="mt-1 text-xs text-ink-500">Batches above the payout release limit need a different person with “approve payouts” to release them (Approvals). Payouts to an account whose bank details changed recently are held for the cooling-off period.</p>
      </Card>
      <Card title="Payouts" action={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['ELIGIBLE', 'SUBMITTED', 'PAID', 'RECONCILED', 'HELD', 'FAILED'].map((s) => <option key={s}>{s}</option>)}</Select>}>
        <Table rows={list || []} empty="No payouts." cols={[
          { key: 'w', label: 'To', render: (p) => <span>{p.organizationName || p.partyType.toLowerCase()}<span className="block text-xs text-ink-500">{p.partyType.toLowerCase()} · period to {p.periodEnd.slice(0, 10)}</span></span> },
          { key: 'a', label: 'Amount', render: (p) => money(p.amountCents) }, { key: 's', label: 'Status', render: (p) => <Badge tone={statusTone(p.status)}>{p.status}</Badge> },
          { key: 'r', label: 'Note', render: (p) => <span className="text-xs">{p.failureReason}{p.attempts > 1 ? ` · ${p.attempts} attempts` : ''}</span> },
          { key: 'x', label: '', render: (p) => manage && ['FAILED', 'HELD'].includes(p.status) && p.batchId ? <Button size="sm" variant="secondary" onClick={() => { const reason = askReason('reprocessing this payout'); if (reason) run(async () => { const r = await api.post<{ payout: { status: string } }>(`/finance/payouts/${p.id}/reprocess`, { reason }); setOut(`Payout is now ${r.payout.status.toLowerCase()}.`); await reload(); }); }}>Reprocess</Button> : null },
        ]} />
      </Card>
    </div>
  );
}

function Reconcile() {
  const { data: unmatched, reload } = useApi<{ id: string; source: string; externalId: string; amountCents: number; description: string | null; createdAt: string }[]>('/finance/unmatched');
  const { run, error } = useAction();
  const [bank, setBank] = useState({ externalId: '', amount: '' });
  const [transfers, setTransfers] = useState('');
  const [provider, setProvider] = useState('');
  const [out, setOut] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Bank line">
          <div className="flex items-end gap-2"><Input label="Bank line id" value={bank.externalId} onChange={(e) => setBank({ ...bank, externalId: e.target.value })} /><Input label="Amount $" value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} /><Button variant="secondary" onClick={() => run(async () => { setOut(await api.post('/finance/reconcile/bank', { externalId: bank.externalId, amountCents: Math.round(Number(bank.amount) * 100), currency: 'USD' })); await reload(); })}>Match</Button></div>
        </Card>
        <Card title="Processor transfer report (payouts)">
          <Textarea rows={3} label="CSV: transfer_id,amount_cents,status(paid|failed|pending),reason" value={transfers} onChange={(e) => setTransfers(e.target.value)} />
          <Button className="mt-2" variant="secondary" disabled={!transfers} onClick={() => run(async () => { const lines = transfers.split(/\r?\n/).filter((l) => l.trim() && !/^transfer/i.test(l)).map((l) => { const [transferId, amt, status, failureReason] = l.split(',').map((x) => x.trim()); return { transferId, amountCents: Number(amt), status, failureReason }; }); setOut(await api.post('/finance/reconcile/transfers', { lines })); await reload(); })}>Reconcile transfers</Button>
          <p className="mt-1 text-xs text-ink-500">A returned transfer re-opens the payable; reprocess the payout once the bank details are fixed.</p>
        </Card>
      </div>
      <Card title="Delivery provider invoice">
        <Textarea rows={3} label="JSON {provider, externalId, periodStart, periodEnd, lines:[{providerJobId, cents}]}" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <Button className="mt-2" variant="secondary" disabled={!provider} onClick={() => run(async () => { setOut(await api.post('/finance/provider-invoices', JSON.parse(provider))); await reload(); })}>Ingest invoice</Button>
      </Card>
      {out !== null && <pre className="max-h-40 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(out, null, 2)}</pre>}
      <Card title="Unmatched items"><Table rows={unmatched || []} empty="Nothing unmatched." cols={[{ key: 's', label: 'Source', render: (r) => r.source }, { key: 'e', label: 'External id', render: (r) => r.externalId }, { key: 'a', label: 'Amount', render: (r) => money(r.amountCents) }, { key: 'd', label: 'Note', render: (r) => r.description }, { key: 't', label: 'Seen', render: (r) => when(r.createdAt) }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="ghost" onClick={() => { const n = window.prompt('Resolution'); if (n) run(async () => { await api.post(`/finance/unmatched/${r.id}/resolve`, { resolution: n }); await reload(); }); }}>Resolve</Button> }]} /></Card>
    </div>
  );
}

function Adjust() {
  const { data: tenants } = useApi<{ org: { id: string; name: string; kind: string } }[]>('/admin/tenants');
  const list = (tenants || []).filter((t) => t.org.kind === 'MERCHANT').map((t) => t.org);
  const { data: disputes, reload } = useApi<{ id: string; organizationName: string; periodEnd: string; reason: string; amountCents: number | null; status: string; resolution: string | null; adjustmentCents: number | null; createdAt: string }[]>('/finance/statement-disputes');
  const { run, error } = useAction();
  const [f, setF] = useState({ organizationId: '', amount: '', reason: '' });
  const [ok, setOk] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <Card title="Manual adjustment (posted to the ledger)">
        <div className="grid gap-2 sm:grid-cols-4"><Select label="Merchant" value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })}><option value="">Choose…</option>{list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select><Input label="Amount $ (− charges the merchant)" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /><Input label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /><Button className="self-end" disabled={!f.organizationId || !f.amount || f.reason.length < 5} onClick={() => run(async () => { await api.post('/finance/adjustments', { organizationId: f.organizationId, cents: Math.round(Number(f.amount) * 100), reason: f.reason }); setOk('Adjustment posted; it appears on the next statement.'); setF({ organizationId: '', amount: '', reason: '' }); })}>Post</Button></div>
      </Card>
      <Card title="Statement disputes">
        <Table rows={disputes || []} empty="No statement disputes." cols={[
          { key: 'm', label: 'Merchant', render: (d) => <span>{d.organizationName}<span className="block text-xs text-ink-500">statement to {d.periodEnd.slice(0, 10)}</span></span> }, { key: 'r', label: 'Reason', render: (d) => d.reason }, { key: 'a', label: 'Claimed', render: (d) => (d.amountCents ? money(d.amountCents) : '—') },
          { key: 's', label: 'Status', render: (d) => <span><Badge tone={d.status === 'OPEN' ? 'warn' : d.status === 'RESOLVED' ? 'good' : 'bad'}>{d.status}</Badge>{d.resolution && <span className="block text-xs">{d.resolution}{d.adjustmentCents ? ` · ${money(d.adjustmentCents)}` : ''}</span>}</span> },
          { key: 'x', label: '', render: (d) => d.status === 'OPEN' ? <span className="flex gap-1"><Button size="sm" onClick={() => { const amt = window.prompt('Adjustment $ to credit (blank = none)', d.amountCents ? String(d.amountCents / 100) : ''); const resolution = askReason('accepting this dispute', 3); if (resolution) run(async () => { await api.post(`/finance/statement-disputes/${d.id}/resolve`, { accept: true, resolution, adjustmentCents: amt ? Math.round(Number(amt) * 100) : undefined }); await reload(); }); }}>Accept</Button><Button size="sm" variant="ghost" onClick={() => { const resolution = askReason('rejecting this dispute', 3); if (resolution) run(async () => { await api.post(`/finance/statement-disputes/${d.id}/resolve`, { accept: false, resolution }); await reload(); }); }}>Reject</Button></span> : null },
        ]} />
      </Card>
    </div>
  );
}

function Ledger() {
  const [f, setF] = useState({ account: '', partyId: '', orderId: '', batchId: '', from: '', to: '' });
  const [qs, setQs] = useState('limit=100');
  const { data } = useApi<{ entries: { id: string; batchId: string; account: string; partyId: string | null; orderId: string | null; debitCents: number; creditCents: number; memo: string | null; createdAt: string; reconciledAt: string | null }[]; totals: { debits: number; credits: number; count: number } }>(`/finance/ledger?${qs}`, { deps: [qs] });
  const accounts = ['MERCHANT_PAYABLE', 'DRIVER_PAYABLE', 'PROVIDER_PAYABLE', 'SUPPLIER_PAYABLE', 'PROCESSOR_CLEARING', 'BANK', 'CUSTOMER_CREDIT_LIABILITY', 'DEFERRED_REVENUE', 'DISPUTE_RECEIVABLE', 'INVENTORY', 'PLATFORM_REVENUE_COMMISSION', 'PLATFORM_REVENUE_SERVICE_FEE', 'PLATFORM_REVENUE_DELIVERY', 'PLATFORM_REVENUE_SUBSCRIPTION', 'PLATFORM_REVENUE_MEMBERSHIP', 'PLATFORM_REVENUE_BREAKAGE', 'PLATFORM_EXPENSE_COGS', 'PLATFORM_EXPENSE_PROCESSING', 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', 'PLATFORM_EXPENSE_PROMOTION', 'PLATFORM_EXPENSE_REFUND', 'PLATFORM_EXPENSE_ROYALTY', 'PLATFORM_ADJUSTMENTS'];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2"><Select label="Account" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">Any</option>{accounts.map((a) => <option key={a}>{a}</option>)}</Select><Input label="Party id" value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })} /><Input label="Order id" value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value })} /><Input label="Batch id" value={f.batchId} onChange={(e) => setF({ ...f, batchId: e.target.value })} /><Input type="date" label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input type="date" label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /><Button onClick={() => setQs(new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit: '200' }).toString())}>Search</Button></div>
      {data && <p className="text-sm">{data.totals.count} lines · debits {money(data.totals.debits)} · credits {money(data.totals.credits)} · net {money(data.totals.credits - data.totals.debits)}</p>}
      <Table rows={data?.entries || []} empty="No entries." cols={[{ key: 'd', label: 'When', render: (e) => <span className="text-xs">{when(e.createdAt)}</span> }, { key: 'a', label: 'Account', render: (e) => <span className="text-xs">{e.account}</span> }, { key: 'p', label: 'Party', render: (e) => <span className="text-xs">{e.partyId?.slice(0, 12)}</span> }, { key: 'dr', label: 'Debit', render: (e) => (e.debitCents ? money(e.debitCents) : '') }, { key: 'cr', label: 'Credit', render: (e) => (e.creditCents ? money(e.creditCents) : '') }, { key: 'm', label: 'Memo', render: (e) => <span className="text-xs">{e.memo}</span> }, { key: 'b', label: 'Batch', render: (e) => <button className="text-xs underline" onClick={() => setQs(`batchId=${e.batchId}`)}>{e.batchId.slice(0, 8)}</button> }]} />
    </div>
  );
}

function Liabilities() {
  const { data } = useApi<{ liabilities: { account: string; balanceCents: number }[]; totalLiabilitiesCents: number; revenue: { account: string; balanceCents: number }[]; totalRevenueCents: number; cash: { bankCents: number; processorClearingCents: number }; topMerchants: { organizationId: string; name: string | null; balanceCents: number }[] }>('/finance/liabilities');
  if (!data) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`Liabilities · ${money(data.totalLiabilitiesCents)}`}><Table rows={data.liabilities} cols={[{ key: 'a', label: 'Account', render: (l) => l.account.toLowerCase().replace(/_/g, ' ') }, { key: 'b', label: 'Balance', render: (l) => money(l.balanceCents) }]} /></Card>
      <Card title={`Revenue to date · ${money(data.totalRevenueCents)}`}><Table rows={data.revenue} cols={[{ key: 'a', label: 'Account', render: (l) => l.account.replace('PLATFORM_REVENUE_', '').toLowerCase().replace(/_/g, ' ') }, { key: 'b', label: 'Balance', render: (l) => money(l.balanceCents) }]} /><p className="mt-2 text-xs text-ink-500">Bank {money(data.cash.bankCents)} · processor clearing {money(-data.cash.processorClearingCents)}</p></Card>
      <Card title="Largest merchant balances"><Table rows={data.topMerchants} cols={[{ key: 'n', label: 'Merchant', render: (m) => m.name || m.organizationId }, { key: 'b', label: 'Owed', render: (m) => money(m.balanceCents) }]} /></Card>
    </div>
  );
}

function Royalties() {
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const { data } = useApi<{ brandId: string; name: string; ownerName: string | null; salesCents: number; units: number; royaltyCents: number; lines: { rule: string; cents: number }[] }[]>(`/finance/royalties?from=${from}`, { deps: [from] });
  return (
    <div className="space-y-3">
      <Input type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
      <Table rows={data || []} empty="No brand sales in this period." cols={[{ key: 'n', label: 'Brand', render: (b) => <span>{b.name}<span className="block text-xs text-ink-500">{b.ownerName}</span></span> }, { key: 's', label: 'Sales', render: (b) => `${money(b.salesCents)} · ${b.units} items` }, { key: 'r', label: 'Royalty', render: (b) => <b>{money(b.royaltyCents)}</b> }, { key: 'l', label: 'How', render: (b) => <span className="text-xs">{b.lines.map((l) => `${l.rule}: ${money(l.cents)}`).join(' · ')}</span> }]} />
    </div>
  );
}
