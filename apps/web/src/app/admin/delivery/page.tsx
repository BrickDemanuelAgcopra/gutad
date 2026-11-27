'use client';
import { useEffect, useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Table, Tabs } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';
import { TileMap } from '@/components/tile-map';
import { DeliveryAreaEditor } from '@/components/delivery-area';
import { useDebounced, useLiveDelivery } from '@/lib/live';
import { BatchingPreview, CourierPolicies, ProviderTests, Reconciliation } from './courier-policies';
import { CampaignsTab, ForecastTab } from './courier-r3';
import { SpecialCategoriesTab } from '@/components/courier/special-admin';

interface Live { couriers: { id: string; name: string | null; lat: number | null; lng: number | null; status: string; vehicleType: string; activeJobs: number; lastSeenAt: string }[]; pickups: { id: string; name: string; lat: number | null; lng: number | null; jobs: number }[]; deliveries: { id: string; orderId: string | null; status: string; fleet: string; provider: string; location: string; locationId: string; driverId: string | null; batchId: string | null; etaAt: string | null; late: boolean; dropoff: { lat: number | null; lng: number | null; line1: string }; requirements: string[]; offerAttempts: number; exception: string | null; needsAttention: boolean }[] }
const courierColor = (s: string) => (s === 'ON_DELIVERY' ? '#d97706' : s === 'ONLINE' ? '#059669' : '#9ca3af');

export default function AdminDelivery() {
  const [tab, setTab] = useState('live');
  return (
    <div className="space-y-4">
      <SectionTitle title="Delivery & dispatch" hint="Live couriers and deliveries, manual assignment, delivery areas, disruption restrictions, providers, demand forecast, courier campaigns, courier policies, partner reconciliation and cost analysis." />
      <Tabs tabs={[{ id: 'live', label: 'Live dispatch' }, { id: 'zones', label: 'Zones' }, { id: 'restrictions', label: 'Restrictions' }, { id: 'coverage', label: 'Coverage simulation' }, { id: 'forecast', label: 'Forecast' }, { id: 'campaigns', label: 'Campaigns' }, { id: 'special', label: 'Special categories' }, { id: 'policies', label: 'Courier policies' }, { id: 'providers', label: 'Providers' }, { id: 'reconciliation', label: 'Reconciliation' }, { id: 'analysis', label: 'Analysis' }]} active={tab} onChange={setTab} />
      {tab === 'live' && <LiveDispatch />}
      {tab === 'zones' && <Zones />}
      {tab === 'restrictions' && <Restrictions />}
      {tab === 'coverage' && <Coverage />}
      {tab === 'forecast' && <ForecastTab />}
      {tab === 'campaigns' && <CampaignsTab />}
      {tab === 'special' && <SpecialCategoriesTab />}
      {tab === 'policies' && <div className="space-y-4"><CourierPolicies /><BatchingPreview /></div>}
      {tab === 'providers' && <Providers />}
      {tab === 'reconciliation' && <Reconciliation />}
      {tab === 'analysis' && <Analysis />}
    </div>
  );
}

function LiveDispatch() {
  // 17.1-R pushed updates; polling stays as a slow fallback (fast while the stream is down)
  const [pushed, setPushed] = useState(false);
  const { data, reload, setData } = useApi<Live>('/admin/delivery/live', { poll: pushed ? 60000 : 10000, deps: [pushed] });
  const refetch = useDebounced(() => void reload(), 1500);
  const { connected } = useLiveDelivery({ onEvent: (ev) => {
    if (ev.type === 'courier') setData((d) => (d && d.couriers.some((c) => c.id === ev.driverId) ? { ...d, couriers: d.couriers.map((c) => (c.id === ev.driverId ? { ...c, lat: ev.lat, lng: ev.lng, lastSeenAt: ev.at } : c)) } : d));
    if (ev.type === 'job' || !data?.couriers.some((c) => c.id === ev.driverId)) refetch();
  } });
  useEffect(() => setPushed(connected), [connected]);
  const { data: couriers } = useApi<{ id: string; name: string | null; status: string; operational: string; vehicleType: string; capabilities: string[]; activeJobs: number }[]>('/admin/couriers?status=APPROVED');
  const { can } = useSession();
  const { run, error } = useAction();
  const [assign, setAssign] = useState<Live['deliveries'][number] | null>(null);
  const [driverId, setDriverId] = useState('');
  const [proof, setProof] = useState<{ proofPhotoUrl: string | null; proofSignature: string | null; purgedAt: string | null } | null>(null);
  const [onlyAttention, setOnlyAttention] = useState(false);
  if (!data) return null;
  const center = data.pickups.find((p) => p.lat) || data.couriers.find((c) => c.lat) || { lat: 40.7359, lng: -73.9911 };
  const rows = data.deliveries.filter((d) => !onlyAttention || d.needsAttention || d.late);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <TileMap center={{ lat: center.lat!, lng: center.lng! }} zoom={13} height={420}
        markers={[
          ...data.pickups.filter((p) => p.lat).map((p) => ({ id: `p${p.id}`, lat: p.lat!, lng: p.lng!, color: '#f45d0a', size: 8, label: `${p.name} (${p.jobs})` })),
          ...data.couriers.filter((c) => c.lat).map((c) => ({ id: `c${c.id}`, lat: c.lat!, lng: c.lng!, color: courierColor(c.status), label: c.name || 'courier', title: `${c.status} · ${c.vehicleType} · ${c.activeJobs} job(s)` })),
          ...data.deliveries.filter((d) => d.dropoff.lat).map((d) => ({ id: `d${d.id}`, lat: d.dropoff.lat!, lng: d.dropoff.lng!, color: d.needsAttention || d.late ? '#dc2626' : '#0284c7', size: 5, title: `${d.status} · ${d.dropoff.line1}` })),
        ]} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-500"><span><span className="inline-block h-2 w-2 rounded-full bg-[#f45d0a]" /> pickup</span><span><span className="inline-block h-2 w-2 rounded-full bg-[#059669]" /> courier online</span><span><span className="inline-block h-2 w-2 rounded-full bg-[#d97706]" /> on delivery</span><span><span className="inline-block h-2 w-2 rounded-full bg-[#0284c7]" /> drop-off</span><span><span className="inline-block h-2 w-2 rounded-full bg-[#dc2626]" /> needs attention / late</span><span className={connected ? 'text-emerald-700' : ''}>{connected ? '● live' : '○ refreshing every 10 s'}</span><label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} /> Only problems</label></div>
      <Table rows={rows} empty="No active deliveries." cols={[
        { key: 'l', label: 'Pickup → drop-off', render: (d) => <span>{d.location} → {d.dropoff.line1}{d.batchId && <Badge tone="info">batch</Badge>}{d.requirements.filter((r) => r !== 'COLD_BAG').map((r) => <Badge key={r} tone="warn">{r.toLowerCase().replace('_', ' ')}</Badge>)}</span> },
        { key: 's', label: 'Status', render: (d) => <span><Badge tone={statusTone(d.status)}>{d.status}</Badge>{d.late && <Badge tone="bad">late</Badge>}{d.exception && <Badge tone="bad">{d.exception.toLowerCase().replace(/_/g, ' ')}</Badge>}</span> },
        { key: 'f', label: 'Fleet', render: (d) => <span className="text-xs">{d.fleet.toLowerCase()} / {d.provider}{d.offerAttempts ? ` · ${d.offerAttempts} offer round(s)` : ''}</span> },
        { key: 'c', label: 'Courier', render: (d) => <span className="text-xs">{data.couriers.find((c) => c.id === d.driverId)?.name || (d.driverId ? 'assigned' : '—')}</span> },
        { key: 'e', label: 'ETA', render: (d) => <span className="text-xs">{when(d.etaAt)}</span> },
        { key: 'a', label: '', render: (d) => <span className="flex flex-wrap gap-1">
          {can('delivery.manage') && ['QUOTED', 'REQUESTED', 'UNASSIGNED', 'ASSIGNED'].includes(d.status) && d.fleet !== 'PARTNER' && <Button size="sm" variant="secondary" onClick={() => { setAssign(d); setDriverId(''); }}>Assign</Button>}
          {can('delivery.manage') && d.exception && <><Button size="sm" variant="ghost" onClick={() => { const note = askReason('returning this order to the restaurant'); if (note) run(async () => { await api.post(`/admin/delivery-jobs/${d.id}/exception/resolve`, { resolution: 'RETURN', note }); await reload(); }); }}>Return</Button><Button size="sm" variant="ghost" onClick={() => { const note = askReason('disposing of this order'); if (note) run(async () => { await api.post(`/admin/delivery-jobs/${d.id}/exception/resolve`, { resolution: 'DISPOSE', note }); await reload(); }); }}>Dispose</Button></>}
        </span> },
      ]} />
      <ProofLookup onShow={setProof} />
      {proof && <Card title="Proof of delivery (access is audited)" action={<Button size="sm" variant="ghost" onClick={() => setProof(null)}>Close</Button>}>{proof.purgedAt ? <p className="text-sm text-ink-500">Removed on {when(proof.purgedAt)} under the retention policy.</p> : <>{proof.proofPhotoUrl && <img src={proof.proofPhotoUrl} alt="Proof of delivery" className="max-h-72 rounded" />}{proof.proofSignature && <p className="text-sm">Signed: {proof.proofSignature}</p>}</>}</Card>}
      <Modal open={!!assign} onClose={() => setAssign(null)} title="Assign a courier">
        {assign && <div className="space-y-2">
          <p className="text-sm">{assign.location} → {assign.dropoff.line1}{assign.requirements.length ? ` · needs ${assign.requirements.join(', ').toLowerCase()}` : ''}</p>
          <Select label="Courier" value={driverId} onChange={(e) => setDriverId(e.target.value)}><option value="">Choose…</option>{couriers?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.operational.toLowerCase().replace('_', ' ')} · {c.vehicleType.toLowerCase()}{c.capabilities.length ? ` · ${c.capabilities.join(', ').toLowerCase()}` : ''}</option>)}</Select>
          <Button disabled={!driverId} onClick={() => { const reason = askReason('assigning this courier by hand'); if (reason) run(async () => { await api.post(`/admin/delivery-jobs/${assign.id}/assign`, { driverId, reason }); setAssign(null); await reload(); }); }}>Assign</Button>
        </div>}
      </Modal>
    </div>
  );
}

function ProofLookup({ onShow }: { onShow: (p: { proofPhotoUrl: string | null; proofSignature: string | null; purgedAt: string | null }) => void }) {
  const [id, setId] = useState('');
  const { run, error } = useAction();
  return <div className="flex items-end gap-2">{error && <Alert>{error}</Alert>}<Input label="Delivery job id (proof lookup)" value={id} onChange={(e) => setId(e.target.value.trim())} /><Button size="sm" variant="secondary" disabled={id.length < 30} onClick={() => run(async () => onShow(await api.get(`/delivery-jobs/${id}/proof`)))}>View proof</Button></div>;
}

function Zones() {
  const { data } = useApi<{ locations: { id: string; name: string; acceptsDelivery: boolean }[] }>('/admin/delivery/network');
  const [loc, setLoc] = useState('');
  return (
    <div className="space-y-3">
      <Select label="Location" value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Choose a location…</option>{data?.locations.filter((l) => l.acceptsDelivery).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
      {loc && <DeliveryAreaEditor locationId={loc} />}
    </div>
  );
}

function Restrictions() {
  const { data, reload } = useApi<{ id: string; kind: string; value: number | null; reason: string; zoneId: string | null; locationId: string | null; regionId: string | null; startsAt: string; endsAt: string }[]>('/admin/delivery/restrictions');
  const { data: net } = useApi<{ locations: { id: string; name: string }[]; zones: { id: string; name: string; kind: string }[] }>('/admin/delivery/network');
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const { run, error } = useAction();
  const [f, setF] = useState({ kind: 'PAUSE', value: '', reason: '', scope: 'location', target: '', hours: '2' });
  const name = (r: { zoneId: string | null; locationId: string | null; regionId: string | null }) => r.zoneId ? `zone ${net?.zones.find((z) => z.id === r.zoneId)?.name || ''}` : r.locationId ? net?.locations.find((l) => l.id === r.locationId)?.name || 'location' : r.regionId ? `region ${regions?.find((x) => x.id === r.regionId)?.name || ''}` : 'everywhere';
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No restrictions in force." cols={[{ key: 'k', label: 'Restriction', render: (r) => <b>{r.kind === 'PAUSE' ? 'Delivery paused' : r.kind === 'SHRINK_RADIUS' ? `Radius limited to ${r.value} km` : `+${r.value} min`}</b> }, { key: 's', label: 'Where', render: (r) => name(r) }, { key: 'r', label: 'Reason', render: (r) => r.reason }, { key: 'e', label: 'Until', render: (r) => when(r.endsAt) }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/admin/delivery/restrictions/${r.id}/lift`, {}); await reload(); })}>Lift</Button> }]} />
      <Card title="New restriction (weather, disruption)">
        <div className="grid gap-2 sm:grid-cols-6">
          <Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PAUSE">Pause delivery</option><option value="SHRINK_RADIUS">Shrink radius (km)</option><option value="ADD_MINUTES">Add minutes</option></Select>
          {f.kind !== 'PAUSE' && <Input label={f.kind === 'SHRINK_RADIUS' ? 'Max km' : 'Minutes'} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}
          <Select label="Scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, target: '' })}><option value="location">Location</option><option value="zone">Zone</option><option value="region">Region</option><option value="all">Everywhere</option></Select>
          {f.scope !== 'all' && <Select label="Which" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}><option value="">Choose…</option>{(f.scope === 'location' ? net?.locations : f.scope === 'zone' ? net?.zones.filter((z) => z.kind === 'SERVICE') : regions)?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
          <Input label="Hours" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
          <Input label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <Button className="mt-2" disabled={f.reason.length < 3 || (f.scope !== 'all' && !f.target)} onClick={() => run(async () => { await api.post('/admin/delivery/restrictions', { kind: f.kind, value: f.value ? Number(f.value) : null, reason: f.reason, endsAt: new Date(Date.now() + Number(f.hours || 1) * 3600_000).toISOString(), ...(f.scope === 'location' ? { locationId: f.target } : f.scope === 'zone' ? { zoneId: f.target } : f.scope === 'region' ? { regionId: f.target } : {}) }); setF({ ...f, reason: '', value: '' }); await reload(); })}>Apply</Button>
        <p className="mt-1 text-xs text-ink-500">Restrictions end automatically (at most 7 days). Customers see a clear message at checkout.</p>
      </Card>
    </div>
  );
}

function Coverage() {
  const [f, setF] = useState({ lat: '40.7359', lng: '-73.9911', radiusKm: '3' });
  const { run, error } = useAction();
  const [r, setR] = useState<{ samples: number; deliverablePct: number; excludedPct: number; alreadyCoveredPct: number; avgEtaMinutes: number | null; maxEtaMinutes: number | null; overlaps: { id: string; name: string; sharedPct: number }[]; points: { lat: number; lng: number; excluded: boolean }[] } | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-ink-500">Click the map to place a proposed location, set its delivery radius, and simulate.</p>
      <TileMap center={{ lat: Number(f.lat), lng: Number(f.lng) }} zoom={12} onClick={(p) => setF({ ...f, lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })} circles={[{ lat: Number(f.lat), lng: Number(f.lng), radiusKm: Number(f.radiusKm) || 1 }]} markers={[{ lat: Number(f.lat), lng: Number(f.lng), color: '#f45d0a', label: 'proposed' }, ...(r?.points.filter((p) => p.excluded).map((p) => ({ lat: p.lat, lng: p.lng, color: '#dc2626', size: 2 })) || [])]} />
      <div className="flex flex-wrap items-end gap-2"><Input label="Lat" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /><Input label="Lng" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} /><Input label="Radius km" value={f.radiusKm} onChange={(e) => setF({ ...f, radiusKm: e.target.value })} /><Button onClick={() => run(async () => setR(await api.post('/admin/delivery/coverage', { lat: Number(f.lat), lng: Number(f.lng), radiusKm: Number(f.radiusKm) })))}>Simulate</Button></div>
      {r && <Card title="Result"><div className="grid gap-2 sm:grid-cols-4 text-sm"><div>Deliverable: <b>{r.deliverablePct}%</b> of the area</div><div>Excluded zones: {r.excludedPct}%</div><div>Already covered by others: <b>{r.alreadyCoveredPct}%</b></div><div>ETA avg {r.avgEtaMinutes} min, worst {r.maxEtaMinutes} min</div></div>{r.overlaps.length > 0 && <p className="mt-2 text-sm">Overlaps: {r.overlaps.map((o) => `${o.name} (${o.sharedPct}%)`).join(', ')}</p>}</Card>}
    </div>
  );
}

function Providers() {
  const { data, reload } = useApi<{ id: string; regionId: string | null; provider: string; priority: number; isActive: boolean }[]>('/admin/delivery/providers');
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const { run, error } = useAction();
  const [f, setF] = useState({ regionId: '', provider: 'PLATFORM', priority: '1' });
  const { data: names } = useApi<{ primary: string; available: string[] }>('/admin/delivery/provider-names');
  const { data: routing } = useApi<{ provider: string; requested: string; configured: boolean; calls: number; cacheHits: number; failures: number }>('/admin/delivery/routing');
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-ink-500">Failover order per region: when the own fleet's offers go unaccepted for the set number of offer rounds (Max offer rounds in dispatch settings; 0 = no limit), or nobody is online 20 minutes after the food is due, the next one is tried. Without rows: own fleet, then the configured partner provider. Partner-fleet restaurants use the partners in this order too: if a partner cannot take the job, it goes to the next one.</p>
      <Table rows={data || []} empty="Using the default order." cols={[{ key: 'r', label: 'Region', render: (x) => regions?.find((r) => r.id === x.regionId)?.name || 'All regions' }, { key: 'p', label: 'Provider', render: (x) => x.provider === 'PLATFORM' ? 'Gutad fleet' : x.provider }, { key: 'o', label: 'Order', render: (x) => x.priority }, { key: 'a', label: 'Active', render: (x) => <button className="text-xs underline" onClick={() => run(async () => { await api.post('/admin/delivery/providers', { ...x, isActive: !x.isActive }); await reload(); })}>{x.isActive ? 'on' : 'off'}</button> }]} />
      <div className="flex flex-wrap items-end gap-2"><Select label="Region" value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}><option value="">All regions</option>{regions?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select><Select label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{(names?.available || ['PLATFORM', 'mock']).map((p) => <option key={p} value={p}>{p === 'PLATFORM' ? 'Gutad fleet' : p}</option>)}</Select><Input label="Order" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /><Button onClick={() => run(async () => { await api.post('/admin/delivery/providers', { regionId: f.regionId || null, provider: f.provider, priority: Number(f.priority) }); await reload(); })}>Add</Button></div>
      {routing && <p className="text-xs text-ink-500">Travel times: {routing.provider === 'straight' ? 'straight-line distance × minutes per km (set ROUTING_PROVIDER for road times)' : `${routing.provider} road routing · ${routing.calls} calls, ${routing.cacheHits} cached, ${routing.failures} fell back to straight-line`}{!routing.configured ? ` · ${routing.requested} is selected but not configured` : ''}. Default partner: {names?.primary}.</p>}
      <ProviderTests names={names?.available || []} />
    </div>
  );
}

function Analysis() {
  const [by, setBy] = useState('zone');
  const [days, setDays] = useState('30');
  const { data } = useApi<{ rows: { key: string; jobs: number; delivered: number; failed: number; onTimePct: number | null; avgPickupWaitMinutes: number | null; avgDriveMinutes: number | null; avgKm: number | null; costCents: number; feesCents: number; subsidyCents: number; costPerDeliveryCents: number | null }[] }>(`/admin/delivery/analysis?by=${by}&days=${days}`, { deps: [by, days] });
  return (
    <div className="space-y-3">
      <div className="flex gap-2"><Select label="Group by" value={by} onChange={(e) => setBy(e.target.value)}><option value="zone">Zone</option><option value="provider">Provider</option><option value="location">Location</option></Select><Select label="Period" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select></div>
      <Table rows={data?.rows || []} empty="No deliveries in this period." cols={[
        { key: 'k', label: by, render: (r) => r.key }, { key: 'j', label: 'Jobs', render: (r) => `${r.delivered}/${r.jobs}` }, { key: 'f', label: 'Failed', render: (r) => r.failed },
        { key: 'o', label: 'On time', render: (r) => (r.onTimePct == null ? '—' : `${r.onTimePct}%`) }, { key: 'w', label: 'Courier wait at pickup', render: (r) => (r.avgPickupWaitMinutes == null ? '—' : `${r.avgPickupWaitMinutes} min`) },
        { key: 'd', label: 'Drive', render: (r) => (r.avgDriveMinutes == null ? '—' : `${r.avgDriveMinutes} min`) }, { key: 'km', label: 'Avg km', render: (r) => r.avgKm ?? '—' },
        { key: 'c', label: 'Cost / delivery', render: (r) => (r.costPerDeliveryCents == null ? '—' : money(r.costPerDeliveryCents)) }, { key: 't', label: 'Total cost', render: (r) => money(r.costCents) }, { key: 's', label: 'Subsidy', render: (r) => money(r.subsidyCents) },
      ]} />
    </div>
  );
}
