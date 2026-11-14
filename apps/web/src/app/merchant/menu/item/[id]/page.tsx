'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ALLERGENS, HANDLING_FLAGS, HANDLING_LABELS, MENU_ITEM_KINDS, TAX_CATEGORIES } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';
import { useMerchant } from '../../../context';

interface History { item: { id: string; name: string; priceCents: number }; scheduled: { id: string; newPriceCents: number; previousPriceCents: number | null; effectiveAt: string; status: string; reason: string | null; channel: string | null; locationId: string | null; createdByEmail: string | null }[]; history: { at: string; by: string | null; before: { priceCents?: number } | null; after: { priceCents?: number } | null; reason: string | null }[] }
interface Allergens { listed: string[]; fromRecipe: string[]; fromOptions: string[]; missing: string[]; reviewNeeded: boolean }
interface Fields { servingSize: string; kind: string; taxCategory: string; maxPerOrder: string; calories: string; allergens: string[]; cookMinutes: string; stationCode: string; handling: string[] }

/** Item details: serving size, nutrition, kind, tax category, limits, allergens (from recipe), price schedule & history, location prices. */
export default function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const { org, loc } = useMerchant();
  const { data: menus } = useApi<{ id: string; categories: { items: { id: string; name: string; priceCents: number; allergens: string[]; servingSize?: string | null; kind?: string; taxCategory?: string; maxPerOrder?: number | null; nutrition?: { calories?: number }; cookMinutes?: number | null; stationCode?: string | null; handling?: string[] }[] }[] }[]>(loc ? `/locations/${loc.id}/menus` : null, { deps: [loc?.id] });
  const { data: hist, reload: reloadHist } = useApi<History>(`/items/${id}/price-history`);
  const { data: al, reload: reloadAl } = useApi<Allergens>(`/items/${id}/allergens`);
  const { run, error } = useAction();
  const item = menus?.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === id);
  const [f, setF] = useState<Fields | null>(null);
  const [pc, setPc] = useState({ price: '', when: '', reason: '' });
  const [ovr, setOvr] = useState({ locationId: '', price: '' });
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (item && !f) setF({ servingSize: item.servingSize || '', kind: item.kind || 'ITEM', taxCategory: item.taxCategory || 'STANDARD', maxPerOrder: item.maxPerOrder ? String(item.maxPerOrder) : '', calories: item.nutrition?.calories ? String(item.nutrition.calories) : '', allergens: item.allergens, cookMinutes: item.cookMinutes ? String(item.cookMinutes) : '', stationCode: item.stationCode || '', handling: item.handling || [] }); }, [item, f]);
  if (!item || !f) return null;
  return (
    <div className="space-y-4">
      <div><Link href="/merchant/menu" className="text-xs text-ink-500 underline">← Menus</Link><h1 className="text-2xl font-bold">{item.name} <span className="text-base font-normal text-ink-500">{money(item.priceCents)}</span></h1></div>
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      {al?.reviewNeeded && <Alert>The recipe for this item changed and contains allergens not listed here: <b>{al.missing.join(', ') || 'check the list'}</b>. Update the allergens and save to clear the review.</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Serving size" value={f.servingSize} onChange={(e) => setF({ ...f, servingSize: e.target.value })} />
            <Input label="Calories" value={f.calories} onChange={(e) => setF({ ...f, calories: e.target.value })} />
            <Select label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{MENU_ITEM_KINDS.map((k) => <option key={k}>{k}</option>)}</Select>
            <Select label="Tax category" value={f.taxCategory} onChange={(e) => setF({ ...f, taxCategory: e.target.value })}>{TAX_CATEGORIES.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</Select>
            <Input label="Max per order (blank = no limit)" value={f.maxPerOrder} onChange={(e) => setF({ ...f, maxPerOrder: e.target.value })} />
            <Input label="Cook minutes (kitchen timing)" value={f.cookMinutes} onChange={(e) => setF({ ...f, cookMinutes: e.target.value })} />
            <Input label="Station code (e.g. GRILL)" value={f.stationCode} onChange={(e) => setF({ ...f, stationCode: e.target.value.toUpperCase() })} />
          </div>
          <div className="mt-2 text-xs font-medium text-ink-500">Packing &amp; handling</div>
          <div className="flex flex-wrap gap-3">{HANDLING_FLAGS.map((h) => <label key={h} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.handling.includes(h)} onChange={(e) => setF({ ...f, handling: e.target.checked ? [...f.handling, h] : f.handling.filter((x) => x !== h) })} />{HANDLING_LABELS[h]}</label>)}</div>
          <div className="mt-2 text-xs font-medium text-ink-500">Allergens</div>
          <div className="flex flex-wrap gap-2">{ALLERGENS.map((a) => <label key={a} className={`flex items-center gap-1 text-xs ${al?.missing.includes(a) ? 'font-bold text-red-700' : ''}`}><input type="checkbox" checked={f.allergens.includes(a)} onChange={(e) => setF({ ...f, allergens: e.target.checked ? [...f.allergens, a] : f.allergens.filter((x) => x !== a) })} />{a.replace('_', ' ')}</label>)}</div>
          {al && <p className="mt-1 text-xs text-ink-500">From the recipe: {al.fromRecipe.join(', ') || 'none'}{al.fromOptions.length ? ` · from options: ${al.fromOptions.join(', ')}` : ''}</p>}
          <Button className="mt-3" size="sm" onClick={() => run(async () => { await api.patch(`/items/${id}`, { servingSize: f.servingSize || null, kind: f.kind, taxCategory: f.taxCategory, maxPerOrder: f.maxPerOrder ? Number(f.maxPerOrder) : null, nutrition: f.calories ? { calories: Number(f.calories) } : {}, allergens: f.allergens, allergenReviewNeeded: false, cookMinutes: f.cookMinutes ? Number(f.cookMinutes) : null, stationCode: f.stationCode || undefined, handling: f.handling }); setOk('Saved.'); reloadAl(); })}>Save details</Button>
        </Card>
        <Card title="Price schedule">
          <div className="grid gap-2 sm:grid-cols-3"><Input label="New price (USD)" value={pc.price} onChange={(e) => setPc({ ...pc, price: e.target.value })} /><Input label="From (blank = now)" type="datetime-local" value={pc.when} onChange={(e) => setPc({ ...pc, when: e.target.value })} /><Input label="Reason" value={pc.reason} onChange={(e) => setPc({ ...pc, reason: e.target.value })} /></div>
          <Button className="mt-2" size="sm" disabled={!pc.price} onClick={() => run(async () => { const r = await api.post<{ status: string }>(`/items/${id}/price-changes`, { newPriceCents: Math.round(Number(pc.price) * 100), effectiveAt: pc.when ? new Date(pc.when).toISOString() : undefined, reason: pc.reason || undefined }); setOk(r.status === 'PENDING_APPROVAL' ? 'Sent for approval (change is above the limit).' : r.status === 'APPLIED' ? 'Price changed.' : 'Scheduled.'); setPc({ price: '', when: '', reason: '' }); reloadHist(); })}>Schedule</Button>
          <Table rows={hist?.scheduled || []} empty="No price changes yet." cols={[{ key: 'p', label: 'Change', render: (r) => `${money(r.previousPriceCents || 0)} → ${money(r.newPriceCents)}${r.channel ? ` (${r.channel.toLowerCase()})` : ''}` }, { key: 'w', label: 'From', render: (r) => when(r.effectiveAt) }, { key: 's', label: 'Status', render: (r) => <Badge tone={r.status === 'APPLIED' ? 'good' : r.status === 'CANCELED' ? 'neutral' : 'warn'}>{r.status}</Badge> }, { key: 'x', label: '', render: (r) => ['SCHEDULED', 'PENDING_APPROVAL'].includes(r.status) ? <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/price-changes/${r.id}`); reloadHist(); })}>Cancel</button> : null }]} />
          <div className="mt-2 text-xs text-ink-500">History: {hist?.history.slice(0, 6).map((h) => `${when(h.at)} ${h.before?.priceCents !== undefined ? money(h.before.priceCents) + '→' : ''}${h.after?.priceCents !== undefined ? money(h.after.priceCents) : ''} ${h.by || ''}`).join(' · ') || '—'}</div>
        </Card>
      </div>
      {org && org.locations.length > 1 && (
        <Card title="Price at another location">
          <p className="text-xs text-ink-500">Applies when this menu is shared to another of your locations (Menus → Versions → share).</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_150px_auto]"><Select value={ovr.locationId} onChange={(e) => setOvr({ ...ovr, locationId: e.target.value })}><option value="">Location…</option>{org.locations.filter((l) => l.id !== loc?.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select><Input placeholder="Price (blank = same)" value={ovr.price} onChange={(e) => setOvr({ ...ovr, price: e.target.value })} /><Button size="sm" disabled={!ovr.locationId} onClick={() => run(async () => { await api.put(`/items/${id}/locations/${ovr.locationId}`, { priceCents: ovr.price ? Math.round(Number(ovr.price) * 100) : null }); setOk('Location price saved.'); })}>Save</Button></div>
        </Card>
      )}
    </div>
  );
}
