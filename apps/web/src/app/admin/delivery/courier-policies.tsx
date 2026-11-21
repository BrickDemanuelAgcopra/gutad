'use client';
import { useState } from 'react';
import type { BatchingConfig, CourierPayPolicy, ReadySyncConfig } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, statusTone, Table } from '@/components/ui';
import { KeyValue } from '@/components/admin-ui';

// Courier Release 2 admin: market policies, batching preview, partner reconciliation, provider connectivity test.

interface Market { regionId: string; regionName: string; pay: Partial<CourierPayPolicy>; batching: Partial<BatchingConfig>; version: number; updatedAt: string; updatedBy: string | null }
interface Policies { global: { pay: CourierPayPolicy; batching: BatchingConfig; readySync: ReadySyncConfig }; markets: Market[]; regions: { id: string; name: string; parentId: string | null }[] }
interface Effective { market: { id: string; name: string } | null; pay: CourierPayPolicy; batching: BatchingConfig; readySync: ReadySyncConfig }

type PayKey = Exclude<keyof CourierPayPolicy, 'version'>;
const PAY: { key: PayKey; label: string; unit: 'money' | 'min' | 'h' }[] = [
  { key: 'baseCents', label: 'Base pay', unit: 'money' },
  { key: 'perKmCents', label: 'Per km', unit: 'money' },
  { key: 'perMinuteCents', label: 'Per minute', unit: 'money' },
  { key: 'waitingGraceMinutes', label: 'Pickup wait grace', unit: 'min' },
  { key: 'waitingPerMinuteCents', label: 'Waiting per minute', unit: 'money' },
  { key: 'waitingCapMinutes', label: 'Waiting paid up to', unit: 'min' },
  { key: 'dropoffGraceMinutes', label: 'Drop-off wait grace', unit: 'min' },
  { key: 'returnCents', label: 'Return to kitchen', unit: 'money' },
  { key: 'cancelAfterArrivalCents', label: 'Canceled after arrival', unit: 'money' },
  { key: 'holdHours', label: 'Earnings hold', unit: 'h' },
];
type BatchNumKey = 'maxOrders' | 'readyWindowMinutes' | 'maxBearingDiff' | 'maxExtraMinutes' | 'maxDropoffSpreadKm';
const BATCH_NUM: { key: BatchNumKey; label: string; unit: string }[] = [
  { key: 'maxOrders', label: 'Max orders per batch', unit: '' },
  { key: 'readyWindowMinutes', label: 'Ready within', unit: 'min' },
  { key: 'maxBearingDiff', label: 'Max direction difference', unit: '°' },
  { key: 'maxExtraMinutes', label: 'Max extra minutes', unit: 'min' },
  { key: 'maxDropoffSpreadKm', label: 'Max drop-off spread', unit: 'km' },
];
type BatchBoolKey = 'enabled' | 'allowMixedTemperature';
const BATCH_BOOL: { key: BatchBoolKey; label: string }[] = [
  { key: 'enabled', label: 'Batching' },
  { key: 'allowMixedTemperature', label: 'Hot and cold together' },
];
const REQUIREMENTS = ['ALCOHOL', 'LARGE_ORDER', 'COLD_BAG', 'HOT_BAG'];
const reqLabel = (r: string) => r.toLowerCase().replace(/_/g, ' ');

const payValue = (unit: 'money' | 'min' | 'h', v: number) => (unit === 'money' ? money(v) : unit === 'min' ? `${v} min` : `${v} h`);
const onOff = (b: boolean) => (b ? 'on' : 'off');

function payRows(p: Partial<CourierPayPolicy>): [string, React.ReactNode][] {
  return PAY.filter((f) => p[f.key] !== undefined).map((f) => [f.label, payValue(f.unit, p[f.key] as number)]);
}
function batchRows(b: Partial<BatchingConfig>): [string, React.ReactNode][] {
  return [
    ...BATCH_BOOL.filter((f) => b[f.key] !== undefined).map((f): [string, React.ReactNode] => [f.label, onOff(b[f.key] as boolean)]),
    ...BATCH_NUM.filter((f) => b[f.key] !== undefined).map((f): [string, React.ReactNode] => [f.label, `${b[f.key]}${f.unit ? ` ${f.unit}` : ''}`]),
    ...(b.excludeRequirements !== undefined ? [['Never batch', b.excludeRequirements.length ? b.excludeRequirements.map(reqLabel).join(', ') : 'nothing'] as [string, React.ReactNode]] : []),
  ];
}
function readyRows(r: ReadySyncConfig): [string, React.ReactNode][] {
  return [['Ready sync', onOff(r.enabled)], ['Offer lead', `${r.offerLeadMinutes} min`], ['Travel to pickup', `${r.pickupTravelMinutes} min`], ['Partner resync at', `${r.resyncMinutes} min change`], ['Default prep', `${r.defaultPrepMinutes} min`]];
}
function overrideSummary(m: Market) {
  const parts = [...payRows(m.pay), ...batchRows(m.batching)].map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(' · ') : 'nothing (uses global)';
}

interface Form { regionId: string; pay: Record<string, string>; num: Record<string, string>; bool: Record<string, '' | 'true' | 'false'>; excl: string[] | null; reason: string }
const emptyForm = (): Form => ({ regionId: '', pay: {}, num: {}, bool: {}, excl: null, reason: '' });
function formFrom(m: Market): Form {
  const pay: Record<string, string> = {};
  for (const f of PAY) { const v = m.pay[f.key]; if (typeof v === 'number') pay[f.key] = f.unit === 'money' ? (v / 100).toFixed(2) : String(v); }
  const num: Record<string, string> = {};
  for (const f of BATCH_NUM) { const v = m.batching[f.key]; if (typeof v === 'number') num[f.key] = String(v); }
  const bool: Form['bool'] = {};
  for (const f of BATCH_BOOL) { const v = m.batching[f.key]; if (typeof v === 'boolean') bool[f.key] = v ? 'true' : 'false'; }
  return { regionId: m.regionId, pay, num, bool, excl: m.batching.excludeRequirements ? [...m.batching.excludeRequirements] : null, reason: '' };
}
/** Only filled-in keys are sent; blank means "inherit the global value". Money is typed in dollars, sent in cents. */
function bodyFrom(f: Form): { pay: Record<string, number>; batching: Record<string, unknown>; bad: string | null } {
  const pay: Record<string, number> = {};
  const batching: Record<string, unknown> = {};
  for (const p of PAY) {
    const s = (f.pay[p.key] || '').trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { pay, batching, bad: `${p.label} must be a number of 0 or more` };
    pay[p.key] = p.unit === 'money' ? Math.round(n * 100) : Math.round(n);
  }
  for (const b of BATCH_NUM) {
    const s = (f.num[b.key] || '').trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { pay, batching, bad: `${b.label} must be a number of 0 or more` };
    batching[b.key] = n;
  }
  for (const b of BATCH_BOOL) if (f.bool[b.key]) batching[b.key] = f.bool[b.key] === 'true';
  if (f.excl) batching.excludeRequirements = f.excl;
  return { pay, batching, bad: null };
}

export function CourierPolicies() {
  const { data, reload, error: loadError } = useApi<Policies>('/admin/delivery/policies');
  const { can } = useSession();
  const { run, error, busy } = useAction();
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<{ regionId: string; name: string; reason: string } | null>(null);
  const manage = can('delivery.manage');
  if (loadError && !data) return <Alert>{loadError}</Alert>;
  if (!data) return null;
  const check = form ? bodyFrom(form) : null;
  const taken = new Set(data.markets.map((m) => m.regionId));
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Courier pay (global)"><KeyValue rows={payRows(data.global.pay)} /></Card>
        <Card title="Batching (global)"><KeyValue rows={batchRows(data.global.batching)} /></Card>
        <Card title="Kitchen-ready sync (global)"><KeyValue rows={readyRows(data.global.readySync)} /></Card>
      </div>
      <p className="text-xs text-ink-500">Global values are edited under Settings, keys <code>delivery.pay</code>, <code>delivery.batching</code> and <code>delivery.readySync</code>. A market override replaces only the values it sets.</p>

      <Card title="Market overrides" action={manage && <Button size="sm" onClick={() => { setForm(emptyForm()); setEditing(false); }}>Add market</Button>}>
        <Table rows={data.markets} empty="No market overrides. Every market uses the global values." cols={[
          { key: 'r', label: 'Market', render: (m) => <b>{m.regionName}</b> },
          { key: 'v', label: 'Version', render: (m) => `v${m.version}` },
          { key: 'o', label: 'Overrides', render: (m) => <span className="text-xs">{overrideSummary(m)}</span> },
          { key: 'u', label: 'Updated', render: (m) => <span className="text-xs">{when(m.updatedAt)}</span> },
          { key: 'a', label: '', render: (m) => manage ? <span className="flex flex-wrap gap-1"><Button size="sm" variant="secondary" onClick={() => { setForm(formFrom(m)); setEditing(true); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setRemoving({ regionId: m.regionId, name: m.regionName, reason: '' })}>Remove</Button></span> : null },
        ]} />
        {removing && (
          <div className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="text-sm">Remove the override for <b>{removing.name}</b>? Couriers there go back to the global values.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Input className="min-w-0 flex-1" label="Reason (saved in the audit trail)" value={removing.reason} onChange={(e) => setRemoving({ ...removing, reason: e.target.value })} />
              <Button size="sm" variant="danger" disabled={busy || removing.reason.trim().length < 3} onClick={() => run(async () => { await api.request('DELETE', `/admin/delivery/policies/markets/${removing.regionId}`, { reason: removing.reason.trim() }); setRemoving(null); await reload(); })}>Remove</Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <EffectivePolicy regions={data.regions} />

      <Modal open={!!form} onClose={() => setForm(null)} title={editing ? 'Edit market override' : 'Add market override'}>
        {form && check && <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <Select label="Market (region)" value={form.regionId} disabled={editing} onChange={(e) => setForm({ ...form, regionId: e.target.value })}>
            <option value="">Choose…</option>
            {data.regions.filter((r) => editing || !taken.has(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          <p className="text-xs text-ink-500">Leave a field blank to use the global value (shown as the placeholder).</p>
          <div>
            <h4 className="mb-1 text-sm font-semibold">Pay</h4>
            <div className="grid grid-cols-2 gap-2">
              {PAY.map((p) => <Input key={p.key} inputMode="decimal" label={`${p.label}${p.unit === 'money' ? ' ($)' : p.unit === 'min' ? ' (min)' : ' (hours)'}`} placeholder={p.unit === 'money' ? (data.global.pay[p.key] / 100).toFixed(2) : String(data.global.pay[p.key])} value={form.pay[p.key] || ''} onChange={(e) => setForm({ ...form, pay: { ...form.pay, [p.key]: e.target.value } })} />)}
            </div>
          </div>
          <div>
            <h4 className="mb-1 text-sm font-semibold">Batching</h4>
            <div className="grid grid-cols-2 gap-2">
              {BATCH_BOOL.map((b) => <Select key={b.key} label={b.label} value={form.bool[b.key] || ''} onChange={(e) => setForm({ ...form, bool: { ...form.bool, [b.key]: e.target.value as '' | 'true' | 'false' } })}><option value="">Global ({onOff(data.global.batching[b.key])})</option><option value="true">On</option><option value="false">Off</option></Select>)}
              {BATCH_NUM.map((b) => <Input key={b.key} inputMode="decimal" label={`${b.label}${b.unit ? ` (${b.unit})` : ''}`} placeholder={String(data.global.batching[b.key])} value={form.num[b.key] || ''} onChange={(e) => setForm({ ...form, num: { ...form.num, [b.key]: e.target.value } })} />)}
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.excl !== null} onChange={(e) => setForm({ ...form, excl: e.target.checked ? [...data.global.batching.excludeRequirements] : null })} /> Set which orders are never batched here</label>
            {form.excl === null
              ? <p className="text-xs text-ink-500">Global: {data.global.batching.excludeRequirements.length ? data.global.batching.excludeRequirements.map(reqLabel).join(', ') : 'nothing'}.</p>
              : <div className="mt-1 flex flex-wrap gap-3">{REQUIREMENTS.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.excl!.includes(r)} onChange={(e) => setForm({ ...form, excl: e.target.checked ? [...form.excl!, r] : form.excl!.filter((x) => x !== r) })} /> {reqLabel(r)}</label>)}</div>}
          </div>
          <Input label="Reason (saved in the audit trail)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          {check.bad && <p className="text-xs text-red-700">{check.bad}</p>}
          <Button disabled={busy || !form.regionId || form.reason.trim().length < 3 || !!check.bad} onClick={() => run(async () => { await api.put(`/admin/delivery/policies/markets/${form.regionId}`, { pay: check.pay, batching: check.batching, reason: form.reason.trim() }); setForm(null); await reload(); })}>Save</Button>
        </div>}
      </Modal>
    </div>
  );
}

function EffectivePolicy({ regions }: { regions: Policies['regions'] }) {
  const { data: net } = useApi<{ locations: { id: string; name: string }[] }>('/admin/delivery/network');
  const { run, error, busy } = useAction();
  const [by, setBy] = useState<'location' | 'region'>('location');
  const [target, setTarget] = useState('');
  const [r, setR] = useState<Effective | null>(null);
  return (
    <Card title="Effective policy">
      {error && <Alert>{error}</Alert>}
      <p className="mb-2 text-sm text-ink-500">What couriers are actually paid and how orders are batched at a location or market, after overrides.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="For" value={by} onChange={(e) => { setBy(e.target.value as 'location' | 'region'); setTarget(''); setR(null); }}><option value="location">Location</option><option value="region">Market (region)</option></Select>
        <Select className="min-w-0 flex-1" label="Which" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{(by === 'location' ? net?.locations : regions)?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Button size="sm" variant="secondary" disabled={!target || busy} onClick={() => run(async () => setR(await api.get<Effective>(`/admin/delivery/policies/effective?${by === 'location' ? 'locationId' : 'regionId'}=${encodeURIComponent(target)}`)))}>Show</Button>
      </div>
      {r && <div className="mt-3 space-y-2">
        <p className="text-sm">Market: <b>{r.market ? r.market.name : 'none (global values)'}</b></p>
        <div className="grid gap-3 md:grid-cols-3">
          <div><h4 className="mb-1 text-sm font-semibold">Pay</h4><KeyValue rows={payRows(r.pay)} /></div>
          <div><h4 className="mb-1 text-sm font-semibold">Batching</h4><KeyValue rows={batchRows(r.batching)} /></div>
          <div><h4 className="mb-1 text-sm font-semibold">Kitchen-ready sync</h4><KeyValue rows={readyRows(r.readySync)} /></div>
        </div>
      </div>}
    </Card>
  );
}

export function BatchingPreview() {
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ jobId: '', withJobId: '' });
  const [r, setR] = useState<{ batchable: boolean; reasons: string[]; market?: { id: string; name: string } | null } | null>(null);
  const valid = (s: string) => s.length >= 30;
  return (
    <Card title="Batching preview">
      {error && <Alert>{error}</Alert>}
      <p className="mb-2 text-sm text-ink-500">Check whether two deliveries could go with one courier, and why not. Uses the first delivery&apos;s market rules.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input className="min-w-0 flex-1" label="Delivery job id" value={f.jobId} onChange={(e) => { setF({ ...f, jobId: e.target.value.trim() }); setR(null); }} />
        <Input className="min-w-0 flex-1" label="With delivery job id" value={f.withJobId} onChange={(e) => { setF({ ...f, withJobId: e.target.value.trim() }); setR(null); }} />
        <Button size="sm" variant="secondary" disabled={busy || !valid(f.jobId) || !valid(f.withJobId)} onClick={() => run(async () => setR(await api.post('/admin/delivery/batching/preview', f)))}>Check</Button>
      </div>
      {r && <div className="mt-3 text-sm">
        <p>{r.batchable ? <Badge tone="good">Can be batched</Badge> : <Badge tone="bad">Not batchable</Badge>}{r.market && <span className="ml-2 text-xs text-ink-500">{r.market.name} rules</span>}</p>
        {r.reasons.length > 0 && <ul className="mt-2 list-disc pl-5">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      </div>}
    </Card>
  );
}

interface Recon { rows: { jobId: string; orderNumber: string | null; provider: string; quotedCents: number; actualCents: number | null; cancelFeeCents: number; varianceCents: number | null; status: string; createdAt: string }[]; totals: { jobs: number; quotedCents: number; actualCents: number; varianceCents: number; unreported: number } }
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const signed = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${money(Math.abs(c))}`;

export function Reconciliation() {
  const { data: names } = useApi<{ primary: string; available: string[] }>('/admin/delivery/provider-names');
  const [f, setF] = useState({ provider: '', from: dayStr(new Date(Date.now() - 30 * 86_400_000)), to: dayStr(new Date()) });
  const qs = new URLSearchParams();
  if (f.provider) qs.set('provider', f.provider);
  if (f.from) qs.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) qs.set('to', new Date(`${f.to}T23:59:59`).toISOString());
  const { data, error } = useApi<Recon>(`/admin/delivery/reconciliation?${qs.toString()}`, { deps: [f.provider, f.from, f.to] });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-ink-500">Partner deliveries: what the partner quoted versus what it charged (including cancellation fees).</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="">All partners</option>{names?.available.filter((p) => p !== 'PLATFORM').map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        <Input type="date" label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input type="date" label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      {data && <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Jobs" value={data.totals.jobs} />
          <Stat label="Quoted" value={money(data.totals.quotedCents)} />
          <Stat label="Actual" value={money(data.totals.actualCents)} hint="reported jobs, with cancel fees" />
          <Stat label="Variance" value={<span className={data.totals.varianceCents ? 'text-red-700' : ''}>{signed(data.totals.varianceCents)}</span>} />
          <Stat label="Not reported" value={data.totals.unreported} />
        </div>
        <Table rows={data.rows} empty="No partner deliveries in this period." cols={[
          { key: 'n', label: 'Order', render: (r) => r.orderNumber ? `#${r.orderNumber}` : <span className="text-xs text-ink-500">{r.jobId.slice(0, 8)}</span> },
          { key: 'p', label: 'Provider', render: (r) => r.provider },
          { key: 'q', label: 'Quoted', render: (r) => money(r.quotedCents) },
          { key: 'a', label: 'Actual', render: (r) => (r.actualCents === null ? <span className="text-xs text-ink-500">not reported</span> : money(r.actualCents)) },
          { key: 'c', label: 'Cancel fee', render: (r) => (r.cancelFeeCents ? money(r.cancelFeeCents) : '—') },
          { key: 'v', label: 'Variance', render: (r) => (r.varianceCents === null ? '—' : r.varianceCents === 0 ? money(0) : <Badge tone={r.varianceCents > 0 ? 'bad' : 'warn'}>{signed(r.varianceCents)}</Badge>) },
          { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
          { key: 'd', label: 'Date', render: (r) => <span className="text-xs">{when(r.createdAt)}</span> },
        ]} />
      </>}
    </div>
  );
}

/** "Test connection" per partner provider: one quote between a location and a nearby point; nothing is created. */
export function ProviderTests({ names }: { names: string[] }) {
  const { can } = useSession();
  const { run } = useAction();
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, { ok: boolean; latencyMs: number; error: string | null; quote?: { feeCents: number; etaMinutes: number } }>>({});
  const partners = names.filter((p) => p !== 'PLATFORM');
  if (!can('delivery.manage') || !partners.length) return null;
  return (
    <Card title="Partner connection">
      <p className="mb-2 text-xs text-ink-500">Asks the partner for one quote near a location. No delivery is created.</p>
      <ul className="divide-y divide-ink-100 text-sm">
        {partners.map((p) => {
          const r = res[p];
          return (
            <li key={p} className="flex flex-wrap items-center gap-2 py-2">
              <b className="min-w-[6rem]">{p}</b>
              <Button size="sm" variant="secondary" disabled={busy === p} onClick={() => { setBusy(p); void run(async () => { try { const out = await api.post<NonNullable<typeof r>>(`/admin/delivery/providers/${encodeURIComponent(p)}/test`, {}); setRes((x) => ({ ...x, [p]: out })); } catch (e) { setRes((x) => ({ ...x, [p]: { ok: false, latencyMs: 0, error: (e as Error).message } })); } finally { setBusy(null); } }); }}>{busy === p ? 'Testing…' : 'Test connection'}</Button>
              {r && (r.ok
                ? <span className="text-xs"><Badge tone="good">ok</Badge> {r.latencyMs} ms{r.quote ? ` · quote ${money(r.quote.feeCents)}, ${r.quote.etaMinutes} min` : ''}</span>
                : <span className="text-xs"><Badge tone="bad">failed</Badge> {r.latencyMs ? `${r.latencyMs} ms · ` : ''}{r.error || 'No response'}</span>)}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
