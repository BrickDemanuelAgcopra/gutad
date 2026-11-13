'use client';
import { useEffect, useMemo, useState } from 'react';
import { describeFee, feeAmount, FEE_CHANNELS, FEE_FULFILLMENTS, FEE_TYPES, PRODUCT_LINES, resolveFee, type FeeRuleDto } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Tabs, Textarea } from '@/components/ui';

interface Feature { key: string; name: string; description: string | null; kind: 'BOOLEAN' | 'LIMIT'; productLine: string; sortOrder: number; isActive: boolean }
interface Version { id: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; subscriptionCents: number; interval: 'MONTH' | 'YEAR'; perLocation: boolean; setupFeeCents: number; trialDays: number; notes: string | null; publishedAt: string | null; contracts: number; fees: (FeeRuleDto & { id?: string })[]; features: { key: string; enabled: boolean; limitValue: number | null }[] }
interface Plan { id: string; code: string; name: string; productLine: string; tagline: string | null; description: string | null; isPublic: boolean; isArchived: boolean; highlight: boolean; sortOrder: number; versions: Version[] }
interface Catalog { requireSecondApprover: boolean; features: Feature[]; plans: Plan[] }

const statusTone = { DRAFT: 'warn', PUBLISHED: 'good', RETIRED: 'neutral' } as const;
const dollars = (cents: number) => (cents / 100).toFixed(2);
const toCents = (v: string) => Math.round(Number(v || 0) * 100);

/** Admin → Plans: product lines, plans, versioned prices, fee rules and features — all editable here. */
export default function PlansAdmin() {
  const { data, reload } = useApi<Catalog>('/admin/plans');
  const [tab, setTab] = useState('plans');
  const [selId, setSelId] = useState<string | null>(null);
  const { run, error } = useAction();
  const sel = data?.plans.find((p) => p.id === selId) || null;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div><h1 className="text-2xl font-bold">Plans & pricing</h1><p className="text-sm text-ink-500">Changes apply to new Order Forms once a version is published. Merchants keep the version they signed.</p></div>
        <a className="text-sm text-brand-600 underline" href="/pricing" target="_blank" rel="noreferrer">View public pricing</a>
      </div>
      <Tabs tabs={[{ id: 'plans', label: 'Plans' }, { id: 'features', label: 'Features' }]} active={tab} onChange={setTab} />
      {error && <Alert>{error}</Alert>}
      {tab === 'features' && data && <FeaturesTab features={data.features} reload={reload} />}
      {tab === 'plans' && data && (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="space-y-4">
            {PRODUCT_LINES.map((line) => (
              <Card key={line.key} title={line.label}>
                <ul className="space-y-1 text-sm">
                  {data.plans.filter((p) => p.productLine === line.key).map((p) => {
                    const live = p.versions.find((v) => v.status === 'PUBLISHED');
                    const draft = p.versions.some((v) => v.status === 'DRAFT');
                    return (
                      <li key={p.id}>
                        <button onClick={() => setSelId(p.id)} className={`w-full rounded-lg px-2 py-1.5 text-left ${selId === p.id ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-ink-50'} ${p.isArchived ? 'opacity-50' : ''}`}>
                          <div className="flex items-center justify-between gap-1"><span>{p.name}</span><span className="text-xs text-ink-500">{live ? `${money(live.subscriptionCents)}/${live.interval === 'YEAR' ? 'yr' : 'mo'}` : '—'}</span></div>
                          <div className="text-[11px] text-ink-500">{p.code}{!p.isPublic && ' · hidden'}{p.isArchived && ' · archived'}{draft && ' · draft pending'}</div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
            <NewPlan onCreated={async (id) => { await reload(); setSelId(id); }} />
          </div>
          <div>{sel ? <PlanEditor key={sel.id} plan={sel} catalog={data} reload={reload} run={run} /> : <Card><p className="text-sm text-ink-500">Choose a plan to edit its price, fees and features, or create a new one.</p></Card>}</div>
        </div>
      )}
    </div>
  );
}

function NewPlan({ onCreated }: { onCreated: (id: string) => void }) {
  const [f, setF] = useState({ code: '', name: '', productLine: 'ORDERING' });
  const { run, error } = useAction();
  return (
    <Card title="New plan">
      <div className="space-y-2">
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, code: f.code || '' })} />
        <Input label="Code (permanent, e.g. ORDERING_ENTERPRISE)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        <Select label="Product line" value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })}>{PRODUCT_LINES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</Select>
        {error && <Alert>{error}</Alert>}
        <Button size="sm" disabled={f.name.length < 2 || f.code.length < 2} onClick={() => run(async () => { const p = await api.post<{ id: string }>('/admin/plans', f); setF({ code: '', name: '', productLine: 'ORDERING' }); onCreated(p.id); })}>Create plan (as hidden draft)</Button>
      </div>
    </Card>
  );
}

function PlanEditor({ plan, catalog, reload, run }: { plan: Plan; catalog: Catalog; reload: () => void; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [meta, setMeta] = useState({ name: plan.name, productLine: plan.productLine, tagline: plan.tagline || '', description: plan.description || '', isPublic: plan.isPublic, highlight: plan.highlight, sortOrder: plan.sortOrder });
  const draft = plan.versions.find((v) => v.status === 'DRAFT');
  const live = plan.versions.find((v) => v.status === 'PUBLISHED');
  const [viewId, setViewId] = useState<string | null>(draft?.id || live?.id || null);
  const view = plan.versions.find((v) => v.id === viewId) || draft || live || plan.versions[0];
  return (
    <div className="space-y-4">
      <Card title={plan.name} action={<div className="flex gap-1">{plan.isArchived ? <Badge tone="neutral">Archived</Badge> : live ? <Badge tone="good">Live v{live.version}</Badge> : <Badge tone="warn">Not published</Badge>}</div>}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label="Name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          <Select label="Product line" value={meta.productLine} onChange={(e) => setMeta({ ...meta, productLine: e.target.value })}>{PRODUCT_LINES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</Select>
          <Input label="Tagline" value={meta.tagline} onChange={(e) => setMeta({ ...meta, tagline: e.target.value })} className="sm:col-span-2" />
          <Input label="Display order" type="number" value={meta.sortOrder} onChange={(e) => setMeta({ ...meta, sortOrder: Number(e.target.value) })} />
          <div className="flex items-end gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={meta.isPublic} onChange={(e) => setMeta({ ...meta, isPublic: e.target.checked })} /> Shown on pricing page</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={meta.highlight} onChange={(e) => setMeta({ ...meta, highlight: e.target.checked })} /> Highlight</label>
          </div>
        </div>
        <Textarea className="mt-2" label="Description" rows={2} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => run(async () => { await api.patch(`/admin/plans/${plan.id}`, { ...meta, tagline: meta.tagline || null, description: meta.description || null }); reload(); })}>Save details</Button>
          <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.patch(`/admin/plans/${plan.id}`, { isArchived: !plan.isArchived }); reload(); })}>{plan.isArchived ? 'Restore plan' : 'Archive plan'}</Button>
          <span className="self-center text-xs text-ink-500">Code {plan.code} (permanent)</span>
        </div>
      </Card>

      <Card title="Versions" action={!draft && <Button size="sm" onClick={() => run(async () => { const d = await api.post<{ id: string }>(`/admin/plans/${plan.id}/versions`, {}); await reload(); setViewId(d.id); })}>New draft from live version</Button>}>
        <div className="flex flex-wrap gap-2">
          {plan.versions.map((v) => <button key={v.id} onClick={() => setViewId(v.id)} className={`rounded-lg border px-3 py-1 text-sm ${view?.id === v.id ? 'border-brand-400 bg-brand-50' : 'border-ink-100'}`}>v{v.version} <Badge tone={statusTone[v.status]}>{v.status.toLowerCase()}</Badge>{v.contracts > 0 && <span className="ml-1 text-xs text-ink-500">{v.contracts} contract{v.contracts === 1 ? '' : 's'}</span>}</button>)}
        </div>
      </Card>
      {view && <VersionEditor key={view.id + view.status} plan={plan} version={view} catalog={catalog} reload={reload} run={run} />}
    </div>
  );
}

function VersionEditor({ plan, version, catalog, reload, run }: { plan: Plan; version: Version; catalog: Catalog; reload: () => void; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const editable = version.status === 'DRAFT';
  const [v, setV] = useState({ price: dollars(version.subscriptionCents), interval: version.interval, perLocation: version.perLocation, setup: dollars(version.setupFeeCents), trialDays: version.trialDays, notes: version.notes || '' });
  const [fees, setFees] = useState<FeeRuleDto[]>(version.fees.map(({ id: _id, ...f }) => f));
  const [feats, setFeats] = useState<Record<string, { enabled: boolean; limitValue: number | null }>>(() => Object.fromEntries(version.features.map((f) => [f.key, { enabled: f.enabled, limitValue: f.limitValue }])));
  const [approver, setApprover] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => setDirty(false), [version.id]);
  const mark = <T,>(fn: (x: T) => void) => (x: T) => { fn(x); setDirty(true); };
  const save = () => api.patch(`/admin/plan-versions/${version.id}`, {
    subscriptionCents: toCents(v.price), interval: v.interval, perLocation: v.perLocation, setupFeeCents: toCents(v.setup), trialDays: Number(v.trialDays) || 0, notes: v.notes || null,
    fees: fees.map((f) => ({ ...f, bps: Math.round(f.bps), cents: Math.round(f.cents), capCents: f.capCents ?? null, label: f.label || null })),
    features: catalog.features.map((c) => ({ key: c.key, enabled: !!feats[c.key]?.enabled, limitValue: c.kind === 'LIMIT' ? feats[c.key]?.limitValue ?? null : null })).filter((f) => f.enabled || f.limitValue != null),
  });
  const setFee = (i: number, patch: Partial<FeeRuleDto>) => mark(() => setFees((all) => all.map((f, j) => (j === i ? { ...f, ...patch } : f))))(undefined);
  const unit = (t: string) => FEE_TYPES.find((x) => x.key === t)?.unit || 'bps';
  return (
    <div className="space-y-4">
      {!editable && <Alert tone="info">v{version.version} is {version.status.toLowerCase()}{version.publishedAt ? ` (published ${when(version.publishedAt)})` : ''} and can&apos;t be edited. Create a new draft to change this plan; {version.contracts} contract{version.contracts === 1 ? '' : 's'} keep these terms.</Alert>}
      <Card title={`Price · v${version.version}`}>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input label="Subscription (USD)" disabled={!editable} value={v.price} onChange={(e) => mark(setV)({ ...v, price: e.target.value })} />
          <Select label="Billed" disabled={!editable} value={v.interval} onChange={(e) => mark(setV)({ ...v, interval: e.target.value as 'MONTH' | 'YEAR' })}><option value="MONTH">Monthly</option><option value="YEAR">Yearly</option></Select>
          <Input label="Setup fee (USD)" disabled={!editable} value={v.setup} onChange={(e) => mark(setV)({ ...v, setup: e.target.value })} />
          <Input label="Free trial (days)" type="number" disabled={!editable} value={v.trialDays} onChange={(e) => mark(setV)({ ...v, trialDays: Number(e.target.value) })} />
          <label className="flex items-end gap-1 pb-2 text-sm"><input type="checkbox" disabled={!editable} checked={v.perLocation} onChange={(e) => mark(setV)({ ...v, perLocation: e.target.checked })} /> Per location</label>
        </div>
        <Input className="mt-2" label="Internal notes (why this version changed)" disabled={!editable} value={v.notes} onChange={(e) => mark(setV)({ ...v, notes: e.target.value })} />
      </Card>

      <Card title="Fees" action={editable && <Button size="sm" variant="secondary" onClick={() => mark(setFees)([...fees, { type: 'COMMISSION', channel: 'NETWORK', fulfillment: 'ANY', bps: 0, cents: 0, capCents: null }])}>Add fee rule</Button>}>
        <p className="mb-2 text-xs text-ink-500">For each order or booking, the most specific matching rule applies: an exact channel beats “Gutad network”, which beats “Any”; an exact fulfillment beats “Any”.</p>
        <div className="space-y-2">
          {fees.map((f, i) => (
            <div key={i} className="grid items-end gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-[1.3fr_1.3fr_1fr_0.7fr_0.7fr_0.7fr_auto]">
              <Select label="Type" disabled={!editable} value={f.type} onChange={(e) => setFee(i, { type: e.target.value as FeeRuleDto['type'] })}>{FEE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
              <Select label="Channel" disabled={!editable} value={f.channel} onChange={(e) => setFee(i, { channel: e.target.value })}>{FEE_CHANNELS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
              <Select label="Fulfillment" disabled={!editable} value={f.fulfillment} onChange={(e) => setFee(i, { fulfillment: e.target.value })}>{FEE_FULFILLMENTS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
              <Input label="Percent" disabled={!editable || unit(f.type) === 'cents'} value={f.bps / 100} onChange={(e) => setFee(i, { bps: Math.round(Number(e.target.value || 0) * 100) })} />
              <Input label="Fixed $" disabled={!editable || unit(f.type) === 'bps'} value={dollars(f.cents)} onChange={(e) => setFee(i, { cents: toCents(e.target.value) })} />
              <Input label="Cap $" disabled={!editable} value={f.capCents == null ? '' : dollars(f.capCents)} placeholder="none" onChange={(e) => setFee(i, { capCents: e.target.value === '' ? null : toCents(e.target.value) })} />
              {editable ? <Button size="sm" variant="ghost" onClick={() => mark(setFees)(fees.filter((_, j) => j !== i))}>Remove</Button> : <span />}
              <p className="text-xs text-ink-500 sm:col-span-7">{describeFee(f)}</p>
            </div>
          ))}
          {!fees.length && <p className="text-sm text-ink-500">No fees: orders and bookings fall back to platform defaults.</p>}
        </div>
      </Card>

      <Card title="Features">
        <div className="grid gap-1 sm:grid-cols-2">
          {catalog.features.filter((c) => c.isActive).map((c) => (
            <label key={c.key} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-sm hover:bg-ink-50">
              <span className="flex items-center gap-2">
                {c.kind === 'BOOLEAN' && <input type="checkbox" disabled={!editable} checked={!!feats[c.key]?.enabled} onChange={(e) => mark(setFeats)({ ...feats, [c.key]: { enabled: e.target.checked, limitValue: null } })} />}
                <span>{c.name}<span className="block text-[11px] text-ink-500">{c.description}</span></span>
              </span>
              {c.kind === 'LIMIT' && <input className="w-20 rounded border border-ink-100 px-2 py-1 text-right" type="number" min={0} disabled={!editable} value={feats[c.key]?.limitValue ?? ''} placeholder="∞" onChange={(e) => mark(setFeats)({ ...feats, [c.key]: { enabled: e.target.value !== '', limitValue: e.target.value === '' ? null : Number(e.target.value) } })} />}
            </label>
          ))}
        </div>
      </Card>

      <Preview fees={fees} subscriptionCents={toCents(v.price)} interval={v.interval} />

      {editable && (
        <Card title="Save & publish">
          <div className="flex flex-wrap items-end gap-2">
            <Button variant="secondary" onClick={() => run(async () => { await save(); setDirty(false); reload(); })}>Save draft</Button>
            {catalog.requireSecondApprover && <Input label="Approving admin's email" value={approver} onChange={(e) => setApprover(e.target.value)} />}
            <Button onClick={() => run(async () => { await save(); await api.post(`/admin/plan-versions/${version.id}/publish`, { approverEmail: approver || undefined }); reload(); })}>Publish v{version.version}</Button>
            <Button variant="ghost" onClick={() => run(async () => { await api.delete(`/admin/plan-versions/${version.id}`); reload(); })}>Delete draft</Button>
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          </div>
          <p className="mt-2 text-xs text-ink-500">Publishing makes v{version.version} the version new Order Forms for {plan.name} use and retires the current one. Merchants already signed stay on their version.{catalog.requireSecondApprover ? ' A second platform admin must approve.' : ''}</p>
        </Card>
      )}
    </div>
  );
}

/** What a typical merchant would pay in a month under these rules, using the same resolver the API charges with. */
function Preview({ fees, subscriptionCents, interval }: { fees: FeeRuleDto[]; subscriptionCents: number; interval: string }) {
  const [x, setX] = useState({ deliveries: 300, pickups: 150, avg: 30, networkCovers: 200, directCovers: 300 });
  const r = useMemo(() => {
    const avg = x.avg * 100;
    const c = (ch: string, ful: string, n: number) => n * feeAmount(resolveFee(fees, 'COMMISSION', ch, ful), avg);
    const delivery = c('MARKETPLACE', 'DELIVERY', x.deliveries);
    const pickup = c('MARKETPLACE', 'PICKUP', x.pickups);
    const covers = x.networkCovers * feeAmount(resolveFee(fees, 'COVER_FEE', 'MARKETPLACE', 'DINE_IN'), 0) + x.directCovers * feeAmount(resolveFee(fees, 'COVER_FEE', 'WIDGET', 'DINE_IN'), 0);
    const processing = (x.deliveries + x.pickups) * feeAmount(resolveFee(fees, 'PROCESSING', 'MARKETPLACE'), avg);
    const sub = interval === 'YEAR' ? Math.round(subscriptionCents / 12) : subscriptionCents;
    return { delivery, pickup, covers, processing, sub, total: delivery + pickup + covers + processing + sub };
  }, [fees, subscriptionCents, interval, x]);
  const n = (k: keyof typeof x, label: string) => <Input label={label} type="number" value={x[k]} onChange={(e) => setX({ ...x, [k]: Number(e.target.value) })} />;
  return (
    <Card title="Monthly cost preview">
      <div className="grid gap-2 sm:grid-cols-5">{n('deliveries', 'Marketplace deliveries')}{n('pickups', 'Marketplace pickups')}{n('avg', 'Average order $')}{n('networkCovers', 'Gutad covers')}{n('directCovers', 'Own-site covers')}</div>
      <div className="mt-3 grid gap-1 text-sm sm:grid-cols-3">
        <span>Subscription: <b>{money(r.sub)}</b></span><span>Delivery commission: <b>{money(r.delivery)}</b></span><span>Pickup commission: <b>{money(r.pickup)}</b></span>
        <span>Cover fees: <b>{money(r.covers)}</b></span><span>Card processing: <b>{money(r.processing)}</b></span><span>Total to Gutad: <b className="text-brand-700">{money(r.total)}</b></span>
      </div>
    </Card>
  );
}

function FeaturesTab({ features, reload }: { features: Feature[]; reload: () => void }) {
  const blank = { key: '', name: '', description: '', kind: 'BOOLEAN' as 'BOOLEAN' | 'LIMIT', productLine: 'ALL', sortOrder: (features.length + 1) * 10, isActive: true };
  const [f, setF] = useState(blank);
  const { run, error } = useAction();
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title="Feature list">
        <ul className="divide-y divide-ink-100 text-sm">
          {features.map((x) => (
            <li key={x.key} className={`flex items-center justify-between gap-2 py-2 ${x.isActive ? '' : 'opacity-50'}`}>
              <span><b>{x.name}</b> <span className="text-xs text-ink-500">{x.key} · {x.kind === 'LIMIT' ? 'limit' : 'on/off'} · {x.productLine.toLowerCase()}</span><span className="block text-xs text-ink-500">{x.description}</span></span>
              <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setF({ ...x, description: x.description || '' })}>Edit</Button><Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post('/admin/features', { ...x, isActive: !x.isActive }); reload(); })}>{x.isActive ? 'Hide' : 'Show'}</Button></div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={features.some((x) => x.key === f.key) ? `Edit ${f.key}` : 'Add feature'}>
        <div className="space-y-2">
          <Input label="Key (permanent, e.g. loyalty)" value={f.key} disabled={features.some((x) => x.key === f.key)} onChange={(e) => setF({ ...f, key: e.target.value })} />
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'BOOLEAN' | 'LIMIT' })}><option value="BOOLEAN">On/off</option><option value="LIMIT">Number limit</option></Select>
          <Select label="Product line" value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })}><option value="ALL">All</option><option value="ORDERING">Ordering</option><option value="RESERVATIONS">Reservations</option></Select>
          <Input label="Display order" type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2"><Button size="sm" disabled={f.key.length < 2 || f.name.length < 2} onClick={() => run(async () => { await api.post('/admin/features', { ...f, description: f.description || null }); setF(blank); reload(); })}>Save feature</Button><Button size="sm" variant="ghost" onClick={() => setF(blank)}>Clear</Button></div>
          <p className="text-xs text-ink-500">New features appear on every plan&apos;s editor. Enforcement in the apps for new keys comes with Phase 2 (see docs/PLANS-TRACKER.md).</p>
        </div>
      </Card>
    </div>
  );
}
