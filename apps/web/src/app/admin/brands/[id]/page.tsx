'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table, Textarea } from '@/components/ui';

interface Rule { type: 'BPS' | 'PER_ITEM' | 'TIERED'; bps?: number; cents?: number; tiers?: { uptoCents: number | null; bps: number }[]; channel?: string; minGuaranteeCents?: number }
interface Brand { id: string; name: string; organizationId: string; ownershipType: string; ownerName: string | null; operatingRights: string | null; territoryRegionIds: string[]; contractStart: string | null; contractEnd: string | null; rightsStatus: string; rightsNote: string | null; authorizedChannels: string[]; royaltyRules: Rule[]; royaltyBps: number; presentationStandards: string | null; assets: { kind: string; url: string; label?: string; approved?: boolean }[]; description: string | null }
interface Detail { brand: Brand; menus: { id: string; name: string; location: string; blockedReason: string | null }[]; kitchens: { kitchenId: string; kitchen: string; isActive: boolean }[]; reviews: { id: string; kind: string; score: number | null; result: string; notes: string | null; reviewerEmail: string | null; createdAt: string }[]; blockedReason: string | null }
interface Statement { salesCents: number; units: number; orders: number; byChannel: { channel: string; salesCents: number; units: number }[]; byLocation: { location: string; salesCents: number }[]; topItems: { name: string; units: number; salesCents: number }[]; royalty: { royaltyCents: number; lines: { rule: string; cents: number }[] }; quality: { reviews: number; avgScore: number | null; fails: number } }
const CHANNELS = ['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER', 'PHONE', 'WALK_IN', 'KIOSK', 'CORPORATE', 'CAMPUS'];

/** Brand rights & partnership: ownership, territories, channels, contract, royalty rules, assets, reviews, statement. */
export default function BrandDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/brands/${id}`);
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const from = new Date(`${month}-01T00:00:00`);
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  const { data: st } = useApi<Statement>(`/brands/${id}/statement?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { deps: [month] });
  const { run, error } = useAction();
  const [b, setB] = useState<Brand | null>(null);
  const [rv, setRv] = useState({ kind: 'QUALITY_REVIEW', score: '4', result: 'PASS', notes: '' });
  useEffect(() => { if (d) setB(d.brand); }, [d]);
  if (!d || !b) return null;
  const commercial = can('merchants.manage') || can('catalog.manage');
  const save = (fields: (keyof Brand)[]) => run(async () => { await api.patch(`/brands/${id}`, Object.fromEntries(fields.map((k) => [k, b[k]]))); reload(); });
  return (
    <div className="space-y-4">
      <div><Link href="/admin/brands" className="text-xs text-ink-500 underline">← Brands</Link><h1 className="text-2xl font-bold">{b.name}</h1><p className="text-sm">{d.blockedReason ? <Badge tone="bad">sales stopped: {d.blockedReason}</Badge> : <Badge tone="good">selling</Badge>}</p></div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ownership & rights">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label="Ownership" disabled={!commercial} value={b.ownershipType} onChange={(e) => setB({ ...b, ownershipType: e.target.value })}>{['COMPANY_OWNED', 'LICENSED', 'INDEPENDENT', 'CREATOR'].map((o) => <option key={o} value={o}>{o.toLowerCase().replace('_', ' ')}</option>)}</Select>
            <Input label="Owner / licensor" disabled={!commercial} value={b.ownerName || ''} onChange={(e) => setB({ ...b, ownerName: e.target.value || null })} />
            <Input label="Contract start" type="date" disabled={!commercial} value={b.contractStart?.slice(0, 10) || ''} onChange={(e) => setB({ ...b, contractStart: e.target.value ? new Date(e.target.value).toISOString() : null })} />
            <Input label="Contract end" type="date" disabled={!commercial} value={b.contractEnd?.slice(0, 10) || ''} onChange={(e) => setB({ ...b, contractEnd: e.target.value ? new Date(e.target.value).toISOString() : null })} />
            <Select label="Rights status" disabled={!commercial} value={b.rightsStatus} onChange={(e) => setB({ ...b, rightsStatus: e.target.value })}>{['ACTIVE', 'SUSPENDED', 'EXPIRED'].map((o) => <option key={o}>{o}</option>)}</Select>
            <Input label="Rights note (required to stop sales)" disabled={!commercial} value={b.rightsNote || ''} onChange={(e) => setB({ ...b, rightsNote: e.target.value || null })} />
          </div>
          <Textarea className="mt-2" label="Operating rights" disabled={!commercial} rows={2} value={b.operatingRights || ''} onChange={(e) => setB({ ...b, operatingRights: e.target.value || null })} />
          <div className="mt-2 text-xs font-medium text-ink-500">Territories (none = anywhere)</div>
          <div className="flex flex-wrap gap-2">{regions?.map((r) => <label key={r.id} className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={!commercial} checked={b.territoryRegionIds.includes(r.id)} onChange={(e) => setB({ ...b, territoryRegionIds: e.target.checked ? [...b.territoryRegionIds, r.id] : b.territoryRegionIds.filter((x) => x !== r.id) })} />{r.name}</label>)}</div>
          <div className="mt-2 text-xs font-medium text-ink-500">Authorized channels (none = all)</div>
          <div className="flex flex-wrap gap-2">{CHANNELS.map((c) => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!commercial} checked={b.authorizedChannels.includes(c)} onChange={(e) => setB({ ...b, authorizedChannels: e.target.checked ? [...b.authorizedChannels, c] : b.authorizedChannels.filter((x) => x !== c) })} />{c.toLowerCase()}</label>)}</div>
          {commercial && <Button className="mt-3" size="sm" onClick={() => save(['ownershipType', 'ownerName', 'contractStart', 'contractEnd', 'rightsStatus', 'rightsNote', 'operatingRights', 'territoryRegionIds', 'authorizedChannels'])}>Save rights</Button>}
        </Card>
        <Card title="Royalty & revenue share">
          <p className="text-xs text-ink-500">Rules add up; the minimum guarantee tops up the total. With no rules the flat rate applies ({b.royaltyBps / 100}%).</p>
          {b.royaltyRules.map((r, i) => (
            <div key={i} className="mt-2 rounded-lg bg-ink-50 p-2 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <Select disabled={!commercial} value={r.type} onChange={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, type: e.target.value as Rule['type'] } : x)) })}><option value="BPS">% of sales</option><option value="PER_ITEM">per item</option><option value="TIERED">tiered %</option></Select>
                {r.type === 'BPS' && <Input placeholder="%" disabled={!commercial} value={(r.bps || 0) / 100} onChange={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, bps: Math.round(Number(e.target.value) * 100) } : x)) })} />}
                {r.type === 'PER_ITEM' && <Input placeholder="$ per item" disabled={!commercial} value={(r.cents || 0) / 100} onChange={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, cents: Math.round(Number(e.target.value) * 100) } : x)) })} />}
                {r.type === 'TIERED' && <Input placeholder="e.g. 1000:8,∞:5" disabled={!commercial} defaultValue={(r.tiers || []).map((t) => `${t.uptoCents === null ? '∞' : t.uptoCents / 100}:${t.bps / 100}`).join(',')} onBlur={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, tiers: e.target.value.split(',').map((p) => { const [u, pc] = p.split(':'); return { uptoCents: u.trim() === '∞' ? null : Math.round(Number(u) * 100), bps: Math.round(Number(pc) * 100) }; }) } : x)) })} />}
                <Select disabled={!commercial} value={r.channel || ''} onChange={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, channel: e.target.value || undefined } : x)) })}><option value="">all channels</option>{CHANNELS.map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}</Select>
              </div>
              <div className="mt-1 flex items-center gap-2"><Input placeholder="Minimum guarantee $" disabled={!commercial} value={r.minGuaranteeCents ? r.minGuaranteeCents / 100 : ''} onChange={(e) => setB({ ...b, royaltyRules: b.royaltyRules.map((x, j) => (j === i ? { ...x, minGuaranteeCents: e.target.value ? Math.round(Number(e.target.value) * 100) : undefined } : x)) })} />{commercial && <button className="text-xs text-red-600" onClick={() => setB({ ...b, royaltyRules: b.royaltyRules.filter((_, j) => j !== i) })}>Remove</button>}</div>
            </div>
          ))}
          {commercial && <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" onClick={() => setB({ ...b, royaltyRules: [...b.royaltyRules, { type: 'BPS', bps: 500 }] })}>Add rule</Button><Button size="sm" onClick={() => save(['royaltyRules'])}>Save royalty</Button></div>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Brand assets & presentation standards">
          <Textarea label="Presentation standards" rows={3} value={b.presentationStandards || ''} onChange={(e) => setB({ ...b, presentationStandards: e.target.value || null })} />
          <div className="mt-2 space-y-1">{b.assets.map((a, i) => <div key={i} className="flex items-center justify-between text-sm"><a className="underline" href={a.url} target="_blank" rel="noreferrer">{a.label || a.kind.toLowerCase()}</a><span className="flex items-center gap-2">{a.approved ? <Badge tone="good">approved</Badge> : <Badge tone="warn">pending</Badge>}{commercial && <button className="text-xs underline" onClick={() => setB({ ...b, assets: b.assets.map((x, j) => (j === i ? { ...x, approved: !x.approved } : x)) })}>{a.approved ? 'Unapprove' : 'Approve'}</button>}<button className="text-xs text-red-600" onClick={() => setB({ ...b, assets: b.assets.filter((_, j) => j !== i) })}>×</button></span></div>)}</div>
          <button className="mt-1 text-xs underline" onClick={() => { const url = window.prompt('Asset URL'); if (url) setB({ ...b, assets: [...b.assets, { kind: 'PHOTO', url, label: window.prompt('Label') || undefined, approved: false }] }); }}>+ Add asset</button>
          <div><Button className="mt-2" size="sm" onClick={() => save(['presentationStandards', 'assets'])}>Save</Button></div>
        </Card>
        <Card title="Kitchens & menus">
          <div className="text-xs font-medium text-ink-500">Authorized kitchens</div>
          {d.kitchens.map((k) => <div key={k.kitchenId} className="flex justify-between text-sm"><span>{k.kitchen}</span>{commercial && <button className="text-xs underline" onClick={() => run(async () => { await api.post(`/brands/${id}/kitchens`, { kitchenId: k.kitchenId, isActive: !k.isActive }); reload(); })}>{k.isActive ? 'authorized — revoke' : 'not authorized — authorize'}</button>}</div>)}
          <div className="mt-2 text-xs font-medium text-ink-500">Menus</div>
          {d.menus.map((m) => <div key={m.id} className="text-sm">{m.name} · {m.location}{m.blockedReason && <span className="text-xs text-red-700"> · {m.blockedReason}</span>}</div>)}
        </Card>
      </div>
      <Card title="Recipe approvals & quality reviews">
        {(can('culinary.manage') || can('catalog.manage')) && <div className="mb-3 grid gap-2 sm:grid-cols-[170px_90px_130px_1fr_auto]"><Select value={rv.kind} onChange={(e) => setRv({ ...rv, kind: e.target.value })}><option value="QUALITY_REVIEW">Quality review</option><option value="RECIPE_APPROVAL">Recipe approval</option><option value="MYSTERY_SHOP">Mystery shop</option></Select><Select value={rv.score} onChange={(e) => setRv({ ...rv, score: e.target.value })}>{[1, 2, 3, 4, 5].map((s) => <option key={s}>{s}</option>)}</Select><Select value={rv.result} onChange={(e) => setRv({ ...rv, result: e.target.value })}><option>PASS</option><option>NEEDS_WORK</option><option>FAIL</option></Select><Input placeholder="Notes" value={rv.notes} onChange={(e) => setRv({ ...rv, notes: e.target.value })} /><Button size="sm" onClick={() => run(async () => { await api.post(`/brands/${id}/reviews`, { ...rv, score: Number(rv.score), notes: rv.notes || undefined }); setRv({ ...rv, notes: '' }); reload(); })}>Record</Button></div>}
        <Table rows={d.reviews} empty="No reviews yet." cols={[{ key: 'k', label: 'Kind', render: (r) => r.kind.toLowerCase().replace('_', ' ') }, { key: 's', label: 'Score', render: (r) => r.score ?? '—' }, { key: 'r', label: 'Result', render: (r) => <Badge tone={r.result === 'PASS' ? 'good' : r.result === 'FAIL' ? 'bad' : 'warn'}>{r.result}</Badge> }, { key: 'n', label: 'Notes', render: (r) => <span className="text-xs">{r.notes}</span> }, { key: 'w', label: 'By', render: (r) => <span className="text-xs">{r.reviewerEmail} · {when(r.createdAt)}</span> }]} />
      </Card>
      <Card title="Partner statement" action={<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}>
        {st && <div className="grid gap-4 lg:grid-cols-3">
          <div className="text-sm"><div className="text-2xl font-bold">{money(st.salesCents)}</div><div className="text-ink-500">{st.orders} orders · {st.units} items</div><div className="mt-2 font-semibold">Royalty {money(st.royalty.royaltyCents)}</div>{st.royalty.lines.map((l, i) => <div key={i} className="text-xs text-ink-500">{l.rule}: {money(l.cents)}</div>)}<div className="mt-2 text-xs">Quality: {st.quality.reviews} reviews · avg {st.quality.avgScore?.toFixed(1) ?? '—'} · {st.quality.fails} fails</div></div>
          <div><div className="text-xs font-semibold text-ink-500">By channel</div>{st.byChannel.map((c) => <div key={c.channel} className="flex justify-between text-sm"><span>{c.channel.toLowerCase()}</span><span>{money(c.salesCents)}</span></div>)}<div className="mt-2 text-xs font-semibold text-ink-500">By location</div>{st.byLocation.map((c) => <div key={c.location} className="flex justify-between text-sm"><span>{c.location}</span><span>{money(c.salesCents)}</span></div>)}</div>
          <div><div className="text-xs font-semibold text-ink-500">Top items</div>{st.topItems.map((t) => <div key={t.name} className="flex justify-between text-sm"><span>{t.name} ×{t.units}</span><span>{money(t.salesCents)}</span></div>)}</div>
        </div>}
      </Card>
    </div>
  );
}
