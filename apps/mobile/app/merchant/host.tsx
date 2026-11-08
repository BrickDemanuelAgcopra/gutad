import { FlatList, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, Card, ErrorText, Loading, Muted, s, tone } from '@/ui';

interface R { id: string; status: string; partySize: number; actualPartySize: number | null; startAt: string; guestName: string; confirmationCode: string; channel: string; tableIds: string[] }
interface Board { reservations: R[]; waitlist: { id: string; guestName: string; partySize: number; status: string; position: number }[]; floor: { tables: { id: string; name: string; occupied: boolean }[] } }

export default function Host() {
  const { loc } = useMerchantLocation();
  const { data: b, reload } = useApi<Board>(loc ? `/locations/${loc.id}/host` : null, { poll: 6000, deps: [loc?.id] });
  const { run, error } = useAction();
  if (!loc || !b) return <Loading />;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const tname = (id: string) => b.floor.tables.find((t) => t.id === id)?.name || '?';
  return (
    <View style={s.screen}>
      <View style={[s.pad, { paddingBottom: 0 }]}><Text style={{ fontSize: 18, fontWeight: '700' }}>{loc.name} · today</Text><ErrorText msg={error} /><Button title="Walk-in (2)" variant="secondary" onPress={() => act(() => api.post(`/locations/${loc.id}/host/book`, { partySize: 2, guestName: 'Walk-in', channel: 'WALK_IN' }))} /></View>
      <FlatList contentContainerStyle={s.pad} data={b.reservations} keyExtractor={(r) => r.id} ListEmptyComponent={<Muted>No bookings today.</Muted>} renderItem={({ item: r }) => (
        <Card>
          <View style={s.row}><Text style={{ fontWeight: '700' }}>{new Date(r.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {r.guestName} · {r.actualPartySize ?? r.partySize}</Text><Badge text={r.status} tone={tone(r.status)} /></View>
          <Muted>{r.channel} · {r.confirmationCode}{r.tableIds.length ? ` · ${r.tableIds.map(tname).join('+')}` : ''}</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {r.status === 'CONFIRMED' && <Button title="Arrived" variant="secondary" onPress={() => act(() => api.post(`/reservations/${r.id}/host`, { action: 'ARRIVE' }))} />}
            {['CONFIRMED', 'ARRIVED'].includes(r.status) && <Button title="Seat" onPress={() => act(() => api.post(`/reservations/${r.id}/host`, { action: 'SEAT' }))} />}
            {['CONFIRMED', 'ARRIVED'].includes(r.status) && <Button title="No-show" variant="ghost" onPress={() => act(() => api.post(`/reservations/${r.id}/host`, { action: 'NO_SHOW' }))} />}
            {r.status === 'SEATED' && <Button title="Close visit" onPress={() => act(() => api.post(`/reservations/${r.id}/host`, { action: 'COMPLETE' }))} />}
          </View>
        </Card>
      )} ListFooterComponent={<View><Text style={{ fontWeight: '700', fontSize: 16, marginVertical: 8 }}>Waitlist ({b.waitlist.length})</Text>{b.waitlist.map((w) => <Card key={w.id}><View style={s.row}><Text>#{w.position} {w.guestName} · {w.partySize}</Text><View style={{ flexDirection: 'row', gap: 6 }}>{w.status === 'WAITING' && <Button title="Table ready" variant="secondary" onPress={() => act(() => api.post(`/waitlist/${w.id}/notify`, {}))} />}<Button title="Seat" onPress={() => act(() => api.post(`/waitlist/${w.id}/seat`, {}))} /></View></View></Card>)}<Text style={{ fontWeight: '700', fontSize: 16, marginVertical: 8 }}>Floor</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{b.floor.tables.map((t) => <Badge key={t.id} text={t.name} tone={t.occupied ? 'bad' : 'good'} />)}</View>{when(new Date()) ? null : null}</View>} />
    </View>
  );
}
