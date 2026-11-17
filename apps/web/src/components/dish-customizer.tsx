'use client';
import { useMemo, useState } from 'react';
import { evaluateCustomization, modifierLabel, type CustomizationResult, type ModGroup, type ModOption } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/hooks';
import { QtyStepper, RadioCards, Segmented } from '@/components/form-kit';

const plus = (c: number) => (c ? `+${money(c)}` : '');

/** Selection state as option id → quantity (the API receives repeated ids). */
export type Picks = Record<string, number>;
export const picksToIds = (p: Picks) => Object.entries(p).flatMap(([id, n]) => Array(Math.max(0, n)).fill(id) as string[]);

export function useCustomization(name: string, groups: ModGroup[], base: { allergens: string[]; dietaryTags: string[] }) {
  const [picks, setRaw] = useState<Picks>({});
  const ev = useMemo(() => evaluateCustomization(name, groups, picksToIds(picks), base), [name, groups, picks, base]);
  /** Choices inside a conditional group are dropped when its parent choice is undone. */
  const setPicks = (next: Picks) => {
    let p = { ...next };
    for (let i = 0; i < 3; i++) {
      const ids = picksToIds(p);
      const sel = new Set(evaluateCustomization(name, groups.map((g) => (g.parentOptionId ? { ...g, options: [] } : g)), ids.filter((id) => !groups.some((g) => g.parentOptionId && g.options.some((o) => o.id === id))), base).chosen.map((c) => c.id));
      let changed = false;
      for (const g of groups) if (g.parentOptionId && !sel.has(g.parentOptionId) && !(p[g.parentOptionId] > 0)) for (const o of g.options) if (p[o.id]) { delete p[o.id]; changed = true; }
      if (!changed) break;
      p = { ...p };
    }
    setRaw(p);
  };
  return { picks, setPicks, ev };
}

/**
 * Tap-based customization: radio cards for one choice, segmented buttons for levels, checkboxes with prices for
 * several, −/+ steppers for portions, included components shown as locked, and ingredient search over the
 * chef's approved extras. Conditional groups appear as soon as their parent choice is made.
 */
export function DishCustomizer({ groups, picks, setPicks, ev, chefName, onAskChef, acceptsRequests, dishId }: { groups: ModGroup[]; picks: Picks; setPicks: (p: Picks) => void; ev: CustomizationResult; chefName: string; onAskChef?: (term: string) => void; acceptsRequests?: boolean; /** shows “Describe what you want” (CN.3) */ dishId?: string }) {
  const active = new Set(ev.activeGroupIds);
  const chosenQty = (id: string) => ev.chosen.find((c) => c.id === id)?.qty || 0;
  const setGroupSingle = (g: ModGroup, id: string) => { const n: Picks = { ...picks }; for (const o of g.options) delete n[o.id]; n[id] = 1; setPicks(n); };
  const toggle = (id: string) => setPicks({ ...picks, [id]: picks[id] ? 0 : 1 });
  const setQty = (id: string, q: number) => setPicks({ ...picks, [id]: q });
  const ruleMax = (o: ModOption) => { let m = o.maxQty ?? 10; for (const [when, r] of Object.entries(o.rules || {})) if (chosenQty(when) && r.maxQty !== undefined) m = r.maxQty; return m; };
  const rulePrice = (o: ModOption) => { let p = o.priceCents; for (const [when, r] of Object.entries(o.rules || {})) if (chosenQty(when) && r.priceCents !== undefined) p = r.priceCents; return p; };
  const visible = groups.filter((g) => !g.isExtras && (!g.parentOptionId || active.has(g.id)));
  const extras = groups.find((g) => g.isExtras);
  return (
    <div className="space-y-5">
      {dishId && visible.some((g) => (g.selectionType || 'CHOICE') !== 'INCLUDED') && <DescribeIt dishId={dishId} setPicks={setPicks} chefName={chefName} onAskChef={acceptsRequests ? onAskChef : undefined} />}
      {visible.map((g) => {
        const t = g.selectionType || 'CHOICE';
        const req = g.required || g.minSelect > 0;
        const head = (
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold">{g.name}{g.parentOptionId && <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand-700">New</span>}</h3>
            <span className="text-xs text-ink-500">{t === 'INCLUDED' ? 'Not adjustable' : req ? 'Required' : t === 'QUANTITY' && g.maxSelect ? `Optional · up to ${g.maxSelect}` : t === 'MULTI' ? `Optional · up to ${g.maxSelect}` : 'Optional'}</span>
          </div>
        );
        const desc = g.description && <p className="-mt-1 mb-2 text-xs text-ink-500">{g.description}</p>;
        if (t === 'INCLUDED')
          return <section key={g.id}>{head}{desc}<ul className="space-y-1">{g.options.map((o) => <li key={o.id} className="flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700"><span aria-hidden>🔒</span>{o.name}<span className="ml-auto text-xs text-ink-500">Included</span></li>)}</ul></section>;
        const current = g.options.find((o) => chosenQty(o.id));
        if (t === 'LEVEL')
          return <section key={g.id}>{head}{desc}<Segmented name={g.name} value={current?.id} onChange={(id) => setGroupSingle(g, id)} options={g.options.map((o) => ({ value: o.id, label: <>{o.name}{rulePrice(o) ? <span className="ml-1 text-xs text-ink-500">{plus(rulePrice(o))}</span> : null}</>, disabled: o.soldOut }))} /></section>;
        if (t === 'SINGLE' || (t === 'CHOICE' && g.maxSelect === 1))
          return <section key={g.id}>{head}{desc}<RadioCards name={g.name} columns={g.options.length > 2 ? 2 : g.options.length === 2 ? 2 : 1} value={current?.id} onChange={(id) => (current?.id === id && !req ? setPicks({ ...picks, [id]: 0 }) : setGroupSingle(g, id))} options={g.options.map((o) => ({ value: o.id, label: o.name, description: [o.portionDesc, o.addsAllergens?.length ? `Contains ${o.addsAllergens.join(', ')}` : '', o.soldOut ? 'Sold out' : ''].filter(Boolean).join(' · ') || undefined, extra: plus(rulePrice(o)), disabled: o.soldOut }))} /></section>;
        if (t === 'QUANTITY')
          return (
            <section key={g.id}>{head}{desc}
              <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white">
                {g.options.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1"><div className="text-sm font-medium">{o.name}</div><div className="text-xs text-ink-500">{[o.portionDesc && `per portion ${o.portionDesc}`, rulePrice(o) ? `${money(rulePrice(o))} each` : 'free', o.addsAllergens?.length ? `contains ${o.addsAllergens.join(', ')}` : '', o.soldOut ? 'sold out' : ''].filter(Boolean).join(' · ')}</div></div>
                    <QtyStepper size="sm" label={o.name} value={picks[o.id] || 0} min={0} max={o.soldOut ? 0 : ruleMax(o)} onChange={(q) => setQty(o.id, q)} />
                  </li>
                ))}
              </ul>
            </section>
          );
        return (
          <section key={g.id}>{head}{desc}
            <ul className="space-y-1.5">
              {g.options.map((o) => {
                const on = !!chosenQty(o.id);
                return (
                  <li key={o.id}>
                    <label className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition ${on ? 'border-brand-500 bg-brand-50' : 'border-ink-100 bg-white hover:border-ink-300'} ${o.soldOut ? 'opacity-50' : ''}`}>
                      <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={on} disabled={o.soldOut} onChange={() => toggle(o.id)} />
                      <span className="flex-1">{o.name}{o.addsAllergens?.length ? <span className="block text-xs text-ink-500">Contains {o.addsAllergens.join(', ')}</span> : null}</span>
                      <span className="text-xs font-medium text-ink-700">{o.soldOut ? 'Sold out' : plus(rulePrice(o))}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {(extras || acceptsRequests) && <ExtrasSearch group={extras} picks={picks} setQty={setQty} chefName={chefName} onAskChef={onAskChef} acceptsRequests={acceptsRequests} />}
    </div>
  );
}

function ExtrasSearch({ group, picks, setQty, chefName, onAskChef, acceptsRequests }: { group?: ModGroup; picks: Picks; setQty: (id: string, q: number) => void; chefName: string; onAskChef?: (t: string) => void; acceptsRequests?: boolean }) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const all = group?.options || [];
  const hits = term ? all.filter((o) => o.name.toLowerCase().includes(term) || (o.searchTerms || []).some((s) => s.includes(term) || term.includes(s))) : [];
  const added = all.filter((o) => (picks[o.id] || 0) > 0);
  const rows = Array.from(new Set([...added, ...hits]));
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between"><h3 className="font-semibold">Add an ingredient</h3><span className="text-xs text-ink-500">Search {chefName}’s approved extras</span></div>
      <input type="search" role="combobox" aria-expanded={!!term} aria-label="Search extras" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. burrata, chili, shrimp" className="w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" />
      {!term && !added.length && all.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{all.slice(0, 6).map((o) => <button key={o.id} type="button" onClick={() => setQ(o.name)} className="rounded-full border border-ink-100 bg-white px-2.5 py-1 text-xs hover:border-ink-300">{o.name} {o.priceCents ? `· ${money(o.priceCents)}` : ''}</button>)}</div>}
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white">
          {rows.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">{o.name}</div><div className="text-xs text-ink-500">{[o.portionDesc, o.priceCents ? `${money(o.priceCents)} each` : 'free', o.addsAllergens?.length ? `contains ${o.addsAllergens.join(', ')}` : '', o.soldOut ? 'sold out' : ''].filter(Boolean).join(' · ')}</div></div>
              <QtyStepper size="sm" label={o.name} value={picks[o.id] || 0} min={0} max={o.soldOut ? 0 : o.maxQty ?? 2} onChange={(n) => setQty(o.id, n)} />
            </li>
          ))}
        </ul>
      )}
      {term && !hits.length && (
        <div className="mt-2 rounded-xl border border-dashed border-ink-300 bg-ink-50 p-3 text-sm">
          {acceptsRequests ? (
            <>
              <p className="font-medium">Ask {chefName} to add {q.trim()}</p>
              <p className="text-xs text-ink-500">Tell the chef how much you’d like. Price and availability need the chef’s confirmation; nothing is charged until you accept a quote.</p>
              <button type="button" disabled={!onAskChef} onClick={() => onAskChef?.(q.trim())} className="mt-2 rounded-lg border border-ink-100 bg-white px-3 py-1.5 text-xs font-medium disabled:opacity-60">{`Ask ${chefName}`}</button>
            </>
          ) : <p className="text-xs text-ink-500">{q.trim()} isn’t offered on this dish. {chefName} doesn’t take special requests for it.</p>}
        </div>
      )}
    </section>
  );
}

/** Persistent order summary: base price, changes, allergens and dietary effects, total. */
export function CustomizationSummary({ basePriceCents, ev, qty, baseAllergens, compact }: { basePriceCents: number; ev: CustomizationResult; qty: number; baseAllergens: string[]; compact?: boolean }) {
  const lines = ev.chosen.filter((c) => c.priceCents > 0 || !c.name.match(/^(Regular|Standard|Medium)$/));
  const newAllergens = ev.allergens.filter((a) => !baseAllergens.includes(a));
  return (
    <div className="space-y-2 text-sm">
      {!compact && (
        <ul className="space-y-1">
          <li className="flex justify-between"><span>Dish</span><span>{money(basePriceCents)}</span></li>
          {lines.map((c) => <li key={c.id} className="flex justify-between text-ink-700"><span>{modifierLabel(c)}</span><span>{c.priceCents ? `+${money(c.priceCents)}` : '—'}</span></li>)}
        </ul>
      )}
      {newAllergens.length > 0 && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">Your choices add: {newAllergens.join(', ')}</p>}
      {ev.removedDietaryTags.length > 0 && <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">No longer {ev.removedDietaryTags.map((t) => t.replace('_', ' ')).join(', ')}</p>}
      {ev.prepMinutesDelta > 0 && <p className="text-xs text-ink-500">Adds about {ev.prepMinutesDelta} min of preparation</p>}
      {!ev.ok && <p className="text-xs text-red-600">{ev.errors[0]}</p>}
      <div className="flex justify-between border-t border-ink-100 pt-2 font-semibold"><span>{qty > 1 ? `${qty} × ${money(basePriceCents + ev.modifiersCents)}` : 'Total'}</span><span>{money((basePriceCents + ev.modifiersCents) * qty)}</span></div>
    </div>
  );
}

interface Interpretation { source: 'ai' | 'rules'; optionIds: string[]; chosen: { id: string; name: string; qty: number }[]; unmatched: string[]; note: string; ok: boolean; errors: string[] }

/**
 * CN.3: the customer describes the dish in their words ("large, extra spicy, no onions"); Gutad fills in the matching
 * options for them to review. What no option covers can go to the chef as a special request.
 */
function DescribeIt({ dishId, setPicks, chefName, onAskChef }: { dishId: string; setPicks: (p: Picks) => void; chefName: string; onAskChef?: (term: string) => void }) {
  const { user } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Interpretation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<Interpretation>(`/chef-dishes/${dishId}/interpret`, { text });
      const p: Picks = {};
      for (const id of r.optionIds) p[id] = (p[id] || 0) + 1;
      setPicks(p);
      setRes(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Describe what you want" className="rounded-xl border border-dashed border-ink-200 p-3">
      <label htmlFor="describe-it" className="text-sm font-semibold">Describe what you want</label>
      <p className="text-xs text-ink-500">e.g. “large, extra spicy, no onions, add shrimp”. We fill in the options for you to check.</p>
      <div className="mt-2 flex gap-2">
        <input id="describe-it" className="min-w-0 flex-1 rounded-lg border border-ink-200 px-3 py-2 text-sm" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim().length > 1 && user) { e.preventDefault(); void go(); } }} placeholder="Your way, in your words" />
        <button type="button" className="rounded-lg bg-ink-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || text.trim().length < 2 || !user} onClick={() => void go()}>{busy ? 'Filling in…' : 'Fill in options'}</button>
      </div>
      {!user && <p className="mt-1 text-xs text-ink-500">Sign in to use this.</p>}
      {err && <p className="mt-2 text-sm text-red-700">{err}</p>}
      {res && (
        <div className="mt-2 space-y-1 text-sm" aria-live="polite">
          <p>{res.note}</p>
          {!res.ok && res.errors[0] && <p className="text-amber-700">Still needed: {res.errors[0]}</p>}
          {res.unmatched.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-ink-600">Not on the options:</span>
              {res.unmatched.map((u) => onAskChef
                ? <button key={u} type="button" className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs text-brand-700 hover:bg-brand-100" onClick={() => onAskChef(u)}>Ask {chefName} for “{u}”</button>
                : <span key={u} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs">{u}</span>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
