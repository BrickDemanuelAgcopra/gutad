'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Tabs, statusTone, Table } from '@/components/ui';
import { useMerchant } from '../context';
import { ExpoBoard, KitchenPerformance, KitchenSetup, PackingBoard, PickupBoard, StationsBoard } from '@/components/kitchen';


/** Station screens, packing screen, supply & costing — for shared-kitchen locations. */
export default function KitchenPage() {
  const { loc, org } = useMerchant();
  const kitchenId = loc?.kitchenId || null;
  const [tab, setTab] = useState('stations');
  const { data: kitchen, reload: reloadKitchen } = useApi<{ loadLevel: string; stations: { id: string; code: string; name: string; targetMinutes: number; maxConcurrent: number | null; isAvailable: boolean }[]; brands: { brand: { id: string; name: string } }[] }>(kitchenId ? `/kitchens/${kitchenId}` : null, { deps: [kitchenId] });
  const { data: stock, reload: reloadStock } = useApi<{ ingredient: { id: string; name: string; unit: string; costCentsPerUnit: number }; onHand: number; parLevel: number }[]>(kitchenId && tab === 'supply' ? `/kitchens/${kitchenId}/stock` : null, { deps: [kitchenId, tab] });
  const { data: contrib } = useApi<{ orders: number; netSalesCents: number; purchasesCents: number; laborCents: number; wasteCents: number; royaltyCents: number; contributionCents: number }>(kitchenId && tab === 'supply' ? `/kitchens/${kitchenId}/contribution` : null, { deps: [kitchenId, tab] });
  const { run, error } = useAction();
  const [newKitchen, setNewKitchen] = useState({ name: '', addressLine1: '', city: '', region: '', postalCode: '' });
  if (!loc) return null;
  if (!kitchenId) {
    return (
      <div className="space-y-4">
      <h1 className="text-2xl font-bold">Kitchen</h1>
      <Tabs tabs={[{ id: 'packing', label: 'Packing' }, { id: 'pickup', label: 'Pickup & runner' }, { id: 'setup', label: 'Setup' }, { id: 'kitchen', label: 'Production kitchen' }]} active={['packing', 'pickup', 'setup', 'kitchen'].includes(tab) ? tab : 'packing'} onChange={setTab} />
      {(tab === 'packing' || !['pickup', 'setup', 'kitchen'].includes(tab)) && <PackingBoard path={`/locations/${loc.id}/packing`} />}
      {tab === 'pickup' && <PickupBoard locationId={loc.id} />}
      {tab === 'setup' && <KitchenSetup kitchenId={null} locationId={loc.id} stations={[]} reloadKitchen={() => undefined} />}
      {tab === 'kitchen' && (
      <Card title="No shared kitchen linked to this location">
        <p className="mb-2 text-sm text-ink-500">Create a production kitchen with stations, then link this location to it in Settings. Brands you create can be produced here and sold from one multi-brand page.</p>
        <div className="grid gap-2 sm:grid-cols-2">{(['name', 'addressLine1', 'city', 'region', 'postalCode'] as const).map((k) => <Input key={k} label={k} value={newKitchen[k]} onChange={(e) => setNewKitchen({ ...newKitchen, [k]: e.target.value })} />)}</div>
        {error && <Alert>{error}</Alert>}
        <Button className="mt-2" disabled={!newKitchen.name || !org} onClick={() => run(async () => { const k = await api.post<{ id: string }>(`/organizations/${org!.id}/kitchens`, newKitchen); await api.patch(`/locations/${loc.id}`, { kitchenId: k.id }); location.reload(); })}>Create kitchen & link</Button>
      </Card>
      )}
      </div>
    );
  }
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reloadStock(); });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between print:hidden"><h1 className="text-2xl font-bold">Kitchen</h1>{kitchen && kitchen.loadLevel !== 'NORMAL' && <Badge tone={kitchen.loadLevel === 'BUSY' ? 'warn' : 'bad'}>{kitchen.loadLevel === 'BUSY' ? 'Busy: prep times extended' : 'Overloaded: ASAP orders paused'}</Badge>}</div>
      {error && <Alert>{error}</Alert>}
      <div className="print:hidden"><Tabs tabs={[{ id: 'stations', label: 'Stations' }, { id: 'expo', label: 'Expo' }, { id: 'packing', label: 'Packing' }, { id: 'pickup', label: 'Pickup & runner' }, { id: 'performance', label: 'Performance' }, { id: 'setup', label: 'Setup' }, { id: 'supply', label: 'Supply & costing' }]} active={tab} onChange={setTab} /></div>
      {tab === 'expo' && <ExpoBoard kitchenId={kitchenId} />}
      {tab === 'pickup' && <PickupBoard locationId={loc.id} />}
      {tab === 'performance' && <KitchenPerformance kitchenId={kitchenId} />}
      {tab === 'setup' && <KitchenSetup kitchenId={kitchenId} locationId={loc.id} stations={kitchen?.stations || []} reloadKitchen={() => void reloadKitchen()} />}
      {tab === 'stations' && <StationsBoard kitchenId={kitchenId} stations={kitchen?.stations || []} />}
      {tab === 'packing' && <PackingBoard path={`/kitchens/${kitchenId}/packing`} />}
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
