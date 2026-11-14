'use client';
import { useState } from 'react';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_TYPES, type PaymentMethodType } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, statusTone, Table, Tabs, Textarea } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface Pay { id: string; orderId: string | null; orderNumber: string | null; customerEmail: string | null; purpose: string; status: string; amountCents: number; capturedCents: number; refundedCents: number; processingFeeCents: number; provider: string; paymentMethodId: string | null; disputeStatus: string | null; createdAt: string; retryCount: number }

export default function Payments() {
  const [tab, setTab] = useState('console');
  return (
    <div className="space-y-4">
      <SectionTitle title="Payments" hint="Authorizations, captures, voids, refunds, failures and disputes. Card numbers are never shown or stored." />
      <Tabs tabs={[{ id: 'console', label: 'Console' }, { id: 'failures', label: 'Failures' }, { id: 'disputes', label: 'Disputes' }, { id: 'settlement', label: 'Settlement file' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'methods', label: 'Payment methods' }]} active={tab} onChange={setTab} />
      {tab === 'console' && <Console />}
      {tab === 'failures' && <Failures />}
      {tab === 'disputes' && <Disputes />}
      {tab === 'settlement' && <Settlement />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'methods' && <Methods />}
    </div>
  );
}

function Console() {
  const [f, setF] = useState({ status: '', purpose: '', q: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, reload } = useApi<{ summary30d: { authorizedOpenCents: number; capturedCents: number; refundedCents: number; feesCents: number; voided: number; failures: number }; payments: Pay[] }>(`/admin/payments?${qs}`, { deps: [qs] });
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {data && <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><Stat label="Captured (30d)" value={money(data.summary30d.capturedCents)} /><Stat label="Refunded" value={money(data.summary30d.refundedCents)} /><Stat label="Open authorizations" value={money(data.summary30d.authorizedOpenCents)} /><Stat label="Processing fees" value={money(data.summary30d.feesCents)} /><Stat label="Voided" value={data.summary30d.voided} /><Stat label="Failed attempts" value={data.summary30d.failures} /></div>}
      <div className="flex flex-wrap items-end gap-2"><Input label="Order, intent or charge id" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /><Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option>{['AUTHORIZED', 'CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED', 'DISPUTED', 'REQUIRES_ACTION'].map((s) => <option key={s}>{s}</option>)}</Select><Select label="Purpose" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="">Any</option>{['ORDER', 'DEPOSIT', 'GUARANTEE', 'TICKET', 'MEMBERSHIP', 'INVOICE', 'SHIPMENT', 'NO_SHOW', 'EVENT_DEPOSIT'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      <Table rows={data?.payments || []} empty="No payments." cols={[
        { key: 'c', label: 'Created', render: (p) => <span className="text-xs">{when(p.createdAt)}</span> },
        { key: 'o', label: 'For', render: (p) => <button className="text-left underline" onClick={() => setSel(p.id)}>{p.orderNumber || p.purpose.toLowerCase()}<span className="block text-xs text-ink-500">{p.customerEmail}</span></button> },
        { key: 's', label: 'Status', render: (p) => <span><Badge tone={statusTone(p.status)}>{p.status}</Badge>{p.disputeStatus && <Badge tone="bad">dispute {p.disputeStatus.toLowerCase()}</Badge>}</span> },
        { key: 'a', label: 'Amount', render: (p) => money(p.amountCents) }, { key: 'cp', label: 'Captured', render: (p) => money(p.capturedCents) }, { key: 'r', label: 'Refunded', render: (p) => money(p.refundedCents) },
        { key: 'm', label: 'Method', render: (p) => <span className="text-xs">{p.provider} {p.paymentMethodId || ''}</span> },
      ]} />
      {sel && <PaymentDetail id={sel} onClose={() => { setSel(null); void reload(); }} />}
    </div>
  );
}

function PaymentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, reload } = useApi<{ payment: Pay & { split: { cardCents: number; creditsCents: number; loyaltyCents: number; giftCents: number } | null; lastFailureReason: string | null; providerChargeId: string | null }; refunds: { id: string; amountCents: number; reason: string; funder: string; status: string; allocation: { cardCents: number; creditsCents: number } | null; createdAt: string }[]; dispute: { status: string; evidenceDueAt: string } | null; journal: { account: string; debit_cents: number; credit_cents: number; memo: string | null; created_at: string }[] }>(`/admin/payments/${id}`);
  const { can } = useSession();
  const { run, error } = useAction();
  const [rf, setRf] = useState({ amount: '', reason: '', funder: 'PLATFORM' });
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const p = data.payment;
  return (
    <Modal open onClose={onClose} title={`Payment ${p.orderNumber || p.id.slice(0, 8)}`}>
      <div className="max-h-[70vh] space-y-3 overflow-auto text-sm">
        {error && <Alert>{error}</Alert>}{msg && <Alert tone="good">{msg}</Alert>}
        <div><Badge tone={statusTone(p.status)}>{p.status}</Badge> · captured {money(p.capturedCents)} · refunded {money(p.refundedCents)} · fee {money(p.processingFeeCents)} · charge {p.providerChargeId || '—'}</div>
        {p.split && <div>Paid with: card {money(p.split.cardCents)}{p.split.creditsCents ? ` · credits ${money(p.split.creditsCents)}` : ''}{p.split.loyaltyCents ? ` · points ${money(p.split.loyaltyCents)}` : ''}{p.split.giftCents ? ` · gift ${money(p.split.giftCents)}` : ''}</div>}
        {p.lastFailureReason && <Alert>Last failure: {p.lastFailureReason} (retries {p.retryCount})</Alert>}
        {data.dispute && <Alert>Dispute {data.dispute.status.toLowerCase().replace('_', ' ')} · evidence due {when(data.dispute.evidenceDueAt)}</Alert>}
        {data.refunds.length > 0 && <div><div className="text-xs font-semibold text-ink-500">Refunds</div>{data.refunds.map((r) => <div key={r.id}>{money(r.amountCents + (r.allocation?.creditsCents || 0))} · {r.funder.toLowerCase()} · {r.reason}{r.allocation ? ` (card ${money(r.allocation.cardCents)}, credits ${money(r.allocation.creditsCents)})` : ''} · {when(r.createdAt)}</div>)}</div>}
        <div><div className="text-xs font-semibold text-ink-500">Ledger</div>{data.journal.map((j, i) => <div key={i} className="text-xs">{j.account} {j.debit_cents ? `Dr ${money(j.debit_cents)}` : `Cr ${money(j.credit_cents)}`} · {j.memo}</div>)}</div>
        {can('finance.manage') && p.status === 'AUTHORIZED' && <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api.post<{ ok: boolean; reason?: string; retriesLeft?: number }>(`/admin/payments/${id}/retry-capture`, {}); setMsg(r.ok ? 'Captured.' : `Still failing: ${r.reason} (${r.retriesLeft} retries left)`); await reload(); })}>Retry capture</Button>}
        {(can('finance.manage') || can('support.manage')) && ['CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED'].includes(p.status) && (
          <div className="rounded-lg bg-ink-50 p-2"><div className="text-xs font-semibold text-ink-500">Partial refund (split back to card and credits)</div><div className="grid gap-2 sm:grid-cols-3"><Input label="Amount $" value={rf.amount} onChange={(e) => setRf({ ...rf, amount: e.target.value })} /><Select label="Funded by" value={rf.funder} onChange={(e) => setRf({ ...rf, funder: e.target.value })}><option value="PLATFORM">Gutad</option><option value="MERCHANT">Merchant</option></Select><Input label="Reason" value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} /></div><Button className="mt-2" size="sm" disabled={!rf.amount || rf.reason.length < 5} onClick={() => run(async () => { const r = await api.post<{ toCardCents: number; toCreditsCents: number }>(`/admin/payments/${id}/refund`, { amountCents: Math.round(Number(rf.amount) * 100), reason: rf.reason, funder: rf.funder }); setMsg(`Refunded ${money(r.toCardCents)} to the card and ${money(r.toCreditsCents)} as credits.`); await reload(); })}>Refund</Button></div>
        )}
      </div>
    </Modal>
  );
}

function Failures() {
  const [days, setDays] = useState('7');
  const { data } = useApi<{ failures: { id: string; purpose: string; amountCents: number; reason: string; customerEmail: string | null; location: string | null; createdAt: string }[]; byReason: { reason: string; count: number }[] }>(`/admin/payments/failures?days=${days}`, { deps: [days] });
  const { data: dups } = useApi<{ a_id: string; b_id: string; amount_cents: number; a_number: string | null; b_number: string | null; a_at: string; b_at: string }[]>('/admin/payments/duplicates?days=30');
  return (
    <div className="space-y-3">
      <Select value={days} onChange={(e) => setDays(e.target.value)}><option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option></Select>
      <div className="flex flex-wrap gap-2">{data?.byReason.map((r) => <Badge key={r.reason} tone="bad">{r.reason}: {r.count}</Badge>)}</div>
      <Table rows={data?.failures || []} empty="No failed payments." cols={[{ key: 'd', label: 'When', render: (f) => <span className="text-xs">{when(f.createdAt)}</span> }, { key: 'p', label: 'What', render: (f) => f.purpose.toLowerCase() }, { key: 'a', label: 'Amount', render: (f) => money(f.amountCents) }, { key: 'c', label: 'Customer', render: (f) => <span className="text-xs">{f.customerEmail} {f.location ? `· ${f.location}` : ''}</span> }, { key: 'r', label: 'Reason', render: (f) => f.reason }]} />
      <Card title="Possible duplicate charges (same customer and amount within 5 minutes)">
        <Table rows={dups || []} empty="None found." cols={[{ key: 'a', label: 'First', render: (d) => `${d.a_number || d.a_id.slice(0, 8)} · ${when(d.a_at)}` }, { key: 'b', label: 'Second', render: (d) => `${d.b_number || d.b_id.slice(0, 8)} · ${when(d.b_at)}` }, { key: 'm', label: 'Amount', render: (d) => money(d.amount_cents) }]} />
      </Card>
    </div>
  );
}

function Disputes() {
  const { data, reload } = useApi<{ id: string; orderNumber: string | null; amountCents: number; reason: string | null; status: string; evidenceDueAt: string | null; overdue: boolean; liability: string; outcomeNote: string | null }[]>('/admin/disputes');
  const { can } = useSession();
  const { run, error } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No disputes." cols={[
        { key: 'o', label: 'Order', render: (d) => d.orderNumber || '—' }, { key: 'a', label: 'Amount', render: (d) => money(d.amountCents) }, { key: 'r', label: 'Reason', render: (d) => d.reason || '—' },
        { key: 's', label: 'Status', render: (d) => <span><Badge tone={d.status === 'WON' ? 'good' : d.status === 'LOST' ? 'bad' : 'warn'}>{d.status.replace('_', ' ')}</Badge>{d.overdue && <Badge tone="bad">overdue</Badge>}</span> },
        { key: 'd', label: 'Evidence due', render: (d) => <span className="text-xs">{when(d.evidenceDueAt)}</span> },
        { key: 'x', label: '', render: (d) => can('finance.manage') && <span className="flex flex-wrap gap-1">
          {d.status === 'NEEDS_RESPONSE' && <Button size="sm" onClick={() => run(async () => { await api.post(`/admin/disputes/${d.id}/evidence`, { note: window.prompt('Note for the evidence packet (optional)') || undefined }); await reload(); })}>Submit evidence</Button>}
          {['NEEDS_RESPONSE', 'UNDER_REVIEW'].includes(d.status) && <><Button size="sm" variant="secondary" onClick={() => { const note = askReason('recording a won dispute'); if (note) run(async () => { await api.post(`/admin/disputes/${d.id}/outcome`, { outcome: 'WON', note }); await reload(); }); }}>Won</Button><Button size="sm" variant="ghost" onClick={() => { const note = askReason('recording a lost dispute'); const liab = window.confirm('Is the merchant liable? (Cancel = Gutad bears it)') ? 'MERCHANT' : 'PLATFORM'; if (note) run(async () => { await api.post(`/admin/disputes/${d.id}/outcome`, { outcome: 'LOST', liability: liab, note }); await reload(); }); }}>Lost</Button></>}
        </span> },
      ]} />
    </div>
  );
}

function Settlement() {
  const { data, reload } = useApi<{ unsettled: { id: string; orderId: string | null; capturedCents: number; createdAt: string; providerChargeId: string | null }[]; staleAuthorizations: { id: string; authorizedCents: number; createdAt: string }[]; unmatched: { id: string; externalId: string; amountCents: number; description: string | null }[] }>('/admin/payments/unresolved');
  const { run, error } = useAction();
  const [csv, setCsv] = useState('');
  const [out, setOut] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{out && <Alert tone="info">{out}</Alert>}
      <Card title="Upload processor settlement file">
        <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setCsv); }} />
        <Textarea className="mt-2" rows={4} label="…or paste CSV (charge_id,amount_cents,fee_cents)" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <Button className="mt-2" disabled={!csv} onClick={() => run(async () => { const r = await api.post<{ lines: number; matched: number; unmatched: string[] }>('/admin/payments/settlement-file', { csv }); setOut(`${r.lines} lines: ${r.matched} matched, ${r.unmatched.length} unmatched.`); setCsv(''); await reload(); })}>Reconcile</Button>
      </Card>
      <Card title="Unresolved payments">
        <p className="text-xs text-ink-500">Captured more than 3 days ago but not in a settlement file: {data?.unsettled.length ?? 0} · authorizations open more than a day: {data?.staleAuthorizations.length ?? 0}</p>
        <Table rows={data?.unmatched || []} empty="No unmatched processor lines." cols={[{ key: 'e', label: 'Processor id', render: (u) => u.externalId }, { key: 'a', label: 'Amount', render: (u) => money(u.amountCents) }, { key: 'd', label: 'Note', render: (u) => u.description }, { key: 'x', label: '', render: (u) => <Button size="sm" variant="ghost" onClick={() => { const r = window.prompt('Resolution'); if (r) run(async () => { await api.post(`/finance/unmatched/${u.id}/resolve`, { resolution: r }); await reload(); }); }}>Resolve</Button> }]} />
      </Card>
    </div>
  );
}

function Webhooks() {
  const { data, reload } = useApi<{ providers: { provider: string; received: number; failed: number; pending: number; ratePerHour: number; avgLagSeconds: number | null; maxLagSeconds: number | null }[]; failed: { id: string; provider: string; eventId: string; type: string; error: string | null; receivedAt: string }[] }>('/admin/webhooks?hours=24', { poll: 30000 });
  const { run, error } = useAction();
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Table rows={data?.providers || []} empty="No webhooks in the last 24 hours." cols={[{ key: 'p', label: 'Provider', render: (p) => p.provider }, { key: 'r', label: 'Received', render: (p) => `${p.received} (${p.ratePerHour}/h)` }, { key: 'f', label: 'Failed', render: (p) => <span className={p.failed ? 'text-red-700' : ''}>{p.failed}</span> }, { key: 'q', label: 'Pending', render: (p) => p.pending }, { key: 'l', label: 'Lag avg / max', render: (p) => `${p.avgLagSeconds ?? '—'}s / ${p.maxLagSeconds ?? '—'}s` }]} />
      <Card title="Failed events">
        <Table rows={data?.failed || []} empty="No failed events." cols={[{ key: 'p', label: 'Provider', render: (f) => f.provider }, { key: 't', label: 'Type', render: (f) => f.type }, { key: 'e', label: 'Error', render: (f) => <span className="text-xs">{f.error}</span> }, { key: 'w', label: 'When', render: (f) => when(f.receivedAt) }, { key: 'x', label: '', render: (f) => <span className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => run(async () => setPlan(await api.post(`/admin/webhooks/${f.id}/replay`, { dryRun: true })))}>Dry run</Button><Button size="sm" onClick={() => run(async () => { setPlan(await api.post(`/admin/webhooks/${f.id}/replay`, { dryRun: false })); await reload(); })}>Replay</Button></span> }]} />
      </Card>
      {plan && <pre className="max-h-48 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(plan, null, 2)}</pre>}
    </div>
  );
}

function Methods() {
  const { data, reload } = useApi<{ settings: Record<string, unknown> }>('/admin/settings');
  const { run, error } = useAction();
  const cur = (data?.settings['payments.methods'] as { default?: PaymentMethodType[] } | undefined)?.default || ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'CREDITS', 'LOYALTY'];
  const [sel, setSel] = useState<PaymentMethodType[] | null>(null);
  const v = sel || cur;
  return (
    <Card title="Payment methods offered at checkout">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-3">{PAYMENT_METHOD_TYPES.map((m) => <label key={m} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={v.includes(m)} disabled={m === 'CARD'} onChange={(e) => setSel(e.target.checked ? [...v, m] : v.filter((x) => x !== m))} />{PAYMENT_METHOD_LABELS[m]}{m === 'GIFT_CARD' ? ' (with gift cards)' : ''}</label>)}</div>
      <p className="mt-1 text-xs text-ink-500">Phone and walk-in orders take cards only. Per-region lists can be set in Settings (`payments.methods.byRegion`).</p>
      <Button className="mt-2" size="sm" disabled={!sel} onClick={() => { const reason = askReason('changing payment methods'); if (reason) run(async () => { await api.post('/admin/settings', { key: 'payments.methods', value: { default: v, byChannel: { PHONE: ['CARD'], WALK_IN: ['CARD'] }, byRegion: {} }, reason }); setSel(null); await reload(); }); }}>Save</Button>
    </Card>
  );
}
