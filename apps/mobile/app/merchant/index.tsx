import { WorkspaceGate } from '@/ops';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { api, money, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { PlanSummary } from '@/plan';

interface Order { id: string; number: string; status: string; channel: string; fulfillmentType: string; guestName: string | null; totalCents: number; promiseAt: string | null; createdAt: string; pickupCode: string | null; lines: { id: string; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null }[]; delivery: { status: string } | null }

/** Tablet order inbox: acknowledge/accept/reject, prep time, ready, handoff, pause. Polls every 4 s. */
function MerchantInbox() {
  const { loc, locs, setLocId, deviceToken, setDeviceToken } = useMerchantLocation();
  const { data, reload } = useApi<Order[]>(loc ? `/locations/${loc.id}/orders` : null, { poll: 4000, deps: [loc?.id] });
  const { run, error } = useAction();
  const [prep, setPrep] = useState('20');
  if (!loc) return <View style={[s.screen, s.pad]}><Loading /><Muted>Loading your locations… (sign in with a merchant account)</Muted></View>;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <View style={s.screen}>
      <View style={[s.pad, { paddingBottom: 0 }]}>
        <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{loc.name}</Text><View style={{ flexDirection: 'row', gap: 6 }}>{locs.length > 1 && <Button title="Switch" variant="ghost" onPress={() => setLocId(locs[(locs.findIndex((l) => l.id === loc.id) + 1) % locs.length].id)} />}<Button title={loc.isPaused ? 'Resume' : 'Pause 30m'} variant="secondary" onPress={() => act(() => api.post(`/locations/${loc.id}/${loc.isPaused ? 'resume' : 'pause'}`, loc.isPaused ? {} : { minutes: 30, reason: 'Kitchen at capacity' }))} /></View></View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Link href="/merchant/host" asChild><Button title="Host stand" variant="secondary" onPress={() => undefined} /></Link><Link href="/merchant/kitchen" asChild><Button title="Kitchen" variant="secondary" onPress={() => undefined} /></Link></View>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Input label="Device token (from Settings → Devices)" value={deviceToken} onChangeText={setDeviceToken} autoCapitalize="none" /></View><View style={{ width: 90 }}><Input label="Prep min" keyboardType="number-pad" value={prep} onChangeText={setPrep} /></View></View>
        <ErrorText msg={error} />
      </View>
      <FlatList contentContainerStyle={s.pad} ListHeaderComponent={<PlanSummary orgId={loc.organizationId} />} data={data || []} keyExtractor={(o) => o.id} ListEmptyComponent={<Muted>No active orders.</Muted>} renderItem={({ item: o }) => (
        <Card style={o.status === 'SUBMITTED' ? { borderColor: C.brand, borderWidth: 2 } : undefined}>
          <View style={s.row}><Text style={{ fontWeight: '700', fontSize: 16 }}>{o.number}</Text><Badge text={o.status} tone={tone(o.status)} /></View>
          <Muted>{o.guestName || 'Customer'} · {o.channel} · {o.fulfillmentType} · {o.promiseAt ? `due ${when(o.promiseAt)}` : when(o.createdAt)}{o.delivery ? ` · courier ${o.delivery.status}` : ''}</Muted>
          {o.lines.map((l) => <Text key={l.id} style={{ marginTop: 4 }}><Text style={{ fontWeight: '700' }}>{l.quantity}× </Text>{l.name}{l.modifiers?.length ? <Text style={{ color: C.ink5 }}> — {l.modifiers.map((m) => m.name).join(', ')}</Text> : null}{l.specialInstructions ? <Text style={{ color: C.warn }}> “{l.specialInstructions}”</Text> : null}</Text>)}
          <View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>{money(o.totalCents)}</Text>{o.pickupCode && <Text style={{ fontFamily: 'monospace' }}>code {o.pickupCode}</Text>}</View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {o.status === 'SUBMITTED' && (<><Button title="Accept" onPress={() => act(() => api.post(`/orders/${o.id}/accept`, { prepMinutes: Number(prep) || 20 }))} /><Button title="Reject" variant="danger" onPress={() => act(() => api.post(`/orders/${o.id}/reject`, { reason: 'Too busy' }))} /></>)}
            {['ACCEPTED', 'PREPARING'].includes(o.status) && (<><Button title="Ready" onPress={() => act(() => api.post(`/orders/${o.id}/ready`, {}))} /><Button title="+15 min" variant="secondary" onPress={() => act(() => api.post(`/orders/${o.id}/prep-time`, { prepMinutes: 15 }))} /></>)}
            {o.status === 'READY' && <Button title={o.fulfillmentType === 'DELIVERY' ? 'Courier collected' : 'Handed off'} onPress={() => act(() => api.post(`/orders/${o.id}/handoff`, {}))} />}
          </View>
        </Card>
      )} />
    </View>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/orders"><MerchantInbox /></WorkspaceGate>;
}
