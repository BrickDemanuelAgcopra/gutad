import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, Loading, Muted, s, tone } from '@/ui';

type GroupOrder = { id: string; number: string; status: string; fulfillmentType: string; locationName?: string; totalCents: number; scheduledFor: string | null; chefNetwork: { chefName: string | null; acceptBy: string | null } | null };
type Group = { id: string; totalCents: number; deliveries: number; orders: GroupOrder[] };

/** Confirmation for a multi-chef checkout: one payment, one order per chef. Guests load each order by id + email. */
export default function CheckoutGroup() {
  const { id, email, orders } = useLocalSearchParams<{ id: string; email?: string; orders?: string }>();
  const { user } = useSession();
  const router = useRouter();
  const { data: mine, error } = useApi<Group>(user ? `/checkout-groups/${id}` : null, { deps: [user?.id, id] });
  const [guestOrders, setGuestOrders] = useState<GroupOrder[] | null>(null);
  useEffect(() => {
    if (user || !orders) return;
    Promise.all(orders.split(',').filter(Boolean).map((oid) => api.get<GroupOrder>(`/orders/${oid}?email=${encodeURIComponent(email || '')}`).catch(() => null))).then((r) => setGuestOrders(r.filter((o): o is GroupOrder => !!o)));
  }, [user, orders, email]);
  const list = mine?.orders || guestOrders;
  if (!list) return error ? <View style={[s.screen, s.pad]}><Muted>{error}</Muted></View> : <Loading />;
  const total = mine?.totalCents ?? list.reduce((a, o) => a + o.totalCents, 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: C.ink }}>Thank you!</Text>
      <Text style={{ color: C.ink, marginBottom: 4 }}>{list.length} {list.length === 1 ? 'delivery' : 'deliveries'} · one payment of {money(total)}</Text>
      <Muted>Each chef confirms your order before cooking. If a chef declines or doesn’t confirm in time, that order is refunded in full.</Muted>
      <View style={{ height: 10 }} />
      {list.map((o) => (
        <Card key={o.id} title={o.chefNetwork?.chefName || o.locationName || 'Chef'}>
          <View style={s.row}><Text style={{ fontWeight: '600' }}>{o.number}</Text><Badge text={o.status === 'SUBMITTED' ? 'Waiting for chef' : o.status} tone={tone(o.status)} /></View>
          {o.chefNetwork?.chefName && o.locationName && <Muted>{o.locationName}</Muted>}
          <Muted>{o.fulfillmentType === 'DELIVERY' ? 'Delivery' : 'Pickup'}{o.scheduledFor ? ` · ${when(o.scheduledFor)}` : ''}</Muted>
          {o.status === 'SUBMITTED' && o.chefNetwork?.acceptBy && <Muted>Chef confirms by {when(o.chefNetwork.acceptBy)}</Muted>}
          <View style={[s.row, { marginTop: 4 }]}><Text>Total</Text><Text style={{ fontWeight: '700' }}>{money(o.totalCents)}</Text></View>
          <Button title="View order" variant="secondary" onPress={() => router.push({ pathname: '/order/[id]', params: { id: o.id, email: email || '' } })} />
        </Card>
      ))}
      <Button title="Done" variant="ghost" onPress={() => router.replace('/')} />
    </ScrollView>
  );
}
