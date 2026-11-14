'use client';
import { useEffect, useState } from 'react';
import { TAX_CATEGORIES, type CustomerFeeRules } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table, Tabs } from '@/components/ui';
import { askReason, pendingNotice, SectionTitle } from '@/components/admin-ui';

const CH = ['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER', 'PHONE', 'KIOSK'];
const FUL = ['DELIVERY', 'PICKUP', 'DINE_IN'];
const usd = (c: number) => (c / 100).toFixed(2);
const cents = (v: string) => Math.round(Number(v || 0) * 100);

export default function Pricing() {
  const [tab, setTab] = useState('fees');
  return (
    <div className="space-y-4">
      <SectionTitle title="Pricing, fees & tax" hint="Customer fees, item tax categories, membership benefits, commission and royalty schedules, and a checkout-price simulator." />
      <Tabs tabs={[{ id: 'fees', label: 'Customer fees' }, { id: 'tax', label: 'Tax' }, { id: 'members', label: 'Memberships' }, { id: 'schedules', label: 'Commission & royalties' }, { id: 'sim', label: 'Simulator' }]} active={tab} onChange={setTab} />
      {tab === 'fees' && <Fees />}
      {tab === 'tax' && <Tax />}
      {tab === 'members' && <Members />}
      {tab === 'schedules' && <Schedules />}
      {tab === 'sim' && <Simulator />}
    </div>
  );
}

function ListPick({ value, all, onChange }: { value: string[]; all: string[]; onChange: (v: string[]) => void }) {
  return <div className="flex flex-wrap gap-2">{all.map((x) => <label key={x} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={value.includes(x)} onChange={(e) => onChange(e.target.checked ? [...value, x] : value.filter((y) => y !== x))} />{x.toLowerCase().replace('_', ' ')}</label>)}<span className="text-xs text-ink-500">(none = all)</span></div>;
}

function Fees() {
  const { data } = useApi<{ rules: CustomerFeeRules }>('/admin/pricing/fees');
  const { run, error } = useAction();
  const [r, setR] = useState<CustomerFeeRules | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => { if (data) setR(data.rules); }, [data]);
  if (!r) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {error && <Alert>{error}</Alert>}{info && <Alert tone="info">{info}</Alert>}
      <Card title="Service fee (platform)"><div className="grid grid-cols-3 gap-2"><Input label="%" value={r.service.bps / 100} onChange={(e) => setR({ ...r, service: { ...r.service, bps: Math.round(Number(e.target.value) * 100) } })} /><Input label="Min $" value={usd(r.service.minCents)} onChange={(e) => setR({ ...r, service: { ...r.service, minCents: cents(e.target.value) } })} /><Input label="Cap $" value={usd(r.service.capCents)} onChange={(e) => setR({ ...r, service: { ...r.service, capCents: cents(e.target.value) } })} /></div><div className="mt-2 text-xs font-medium text-ink-500">Channels</div><ListPick value={r.service.channels} all={CH} onChange={(v) => setR({ ...r, service: { ...r.service, channels: v } })} /><div className="mt-1 text-xs font-medium text-ink-500">Fulfillment</div><ListPick value={r.service.fulfillments} all={FUL} onChange={(v) => setR({ ...r, service: { ...r.service, fulfillments: v } })} /><p className="mt-1 text-xs text-ink-500">Members with “service fee waived” pay nothing.</p></Card>
      <Card title="Small-order fee (platform)"><div className="grid grid-cols-2 gap-2"><Input label="Under $" value={usd(r.smallOrder.thresholdCents)} onChange={(e) => setR({ ...r, smallOrder: { ...r.smallOrder, thresholdCents: cents(e.target.value) } })} /><Input label="Fee $" value={usd(r.smallOrder.feeCents)} onChange={(e) => setR({ ...r, smallOrder: { ...r.smallOrder, feeCents: cents(e.target.value) } })} /></div><div className="mt-2 text-xs font-medium text-ink-500">Channels</div><ListPick value={r.smallOrder.channels} all={CH} onChange={(v) => setR({ ...r, smallOrder: { ...r.smallOrder, channels: v } })} /><div className="mt-1 text-xs font-medium text-ink-500">Fulfillment</div><ListPick value={r.smallOrder.fulfillments} all={FUL} onChange={(v) => setR({ ...r, smallOrder: { ...r.smallOrder, fulfillments: v } })} /></Card>
      <Card title="Packaging fee (to the merchant)"><div className="grid grid-cols-2 gap-2"><Input label="Per order $" value={usd(r.packaging.perOrderCents)} onChange={(e) => setR({ ...r, packaging: { ...r.packaging, perOrderCents: cents(e.target.value) } })} /><Input label="Per item $" value={usd(r.packaging.perItemCents)} onChange={(e) => setR({ ...r, packaging: { ...r.packaging, perItemCents: cents(e.target.value) } })} /></div><div className="mt-2 text-xs font-medium text-ink-500">Fulfillment</div><ListPick value={r.packaging.fulfillments} all={FUL} onChange={(v) => setR({ ...r, packaging: { ...r.packaging, fulfillments: v } })} /><p className="mt-1 text-xs text-ink-500">A location&apos;s own packaging fee replaces the per-order amount.</p></Card>
      <div className="lg:col-span-3"><Button onClick={() => { const reason = askReason('changing customer fees'); if (reason) run(async () => setInfo(pendingNotice(await api.post('/admin/pricing/fees', { rules: r, reason })) || 'Saved.')); }}>Request change</Button><span className="ml-3 text-xs text-ink-500">Fee changes apply after a second person approves them. Try them in the Simulator first.</span></div>
    </div>
  );
}

function Tax() {
  const { can } = useSession();
  const { data, reload } = useApi<{ rates: { id: string; locationId: string | null; region: string | null; category: string; rateBps: number; label: string | null }[] }>('/tax-rates');
  const { data: locs } = useApi<{ id: string; name: string }[]>('/admin/locations');
  const { run, error } = useAction();
  const [f, setF] = useState({ scope: 'region', region: '', locationId: '', category: 'BEVERAGE', rate: '' });
  return (
    <Card title="Tax rates by item category">
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-ink-500">Most specific wins: location → region (state) → platform default → the location&apos;s own rate. EXEMPT is always 0%. Each menu item has a tax category.</p>
      <Table rows={data?.rates || []} empty="No category rates yet — every item uses its location's rate." cols={[{ key: 'c', label: 'Category', render: (r) => TAX_CATEGORIES.find((c) => c.key === r.category)?.label || r.category }, { key: 's', label: 'Applies to', render: (r) => r.locationId ? locs?.find((l) => l.id === r.locationId)?.name || 'location' : r.region ? `region ${r.region}` : 'all locations' }, { key: 'r', label: 'Rate', render: (r) => `${(r.rateBps / 100).toFixed(3)}%` }, { key: 'l', label: 'Label', render: (r) => r.label }, { key: 'x', label: '', render: (r) => can('finance.manage') ? <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/admin/tax-rates/${r.id}`); reload(); })}>Remove</button> : null }]} />
      {can('finance.manage') && <div className="mt-3 grid gap-2 sm:grid-cols-5"><Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="region">Region</option><option value="location">Location</option><option value="all">All locations</option></Select>{f.scope === 'region' ? <Input placeholder="State, e.g. NY" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /> : f.scope === 'location' ? <Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">Location…</option>{locs?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select> : <span />}<Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{TAX_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select><Input placeholder="Rate %" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /><Button size="sm" onClick={() => run(async () => { await api.post('/admin/tax-rates', { category: f.category, rateBps: Math.round(Number(f.rate) * 100), region: f.scope === 'region' ? f.region : null, locationId: f.scope === 'location' ? f.locationId : null }); setF({ ...f, rate: '' }); reload(); })}>Add rate</Button></div>}
      <TaxEngineNote />
    </Card>
  );
}

/** 9.5-X — the active tax engine (env TAX_PROVIDER); the rate table above is also the fallback when a provider fails. */
function TaxEngineNote() {
  const { data } = useApi<{ engine: string; requested: string; configured: boolean; reason: string | null; cacheTtlSeconds: number; cacheEntries: number; lastError: { at: string; message: string } | null; stats: { calls: number; cacheHits: number; fallbacks: number } }>('/admin/pricing/tax-engine');
  if (!data) return null;
  const label: Record<string, string> = { builtin: 'Built-in rate table', taxjar: 'TaxJar', avalara: 'Avalara AvaTax', mock: 'Mock provider (testing)' };
  return (
    <div className="mt-3 rounded-lg bg-ink-50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2"><b>Tax engine:</b> <Badge tone={data.engine === 'builtin' ? 'neutral' : 'good'}>{label[data.engine] || data.engine}</Badge>{data.reason && <span className="text-amber-700">{data.reason}</span>}</div>
      {data.engine === 'builtin'
        ? <p className="mt-1 text-ink-500">Quotes use the rates above. Set TAX_PROVIDER=taxjar (TAXJAR_API_KEY) or TAX_PROVIDER=avalara (AVALARA_ACCOUNT_ID, AVALARA_LICENSE_KEY, AVALARA_COMPANY_CODE) on the API to use an external service.</p>
        : <p className="mt-1 text-ink-500">Quotes are priced by {label[data.engine]}; results are cached for {data.cacheTtlSeconds}s per cart ({data.cacheEntries} cached). If the service fails, the rates above are used and the customer sees an estimate warning. Calls {data.stats.calls} · cache hits {data.stats.cacheHits} · fallbacks {data.stats.fallbacks}{data.lastError ? ` · last error ${new Date(data.lastError.at).toLocaleString()}: ${data.lastError.message}` : ''}</p>}
    </div>
  );
}

function Members() {
  const { can } = useSession();
  const { data, reload } = useApi<{ id: string; name: string; priceCents: number; interval: string; isActive: boolean; benefits: { freeDeliveryAboveCents?: number; serviceFeeWaived?: boolean; creditCentsPerMonth?: number; priorityWaitlist?: boolean } }[]>('/admin/membership-plans');
  const { run, error } = useAction();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && <Alert>{error}</Alert>}
      {data?.map((p) => (
        <Card key={p.id} title={<span>{p.name} · {money(p.priceCents)}/{p.interval.toLowerCase()} {!p.isActive && <Badge>off</Badge>}</span>}>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Input label="Free delivery above $" defaultValue={p.benefits.freeDeliveryAboveCents !== undefined ? usd(p.benefits.freeDeliveryAboveCents) : ''} disabled={!can('growth.manage')} onBlur={(e) => run(async () => { await api.patch(`/admin/membership-plans/${p.id}`, { benefits: { freeDeliveryAboveCents: cents(e.target.value) } }); reload(); })} />
            <Input label="Monthly credit $" defaultValue={usd(p.benefits.creditCentsPerMonth || 0)} disabled={!can('growth.manage')} onBlur={(e) => run(async () => { await api.patch(`/admin/membership-plans/${p.id}`, { benefits: { creditCentsPerMonth: cents(e.target.value) } }); reload(); })} />
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!can('growth.manage')} checked={!!p.benefits.serviceFeeWaived} onChange={(e) => run(async () => { await api.patch(`/admin/membership-plans/${p.id}`, { benefits: { serviceFeeWaived: e.target.checked } }); reload(); })} /> Service fee waived</label>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!can('growth.manage')} checked={!!p.benefits.priorityWaitlist} onChange={(e) => run(async () => { await api.patch(`/admin/membership-plans/${p.id}`, { benefits: { priorityWaitlist: e.target.checked } }); reload(); })} /> Priority waitlist</label>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Schedules() {
  const { data } = useApi<{ commission: { plan: string; version: number; type: string; channel: string; fulfillment: string; bps: number; cents: number; capCents: number | null }[]; royalties: { id: string; name: string; org: string; ownershipType: string; royaltyBps: number; royaltyRules: unknown[] }[]; promotions: { code: string; funder: string; platformSharePct: number | null; kind: string; value: number; uses: number }[]; scheduledPriceChanges: { id: string; menuItemId: string; newPriceCents: number; effectiveAt: string; status: string }[] }>('/admin/pricing/overview');
  if (!data) return null;
  return (
    <div className="space-y-4">
      <Card title="Merchant commission & fees (published plan versions)"><Table rows={data.commission} cols={[{ key: 'p', label: 'Plan', render: (r) => `${r.plan} v${r.version}` }, { key: 't', label: 'Fee', render: (r) => r.type.toLowerCase().replace(/_/g, ' ') }, { key: 'c', label: 'Channel', render: (r) => `${r.channel.toLowerCase()} · ${r.fulfillment.toLowerCase()}` }, { key: 'v', label: 'Rate', render: (r) => `${r.bps ? `${r.bps / 100}%` : ''}${r.cents ? ` + ${money(r.cents)}` : ''}${r.capCents ? ` (cap ${money(r.capCents)})` : ''}` || '0' }]} /></Card>
      <Card title="Brand royalties & revenue share"><Table rows={data.royalties} cols={[{ key: 'b', label: 'Brand', render: (r) => <a className="underline" href={`/admin/brands/${r.id}`}>{r.name}</a> }, { key: 'o', label: 'Merchant', render: (r) => r.org }, { key: 't', label: 'Ownership', render: (r) => r.ownershipType.toLowerCase().replace('_', ' ') }, { key: 'r', label: 'Royalty', render: (r) => r.royaltyRules.length ? `${r.royaltyRules.length} rule(s)` : `${r.royaltyBps / 100}% flat` }]} /></Card>
      <Card title="Promotion funding"><Table rows={data.promotions} cols={[{ key: 'c', label: 'Code', render: (r) => r.code }, { key: 'k', label: 'Offer', render: (r) => `${r.kind.toLowerCase()} ${r.kind === 'PERCENT' ? `${r.value}%` : money(r.value)}` }, { key: 'f', label: 'Funded by', render: (r) => r.platformSharePct ? `platform ${r.platformSharePct}% / merchant ${100 - r.platformSharePct}%` : r.funder.toLowerCase() }, { key: 'u', label: 'Uses', render: (r) => r.uses }]} /></Card>
      <Card title="Scheduled price changes"><Table rows={data.scheduledPriceChanges} empty="None." cols={[{ key: 'i', label: 'Item', render: (r) => r.menuItemId.slice(0, 8) }, { key: 'p', label: 'New price', render: (r) => money(r.newPriceCents) }, { key: 'w', label: 'From', render: (r) => new Date(r.effectiveAt).toLocaleString() }, { key: 's', label: 'Status', render: (r) => <Badge>{r.status}</Badge> }]} /></Card>
    </div>
  );
}

function Simulator() {
  const { data: locs } = useApi<{ id: string; name: string }[]>('/admin/locations');
  const { data: fees } = useApi<{ rules: CustomerFeeRules }>('/admin/pricing/fees');
  const [locId, setLocId] = useState('');
  const { data: menus } = useApi<{ categories: { items: { id: string; name: string; priceCents: number; modifierGroups: { required: boolean; options: { id: string }[] }[] }[] }[] }[]>(locId ? `/public/locations/${locId}/menus?channel=MARKETPLACE` : null, { deps: [locId] });
  const items = (menus || []).flatMap((m) => m.categories.flatMap((c) => c.items));
  const [cart, setCart] = useState<Record<string, number>>({});
  const [ch, setCh] = useState('MARKETPLACE');
  const [ful, setFul] = useState('PICKUP');
  const [promo, setPromo] = useState('');
  const [draft, setDraft] = useState({ serviceBps: '', smallUnder: '', smallFee: '', packaging: '', taxStandard: '' });
  const [res, setRes] = useState<{ current: Record<string, number>; proposed: Record<string, number>; delta: Record<string, number> } | null>(null);
  const { run, error } = useAction();
  const simulate = () => run(async () => {
    const base = fees!.rules;
    const feeRules = { ...base, service: { ...base.service, bps: draft.serviceBps ? Math.round(Number(draft.serviceBps) * 100) : base.service.bps }, smallOrder: draft.smallUnder ? { ...base.smallOrder, thresholdCents: cents(draft.smallUnder), feeCents: cents(draft.smallFee) } : base.smallOrder, packaging: draft.packaging ? { ...base.packaging, perOrderCents: cents(draft.packaging) } : base.packaging };
    const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([id, q]) => { const it = items.find((i) => i.id === id)!; return { menuItemId: id, quantity: q, modifierOptionIds: it.modifierGroups.filter((g) => g.required).map((g) => g.options[0].id) }; });
    setRes(await api.post('/pricing/simulate', { cart: { locationId: locId, channel: ch, fulfillmentType: ful, lines, promoCode: promo || undefined }, draft: { feeRules, ...(draft.taxStandard ? { taxRates: { STANDARD: Math.round(Number(draft.taxStandard) * 100) } } : {}) } }));
  });
  const rows = ['subtotalCents', 'discountCents', 'taxCents', 'serviceFeeCents', 'smallOrderFeeCents', 'packagingFeeCents', 'deliveryFeeCents', 'totalCents', 'commissionCents'];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && <Alert>{error}</Alert>}
      <Card title="Sample cart">
        <div className="grid grid-cols-3 gap-2"><Select value={locId} onChange={(e) => { setLocId(e.target.value); setCart({}); }}><option value="">Location…</option>{locs?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select><Select value={ch} onChange={(e) => setCh(e.target.value)}>{CH.map((c) => <option key={c}>{c}</option>)}</Select><Select value={ful} onChange={(e) => setFul(e.target.value)}><option>PICKUP</option><option>DINE_IN</option></Select></div>
        <div className="mt-2 max-h-56 space-y-1 overflow-auto">{items.map((i) => <div key={i.id} className="flex items-center justify-between text-sm"><span>{i.name} <span className="text-xs text-ink-500">{money(i.priceCents)}</span></span><input type="number" min={0} className="w-16 rounded border border-ink-100 px-1" value={cart[i.id] || 0} onChange={(e) => setCart({ ...cart, [i.id]: Number(e.target.value) })} /></div>)}</div>
        <Input className="mt-2" label="Promo code" value={promo} onChange={(e) => setPromo(e.target.value)} />
      </Card>
      <Card title="Draft rules">
        <div className="grid grid-cols-2 gap-2"><Input label="Service fee %" placeholder={fees ? String(fees.rules.service.bps / 100) : ''} value={draft.serviceBps} onChange={(e) => setDraft({ ...draft, serviceBps: e.target.value })} /><Input label="Standard tax %" value={draft.taxStandard} onChange={(e) => setDraft({ ...draft, taxStandard: e.target.value })} /><Input label="Small-order under $" value={draft.smallUnder} onChange={(e) => setDraft({ ...draft, smallUnder: e.target.value })} /><Input label="Small-order fee $" value={draft.smallFee} onChange={(e) => setDraft({ ...draft, smallFee: e.target.value })} /><Input label="Packaging per order $" value={draft.packaging} onChange={(e) => setDraft({ ...draft, packaging: e.target.value })} /></div>
        <Button className="mt-2" disabled={!locId || !Object.values(cart).some((q) => q > 0) || !fees} onClick={simulate}>Simulate</Button>
        {res && <table className="mt-3 w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th /><th>Now</th><th>Draft</th><th>Change</th></tr></thead><tbody>{rows.map((k) => <tr key={k} className={`border-t border-ink-50 ${k === 'totalCents' ? 'font-semibold' : ''}`}><td>{k.replace('Cents', '').replace(/([A-Z])/g, ' $1').toLowerCase()}</td><td>{money(res.current[k])}</td><td>{money(res.proposed[k])}</td><td className={res.delta[k] ? (res.delta[k] > 0 ? 'text-red-700' : 'text-emerald-700') : ''}>{res.delta[k] ? `${res.delta[k] > 0 ? '+' : ''}${money(res.delta[k])}` : '—'}</td></tr>)}</tbody></table>}
      </Card>
    </div>
  );
}
