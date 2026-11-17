'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ALLERGENS, CHEF_CUISINES, CHEF_DISH_MODES, CHEF_DISH_STATUS_LABELS, CHEF_FULFILLMENT_FORMATS, chefDishMissing, chefDishTitle, DIETARY_TAGS, type ChefDishInput, type ChefDishStatus } from '@gutad/shared';
import { api, API_URL, money, uploadFile } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Spinner, Textarea } from '@/components/ui';
import { ChipGroup, FileDrop, RadioCards, SaveBadge, StepNav, useAutosave } from '@/components/form-kit';

interface Dish extends Required<Pick<ChefDishInput, 'dishName' | 'portionDesc' | 'ingredients' | 'allergens' | 'dietaryTags' | 'priceCents' | 'mode' | 'acceptsSpecialRequests' | 'fulfillmentFormat' | 'prepMinutes' | 'photos'>> {
  id: string; title: string; description: string | null; cuisine: string | null; allergensConfirmed: boolean; dailyCapacity: number | null; minLeadDays: number | null; cutoffHour: number | null; maxAdvanceDays: number | null;
  reviewStatus: ChefDishStatus; reviewNote: string | null; pendingChanges: Record<string, unknown> | null; missing: string[]; soldOut: boolean; live: boolean;
}
interface Me { profile: { displayName: string; operating: { minLeadDays?: number; cutoffHour?: number; dailyCapacity?: number; maxAdvanceDays?: number } } }

const STEPS = [
  { key: 'describe', label: 'Describe the dish' },
  { key: 'mode', label: 'Fixed or customizable' },
  { key: 'options', label: 'Customer options' },
  { key: 'availability', label: 'Availability' },
  { key: 'preview', label: 'Preview & submit' },
];
const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED', 'PUBLISHED'];

export default function DishBuilder() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: dish, setData, loading } = useApi<Dish>(`/chef/dishes/${id}`);
  const { data: me } = useApi<Me>('/chef/me');
  const [f, setF] = useState<Dish | null>(null);
  const [step, setStep] = useState('describe');
  const { run, busy, error } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (dish && !f) setF(dish); }, [dish]); // eslint-disable-line react-hooks/exhaustive-deps
  const draft = !!dish && dish.reviewStatus !== 'PUBLISHED';
  const auto = useAutosave<Partial<Dish>>(async (patch) => setData(await api.patch<Dish>(`/chef/dishes/${id}`, patch)));
  if (loading || !f || !dish) return <Spinner />;
  const editable = EDITABLE.includes(dish.reviewStatus);
  const chef = me?.profile.displayName || '';
  const op = me?.profile.operating || {};
  const set = (patch: Partial<Dish>) => {
    const next = { ...f, ...patch };
    if (patch.mode === 'FIXED') next.acceptsSpecialRequests = false;
    setF(next);
    if (draft && editable) auto.queue(patch);
  };
  const payload = (x: Dish): ChefDishInput => ({ dishName: x.dishName, description: x.description, cuisine: x.cuisine, portionDesc: x.portionDesc, ingredients: x.ingredients, allergens: x.allergens, allergensConfirmed: x.allergensConfirmed, dietaryTags: x.dietaryTags, priceCents: x.priceCents, mode: x.mode, acceptsSpecialRequests: x.acceptsSpecialRequests, fulfillmentFormat: x.fulfillmentFormat, prepMinutes: x.prepMinutes, dailyCapacity: x.dailyCapacity, minLeadDays: x.minLeadDays, cutoffHour: x.cutoffHour, maxAdvanceDays: x.maxAdvanceDays, photos: x.photos });
  const saveLive = () => run(async () => {
    const r = await api.patch<Dish & { needsReview: boolean }>(`/chef/dishes/${id}`, payload(f));
    setData(r);
    setMsg(r.needsReview ? 'Saved. Price and availability changes are live; ingredient, allergen, photo and description changes go live after Gutad review.' : 'Saved — changes are live.');
  });
  const submit = () => run(async () => { await auto.flush(); setData(await api.post<Dish>(`/chef/dishes/${id}/submit`, {})); setStep('preview'); });
  const missing = chefDishMissing(payload(f));
  const idx = STEPS.findIndex((s) => s.key === step);
  const stepDone: Record<string, boolean> = {
    describe: !missing.some((m) => /name|price|portion|ingredient|allergen|photo/i.test(m)),
    mode: !!f.mode,
    options: true,
    availability: !!f.fulfillmentFormat && f.prepMinutes > 0,
    preview: dish.reviewStatus !== 'DRAFT' && dish.reviewStatus !== 'CHANGES_REQUESTED',
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/chef/dishes" className="text-sm text-ink-500 hover:underline">← Dishes</Link>
          <h1 className="text-2xl font-bold">{chefDishTitle(f.dishName || 'New dish', chef)}</h1>
          <div className="mt-1 flex flex-wrap gap-1"><Badge tone={dish.reviewStatus === 'PUBLISHED' ? 'good' : dish.reviewStatus === 'CHANGES_REQUESTED' ? 'warn' : 'info'}>{CHEF_DISH_STATUS_LABELS[dish.reviewStatus]}</Badge>{dish.pendingChanges && <Badge tone="info">Changes waiting for review</Badge>}</div>
        </div>
        <div className="flex items-center gap-2">
          {draft && <SaveBadge state={auto.state} error={auto.error} />}
          {dish.reviewStatus === 'PUBLISHED' && <Button disabled={busy} onClick={saveLive}>Save changes</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('Archive this dish? It will be removed from your menu.')) void run(async () => { await api.post(`/chef/dishes/${id}/archive`, {}); router.push('/chef/dishes'); }); }}>Archive</Button>
        </div>
      </div>
      {dish.reviewStatus === 'CHANGES_REQUESTED' && dish.reviewNote && <Alert tone="info">Gutad reviewer: {dish.reviewNote}</Alert>}
      {dish.reviewStatus === 'IN_REVIEW' && <Alert tone="info">Gutad is reviewing this dish (ingredients, allergens, portion, photos and price). You can edit it again after the decision.</Alert>}
      {msg && <Alert tone="good">{msg}</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-[200px_1fr_320px]">
        <div className="lg:sticky lg:top-20 lg:self-start"><StepNav active={step} onSelect={setStep} steps={STEPS.map((s) => ({ ...s, complete: stepDone[s.key] }))} /></div>
        <Card title={STEPS[idx].label}>
          <fieldset disabled={!editable} className="space-y-4 disabled:opacity-70">
            {step === 'describe' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Dish name" value={f.dishName} onChange={(e) => set({ dishName: e.target.value })} placeholder="Spaghetti" />
                  <Input label="Price (USD)" type="number" min={1} step="0.5" value={f.priceCents ? f.priceCents / 100 : ''} onChange={(e) => set({ priceCents: Math.round(Number(e.target.value) * 100) })} />
                </div>
                <p className="-mt-2 text-xs text-ink-500">Listed as <strong>{chefDishTitle(f.dishName || '…', chef)}</strong></p>
                <Textarea label="Description" rows={3} value={f.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="What makes it special; reheating instructions if chilled" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Portion" value={f.portionDesc} onChange={(e) => set({ portionDesc: e.target.value })} placeholder="1 bowl (450 g) · serves 1" />
                  <Select label="Cuisine" value={f.cuisine || ''} onChange={(e) => set({ cuisine: e.target.value || null })}><option value="">—</option>{CHEF_CUISINES.map((c) => <option key={c}>{c}</option>)}</Select>
                </div>
                <TagInput label="Ingredients (type and press Enter)" values={f.ingredients} onChange={(ingredients) => set({ ingredients })} />
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-500">Allergens in the dish or prepared alongside it</span>
                  <ChipGroup name="Allergens" values={f.allergens} onChange={(allergens) => set({ allergens, allergensConfirmed: true })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} />
                  <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allergensConfirmed} onChange={(e) => set({ allergensConfirmed: e.target.checked })} /> I confirm this allergen list is complete{!f.allergens.length ? ' (none of these allergens)' : ''}</label>
                </div>
                <div><span className="mb-1 block text-xs font-medium text-ink-500">Dietary labels</span><ChipGroup name="Dietary labels" values={f.dietaryTags} onChange={(dietaryTags) => set({ dietaryTags })} options={DIETARY_TAGS.map((t) => ({ value: t, label: t.replace('_', ' ') }))} /></div>
                <Photos photos={f.photos} onChange={(photos) => set({ photos })} />
              </>
            )}
            {step === 'mode' && (
              <>
                <RadioCards name="Listing type" columns={1} value={f.mode} onChange={(mode) => set({ mode })} options={(Object.keys(CHEF_DISH_MODES) as (keyof typeof CHEF_DISH_MODES)[]).map((k) => ({ value: k, label: CHEF_DISH_MODES[k].label, description: <><span className="block">Customer: {CHEF_DISH_MODES[k].customer}</span><span className="block">You: {CHEF_DISH_MODES[k].chef}</span></> }))} />
                {f.mode === 'CUSTOMIZABLE' ? (
                  <label className="flex items-start gap-2 rounded-xl border border-ink-100 p-3 text-sm"><input type="checkbox" className="mt-1" checked={f.acceptsSpecialRequests} onChange={(e) => set({ acceptsSpecialRequests: e.target.checked })} /><span><strong>Accept special requests</strong><span className="block text-xs text-ink-500">Customers can ask for an ingredient or change outside your published options. You review and send a quote, suggest an alternative, or decline. Nothing unlisted is ever ordered without your quote and the customer’s acceptance.</span></span></label>
                ) : (
                  <p className="rounded-xl bg-ink-50 p-3 text-xs text-ink-500">Fixed dishes have no preparation-notes field, so nobody can bypass the recipe. Delivery instructions stay separate.</p>
                )}
              </>
            )}
            {step === 'options' && (
              f.mode === 'FIXED' ? <p className="text-sm text-ink-500">Fixed dishes have no customer options. Customers choose quantity and an available time.</p> : (
                <div className="space-y-2 text-sm text-ink-700">
                  <p>Customers will adjust only what you enable here: portion size, protein choices, sauce and cheese levels, extra toppings, and extras from your approved ingredient list.</p>
                  <p className="rounded-xl bg-brand-50 p-3 text-brand-800">The option builder (templates such as Spice level, Choose protein, Extra toppings and Portion size, each with prices, limits and allergen effects) arrives in the next Chef Network update. Until then this dish sells as its standard recipe.</p>
                </div>
              )
            )}
            {step === 'availability' && (
              <>
                <div><span className="mb-1 block text-xs font-medium text-ink-500">Fulfillment format</span><RadioCards name="Fulfillment format" columns={2} value={f.fulfillmentFormat} onChange={(fulfillmentFormat) => set({ fulfillmentFormat })} options={(Object.keys(CHEF_FULFILLMENT_FORMATS) as (keyof typeof CHEF_FULFILLMENT_FORMATS)[]).map((k) => ({ value: k, label: CHEF_FULFILLMENT_FORMATS[k] }))} /></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Preparation time (minutes)" type="number" min={5} value={f.prepMinutes} onChange={(e) => set({ prepMinutes: Number(e.target.value) })} />
                  <Input label={`Max per cooking day (default ${op.dailyCapacity ?? '—'})`} type="number" min={1} value={f.dailyCapacity ?? ''} onChange={(e) => set({ dailyCapacity: e.target.value ? Number(e.target.value) : null })} />
                  <Select label={`Minimum notice (default ${op.minLeadDays ?? 1} day)`} value={f.minLeadDays ?? ''} onChange={(e) => set({ minLeadDays: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Use my default</option>{[0, 1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d === 0 ? 'Same day' : `${d} day${d > 1 ? 's' : ''}`}</option>)}</Select>
                  <Select label={`Order up to (default ${op.maxAdvanceDays ?? 30} days)`} value={f.maxAdvanceDays ?? ''} onChange={(e) => set({ maxAdvanceDays: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Use my default</option>{[7, 14, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} days ahead</option>)}</Select>
                  <Select label={`Cutoff the day before (default ${op.cutoffHour ?? 12}:00)`} value={f.cutoffHour ?? ''} onChange={(e) => set({ cutoffHour: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Use my default</option>{[8, 10, 12, 14, 16, 18, 20].map((h) => <option key={h} value={h}>{h}:00</option>)}</Select>
                </div>
                <p className="text-xs text-ink-500">Example: a holiday pie with 3 days’ notice and a noon cutoff can be ordered two weeks ahead; orders for that day close at noon the day before, or earlier once your daily maximum is reached.</p>
              </>
            )}
            {step === 'preview' && (
              <div className="space-y-3">
                {missing.length ? <Alert tone="info">Still needed: {missing.join(' · ')}</Alert> : <Alert tone="good">Everything Gutad needs to review is here.</Alert>}
                {(dish.reviewStatus === 'DRAFT' || dish.reviewStatus === 'CHANGES_REQUESTED') && <Button size="lg" disabled={busy || missing.length > 0} onClick={submit}>Submit for Gutad review</Button>}
                {dish.reviewStatus === 'PUBLISHED' && <p className="text-sm text-ink-500">This dish is live. Use “Save changes” after editing.</p>}
                <p className="text-xs text-ink-500">Gutad checks ingredient and allergen completeness, portion accuracy, photographs and pricing. Routine orders never need approval.</p>
              </div>
            )}
          </fieldset>
          <div className="mt-6 flex justify-between border-t border-ink-100 pt-4">
            <Button variant="secondary" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1].key)}>Back</Button>
            {idx < STEPS.length - 1 && <Button onClick={() => setStep(STEPS[idx + 1].key)}>Continue</Button>}
          </div>
        </Card>
        <div className="lg:sticky lg:top-20 lg:self-start">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Customer preview</p>
          <Preview f={f} chef={chef} />
        </div>
      </div>
    </div>
  );
}

function Preview({ f, chef }: { f: Dish; chef: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card">
      <div className="aspect-[4/3] bg-ink-100">{f.photos[0] && <img src={f.photos[0]} alt="" className="h-full w-full object-cover" />}</div>
      <div className="space-y-2 p-4">
        <div className="text-base font-semibold leading-snug">{chefDishTitle(f.dishName || 'Your dish', chef)}</div>
        <p className="text-xs text-ink-500">Prepared by {chef} at an approved partner kitchen.</p>
        <div className="flex flex-wrap gap-1"><Badge>{CHEF_FULFILLMENT_FORMATS[f.fulfillmentFormat]}</Badge><Badge tone={f.mode === 'CUSTOMIZABLE' ? 'info' : 'neutral'}>{f.mode === 'CUSTOMIZABLE' ? 'Customizable' : 'Fixed recipe'}</Badge>{f.dietaryTags.map((t) => <Badge key={t} tone="good">{t.replace('_', ' ')}</Badge>)}</div>
        {f.description && <p className="text-sm text-ink-700">{f.description}</p>}
        <p className="text-xs text-ink-500">{f.portionDesc || 'Portion'} · {f.ingredients.length ? f.ingredients.join(', ') : 'ingredients'}</p>
        <p className="text-xs"><strong>Allergens:</strong> {f.allergens.length ? f.allergens.join(', ') : f.allergensConfirmed ? 'none declared' : '—'}</p>
        <div className="flex items-center justify-between pt-2"><span className="text-lg font-bold">{money(f.priceCents || 0)}</span><span className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white">{f.mode === 'CUSTOMIZABLE' ? 'Customize & order' : 'Add to cart'}</span></div>
      </div>
    </div>
  );
}

function TagInput({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const [t, setT] = useState('');
  const add = () => { const v = t.trim(); if (v && !values.includes(v)) onChange([...values, v]); setT(''); };
  return (
    <div>
      <Input label={label} value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} />
      <div className="mt-2 flex flex-wrap gap-1.5">{values.map((v) => <span key={v} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-0.5 text-xs">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="text-ink-500 hover:text-ink-900">×</button></span>)}</div>
    </div>
  );
}

function Photos({ photos, onChange }: { photos: string[]; onChange: (p: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-ink-500">Photos (first one is the cover)</span>
      <div className="mb-2 flex flex-wrap gap-2">{photos.map((u, i) => <div key={u} className="relative"><img src={u} alt="" className="h-20 w-20 rounded-lg object-cover" />{i === 0 && <span className="absolute bottom-1 left-1 rounded bg-ink-900/70 px-1 text-[10px] text-white">Cover</span>}<button type="button" aria-label="Remove photo" onClick={() => onChange(photos.filter((x) => x !== u))} className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-xs text-white">×</button>{i > 0 && <button type="button" aria-label="Make cover" onClick={() => onChange([u, ...photos.filter((x) => x !== u)])} className="absolute bottom-1 right-1 rounded bg-white/90 px-1 text-[10px]">★</button>}</div>)}</div>
      {photos.length < 8 && <FileDrop accept="image/jpeg,image/png,image/webp" label="Add a dish photo" hint="Natural light, the real portion, no stock images" busy={busy} onFile={async (file) => {
        setBusy(true); setErr(null);
        try { const fd = new FormData(); fd.append('file', file); const r = await uploadFile<{ url: string }>('/chef/photos', fd); onChange([...photos, `${API_URL}${r.url}`]); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />}
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
