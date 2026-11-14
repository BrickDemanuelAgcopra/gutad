'use client';
import { useState } from 'react';
import { ALLERGENS } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Table, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

interface Row { id: string; name: string; version: number; status: string; shared: boolean; portionSize: string | null; plateCostCents: number; allergens: string[]; items: number; lowestMarginPct: number | null }
interface Ing { id: string; name: string; unit: string; costCentsPerUnit: number; allergens: string[]; organizationId: string | null }
interface Detail {
  recipe: { id: string; name: string; version: number; status: string; yieldPortions: number; laborMinutes: number; portionSize: string | null; steps: { n: number; text: string; stationCode?: string; minutes?: number }[]; equipment: string[]; prepMinutes: number; batchMaxPortions: number | null; trials: { at: string; by: string; notes: string; score: number | null }[]; trainingUrl: string | null; trainingNotes: string | null; changeSummary: string | null; createdById: string | null; organizationId: string | null };
  costing: { lines: { id: string; name: string; unit: string; quantity: number; costCents: number; allergens: string[] }[]; ingredientCentsPerPortion: number; laborCentsPerPortion: number; plateCostCents: number; allergens: string[]; items: { id: string; name: string; priceCents: number; marginPct: number | null; foodCostPct: number | null; allergenReviewNeeded: boolean }[] };
  history: { id: string; version: number; status: string; changeSummary: string | null }[];
  substitutions: { ingredient?: string; substitute?: string; ratio?: number; approved?: boolean; substituteAllergens: string[] }[];
  acknowledgments: { email: string; at: string }[];
  awaitingAcknowledgment: { email: string; role: string }[];
}
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Recipes: standard recipes, steps per station, versions, trials, release approval, training & acknowledgments, plate cost & margins. */
export default function Recipes() {
  const { org } = useMerchant();
  const { user } = useSession();
  const { data: list, reload } = useApi<Row[]>(org ? `/organizations/${org.id}/recipes` : null, { deps: [org?.id] });
  const { data: ings, reload: reloadIngs } = useApi<Ing[]>(org ? `/ingredients?organizationId=${org.id}` : null, { deps: [org?.id] });
  const { data: review } = useApi<{ id: string; name: string; missing: string[] }[]>(org ? `/organizations/${org.id}/allergen-review` : null, { deps: [org?.id] });
  const [sel, setSel] = useState<string | null>(null);
  const { data: d, reload: reloadD } = useApi<Detail>(sel ? `/recipes/${sel}` : null, { deps: [sel] });
  const { run, error } = useAction();
  const [nr, setNr] = useState<{ name: string; yieldPortions: string; laborMinutes: string; portionSize: string; lines: { ingredientId: string; quantity: string }[]; steps: string } | null>(null);
  const [ni, setNi] = useState({ name: '', unit: 'g', cost: '', allergens: [] as string[] });
  if (!org) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); await reloadD(); });
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between"><h1 className="text-2xl font-bold">Recipes</h1><Button onClick={() => setNr({ name: '', yieldPortions: '1', laborMinutes: '0', portionSize: '', lines: [{ ingredientId: '', quantity: '' }], steps: '' })}>New recipe</Button></div>
      {error && <Alert>{error}</Alert>}
      {review && review.length > 0 && <Alert>Allergen review needed: {review.map((r) => `${r.name} (${r.missing.join(', ')})`).join('; ')} — update the item on the Menu page.</Alert>}
      <Table rows={list || []} empty="No recipes yet." cols={[
        { key: 'n', label: 'Recipe', render: (r) => <button className="text-left underline" onClick={() => setSel(r.id)}>{r.name} <span className="text-xs text-ink-500 no-underline">v{r.version}{r.shared ? ' · shared' : ''}</span></button> },
        { key: 's', label: 'Status', render: (r) => <Badge tone={r.status === 'APPROVED' ? 'good' : r.status === 'RETIRED' ? 'neutral' : 'warn'}>{r.status}</Badge> },
        { key: 'c', label: 'Plate cost', render: (r) => `${money(r.plateCostCents)}${r.portionSize ? ` / ${r.portionSize}` : ''}` },
        { key: 'm', label: 'Lowest margin', render: (r) => <span className={r.lowestMarginPct !== null && r.lowestMarginPct < 0.6 ? 'text-red-700' : ''}>{pct(r.lowestMarginPct)}</span> },
        { key: 'a', label: 'Allergens', render: (r) => <span className="text-xs">{r.allergens.join(', ') || '—'}</span> },
        { key: 'i', label: 'Menu items', render: (r) => r.items },
      ]} />
      {d && (
        <Card title={<span>{d.recipe.name} v{d.recipe.version} <Badge>{d.recipe.status}</Badge></span>} action={<Button size="sm" variant="ghost" onClick={() => setSel(null)}>Close</Button>}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2 text-sm">
              <div>Yield {d.recipe.yieldPortions} portions{d.recipe.portionSize ? ` of ${d.recipe.portionSize}` : ''} · prep {d.recipe.prepMinutes} min · labor {d.recipe.laborMinutes} min{d.recipe.batchMaxPortions ? ` · max batch ${d.recipe.batchMaxPortions}` : ''}{d.recipe.equipment.length ? ` · ${d.recipe.equipment.join(', ')}` : ''}</div>
              <table className="w-full text-xs"><tbody>{d.costing.lines.map((l) => <tr key={l.id} className="border-t border-ink-50"><td>{l.name}{l.allergens.length > 0 && <span className="text-red-700"> ({l.allergens.join(', ')})</span>}</td><td>{l.quantity} {l.unit}</td><td className="text-right">{money(l.costCents)}</td></tr>)}</tbody></table>
              <div className="font-semibold">Plate cost {money(d.costing.plateCostCents)} <span className="text-xs font-normal text-ink-500">({money(d.costing.ingredientCentsPerPortion)} food + {money(d.costing.laborCentsPerPortion)} labor)</span></div>
              {d.costing.items.map((i) => <div key={i.id} className="text-xs">{i.name}: {money(i.priceCents)} · food cost {pct(i.foodCostPct)} · margin {pct(i.marginPct)}{i.allergenReviewNeeded && <Badge tone="bad">allergen review</Badge>}</div>)}
              {d.substitutions.length > 0 && <div className="text-xs"><b>Approved substitutions:</b> {d.substitutions.map((s) => `${s.ingredient} → ${s.substitute}${s.substituteAllergens.length ? ` (${s.substituteAllergens.join(', ')})` : ''}`).join('; ')}</div>}
            </div>
            <div className="space-y-2 text-sm">
              <div className="font-semibold">Steps</div>
              <ol className="list-decimal pl-5 text-sm">{d.recipe.steps.map((s) => <li key={s.n}>{s.text}{s.stationCode && <Badge>{s.stationCode}</Badge>}{s.minutes ? <span className="text-xs text-ink-500"> {s.minutes} min</span> : null}</li>)}</ol>
              {d.recipe.trainingNotes && <p className="text-xs">Training: {d.recipe.trainingNotes} {d.recipe.trainingUrl && <a className="underline" href={d.recipe.trainingUrl} target="_blank" rel="noreferrer">video</a>}</p>}
              <div className="text-xs">Trials: {d.recipe.trials.map((t) => `${when(t.at)} ${t.by}: ${t.notes}${t.score ? ` (${t.score}/5)` : ''}`).join(' · ') || 'none'}</div>
              {d.recipe.status === 'APPROVED' && <div className="text-xs">Read by: {d.acknowledgments.map((a) => a.email).join(', ') || 'nobody yet'}{d.awaitingAcknowledgment.length > 0 && <span className="text-amber-700"> · waiting: {d.awaitingAcknowledgment.map((a) => a.email).join(', ')}</span>}</div>}
              <div className="text-xs text-ink-500">Versions: {d.history.map((h) => `v${h.version} ${h.status.toLowerCase()}`).join(' · ') || 'first version'}</div>
              <div className="flex flex-wrap gap-2">
                {['DRAFT', 'TRIAL'].includes(d.recipe.status) && <Button size="sm" variant="secondary" onClick={() => { const notes = window.prompt('Trial notes'); if (notes) act(() => api.post(`/recipes/${d.recipe.id}/trials`, { notes, score: Number(window.prompt('Score 1–5', '4')) || undefined })); }}>Record trial</Button>}
                {['DRAFT', 'TRIAL'].includes(d.recipe.status) && d.recipe.createdById !== user?.id && <Button size="sm" onClick={() => { const note = window.prompt('Release note'); if (note) act(() => api.post(`/recipes/${d.recipe.id}/approve`, { note })); }}>Approve release</Button>}
                {d.recipe.status === 'APPROVED' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/recipes/${d.recipe.id}/acknowledge`, {}))}>I&apos;ve read it</Button>}
                {d.recipe.status === 'APPROVED' && !d.recipe.organizationId ? null : d.recipe.status === 'APPROVED' && <Button size="sm" variant="ghost" onClick={() => { const changeSummary = window.prompt('What changes in the new version?'); if (changeSummary) act(async () => { const r = await api.post<{ id: string }>(`/organizations/${org.id}/recipes`, { previousRecipeId: d.recipe.id, name: d.recipe.name, changeSummary }); setSel(r.id); }); }}>New version</Button>}
              </div>
            </div>
          </div>
        </Card>
      )}
      <Card title="Your ingredients">
        <div className="grid gap-2 sm:grid-cols-[1fr_90px_110px_auto]"><Input placeholder="Name" value={ni.name} onChange={(e) => setNi({ ...ni, name: e.target.value })} /><Select value={ni.unit} onChange={(e) => setNi({ ...ni, unit: e.target.value })}>{['g', 'ml', 'each'].map((u) => <option key={u}>{u}</option>)}</Select><Input placeholder="¢ per unit" value={ni.cost} onChange={(e) => setNi({ ...ni, cost: e.target.value })} /><Button size="sm" disabled={!ni.name} onClick={() => run(async () => { await api.post('/ingredients', { organizationId: org.id, name: ni.name, unit: ni.unit, costCentsPerUnit: Number(ni.cost) || 0, allergens: ni.allergens }); setNi({ name: '', unit: 'g', cost: '', allergens: [] }); reloadIngs(); })}>Add</Button></div>
        <div className="mt-1 flex flex-wrap gap-2">{ALLERGENS.map((a) => <label key={a} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={ni.allergens.includes(a)} onChange={(e) => setNi({ ...ni, allergens: e.target.checked ? [...ni.allergens, a] : ni.allergens.filter((x) => x !== a) })} />{a.replace('_', ' ')}</label>)}</div>
        <div className="mt-2 text-xs text-ink-500">{ings?.filter((i) => i.organizationId).map((i) => `${i.name} (${i.costCentsPerUnit}¢/${i.unit}${i.allergens.length ? `, ${i.allergens.join('/')}` : ''})`).join(' · ')}</div>
      </Card>
      <Modal open={!!nr} onClose={() => setNr(null)} title="New recipe">
        {nr && (
          <div className="space-y-2">
            <Input label="Name" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} />
            <div className="grid grid-cols-3 gap-2"><Input label="Yield (portions)" value={nr.yieldPortions} onChange={(e) => setNr({ ...nr, yieldPortions: e.target.value })} /><Input label="Labor (min)" value={nr.laborMinutes} onChange={(e) => setNr({ ...nr, laborMinutes: e.target.value })} /><Input label="Portion size" value={nr.portionSize} onChange={(e) => setNr({ ...nr, portionSize: e.target.value })} /></div>
            {nr.lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_100px] gap-2"><Select value={l.ingredientId} onChange={(e) => setNr({ ...nr, lines: nr.lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)) })}><option value="">Ingredient…</option>{ings?.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}</Select><Input placeholder="Qty" value={l.quantity} onChange={(e) => setNr({ ...nr, lines: nr.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} /></div>)}
            <button className="text-xs underline" onClick={() => setNr({ ...nr, lines: [...nr.lines, { ingredientId: '', quantity: '' }] })}>+ Ingredient</button>
            <Textarea label="Steps (one per line; start with [STATION] to route, e.g. [GRILL] Sear 2 min)" rows={4} value={nr.steps} onChange={(e) => setNr({ ...nr, steps: e.target.value })} />
            <Button onClick={() => run(async () => { const steps = nr.steps.split('\n').filter((x) => x.trim()).map((t, i) => { const m = t.match(/^\[(\w+)\]\s*(.*)$/); return { n: i + 1, text: m ? m[2] : t.trim(), stationCode: m ? m[1] : undefined }; }); const r = await api.post<{ id: string }>(`/organizations/${org.id}/recipes`, { name: nr.name, yieldPortions: Number(nr.yieldPortions) || 1, laborMinutes: Number(nr.laborMinutes) || 0, portionSize: nr.portionSize || null, steps, lines: nr.lines.filter((l) => l.ingredientId && Number(l.quantity)).map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity) })) }); setNr(null); await reload(); setSel(r.id); })}>Create draft</Button>
            <p className="text-xs text-ink-500">Drafts can be trialled in the test kitchen; someone other than the author approves the release, and the new version replaces the old one on your menu items.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
