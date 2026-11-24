'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DEFAULT_FIRST_PARTY_POLICY, FIRST_PARTY_RANKING_LABELS, FIRST_PARTY_RANKING_MODES, type FirstPartyPolicy, type FirstPartyRankingMode, type FirstPartyRules } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, statusTone, Table, Tabs } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface Loc { id: string; name: string; slug: string; city: string; region: string; status: string; verifiedAt: string | null; readinessApprovedAt: string | null; platformOperated: boolean; kitchenId: string | null; isPaused: boolean; acceptsPickup: boolean; acceptsDelivery: boolean }
interface Overview { org: { id: string; name: string; status: string; createdAt: string } | null; sellers: { id: string; legalName: string; taxId: string | null }[]; locations: Loc[]; brands: { id: string; name: string; description: string | null; ownershipType: string; rightsStatus: string }[]; kitchens: { id: string; name: string; city: string; own: boolean; isShared: boolean }[]; memberCount: number; policyVersion: number }
interface PolicyRes { current: FirstPartyPolicy & { version: number }; versions: { id: string; version: number; note: string | null; createdAt: string; by: string | null }[]; summary: string[] }
interface Row { position: number; id: string; name: string; city: string; firstParty: boolean; sponsored: boolean; isOpenNow: boolean; rating: number | null; why: string[] }
interface Preview { summary: string[]; neutral: Row[]; withPolicy: Row[]; total: number }
interface Report { from: string; to: string; firstParty: { orders: number; gmvCents: number; foodSalesCents: number; cogsCents: number; grossMarginCents: number; grossMarginPct: number | null; shadowCommissionCents: number; shadowCommissionBps: number }; merchants: { orders: number; gmvCents: number; commissionCents: number }; firstPartySharePct: number; byLocation: { locationId: string; name: string; city: string; n: number; gmv: number }[] }
interface Operators { members: { id: string; email: string; name: string | null; role: string; locationIds: string[]; acceptedAt: string | null; crossTenantStaff: boolean; staffRoles: string[] }[]; conflicts: number }

const TABS = [{ id: 'setup', label: 'Locations & brands' }, { id: 'policy', label: 'Marketplace policy' }, { id: 'preview', label: 'Search preview' }, { id: 'report', label: 'Report' }, { id: 'operators', label: 'Operators & access' }];

export default function FirstPartyAdmin() {
  const [tab, setTab] = useState('setup');
  return (
    <div className="space-y-4">
      <SectionTitle title="Gutad Kitchens (first-party)" hint="Food Gutad sells itself, next to merchants: Gutad is the seller of record (no commission, no payout), results are labelled, and search follows the marketplace policy below." />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'setup' && <Setup />}
      {tab === 'policy' && <PolicyTab />}
      {tab === 'preview' && <PreviewTab />}
      {tab === 'report' && <ReportTab />}
      {tab === 'operators' && <OperatorsTab />}
    </div>
  );
}

function Setup() {
  const { can } = useSession();
  const write = can('merchants.manage');
  const { data, reload } = useApi<Overview>('/admin/first-party');
  const { run, busy, error } = useAction();
  const [setup, setSetup] = useState({ name: 'Gutad', legalName: '', taxId: '' });
  const blankLoc = { name: '', description: '', cuisine: '', addressLine1: '', city: '', region: '', postalCode: '', lat: '', lng: '', kitchenId: '', foodHall: false, acceptsPickup: true, acceptsDelivery: true };
  const [loc, setLoc] = useState(blankLoc);
  const [kitchen, setKitchen] = useState({ name: '', addressLine1: '', city: '', region: '', postalCode: '' });
  const [brand, setBrand] = useState({ name: '', description: '' });
  if (!data) return null;
  if (!data.org) {
    return (
      <Card title="Set up Gutad as a seller">
        {error && <Alert>{error}</Alert>}
        <p className="mb-3 text-sm text-ink-700">Creates Gutad&rsquo;s own organization and legal seller. It needs no Merchant Agreement, Order Form or plan, and it never receives payouts: its sales go straight to Gutad&rsquo;s books.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input label="Name shown to staff" value={setup.name} onChange={(e) => setSetup({ ...setup, name: e.target.value })} />
          <Input label="Legal name (seller of record)" placeholder="Gutad Inc." value={setup.legalName} onChange={(e) => setSetup({ ...setup, legalName: e.target.value })} />
          <Input label="Tax ID (optional)" value={setup.taxId} onChange={(e) => setSetup({ ...setup, taxId: e.target.value })} />
        </div>
        <Button className="mt-3" disabled={!write || busy} onClick={() => run(async () => { await api.post('/admin/first-party/setup', { name: setup.name || undefined, legalName: setup.legalName || undefined, taxId: setup.taxId || undefined }); reload(); })}>Create Gutad seller</Button>
        {!write && <p className="mt-2 text-xs text-ink-500">Needs the “Onboard and manage merchants” permission.</p>}
      </Card>
    );
  }
  const orgId = data.org.id;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); reload(); });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Seller of record" value={data.sellers[0]?.legalName || data.org.name} hint="no commission · no payout" />
        <Stat label="Locations" value={data.locations.length} hint={`${data.locations.filter((l) => l.status === 'LIVE').length} live`} />
        <Stat label="Brands" value={data.brands.length} />
        <Stat label="Policy version" value={data.policyVersion || 'default'} />
      </div>
      <Card title="Locations">
        <Table rows={data.locations} empty="No Gutad locations yet. Add one below." cols={[
          { key: 'n', label: 'Location', render: (l) => <span>{l.name}<span className="block text-xs text-ink-500">{l.city}, {l.region}{l.platformOperated ? ' · food hall' : ''}</span></span> },
          { key: 's', label: 'Status', render: (l) => <span className="flex flex-wrap gap-1"><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.isPaused && l.status === 'LIVE' && <Badge tone="bad">paused</Badge>}{l.readinessApprovedAt ? <Badge tone="good">launch ready</Badge> : <Badge tone="warn">checklist open</Badge>}</span> },
          { key: 'a', label: 'Next step', render: (l) => (
            <div className="flex flex-wrap gap-1">
              <a className="rounded-lg border border-ink-100 px-2 py-1 text-xs" href={`/merchant?support=${orgId}&loc=${l.id}`}>Menu &amp; settings</a>
              <Link className="rounded-lg border border-ink-100 px-2 py-1 text-xs" href={`/admin/locations/${l.id}`}>Launch checklist</Link>
              {write && !l.verifiedAt && <Button size="sm" onClick={() => act(() => api.post(`/locations/${l.id}/verify`, { verified: true }))}>Verify</Button>}
              {write && l.verifiedAt && l.status !== 'LIVE' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/locations/${l.id}/status`, { status: 'LIVE' }))}>Go live</Button>}
              {write && l.status === 'LIVE' && <Button size="sm" variant="ghost" onClick={() => { const r = askReason('pausing this Gutad location'); if (r) act(() => api.post(`/locations/${l.id}/status`, { status: 'PAUSED', reason: r })); }}>Pause</Button>}
              {write && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/locations/${l.id}/platform-operated`, { value: !l.platformOperated }))}>{l.platformOperated ? 'Not a food hall' : 'Make food hall'}</Button>}
            </div>
          ) },
        ]} />
        <p className="mt-2 text-xs text-ink-500">Menus are built in the merchant portal (the same editor merchants use). Going live needs verification and an approved launch checklist.</p>
      </Card>
      {write && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Add a location">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input label="Name" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} />
              <Input label="Cuisine (comma separated)" value={loc.cuisine} onChange={(e) => setLoc({ ...loc, cuisine: e.target.value })} />
              <Input label="Street address" value={loc.addressLine1} onChange={(e) => setLoc({ ...loc, addressLine1: e.target.value })} />
              <Input label="City" value={loc.city} onChange={(e) => setLoc({ ...loc, city: e.target.value })} />
              <Input label="State" value={loc.region} onChange={(e) => setLoc({ ...loc, region: e.target.value })} />
              <Input label="Postal code" value={loc.postalCode} onChange={(e) => setLoc({ ...loc, postalCode: e.target.value })} />
              <Input label="Latitude" value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} />
              <Input label="Longitude" value={loc.lng} onChange={(e) => setLoc({ ...loc, lng: e.target.value })} />
              <Select label="Kitchen" value={loc.kitchenId} onChange={(e) => setLoc({ ...loc, kitchenId: e.target.value })}>
                <option value="">None yet</option>
                {data.kitchens.map((k) => <option key={k.id} value={k.id}>{k.name} · {k.city}{k.own ? ' (Gutad)' : ' (shared)'}</option>)}
              </Select>
              <Input label="Description" value={loc.description} onChange={(e) => setLoc({ ...loc, description: e.target.value })} />
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="checkbox" checked={loc.foodHall} onChange={(e) => setLoc({ ...loc, foodHall: e.target.checked })} /> Food hall (several brands, one order)</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={loc.acceptsPickup} onChange={(e) => setLoc({ ...loc, acceptsPickup: e.target.checked })} /> Pickup</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={loc.acceptsDelivery} onChange={(e) => setLoc({ ...loc, acceptsDelivery: e.target.checked })} /> Delivery</label>
            </div>
            <Button className="mt-3" disabled={busy || !loc.name || !loc.addressLine1 || !loc.city || !loc.region || !loc.postalCode} onClick={() => act(async () => {
              await api.post('/admin/first-party/locations', { name: loc.name, description: loc.description || undefined, cuisine: loc.cuisine ? loc.cuisine.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) : undefined, addressLine1: loc.addressLine1, city: loc.city, region: loc.region, postalCode: loc.postalCode, lat: loc.lat ? Number(loc.lat) : undefined, lng: loc.lng ? Number(loc.lng) : undefined, kitchenId: loc.kitchenId || undefined, foodHall: loc.foodHall, acceptsPickup: loc.acceptsPickup, acceptsDelivery: loc.acceptsDelivery });
              setLoc(blankLoc);
            })}>Create location</Button>
          </Card>
          <div className="space-y-4">
            <Card title="Brands">
              <ul className="mb-3 space-y-1 text-sm">{data.brands.map((b) => <li key={b.id}>{b.name} <span className="text-xs text-ink-500">· company-owned{b.rightsStatus !== 'ACTIVE' ? ` · ${b.rightsStatus.toLowerCase()}` : ''}</span></li>)}{!data.brands.length && <li className="text-ink-500">No brands yet. Brands show as separate results when a food hall prepares them.</li>}</ul>
              <div className="grid gap-2 sm:grid-cols-2"><Input label="Brand name" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} /><Input label="Description" value={brand.description} onChange={(e) => setBrand({ ...brand, description: e.target.value })} /></div>
              <Button className="mt-2" disabled={busy || !brand.name} onClick={() => act(async () => { await api.post('/admin/first-party/brands', { name: brand.name, description: brand.description || undefined }); setBrand({ name: '', description: '' }); })}>Add brand</Button>
            </Card>
            <Card title="Add a Gutad kitchen">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input label="Name" value={kitchen.name} onChange={(e) => setKitchen({ ...kitchen, name: e.target.value })} />
                <Input label="Street address" value={kitchen.addressLine1} onChange={(e) => setKitchen({ ...kitchen, addressLine1: e.target.value })} />
                <Input label="City" value={kitchen.city} onChange={(e) => setKitchen({ ...kitchen, city: e.target.value })} />
                <Input label="State" value={kitchen.region} onChange={(e) => setKitchen({ ...kitchen, region: e.target.value })} />
                <Input label="Postal code" value={kitchen.postalCode} onChange={(e) => setKitchen({ ...kitchen, postalCode: e.target.value })} />
              </div>
              <Button className="mt-2" disabled={busy || !kitchen.name || !kitchen.addressLine1 || !kitchen.city || !kitchen.region || !kitchen.postalCode} onClick={() => act(async () => { await api.post('/admin/first-party/kitchens', kitchen); setKitchen({ name: '', addressLine1: '', city: '', region: '', postalCode: '' }); })}>Add kitchen</Button>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function RulesForm({ value, onChange, partial }: { value: Partial<FirstPartyRules>; onChange: (v: Partial<FirstPartyRules>) => void; partial?: boolean }) {
  const set = <K extends keyof FirstPartyRules>(k: K, v: FirstPartyRules[K] | undefined) => { const n = { ...value }; if (v === undefined) delete n[k]; else n[k] = v; onChange(n); };
  const inherit = partial ? <option value="">Same as everywhere</option> : null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select label="Selling" value={value.enabled === undefined ? '' : String(value.enabled)} onChange={(e) => set('enabled', e.target.value === '' ? undefined : e.target.value === 'true')}>{inherit}<option value="true">On</option><option value="false">Off (hidden, no new orders)</option></Select>
      <Select label="Ranking" value={value.ranking || ''} onChange={(e) => set('ranking', (e.target.value || undefined) as FirstPartyRankingMode | undefined)}>{inherit}{FIRST_PARTY_RANKING_MODES.map((m) => <option key={m} value={m}>{FIRST_PARTY_RANKING_LABELS[m]}</option>)}</Select>
      <Input label="Boost: places up (max)" type="number" min={0} max={50} value={value.boostPositions ?? ''} onChange={(e) => set('boostPositions', e.target.value === '' ? undefined : Number(e.target.value))} />
      <Input label="Pinned positions (e.g. 2, 6)" value={value.pinSlots?.join(', ') ?? ''} onChange={(e) => set('pinSlots', e.target.value.trim() === '' ? (partial ? undefined : []) : e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))} />
      <Input label="Max share of first page (%)" type="number" min={0} max={100} value={value.maxFirstPageSharePct ?? ''} onChange={(e) => set('maxFirstPageSharePct', e.target.value === '' ? undefined : Number(e.target.value))} />
      <Select label="Sponsored placements" value={value.allowSponsored === undefined ? '' : String(value.allowSponsored)} onChange={(e) => set('allowSponsored', e.target.value === '' ? undefined : e.target.value === 'true')}>{inherit}<option value="false">Gutad may not buy them</option><option value="true">Allowed, marked Sponsored</option></Select>
      <Input label="Customer label" value={value.label ?? ''} onChange={(e) => set('label', e.target.value === '' && partial ? undefined : e.target.value)} />
      <Input label="Shadow commission (bps, reports only)" type="number" min={0} max={5000} value={value.shadowCommissionBps ?? ''} onChange={(e) => set('shadowCommissionBps', e.target.value === '' ? undefined : Number(e.target.value))} />
    </div>
  );
}

function PolicyTab() {
  const { can } = useSession();
  const write = can('settings.manage');
  const kill = can('ops.manage') || write;
  const { data, reload } = useApi<PolicyRes>('/admin/first-party/policy');
  const { run, busy, error } = useAction();
  const [draft, setDraft] = useState<FirstPartyPolicy | null>(null);
  const [city, setCity] = useState('');
  useEffect(() => { if (data) { const { version: _v, ...p } = data.current; setDraft({ ...DEFAULT_FIRST_PARTY_POLICY, ...p }); } }, [data]);
  if (!data || !draft) return null;
  const { cities, ...globalRules } = draft;
  const save = () => { const r = askReason('changing the marketplace policy'); if (r) run(async () => { await api.put('/admin/first-party/policy', { policy: draft, reason: r }); reload(); }); };
  const toggle = (enabled: boolean, c?: string) => { const r = askReason(`${enabled ? 'turning on' : 'turning off'} Gutad's own food${c ? ` in ${c}` : ' everywhere'}`); if (r) run(async () => { await api.post('/admin/first-party/policy/kill-switch', { enabled, city: c || null, reason: r }); reload(); }); };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Card title="Kill switch">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={data.current.enabled ? 'good' : 'bad'}>{data.current.enabled ? 'Selling everywhere' : 'Off everywhere'}</Badge>
          {kill && (data.current.enabled ? <Button variant="danger" disabled={busy} onClick={() => toggle(false)}>Turn off everywhere now</Button> : <Button disabled={busy} onClick={() => toggle(true)}>Turn back on</Button>)}
          {Object.entries(data.current.cities).filter(([, v]) => v.enabled === false).map(([c]) => <span key={c} className="flex items-center gap-1"><Badge tone="bad">off in {c}</Badge>{kill && <Button size="sm" variant="ghost" onClick={() => toggle(true, c)}>turn on</Button>}</span>)}
        </div>
        <p className="mt-2 text-xs text-ink-500">Takes effect within seconds: Gutad results disappear from search, location pages return “not found” and new orders are refused. Existing orders continue.</p>
      </Card>
      <Card title={`Policy (version ${data.current.version || 'default'})`}>
        <ul className="mb-3 list-disc pl-5 text-sm text-ink-700">{data.summary.map((s) => <li key={s}>{s}</li>)}</ul>
        <RulesForm value={globalRules} onChange={(v) => setDraft({ ...draft, ...(v as FirstPartyRules) })} />
        <div className="mt-4">
          <div className="mb-1 text-sm font-semibold">City overrides</div>
          {Object.entries(cities).map(([c, over]) => (
            <div key={c} className="mb-3 rounded-lg border border-ink-100 p-3">
              <div className="mb-2 flex items-center justify-between"><span className="font-medium capitalize">{c}</span><Button size="sm" variant="ghost" onClick={() => { const n = { ...cities }; delete n[c]; setDraft({ ...draft, cities: n }); }}>Remove</Button></div>
              <RulesForm partial value={over} onChange={(v) => setDraft({ ...draft, cities: { ...cities, [c]: v } })} />
            </div>
          ))}
          <div className="flex items-end gap-2"><Input label="Add city" placeholder="new york" value={city} onChange={(e) => setCity(e.target.value)} /><Button variant="secondary" disabled={!city.trim()} onClick={() => { setDraft({ ...draft, cities: { ...cities, [city.trim().toLowerCase()]: {} } }); setCity(''); }}>Add</Button></div>
        </div>
        {write ? <Button className="mt-4" disabled={busy} onClick={save}>Save new version</Button> : <p className="mt-3 text-xs text-ink-500">Changing the policy needs the “Platform settings” permission.</p>}
      </Card>
      <Card title="History">
        <Table rows={data.versions} empty="Using the default policy." cols={[
          { key: 'v', label: 'Version', render: (v) => v.version },
          { key: 'n', label: 'Change', render: (v) => <span className="text-xs">{v.note}</span> },
          { key: 'b', label: 'By', render: (v) => <span className="text-xs">{v.by || '—'} · {when(v.createdAt)}</span> },
          { key: 'r', label: '', render: (v) => write && v.version !== data.current.version ? <Button size="sm" variant="ghost" onClick={() => { const r = askReason(`restoring version ${v.version}`); if (r) run(async () => { await api.post(`/admin/first-party/policy/versions/${v.version}/restore`, { reason: r }); reload(); }); }}>Restore</Button> : null },
        ]} />
      </Card>
    </div>
  );
}

function PreviewTab() {
  const { run, busy, error } = useAction();
  const { data: pol } = useApi<PolicyRes>('/admin/first-party/policy');
  const [q, setQ] = useState({ city: '', q: '', service: '' });
  const [useDraft, setUseDraft] = useState(false);
  const [draft, setDraft] = useState<Partial<FirstPartyRules>>({});
  const [res, setRes] = useState<Preview | null>(null);
  const go = () => run(async () => setRes(await api.post<Preview>('/admin/first-party/preview', { city: q.city || undefined, q: q.q || undefined, service: q.service || undefined, policy: useDraft ? draft : undefined })));
  const list = (rows: Row[], showWhy: boolean) => (
    <ol className="space-y-1 text-sm">{rows.map((r) => <li key={`${r.position}-${r.id}-${r.name}`} className={`rounded-lg px-2 py-1 ${r.firstParty ? 'bg-emerald-50' : ''}`}><span className="mr-2 inline-block w-5 text-right text-ink-500">{r.position}</span>{r.name}{r.firstParty && <Badge tone="good">Gutad</Badge>}{r.sponsored && <Badge tone="info">Sponsored</Badge>}{!r.isOpenNow && <span className="ml-1 text-xs text-ink-500">closed</span>}{showWhy && r.why.length > 0 && <span className="block pl-7 text-xs text-emerald-800">{r.why.join('; ')}</span>}</li>)}{!rows.length && <li className="text-ink-500">No results.</li>}</ol>
  );
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Card title="What customers would see">
        <div className="grid gap-2 sm:grid-cols-4">
          <Input label="City" value={q.city} onChange={(e) => setQ({ ...q, city: e.target.value })} />
          <Input label="Search words" value={q.q} onChange={(e) => setQ({ ...q, q: e.target.value })} />
          <Select label="Service" value={q.service} onChange={(e) => setQ({ ...q, service: e.target.value })}><option value="">Any</option><option value="pickup">Pickup</option><option value="delivery">Delivery</option></Select>
          <div className="flex items-end"><Button disabled={busy} onClick={go}>Preview</Button></div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={useDraft} onChange={(e) => { setUseDraft(e.target.checked); if (e.target.checked && pol) { const { cities: _c, version: _v, ...g } = pol.current; setDraft(g); } }} /> Try a draft policy (not saved)</label>
        {useDraft && <div className="mt-2"><RulesForm value={draft} onChange={setDraft} /></div>}
      </Card>
      {res && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Neutral ranking (same rules for everyone)">{list(res.neutral, false)}</Card>
          <Card title={useDraft ? 'With the draft policy' : 'With the current policy'}><ul className="mb-2 list-disc pl-5 text-xs text-ink-500">{res.summary.map((s) => <li key={s}>{s}</li>)}</ul>{list(res.withPolicy, true)}</Card>
        </div>
      )}
    </div>
  );
}

function ReportTab() {
  const [range, setRange] = useState(30);
  const from = new Date(Date.now() - range * 86400000).toISOString();
  const { data, error } = useApi<Report>(`/admin/first-party/report?from=${encodeURIComponent(from)}`, { deps: [range] });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center gap-2 text-sm">Period <Select value={String(range)} onChange={(e) => setRange(Number(e.target.value))}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">12 months</option></Select></div>
      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gutad sales (GMV)" value={money(data.firstParty.gmvCents)} hint={`${data.firstParty.orders} orders · ${data.firstPartySharePct}% of all GMV`} />
            <Stat label="Gutad gross margin" value={money(data.firstParty.grossMarginCents)} hint={`${data.firstParty.grossMarginPct ?? '—'}% · food sales ${money(data.firstParty.foodSalesCents)} − cost of goods ${money(data.firstParty.cogsCents)}`} />
            <Stat label="Merchant sales (GMV)" value={money(data.merchants.gmvCents)} hint={`${data.merchants.orders} orders · commission ${money(data.merchants.commissionCents)}`} />
            <Stat label="Shadow commission" value={money(data.firstParty.shadowCommissionCents)} hint={`what a merchant would have paid on Gutad's sales at ${data.firstParty.shadowCommissionBps / 100}%`} />
          </div>
          <Card title="Gutad locations">
            <Table rows={data.byLocation} empty="No first-party orders in this period." cols={[
              { key: 'n', label: 'Location', render: (r) => <span>{r.name}<span className="block text-xs text-ink-500">{r.city}</span></span> },
              { key: 'o', label: 'Orders', render: (r) => r.n },
              { key: 'g', label: 'GMV', render: (r) => money(r.gmv) },
            ]} />
          </Card>
          <p className="text-xs text-ink-500">Cost of goods comes from recipes on each sold item; items without a recipe add no cost. Shadow commission is for comparison only and is never charged.</p>
        </>
      )}
    </div>
  );
}

function OperatorsTab() {
  const { can } = useSession();
  const write = can('merchants.manage');
  const { data, reload } = useApi<Operators>('/admin/first-party/operators');
  const { run, busy, error } = useAction();
  const [f, setF] = useState({ email: '', role: 'MERCHANT_MANAGER' });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Alert tone="info">People who run Gutad&rsquo;s own kitchens are added here as members of the Gutad organization only. They see Gutad&rsquo;s menus, orders and reports, and nothing about other merchants. Someone with platform-wide staff access cannot be added: remove that access first in Users, roles &amp; permissions.</Alert>
      {!!data?.conflicts && <Alert>{data.conflicts} member{data.conflicts === 1 ? '' : 's'} also hold platform-wide staff access and could see competitors&rsquo; data. Remove one of the two.</Alert>}
      <Card title="Operators">
        <Table rows={data?.members || []} empty="No operators yet." cols={[
          { key: 'e', label: 'Person', render: (m) => <span>{m.name || m.email}<span className="block text-xs text-ink-500">{m.email}</span></span> },
          { key: 'r', label: 'Role', render: (m) => <span className="text-xs">{m.role.toLowerCase().replace(/_/g, ' ')}{m.locationIds.length ? ` · ${m.locationIds.length} location(s)` : ' · all locations'}</span> },
          { key: 'c', label: 'Access check', render: (m) => m.crossTenantStaff ? <Badge tone="bad">also platform staff ({m.staffRoles.join(', ').toLowerCase()})</Badge> : <Badge tone="good">Gutad only</Badge> },
          { key: 'x', label: '', render: (m) => write ? <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.delete(`/admin/first-party/operators/${m.id}`); reload(); })}>Remove</Button> : null },
        ]} />
        {write && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'KITCHEN', 'PACKER', 'HOST'].map((r) => <option key={r} value={r}>{r.toLowerCase().replace(/_/g, ' ')}</option>)}</Select>
            <Button disabled={busy || !f.email} onClick={() => run(async () => { await api.post('/admin/first-party/operators', f); setF({ ...f, email: '' }); reload(); })}>Add operator</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
