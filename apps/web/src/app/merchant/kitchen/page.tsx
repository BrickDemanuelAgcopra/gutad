'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Tabs, statusTone, Table } from '@/components/ui';
import { useMerchant } from '../context';

interface Ticket { id: string; stationCode: string | null; status: string; orderNumber: string; promiseAt: string | null; lines: { id: string; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null; status: string }[] }
interface Pack { id: string; orderNumber: string; bagCode: string; status: string; verifiedLineIds: string[]; blockedReason: string | null; lines: { id: string; name: string; quantity: number; status: string; brandId: string | null }[] }

/** Station screens, packing screen, supply & costing — for shared-kitchen locations. */
export default function KitchenPage() {
  const { loc, org } = useMerchant();
  const kitchenId = loc?.kitchenId || null;
  const [tab, setTab] = useState('stations');
  const [station, setStation] = useState('');
  const { data: tickets, reload } = useApi<Ticket[]>(kitchenId && tab === 'stations' ? `/kitchens/${kitchenId}/stations/queue${station ? `?station=${station}` : ''}` : null, { poll: 4000, deps: [kitchenId, station, tab] });
  const { data: packs, reload: reloadPacks } = useApi<Pack[]>(kitchenId && tab === 'packing' ? `/kitchens/${kitchenId}/packing` : null, { poll: 4000, deps: [kitchenId, tab] });
  const { data: kitchen } = useApi<{ stations: { code: string; name: string }[]; brands: { brand: { id: string; name: string } }[] }>(kitchenId ? `/kitchens/${kitchenId}` : null, { deps: [kitchenId] });
  const { data: stock, reload: reloadStock } = useApi<{ ingredient: { id: string; name: string; unit: string; costCentsPerUnit: number }; onHand: number; parLevel: number }[]>(kitchenId && tab === 'supply' ? `/kitchens/${kitchenId}/stock` : null, { deps: [kitchenId, tab] });
  const { data: contrib } = useApi<{ orders: number; netSalesCents: number; purchasesCents: number; laborCents: number; wasteCents: number; royaltyCents: number; contributionCents: number }>(kitchenId && tab === 'supply' ? `/kitchens/${kitchenId}/contribution` : null, { deps: [kitchenId, tab] });
  const { run, error } = useAction();
  const [newKitchen, setNewKitchen] = useState({ name: '', addressLine1: '', city: '', region: '', postalCode: '' });
  if (!loc) return null;
  if (!kitchenId) {
    return (
      <Card title="No shared kitchen linked to this location">
        <p className="mb-2 text-sm text-ink-500">Create a production kitchen with stations, then link this location to it in Settings. Brands you create can be produced here and sold from one multi-brand page.</p>
        <div className="grid gap-2 sm:grid-cols-2">{(['name', 'addressLine1', 'city', 'region', 'postalCode'] as const).map((k) => <Input key={k} label={k} value={newKitchen[k]} onChange={(e) => setNewKitchen({ ...newKitchen, [k]: e.target.value })} />)}</div>
        {error && <Alert>{error}</Alert>}
        <Button className="mt-2" disabled={!newKitchen.name || !org} onClick={() => run(async () => { const k = await api.post<{ id: string }>(`/organizations/${org!.id}/kitchens`, newKitchen); await api.patch(`/locations/${loc.id}`, { kitchenId: k.id }); location.reload(); })}>Create kitchen & link</Button>
      </Card>
    );
  }
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); await reloadPacks(); await reloadStock(); });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Kitchen</h1>
      {error && <Alert>{error}</Alert>}
      <Tabs tabs={[{ id: 'stations', label: 'Stations' }, { id: 'packing', label: 'Packing' }, { id: 'supply', label: 'Supply & costing' }]} active={tab} onChange={setTab} />
      {tab === 'stations' && (
        <>
          <Select value={station} onChange={(e) => setStation(e.target.value)} className="w-48"><option value="">All stations</option>{kitchen?.stations.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {tickets?.map((t) => (
              <Card key={t.id} title={<span>{t.orderNumber} <Badge tone="info">{t.stationCode || 'MAIN'}</Badge></span>} action={<Badge tone={statusTone(t.status)}>{t.status}</Badge>}>
                <div className="text-xs text-ink-500">Promise {when(t.promiseAt)}</div>
                <ul className="mt-2 text-sm">{t.lines.map((l) => <li key={l.id}><b>{l.quantity}×</b> {l.name}{l.modifiers?.length ? ` — ${l.modifiers.map((m) => m.name).join(', ')}` : ''}{l.specialInstructions && <span className="text-amber-700"> “{l.specialInstructions}”</span>}</li>)}</ul>
                <div className="mt-2 flex gap-1">{t.status === 'QUEUED' && <Button size="sm" onClick={() => act(() => api.post(`/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }))}>Start</Button>}{t.status === 'IN_PROGRESS' && <Button size="sm" onClick={() => act(() => api.post(`/tickets/${t.id}/transition`, { status: 'DONE' }))}>Done</Button>}{t.lines.map((l) => l.status !== 'UNAVAILABLE' && <Button key={l.id} size="sm" variant="ghost" onClick={() => act(() => api.post(`/order-lines/${l.id}/unavailable`, { note: 'Out of stock — replacement offered' }))}>86 {l.name}</Button>)}</div>
              </Card>
            ))}
            {!tickets?.length && <p className="text-sm text-ink-500">No tickets in queue.</p>}
          </div>
        </>
      )}
      {tab === 'packing' && (
        <div className="grid gap-3 md:grid-cols-2">
          {packs?.map((p) => (
            <Card key={p.id} title={<span>{p.orderNumber} · bag <span className="font-mono">{p.bagCode}</span></span>} action={<Badge tone={statusTone(p.status)}>{p.status}</Badge>}>
              {p.blockedReason && <Alert>{p.blockedReason}</Alert>}
              <ul className="mt-2 space-y-1 text-sm">{p.lines.map((l) => <li key={l.id} className="flex items-center justify-between"><span className={l.status === 'UNAVAILABLE' ? 'text-red-600 line-through' : ''}>{l.quantity}× {l.name} <Badge tone={statusTone(l.status)}>{l.status}</Badge></span>{!p.verifiedLineIds.includes(l.id) && l.status === 'READY' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/packing/${p.id}/verify`, { lineId: l.id }))}>In bag ✓</Button>}{p.verifiedLineIds.includes(l.id) && <span className="text-xs text-emerald-700">verified</span>}</li>)}</ul>
              <Button className="mt-3 w-full" disabled={p.status === 'BLOCKED'} onClick={() => act(() => api.post(`/packing/${p.id}/release`, {}))}>Release bag</Button>
            </Card>
          ))}
          {!packs?.length && <p className="text-sm text-ink-500">Nothing to pack.</p>}
        </div>
      )}
      {tab === 'supply' && (
        <div className="space-y-4">
          {contrib && <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6 text-sm">{[['Net sales', contrib.netSalesCents], ['Purchases', contrib.purchasesCents], ['Labor', contrib.laborCents], ['Waste', contrib.wasteCents], ['Royalties', contrib.royaltyCents], ['Contribution', contrib.contributionCents]].map(([l, v]) => <div key={String(l)} className="rounded-lg border border-ink-100 bg-white p-3"><div className="text-xs text-ink-500">{l}</div><div className="font-semibold">{money(Number(v))}</div></div>)}</div>}
          <Card title="Ingredient stock">
            <Table rows={stock || []} cols={[{ key: 'n', label: 'Ingredient', render: (r) => r.ingredient.name }, { key: 'o', label: 'On hand', render: (r) => <span className={r.onHand <= r.parLevel ? 'text-red-600' : ''}>{r.onHand} {r.ingredient.unit}</span> }, { key: 'p', label: 'Par', render: (r) => r.parLevel }, { key: 'c', label: 'Cost/unit', render: (r) => money(r.ingredient.costCentsPerUnit) }, { key: 'a', label: '', render: (r) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => { const q = prompt('Receive quantity'); if (q) act(async () => { const po = await api.post<{ id: string }>(`/kitchens/${kitchenId}/purchase-orders`, { supplier: 'Quick receive', lines: [{ ingredientId: r.ingredient.id, quantity: Number(q), unitCostCents: r.ingredient.costCentsPerUnit }] }); await api.post(`/purchase-orders/${po.id}/receive`, { received: [] }); }); }}>Receive</Button><Button size="sm" variant="ghost" onClick={() => { const q = prompt('Waste quantity'); if (q) act(() => api.post(`/kitchens/${kitchenId}/waste`, { ingredientId: r.ingredient.id, quantity: Number(q), reason: 'Spoilage' })); }}>Waste</Button></div> }]} />
            <Button className="mt-2" variant="secondary" onClick={() => { const n = prompt('New ingredient name'); const u = prompt('Unit (g/ml/each)', 'g'); if (n) act(() => api.post('/ingredients', { name: n, unit: u || 'g' })); }}>+ Ingredient</Button>
          </Card>
        </div>
      )}
    </div>
  );
}
