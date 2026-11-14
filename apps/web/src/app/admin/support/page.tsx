'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SUPPORT_CATEGORIES } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { CaseThread } from '@/components/case-thread';
import { pendingNotice } from '@/components/admin-ui';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Tabs, Textarea } from '@/components/ui';

interface Incident {
  id: string; reporterType?: string; category: string; description: string; status: string; owner: string | null; remedy: string | null; remedyCents: number; orderId: string | null; createdAt: string;
  priority: string; queue: string | null; assigneeId: string | null; firstResponseDueAt: string | null; resolveDueAt: string | null; firstRespondedAt: string | null; slaBreachedAt: string | null;
  responsibilityDispute: { role?: string; reason?: string; status?: string; at?: string } | null;
}
interface Detail { incident: Incident; order: { order: { id: string; number: string; status: string; totalCents: number; guestEmail: string | null; userId: string | null }; events: { type: string; createdAt: string; actorRole: string | null }[]; payment: { status: string; capturedCents: number; refundedCents: number } | null; delivery: { status: string; proofPhotoUrl: string | null } | null } | null; priorIncidents: Incident[] }
interface Preview { refundableCents: number; refundFits: boolean; orderTotalCents: number | null; priorCompensation: { id: string; remedy: string; cents: number }[]; goodwill: { count90d: number; cents90d: number } | null; restrictions: string[]; needsApproval: boolean; reasons: string[]; willIssue: string }

const label = (k: string) => (SUPPORT_CATEGORIES as Record<string, { label?: string }>)[k]?.label || k.toLowerCase().replace(/_/g, ' ');
const prioTone = (p: string) => (p === 'URGENT' ? 'bad' : p === 'HIGH' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';

function Due({ at, done }: { at: string | null; done?: boolean }) {
  if (!at || done) return <span className="text-xs text-ink-500">—</span>;
  const mins = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  return <span className={`text-xs ${mins < 0 ? 'font-semibold text-red-700' : mins < 30 ? 'text-amber-700' : 'text-ink-500'}`}>{mins < 0 ? `${-mins}m late` : mins < 120 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`}</span>;
}

export default function AdminSupport() {
  const [tab, setTab] = useState('queue');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Support</h1>
      <Tabs tabs={[{ id: 'queue', label: 'Queue' }, { id: 'disputes', label: 'Responsibility disputes' }, { id: 'causes', label: 'Root causes' }, { id: 'policy', label: 'Policy enforcement' }]} active={tab} onChange={setTab} />
      {tab === 'queue' && <Queue />}
      {tab === 'disputes' && <Disputes />}
      {tab === 'causes' && <RootCauses />}
      {tab === 'policy' && <Policy />}
    </div>
  );
}

function Queue() {
  const { user } = useSession();
  const [f, setF] = useState({ status: 'OPEN', priority: '', queue: '', reporterType: '', mine: false, breached: false });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
  const { data, reload } = useApi<Incident[]>(`/incidents?${qs}`, { poll: 10000, deps: [qs] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<Detail | null>(null);
  const open = (id: string) => api.get<Detail>(`/incidents/${id}`).then(setSel);
  const queues = Array.from(new Set(Object.values(SUPPORT_CATEGORIES as Record<string, { queue: string }>).map((c) => c.queue)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option>{['OPEN', 'INVESTIGATING', 'APPEALED', 'RESOLVED', 'CLOSED'].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Any</option>{['URGENT', 'HIGH', 'NORMAL', 'LOW'].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select label="Queue" value={f.queue} onChange={(e) => setF({ ...f, queue: e.target.value })}><option value="">Any</option>{queues.map((s) => <option key={s}>{s}</option>)}</Select>
        <Select label="From" value={f.reporterType} onChange={(e) => setF({ ...f, reporterType: e.target.value })}><option value="">Anyone</option>{['CUSTOMER', 'MERCHANT', 'DRIVER'].map((s) => <option key={s}>{s}</option>)}</Select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> Mine</label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.breached} onChange={(e) => setF({ ...f, breached: e.target.checked })} /> SLA breached</label>
      </div>
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="Queue is empty." cols={[
        { key: 'p', label: 'Priority', render: (r) => <span><Badge tone={prioTone(r.priority)}>{r.priority}</Badge>{r.slaBreachedAt && <Badge tone="bad">SLA</Badge>}</span> },
        { key: 'c', label: 'Category', render: (r) => <span>{label(r.category)}<span className="block text-xs text-ink-500">{r.queue}{r.reporterType && r.reporterType !== 'CUSTOMER' ? ` · from ${r.reporterType.toLowerCase()}` : ''}</span></span> },
        { key: 'd', label: 'Description', render: (r) => <button className="max-w-xs truncate text-left underline" onClick={() => open(r.id)}>{r.description}</button> },
        { key: 'f', label: 'First reply', render: (r) => <Due at={r.firstResponseDueAt} done={!!r.firstRespondedAt} /> },
        { key: 'r', label: 'Resolve by', render: (r) => <Due at={r.resolveDueAt} done={['RESOLVED', 'CLOSED'].includes(r.status)} /> },
        { key: 'a', label: 'Agent', render: (r) => r.assigneeId ? (r.assigneeId === user?.id ? 'me' : 'assigned') : <button className="text-xs underline" onClick={() => run(async () => { await api.post(`/incidents/${r.id}/assign`, { assigneeId: user?.id }); reload(); })}>take it</button> },
        { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
      ]} />
      {sel && <CasePanel d={sel} onClose={() => setSel(null)} onChange={() => { reload(); open(sel.incident.id); }} />}
    </div>
  );
}

function CasePanel({ d, onClose, onChange }: { d: Detail; onClose: () => void; onChange: () => void }) {
  const i = d.incident;
  const { user } = useSession();
  const { run, error } = useAction();
  const [res, setRes] = useState({ owner: 'MERCHANT', remedy: 'REFUND', cents: '', note: '' });
  const [pv, setPv] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cents = Math.round(Number(res.cents || 0) * 100);
  useEffect(() => {
    const t = setTimeout(() => { api.get<Preview>(`/incidents/${i.id}/remedy-preview?remedy=${res.remedy}&cents=${cents}`).then(setPv).catch(() => setPv(null)); }, 300);
    return () => clearTimeout(t);
  }, [i.id, res.remedy, cents]);
  const active = ['OPEN', 'INVESTIGATING', 'APPEALED'].includes(i.status);
  return (
    <Card title={`Ticket ${i.id.slice(0, 8)} · ${label(i.category)}`} action={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      {error && <Alert>{error}</Alert>}{notice && <Alert tone="info">{notice}</Alert>}
      <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone={prioTone(i.priority)}>{i.priority}</Badge><span>{i.queue}</span><span>opened {when(i.createdAt)}</span><span>first reply <Due at={i.firstResponseDueAt} done={!!i.firstRespondedAt} /></span><span>resolve <Due at={i.resolveDueAt} done={!active} /></span>
        {active && <><Select value={i.priority} onChange={(e) => run(async () => { await api.post(`/incidents/${i.id}/assign`, { priority: e.target.value }); onChange(); })}>{['URGENT', 'HIGH', 'NORMAL', 'LOW'].map((p) => <option key={p}>{p}</option>)}</Select>{i.assigneeId !== user?.id && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/incidents/${i.id}/assign`, { assigneeId: user?.id }); onChange(); })}>Assign to me</Button>}</>}
      </div>
      <p className="mt-2 text-sm">{i.description}</p>
      {d.order && (
        <div className="mt-2 rounded-lg bg-ink-50 p-3 text-xs">
          <div>Order <Link className="underline" href={`/admin/orders/${d.order.order.id}`}>{d.order.order.number}</Link> · {d.order.order.status} · {money(d.order.order.totalCents)}{d.order.order.userId && <> · <Link className="underline" href={`/admin/customers/${d.order.order.userId}`}>customer profile</Link></>}</div>
          <div>Payment {d.order.payment?.status} captured {money(d.order.payment?.capturedCents || 0)} refunded {money(d.order.payment?.refundedCents || 0)}</div>
          {d.order.delivery && <div>Delivery {d.order.delivery.status} {d.order.delivery.proofPhotoUrl && <a className="underline" href={d.order.delivery.proofPhotoUrl} target="_blank" rel="noreferrer">proof</a>}</div>}
          <div className="mt-1">Timeline: {d.order.events.map((e) => `${e.type}(${e.actorRole || 'sys'}) ${new Date(e.createdAt).toLocaleTimeString()}`).join(' → ')}</div>
          {d.priorIncidents.length > 0 && <div className="mt-1">Other tickets on this order: {d.priorIncidents.map((p) => `${label(p.category)} (${p.status.toLowerCase()}${p.remedyCents ? `, ${money(p.remedyCents)}` : ''})`).join('; ')}</div>}
        </div>
      )}
      <CaseThread incidentId={i.id} />
      {active && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-4">
            <Select label="Cost owner" value={res.owner} onChange={(e) => setRes({ ...res, owner: e.target.value })}>{['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER'].map((o) => <option key={o}>{o}</option>)}</Select>
            <Select label="Remedy" value={res.remedy} onChange={(e) => setRes({ ...res, remedy: e.target.value })}>{['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY', 'REASSIGN', 'NONE'].map((o) => <option key={o}>{o}</option>)}</Select>
            <Input label="Amount (USD)" value={res.cents} onChange={(e) => setRes({ ...res, cents: e.target.value })} />
            <Button className="self-end" onClick={() => run(async () => { const r = await api.post(`/incidents/${i.id}/resolve`, { owner: res.owner, remedy: res.remedy, remedyCents: cents, note: res.note }); const n = pendingNotice(r); if (n) setNotice(n); else onClose(); onChange(); })}>{pv?.needsApproval ? 'Request approval' : 'Resolve'}</Button>
          </div>
          {pv && (
            <div className={`rounded-lg p-2 text-xs ${pv.needsApproval || !pv.refundFits ? 'bg-amber-50' : 'bg-ink-50'}`}>
              Refundable left {money(pv.refundableCents)}{pv.orderTotalCents != null ? ` of ${money(pv.orderTotalCents)}` : ''} · will issue {pv.willIssue}
              {pv.goodwill && <> · customer goodwill 90d: {pv.goodwill.count90d}× {money(pv.goodwill.cents90d)}</>}
              {pv.priorCompensation.length > 0 && <> · already compensated {pv.priorCompensation.map((p) => `${p.remedy} ${money(p.cents)}`).join(', ')}</>}
              {pv.restrictions.length > 0 && <> · restrictions: {pv.restrictions.join(', ')}</>}
              {pv.needsApproval && <div className="font-semibold">Needs a second approver: {pv.reasons.join('; ')}</div>}
            </div>
          )}
          <Textarea label="Evidence / note" value={res.note} onChange={(e) => setRes({ ...res, note: e.target.value })} rows={2} />
        </div>
      )}
      {i.responsibilityDispute?.status === 'OPEN' && <DisputeDecision i={i} onDone={onChange} />}
    </Card>
  );
}

function DisputeDecision({ i, onDone }: { i: Incident; onDone: () => void }) {
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const d = i.responsibilityDispute!;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      {error && <Alert>{error}</Alert>}
      <div>The {d.role?.toLowerCase()} disputes being held responsible ({i.owner?.toLowerCase()}, {i.remedy?.toLowerCase()} {money(i.remedyCents)}): “{d.reason}”</div>
      <Input label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-2 flex gap-2"><Button size="sm" disabled={note.length < 3} onClick={() => run(async () => { await api.post(`/incidents/${i.id}/responsibility-decision`, { reverse: true, note }); onDone(); })}>Reverse — Gutad absorbs it</Button><Button size="sm" variant="secondary" disabled={note.length < 3} onClick={() => run(async () => { await api.post(`/incidents/${i.id}/responsibility-decision`, { reverse: false, note }); onDone(); })}>Uphold</Button></div>
    </div>
  );
}

function Disputes() {
  const { data, reload } = useApi<Incident[]>('/incidents?status=RESOLVED');
  const { data: closed } = useApi<Incident[]>('/incidents?status=CLOSED');
  const rows = [...(data || []), ...(closed || [])].filter((i) => i.responsibilityDispute?.status === 'OPEN');
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-sm text-ink-500">No open responsibility disputes.</p>}
      {rows.map((i) => <Card key={i.id} title={`${label(i.category)} · ${when(i.createdAt)}`}><p className="text-sm">{i.description}</p><DisputeDecision i={i} onDone={reload} /></Card>)}
    </div>
  );
}

function RootCauses() {
  const [dim, setDim] = useState('category');
  const [days, setDays] = useState('30');
  const from = new Date(Date.now() - Number(days || 30) * 86400_000).toISOString();
  const { data } = useApi<{ total: number; rows: { key: string; tickets: number; costCents: number; breached: number; avgResolveHours: number | null }[] }>(`/admin/support/root-causes?dim=${dim}&from=${encodeURIComponent(from.slice(0, 13) + ':00:00.000Z')}`, { deps: [dim, days] });
  const max = Math.max(1, ...(data?.rows.map((r) => r.tickets) || [1]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Group by" value={dim} onChange={(e) => setDim(e.target.value)}>{['category', 'dish', 'merchant', 'location', 'kitchen', 'zone', 'owner'].map((d) => <option key={d}>{d}</option>)}</Select>
        <Select label="Period" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select>
        {data && <span className="text-xs text-ink-500">{data.total} tickets</span>}
      </div>
      <Table rows={data?.rows || []} empty="No tickets in this period." cols={[
        { key: 'k', label: dim, render: (r) => <span className="text-sm">{dim === 'category' ? label(r.key) : r.key}</span> },
        { key: 't', label: 'Tickets', render: (r) => <span className="flex items-center gap-2"><span className="inline-block h-2 rounded bg-ink-400" style={{ width: `${(r.tickets / max) * 80}px` }} />{r.tickets}</span> },
        { key: 'c', label: 'Compensation', render: (r) => money(r.costCents) },
        { key: 'b', label: 'SLA breached', render: (r) => r.breached },
        { key: 'h', label: 'Avg time to resolve', render: (r) => (r.avgResolveHours == null ? '—' : `${r.avgResolveHours}h`) },
      ]} />
    </div>
  );
}

function Policy() {
  const { run, error } = useAction();
  const [strike, setStrike] = useState({ subjectType: 'MERCHANT', subjectId: '', reason: '' });
  const [ok, setOk] = useState<string | null>(null);
  return (
    <Card title="Policy enforcement">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <div className="grid gap-2 sm:grid-cols-4"><Select label="Subject" value={strike.subjectType} onChange={(e) => setStrike({ ...strike, subjectType: e.target.value })}>{['MERCHANT', 'DRIVER', 'CUSTOMER'].map((s) => <option key={s}>{s}</option>)}</Select><Input label="Subject id (org / driver / user)" value={strike.subjectId} onChange={(e) => setStrike({ ...strike, subjectId: e.target.value })} /><Input label="Reason" value={strike.reason} onChange={(e) => setStrike({ ...strike, reason: e.target.value })} /><Button className="self-end" variant="danger" onClick={() => run(async () => { const r = await api.post<{ total?: number; suspended?: boolean }>('/policy/strikes', strike); setOk(`Strike recorded${r?.total != null ? ` · ${r.total} points` : ''}${r?.suspended ? ' · subject suspended' : ''}.`); })}>Issue strike</Button></div>
      <p className="mt-1 text-xs text-ink-500">Three severity points auto-suspend a merchant or courier; customers with three points are blocked from ordering (they can appeal from their account). Appeals re-open the case.</p>
    </Card>
  );
}
