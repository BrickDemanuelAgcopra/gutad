'use client';
import { useMemo, useState } from 'react';
import { ALLERGENS, CHEF_OPTION_TEMPLATES, configToGroups, DIETARY_TAGS, newOptionId, validateOptionsConfig, type OptionsConfigGroup } from '@gutad/shared';
import { money } from '@/lib/api';
import { Badge, Button, Input, Select } from '@/components/ui';
import { ChipGroup, SortableList } from '@/components/form-kit';
import { CustomizationSummary, DishCustomizer, useCustomization } from '@/components/dish-customizer';

type Opt = OptionsConfigGroup['options'][number];
const TYPE_LABELS: Record<OptionsConfigGroup['selectionType'], string> = { SINGLE: 'Choose one', LEVEL: 'Level (None / Light / Standard / Extra)', MULTI: 'Choose several', QUANTITY: 'Portions (−/+)', INCLUDED: 'Included, not adjustable' };

/**
 * Chef option table: start from templates, then edit each option's default, limits, price, portion, prep time,
 * allergen and dietary effects, and rules. Groups can appear only after a chosen option ("only when").
 */
export function OptionsBuilder({ value, onChange, dishName, basePriceCents, baseAllergens, baseDietary, live, onSoldOut }: { value: OptionsConfigGroup[]; onChange: (v: OptionsConfigGroup[]) => void; dishName: string; basePriceCents: number; baseAllergens: string[]; baseDietary: string[]; live?: boolean; onSoldOut?: (optionId: string, soldOut: boolean) => void }) {
  const errs = validateOptionsConfig(value);
  const setGroup = (i: number, patch: Partial<OptionsConfigGroup>) => onChange(value.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const setOpt = (gi: number, oi: number, patch: Partial<Opt>) => setGroup(gi, { options: value[gi].options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) });
  const earlierOptions = (gi: number) => value.slice(0, gi).flatMap((g) => g.options.filter((o) => !o.locked).map((o) => ({ id: o.id, label: `${g.name}: ${o.name}` })));
  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-xs font-medium text-ink-500">Add from a template</span>
        <div className="flex flex-wrap gap-1.5">{CHEF_OPTION_TEMPLATES.map((t) => <button key={t.key} type="button" onClick={() => onChange([...value, t.build()])} className="rounded-full border border-ink-100 bg-white px-3 py-1 text-xs hover:border-brand-400" title={t.hint}>+ {t.label}</button>)}
          <button type="button" onClick={() => onChange([...value, { id: newOptionId(), name: 'New choice', selectionType: 'MULTI', required: false, minSelect: 0, maxSelect: 3, options: [{ id: newOptionId(), name: 'Option', priceCents: 0 }] }])} className="rounded-full border border-dashed border-ink-300 px-3 py-1 text-xs">+ Blank group</button>
        </div>
      </div>
      {!value.length && <p className="rounded-xl bg-ink-50 p-3 text-sm text-ink-500">No options yet. Customers can only adjust what you add here; anything else becomes a special request you can quote or decline.</p>}
      {live && <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800">This dish is live. Option changes go live after Gutad review. “Sold out” switches apply immediately.</p>}
      <SortableList
        items={value}
        getKey={(g) => g.id}
        label={(g) => g.name}
        onChange={onChange}
        render={(g, gi) => (
          <div className="space-y-3 pr-2">
            <div className="grid gap-2 sm:grid-cols-[1fr_200px_auto]">
              <Input aria-label="Group name" value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} />
              <Select aria-label="Type" value={g.selectionType} onChange={(e) => { const t = e.target.value as OptionsConfigGroup['selectionType']; setGroup(gi, { selectionType: t, ...(t === 'SINGLE' || t === 'LEVEL' ? { maxSelect: 1 } : t === 'INCLUDED' ? { required: false, minSelect: 0, maxSelect: 0, options: g.options.map((o) => ({ ...o, locked: true, priceCents: 0 })) } : {}) }); }}>{Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <button type="button" className="text-xs text-red-600 underline" onClick={() => onChange(value.filter((_, j) => j !== gi))}>Remove group</button>
            </div>
            {g.selectionType !== 'INCLUDED' && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" checked={g.required} onChange={(e) => setGroup(gi, { required: e.target.checked, minSelect: e.target.checked ? Math.max(1, g.minSelect) : 0 })} /> Required</label>
                {(g.selectionType === 'MULTI' || g.selectionType === 'QUANTITY') && <>
                  <label className="flex items-center gap-1">Min <input type="number" min={0} className="w-14 rounded border border-ink-100 px-1 py-0.5" value={g.minSelect} onChange={(e) => setGroup(gi, { minSelect: Number(e.target.value) })} /></label>
                  <label className="flex items-center gap-1">Max {g.selectionType === 'QUANTITY' ? 'portions' : 'choices'} <input type="number" min={0} className="w-14 rounded border border-ink-100 px-1 py-0.5" value={g.maxSelect} onChange={(e) => setGroup(gi, { maxSelect: Number(e.target.value) })} /></label>
                </>}
                {gi > 0 && <label className="flex items-center gap-1">Only when <select className="max-w-[220px] rounded border border-ink-100 px-1 py-0.5" value={g.parentOptionId || ''} onChange={(e) => setGroup(gi, { parentOptionId: e.target.value || null })}><option value="">always shown</option>{earlierOptions(gi).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
              </div>
            )}
            <Input aria-label="Note for customers" placeholder="Note for customers (optional), e.g. “Removing cheese does not make this milk-free”" value={g.description || ''} onChange={(e) => setGroup(gi, { description: e.target.value })} />
            <div className="overflow-x-auto rounded-lg border border-ink-100">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="bg-ink-50 text-left text-ink-500"><tr><th className="px-2 py-1.5">Option</th>{(g.selectionType === 'SINGLE' || g.selectionType === 'LEVEL') && <th className="px-2">Default</th>}<th className="px-2">Extra charge</th>{g.selectionType === 'QUANTITY' && <th className="px-2">Max each</th>}<th className="px-2">Portion</th><th className="px-2">Effects</th><th className="px-2" /></tr></thead>
                <tbody>
                  {g.options.map((o, oi) => (
                    <OptionRow key={o.id} o={o} g={g} gi={gi} oi={oi} setOpt={setOpt} allOptions={value.flatMap((x) => x.options.filter((y) => y.id !== o.id && !y.locked).map((y) => ({ id: y.id, label: `${x.name}: ${y.name}` })))} onRemove={() => setGroup(gi, { options: g.options.filter((_, j) => j !== oi) })} onDefault={() => setGroup(gi, { options: g.options.map((x) => ({ ...x, isDefault: x.id === o.id })) })} onMove={(dir) => { const n = [...g.options]; const j = oi + dir; if (j < 0 || j >= n.length) return; [n[oi], n[j]] = [n[j], n[oi]]; setGroup(gi, { options: n }); }} onSoldOut={live && onSoldOut ? (s) => { setOpt(gi, oi, { soldOut: s }); onSoldOut(o.id, s); } : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setGroup(gi, { options: [...g.options, { id: newOptionId(), name: '', priceCents: 0, ...(g.selectionType === 'INCLUDED' ? { locked: true } : {}), ...(g.selectionType === 'QUANTITY' ? { maxQty: 2 } : {}) }] })}>+ Add option</Button>
          </div>
        )}
      />
      {errs.length > 0 && <ul className="space-y-0.5 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{errs.map((e) => <li key={e}>• {e}</li>)}</ul>}
      {value.length > 0 && !errs.length && <TryIt cfg={value} dishName={dishName} basePriceCents={basePriceCents} baseAllergens={baseAllergens} baseDietary={baseDietary} />}
    </div>
  );
}

function OptionRow({ o, g, gi, oi, setOpt, allOptions, onRemove, onDefault, onMove, onSoldOut }: { o: Opt; g: OptionsConfigGroup; gi: number; oi: number; setOpt: (gi: number, oi: number, p: Partial<Opt>) => void; allOptions: { id: string; label: string }[]; onRemove: () => void; onDefault: () => void; onMove: (d: number) => void; onSoldOut?: (s: boolean) => void }) {
  const [more, setMore] = useState(false);
  const incl = g.selectionType === 'INCLUDED';
  const rules = Object.entries(o.rules || {});
  return (
    <>
      <tr className="border-t border-ink-100 align-top">
        <td className="px-2 py-1.5"><input aria-label="Option name" className="w-full rounded border border-ink-100 px-1.5 py-1" value={o.name} onChange={(e) => setOpt(gi, oi, { name: e.target.value })} placeholder="Name" /></td>
        {(g.selectionType === 'SINGLE' || g.selectionType === 'LEVEL') && <td className="px-2 py-1.5 text-center"><input type="radio" aria-label="Default" name={`def-${g.id}`} checked={!!o.isDefault} onChange={onDefault} /></td>}
        <td className="px-2 py-1.5">{incl ? <span className="text-ink-500">Included</span> : <input aria-label="Extra charge" type="number" min={0} step="0.25" className="w-20 rounded border border-ink-100 px-1.5 py-1" value={o.priceCents / 100} onChange={(e) => setOpt(gi, oi, { priceCents: Math.round(Number(e.target.value) * 100) })} />}</td>
        {g.selectionType === 'QUANTITY' && <td className="px-2 py-1.5"><input aria-label="Max each" type="number" min={1} max={20} className="w-14 rounded border border-ink-100 px-1.5 py-1" value={o.maxQty ?? 2} onChange={(e) => setOpt(gi, oi, { maxQty: Number(e.target.value) })} /></td>}
        <td className="px-2 py-1.5"><input aria-label="Portion" className="w-24 rounded border border-ink-100 px-1.5 py-1" value={o.portionDesc || ''} onChange={(e) => setOpt(gi, oi, { portionDesc: e.target.value })} placeholder="30 g" /></td>
        <td className="px-2 py-1.5">
          <div className="flex flex-wrap gap-1">{(o.addsAllergens || []).map((a) => <Badge key={a} tone="bad">+{a}</Badge>)}{(o.removesDietaryTags || []).map((t) => <Badge key={t} tone="warn">not {t.replace('_', ' ')}</Badge>)}{o.prepMinutesDelta ? <Badge>+{o.prepMinutesDelta} min</Badge> : null}{rules.length ? <Badge tone="info">{rules.length} rule{rules.length > 1 ? 's' : ''}</Badge> : null}{o.soldOut && <Badge tone="warn">sold out</Badge>}</div>
          {!incl && <button type="button" className="mt-1 text-[11px] underline" onClick={() => setMore(!more)}>{more ? 'Hide details' : 'Allergens, timing, rules'}</button>}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right">
          <button type="button" aria-label="Move option up" className="px-1" onClick={() => onMove(-1)}>↑</button>
          <button type="button" aria-label="Move option down" className="px-1" onClick={() => onMove(1)}>↓</button>
          {onSoldOut && <button type="button" className="px-1 underline" onClick={() => onSoldOut(!o.soldOut)}>{o.soldOut ? 'Back' : 'Sold out'}</button>}
          <button type="button" aria-label="Remove option" className="px-1 text-red-600" onClick={onRemove}>✕</button>
        </td>
      </tr>
      {more && (
        <tr className="bg-ink-50/60"><td colSpan={7} className="space-y-2 px-2 py-2">
          <div><span className="text-[11px] font-medium text-ink-500">Adds allergens</span><ChipGroup name="Adds allergens" values={o.addsAllergens || []} onChange={(v) => setOpt(gi, oi, { addsAllergens: v })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} /></div>
          <div><span className="text-[11px] font-medium text-ink-500">Removes dietary labels</span><ChipGroup name="Removes dietary labels" values={o.removesDietaryTags || []} onChange={(v) => setOpt(gi, oi, { removesDietaryTags: v })} options={DIETARY_TAGS.map((t) => ({ value: t, label: t.replace('_', ' ') }))} /></div>
          <label className="flex items-center gap-2 text-xs">Extra preparation <input type="number" min={0} className="w-16 rounded border border-ink-100 px-1 py-0.5" value={o.prepMinutesDelta || 0} onChange={(e) => setOpt(gi, oi, { prepMinutesDelta: Number(e.target.value) })} /> min</label>
          <div className="space-y-1 text-xs">
            <span className="text-[11px] font-medium text-ink-500">Rules (when another option is chosen)</span>
            {rules.map(([when, r]) => (
              <div key={when} className="flex flex-wrap items-center gap-2">When <strong>{allOptions.find((x) => x.id === when)?.label || 'option'}</strong>:
                <label>max <input type="number" min={0} className="w-12 rounded border border-ink-100 px-1" value={r.maxQty ?? ''} onChange={(e) => setOpt(gi, oi, { rules: { ...o.rules, [when]: { ...r, maxQty: e.target.value === '' ? undefined : Number(e.target.value) } } })} /></label>
                <label>price $<input type="number" min={0} step="0.25" className="w-16 rounded border border-ink-100 px-1" value={r.priceCents !== undefined ? r.priceCents / 100 : ''} onChange={(e) => setOpt(gi, oi, { rules: { ...o.rules, [when]: { ...r, priceCents: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100) } } })} /></label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!r.hidden} onChange={(e) => setOpt(gi, oi, { rules: { ...o.rules, [when]: { ...r, hidden: e.target.checked } } })} /> unavailable</label>
                <button type="button" className="text-red-600" onClick={() => { const n = { ...(o.rules || {}) }; delete n[when]; setOpt(gi, oi, { rules: n }); }}>remove</button>
              </div>
            ))}
            <select className="rounded border border-ink-100 px-1 py-0.5" value="" onChange={(e) => e.target.value && setOpt(gi, oi, { rules: { ...(o.rules || {}), [e.target.value]: {} } })}><option value="">+ Add a rule…</option>{allOptions.filter((x) => !(o.rules || {})[x.id]).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
          </div>
        </td></tr>
      )}
    </>
  );
}

/** Live customer preview of the options (same engine the customer and the API use). */
function TryIt({ cfg, dishName, basePriceCents, baseAllergens, baseDietary }: { cfg: OptionsConfigGroup[]; dishName: string; basePriceCents: number; baseAllergens: string[]; baseDietary: string[] }) {
  const groups = useMemo(() => configToGroups(cfg), [cfg]);
  const base = useMemo(() => ({ allergens: baseAllergens, dietaryTags: baseDietary }), [baseAllergens, baseDietary]);
  const { picks, setPicks, ev } = useCustomization(dishName, groups, base);
  return (
    <details className="rounded-xl border border-ink-100 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold">Try it as a customer · {money(basePriceCents + ev.modifiersCents)}</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-[1fr_220px]">
        <DishCustomizer groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName="you" />
        <CustomizationSummary basePriceCents={basePriceCents} ev={ev} qty={1} baseAllergens={baseAllergens} />
      </div>
    </details>
  );
}
