import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ALLERGENS, DIETARY_TAGS, type ChefAvailability, type ChefDishStatus, type PublicChefDish } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { DateSlotPicker } from '@/date-slot-picker';
import { QuoteCard, RequestCard, TextAction, Thread, type RequestDetail } from '@/chef-requests';

type Mode = 'quote' | 'alt' | 'ask' | 'decline' | null;
interface Menu { sections: { id: string; name: string; dishes: { id: string; title: string; priceCents: number; reviewStatus: ChefDishStatus }[] }[] }

/** A special request from the chef's side: read it, then quote, suggest an alternative, ask a question or decline. */
export default function ChefRequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: r, setData, error } = useApi<RequestDetail>(`/chef-requests/${id}`, { poll: 30000 });
  const { run, busy, error: actErr } = useAction();
  const [mode, setMode] = useState<Mode>(null);
  if (!r) return error ? <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View> : <Loading />;
  const done = (d: RequestDetail) => { setData(d); setMode(null); return d; };
  const post = (path: string, body: unknown) => run(async () => done(await api.post<RequestDetail>(`/chef/requests/${r.id}/${path}`, body)));
  const pick = (m: Mode) => setMode(mode === m ? null : m);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <RequestCard r={r} />
      {(r.can.quote || r.can.ask || r.can.decline) && (
        <Card title="Reply">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {r.can.quote && <Button title={r.quotes.length ? 'Send a new quote' : 'Accept & quote'} variant={mode === 'quote' ? 'primary' : 'secondary'} onPress={() => pick('quote')} />}
            {r.can.quote && r.alternativesOk && <Button title="Suggest alternative" variant={mode === 'alt' ? 'primary' : 'secondary'} onPress={() => pick('alt')} />}
            {r.can.ask && <Button title="Ask a question" variant={mode === 'ask' ? 'primary' : 'secondary'} onPress={() => pick('ask')} />}
            {r.can.decline && <Button title="Decline" variant={mode === 'decline' ? 'danger' : 'secondary'} onPress={() => pick('decline')} />}
          </View>
          {!r.alternativesOk && r.can.quote && <Muted>The customer asked for no alternatives.</Muted>}
        </Card>
      )}
      <ErrorText msg={actErr} />
      {(mode === 'quote' || mode === 'alt') && <QuoteForm key={mode} r={r} kind={mode === 'alt' ? 'ALTERNATIVE' : 'QUOTE'} busy={busy} onSend={(body) => post('quote', body)} />}
      {mode === 'ask' && <Card title="Ask a question"><Muted>The customer is notified and has time to answer before the request closes.</Muted><TextAction placeholder="e.g. Is a little butter OK, or should it be fully dairy-free?" button="Send question" busy={busy} onSend={(body) => post('question', { body })} /></Card>}
      {mode === 'decline' && <Card title="Decline"><Muted>Tell the customer why. They aren’t charged.</Muted><TextAction placeholder="e.g. I can’t keep shellfish separate in my kitchen" button="Decline request" variant="danger" min={3} busy={busy} onSend={(reason) => post('decline', { reason })} /></Card>}
      {r.quotes.map((q) => <QuoteCard key={q.id} q={q} />)}
      <Thread messages={r.messages} />
      {r.can.message && <Card title="Message the customer"><TextAction placeholder="Write a message" button="Send" busy={busy} onSend={(body) => run(async () => done(await api.post<RequestDetail>(`/chef-requests/${r.id}/messages`, { body })))} /></Card>}
    </ScrollView>
  );
}

function Chips({ all, on, onToggle }: { all: string[]; on: string[]; onToggle: (v: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {all.map((a) => { const sel = on.includes(a); return <Pressable key={a} accessibilityRole="checkbox" accessibilityState={{ checked: sel }} onPress={() => onToggle(a)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: sel ? C.brand : C.ink1, backgroundColor: sel ? '#fff4ec' : C.white }}><Text style={{ color: sel ? C.ink : C.ink5, fontWeight: sel ? '700' : '500', fontSize: 13 }}>{sel ? '✓ ' : ''}{a.replace('_', ' ')}</Text></Pressable>; })}
    </View>
  );
}

/** Accept & quote (same dish) or suggest an alternative (another of the chef's live dishes). */
function QuoteForm({ r, kind, busy, onSend }: { r: RequestDetail; kind: 'QUOTE' | 'ALTERNATIVE'; busy: boolean; onSend: (body: unknown) => Promise<unknown> }) {
  const alt = kind === 'ALTERNATIVE';
  const { data: menu } = useApi<Menu>(alt ? '/chef/menu' : null);
  const altDishes = (menu?.sections || []).flatMap((x) => x.dishes).filter((x) => x.reviewStatus === 'PUBLISHED' && x.id !== r.dish.id);
  const [altId, setAltId] = useState<string | null>(null);
  const dishId = alt ? altId : r.dish.id;
  const last = r.quotes.find((q) => q.dish.id === dishId) || null;
  const { data: pub } = useApi<PublicChefDish>(dishId ? `/public/chef-dishes/${dishId}` : null, { deps: [dishId] });
  const [changes, setChanges] = useState(last?.changes || (r.ingredient && r.requestType === 'ADD' ? `Add ${r.ingredient}` : ''));
  const [portion, setPortion] = useState(last?.portionDesc || '');
  const [price, setPrice] = useState(last ? (last.unitPriceCents / 100).toFixed(2) : alt ? '' : (r.dish.priceCents / 100).toFixed(2));
  const [qty, setQty] = useState(last?.quantity || r.servings);
  const [allergens, setAllergens] = useState<string[]>(last?.allergens || []);
  const [dietary, setDietary] = useState<string[]>(last?.dietaryTags || []);
  const [extra, setExtra] = useState('');
  // prefill from the dish sold when there's no earlier quote for it
  useEffect(() => {
    if (!pub || last) return;
    setAllergens(pub.allergens);
    setDietary(pub.dietaryTags);
    if (alt) { setPrice((pub.priceCents / 100).toFixed(2)); setPortion(pub.portionDesc); }
  }, [pub?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: avail, loading: availLoading } = useApi<ChefAvailability>(dishId ? `/public/chef-dishes/${dishId}/availability?quantity=${qty}` : null, { deps: [dishId, qty] });
  const [sched, setSched] = useState<{ date: string; time: string } | null>(null);
  useEffect(() => {
    if (!avail) return;
    const cur = sched ? avail.days.find((x) => x.date === sched.date && x.status === 'AVAILABLE') : undefined;
    if (cur) return;
    const wantDate = last?.serviceDate || r.requestedDate, wantTime = last ? last.serviceTime : r.requestedTime;
    const want = avail.days.find((x) => x.date === wantDate && x.status === 'AVAILABLE');
    setSched(want ? { date: want.date, time: wantTime && want.slots.includes(wantTime) ? wantTime : '' } : avail.earliestDate ? { date: avail.earliestDate, time: '' } : null);
  }, [avail]); // eslint-disable-line react-hooks/exhaustive-deps
  const [valid, setValid] = useState('48');
  const [note, setNote] = useState(last?.note || '');
  const cents = Math.round(Number(price.replace(/[^0-9.]/g, '')) * 100);
  const hours = Math.round(Number(valid));
  const priceOk = price.trim() !== '' && Number.isFinite(cents) && cents >= 0 && cents <= 100_000;
  const ok = !!dishId && changes.trim().length >= 3 && priceOk && !!sched?.date && hours >= 1 && hours <= 168;
  const toggle = (list: string[], set: (v: string[]) => void) => (v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = () => onSend({ kind, altDishId: alt ? altId : undefined, changes: changes.trim(), portionDesc: portion.trim() || null, unitPriceCents: cents, quantity: qty, allergens, dietaryTags: dietary, serviceDate: sched!.date, serviceTime: sched!.time || null, note: note.trim() || null, validHours: hours });
  return (
    <Card title={alt ? 'Suggest an alternative' : 'Accept & quote'}>
      {alt && (
        <>
          <Text style={s.label}>Your dish to suggest</Text>
          {!menu ? <Loading /> : !altDishes.length ? <Muted>You have no other live dishes.</Muted> : altDishes.map((x) => (
            <Pressable key={x.id} accessibilityRole="radio" accessibilityState={{ checked: altId === x.id }} onPress={() => setAltId(x.id)} style={{ padding: 10, marginBottom: 6, borderRadius: 12, borderWidth: 1, borderColor: altId === x.id ? C.brand : C.ink1, backgroundColor: altId === x.id ? '#fff4ec' : C.white }}>
              <Text style={{ fontWeight: altId === x.id ? '700' : '500', color: C.ink }}>{x.title}</Text><Muted>{money(x.priceCents)}</Muted>
            </Pressable>
          ))}
        </>
      )}
      <Input label="Exactly what you’ll make" multiline placeholder="e.g. Add 6 grilled shrimp on top" value={changes} onChangeText={setChanges} style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]} />
      <Input label="Portion (optional)" placeholder={pub?.portionDesc || 'e.g. 450 g bowl'} value={portion} onChangeText={setPortion} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Input label="Price per serving ($)" keyboardType="decimal-pad" value={price} onChangeText={setPrice} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>Servings</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Button title="−" variant="secondary" disabled={qty <= 1} onPress={() => setQty(qty - 1)} />
            <Text accessibilityLabel={`Servings ${qty}`} style={{ minWidth: 24, textAlign: 'center', fontWeight: '700' }}>{qty}</Text>
            <Button title="+" variant="secondary" disabled={qty >= 50} onPress={() => setQty(qty + 1)} />
          </View>
        </View>
      </View>
      {priceOk && <Text style={{ fontWeight: '700', marginBottom: 6 }}>Customer pays {money(cents * qty)} for the food{r.budgetCents !== null ? ` · budget ${money(r.budgetCents)}` : ''}</Text>}
      {qty !== r.servings && <Text style={{ color: C.warn, fontSize: 12 }}>The customer asked for {r.servings}.</Text>}
      <Text style={s.label}>Allergens in what you’ll make</Text>
      <Chips all={[...new Set([...ALLERGENS, ...allergens])]} on={allergens} onToggle={toggle(allergens, setAllergens)} />
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <View style={{ flex: 1 }}><Input placeholder="Other allergen" value={extra} onChangeText={setExtra} /></View>
        <Button title="Add" variant="secondary" disabled={!extra.trim()} onPress={() => { const v = extra.trim().toLowerCase(); if (!allergens.includes(v)) setAllergens([...allergens, v]); setExtra(''); }} />
      </View>
      {r.reason === 'ALLERGY' && <Text style={{ color: C.bad, fontSize: 12, marginBottom: 6 }}>The customer has an allergy. List every allergen honestly.</Text>}
      <Text style={s.label}>Dietary tags</Text>
      <Chips all={[...new Set([...DIETARY_TAGS, ...dietary])]} on={dietary} onToggle={toggle(dietary, setDietary)} />
      <Text style={s.label}>Cooking day (time optional)</Text>
      {dishId ? <DateSlotPicker availability={avail} loading={availLoading} value={sched} onChange={(v) => setSched(v.time && v.time === sched?.time && v.date === sched?.date ? { date: v.date, time: '' } : v)} /> : <Muted>Pick a dish first.</Muted>}
      {sched && sched.date !== r.requestedDate && <Text style={{ color: C.warn, fontSize: 12, marginTop: 4 }}>The customer asked for {r.requestedDate}.</Text>}
      <View style={{ height: 8 }} />
      <Input label="Quote valid for (hours, 1–168)" keyboardType="number-pad" value={valid} onChangeText={setValid} />
      <Input label="Note to the customer (optional)" multiline value={note} onChangeText={setNote} />
      <Button title={busy ? 'Sending…' : alt ? 'Send alternative' : 'Send quote'} disabled={busy || !ok} onPress={() => void submit()} />
      <Muted>Sending replaces any earlier open quote. The customer pays this price at checkout.</Muted>
    </Card>
  );
}
