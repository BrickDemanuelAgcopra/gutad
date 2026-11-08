import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, money, when } from '@/api';
import { ConfirmHold } from '@/hold';
import { useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';

export default function Reserve() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { user } = useSession();
  const { data: loc } = useApi<{ id: string; name: string }>(`/public/locations/${slug}`);
  const [date, setDate] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState<{ time: string; iso: string } | null>(null);
  const [f, setF] = useState({ guestName: user?.name || '', guestEmail: user?.email || '', guestPhone: '', notes: '' });
  const [card, setCard] = useState('');
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: avail, loading } = useApi<{ slots: { time: string; iso: string }[]; policy: { cancellationHours: number; requiresCardAbove: number | null; noShowFeeCents: number } | null; reason?: string }>(loc ? `/public/locations/${loc.id}/availability?date=${date}&partySize=${party}` : null, { deps: [loc?.id, date, party] });
  if (!loc) return <Loading />;
  const needsCard = !!avail?.policy?.requiresCardAbove && party >= avail.policy.requiresCardAbove;
  if (done) return <View style={[s.screen, s.pad]}><Card title={done.status === 'HELD' ? 'Table held — one more step' : 'Reservation confirmed'}><Text>Code {String(done.confirmationCode)} · {when(done.startAt as string)} · party of {String(done.partySize)}</Text>{done.status === 'HELD' && <ConfirmHold reservation={done as { id: string; holdExpiresAt?: string | null; policy?: { noShowFeeCents: number } | null }} onConfirmed={setDone} />}</Card></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>{loc.name}</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><View style={{ flex: 1 }}><Input label="Date (YYYY-MM-DD)" value={date} onChangeText={(v) => { setDate(v); setSlot(null); }} /></View><View style={{ width: 120 }}><Input label="Party" keyboardType="number-pad" value={String(party)} onChangeText={(v) => { setParty(Number(v) || 1); setSlot(null); }} /></View></View>
      {loading ? <Loading /> : avail?.slots?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{avail.slots.map((sl) => <Pressable key={sl.iso} onPress={() => setSlot(sl)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: slot?.iso === sl.iso ? C.brand : C.white, borderWidth: 1, borderColor: C.ink1 }}><Text style={{ color: slot?.iso === sl.iso ? C.white : C.ink }}>{sl.time}</Text></Pressable>)}</View> : <Muted>{avail?.reason || 'No availability for that date and party size.'}</Muted>}
      {avail?.policy && <Muted>Free cancellation up to {avail.policy.cancellationHours}h before.{avail.policy.noShowFeeCents ? ` No-show fee ${money(avail.policy.noShowFeeCents)}/guest for parties of ${avail.policy.requiresCardAbove}+.` : ''}</Muted>}
      <Card title={slot ? `Book ${slot.time}` : 'Pick a time'} style={{ marginTop: 12 }}>
        <Input label="Name" value={f.guestName} onChangeText={(v) => setF({ ...f, guestName: v })} />
        <Input label="Email" autoCapitalize="none" value={f.guestEmail} onChangeText={(v) => setF({ ...f, guestEmail: v })} />
        <Input label="Phone" value={f.guestPhone} onChangeText={(v) => setF({ ...f, guestPhone: v })} />
        <Input label="Notes" value={f.notes} onChangeText={(v) => setF({ ...f, notes: v })} />
        {needsCard && <Input label="Card (guarantee only)" value={card} onChangeText={setCard} />}
        <ErrorText msg={error} />
        <Button title="Reserve" disabled={!slot || !f.guestName || !f.guestEmail} onPress={async () => { try { setDone(await api.post('/reservations', { locationId: loc.id, startAt: slot!.iso, partySize: party, ...f, channel: 'MARKETPLACE', paymentMethodId: card ? `mock_pm_${card.slice(-4)}` : undefined })); } catch (e) { setError((e as Error).message); } }} />
      </Card>
    </ScrollView>
  );
}
