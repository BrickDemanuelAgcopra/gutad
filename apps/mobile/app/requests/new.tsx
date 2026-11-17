import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CHEF_REQUEST_REASONS, CHEF_REQUEST_TYPES, type ChefAvailability, type ChefRequestDetail, type ChefRequestReason, type ChefRequestType, type PublicChefDish } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';
import { DateSlotPicker } from '@/date-slot-picker';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ask a chef for a change the dish's options don't cover. The chef replies with a quote; nothing is charged until it's accepted. */
export default function NewRequest() {
  const p = useLocalSearchParams<{ dishId: string; ingredient?: string; optionIds?: string }>();
  const router = useRouter();
  const { user, ready } = useSession();
  const ingredient = (p.ingredient || '').trim();
  const { data: d, error: dishErr } = useApi<PublicChefDish>(p.dishId ? `/public/chef-dishes/${p.dishId}` : null);
  const [type, setType] = useState<ChefRequestType>(ingredient ? 'ADD' : 'OTHER');
  const [details, setDetails] = useState(ingredient ? `Please add ${ingredient}.` : '');
  const [reason, setReason] = useState<ChefRequestReason>('PREFERENCE');
  const [servings, setServings] = useState(1);
  const { data: avail, loading: availLoading } = useApi<ChefAvailability>(p.dishId ? `/public/chef-dishes/${p.dishId}/availability?quantity=${servings}` : null, { deps: [servings] });
  const [when, setWhen] = useState<{ date: string; time: string } | null>(null);
  useEffect(() => {
    if (!avail) return;
    const day = when ? avail.days.find((x) => x.date === when.date) : undefined;
    if (!day || day.status !== 'AVAILABLE') setWhen(avail.earliestDate ? { date: avail.earliestDate, time: '' } : null);
  }, [avail]); // eslint-disable-line react-hooks/exhaustive-deps
  const [budget, setBudget] = useState('');
  const [altOk, setAltOk] = useState(true);
  const [altNote, setAltNote] = useState('');
  const { run, busy, error } = useAction();
  if (!ready) return null;
  if (!user) return <View style={[s.screen, s.pad]}><Card title="Request something special"><Muted>Sign in to send a request to the chef.</Muted><Button title="Sign in / create account" onPress={() => router.push('/login')} /></Card></View>;
  if (dishErr) return <View style={[s.screen, s.pad]}><Muted>This dish isn’t available right now.</Muted></View>;
  if (!d) return <Loading />;
  const budgetCents = budget.trim() ? Math.round(Number(budget.replace(/[^0-9.]/g, '')) * 100) : null;
  const budgetBad = budgetCents !== null && (!Number.isFinite(budgetCents) || budgetCents < 0);
  const ok = details.trim().length >= 5 && !!when?.date && !budgetBad;
  const submit = () => run(async () => {
    const baseOptionIds = (p.optionIds || '').split(',').filter((x) => UUID.test(x));
    const r = await api.post<ChefRequestDetail>('/chef-requests', { dishId: d.id, requestType: type, details: details.trim(), ingredient: ingredient || null, servings, requestedDate: when!.date, requestedTime: when!.time || null, reason, budgetCents, alternativesOk: altOk, alternativesNote: altOk && altNote.trim() ? altNote.trim() : null, baseOptionIds: baseOptionIds.length ? baseOptionIds : undefined });
    router.replace({ pathname: '/requests/[id]', params: { id: r.id } });
  });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>{d.title}</Text>
      <Muted>{d.chef.displayName} replies with a price and date. Nothing is charged until you accept.</Muted>
      <View style={{ height: 10 }} />
      <Card title="What would you like?">
        <Pills value={type} onChange={setType} options={(Object.keys(CHEF_REQUEST_TYPES) as ChefRequestType[]).map((k) => ({ id: k, label: CHEF_REQUEST_TYPES[k] }))} />
        <Input label="Details for the chef" multiline placeholder="e.g. Add grilled shrimp on top, about 6 pieces" value={details} onChangeText={setDetails} style={[s.input, { minHeight: 80, textAlignVertical: 'top' }]} />
        <Text style={s.label}>Why</Text>
        <Pills value={reason} onChange={setReason} options={(Object.keys(CHEF_REQUEST_REASONS) as ChefRequestReason[]).map((k) => ({ id: k, label: CHEF_REQUEST_REASONS[k] }))} />
        {reason === 'ALLERGY' && <Text style={{ color: C.bad, fontSize: 12 }}>Name the allergen in the details. Chefs cook in shared kitchens and confirm what they can do in their quote.</Text>}
      </Card>
      <Card title="Servings">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Button title="−" variant="secondary" disabled={servings <= 1} onPress={() => setServings(servings - 1)} />
          <Text accessibilityLabel={`Servings ${servings}`} style={{ minWidth: 28, textAlign: 'center', fontWeight: '700' }}>{servings}</Text>
          <Button title="+" variant="secondary" disabled={servings >= 50} onPress={() => setServings(servings + 1)} />
          <Muted>Usually {money(d.priceCents)} each</Muted>
        </View>
      </Card>
      <Card title="When">
        <Muted>Pick a day; a time is optional.</Muted>
        <View style={{ marginTop: 6 }}><DateSlotPicker availability={avail} loading={availLoading} value={when} onChange={(v) => setWhen(v.time && v.time === when?.time && v.date === when?.date ? { date: v.date, time: '' } : v)} /></View>
      </Card>
      <Card title="Budget & alternatives">
        <Input label="Budget per order (optional)" keyboardType="decimal-pad" placeholder="$" value={budget} onChangeText={setBudget} />
        {budgetBad && <ErrorText msg="Enter an amount like 45 or 45.50" />}
        <View style={[s.row, { marginVertical: 6 }]}><Text style={{ flex: 1, color: C.ink }}>The chef may suggest an alternative</Text><Switch value={altOk} onValueChange={setAltOk} /></View>
        {altOk && <Input label="Anything to keep in mind? (optional)" placeholder="e.g. Any seafood is fine" value={altNote} onChangeText={setAltNote} />}
      </Card>
      <ErrorText msg={error} />
      <Button title={busy ? 'Sending…' : 'Send request'} disabled={busy || !ok} onPress={() => void submit()} />
      {!ok && <Muted>Add a few words of detail and pick a day.</Muted>}
    </ScrollView>
  );
}
