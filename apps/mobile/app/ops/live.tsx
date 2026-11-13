import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { StatTile } from '@/ops';

interface Item { id: string; number: string; status: string; fulfillmentType: string; locationName?: string; totalCents: number; deliveryStatus: string | null; bucket: string; overdue: boolean; minutesLate: number }
interface Cap { couriers: { approved: number; available: number; busy: number; jobsWaitingForCourier: number }; totals: { paused: number; overloaded: number; stockouts: number; devicesOffline: number }; locations: { id: string; name: string; isPaused: boolean; pausedReason: string | null; activeOrders: number; loadPct: number | null; soldOutItems: number; devicesOffline: number }[] }
const LABEL: Record<string, string> = { awaitingAcceptance: 'Awaiting acceptance', cooking: 'Cooking', ready: 'Ready for pickup', awaitingCourier: 'Awaiting courier', outForDelivery: 'Out for delivery', overdue: 'Overdue' };

/** Live board: orders by stage, overdue, couriers, and one-tap pause/resume per location. */
export default function OpsLive() {
  const router = useRouter();
  const { can } = useSession();
  const { data } = useApi<{ counts: Record<string, number>; items: Item[] }>('/admin/ops/live', { poll: 10000 });
  const { data: cap, reload } = useApi<Cap>('/admin/ops/capacity', { poll: 20000 });
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  const [bucket, setBucket] = useState<string | null>(null);
  if (!data) return <Loading />;
  const items = data.items.filter((i) => !bucket || (bucket === 'overdue' ? i.overdue : i.bucket === bucket));
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {Object.entries(LABEL).map(([k, l]) => <Pressable key={k} onPress={() => setBucket(bucket === k ? null : k)} style={{ flexBasis: '31%', flexGrow: 1, backgroundColor: bucket === k ? '#fff4ed' : k === 'overdue' && data.counts.overdue ? '#fee2e2' : C.white, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: bucket === k ? C.brand : C.ink1 }}><Text style={{ fontSize: 11, color: C.ink5 }}>{l}</Text><Text style={{ fontSize: 20, fontWeight: '700' }}>{data.counts[k]}</Text></Pressable>)}
      </View>
      <Card title={bucket ? LABEL[bucket] : 'Most urgent'}>
        {items.slice(0, 25).map((i) => (
          <Pressable key={i.id} onPress={() => router.push(`/ops/order/${i.id}` as never)} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.ink1 }}>
            <View style={s.row}><Text style={{ fontWeight: '600' }}>{i.number}</Text>{i.overdue ? <Text style={{ color: C.bad, fontWeight: '700' }}>{i.minutesLate} min late</Text> : <Text>{money(i.totalCents)}</Text>}</View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}><Badge text={i.status} tone={tone(i.status)} />{i.deliveryStatus && <Badge text={i.deliveryStatus} tone={tone(i.deliveryStatus)} />}</View>
            <Muted>{i.locationName} · {i.fulfillmentType.toLowerCase()}</Muted>
          </Pressable>
        ))}
        {!items.length && <Muted>Nothing here.</Muted>}
      </Card>
      {cap && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <StatTile label="Couriers available" value={`${cap.couriers.available}/${cap.couriers.approved}`} hint={`${cap.couriers.busy} on a delivery`} />
            <StatTile label="Waiting for courier" value={cap.couriers.jobsWaitingForCourier} />
            <StatTile label="Items sold out" value={cap.totals.stockouts} />
            <StatTile label="Devices offline" value={cap.totals.devicesOffline} hint={`${cap.totals.paused} locations paused`} />
          </View>
          <Card title="Locations">
            {can('ops.manage') && <Input label="Reason for pause / resume" value={reason} onChangeText={setReason} />}
            <ErrorText msg={error} />
            {cap.locations.slice(0, 20).map((l) => (
              <View key={l.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.ink1 }}>
                <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{l.name}</Text>{l.isPaused && <Badge text="PAUSED" tone="bad" />}</View>
                <Muted>{l.activeOrders} cooking{l.loadPct !== null ? ` · load ${l.loadPct}%` : ''}{l.soldOutItems ? ` · ${l.soldOutItems} sold out` : ''}{l.devicesOffline ? ` · ${l.devicesOffline} devices offline` : ''}{l.pausedReason ? ` · ${l.pausedReason}` : ''}</Muted>
                {can('ops.manage') && <Button title={l.isPaused ? 'Resume' : 'Pause 30 min'} variant={l.isPaused ? 'primary' : 'secondary'} disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/locations/${l.id}/${l.isPaused ? 'resume' : 'pause'}`, l.isPaused ? { reason } : { reason, minutes: 30 }); reload(); })} />}
              </View>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
