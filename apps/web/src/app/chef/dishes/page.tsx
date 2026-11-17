'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CHEF_DISH_STATUS_LABELS, type ChefDishStatus } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner } from '@/components/ui';
import { SortableList } from '@/components/form-kit';

export interface ChefDish { id: string; title: string; dishName: string; priceCents: number; reviewStatus: ChefDishStatus; reviewNote: string | null; pendingChanges: Record<string, unknown> | null; photos: string[]; mode: string; soldOut: boolean; live: boolean; missing: string[]; sectionId: string }
interface Menu { menuId: string; chefName: string; sections: { id: string; name: string; dishes: ChefDish[] }[] }

const tone = (s: ChefDishStatus) => (s === 'PUBLISHED' ? 'good' : s === 'IN_REVIEW' ? 'info' : s === 'CHANGES_REQUESTED' ? 'warn' : s === 'SUSPENDED' ? 'bad' : 'neutral');

export default function ChefDishes() {
  const router = useRouter();
  const { data, setData, loading, error } = useApi<Menu>('/chef/menu');
  const { run, busy, error: actErr } = useAction();
  const [newSection, setNewSection] = useState('');
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert tone="info">Only approved chefs have a menu. <Link className="underline" href="/chefs/apply">Apply</Link></Alert>;
  const save = (sections: Menu['sections']) => {
    setData({ ...data, sections });
    return run(async () => setData(await api.put<Menu>('/chef/menu/order', { sections: sections.map((s) => ({ id: s.id, dishIds: s.dishes.map((d) => d.id) })) })));
  };
  const moveDishTo = (dish: ChefDish, toId: string) => save(data.sections.map((s) => ({ ...s, dishes: s.id === toId ? [...s.dishes.filter((d) => d.id !== dish.id), dish] : s.dishes.filter((d) => d.id !== dish.id) })));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-2xl font-bold">Dishes</h1><p className="text-sm text-ink-500">Every dish sells as <strong>Gutad’s &lt;dish&gt; — by {data.chefName}</strong>. New dishes and ingredient or allergen changes are reviewed by Gutad; prices apply right away.</p></div>
        <Button disabled={busy} onClick={() => run(async () => { const d = await api.post<ChefDish>('/chef/dishes', { dishName: 'New dish' }); router.push(`/chef/dishes/${d.id}`); })}>+ New dish</Button>
      </div>
      {actErr && <Alert>{actErr}</Alert>}
      <Card title="Menu sections" action={<span className="text-xs text-ink-500">Drag ⋮⋮ or use ↑ ↓ to reorder</span>}>
        <SortableList
          items={data.sections}
          getKey={(s) => s.id}
          label={(s) => s.name}
          onChange={save}
          render={(s) => (
            <div className="flex items-center justify-between gap-2 pr-2">
              <span className="font-medium">{s.name} <span className="text-xs text-ink-500">· {s.dishes.length} dish{s.dishes.length === 1 ? '' : 'es'}</span></span>
              <span className="flex gap-2 text-xs">
                <button className="underline" onClick={() => { const n = window.prompt('Section name', s.name); if (n?.trim()) void run(async () => { await api.patch(`/chef/menu/sections/${s.id}`, { name: n }); setData(await api.get<Menu>('/chef/menu')); }); }}>Rename</button>
                {!s.dishes.length && data.sections.length > 1 && <button className="text-red-600 underline" onClick={() => run(async () => { await api.delete(`/chef/menu/sections/${s.id}`); setData(await api.get<Menu>('/chef/menu')); })}>Delete</button>}
              </span>
            </div>
          )}
        />
        <div className="mt-3 flex gap-2"><Input aria-label="New section name" placeholder="New section, e.g. Desserts" value={newSection} onChange={(e) => setNewSection(e.target.value)} className="flex-1" /><Button variant="secondary" disabled={!newSection.trim() || busy} onClick={() => run(async () => { await api.post('/chef/menu/sections', { name: newSection }); setNewSection(''); setData(await api.get<Menu>('/chef/menu')); })}>Add section</Button></div>
      </Card>
      {data.sections.map((s) => (
        <Card key={s.id} title={s.name}>
          {!s.dishes.length ? <p className="text-sm text-ink-500">No dishes in this section.</p> : (
            <SortableList
              items={s.dishes}
              getKey={(d) => d.id}
              label={(d) => d.dishName}
              onChange={(dishes) => save(data.sections.map((x) => (x.id === s.id ? { ...x, dishes } : x)))}
              render={(d) => (
                <div className="flex flex-wrap items-center gap-3 pr-2">
                  {d.photos[0] ? <img src={d.photos[0]} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-lg bg-ink-100 text-lg">🍽</div>}
                  <div className="min-w-0 flex-1">
                    <Link href={`/chef/dishes/${d.id}`} className="font-medium hover:underline">{d.title}</Link>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-ink-500">
                      <Badge tone={tone(d.reviewStatus)}>{CHEF_DISH_STATUS_LABELS[d.reviewStatus]}</Badge>
                      {d.pendingChanges && <Badge tone="info">Changes in review</Badge>}
                      {d.soldOut && <Badge tone="warn">Sold out</Badge>}
                      <span>{money(d.priceCents)} · {d.mode === 'CUSTOMIZABLE' ? 'customizable' : 'fixed'}</span>
                      {d.reviewStatus === 'CHANGES_REQUESTED' && d.reviewNote && <span className="text-amber-700">— {d.reviewNote}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {data.sections.length > 1 && (
                      <select aria-label="Move to section" className="rounded border border-ink-100 px-1 py-0.5" value={s.id} onChange={(e) => moveDishTo(d, e.target.value)}>{data.sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                    )}
                    {d.reviewStatus === 'PUBLISHED' && <button className="underline" onClick={() => run(async () => { await api.post(`/chef/dishes/${d.id}/sold-out`, { soldOut: !d.soldOut }); setData(await api.get<Menu>('/chef/menu')); })}>{d.soldOut ? 'Back in stock' : 'Mark sold out'}</button>}
                    <Link href={`/chef/dishes/${d.id}`} className="font-medium text-brand-700 underline">Edit</Link>
                  </div>
                </div>
              )}
            />
          )}
        </Card>
      ))}
    </div>
  );
}
