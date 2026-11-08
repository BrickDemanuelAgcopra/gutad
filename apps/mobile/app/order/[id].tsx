import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, Loading, Muted, s, tone } from '@/ui';

const STEPS = ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED', 'COMPLETED'];

export default function Order() {
  const { id, email } = useLocalSearchParams<{ id: string; email?: string }>();
  const { user } = useSession();
  const { data: o, reload } = useApi<{ id: string; number: string; status: string; fulfillmentType: string; locationName: string; totalCents: number; promiseAt: string | null; pickupCode: string | null; canCancel: boolean; lines: { id: string; name: string; quantity: number; lineTotalCents: number; status: string; replacementNote: string | null }[]; payment: { status: string; refundedCents: number } | null; delivery: { id: string; status: string; etaAt: string | null; proofPhotoUrl: string | null } | null }>(`/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`, { poll: 5000 });
  const { data: track } = useApi<{ status: string; etaAt: string | null; courierLocation: { lat: number; lng: number } | null }>(o?.delivery ? `/public/delivery/${o.delivery.id}/track` : null, { poll: 7000, deps: [o?.delivery?.id] });
  if (!o) return <Loading />;
  const idx = STEPS.indexOf(o.status);
  const bad = ['REJECTED', 'CANCELED'].includes(o.status);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.row}><Text style={{ fontSize: 20, fontWeight: '700' }}>{o.number}</Text><Badge text={o.status} tone={tone(o.status)} /></View>
      <Muted>{o.locationName}</Muted>
      {!bad && <View style={{ flexDirection: 'row', gap: 3, marginVertical: 10 }}>{STEPS.map((st, i) => <View key={st} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= idx ? C.brand : C.ink1 }} />)}</View>}
      {o.status === 'READY' && o.pickupCode && <Card><Text style={{ fontSize: 16 }}>Ready! Show code</Text><Text style={{ fontSize: 40, fontWeight: '800', letterSpacing: 6 }}>{o.pickupCode}</Text></Card>}
      {o.promiseAt && !bad && o.status !== 'COMPLETED' && <Muted>Estimated {o.fulfillmentType === 'DELIVERY' ? 'delivery' : 'ready'}: {when(o.promiseAt)}</Muted>}
      {o.lines.filter((l) => l.status === 'UNAVAILABLE').map((l) => <Card key={l.id} title="Item unavailable"><Text>{l.name}{l.replacementNote ? ` — suggested: ${l.replacementNote}` : ''}</Text><View style={{ flexDirection: 'row', gap: 8 }}><Button title="Accept replacement" onPress={() => api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'REPLACE' }).then(reload)} /><Button title="Credit me" variant="secondary" onPress={() => api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'CREDIT' }).then(reload)} /></View></Card>)}
      {o.delivery && <Card title="Delivery"><View style={s.row}><Text>Courier</Text><Badge text={track?.status || o.delivery.status} tone={tone(track?.status || o.delivery.status)} /></View>{track?.etaAt && <Muted>ETA {when(track.etaAt)}</Muted>}{track?.courierLocation && <Muted>Courier at {track.courierLocation.lat.toFixed(3)}, {track.courierLocation.lng.toFixed(3)}</Muted>}{o.delivery.proofPhotoUrl && <Muted>Proof of delivery captured</Muted>}</Card>}
      <Card title="Items">{o.lines.map((l) => <View key={l.id} style={s.row}><Text>{l.quantity}× {l.name} {l.status === 'CREDITED' ? '(credited)' : ''}</Text><Text>{money(l.lineTotalCents)}</Text></View>)}<View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>Total</Text><Text style={{ fontWeight: '700' }}>{money(o.totalCents)}</Text></View>{o.payment && <Muted>Payment {o.payment.status}{o.payment.refundedCents ? ` · refunded ${money(o.payment.refundedCents)}` : ''}</Muted>}</Card>
      {o.canCancel && user && <Button title="Cancel order" variant="danger" onPress={() => api.post(`/orders/${o.id}/cancel`, { reason: 'Changed my mind' }).then(reload)} />}
      {user && !bad && <Button title="Report a problem" variant="secondary" onPress={() => api.post('/incidents', { orderId: o.id, category: 'OTHER', description: 'Reported from the app' }).then(() => alert('Support case opened'))} />}
    </ScrollView>
  );
}
