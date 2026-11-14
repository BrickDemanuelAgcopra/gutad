import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';
import { TileMap } from '@/tile-map';

interface Live { couriers: { id: string; name: string | null; lat: number | null; lng: number | null; status: string; activeJobs: number; vehicleType: string }[]; pickups: { id: string; name: string; lat: number | null; lng: number | null; jobs: number }[]; deliveries: { id: string; status: string; fleet: string; provider: string; location: string; locationId: string; driverId: string | null; etaAt: string | null; late: boolean; dropoff: { lat: number | null; lng: number | null; line1: string }; exception: string | null; needsAttention: boolean; requirements: string[] }[] }
interface Restr { id: string; kind: string; value: number | null; reason: string; locationId: string | null; zoneId: string | null; endsAt: string }

/** Dispatch on the phone: live map, problem deliveries, manual assignment, exceptions and quick restrictions. Zone drawing and analysis are on the web. */
export default function OpsDelivery() {
  const { can } = useSession();
  const [tab, setTab] = useState<'live' | 'restrictions'>('live');
  const { data, reload } = useApi<Live>('/admin/delivery/live', { poll: 15000 });
  const { data: couriers } = useApi<{ id: string; name: string | null; operational: string; capabilities: string[] }[]>(tab === 'live' ? '/admin/couriers?status=APPROVED' : null, { deps: [tab] });
  const { data: restr, reload: reloadR } = useApi<Restr[]>(tab === 'restrictions' ? '/admin/delivery/restrictions' : null, { deps: [tab] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [rLoc, setRLoc] = useState<string | null>(null);
  if (!data) return <Loading />;
  const center = data.pickups.find((p) => p.lat) || data.couriers.find((c) => c.lat) || { lat: 40.7359, lng: -73.9911 };
  const problems = data.deliveries.filter((d) => d.needsAttention || d.late);
  const manage = can('delivery.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'live', label: 'Live' }, { id: 'restrictions', label: 'Restrictions' }]} />
      <ErrorText msg={error} />
      {tab === 'live' && (
        <>
          <TileMap center={{ lat: center.lat!, lng: center.lng! }} dots={[
            ...data.pickups.filter((p) => p.lat).map((p) => ({ id: `p${p.id}`, lat: p.lat!, lng: p.lng!, color: C.brand, size: 12, label: p.name })),
            ...data.couriers.filter((c) => c.lat).map((c) => ({ id: `c${c.id}`, lat: c.lat!, lng: c.lng!, color: c.status === 'ON_DELIVERY' ? C.warn : c.status === 'ONLINE' ? C.good : C.ink3 })),
            ...data.deliveries.filter((d) => d.dropoff.lat).map((d) => ({ id: `d${d.id}`, lat: d.dropoff.lat!, lng: d.dropoff.lng!, color: d.needsAttention || d.late ? C.bad : C.info, size: 8 })),
          ]} />
          <Muted>{data.couriers.filter((c) => c.status !== 'OFFLINE').length} couriers online · {data.deliveries.length} active · {problems.length} need attention</Muted>
          {(problems.length ? problems : data.deliveries).map((d) => (
            <Card key={d.id}>
              <Pressable onPress={() => setOpen(open === d.id ? null : d.id)}>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={d.status} tone={tone(d.status)} />{d.late && <Badge text="late" tone="bad" />}{d.exception && <Badge text={d.exception.toLowerCase().replace(/_/g, ' ')} tone="bad" />}</View>
                <Text style={{ marginTop: 4, color: C.ink }}>{d.location} → {d.dropoff.line1}</Text>
                <Muted>{d.fleet.toLowerCase()} / {d.provider} · ETA {when(d.etaAt)}{d.requirements.length ? ` · needs ${d.requirements.join(', ').toLowerCase()}` : ''}</Muted>
              </Pressable>
              {open === d.id && manage && (
                <View style={{ marginTop: 8 }}>
                  <Input label="Reason (required)" value={reason} onChangeText={setReason} />
                  {['QUOTED', 'REQUESTED', 'UNASSIGNED', 'ASSIGNED'].includes(d.status) && d.fleet !== 'PARTNER' && <><Muted>Assign to:</Muted><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 4 }}>{couriers?.filter((c) => c.operational !== 'SUSPENDED').map((c) => <Button key={c.id} title={`${c.name || 'courier'} · ${c.operational.toLowerCase().replace('_', ' ')}`} variant="secondary" disabled={reason.length < 5} onPress={() => run(async () => { await api.post(`/admin/delivery-jobs/${d.id}/assign`, { driverId: c.id, reason }); setReason(''); setOpen(null); await reload(); })} />)}</View></>}
                  {d.exception && <View style={{ flexDirection: 'row', gap: 6 }}><Button title="Return to restaurant" disabled={reason.length < 5} onPress={() => run(async () => { await api.post(`/admin/delivery-jobs/${d.id}/exception/resolve`, { resolution: 'RETURN', note: reason }); setReason(''); await reload(); })} /><Button title="Dispose" variant="secondary" disabled={reason.length < 5} onPress={() => run(async () => { await api.post(`/admin/delivery-jobs/${d.id}/exception/resolve`, { resolution: 'DISPOSE', note: reason }); setReason(''); await reload(); })} /></View>}
                  <Button title={rLoc === d.locationId ? 'Cancel' : 'Restrict this location…'} variant="ghost" onPress={() => setRLoc(rLoc === d.locationId ? null : d.locationId)} />
                  {rLoc === d.locationId && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <Button title="Pause 1 h" variant="danger" disabled={reason.length < 3} onPress={() => run(async () => { await api.post('/admin/delivery/restrictions', { kind: 'PAUSE', reason, locationId: d.locationId, endsAt: new Date(Date.now() + 3600_000).toISOString() }); setRLoc(null); setReason(''); })} />
                    <Button title="+15 min for 2 h" variant="secondary" disabled={reason.length < 3} onPress={() => run(async () => { await api.post('/admin/delivery/restrictions', { kind: 'ADD_MINUTES', value: 15, reason, locationId: d.locationId, endsAt: new Date(Date.now() + 2 * 3600_000).toISOString() }); setRLoc(null); setReason(''); })} />
                    <Button title="Limit to 2 km for 2 h" variant="secondary" disabled={reason.length < 3} onPress={() => run(async () => { await api.post('/admin/delivery/restrictions', { kind: 'SHRINK_RADIUS', value: 2, reason, locationId: d.locationId, endsAt: new Date(Date.now() + 2 * 3600_000).toISOString() }); setRLoc(null); setReason(''); })} />
                  </View>}
                </View>
              )}
            </Card>
          ))}
          {!data.deliveries.length && <Card><Muted>No active deliveries.</Muted></Card>}
        </>
      )}
      {tab === 'restrictions' && (
        <>
          {!restr?.length && <Card><Muted>No restrictions in force.</Muted></Card>}
          {restr?.map((r) => <Card key={r.id}><Text style={{ fontWeight: '600', color: C.ink }}>{r.kind === 'PAUSE' ? 'Delivery paused' : r.kind === 'SHRINK_RADIUS' ? `Radius ${r.value} km` : `+${r.value} min`}</Text><Muted>{r.reason} · until {when(r.endsAt)}</Muted>{manage && <Button title="Lift" variant="secondary" onPress={() => run(async () => { await api.post(`/admin/delivery/restrictions/${r.id}/lift`, {}); await reloadR(); })} />}</Card>)}
          <Muted>Add restrictions from a delivery on the Live tab, or by zone/region on the web console.</Muted>
        </>
      )}
    </ScrollView>
  );
}
