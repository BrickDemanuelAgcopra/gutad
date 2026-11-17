import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ChefAvailability, PublicChefDish } from '@gutad/shared';
import { api, money } from './api';
import { useAction, useApi } from './hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from './ui';
import { Customizer, Summary, useCustomization } from './customize';
import { DateSlotPicker, ymdLabel } from './date-slot-picker';
import type { RequestDetail } from './chef-requests';

interface AltDish { id: string; title: string; dishName: string; description: string | null; mode: string; priceCents: number; portionDesc: string | null; allergens: string[]; dietaryTags: string[]; chef: { id: string; slug: string; displayName: string; city: string | null }; sameCity: boolean; sameCuisine: boolean; requestedDay: { status: string; slots: string[] } | null; mentionedAllergens: string[] }
interface Alternatives { requestedDate: string; servings: number; reason: string; alternativesOk: boolean; dishes: AltDish[] }
const pretty = (x: string) => x.replace(/_/g, ' ');

/**
 * Gutad staff suggest another chef's dish on a special request: candidates (same city first, whether they can cook
 * it on the requested day, allergens the request mentions), then the dish's options and a quote at its listed price.
 */
export function StaffAlternative({ r, onDone }: { r: RequestDetail; onDone: (d: RequestDetail) => void }) {
  const { data, error } = useApi<Alternatives>(`/admin/chef-requests/${r.id}/alternatives`, { deps: [r.id] });
  const [pick, setPick] = useState<AltDish | null>(null);
  if (error) return <ErrorText msg={error} />;
  if (!data) return <Loading />;
  if (pick) return <AltForm r={r} alt={pick} onBack={() => setPick(null)} onDone={onDone} />;
  return (
    <View>
      <Muted>For {data.servings} serving{data.servings === 1 ? '' : 's'} on {ymdLabel(data.requestedDate)}. The customer sees it as an alternative from the other chef, at that chef’s listed price.</Muted>
      {r.reason === 'ALLERGY' && <Text style={{ color: C.bad, marginTop: 4 }}>The customer mentioned an allergy. Check the dish’s allergens with its chef first.</Text>}
      {!data.dishes.length && <Muted>No other chef has a live dish right now.</Muted>}
      {data.dishes.map((x) => {
        const ok = x.requestedDay?.status === 'AVAILABLE';
        return (
          <View key={x.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.ink1 }}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.ink, fontWeight: '600' }}>{x.title}</Text>
                <Muted>{money(x.priceCents)} per serving{x.chef.city ? ` · ${x.chef.city}` : ''}{x.sameCuisine ? ' · same cuisine' : ''}</Muted>
              </View>
              <Button title="Choose" variant="secondary" onPress={() => setPick(x)} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              <Badge tone={ok ? 'good' : 'warn'} text={ok ? `Open ${ymdLabel(data.requestedDate)}` : `${ymdLabel(data.requestedDate)}: ${pretty((x.requestedDay?.status || 'unavailable').toLowerCase())}`} />
              {!x.sameCity && <Badge tone="warn" text="Other city" />}
              {x.allergens.map((a) => <Badge key={a} tone={x.mentionedAllergens.includes(a) ? 'bad' : 'neutral'} text={pretty(a)} />)}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function AltForm({ r, alt, onBack, onDone }: { r: RequestDetail; alt: AltDish; onBack: () => void; onDone: (d: RequestDetail) => void }) {
  const { run, busy, error } = useAction();
  const { data: pub } = useApi<PublicChefDish>(`/public/chef-dishes/${alt.id}`, { deps: [alt.id] });
  const groups = useMemo(() => pub?.groups || [], [pub]);
  const base = useMemo(() => ({ allergens: alt.allergens, dietaryTags: alt.dietaryTags }), [alt]);
  const { picks, setPicks, ev } = useCustomization(alt.dishName, groups, base);
  const customizable = groups.some((g) => g.selectionType !== 'INCLUDED');
  const [changes, setChanges] = useState(`${alt.title} instead of ${r.dish.title}.`);
  const [qty, setQty] = useState(r.servings);
  const [slot, setSlot] = useState<{ date: string; time: string } | null>({ date: r.requestedDate, time: r.requestedTime || '' });
  const [note, setNote] = useState('');
  const { data: avail, loading } = useApi<ChefAvailability>(`/public/chef-dishes/${alt.id}/availability?quantity=${qty}`, { deps: [alt.id, qty] });
  const unit = alt.priceCents + ev.modifiersCents;
  const send = () => run(async () => {
    const d = await api.post<RequestDetail>(`/admin/chef-requests/${r.id}/quote`, { kind: 'ALTERNATIVE', altDishId: alt.id, optionIds: ev.optionIds, changes, portionDesc: alt.portionDesc, unitPriceCents: unit, quantity: qty, allergens: ev.allergens, dietaryTags: ev.dietaryTags, serviceDate: slot!.date, serviceTime: slot!.time || null, note: note || null, validHours: 48 });
    onDone(d);
  });
  return (
    <View>
      <Button title="← Other dishes" variant="ghost" onPress={onBack} />
      <Text style={{ color: C.ink, fontWeight: '700' }}>{alt.title}</Text>
      <Muted>Prepared by {alt.chef.displayName}{alt.chef.city ? ` (${alt.chef.city})` : ''}.</Muted>
      {customizable && <Customizer groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName={alt.chef.displayName} />}
      <Input label="What the customer gets (they see this)" value={changes} onChangeText={setChanges} multiline maxLength={1000} />
      <View style={[s.row, { marginVertical: 6 }]}>
        <Text>Servings</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Button title="−" variant="secondary" disabled={qty <= 1} onPress={() => setQty(qty - 1)} />
          <Text accessibilityLabel="Servings" style={{ minWidth: 18, textAlign: 'center' }}>{qty}</Text>
          <Button title="+" variant="secondary" disabled={qty >= 50} onPress={() => setQty(qty + 1)} />
        </View>
      </View>
      <Summary base={alt.priceCents} ev={ev} qty={qty} baseAllergens={alt.allergens} />
      <Muted>The chef’s listed price for these options. Allergens sent: {ev.allergens.length ? ev.allergens.map(pretty).join(', ') : 'none listed'}.</Muted>
      {alt.mentionedAllergens.length > 0 && <Text style={{ color: C.bad }}>The request mentions {alt.mentionedAllergens.map(pretty).join(', ')}, which this dish contains.</Text>}
      <Card title="Cooking day"><DateSlotPicker availability={avail} loading={loading} value={slot} onChange={setSlot} /></Card>
      <Input label="Note to the customer (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
      <ErrorText msg={error} />
      <Button title={busy ? 'Sending…' : `Send to the customer — ${money(unit * qty)}`} disabled={busy || !ev.ok || !slot?.date || changes.trim().length < 3} onPress={() => void send()} />
    </View>
  );
}
