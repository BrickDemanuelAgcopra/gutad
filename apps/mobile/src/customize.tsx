import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { evaluateCustomization, type CustomizationResult, type ModGroup, type ModOption } from '@gutad/shared';
import { api, money } from './api';
import { useSession } from './hooks';
import { Button, C, s } from './ui';

export type Picks = Record<string, number>;
export const picksToIds = (p: Picks) => Object.entries(p).flatMap(([id, n]) => Array(Math.max(0, n)).fill(id) as string[]);

/** Same engine as the web and the API: price, defaults, conditional groups and allergen effects update instantly. */
export function useCustomization(name: string, groups: ModGroup[], base: { allergens: string[]; dietaryTags: string[] }) {
  const [picks, setRaw] = useState<Picks>({});
  const ev = useMemo(() => evaluateCustomization(name, groups, picksToIds(picks), base), [name, groups, picks, base]);
  const setPicks = (next: Picks) => {
    const p = { ...next };
    const chosen = new Set(evaluateCustomization(name, groups, picksToIds(p), base).chosen.map((c) => c.id));
    for (const g of groups) if (g.parentOptionId && !chosen.has(g.parentOptionId)) for (const o of g.options) delete p[o.id];
    setRaw(p);
  };
  return { picks, setPicks, ev };
}

const plus = (c: number) => (c ? ` +${money(c)}` : '');

function Stepper({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.ink1, borderRadius: 999 }} accessibilityLabel={label}>
      <Pressable accessibilityLabel={`Decrease ${label}`} disabled={value <= 0} onPress={() => onChange(value - 1)} style={{ paddingHorizontal: 12, paddingVertical: 6, opacity: value <= 0 ? 0.3 : 1 }}><Text style={{ fontSize: 18 }}>−</Text></Pressable>
      <Text style={{ minWidth: 20, textAlign: 'center', fontWeight: '700' }}>{value}</Text>
      <Pressable accessibilityLabel={`Increase ${label}`} disabled={value >= max} onPress={() => onChange(value + 1)} style={{ paddingHorizontal: 12, paddingVertical: 6, opacity: value >= max ? 0.3 : 1 }}><Text style={{ fontSize: 18, color: C.brand }}>+</Text></Pressable>
    </View>
  );
}

export function Customizer({ groups, picks, setPicks, ev, chefName, acceptsRequests, onAsk, dishId }: { groups: ModGroup[]; picks: Picks; setPicks: (p: Picks) => void; ev: CustomizationResult; chefName: string; acceptsRequests?: boolean; /** opens a special request for an ingredient the dish doesn't offer */ onAsk?: (ingredient: string) => void; /** shows “Describe what you want” (CN.3) */ dishId?: string }) {
  const active = new Set(ev.activeGroupIds);
  const qtyOf = (id: string) => ev.chosen.find((c) => c.id === id)?.qty || 0;
  const single = (g: ModGroup, id: string) => { const n = { ...picks }; for (const o of g.options) delete n[o.id]; n[id] = 1; setPicks(n); };
  const ruleMax = (o: ModOption) => { let m = o.maxQty ?? 10; for (const [w, r] of Object.entries(o.rules || {})) if (qtyOf(w) && r.maxQty !== undefined) m = r.maxQty; return m; };
  const [q, setQ] = useState('');
  const extras = groups.find((g) => g.isExtras);
  const term = q.trim().toLowerCase();
  const hits = term && extras ? extras.options.filter((o) => o.name.toLowerCase().includes(term) || (o.searchTerms || []).some((x) => x.includes(term) || term.includes(x))) : [];
  const shownExtras = extras ? Array.from(new Set([...extras.options.filter((o) => picks[o.id]), ...hits])) : [];
  return (
    <View>
      {dishId && groups.some((g) => (g.selectionType || 'CHOICE') !== 'INCLUDED') && <DescribeIt dishId={dishId} setPicks={setPicks} chefName={chefName} onAsk={acceptsRequests ? onAsk : undefined} />}
      {groups.filter((g) => !g.isExtras && (!g.parentOptionId || active.has(g.id))).map((g) => {
        const t = g.selectionType || 'CHOICE';
        return (
          <View key={g.id} style={{ marginBottom: 14 }}>
            <View style={s.row}><Text style={{ fontWeight: '700', fontSize: 15 }}>{g.name}</Text><Text style={{ color: C.ink5, fontSize: 12 }}>{t === 'INCLUDED' ? 'Not adjustable' : g.required ? 'Required' : 'Optional'}</Text></View>
            {g.description && <Text style={{ color: C.ink5, fontSize: 12 }}>{g.description}</Text>}
            <View style={{ flexDirection: t === 'LEVEL' ? 'row' : 'column', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {g.options.map((o) => {
                if (t === 'INCLUDED') return <Text key={o.id} style={{ color: C.ink7 }}>🔒 {o.name} · included</Text>;
                const n = qtyOf(o.id);
                if (t === 'QUANTITY') return <View key={o.id} style={[s.row, { paddingVertical: 4 }]}><View style={{ flex: 1 }}><Text style={{ fontWeight: '600' }}>{o.name}</Text><Text style={{ color: C.ink5, fontSize: 12 }}>{[o.portionDesc, o.priceCents ? `${money(o.priceCents)} each` : 'free', o.addsAllergens?.length ? `contains ${o.addsAllergens.join(', ')}` : '', o.soldOut ? 'sold out' : ''].filter(Boolean).join(' · ')}</Text></View><Stepper label={o.name} value={picks[o.id] || 0} max={o.soldOut ? 0 : ruleMax(o)} onChange={(v) => setPicks({ ...picks, [o.id]: v })} /></View>;
                const on = n > 0;
                const press = () => (t === 'MULTI' || (t === 'CHOICE' && g.maxSelect > 1) ? setPicks({ ...picks, [o.id]: on ? 0 : 1 }) : on && !g.required ? setPicks({ ...picks, [o.id]: 0 }) : single(g, o.id));
                return (
                  <Pressable key={o.id} disabled={o.soldOut} accessibilityRole={t === 'MULTI' ? 'checkbox' : 'radio'} accessibilityState={{ checked: on, disabled: o.soldOut }} onPress={press} style={{ paddingHorizontal: 12, paddingVertical: t === 'LEVEL' ? 6 : 10, borderRadius: t === 'LEVEL' ? 999 : 12, borderWidth: 1, borderColor: on ? C.brand : C.ink1, backgroundColor: on ? '#fff4ec' : C.white, opacity: o.soldOut ? 0.4 : 1 }}>
                    <Text style={{ fontWeight: on ? '700' : '500', color: C.ink }}>{t === 'MULTI' ? (on ? '☑ ' : '☐ ') : ''}{o.name}<Text style={{ color: C.ink5, fontWeight: '400' }}>{plus(o.priceCents)}{o.soldOut ? ' · sold out' : ''}</Text></Text>
                    {t !== 'LEVEL' && (o.portionDesc || o.addsAllergens?.length) ? <Text style={{ color: C.ink5, fontSize: 11 }}>{[o.portionDesc, o.addsAllergens?.length ? `contains ${o.addsAllergens.join(', ')}` : ''].filter(Boolean).join(' · ')}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
      {(extras || acceptsRequests) && (
        <View style={{ marginBottom: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 15 }}>Add an ingredient</Text>
          <TextInput placeholder="Search, e.g. burrata or chili" placeholderTextColor={C.ink3} value={q} onChangeText={setQ} style={[s.input, { marginTop: 6 }]} accessibilityLabel="Search extras" />
          {shownExtras.map((o) => <View key={o.id} style={[s.row, { paddingVertical: 6 }]}><View style={{ flex: 1 }}><Text style={{ fontWeight: '600' }}>{o.name}</Text><Text style={{ color: C.ink5, fontSize: 12 }}>{[o.portionDesc, o.priceCents ? `${money(o.priceCents)} each` : 'free', o.addsAllergens?.length ? `contains ${o.addsAllergens.join(', ')}` : ''].filter(Boolean).join(' · ')}</Text></View><Stepper label={o.name} value={picks[o.id] || 0} max={o.soldOut ? 0 : o.maxQty ?? 2} onChange={(v) => setPicks({ ...picks, [o.id]: v })} /></View>)}
          {!!term && !hits.length && (acceptsRequests && onAsk
            ? <Pressable accessibilityRole="button" accessibilityLabel={`Ask ${chefName} to add ${q.trim()}`} onPress={() => onAsk(q.trim())} style={({ pressed }) => ({ marginTop: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.brand, backgroundColor: pressed ? '#fff4ec' : C.white })}><Text style={{ fontWeight: '600', color: C.brand }}>Ask {chefName} to add {q.trim()} ›</Text><Text style={{ color: C.ink5, fontSize: 12 }}>The chef confirms the price and date. Nothing is charged until you accept their quote.</Text></Pressable>
            : <View style={{ marginTop: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.ink3 }}><Text style={{ fontWeight: '600' }}>{q.trim()} isn’t offered on this dish</Text><Text style={{ color: C.ink5, fontSize: 12 }}>{acceptsRequests ? 'Price and availability need the chef’s confirmation.' : `${chefName} doesn’t take special requests for this dish.`}</Text></View>)}
        </View>
      )}
    </View>
  );
}

export function Summary({ base, ev, qty, baseAllergens }: { base: number; ev: CustomizationResult; qty: number; baseAllergens: string[] }) {
  const added = ev.allergens.filter((a) => !baseAllergens.includes(a));
  return (
    <View>
      {added.length > 0 && <Text style={{ color: C.bad, fontSize: 12 }}>Your choices add: {added.join(', ')}</Text>}
      {ev.removedDietaryTags.length > 0 && <Text style={{ color: C.warn, fontSize: 12 }}>No longer {ev.removedDietaryTags.map((t) => t.replace('_', ' ')).join(', ')}</Text>}
      {!ev.ok && <Text style={{ color: C.bad, fontSize: 12 }}>{ev.errors[0]}</Text>}
      <Text style={{ fontWeight: '700', marginTop: 4 }}>{qty > 1 ? `${qty} × ${money(base + ev.modifiersCents)} = ` : ''}{money((base + ev.modifiersCents) * qty)}</Text>
    </View>
  );
}

interface Interpretation { source: 'ai' | 'rules'; optionIds: string[]; unmatched: string[]; note: string; ok: boolean; errors: string[] }

/** CN.3: describe the dish in your words; Gutad fills in the matching options to review. */
function DescribeIt({ dishId, setPicks, chefName, onAsk }: { dishId: string; setPicks: (p: Picks) => void; chefName: string; onAsk?: (term: string) => void }) {
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
    <View style={{ marginBottom: 14, padding: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.ink3 }}>
      <Text style={{ fontWeight: '700', color: C.ink }}>Describe what you want</Text>
      <Text style={{ color: C.ink5, fontSize: 12 }}>e.g. “large, extra spicy, no onions”. We fill in the options for you to check.</Text>
      <TextInput accessibilityLabel="Describe what you want" value={text} onChangeText={setText} maxLength={500} placeholder="Your way, in your words" style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 10, padding: 8, marginVertical: 6, backgroundColor: C.white }} />
      <Button title={busy ? 'Filling in…' : user ? 'Fill in options' : 'Sign in to use this'} variant="secondary" disabled={busy || !user || text.trim().length < 2} onPress={() => void go()} />
      {!!err && <Text style={{ color: C.bad }}>{err}</Text>}
      {res && (
        <View accessibilityLiveRegion="polite">
          <Text style={{ color: C.ink7 }}>{res.note}</Text>
          {!res.ok && !!res.errors[0] && <Text style={{ color: C.warn }}>Still needed: {res.errors[0]}</Text>}
          {res.unmatched.length > 0 && <Text style={{ color: C.ink5, marginTop: 4 }}>Not on the options:</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {res.unmatched.map((u) => onAsk
              ? <Pressable key={u} accessibilityRole="button" onPress={() => onAsk(u)} style={{ borderWidth: 1, borderColor: C.brand, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}><Text style={{ color: C.brandDark, fontSize: 12 }}>Ask {chefName} for “{u}”</Text></Pressable>
              : <Text key={u} style={{ backgroundColor: C.ink1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, fontSize: 12 }}>{u}</Text>)}
          </View>
        </View>
      )}
    </View>
  );
}
