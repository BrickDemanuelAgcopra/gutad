import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Loading, Muted, s, tone } from '@/ui';

interface Ticket { id: string; stationCode: string | null; status: string; orderNumber: string; promiseAt: string | null; lines: { id: string; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null }[] }
interface Pack { id: string; orderNumber: string; bagCode: string; status: string; verifiedLineIds: string[]; blockedReason: string | null; lines: { id: string; name: string; quantity: number; status: string }[] }

/** Station screen + packing screen for shared kitchens (large type for the line). */
export default function Kitchen() {
  const { loc } = useMerchantLocation();
  const [mode, setMode] = useState<'stations' | 'packing'>('stations');
  const kid = loc?.kitchenId || null;
  const { data: tickets, reload } = useApi<Ticket[]>(kid && mode === 'stations' ? `/kitchens/${kid}/stations/queue` : null, { poll: 4000, deps: [kid, mode] });
  const { data: packs, reload: reloadPacks } = useApi<Pack[]>(kid && mode === 'packing' ? `/kitchens/${kid}/packing` : null, { poll: 4000, deps: [kid, mode] });
  const { run, error } = useAction();
  if (!loc) return <Loading />;
  if (!kid) return <View style={[s.screen, s.pad]}><Muted>This location has no kitchen linked. Single-station restaurants use the order inbox “Ready” button instead.</Muted></View>;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); await reloadPacks(); });
  return (
    <View style={s.screen}>
      <View style={[s.pad, { paddingBottom: 0, flexDirection: 'row', gap: 8 }]}><Button title="Stations" variant={mode === 'stations' ? 'primary' : 'secondary'} onPress={() => setMode('stations')} /><Button title="Packing" variant={mode === 'packing' ? 'primary' : 'secondary'} onPress={() => setMode('packing')} /></View>
      <ErrorText msg={error} />
      {mode === 'stations' ? (
        <FlatList contentContainerStyle={s.pad} data={tickets || []} keyExtractor={(t) => t.id} ListEmptyComponent={<Muted>No tickets.</Muted>} renderItem={({ item: t }) => (
          <Card><View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{t.orderNumber} · {t.stationCode}</Text><Badge text={t.status} tone={tone(t.status)} /></View><Muted>Due {when(t.promiseAt)}</Muted>{t.lines.map((l) => <Text key={l.id} style={{ fontSize: 18, marginTop: 4 }}><Text style={{ fontWeight: '800' }}>{l.quantity}× </Text>{l.name}{l.modifiers?.length ? <Text style={{ color: C.ink5 }}> — {l.modifiers.map((m) => m.name).join(', ')}</Text> : null}{l.specialInstructions ? <Text style={{ color: C.warn }}> “{l.specialInstructions}”</Text> : null}</Text>)}<View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>{t.status === 'QUEUED' && <Button title="Start" onPress={() => act(() => api.post(`/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }))} />}{t.status === 'IN_PROGRESS' && <Button title="Done" onPress={() => act(() => api.post(`/tickets/${t.id}/transition`, { status: 'DONE' }))} />}{t.lines.length > 0 && <Button title={`86 ${t.lines[0].name}`} variant="ghost" onPress={() => act(() => api.post(`/order-lines/${t.lines[0].id}/unavailable`, { note: 'Out of stock' }))} />}</View></Card>
        )} />
      ) : (
        <FlatList contentContainerStyle={s.pad} data={packs || []} keyExtractor={(p) => p.id} ListEmptyComponent={<Muted>Nothing to pack.</Muted>} renderItem={({ item: p }) => (
          <Card><View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{p.orderNumber} · {p.bagCode}</Text><Badge text={p.status} tone={tone(p.status)} /></View>{p.blockedReason && <Text style={{ color: C.bad }}>{p.blockedReason}</Text>}{p.lines.map((l) => <View key={l.id} style={[s.row, { marginTop: 6 }]}><Text style={{ fontSize: 16, textDecorationLine: l.status === 'UNAVAILABLE' ? 'line-through' : 'none' }}>{l.quantity}× {l.name} · {l.status}</Text>{p.verifiedLineIds.includes(l.id) ? <Text style={{ color: C.good }}>✓ in bag</Text> : l.status === 'READY' ? <Button title="In bag" variant="secondary" onPress={() => act(() => api.post(`/packing/${p.id}/verify`, { lineId: l.id }))} /> : null}</View>)}<Button title="Release bag" disabled={p.status === 'BLOCKED'} onPress={() => act(() => api.post(`/packing/${p.id}/release`, {}))} /></Card>
        )} />
      )}
    </View>
  );
}
