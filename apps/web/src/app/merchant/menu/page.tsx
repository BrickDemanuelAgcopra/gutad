'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Disclosure, Input, Modal, Select, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

interface Item { id: string; kind?: string; name: string; description: string | null; priceCents: number; soldOut: boolean; allergens: string[]; modifierGroups: { id: string; name: string; options: { id: string; name: string; priceCents: number; soldOut: boolean }[] }[] }
interface Menu { id: string; name: string; isActive: boolean; version: number; brandId: string | null; channels: string[]; availableFrom: string | null; availableUntil: string | null; categories: { id: string; name: string; items: Item[] }[] }

export default function MenuPage() {
  const { loc, org } = useMerchant();
  const { data: menus, reload } = useApi<Menu[]>(loc ? `/locations/${loc.id}/menus` : null, { deps: [loc?.id] });
  const { run, error } = useAction();
  const [newMenu, setNewMenu] = useState('');
  const [brandId, setBrandId] = useState('');
  const [cat, setCat] = useState<Record<string, string>>({});
  const [item, setItem] = useState<{ categoryId: string; name: string; priceCents: string; description: string; allergens: string; stationCode: string } | null>(null);
  const [mod, setMod] = useState<{ itemId: string; name: string; required: boolean; maxSelect: number; options: string } | null>(null);
  const [importJson, setImportJson] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; errors: string[]; warnings: string[]; alreadyOnMenu: string[]; items: number } | null>(null);
  if (!loc) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold">Menus</h1>
        <div className="flex items-end gap-2">
          <Input label="New menu" value={newMenu} onChange={(e) => setNewMenu(e.target.value)} placeholder="e.g. Brunch" />
          {org?.brands.length ? <Select label="Brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}><option value="">— house —</option>{org.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select> : null}
          <Button disabled={!newMenu} onClick={() => act(async () => { await api.post(`/locations/${loc.id}/menus`, { name: newMenu, brandId: brandId || undefined }); setNewMenu(''); })}>Create</Button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {menus?.map((m) => (
        <Card key={m.id} title={<span>{m.name} <span className="text-xs text-ink-500">v{m.version} · {m.channels.join(', ')}{m.availableFrom ? ` · ${m.availableFrom}–${m.availableUntil}` : ''}</span></span>} action={<div className="flex gap-1"><Link className="rounded-lg border border-ink-100 px-2.5 py-1 text-xs" href={`/merchant/menu/${m.id}/versions`}>Versions & publish</Link><Badge tone={m.isActive ? 'good' : 'bad'}>{m.isActive ? 'Live' : 'Hidden'}</Badge><Button size="sm" variant="ghost" onClick={() => act(() => api.patch(`/menus/${m.id}`, { isActive: !m.isActive }))}>{m.isActive ? 'Hide' : 'Publish'}</Button><Button size="sm" variant="ghost" onClick={() => { const from = prompt('Available from (HH:MM, blank for all day)', m.availableFrom || ''); const until = prompt('Until (HH:MM)', m.availableUntil || ''); act(() => api.patch(`/menus/${m.id}`, { availableFrom: from || null, availableUntil: until || null })); }}>Schedule</Button></div>}>
          {m.categories.map((c) => (
            <Disclosure key={c.id} title={<span>{c.name} <span className="text-xs text-ink-500">({c.items.length})</span></span>} defaultOpen>
              <ul className="divide-y divide-ink-100">
                {c.items.map((it) => (
                  <li key={it.id} className="flex items-center justify-between py-2 text-sm">
                    <div><span className={it.soldOut ? 'line-through' : ''}>{it.name}</span>{it.kind === 'PACKAGED' && <Link href="/merchant/products" className="ml-1 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-700">Packaged</Link>} <span className="text-ink-500">{money(it.priceCents)}</span>{it.allergens.length > 0 && <span className="ml-2 text-xs text-ink-300">{it.allergens.join(', ')}</span>}<div className="text-xs text-ink-500">{it.modifierGroups.map((g) => `${g.name}: ${g.options.map((o) => o.name).join('/')}`).join(' · ')}</div></div>
                    <div className="flex gap-1">
                      <Button size="sm" variant={it.soldOut ? 'primary' : 'secondary'} onClick={() => act(() => api.post(`/items/${it.id}/sold-out`, { soldOut: !it.soldOut, untilMinutes: it.soldOut ? undefined : 240 }))}>{it.soldOut ? 'Back in stock' : '86 (4h)'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => { const p = prompt('New price (USD)', (it.priceCents / 100).toFixed(2)); if (p) act(() => api.patch(`/items/${it.id}`, { priceCents: Math.round(Number(p) * 100) })); }}>Price</Button>
                      <Link className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50" href={`/merchant/menu/item/${it.id}`}>Details</Link>
                      <Button size="sm" variant="ghost" onClick={() => setMod({ itemId: it.id, name: '', required: false, maxSelect: 1, options: '' })}>+ Modifier</Button>
                      <Button size="sm" variant="ghost" onClick={() => confirm('Remove item?') && act(() => api.delete(`/items/${it.id}`))}>Remove</Button>
                    </div>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setItem({ categoryId: c.id, name: '', priceCents: '', description: '', allergens: '', stationCode: '' })}>+ Add item</Button>
            </Disclosure>
          ))}
          <div className="mt-3 flex gap-2"><Input placeholder="New category" value={cat[m.id] || ''} onChange={(e) => setCat({ ...cat, [m.id]: e.target.value })} /><Button variant="secondary" disabled={!cat[m.id]} onClick={() => act(async () => { await api.post(`/menus/${m.id}/categories`, { name: cat[m.id] }); setCat({ ...cat, [m.id]: '' }); })}>Add category</Button></div>
        </Card>
      ))}
      <Card title="Import menu (JSON from POS export)">
        <Textarea rows={4} value={importJson} onChange={(e) => setImportJson(e.target.value)} placeholder='{"name":"Dinner","categories":[{"name":"Mains","items":[{"name":"Steak","priceCents":3200,"posExternalId":"POS-1"}]}]}' />
        <div className="mt-2 flex gap-2"><Button variant="ghost" disabled={!importJson} onClick={() => run(async () => { const v = await api.post<{ ok: boolean; errors: string[]; warnings: string[]; alreadyOnMenu: string[]; items: number }>(`/locations/${loc.id}/menus/validate-import`, JSON.parse(importJson)); setCheck(v); })}>Validate</Button><Button variant="secondary" disabled={!importJson} onClick={() => act(async () => { await api.post(`/locations/${loc.id}/menus/import`, JSON.parse(importJson)); setImportJson(''); })}>Import</Button></div>
        {check && <div className={`mt-2 rounded-lg p-2 text-xs ${check.ok ? 'bg-emerald-50' : 'bg-red-50'}`}>{check.items} items · {check.ok ? 'no errors' : check.errors.join('; ')}{check.warnings.length > 0 && <div>Warnings: {check.warnings.join('; ')}</div>}{check.alreadyOnMenu.length > 0 && <div>Already on your menu: {check.alreadyOnMenu.join(', ')}</div>}</div>}
      </Card>
      <Modal open={!!item} onClose={() => setItem(null)} title="New item">
        {item && (<div className="space-y-2"><Input label="Name" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /><Input label="Price (USD)" value={item.priceCents} onChange={(e) => setItem({ ...item, priceCents: e.target.value })} /><Textarea label="Description" value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} /><Input label="Allergens (comma separated)" value={item.allergens} onChange={(e) => setItem({ ...item, allergens: e.target.value })} /><Input label="Kitchen station code (optional)" value={item.stationCode} onChange={(e) => setItem({ ...item, stationCode: e.target.value })} /><Button onClick={() => act(async () => { await api.post(`/categories/${item.categoryId}/items`, { name: item.name, priceCents: Math.round(Number(item.priceCents) * 100), description: item.description || undefined, allergens: item.allergens ? item.allergens.split(',').map((s) => s.trim()) : [], stationCode: item.stationCode || undefined }); setItem(null); })}>Save</Button></div>)}
      </Modal>
      <Modal open={!!mod} onClose={() => setMod(null)} title="Add modifier group">
        {mod && (<div className="space-y-2"><Input label="Group name" value={mod.name} onChange={(e) => setMod({ ...mod, name: e.target.value })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mod.required} onChange={(e) => setMod({ ...mod, required: e.target.checked })} /> Required</label><Input label="Max selections" type="number" value={mod.maxSelect} onChange={(e) => setMod({ ...mod, maxSelect: Number(e.target.value) })} /><Textarea label="Options, one per line as Name=price (e.g. Bacon=3.00)" value={mod.options} onChange={(e) => setMod({ ...mod, options: e.target.value })} /><Button onClick={() => act(async () => { await api.post(`/items/${mod.itemId}/modifier-groups`, { name: mod.name, required: mod.required, maxSelect: mod.maxSelect, minSelect: mod.required ? 1 : 0, options: mod.options.split('\n').filter(Boolean).map((l) => { const [n, p] = l.split('='); return { name: n.trim(), priceCents: Math.round(Number(p || 0) * 100) }; }) }); setMod(null); })}>Save</Button></div>)}
      </Modal>
    </div>
  );
}
