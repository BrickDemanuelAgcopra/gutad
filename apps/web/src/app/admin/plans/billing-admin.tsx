'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';

interface AddOn { id: string; code: string; name: string; description: string | null; productLine: string; priceCents: number; interval: string; perLocation: boolean; features: Record<string, boolean | number>; isPublic: boolean; isActive: boolean; sortOrder: number; activeCount: number }
interface Feature { key: string; name: string; kind: 'BOOLEAN' | 'LIMIT'; isActive: boolean }

/** Admin → Plans & pricing → Add-ons: what merchants can buy on top of a plan. */
export function AddOnsTab({ features }: { features: Feature[] }) {
  const { data, reload } = useApi<AddOn[]>('/admin/add-ons');
  const blank = { id: '', code: '', name: '', description: '', productLine: 'ALL', price: '0', interval: 'MONTH', perLocation: false, features: {} as Record<string, boolean | number>, isPublic: true, isActive: true, sortOrder: 0 };
  const [f, setF] = useState(blank);
  const { run, error } = useAction();
  const edit = (a: AddOn) => setF({ id: a.id, code: a.code, name: a.name, description: a.description || '', productLine: a.productLine, price: (a.priceCents / 100).toFixed(2), interval: a.interval, perLocation: a.perLocation, features: a.features, isPublic: a.isPublic, isActive: a.isActive, sortOrder: a.sortOrder });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card title="Add-ons">
        <Table rows={data || []} empty="No add-ons yet." cols={[
          { key: 'n', label: 'Add-on', render: (a) => <span className={a.isActive ? '' : 'opacity-50'}><b>{a.name}</b> <span className="text-xs text-ink-500">{a.code}{!a.isPublic && ' · hidden'}</span><span className="block text-xs text-ink-500">{Object.entries(a.features).map(([k, v]) => (typeof v === 'number' ? `+${v} ${k}` : k)).join(', ')}</span></span> },
          { key: 'p', label: 'Price', render: (a) => a.priceCents ? `${money(a.priceCents)}/${a.interval === 'YEAR' ? 'yr' : 'mo'}${a.perLocation ? ' per location' : ''}` : 'Free' },
          { key: 'c', label: 'Active', render: (a) => a.activeCount },
          { key: 'e', label: '', render: (a) => <Button size="sm" variant="ghost" onClick={() => edit(a)}>Edit</Button> },
        ]} />
      </Card>
      <Card title={f.id ? `Edit ${f.code}` : 'New add-on'}>
        <div className="space-y-2">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Code (permanent)" value={f.code} disabled={!!f.id} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Input label="Price (USD)" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            <Select label="Billed" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="MONTH">Monthly</option><option value="YEAR">Yearly</option></Select>
          </div>
          <Select label="Product line" value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })}><option value="ALL">All</option><option value="ORDERING">Ordering</option><option value="RESERVATIONS">Reservations</option></Select>
          <div className="text-sm font-medium">Unlocks</div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-ink-100 p-2 text-sm">
            {features.filter((x) => x.isActive).map((x) => (
              <label key={x.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">{x.kind === 'BOOLEAN' && <input type="checkbox" checked={!!f.features[x.key]} onChange={(e) => { const n = { ...f.features }; if (e.target.checked) n[x.key] = true; else delete n[x.key]; setF({ ...f, features: n }); }} />}{x.name}</span>
                {x.kind === 'LIMIT' && <input type="number" min={0} className="w-16 rounded border border-ink-100 px-1 text-right" placeholder="+0" value={typeof f.features[x.key] === 'number' ? (f.features[x.key] as number) : ''} onChange={(e) => { const n = { ...f.features }; if (e.target.value === '' || Number(e.target.value) === 0) delete n[x.key]; else n[x.key] = Number(e.target.value); setF({ ...f, features: n }); }} />}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.perLocation} onChange={(e) => setF({ ...f, perLocation: e.target.checked })} /> Per location</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Merchants can buy</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
          </div>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button size="sm" disabled={f.name.length < 2 || f.code.length < 2} onClick={() => run(async () => { await api.post('/admin/add-ons', { id: f.id || undefined, code: f.code, name: f.name, description: f.description || null, productLine: f.productLine, priceCents: Math.round(Number(f.price || 0) * 100), interval: f.interval, perLocation: f.perLocation, features: f.features, isPublic: f.isPublic, isActive: f.isActive, sortOrder: f.sortOrder }); setF(blank); reload(); })}>Save add-on</Button>
            <Button size="sm" variant="ghost" onClick={() => setF(blank)}>Clear</Button>
          </div>
          <p className="text-xs text-ink-500">Price changes apply to new purchases; merchants who already bought keep their price.</p>
        </div>
      </Card>
    </div>
  );
}

interface Sub { id: string; organizationId: string; orgName: string; planName: string; planCode: string; status: string; currentPeriodEnd: string; trialEndsAt: string | null; pausedReason: string | null; locationCount: number; mrrCents: number; scheduled: { name: string; effectiveFrom: string } | null }

/** Admin → Plans & pricing → Subscriptions: every merchant subscription, MRR, pause/resume. */
export function SubscriptionsTab() {
  const { data, reload } = useApi<Sub[]>('/admin/subscriptions');
  const { run, error } = useAction();
  const [filter, setFilter] = useState('OPEN');
  const rows = (data || []).filter((s) => filter === 'ALL' || (filter === 'OPEN' ? s.status !== 'CANCELED' : s.status === filter));
  const mrr = (data || []).reduce((a, s) => a + s.mrrCents, 0);
  return (
    <Card title="Subscriptions" action={<span className="text-sm">MRR <b>{money(mrr)}</b></span>}>
      <div className="mb-3 flex flex-wrap gap-2">{['OPEN', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED', 'ALL'].map((k) => <button key={k} onClick={() => setFilter(k)} className={`rounded-full px-3 py-1 text-xs ${filter === k ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-700'}`}>{k.replace('_', ' ').toLowerCase()}</button>)}</div>
      {error && <Alert>{error}</Alert>}
      <Table rows={rows} empty="No subscriptions." cols={[
        { key: 'o', label: 'Merchant', render: (s) => s.orgName },
        { key: 'p', label: 'Plan', render: (s) => <span>{s.planName}{s.scheduled && <span className="block text-xs text-amber-700">→ {s.scheduled.name} on {when(s.scheduled.effectiveFrom)}</span>}</span> },
        { key: 's', label: 'Status', render: (s) => <Badge tone={s.status === 'ACTIVE' ? 'good' : s.status === 'TRIAL' ? 'info' : s.status === 'CANCELED' ? 'neutral' : 'warn'}>{s.status.toLowerCase()}</Badge> },
        { key: 'r', label: 'Renews / ends', render: (s) => when(s.status === 'TRIAL' ? s.trialEndsAt : s.currentPeriodEnd) },
        { key: 'm', label: 'MRR', render: (s) => money(s.mrrCents) },
        { key: 'a', label: '', render: (s) => s.status === 'PAUSED' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/admin/subscriptions/${s.id}/resume`, {}); reload(); })}>Resume</Button> : s.status !== 'CANCELED' ? <Button size="sm" variant="ghost" onClick={() => { const reason = prompt('Why pause billing? (shown in the audit log)'); if (reason !== null) run(async () => { await api.post(`/admin/subscriptions/${s.id}/pause`, { reason }); reload(); }); }}>Pause</Button> : null },
      ]} />
      <p className="mt-2 text-xs text-ink-500">Pausing stops billing and renewals; resuming extends the period by the paused time. Plan changes for a merchant: issue a new Order Form from Tenants, or the merchant switches from Plan & billing.</p>
    </Card>
  );
}

/** On a published version: move merchants on older versions of this plan onto it from a date. */
export function MoveSubscribers({ versionId, version }: { versionId: string; version: number }) {
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ date: in30, includeLegacy: false, includeOverridden: false });
  const [result, setResult] = useState<{ dryRun: boolean; moved: { organizationId: string; from: number | string }[]; skipped: { organizationId: string; reason: string }[]; effectiveFrom: string } | null>(null);
  const { run, error } = useAction();
  const go = (dryRun: boolean) => run(async () => setResult(await api.post(`/admin/plan-versions/${versionId}/migrate`, { effectiveFrom: new Date(f.date + 'T00:00:00').toISOString(), includeLegacy: f.includeLegacy, includeOverridden: f.includeOverridden, dryRun })));
  return (
    <Card title={`Move existing merchants to v${version}`}>
      <p className="mb-2 text-xs text-ink-500">The Merchant Agreement promises 30 days&apos; notice of material changes, so the date defaults to 30 days out. Each merchant gets a new unsigned Order Form that takes effect on that date.</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <Input label="Effective date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <label className="flex items-center gap-1 pb-2"><input type="checkbox" checked={f.includeLegacy} onChange={(e) => setF({ ...f, includeLegacy: e.target.checked })} /> Include original (pre-catalog) contracts</label>
        <label className="flex items-center gap-1 pb-2"><input type="checkbox" checked={f.includeOverridden} onChange={(e) => setF({ ...f, includeOverridden: e.target.checked })} /> Include negotiated fees</label>
        <Button size="sm" variant="secondary" onClick={() => go(true)}>Preview</Button>
        <Button size="sm" onClick={() => go(false)}>Move merchants</Button>
      </div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      {result && <p className="mt-2 text-sm">{result.dryRun ? 'Would move' : 'Moved'} <b>{result.moved.length}</b> merchant{result.moved.length === 1 ? '' : 's'} effective {when(result.effectiveFrom)}; skipped {result.skipped.length}{result.skipped.length ? ` (${[...new Set(result.skipped.map((s) => s.reason))].join('; ')})` : ''}.</p>}
    </Card>
  );
}
