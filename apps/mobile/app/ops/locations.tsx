import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';

interface Row { id: string; name: string; city: string; status: string; isPaused: boolean; pausedReason: string | null; regionName: string | null; readinessApprovedAt: string | null; rampUntil: string | null }
interface Detail { checklist: { progressPct: number; requiredOpen: string[] }; closures: { id: string; kind: string; startsAt: string; endsAt: string; reason: string | null }[]; location: { contacts: { name: string; role?: string; phone?: string }[]; pickupInstructions: string | null } }
interface Av { soldOut: { itemId: string; name: string; locationName: string; until: string | null }[]; pausedLocations: { id: string; name: string; pausedReason: string | null }[]; stationsDown: { id: string; code: string; kitchen: string }[] }

/** Locations on the phone: status, launch progress, contacts, emergency pause and controlled restart; availability across merchants. */
export default function OpsLocations() {
  const { can } = useSession();
  const [tab, setTab] = useState<'locations' | 'availability'>('locations');
  const [q, setQ] = useState('');
  const { data, reload } = useApi<Row[]>(tab === 'locations' ? `/admin/locations${q ? `?q=${encodeURIComponent(q)}` : ''}` : null, { deps: [tab, q] });
  const { data: av, reload: reloadAv } = useApi<Av>(tab === 'availability' ? '/admin/availability' : null, { deps: [tab] });
  const [open, setOpen] = useState<string | null>(null);
  const { data: det } = useApi<Detail>(open ? `/admin/locations/${open}` : null, { deps: [open] });
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'locations', label: 'Locations' }, { id: 'availability', label: 'Availability' }]} />
      <ErrorText msg={error} />
      {tab === 'locations' && (
        <>
          <Input placeholder="Search name or city" value={q} onChangeText={setQ} />
          {!data && <Loading />}
          {data?.map((l) => (
            <Card key={l.id}>
              <Pressable onPress={() => { setOpen(open === l.id ? null : l.id); setReason(''); }}>
                <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{l.name}</Text><Badge text={l.isPaused ? 'PAUSED' : l.status} tone={l.isPaused ? 'bad' : tone(l.status)} /></View>
                <Muted>{l.city}{l.regionName ? ` · ${l.regionName}` : ''}{l.readinessApprovedAt ? ' · ready ✓' : ''}{l.rampUntil && new Date(l.rampUntil) > new Date() ? ' · ramping up' : ''}</Muted>
                {l.pausedReason && <Muted>{l.pausedReason}</Muted>}
              </Pressable>
              {open === l.id && det && (
                <View style={{ marginTop: 8 }}>
                  <Muted>Launch checklist {det.checklist.progressPct}%{det.checklist.requiredOpen.length ? ` · open: ${det.checklist.requiredOpen.join('; ')}` : ''}</Muted>
                  {det.location.contacts.map((c, i) => <Muted key={i}>☎ {c.name}{c.role ? ` (${c.role})` : ''} {c.phone || ''}</Muted>)}
                  {det.closures.filter((c) => new Date(c.endsAt) > new Date()).map((c) => <Muted key={c.id}>{c.kind === 'CLOSED' ? 'Closed' : 'Special hours'} {when(c.startsAt)} → {when(c.endsAt)} {c.reason || ''}</Muted>)}
                  {can('ops.manage') && (
                    <>
                      <Input label="Reason" value={reason} onChangeText={setReason} />
                      {l.isPaused
                        ? <Button title="Controlled restart" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/locations/${l.id}/restart`, { reason }); setReason(''); reload(); })} />
                        : <Button title="Emergency pause" variant="danger" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post('/admin/locations/emergency-pause', { locationIds: [l.id], reason }); setReason(''); reload(); })} />}
                    </>
                  )}
                </View>
              )}
            </Card>
          ))}
        </>
      )}
      {tab === 'availability' && av && (
        <>
          <Card title={`Paused (${av.pausedLocations.length})`}>{av.pausedLocations.map((p) => <Muted key={p.id}>{p.name} — {p.pausedReason}</Muted>)}{!av.pausedLocations.length && <Muted>None.</Muted>}</Card>
          <Card title={`Sold out (${av.soldOut.length})`}>
            {av.soldOut.map((i) => <View key={i.itemId} style={[s.row, { paddingVertical: 4 }]}><View style={{ flex: 1 }}><Text>{i.name}</Text><Muted>{i.locationName}{i.until ? ` · back ${when(i.until)}` : ''}</Muted></View>{can('ops.manage') && <Button title="Available" variant="ghost" onPress={() => run(async () => { await api.post(`/items/${i.itemId}/sold-out`, { soldOut: false }); reloadAv(); })} />}</View>)}
            {!av.soldOut.length && <Muted>Nothing sold out.</Muted>}
          </Card>
          <Card title={`Stations down (${av.stationsDown.length})`}>{av.stationsDown.map((d) => <Muted key={d.id}>{d.kitchen} · {d.code}</Muted>)}{!av.stationsDown.length && <Muted>All available.</Muted>}</Card>
        </>
      )}
    </ScrollView>
  );
}
