import { useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { api, when } from '@/api';
import { ConfirmHold } from '@/hold';
import { useApi, useSession } from '@/hooks';
import { Badge, Button, Loading, Muted, s, tone } from '@/ui';

interface Resv { id: string; confirmationCode: string; status: string; startAt: string; partySize: number; holdExpiresAt: string | null; policy: { noShowFeeCents: number } | null; location: { name: string } }

export default function Reservations() {
  const { user } = useSession();
  const { data, loading, reload } = useApi<Resv[]>(user ? '/me/reservations' : null, { deps: [user?.id] });
  const { data: tickets, reload: reloadTickets } = useApi<{ t: { id: string; confirmationCode: string; status: string; spots: number }; s: { startAt: string }; e: { name: string } }[]>(user ? '/me/tickets' : null, { deps: [user?.id] });
  // Refresh whenever the tab is opened, e.g. right after booking a table or an experience.
  useFocusEffect(useCallback(() => { void reload(); void reloadTickets(); }, [reload, reloadTickets]));
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to see your reservations and tickets.</Muted><Link href="/login" asChild><Button title="Sign in" onPress={() => undefined} /></Link></View>;
  if (loading) return <Loading />;
  return (
    <FlatList style={s.screen} contentContainerStyle={s.pad} data={data || []} keyExtractor={(r) => r.id} ListEmptyComponent={<Muted>No reservations yet. Find a restaurant and tap Reserve.</Muted>} renderItem={({ item: r }) => (
      <View style={s.card}>
        <View style={s.row}><Text style={{ fontWeight: '700' }}>{r.location.name}</Text><Badge text={r.status} tone={tone(r.status)} /></View>
        <Muted>{when(r.startAt)} · party of {r.partySize} · {r.confirmationCode}</Muted>
        {r.status === 'HELD' && <ConfirmHold reservation={r} onConfirmed={() => void reload()} />}
        {['CONFIRMED', 'HELD'].includes(r.status) && <Button title="Cancel reservation" variant="ghost" onPress={() => api.post(`/reservations/${r.id}/cancel`, { reason: 'Guest canceled' }).then(reload)} />}
      </View>
    )} ListFooterComponent={tickets?.length ? <View><Text style={{ fontWeight: '700', fontSize: 16, marginVertical: 8 }}>Tickets</Text>{tickets.map(({ t, s: sess, e }) => <View key={t.id} style={s.card}><View style={s.row}><Text style={{ fontWeight: '700' }}>{e.name}</Text><Badge text={t.status} tone={tone(t.status)} /></View><Muted>{when(sess.startAt)} · {t.spots} spots · {t.confirmationCode}</Muted></View>)}</View> : undefined} />
  );
}
