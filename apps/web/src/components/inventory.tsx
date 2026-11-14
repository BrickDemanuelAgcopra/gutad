'use client';
import { useState } from 'react';
import { ITEM_KINDS } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, statusTone, Table, Tabs } from '@/components/ui';

interface Item { id: string; name: string; unit: string; kind: string; purchaseUnit: string | null; purchaseUnitFactor: number; supplierId: string | null; shelfLifeDays: number | null; minTempC: number | null; maxTempC: number | null; onHand: number; parLevel: number; safetyStock: number; valueCents: number; costCentsPerUnit: number; organizationId: string | null }
interface Lot { id: string; ingredient: string; unit: string; lotCode: string; quantity: number; receivedQty: number; expiresAt: string | null; daysLeft: number | null; status: string; storageArea: string | null; supplier: string | null }
interface Supplier { id: string; organizationId: string | null; name: string; contactName: string | null; email: string | null; leadTimeDays: number; approved: boolean; approvedAt: string | null }
interface PO { id: string; supplier: string; status: string; totalCents: number; expectedAt: string | null; receivedAt: string | null; late: boolean; matchStatus: string | null; invoiceNumber: string | null; matchDetail: { varianceCents: number } | null; lines: { id: string; ingredientId: string; ingredient: string; unit: string; quantity: number; unitCostCents: number; receivedQty: number | null; discrepancyNote: string | null }[] }

/** Phase I inventory workspace for one kitchen (used by the merchant Inventory page and admin Supply). */
export function InventoryWorkspace({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const [tab, setTab] = useState('stock');
  return (
    <div className="space-y-4">
      <Tabs tabs={[{ id: 'stock', label: 'Stock' }, { id: 'lots', label: 'Lots & expiry' }, { id: 'receiving', label: 'Purchase orders' }, { id: 'forecast', label: 'Forecast & reorder' }, { id: 'suppliers', label: 'Suppliers' }, { id: 'transfers', label: 'Transfers' }, { id: 'movements', label: 'Movements' }, { id: 'reports', label: 'Reports' }]} active={tab} onChange={setTab} />
      {tab === 'stock' && <Stock kitchenId={kitchenId} organizationId={organizationId} />}
      {tab === 'lots' && <Lots kitchenId={kitchenId} />}
      {tab === 'receiving' && <Receiving kitchenId={kitchenId} organizationId={organizationId} />}
      {tab === 'forecast' && <Forecast kitchenId={kitchenId} />}
      {tab === 'suppliers' && <Suppliers organizationId={organizationId} />}
      {tab === 'transfers' && <Transfers kitchenId={kitchenId} organizationId={organizationId} />}
      {tab === 'movements' && <Movements kitchenId={kitchenId} />}
      {tab === 'reports' && <Reports kitchenId={kitchenId} />}
    </div>
  );
}

function Stock({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const { data, reload } = useApi<Item[]>(`/kitchens/${kitchenId}/inventory/items`, { deps: [kitchenId] });
  const { data: sups } = useApi<Supplier[]>(`/suppliers?organizationId=${organizationId}`, { deps: [organizationId] });
  const { data: areas, reload: ra } = useApi<{ id: string; name: string; kind: string; minTempC: number | null; maxTempC: number | null }[]>(`/kitchens/${kitchenId}/storage-areas`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [edit, setEdit] = useState<Item | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [area, setArea] = useState({ name: '', kind: 'COLD' });
  const [ok, setOk] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <Table rows={data?.filter((i) => i.onHand > 0 || i.parLevel > 0 || i.organizationId) || []} empty="No stocked items." cols={[
        { key: 'n', label: 'Item', render: (i) => <button className="text-left underline" onClick={() => setEdit(i)}>{i.name}<span className="block text-xs text-ink-500 no-underline">{i.kind.toLowerCase()}{i.purchaseUnit ? ` · buys by ${i.purchaseUnit} (${i.purchaseUnitFactor} ${i.unit})` : ''}</span></button> },
        { key: 'o', label: 'On hand', render: (i) => <span className={i.onHand <= Math.max(i.parLevel, i.safetyStock) ? 'font-semibold text-red-700' : ''}>{Math.round(i.onHand * 100) / 100} {i.unit}</span> },
        { key: 'p', label: 'Par / safety', render: (i) => `${i.parLevel} / ${i.safetyStock}` },
        { key: 'v', label: 'Value', render: (i) => money(i.valueCents) },
        { key: 'c', label: 'Count', render: (i) => <Input className="w-24" placeholder={String(Math.round(i.onHand))} value={counts[i.id] ?? ''} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} /> },
      ]} />
      <Button disabled={!Object.values(counts).some((v) => v !== '')} onClick={() => run(async () => { const r = await api.post<{ ingredientId: string; diff: number }[]>(`/kitchens/${kitchenId}/counts`, { counts: Object.entries(counts).filter(([, v]) => v !== '').map(([ingredientId, v]) => ({ ingredientId, counted: Number(v) })), note: 'Stock count' }); setOk(`Count saved: ${r.map((x) => `${x.diff > 0 ? '+' : ''}${x.diff}`).join(', ')}`); setCounts({}); await reload(); })}>Save count</Button>
      {edit && <Card title={`Item: ${edit.name}`} action={<Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Close</Button>}>
        <div className="grid gap-2 sm:grid-cols-4">
          <Select label="Type" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{ITEM_KINDS.map((k) => <option key={k}>{k}</option>)}</Select>
          <Input label="Purchase unit" value={edit.purchaseUnit || ''} onChange={(e) => setEdit({ ...edit, purchaseUnit: e.target.value })} />
          <Input label={`${edit.unit} per purchase unit`} value={String(edit.purchaseUnitFactor)} onChange={(e) => setEdit({ ...edit, purchaseUnitFactor: Number(e.target.value) || 1 })} />
          <Select label="Supplier" value={edit.supplierId || ''} onChange={(e) => setEdit({ ...edit, supplierId: e.target.value || null })}><option value="">—</option>{sups?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.approved ? '' : ' (not approved)'}</option>)}</Select>
          <Input label="Shelf life (days)" value={edit.shelfLifeDays ?? ''} onChange={(e) => setEdit({ ...edit, shelfLifeDays: e.target.value ? Number(e.target.value) : null })} />
          <Input label="Min °C" value={edit.minTempC ?? ''} onChange={(e) => setEdit({ ...edit, minTempC: e.target.value === '' ? null : Number(e.target.value) })} />
          <Input label="Max °C" value={edit.maxTempC ?? ''} onChange={(e) => setEdit({ ...edit, maxTempC: e.target.value === '' ? null : Number(e.target.value) })} />
          <Input label="Par level" value={String(edit.parLevel)} onChange={(e) => setEdit({ ...edit, parLevel: Number(e.target.value) || 0 })} />
          <Input label="Safety stock" value={String(edit.safetyStock)} onChange={(e) => setEdit({ ...edit, safetyStock: Number(e.target.value) || 0 })} />
        </div>
        <Button className="mt-2" size="sm" onClick={() => run(async () => { const master = edit.organizationId ? { kind: edit.kind, purchaseUnit: edit.purchaseUnit || null, purchaseUnitFactor: edit.purchaseUnitFactor, supplierId: edit.supplierId, shelfLifeDays: edit.shelfLifeDays, minTempC: edit.minTempC, maxTempC: edit.maxTempC } : {}; await api.patch(`/kitchens/${kitchenId}/inventory/items/${edit.id}`, { ...master, parLevel: edit.parLevel, safetyStock: edit.safetyStock }); setEdit(null); await reload(); })}>Save</Button>
        {!edit.organizationId && <p className="text-xs text-ink-500">Shared catalog item: Gutad culinary maintains its master data; you set par and safety stock.</p>}
      </Card>}
      <Card title="Storage areas">
        <div className="flex flex-wrap gap-2">{areas?.map((a) => <Badge key={a.id}>{a.name} · {a.kind.toLowerCase()}{a.maxTempC != null ? ` ≤${a.maxTempC}°C` : ''}</Badge>)}</div>
        <div className="mt-2 flex items-end gap-2"><Input label="Name" value={area.name} onChange={(e) => setArea({ ...area, name: e.target.value })} /><Select label="Kind" value={area.kind} onChange={(e) => setArea({ ...area, kind: e.target.value })}>{['WAREHOUSE', 'DRY', 'COLD', 'FREEZER', 'KITCHEN'].map((k) => <option key={k}>{k}</option>)}</Select><Button size="sm" disabled={!area.name} onClick={() => run(async () => { await api.post(`/kitchens/${kitchenId}/storage-areas`, area); setArea({ name: '', kind: 'COLD' }); await ra(); })}>Add</Button></div>
      </Card>
    </div>
  );
}

function Lots({ kitchenId }: { kitchenId: string }) {
  const [status, setStatus] = useState('');
  const { data, reload } = useApi<Lot[]>(`/kitchens/${kitchenId}/lots${status ? `?status=${status}` : ''}`, { deps: [kitchenId, status] });
  const { run, error } = useAction();
  const [trace, setTrace] = useState<{ orders: { number: string; location: string; createdAt: string }[]; locations: string[]; movements: unknown[] } | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Active</option>{['AVAILABLE', 'QUARANTINED', 'EXPIRED', 'WITHDRAWN', 'DEPLETED'].map((s) => <option key={s}>{s}</option>)}</Select>
      <Table rows={data || []} empty="No lots." cols={[
        { key: 'i', label: 'Item', render: (l) => <span>{l.ingredient}<span className="block text-xs text-ink-500">{l.lotCode}{l.supplier ? ` · ${l.supplier}` : ''}</span></span> },
        { key: 'q', label: 'Left', render: (l) => `${Math.round(l.quantity * 100) / 100} / ${l.receivedQty} ${l.unit}` },
        { key: 'e', label: 'Expires', render: (l) => <span className={l.daysLeft != null && l.daysLeft <= 1 ? 'font-semibold text-red-700' : ''}>{l.expiresAt ? `${when(l.expiresAt)} (${l.daysLeft} d)` : '—'}</span> },
        { key: 'a', label: 'Where', render: (l) => l.storageArea || '—' },
        { key: 's', label: 'Status', render: (l) => <Badge tone={l.status === 'QUARANTINED' ? 'bad' : statusTone(l.status)}>{l.status}</Badge> },
        { key: 't', label: '', render: (l) => <button className="text-xs underline" onClick={() => run(async () => setTrace(await api.get(`/safety/trace/lot/${l.id}`)))}>Trace</button> },
      ]} />
      {trace && <Card title="Where this lot went" action={<Button size="sm" variant="ghost" onClick={() => { setTrace(null); void reload(); }}>Close</Button>}><p className="text-sm">{trace.orders.length} order(s) at {trace.locations.join(', ') || '—'}</p>{trace.orders.slice(0, 20).map((o) => <div key={o.number} className="text-xs">{o.number} · {o.location} · {when(o.createdAt)}</div>)}</Card>}
    </div>
  );
}

function Receiving({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const { data, reload } = useApi<PO[]>(`/kitchens/${kitchenId}/purchase-orders`, { deps: [kitchenId] });
  const { data: areas } = useApi<{ id: string; name: string }[]>(`/kitchens/${kitchenId}/storage-areas`, { deps: [kitchenId] });
  const { data: sups } = useApi<Supplier[]>(`/suppliers?organizationId=${organizationId}`, { deps: [organizationId] });
  const { data: items } = useApi<Item[]>(`/kitchens/${kitchenId}/inventory/items`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [rec, setRec] = useState<Record<string, { qty: string; lot: string; exp: string; area: string; note: string }>>({});
  const [inv, setInv] = useState<{ number: string; lines: Record<string, { qty: string; cost: string }> }>({ number: '', lines: {} });
  const [np, setNp] = useState({ supplierId: '', ingredientId: '', qty: '', cost: '' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Card title="New purchase order">
        <div className="grid gap-2 sm:grid-cols-5"><Select label="Supplier" value={np.supplierId} onChange={(e) => setNp({ ...np, supplierId: e.target.value })}><option value="">Choose…</option>{sups?.filter((s) => s.approved).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Select label="Item" value={np.ingredientId} onChange={(e) => setNp({ ...np, ingredientId: e.target.value })}><option value="">Choose…</option>{items?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select><Input label="Quantity (purchase units)" value={np.qty} onChange={(e) => setNp({ ...np, qty: e.target.value })} /><Input label="Unit cost $" value={np.cost} onChange={(e) => setNp({ ...np, cost: e.target.value })} /><Button className="self-end" disabled={!np.supplierId || !np.ingredientId || !np.qty} onClick={() => run(async () => { await api.post(`/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: np.supplierId, lines: [{ ingredientId: np.ingredientId, quantity: Number(np.qty), unitCostCents: Math.round(Number(np.cost || 0) * 100) }] }); setNp({ supplierId: '', ingredientId: '', qty: '', cost: '' }); await reload(); })}>Order</Button></div>
        <p className="mt-1 text-xs text-ink-500">Only approved suppliers are listed.</p>
      </Card>
      {data?.map((p) => (
        <Card key={p.id} title={<span>{p.supplier} · {money(p.totalCents)} <Badge tone={statusTone(p.status)}>{p.status}</Badge>{p.late && <Badge tone="bad">late</Badge>}{p.matchStatus && <Badge tone={p.matchStatus === 'MATCHED' ? 'good' : 'bad'}>{p.matchStatus === 'MATCHED' ? 'invoice matched' : `variance ${money(p.matchDetail?.varianceCents || 0)}`}</Badge>}</span>} action={<Button size="sm" variant="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Open'}</Button>}>
          <div className="text-xs text-ink-500">{p.expectedAt ? `Expected ${when(p.expectedAt)}` : ''}{p.receivedAt ? ` · received ${when(p.receivedAt)}` : ''}</div>
          {open === p.id && <div className="mt-2 space-y-2">
            {p.lines.map((l) => <div key={l.id} className="text-sm">{l.quantity} {l.unit} {l.ingredient} @ {money(l.unitCostCents)}{l.receivedQty != null ? ` · received ${l.receivedQty}` : ''}{l.discrepancyNote ? <span className="text-amber-700"> · {l.discrepancyNote}</span> : ''}
              {p.status === 'ORDERED' && <div className="mt-1 grid gap-1 sm:grid-cols-5"><Input placeholder={`Received (${l.quantity})`} value={rec[l.id]?.qty ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: { ...(rec[l.id] || { qty: '', lot: '', exp: '', area: '', note: '' }), qty: e.target.value } })} /><Input placeholder="Lot code" value={rec[l.id]?.lot ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: { ...(rec[l.id] || { qty: '', lot: '', exp: '', area: '', note: '' }), lot: e.target.value } })} /><Input type="date" value={rec[l.id]?.exp ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: { ...(rec[l.id] || { qty: '', lot: '', exp: '', area: '', note: '' }), exp: e.target.value } })} /><Select value={rec[l.id]?.area ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: { ...(rec[l.id] || { qty: '', lot: '', exp: '', area: '', note: '' }), area: e.target.value } })}><option value="">Storage…</option>{areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><Input placeholder="Note (damage, short)" value={rec[l.id]?.note ?? ''} onChange={(e) => setRec({ ...rec, [l.id]: { ...(rec[l.id] || { qty: '', lot: '', exp: '', area: '', note: '' }), note: e.target.value } })} /></div>}
              {p.status === 'RECEIVED' && !p.matchStatus && <div className="mt-1 grid gap-1 sm:grid-cols-2"><Input placeholder={`Invoiced qty (${l.receivedQty})`} value={inv.lines[l.ingredientId]?.qty ?? ''} onChange={(e) => setInv({ ...inv, lines: { ...inv.lines, [l.ingredientId]: { qty: e.target.value, cost: inv.lines[l.ingredientId]?.cost ?? '' } } })} /><Input placeholder={`Invoiced unit $ (${l.unitCostCents / 100})`} value={inv.lines[l.ingredientId]?.cost ?? ''} onChange={(e) => setInv({ ...inv, lines: { ...inv.lines, [l.ingredientId]: { cost: e.target.value, qty: inv.lines[l.ingredientId]?.qty ?? '' } } })} /></div>}
            </div>)}
            {p.status === 'DRAFT' && <Button size="sm" onClick={() => run(async () => { await api.post(`/purchase-orders/${p.id}/send`, {}); await reload(); })}>Send to supplier</Button>}
            {p.status === 'ORDERED' && <Button size="sm" onClick={() => run(async () => { await api.post(`/purchase-orders/${p.id}/receive`, { received: p.lines.map((l) => { const r = rec[l.id]; return { lineId: l.id, receivedQty: r?.qty ? Number(r.qty) : l.quantity, lotCode: r?.lot || undefined, expiresAt: r?.exp ? new Date(`${r.exp}T23:59:00Z`).toISOString() : undefined, storageAreaId: r?.area || undefined, note: r?.note || undefined }; }) }); await reload(); })}>Receive</Button>}
            {p.status === 'RECEIVED' && !p.matchStatus && <div className="flex items-end gap-2"><Input label="Invoice number" value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} /><Button size="sm" disabled={!inv.number} onClick={() => run(async () => { await api.post(`/purchase-orders/${p.id}/invoice`, { invoiceNumber: inv.number, lines: p.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: inv.lines[l.ingredientId]?.qty ? Number(inv.lines[l.ingredientId].qty) : l.receivedQty ?? 0, unitCostCents: inv.lines[l.ingredientId]?.cost ? Math.round(Number(inv.lines[l.ingredientId].cost) * 100) : l.unitCostCents })) }); setInv({ number: '', lines: {} }); await reload(); })}>Match invoice</Button></div>}
          </div>}
        </Card>
      ))}
    </div>
  );
}

function Forecast({ kitchenId }: { kitchenId: string }) {
  const { data, reload } = useApi<{ ingredientId: string; name: string; unit: string; purchaseUnit: string | null; supplier: string | null; supplierApproved: boolean | null; onHand: number; onOrder: number; dailyDemand: number; safetyStock: number; reorderPoint: number; daysOfCover: number | null; needsReorder: boolean; proposedQty: number; proposedPurchaseUnits: number }[]>(`/kitchens/${kitchenId}/forecast`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [out, setOut] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{out && <Alert tone="info">{out}</Alert>}
      <Button onClick={() => run(async () => { const r = await api.post<{ drafts: unknown[]; skipped: { name: string; why: string }[] }>(`/kitchens/${kitchenId}/replenish`, {}); setOut(`${r.drafts.length} draft purchase order(s) created${r.skipped.length ? `; skipped: ${r.skipped.map((s) => `${s.name} (${s.why})`).join(', ')}` : ''}. Review and send them under Purchase orders.`); await reload(); })}>Create draft orders for everything below its reorder point</Button>
      <Table rows={data || []} empty="No stocked items." cols={[
        { key: 'n', label: 'Item', render: (x) => <span>{x.name}<span className="block text-xs text-ink-500">{x.supplier || 'no supplier'}{x.supplierApproved === false ? ' (not approved)' : ''}</span></span> },
        { key: 'o', label: 'On hand / on order', render: (x) => `${x.onHand} / ${x.onOrder} ${x.unit}` },
        { key: 'd', label: 'Daily use', render: (x) => x.dailyDemand }, { key: 'c', label: 'Days of cover', render: (x) => x.daysOfCover ?? '—' },
        { key: 'r', label: 'Reorder point (incl. safety)', render: (x) => `${x.reorderPoint} (${x.safetyStock})` },
        { key: 'p', label: 'Proposal', render: (x) => x.needsReorder ? <Badge tone="warn">{x.proposedPurchaseUnits} {x.purchaseUnit || x.unit}</Badge> : <span className="text-xs text-ink-500">ok</span> },
      ]} />
      <p className="text-xs text-ink-500">Demand is the average use for each weekday over the last 4 weeks; safety stock is the larger of your setting and 2 days of use.</p>
    </div>
  );
}

function Suppliers({ organizationId }: { organizationId: string }) {
  const { data, reload } = useApi<Supplier[]>(`/suppliers?organizationId=${organizationId}`, { deps: [organizationId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ name: '', contactName: '', email: '', leadTimeDays: '2' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No suppliers." cols={[{ key: 'n', label: 'Supplier', render: (s) => <span>{s.name}{!s.organizationId && <Badge tone="info">Gutad</Badge>}<span className="block text-xs text-ink-500">{s.contactName} {s.email}</span></span> }, { key: 'l', label: 'Lead time', render: (s) => `${s.leadTimeDays} d` }, { key: 'a', label: 'Approved', render: (s) => s.approved ? <Badge tone="good">approved {s.approvedAt?.slice(0, 10)}</Badge> : <Badge tone="warn">not approved</Badge> }, { key: 'x', label: '', render: (s) => s.organizationId ? <Button size="sm" variant={s.approved ? 'ghost' : 'secondary'} onClick={() => { const note = window.prompt(s.approved ? 'Why revoke?' : 'Approval note (audit, certificates checked)'); if (note) run(async () => { await api.post(`/suppliers/${s.id}/approval`, { approved: !s.approved, note }); await reload(); }); }}>{s.approved ? 'Revoke' : 'Approve'}</Button> : null }]} />
      <Card title="Add supplier"><div className="grid gap-2 sm:grid-cols-5"><Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Contact" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /><Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /><Input label="Lead time (days)" value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value })} /><Button className="self-end" disabled={f.name.length < 2} onClick={() => run(async () => { await api.post('/suppliers', { organizationId, name: f.name, contactName: f.contactName || undefined, email: f.email || undefined, leadTimeDays: Number(f.leadTimeDays) || 2 }); setF({ name: '', contactName: '', email: '', leadTimeDays: '2' }); await reload(); })}>Add</Button></div><p className="mt-1 text-xs text-ink-500">New suppliers need approval before you can order from them; changing their product specifications sends them back for approval.</p></Card>
    </div>
  );
}

function Transfers({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const { data, reload } = useApi<{ id: string; from: string; to: string; direction: string; status: string; lines: { ingredientId: string; quantity: number; receivedQty?: number }[]; discrepancy: string | null; createdAt: string }[]>(`/kitchens/${kitchenId}/transfers`, { deps: [kitchenId] });
  const { data: org } = useApi<{ locations: { kitchenId: string | null }[] }>(`/organizations/${organizationId}`, { deps: [organizationId] });
  const { data: kits } = useApi<{ id: string; name: string }[]>(`/organizations/${organizationId}/kitchens`, { deps: [organizationId] });
  const { data: items } = useApi<Item[]>(`/kitchens/${kitchenId}/inventory/items`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ from: '', ingredientId: '', qty: '' });
  const others = (kits || []).filter((k) => k.id !== kitchenId);
  void org;
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Card title="Request stock from another site">
        <div className="grid gap-2 sm:grid-cols-4"><Select label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}><option value="">Choose…</option>{others.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select><Select label="Item" value={f.ingredientId} onChange={(e) => setF({ ...f, ingredientId: e.target.value })}><option value="">Choose…</option>{items?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select><Input label="Quantity (base unit)" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /><Button className="self-end" disabled={!f.from || !f.ingredientId || !f.qty} onClick={() => run(async () => { await api.post('/transfers', { fromKitchenId: f.from, toKitchenId: kitchenId, lines: [{ ingredientId: f.ingredientId, quantity: Number(f.qty) }] }); setF({ from: '', ingredientId: '', qty: '' }); await reload(); })}>Request</Button></div>
      </Card>
      <Table rows={data || []} empty="No transfers." cols={[
        { key: 'r', label: 'Route', render: (t) => `${t.from} → ${t.to}` }, { key: 'l', label: 'Lines', render: (t) => <span className="text-xs">{t.lines.map((l) => `${items?.find((i) => i.id === l.ingredientId)?.name || l.ingredientId.slice(0, 6)} ${l.quantity}${l.receivedQty != null ? ` (got ${l.receivedQty})` : ''}`).join(', ')}</span> },
        { key: 's', label: 'Status', render: (t) => <span><Badge tone={statusTone(t.status)}>{t.status}</Badge>{t.discrepancy && <span className="block text-xs text-amber-700">{t.discrepancy}</span>}</span> },
        { key: 'x', label: '', render: (t) => <span className="flex gap-1">{t.direction === 'OUT' && t.status === 'REQUESTED' && <Button size="sm" onClick={() => run(async () => { await api.post(`/transfers/${t.id}/pick`, {}); await reload(); })}>Pick (FEFO)</Button>}{t.direction === 'OUT' && t.status === 'PICKED' && <Button size="sm" onClick={() => run(async () => { await api.post(`/transfers/${t.id}/ship`, {}); await reload(); })}>Ship</Button>}{t.direction === 'IN' && t.status === 'SHIPPED' && <Button size="sm" onClick={() => { const got = t.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: Number(window.prompt(`Received quantity of ${items?.find((i) => i.id === l.ingredientId)?.name}`, String(l.quantity)) ?? l.quantity) })); run(async () => { await api.post(`/transfers/${t.id}/receive`, { received: got }); await reload(); }); }}>Receive</Button>}</span> },
      ]} />
    </div>
  );
}

function Movements({ kitchenId }: { kitchenId: string }) {
  const [kind, setKind] = useState('');
  const { data } = useApi<{ id: string; ingredient: string; unit: string; kind: string; quantity: number; lotCode: string | null; reason: string | null; createdAt: string }[]>(`/kitchens/${kitchenId}/movements?days=14${kind ? `&kind=${kind}` : ''}`, { deps: [kitchenId, kind] });
  return (
    <div className="space-y-2">
      <Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All movements</option>{['RECEIPT', 'CONSUMPTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT', 'ADJUSTMENT', 'SPOILAGE', 'WITHDRAWAL'].map((k) => <option key={k}>{k}</option>)}</Select>
      <Table rows={data || []} empty="No movements." cols={[{ key: 'd', label: 'When', render: (m) => <span className="text-xs">{when(m.createdAt)}</span> }, { key: 'i', label: 'Item', render: (m) => m.ingredient }, { key: 'k', label: 'Kind', render: (m) => m.kind.toLowerCase().replace('_', ' ') }, { key: 'q', label: 'Qty', render: (m) => <span className={m.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}>{m.quantity > 0 ? '+' : ''}{Math.round(m.quantity * 100) / 100} {m.unit}</span> }, { key: 'l', label: 'Lot', render: (m) => <span className="text-xs">{m.lotCode}</span> }, { key: 'r', label: 'Reason', render: (m) => <span className="text-xs">{m.reason}</span> }]} />
    </div>
  );
}

function Reports({ kitchenId }: { kitchenId: string }) {
  const { data } = useApi<{ forecastAccuracyPct: number | null; wasteCents: number; waste: { ingredient: string; reason: string | null; quantity: number; cents: number }[]; suppliers: { supplier: string; orders: number; onTimePct: number | null; fillRatePct: number | null; invoiceVariances: number }[]; valuation: { kind: string; cents: number; items: number }[]; valuationCents: number; expiringIn3DaysCents: number }>(`/kitchens/${kitchenId}/inventory/reports`, { deps: [kitchenId] });
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4"><Stat label="Inventory value" value={money(data.valuationCents)} /><Stat label="Expiring in 3 days" value={money(data.expiringIn3DaysCents)} /><Stat label="Waste (30 days)" value={money(data.wasteCents)} /><Stat label="Forecast accuracy" value={data.forecastAccuracyPct == null ? '—' : `${data.forecastAccuracyPct}%`} /></div>
      <Card title="Supplier performance"><Table rows={data.suppliers} empty="No orders." cols={[{ key: 's', label: 'Supplier', render: (s) => s.supplier }, { key: 'o', label: 'Orders', render: (s) => s.orders }, { key: 't', label: 'On time', render: (s) => (s.onTimePct == null ? '—' : `${s.onTimePct}%`) }, { key: 'f', label: 'Fill rate', render: (s) => (s.fillRatePct == null ? '—' : `${s.fillRatePct}%`) }, { key: 'v', label: 'Invoice variances', render: (s) => s.invoiceVariances }]} /></Card>
      <Card title="Waste"><Table rows={data.waste} empty="No waste recorded." cols={[{ key: 'i', label: 'Item', render: (w) => w.ingredient }, { key: 'r', label: 'Reason', render: (w) => w.reason || '—' }, { key: 'q', label: 'Qty', render: (w) => w.quantity }, { key: 'c', label: 'Cost', render: (w) => money(w.cents) }]} /></Card>
      <Card title="Valuation by type"><Table rows={data.valuation} cols={[{ key: 'k', label: 'Type', render: (v) => v.kind.toLowerCase() }, { key: 'n', label: 'Items', render: (v) => v.items }, { key: 'c', label: 'Value', render: (v) => money(v.cents) }]} /></Card>
    </div>
  );
}
