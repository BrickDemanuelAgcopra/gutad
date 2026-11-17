'use client';
import { useState } from 'react';
import { ALLERGENS, DIETARY_TAGS } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner } from '@/components/ui';
import { ChipGroup } from '@/components/form-kit';

interface Extra { id: string; name: string; synonyms: string[]; portionDesc: string | null; priceCents: number; maxQty: number; prepMinutesDelta: number; allergens: string[]; removesDietaryTags: string[]; allDishes: boolean; dishIds: string[]; status: string; reviewNote: string | null; soldOut: boolean }
interface Menu { sections: { dishes: { id: string; dishName: string; mode: string }[] }[] }
const blank = { name: '', synonyms: '', portionDesc: '', price: '', maxQty: 2, prepMinutesDelta: 0, allergens: [] as string[], removesDietaryTags: [] as string[], allDishes: true, dishIds: [] as string[] };

/**
 * Approved extras: ingredients the chef will add at a set price per portion. Customers find them by searching on
 * the dishes the chef allows. New extras and allergen changes are reviewed by Gutad; anything not listed here
 * becomes a special request.
 */
export default function ChefExtras() {
  const { data, setData, loading, error } = useApi<Extra[]>('/chef/extras');
  const { data: menu } = useApi<Menu>('/chef/menu');
  const { run, busy, error: actErr } = useAction();
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="info">Only approved chefs have an extras list.</Alert>;
  const dishes = (menu?.sections || []).flatMap((s) => s.dishes).filter((d) => d.mode === 'CUSTOMIZABLE');
  const reload = async () => setData(await api.get<Extra[]>('/chef/extras'));
  const save = () => run(async () => {
    const body = { name: f.name, synonyms: f.synonyms.split(',').map((x) => x.trim()).filter(Boolean), portionDesc: f.portionDesc || null, priceCents: Math.round(Number(f.price || 0) * 100), maxQty: f.maxQty, prepMinutesDelta: f.prepMinutesDelta, allergens: f.allergens, removesDietaryTags: f.removesDietaryTags, allDishes: f.allDishes, dishIds: f.allDishes ? [] : f.dishIds };
    if (editing) await api.patch(`/chef/extras/${editing}`, body); else await api.post('/chef/extras', body);
    setF(blank); setEditing(null); await reload();
  });
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold">Approved extras</h1><p className="text-sm text-ink-500">Ingredients you’ll add on request at a set price per portion. Customers find them by searching on the dishes you choose. Gutad reviews new extras and allergen changes; price, limits and sold-out apply right away.</p></div>
      {actErr && <Alert>{actErr}</Alert>}
      <Card title="Your extras">
        {!data?.length ? <p className="text-sm text-ink-500">No extras yet.</p> : (
          <ul className="divide-y divide-ink-100">
            {data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{e.name} <span className="font-normal text-ink-500">· {money(e.priceCents)}{e.portionDesc ? ` per ${e.portionDesc}` : ''} · up to {e.maxQty}</span></div>
                  <div className="flex flex-wrap gap-1 text-xs"><Badge tone={e.status === 'APPROVED' ? 'good' : e.status === 'REJECTED' ? 'bad' : 'info'}>{e.status === 'PENDING' ? 'In review' : e.status.toLowerCase()}</Badge>{e.allergens.map((a) => <Badge key={a} tone="bad">{a}</Badge>)}{e.soldOut && <Badge tone="warn">sold out</Badge>}<span className="text-ink-500">{e.allDishes ? 'All customizable dishes' : `${e.dishIds.length} dish${e.dishIds.length === 1 ? '' : 'es'}`}{e.synonyms.length ? ` · also found as ${e.synonyms.join(', ')}` : ''}</span>{e.reviewNote && <span className="text-red-600">{e.reviewNote}</span>}</div>
                </div>
                <button className="text-xs underline" onClick={() => run(async () => { await api.patch(`/chef/extras/${e.id}`, { soldOut: !e.soldOut }); await reload(); })}>{e.soldOut ? 'Back in stock' : 'Sold out'}</button>
                <button className="text-xs underline" onClick={() => { setEditing(e.id); setF({ name: e.name, synonyms: e.synonyms.join(', '), portionDesc: e.portionDesc || '', price: String(e.priceCents / 100), maxQty: e.maxQty, prepMinutesDelta: e.prepMinutesDelta, allergens: e.allergens, removesDietaryTags: e.removesDietaryTags, allDishes: e.allDishes, dishIds: e.dishIds }); }}>Edit</button>
                <button className="text-xs text-red-600 underline" onClick={() => run(async () => { await api.delete(`/chef/extras/${e.id}`); await reload(); })}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={editing ? 'Edit extra' : 'Add an extra'}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Input label="Ingredient" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Burrata" className="sm:col-span-2" />
            <Input label="Price per portion (USD)" type="number" min={0} step="0.25" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            <Input label="Max portions" type="number" min={1} max={20} value={f.maxQty} onChange={(e) => setF({ ...f, maxQty: Number(e.target.value) })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="One portion =" value={f.portionDesc} onChange={(e) => setF({ ...f, portionDesc: e.target.value })} placeholder="100 g" />
            <Input label="Also found as (comma separated)" value={f.synonyms} onChange={(e) => setF({ ...f, synonyms: e.target.value })} placeholder="mozzarella, cheese" />
            <Input label="Extra preparation (min)" type="number" min={0} value={f.prepMinutesDelta} onChange={(e) => setF({ ...f, prepMinutesDelta: Number(e.target.value) })} />
          </div>
          <div><span className="mb-1 block text-xs font-medium text-ink-500">Allergens in this extra</span><ChipGroup name="Allergens" values={f.allergens} onChange={(v) => setF({ ...f, allergens: v })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} /></div>
          <div><span className="mb-1 block text-xs font-medium text-ink-500">Makes a dish no longer…</span><ChipGroup name="Dietary" values={f.removesDietaryTags} onChange={(v) => setF({ ...f, removesDietaryTags: v })} options={DIETARY_TAGS.map((t) => ({ value: t, label: t.replace('_', ' ') }))} /></div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allDishes} onChange={(e) => setF({ ...f, allDishes: e.target.checked })} /> Offer on all my customizable dishes</label>
            {!f.allDishes && <ChipGroup name="Dishes" values={f.dishIds} onChange={(v) => setF({ ...f, dishIds: v })} options={dishes.map((d) => ({ value: d.id, label: d.dishName }))} />}
          </div>
          <div className="flex gap-2"><Button disabled={busy || !f.name.trim()} onClick={save}>{editing ? 'Save extra' : 'Add extra'}</Button>{editing && <Button variant="ghost" onClick={() => { setEditing(null); setF(blank); }}>Cancel</Button>}</div>
        </div>
      </Card>
    </div>
  );
}
