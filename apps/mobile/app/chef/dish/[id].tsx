import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ALLERGENS, CHEF_DISH_STATUS_LABELS, CHEF_FULFILLMENT_FORMATS, CHEF_OPTION_TEMPLATES, chefDishMissing, chefDishTitle, DIETARY_TAGS, newOptionId, type ChefDishInput, type ChefDishStatus, type OptionsConfigGroup } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Chips, Choice, pickImage, Toggle, useAutosave } from '@/chef-ui';
import { uploadMultipart } from '@/upload';

type Dish = Required<Pick<ChefDishInput, 'dishName' | 'portionDesc' | 'ingredients' | 'allergens' | 'dietaryTags' | 'priceCents' | 'mode' | 'acceptsSpecialRequests' | 'fulfillmentFormat' | 'prepMinutes' | 'photos'>> & { id: string; title: string; description: string | null; allergensConfirmed: boolean; dailyCapacity: number | null; minLeadDays: number | null; reviewStatus: ChefDishStatus; reviewNote: string | null; pendingChanges: unknown; optionsConfig: OptionsConfigGroup[] };

/** Dish editor on the phone: same fields and rules as the web builder; drafts autosave, live dishes save explicitly. */
export default function DishEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: dish, setData } = useApi<Dish>(`/chef/dishes/${id}`);
  const { data: me } = useApi<{ profile: { displayName: string } }>('/chef/me');
  const [f, setF] = useState<Dish | null>(null);
  const [ing, setIng] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  const auto = useAutosave<Partial<Dish>>(async (patch) => setData(await api.patch<Dish>(`/chef/dishes/${id}`, patch)));
  useEffect(() => { if (dish && !f) setF(dish); }, [dish]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!dish || !f) return <Loading />;
  const live = dish.reviewStatus === 'PUBLISHED';
  const editable = ['DRAFT', 'CHANGES_REQUESTED', 'PUBLISHED'].includes(dish.reviewStatus);
  const set = (p: Partial<Dish>) => { const n = { ...f, ...p }; if (p.mode === 'FIXED') n.acceptsSpecialRequests = false; setF(n); if (!live && editable) auto.queue(p); };
  const missing = chefDishMissing(f as ChefDishInput);
  const chef = me?.profile.displayName || '';
  const addPhoto = (src: 'camera' | 'library') => run(async () => { const file = await pickImage(src); if (!file) return; const r = await uploadMultipart<{ id: string }>('/chef/photos', file, {}); const d = await api.patch<Dish>(`/chef/dishes/${id}`, { photos: [...f.photos, r.id] }); setData(d); setF({ ...f, photos: d.photos }); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>{chefDishTitle(f.dishName || 'New dish', chef)}</Text>
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}><Badge text={CHEF_DISH_STATUS_LABELS[dish.reviewStatus]} tone={live ? 'good' : 'info'} />{!!dish.pendingChanges && <Badge text="Changes in review" tone="info" />}</View>
        {dish.reviewNote && dish.reviewStatus === 'CHANGES_REQUESTED' && <Text style={{ color: C.warn, marginTop: 6 }}>Reviewer: {dish.reviewNote}</Text>}
        {!live && <Muted>{auto.state === 'saving' ? 'Saving…' : auto.state === 'saved' ? '✓ Saved' : ''}</Muted>}
      </Card>
      <View pointerEvents={editable ? 'auto' : 'none'} style={{ opacity: editable ? 1 : 0.6 }}>
        <Card title="Describe">
          <Input label="Dish name" value={f.dishName} onChangeText={(t) => set({ dishName: t })} />
          <Input label="Price (USD)" keyboardType="decimal-pad" value={f.priceCents ? String(f.priceCents / 100) : ''} onChangeText={(t) => set({ priceCents: Math.round(Number(t) * 100) || 0 })} />
          <Input label="Portion" placeholder="1 bowl (450 g)" value={f.portionDesc} onChangeText={(t) => set({ portionDesc: t })} />
          <Input label="Description" multiline value={f.description || ''} onChangeText={(t) => set({ description: t })} style={[s.input, { minHeight: 70 }]} />
          <Text style={s.label}>Ingredients</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{f.ingredients.map((x) => <Pressable key={x} onPress={() => set({ ingredients: f.ingredients.filter((y) => y !== x) })} style={{ backgroundColor: C.ink1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><Text style={{ fontSize: 12 }}>{x} ×</Text></Pressable>)}</View>
          <Input placeholder="Add an ingredient and press return" value={ing} onChangeText={setIng} onSubmitEditing={() => { const v = ing.trim(); if (v && !f.ingredients.includes(v)) set({ ingredients: [...f.ingredients, v] }); setIng(''); }} returnKeyType="done" blurOnSubmit={false} />
          <Text style={s.label}>Allergens</Text>
          <Chips values={f.allergens} onChange={(a) => set({ allergens: a, allergensConfirmed: true })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} />
          <Toggle on={f.allergensConfirmed} onChange={(x) => set({ allergensConfirmed: x })} title={`Allergen list is complete${!f.allergens.length ? ' (none)' : ''}`} />
          <Text style={s.label}>Dietary labels</Text>
          <Chips values={f.dietaryTags} onChange={(t) => set({ dietaryTags: t })} options={DIETARY_TAGS.map((t) => ({ value: t, label: t.replace('_', ' ') }))} />
          <Text style={s.label}>Photos</Text>
          <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>{f.photos.map((u) => <Pressable key={u} onLongPress={() => set({ photos: f.photos.filter((x) => x !== u) })}><Image source={{ uri: u }} style={{ width: 72, height: 72, borderRadius: 8 }} /></Pressable>)}</ScrollView>
          <Muted>Long-press a photo to remove it.</Muted>
          <View style={{ flexDirection: 'row', gap: 6 }}>{Platform.OS !== 'web' && <Button style={{ flex: 1 }} variant="secondary" title="Take photo" onPress={() => addPhoto('camera')} />}<Button style={{ flex: 1 }} variant="secondary" title="Choose photo" onPress={() => addPhoto('library')} /></View>
        </Card>
        <Card title="Fixed or customizable">
          <Choice value={f.mode} onChange={(m) => set({ mode: m })} options={[{ value: 'FIXED', label: 'Fixed dish', description: 'Quantity and time only; no recipe changes' }, { value: 'CUSTOMIZABLE', label: 'Customizable dish', description: 'Customers adjust only options you enable' }]} />
          {f.mode === 'CUSTOMIZABLE' && <OptionsEditor value={f.optionsConfig} onChange={(optionsConfig) => set({ optionsConfig })} />}
          {f.mode === 'CUSTOMIZABLE' && <Toggle on={f.acceptsSpecialRequests} onChange={(x) => set({ acceptsSpecialRequests: x })} title="Accept special requests" text="You quote unlisted changes; nothing is ordered until the customer accepts your quote" />}
        </Card>
        <Card title="Availability">
          <Choice value={f.fulfillmentFormat} onChange={(x) => set({ fulfillmentFormat: x })} options={(Object.keys(CHEF_FULFILLMENT_FORMATS) as (keyof typeof CHEF_FULFILLMENT_FORMATS)[]).map((k) => ({ value: k, label: CHEF_FULFILLMENT_FORMATS[k] }))} />
          <Input label="Preparation time (minutes)" keyboardType="number-pad" value={String(f.prepMinutes || '')} onChangeText={(t) => set({ prepMinutes: Number(t) || 0 })} />
          <Input label="Max per cooking day (blank = your default)" keyboardType="number-pad" value={f.dailyCapacity ? String(f.dailyCapacity) : ''} onChangeText={(t) => set({ dailyCapacity: t ? Number(t) : null })} />
          <Input label="Minimum notice in days (blank = default)" keyboardType="number-pad" value={f.minLeadDays === null ? '' : String(f.minLeadDays)} onChangeText={(t) => set({ minLeadDays: t === '' ? null : Number(t) })} />
        </Card>
      </View>
      {msg && <Text style={{ color: C.good, marginBottom: 6 }}>{msg}</Text>}
      <ErrorText msg={error} />
      {!!missing.length && !live && <Muted>Still needed: {missing.join(' · ')}</Muted>}
      {live && <Button title="Save changes" disabled={busy} onPress={() => run(async () => { const r = await api.patch<Dish & { needsReview: boolean }>(`/chef/dishes/${id}`, { dishName: f.dishName, description: f.description, portionDesc: f.portionDesc, ingredients: f.ingredients, allergens: f.allergens, allergensConfirmed: f.allergensConfirmed, dietaryTags: f.dietaryTags, priceCents: f.priceCents, mode: f.mode, acceptsSpecialRequests: f.acceptsSpecialRequests, fulfillmentFormat: f.fulfillmentFormat, prepMinutes: f.prepMinutes, dailyCapacity: f.dailyCapacity, minLeadDays: f.minLeadDays, optionsConfig: f.optionsConfig }); setData(r); setMsg(r.needsReview ? 'Saved. Ingredient, allergen and photo changes go live after Gutad review.' : 'Saved — live now.'); })} />}
      {['DRAFT', 'CHANGES_REQUESTED'].includes(dish.reviewStatus) && <Button title={`Submit for review · ${money(f.priceCents)}`} disabled={busy || missing.length > 0} onPress={() => run(async () => { await auto.flush(); setData(await api.post<Dish>(`/chef/dishes/${id}/submit`, {})); })} />}
      <Button title="Archive dish" variant="ghost" onPress={() => run(async () => { await api.post(`/chef/dishes/${id}/archive`, {}); router.back(); })} />
    </ScrollView>
  );
}

/** Customer options on the phone: templates, names, prices, defaults and limits (conditions and rules on the web). */
function OptionsEditor({ value, onChange }: { value: OptionsConfigGroup[]; onChange: (v: OptionsConfigGroup[]) => void }) {
  const setG = (i: number, p: Partial<OptionsConfigGroup>) => onChange(value.map((g, j) => (j === i ? { ...g, ...p } : g)));
  const setO = (gi: number, oi: number, p: Partial<OptionsConfigGroup['options'][number]>) => setG(gi, { options: value[gi].options.map((o, j) => (j === oi ? { ...o, ...p } : o)) });
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={s.label}>Customer options</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{CHEF_OPTION_TEMPLATES.map((t) => <Pressable key={t.key} onPress={() => onChange([...value, t.build()])} style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}><Text style={{ fontSize: 12 }}>+ {t.label}</Text></Pressable>)}</View>
      {value.map((g, gi) => (
        <View key={g.id} style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 12, padding: 10, marginBottom: 8 }}>
          <View style={s.row}><View style={{ flex: 1 }}><Input value={g.name} onChangeText={(t) => setG(gi, { name: t })} /></View><Pressable onPress={() => onChange(value.filter((_, j) => j !== gi))} style={{ padding: 6 }}><Text style={{ color: C.bad }}>Remove</Text></Pressable></View>
          <Muted>{g.selectionType.toLowerCase()}{g.required ? ' · required' : ' · optional'}{g.parentOptionId ? ' · shown only after another choice' : ''}</Muted>
          {g.options.map((o, oi) => (
            <View key={o.id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 6 }}>
              <View style={{ flex: 2 }}><Input value={o.name} placeholder="Option" onChangeText={(t) => setO(gi, oi, { name: t })} /></View>
              {g.selectionType !== 'INCLUDED' && <View style={{ flex: 1 }}><Input keyboardType="decimal-pad" placeholder="+$" value={o.priceCents ? String(o.priceCents / 100) : ''} onChangeText={(t) => setO(gi, oi, { priceCents: Math.round(Number(t) * 100) || 0 })} /></View>}
              {(g.selectionType === 'SINGLE' || g.selectionType === 'LEVEL') && <Pressable accessibilityRole="radio" accessibilityState={{ checked: !!o.isDefault }} onPress={() => setG(gi, { options: g.options.map((x) => ({ ...x, isDefault: x.id === o.id })) })}><Text style={{ color: o.isDefault ? C.brand : C.ink5, fontSize: 12 }}>{o.isDefault ? '● default' : '○ default'}</Text></Pressable>}
              {g.selectionType === 'QUANTITY' && <View style={{ width: 54 }}><Input keyboardType="number-pad" placeholder="max" value={String(o.maxQty ?? 2)} onChangeText={(t) => setO(gi, oi, { maxQty: Number(t) || 1 })} /></View>}
              <Pressable onPress={() => setG(gi, { options: g.options.filter((_, j) => j !== oi) })} style={{ padding: 4 }}><Text style={{ color: C.bad }}>✕</Text></Pressable>
            </View>
          ))}
          <Pressable onPress={() => setG(gi, { options: [...g.options, { id: newOptionId(), name: '', priceCents: 0, ...(g.selectionType === 'INCLUDED' ? { locked: true } : {}) }] })}><Text style={{ color: C.brand, marginTop: 6 }}>+ Add option</Text></Pressable>
        </View>
      ))}
    </View>
  );
}
