'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, Table, Tabs } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';
import { Actions, AllergenReviews, SafetyWorkspace } from '@/components/safety';

interface Recall { id: string; title: string; reason: string; severity: string; status: string; lotIds: string[]; affectedMenuItemIds: string[]; affectedOrderCount: number; customersNotifiedAt: string | null; createdAt: string; closedNote: string | null }

export default function AdminSafety() {
  const [tab, setTab] = useState('overview');
  return (
    <div className="space-y-4">
      <SectionTitle title="Food safety" hint="Temperatures, checklists, allergen reviews, recalls and traceability, illness reports, inspections and corrective actions." />
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'recalls', label: 'Recalls' }, { id: 'cases', label: 'Illness reports' }, { id: 'actions', label: 'Corrective actions' }, { id: 'allergens', label: 'Allergen reviews' }, { id: 'kitchen', label: 'By kitchen' }]} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'recalls' && <Recalls />}
      {tab === 'cases' && <Cases />}
      {tab === 'actions' && <Actions />}
      {tab === 'allergens' && <AllergenReviews />}
      {tab === 'kitchen' && <ByKitchen />}
    </div>
  );
}

function Overview() {
  const { data } = useApi<{ temperatures: { kitchen: string; out: number; total: number }[]; correctiveActions: { open: number; overdue: number; done: number }; checklists7d: { runs: number; missed: number }; openRecalls: Recall[]; openFoodSafetyTickets: number; allergenReviews: number }>('/safety/overview', { poll: 60000 });
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><Stat label="Open recalls" value={data.openRecalls.length} /><Stat label="Illness reports open" value={data.openFoodSafetyTickets} /><Stat label="Corrective actions open" value={data.correctiveActions.open} hint={`${data.correctiveActions.overdue} overdue`} /><Stat label="Awaiting verification" value={data.correctiveActions.done} /><Stat label="Checklists (7 days)" value={data.checklists7d.runs} hint={`${data.checklists7d.missed} missed steps`} /><Stat label="Allergen reviews" value={data.allergenReviews} /></div>
      <Card title="Temperature exceptions (7 days)"><Table rows={data.temperatures} empty="No readings." cols={[{ key: 'k', label: 'Kitchen', render: (t) => t.kitchen }, { key: 'o', label: 'Out of range', render: (t) => <span className={t.out ? 'font-semibold text-red-700' : ''}>{t.out}</span> }, { key: 'n', label: 'Readings', render: (t) => t.total }]} /></Card>
    </div>
  );
}

function Recalls() {
  const { data, reload } = useApi<Recall[]>('/safety/recalls');
  const { data: ks } = useApi<{ id: string; name: string }[]>('/admin/kitchens');
  const { can } = useSession();
  const { run, error } = useAction();
  const [k, setK] = useState('');
  const { data: lots } = useApi<{ id: string; ingredient: string; lotCode: string; supplier: string | null; quantity: number; status: string }[]>(k ? `/kitchens/${k}/lots?status=` : null, { deps: [k] });
  const [sel, setSel] = useState<string[]>([]);
  const [f, setF] = useState({ title: '', reason: '', severity: 'HIGH' });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No recalls." cols={[
        { key: 't', label: 'Recall', render: (r) => <span>{r.title}<span className="block text-xs text-ink-500">{r.reason} · {when(r.createdAt)}</span></span> },
        { key: 's', label: 'Status', render: (r) => <span><Badge tone={r.status === 'CLOSED' ? 'good' : 'bad'}>{r.status}</Badge><Badge>{r.severity}</Badge></span> },
        { key: 'a', label: 'Affected', render: (r) => <span className="text-xs">{r.lotIds.length} lot(s) · {r.affectedMenuItemIds.length} dish(es) · {r.affectedOrderCount} order(s){r.customersNotifiedAt ? ` · customers told ${when(r.customersNotifiedAt)}` : ''}</span> },
        { key: 'x', label: '', render: (r) => r.status !== 'CLOSED' && can('culinary.manage') ? <span className="flex flex-wrap gap-1">{!r.customersNotifiedAt && <Button size="sm" onClick={() => { const m = window.prompt('Message to affected customers', 'Please do not eat any leftovers from this order. Contact us for a refund.'); if (m) run(async () => { await api.post(`/safety/recalls/${r.id}/notify`, { message: m }); await reload(); }); }}>Notify customers</Button>}{r.status === 'QUARANTINED' && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/safety/recalls/${r.id}/withdraw`, {}); await reload(); })}>Withdraw stock</Button>}<Button size="sm" variant="ghost" onClick={() => { const note = askReason('closing this recall', 3); if (note) run(async () => { await api.post(`/safety/recalls/${r.id}/close`, { note }); await reload(); }); }}>Close</Button></span> : r.closedNote ? <span className="text-xs">{r.closedNote}</span> : null },
      ]} />
      {can('culinary.manage') && <Card title="Open a recall / quarantine">
        <Select label="Kitchen" value={k} onChange={(e) => { setK(e.target.value); setSel([]); }}><option value="">Choose…</option>{ks?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        {lots && <div className="mt-2 max-h-48 overflow-auto rounded border border-ink-100 p-2 text-sm">{lots.map((l) => <label key={l.id} className="flex items-center gap-2"><input type="checkbox" checked={sel.includes(l.id)} onChange={(e) => setSel(e.target.checked ? [...sel, l.id] : sel.filter((x) => x !== l.id))} />{l.ingredient} · {l.lotCode}{l.supplier ? ` · ${l.supplier}` : ''} · {l.status.toLowerCase()}</label>)}{!lots.length && <span className="text-ink-500">No lots.</span>}</div>}
        <div className="mt-2 grid gap-2 sm:grid-cols-3"><Input label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /><Input label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /><Select label="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option>LOW</option><option>HIGH</option><option>CRITICAL</option></Select></div>
        <Button className="mt-2" variant="danger" disabled={!sel.length || f.title.length < 3 || f.reason.length < 5} onClick={() => run(async () => { await api.post('/safety/recalls', { ...f, lotIds: sel }); setSel([]); setF({ title: '', reason: '', severity: 'HIGH' }); await reload(); })}>Quarantine lots & stop-sell</Button>
        <p className="mt-1 text-xs text-ink-500">Quarantined lots can’t be used; every dish that uses the ingredient at those kitchens is taken off the menu until the recall closes.</p>
      </Card>}
    </div>
  );
}

function Cases() {
  const { data } = useApi<{ id: string; status: string; description: string; created_at: string; order_id: string | null; number: string | null; location: string | null; item: string | null }[]>('/safety/food-safety-cases');
  const { run, error } = useAction();
  const [lots, setLots] = useState<Record<string, { lot_code: string | null; ingredient: string; supplier: string | null }[]>>({});
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-ink-500">Two or more reports at one location (or for one dish) within 72 hours raise a possible-cluster alert automatically.</p>
      <Table rows={data || []} empty="No food-safety reports in 30 days." cols={[
        { key: 'd', label: 'When', render: (c) => <span className="text-xs">{when(c.created_at)}</span> }, { key: 'l', label: 'Where', render: (c) => <span>{c.location || '—'}{c.item ? <span className="block text-xs text-ink-500">{c.item}</span> : null}</span> },
        { key: 'r', label: 'Report', render: (c) => <span className="text-xs">{c.description}</span> }, { key: 's', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
        { key: 't', label: 'Ingredients used', render: (c) => c.order_id ? (lots[c.id] ? <span className="text-xs">{lots[c.id].map((l) => `${l.ingredient}${l.lot_code ? ` (${l.lot_code})` : ''}`).join(', ') || 'no lots recorded'}</span> : <button className="text-xs underline" onClick={() => run(async () => { const r = await api.get<{ lots: { lot_code: string | null; ingredient: string; supplier: string | null }[] }>(`/safety/trace/order/${c.order_id}`); setLots({ ...lots, [c.id]: r.lots }); })}>Trace order</button>) : '—' },
      ]} />
    </div>
  );
}

function ByKitchen() {
  const { data: ks } = useApi<{ id: string; name: string; organization: string }[]>('/admin/kitchens');
  const { data: orgs } = useApi<{ org: { id: string; name: string } }[]>('/admin/tenants');
  const [k, setK] = useState('');
  const kit = ks?.find((x) => x.id === k);
  const orgId = orgs?.find((o) => o.org.name === kit?.organization)?.org.id;
  return <div className="space-y-3"><Select label="Kitchen" value={k} onChange={(e) => setK(e.target.value)}><option value="">Choose…</option>{ks?.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.organization}</option>)}</Select>{k && orgId && <SafetyWorkspace kitchenId={k} organizationId={orgId} />}</div>;
}
