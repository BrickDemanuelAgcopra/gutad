'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Table, Textarea } from '@/components/ui';

/* ───── 21.6-S forecast factors ───── */

interface ForecastFactorsData { config: { trend: { enabled: boolean; weight: number }; yearOverYear: { enabled: boolean; weight: number }; minFactor: number; maxFactor: number; promotions: { enabled: boolean; upliftPct: number; maxUpliftPct: number } }; horizonDays: number; promotions: { id: string; code: string; name: string | null; kind: string; automatic: boolean; startsAt: string | null; expiresAt: string | null; daysOfWeek: number[]; scope: string; ingredientCount: number | null }[] }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What shapes the forecast: seasonal / trend settings and the promotions expected to lift demand. */
export function ForecastFactors({ kitchenId }: { kitchenId: string }) {
  const { data } = useApi<ForecastFactorsData>(`/kitchens/${kitchenId}/forecast/factors`, { deps: [kitchenId] });
  if (!data) return null;
  const c = data.config;
  return (
    <Card title="Forecast factors">
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div><b>Recent trend</b> {c.trend.enabled ? <span>on · weight {c.trend.weight}</span> : <Badge>off</Badge>}<span className="block text-xs text-ink-500">Last 2 weeks vs the 2 before.</span></div>
        <div><b>Same weeks last year</b> {c.yearOverYear.enabled ? <span>on · weight {c.yearOverYear.weight}</span> : <Badge>off</Badge>}<span className="block text-xs text-ink-500">Upcoming days a year ago vs the 4 weeks before them.</span></div>
        <div><b>Promotion uplift</b> {c.promotions.enabled ? <span>+{c.promotions.upliftPct}% per offer (max {c.promotions.maxUpliftPct}%)</span> : <Badge>off</Badge>}<span className="block text-xs text-ink-500">Seasonal factor kept within {c.minFactor}×–{c.maxFactor}×.</span></div>
      </div>
      <div className="mt-3 text-sm font-semibold">Promotions in the next {data.horizonDays} days</div>
      <Table rows={data.promotions} empty="No automatic offers or campaigns running at this kitchen." cols={[
        { key: 'n', label: 'Offer', render: (p) => <span>{p.name || p.code}{p.automatic && <Badge tone="info">automatic</Badge>}</span> },
        { key: 's', label: 'Applies to', render: (p) => (p.scope === 'MENU' ? 'whole menu' : `${p.ingredientCount ?? 0} ingredient(s) via items`) },
        { key: 'd', label: 'When', render: (p) => <span className="text-xs">{p.startsAt ? when(p.startsAt) : 'now'} → {p.expiresAt ? when(p.expiresAt) : 'open'}{p.daysOfWeek.length ? ` · ${p.daysOfWeek.map((d) => DOW[d]).join(', ')}` : ''}</span> },
      ]} />
      <p className="mt-1 text-xs text-ink-500">Change these in platform settings (key <code>inventory.forecast</code>).</p>
    </Card>
  );
}

/* ───── 21.8-P supplier portal access ───── */

interface PortalAccess { tokens: { id: string; label: string | null; tokenHint: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string; active: boolean }[]; submissions: { id: string; source: string; invoiceNumber: string | null; purchaseOrderId: string | null; status: string; totalCents: number | null; error: string | null; createdAt: string }[] }

/** Issue / revoke a supplier's invoice-portal links and see what they submitted. */
export function SupplierPortalAccess({ supplierId, supplierName, onClose }: { supplierId: string; supplierName: string; onClose: () => void }) {
  const { data, reload } = useApi<PortalAccess>(`/suppliers/${supplierId}/portal-access`, { deps: [supplierId] });
  const { run, error } = useAction();
  const [issued, setIssued] = useState<{ token: string; portalPath: string } | null>(null);
  const [label, setLabel] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Modal open onClose={onClose} title={`Invoice portal · ${supplierName}`}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {issued && <Alert tone="good"><div className="text-xs">Send this link to the supplier (shown once). It also works as the <code>x-supplier-token</code> header for EDI 810 / CSV uploads to <code>POST /supplier-portal/edi</code>.</div><code className="mt-1 block break-all text-xs">{origin}{issued.portalPath}</code></Alert>}
        <div className="flex gap-2"><Input placeholder="Label (e.g. AP inbox)" value={label} onChange={(e) => setLabel(e.target.value)} /><Button onClick={() => run(async () => { const r = await api.post<{ token: string; portalPath: string }>(`/suppliers/${supplierId}/portal-tokens`, { label: label || undefined, expiresInDays: 365 }); setIssued(r); setLabel(''); await reload(); })}>Issue link</Button></div>
        <Table rows={data?.tokens || []} empty="No links issued." cols={[
          { key: 'l', label: 'Link', render: (t) => <span>{t.label || 'link'} <span className="text-xs text-ink-500">…{t.tokenHint}</span></span> },
          { key: 's', label: 'Status', render: (t) => <Badge tone={t.active ? 'good' : 'neutral'}>{t.active ? 'active' : t.revokedAt ? 'revoked' : 'expired'}</Badge> },
          { key: 'u', label: 'Last used', render: (t) => <span className="text-xs">{when(t.lastUsedAt)}</span> },
          { key: 'x', label: '', render: (t) => t.active ? <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/supplier-portal-tokens/${t.id}`); await reload(); })}>Revoke</button> : null },
        ]} />
        <div className="text-sm font-semibold">Submitted invoices</div>
        <Table rows={data?.submissions || []} empty="Nothing submitted yet." cols={[
          { key: 'd', label: 'When', render: (s) => <span className="text-xs">{when(s.createdAt)}</span> },
          { key: 'i', label: 'Invoice', render: (s) => <span>{s.invoiceNumber || '—'}<span className="block text-xs text-ink-500">{s.source.replace('_', ' ')} · PO {s.purchaseOrderId?.slice(0, 8).toUpperCase() || '—'}</span></span> },
          { key: 't', label: 'Total', render: (s) => (s.totalCents == null ? '—' : money(s.totalCents)) },
          { key: 's', label: 'Match', render: (s) => <span><Badge tone={s.status === 'MATCHED' ? 'good' : s.status === 'VARIANCE' ? 'warn' : 'bad'}>{s.status}</Badge>{s.error && <span className="block text-xs text-red-700">{s.error}</span>}</span> },
        ]} />
      </div>
    </Modal>
  );
}

/* ───── 22.2-S temperature sensors ───── */

interface SensorRow { id: string; name: string; storageArea: string | null; storageAreaId: string; vendor: string | null; serial: string | null; tokenHint: string; isOnline: boolean; lastReadingAt: string | null; lastTempC: number | null; lastInRange: boolean | null; batteryPct: number | null; minutesSinceReading: number | null; offlineAfterMinutes: number | null }

/** Wireless sensors per storage area: register, rotate token, retire; readings land in the temperature log. */
export function SensorsCard({ kitchenId, readOnly = false }: { kitchenId: string; readOnly?: boolean }) {
  const { data, reload } = useApi<{ config: { offlineAfterMinutes: number; logEveryMinutes: number }; sensors: SensorRow[] }>(`/kitchens/${kitchenId}/sensors`, { deps: [kitchenId], poll: 60000 });
  const { data: areas } = useApi<{ id: string; name: string }[]>(readOnly ? null : `/kitchens/${kitchenId}/storage-areas`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ areaId: '', name: '', serial: '' });
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  return (
    <Card title="Wireless sensors">
      {error && <Alert>{error}</Alert>}
      {token && <Alert tone="good"><span className="text-xs">Token for {token.name} (shown once). The sensor gateway posts readings to <code>POST /sensors/readings</code> with header <code>x-sensor-token</code>:</span><code className="mt-1 block break-all text-xs">{token.token}</code></Alert>}
      <Table rows={data?.sensors || []} empty="No sensors. Readings are logged by hand." cols={[
        { key: 'n', label: 'Sensor', render: (s) => <span>{s.name}<span className="block text-xs text-ink-500">{s.storageArea}{s.serial ? ` · ${s.serial}` : ''}</span></span> },
        { key: 'o', label: 'Status', render: (s) => <Badge tone={s.isOnline ? 'good' : 'bad'}>{s.isOnline ? 'online' : s.lastReadingAt ? 'offline' : 'waiting'}</Badge> },
        { key: 't', label: 'Last reading', render: (s) => (s.lastTempC == null ? '—' : <span className={s.lastInRange === false ? 'font-semibold text-red-700' : ''}>{s.lastTempC} °C <span className="text-xs text-ink-500">{s.minutesSinceReading} min ago</span></span>) },
        { key: 'b', label: 'Battery', render: (s) => (s.batteryPct == null ? '—' : `${s.batteryPct}%`) },
        { key: 'x', label: '', render: (s) => readOnly ? null : <span className="flex gap-2"><button className="text-xs underline" onClick={() => run(async () => { const r = await api.post<{ token: string }>(`/sensors/${s.id}/rotate-token`, {}); setToken({ name: s.name, token: r.token }); })}>New token</button><button className="text-xs text-red-600" onClick={() => { if (window.confirm(`Retire ${s.name}?`)) run(async () => { await api.delete(`/sensors/${s.id}`); await reload(); }); }}>Retire</button></span> },
      ]} />
      {!readOnly && <div className="mt-2 grid gap-2 sm:grid-cols-4"><Select label="Storage area" value={f.areaId} onChange={(e) => setF({ ...f, areaId: e.target.value })}><option value="">Choose…</option>{areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Serial (optional)" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} /><Button className="self-end" disabled={!f.areaId || f.name.length < 2} onClick={() => run(async () => { const r = await api.post<{ token: string; name: string }>(`/kitchens/${kitchenId}/sensors`, { storageAreaId: f.areaId, name: f.name, serial: f.serial || undefined }); setToken({ name: r.name, token: r.token }); setF({ areaId: '', name: '', serial: '' }); await reload(); })}>Register sensor</Button></div>}
      {data && <p className="mt-1 text-xs text-ink-500">Out-of-range readings raise the same alert and corrective action as a manual reading; in-range readings are logged every {data.config.logEveryMinutes} min. A sensor silent for {data.config.offlineAfterMinutes} min raises an offline alert.</p>}
    </Card>
  );
}

/* ───── 23.3-P payroll provider ───── */

interface PayrollStatus { providers: readonly { key: string; label: string }[]; connection: { provider: string; status: string; externalCompanyId: string | null; hasCredentials: boolean; config: { employeeIds?: Record<string, string> } } | null; batches: { id: string; provider: string; periodStart: string; periodEnd: string; status: string; externalId: string | null; employees: number; regularHours: number; overtimeHours: number; grossCents: number; unapprovedHours: number; attempts: number; lastError: string | null; pushedAt: string | null }[] }

/** Connect a payroll provider and push approved hours (with overtime) per pay period; CSV export stays available. */
export function PayrollProviderCard({ locationId, organizationId, members, from, to }: { locationId: string; organizationId: string; members: { id: string; email: string }[]; from: string; to: string }) {
  const { data, reload } = useApi<PayrollStatus>(`/locations/${locationId}/payroll/provider`, { deps: [locationId] });
  const { run, error } = useAction();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ provider: 'MOCK', companyId: '', accessToken: '', ids: {} as Record<string, string> });
  const [msg, setMsg] = useState<string | null>(null);
  const c = data?.connection;
  const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  return (
    <Card title="Payroll provider" action={<Button size="sm" variant="ghost" onClick={() => { setF({ provider: c?.provider || 'MOCK', companyId: c?.externalCompanyId || '', accessToken: '', ids: c?.config.employeeIds || {} }); setEdit(true); }}>{c && c.status === 'CONNECTED' ? 'Settings' : 'Connect'}</Button>}>
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="info">{msg}</Alert>}
      {c && c.status === 'CONNECTED' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="good">{data?.providers.find((p) => p.key === c.provider)?.label || c.provider}</Badge><span className="text-xs text-ink-500">{c.externalCompanyId || ''}</span>
          <Button size="sm" onClick={() => run(async () => { const r = await api.post<{ batch: { status: string; employees: number; regularHours: number; overtimeHours: number; lastError: string | null }; alreadyPushed: boolean }>(`/locations/${locationId}/payroll/push`, { periodStart: from, periodEnd: end }); setMsg(r.alreadyPushed ? 'This pay period was already sent.' : r.batch.status === 'PUSHED' ? `Sent ${r.batch.employees} people: ${r.batch.regularHours} regular + ${r.batch.overtimeHours} overtime hours.` : `Not sent: ${r.batch.lastError}`); await reload(); })}>Send approved hours {from} → {to}</Button>
          <button className="text-xs text-red-600" onClick={() => { if (window.confirm('Disconnect payroll?')) run(async () => { await api.delete(`/organizations/${organizationId}/payroll/connection`); await reload(); }); }}>Disconnect</button>
        </div>
      ) : <p className="text-sm text-ink-500">No provider connected: use the CSV export above.</p>}
      <Table rows={data?.batches || []} empty="No pay periods sent yet." cols={[
        { key: 'p', label: 'Pay period', render: (b) => `${b.periodStart} → ${b.periodEnd}` },
        { key: 's', label: 'Status', render: (b) => <span><Badge tone={statusTone(b.status === 'PUSHED' ? 'COMPLETED' : b.status === 'FAILED' ? 'FAILED' : 'PENDING')}>{b.status}</Badge>{b.lastError && <span className="block text-xs text-red-700">{b.lastError}</span>}</span> },
        { key: 'h', label: 'Hours (OT)', render: (b) => `${b.regularHours} (${b.overtimeHours})` }, { key: 'g', label: 'Gross', render: (b) => money(b.grossCents) },
        { key: 'r', label: 'Ref', render: (b) => <span className="text-xs">{b.externalId || '—'}{b.unapprovedHours ? ` · ${b.unapprovedHours} h unapproved` : ''}</span> },
        { key: 'x', label: '', render: (b) => b.status === 'FAILED' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/payroll-batches/${b.id}/retry`, {}); await reload(); })}>Retry</Button> : null },
      ]} />
      <Modal open={edit} onClose={() => setEdit(false)} title="Payroll provider">
        <div className="space-y-2">
          <Select label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{data?.providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select>
          {f.provider !== 'MOCK' && <><Input label={f.provider === 'GUSTO' ? 'Gusto company id' : 'ADP payroll group code'} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })} /><Input label={`Access token${c?.hasCredentials ? ' (leave empty to keep)' : ''}`} type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} />
            <div className="text-xs font-semibold text-ink-500">Employee ids at {f.provider}</div>
            {members.map((m) => <Input key={m.id} label={m.email} value={f.ids[m.id] || ''} onChange={(e) => setF({ ...f, ids: { ...f.ids, [m.id]: e.target.value } })} />)}</>}
          <Button onClick={() => run(async () => { await api.post(`/organizations/${organizationId}/payroll/connection`, { provider: f.provider, externalCompanyId: f.provider === 'MOCK' ? null : f.companyId || null, credentials: f.accessToken ? { accessToken: f.accessToken } : undefined, employeeIds: Object.fromEntries(Object.entries(f.ids).filter(([, v]) => v)) }); setEdit(false); await reload(); })}>Save</Button>
          <p className="text-xs text-ink-500">Only approved hours are sent, with overtime above the weekly threshold. Each pay period is sent once; a failed send can be retried.</p>
        </div>
      </Modal>
    </Card>
  );
}

/* ───── 23.8-V equipment vendor link ───── */

interface VendorData { vendors: readonly { key: string; label: string }[]; link: { vendor: string; externalId: string; tokenHint: string; pollEnabled: boolean; isActive: boolean; canPull: boolean; hasCredentials: boolean; lastEventAt: string | null; lastPolledAt: string | null; lastStatus: { status?: string; metrics?: Record<string, number> } | null; lastError: string | null; config: { telemetryLimits?: Record<string, { min?: number; max?: number }> } } | null; events: { id: string; kind: string; code: string | null; severity: string | null; message: string | null; metrics: Record<string, number> | null; alerted: boolean; occurredAt: string }[] }

/** Vendor feed for one automated machine: telemetry, maintenance and faults in; never commands out. */
export function EquipmentVendorPanel({ equipmentId, name, onClose }: { equipmentId: string; name: string; onClose: () => void }) {
  const { data, reload } = useApi<VendorData>(`/equipment/${equipmentId}/vendor-link`, { deps: [equipmentId] });
  const { run, error } = useAction();
  const l = data?.link;
  const [f, setF] = useState<{ vendor: string; externalId: string; accessToken: string; poll: boolean; limits: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const form = f ?? { vendor: l?.vendor || 'GENERIC', externalId: l?.externalId || '', accessToken: '', poll: l?.pollEnabled ?? false, limits: l?.config.telemetryLimits ? JSON.stringify(l.config.telemetryLimits) : '' };
  return (
    <Modal open onClose={onClose} title={`Vendor feed · ${name}`}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {token && <Alert tone="good"><span className="text-xs">Push token (shown once): the vendor posts to <code>POST /equipment-vendor/events</code> with header <code>x-vendor-token</code>.</span><code className="mt-1 block break-all text-xs">{token}</code></Alert>}
        {l && l.isActive && <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="good">{data?.vendors.find((v) => v.key === l.vendor)?.label || l.vendor}</Badge><span className="text-xs text-ink-500">{l.externalId} · token …{l.tokenHint}</span>{l.lastStatus?.status && <Badge tone={l.lastStatus.status === 'OK' ? 'good' : 'bad'}>{l.lastStatus.status}</Badge>}{l.lastError && <span className="text-xs text-red-700">{l.lastError}</span>}{l.canPull && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/equipment/${equipmentId}/vendor-link/poll`, {}); await reload(); })}>Pull status</Button>}<button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/equipment/${equipmentId}/vendor-link`); await reload(); })}>Unlink</button></div>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Select label="Vendor" value={form.vendor} onChange={(e) => setF({ ...form, vendor: e.target.value })}>{data?.vendors.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</Select>
          <Input label="Vendor machine id" value={form.externalId} onChange={(e) => setF({ ...form, externalId: e.target.value })} />
          {form.vendor !== 'GENERIC' && form.vendor !== 'MOCK' && <Input label={`API credential${l?.hasCredentials ? ' (leave empty to keep)' : ''}`} type="password" value={form.accessToken} onChange={(e) => setF({ ...form, accessToken: e.target.value })} />}
          {form.vendor !== 'GENERIC' && <label className="flex items-center gap-1 self-end text-sm"><input type="checkbox" checked={form.poll} onChange={(e) => setF({ ...form, poll: e.target.checked })} /> Pull status every 5 min</label>}
        </div>
        <Textarea label='Telemetry limits (JSON, e.g. {"oilTempC":{"max":190}})' value={form.limits} onChange={(e) => setF({ ...form, limits: e.target.value })} />
        <div className="flex gap-2">
          <Button disabled={!form.externalId} onClick={() => run(async () => { let limits: unknown; try { limits = form.limits ? JSON.parse(form.limits) : undefined; } catch { throw new Error('Telemetry limits must be JSON'); } const r = await api.put<{ token?: string }>(`/equipment/${equipmentId}/vendor-link`, { vendor: form.vendor, externalId: form.externalId, credentials: form.accessToken ? (form.vendor === 'WELBILT' ? { apiKey: form.accessToken } : { accessToken: form.accessToken }) : undefined, pollEnabled: form.vendor !== 'GENERIC' && form.poll, config: limits ? { telemetryLimits: limits } : {} }); if (r.token) setToken(r.token); setF(null); await reload(); })}>Save link</Button>
          {l && <Button variant="ghost" onClick={() => run(async () => { const r = await api.put<{ token?: string }>(`/equipment/${equipmentId}/vendor-link`, { vendor: l.vendor, externalId: l.externalId, pollEnabled: l.pollEnabled, rotateToken: true }); if (r.token) setToken(r.token); await reload(); })}>New push token</Button>}
        </div>
        <Table rows={data?.events || []} empty="No vendor events yet." cols={[
          { key: 'd', label: 'When', render: (e) => <span className="text-xs">{when(e.occurredAt)}</span> },
          { key: 'k', label: 'Event', render: (e) => <span>{e.kind.toLowerCase()} {e.code && <span className="text-xs">{e.code}</span>}{e.severity && <Badge tone={e.severity === 'CRITICAL' || e.severity === 'HIGH' ? 'bad' : 'neutral'}>{e.severity}</Badge>}</span> },
          { key: 'm', label: 'Detail', render: (e) => <span className="text-xs">{e.message}{e.metrics ? ` ${Object.entries(e.metrics).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}</span> },
          { key: 'a', label: '', render: (e) => (e.alerted ? <Badge tone="warn">alerted</Badge> : null) },
        ]} />
        <p className="text-xs text-ink-500">Faults open tickets and alerts, maintenance events update the service record, telemetry outside the limits raises an alert. Gutad never sends commands to the machine.</p>
      </div>
    </Modal>
  );
}

/* ───── 20.1-L / 20.7-L accounting ───── */

interface GlData { legalEntity: string; mode: 'PUSH' | 'CSV'; providers: readonly { key: string; label: string }[]; connection: { provider: string; status: string; externalTenantId: string | null; hasCredentials: boolean; lastPushAt: string | null; lastError: string | null } | null; batches: { id: string; period: string; provider: string; status: string; externalId: string | null; lines: number; debitCents: number; attempts: number; lastError: string | null; nextRetryAt: string | null; pushedAt: string | null }[] }

/** Connect QuickBooks Online / Xero and push closed months; without a connection the CSV export is used. */
export function GlPushCard({ canManage }: { canManage: boolean }) {
  const { data, reload } = useApi<GlData>('/accounting/gl/connection');
  const { run, error } = useAction();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ provider: 'MOCK', tenantId: '', accessToken: '' });
  const [period, setPeriod] = useState(() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); });
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const c = data.connection;
  const pushOnce = async (allowOpen: boolean): Promise<void> => {
    const r = await api.post<{ batch: { status: string; externalId: string | null; lastError: string | null }; alreadyPushed: boolean }>('/accounting/gl/push', { period, allowOpen });
    setMsg(r.alreadyPushed ? `${period} was already pushed (${r.batch.externalId}).` : r.batch.status === 'PUSHED' ? `${period} pushed as ${r.batch.externalId}.` : `Push failed: ${r.batch.lastError}; it will retry.`);
  };
  const push = () => run(async () => {
    try { await pushOnce(false); } catch (e) {
      if (!(e as Error).message.includes('not closed') || !window.confirm(`${period} is not closed. Push it anyway? Postings dated in it later will not be included.`)) throw e;
      await pushOnce(true);
    }
    await reload();
  });
  return (
    <Card title="General ledger" action={canManage ? <Button size="sm" variant="ghost" onClick={() => { setF({ provider: c?.provider || 'MOCK', tenantId: c?.externalTenantId || '', accessToken: '' }); setEdit(true); }}>{data.mode === 'PUSH' ? 'Settings' : 'Connect'}</Button> : undefined}>
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="info">{msg}</Alert>}
      {data.mode === 'PUSH' && c ? (
        <div className="flex flex-wrap items-end gap-2 text-sm"><Badge tone={c.lastError ? 'warn' : 'good'}>{data.providers.find((p) => p.key === c.provider)?.label}</Badge><span className="text-xs text-ink-500">{c.externalTenantId || ''}{c.lastPushAt ? ` · last push ${when(c.lastPushAt)}` : ''}</span>
          {canManage && <><Input type="month" label="Month" value={period} onChange={(e) => setPeriod(e.target.value)} /><Button size="sm" onClick={() => push()}>Push month</Button><button className="text-xs text-red-600" onClick={() => { if (window.confirm('Disconnect? Journals go back to CSV export.')) run(async () => { await api.delete('/accounting/gl/connection'); await reload(); }); }}>Disconnect</button></>}
        </div>
      ) : <p className="text-sm text-ink-500">Journals are exported as CSV (general-journal layout). Connect QuickBooks Online or Xero to push each closed month as one summarized journal.</p>}
      <Table rows={data.batches} empty="Nothing pushed yet." cols={[
        { key: 'p', label: 'Month', render: (b) => b.period }, { key: 'v', label: 'To', render: (b) => b.provider },
        { key: 's', label: 'Status', render: (b) => <span><Badge tone={b.status === 'PUSHED' ? 'good' : b.status === 'FAILED' ? 'bad' : 'warn'}>{b.status}</Badge>{b.lastError && <span className="block text-xs text-red-700">{b.lastError}{b.nextRetryAt ? ` · retry ${when(b.nextRetryAt)}` : ''}</span>}</span> },
        { key: 'r', label: 'External id', render: (b) => <span className="text-xs">{b.externalId || '—'}</span> }, { key: 'l', label: 'Entries / debits', render: (b) => `${b.lines} / ${money(b.debitCents)}` },
        { key: 'x', label: '', render: (b) => canManage && b.status === 'FAILED' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/accounting/gl/push-batches/${b.id}/retry`, {}); await reload(); })}>Retry</Button> : null },
      ]} />
      <Modal open={edit} onClose={() => setEdit(false)} title="Accounting software">
        <div className="space-y-2">
          <Select label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{data.providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select>
          {f.provider !== 'MOCK' && <><Input label={f.provider === 'QBO' ? 'QuickBooks realm id' : 'Xero tenant id'} value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} /><Input label={`OAuth access token${c?.hasCredentials ? ' (leave empty to keep)' : ''}`} type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></>}
          <Button onClick={() => run(async () => { await api.post('/accounting/gl/connection', { provider: f.provider, externalTenantId: f.provider === 'MOCK' ? null : f.tenantId || null, credentials: f.accessToken ? { accessToken: f.accessToken } : undefined }); setEdit(false); await reload(); })}>Save</Button>
          <p className="text-xs text-ink-500">Each month is pushed once (per provider); failed pushes retry automatically. GL codes come from the chart-of-accounts mapping.</p>
        </div>
      </Modal>
    </Card>
  );
}

/** Closed months are locked: postings dated in them go to the current month (or are refused); reopening is audited. */
export function LedgerLockCard({ canManage }: { canManage: boolean }) {
  const { data, reload } = useApi<{ policy: { mode: string }; closed: { period: string; closedAt: string | null }[]; reopened: { period: string; status: string; reopenedAt: string | null; reason: string | null }[] }>('/accounting/ledger-lock');
  const { run, error } = useAction();
  if (!data) return null;
  return (
    <Card title="Ledger lock">
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-ink-500">Postings dated in a closed month are {data.policy.mode === 'reject' ? 'refused' : 'posted in the current month with a memo naming the original date'} (setting <code>accounting.ledgerLock</code>).</p>
      <Table rows={data.closed} empty="No closed months." cols={[{ key: 'p', label: 'Closed month', render: (c) => c.period }, { key: 'a', label: 'Closed', render: (c) => <span className="text-xs">{when(c.closedAt)}</span> }, { key: 'x', label: '', render: (c) => canManage ? <Button size="sm" variant="danger" onClick={() => { const reason = window.prompt(`Why reopen ${c.period}? (audited)`); if (reason && reason.length >= 5) run(async () => { await api.post(`/accounting/close/${c.period}/reopen`, { reason }); await reload(); }); }}>Reopen</Button> : null }]} />
      {data.reopened.length > 0 && <div className="mt-2 text-xs text-ink-500">Reopened: {data.reopened.map((r) => `${r.period} (${when(r.reopenedAt)}: ${r.reason})`).join(' · ')}</div>}
    </Card>
  );
}
