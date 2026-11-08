import { FlatList, Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Badge, Button, Loading, Muted, s, tone } from '@/ui';

export default function Orders() {
  const { user } = useSession();
  const { data, loading } = useApi<{ id: string; number: string; status: string; locationName: string; totalCents: number; createdAt: string; fulfillmentType: string }[]>(user ? '/me/orders' : null, { poll: 8000, deps: [user?.id] });
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to see your orders.</Muted><Link href="/login" asChild><Button title="Sign in" onPress={() => undefined} /></Link></View>;
  if (loading) return <Loading />;
  return (
    <FlatList style={s.screen} contentContainerStyle={s.pad} data={data || []} keyExtractor={(o) => o.id} ListEmptyComponent={<Muted>No orders yet.</Muted>} renderItem={({ item: o }) => (
      <Link href={{ pathname: '/order/[id]', params: { id: o.id } }} asChild>
        <Pressable style={s.card}>
          <View style={s.row}><Text style={{ fontWeight: '700' }}>{o.locationName}</Text><Badge text={o.status} tone={tone(o.status)} /></View>
          <Muted>{o.number} · {when(o.createdAt)} · {o.fulfillmentType} · {money(o.totalCents)}</Muted>
        </Pressable>
      </Link>
    )} />
  );
}
