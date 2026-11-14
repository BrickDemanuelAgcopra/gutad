import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills, StatTile } from '@/ops';

interface Recall { id: string; title: string; reason: string; status: string; severity: string; lotIds: string[]; affectedMenuItemIds: string[]; affectedOrderCount: number; customersNotifiedAt: string | null }

/** Food safety on the phone: overview, recalls (notify, withdraw, close), illness reports, corrective actions. */
export default function OpsSafety() {
  const { can } = useSession();
  const [tab, setTab] = useState<'overview' | 'recalls' | 'cases' | 'actions' | 'sensors'>('overview');
  const { data: ov } = useApi<{ correctiveActions: { open: number; overdue: number; done: number }; openRecalls: Recall[]; openFoodSafetyTickets: number; allergenReviews: number; temperatures: { kitchen: string; out: number }[] }>('/safety/overview', { poll: 60000 });
  const { data: recalls, reload: rr } = useApi<Recall[]>(tab === 'recalls' ? '/safety/recalls' : null, { deps: [tab] });
  const { data: cases } = useApi<{ id: string; description: string; created_at: string; location: string | null; item: string | null; status: string }[]>(tab === 'cases' ? '/safety/food-safety-cases' : null, { deps: [tab] });
  const { data: acts, reload: ra } = useApi<{ id: string; title: string; status: string; overdue: boolean; dueAt: string | null; source: string }[]>(tab === 'actions' ? '/corrective-actions?status=OPEN' : null, { deps: [tab] });
  // 22.2-S wireless sensors, read-only here (register / rotate / retire on the web console)
  const { data: sens } = useApi<{ total: number; offline: number; outOfRange: number; config: { offlineAfterMinutes: number }; sensors: { id: string; name: string; kitchen: string; storageArea: string | null; isOnline: boolean; lastTempC: number | null; lastInRange: boolean | null; minutesSinceReading: number | null; batteryPct: number | null }[] }>(tab === 'sensors' ? '/safety/sensors' : null, { deps: [tab], poll: 60000 });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  if (!ov) return <Loading />;
  const manage = can('culinary.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'overview', label: 'Overview' }, { id: 'recalls', label: 'Recalls' }, { id: 'cases', label: 'Illness' }, { id: 'actions', label: 'Actions' }, { id: 'sensors', label: 'Sensors' }]} />
      <ErrorText msg={error} />
      {tab === 'overview' && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><StatTile label="Open recalls" value={ov.openRecalls.length} /><StatTile label="Illness reports" value={ov.openFoodSafetyTickets} /><StatTile label="Actions open" value={ov.correctiveActions.open} hint={`${ov.correctiveActions.overdue} overdue`} /><StatTile label="Allergen reviews" value={ov.allergenReviews} /></View>
          <Card title="Temperature exceptions (7 days)">{ov.temperatures.filter((t) => t.out).map((t) => <View key={t.kitchen} style={s.row}><Text>{t.kitchen}</Text><Text style={{ color: C.bad }}>{t.out}</Text></View>)}{!ov.temperatures.some((t) => t.out) && <Muted>None.</Muted>}</Card>
        </>
      )}
      {tab === 'recalls' && (
        <>
          {manage && <Input label="Note / message" value={note} onChangeText={setNote} />}
          {recalls?.map((r) => (
            <Card key={r.id}>
              <View style={s.row}><Text style={{ fontWeight: '700', flex: 1 }}>{r.title}</Text><Badge text={r.status} tone={r.status === 'CLOSED' ? 'good' : 'bad'} /></View>
              <Muted>{r.reason}</Muted>
              <Muted>{r.lotIds.length} lot(s) · {r.affectedMenuItemIds.length} dish(es) · {r.affectedOrderCount} order(s){r.customersNotifiedAt ? ' · customers told' : ''}</Muted>
              {manage && r.status !== 'CLOSED' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {!r.customersNotifiedAt && <Button title="Notify customers" disabled={note.length < 10} onPress={() => run(async () => { await api.post(`/safety/recalls/${r.id}/notify`, { message: note }); setNote(''); await rr(); })} />}
                {r.status === 'QUARANTINED' && <Button title="Withdraw stock" variant="secondary" onPress={() => run(async () => { await api.post(`/safety/recalls/${r.id}/withdraw`, {}); await rr(); })} />}
                <Button title="Close" variant="ghost" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/safety/recalls/${r.id}/close`, { note }); setNote(''); await rr(); })} />
              </View>}
            </Card>
          ))}
          {!recalls?.length && <Card><Muted>No recalls. Open one from a lot on the web console.</Muted></Card>}
        </>
      )}
      {tab === 'cases' && (cases?.length ? cases.map((c) => <Card key={c.id}><Text style={{ fontWeight: '600' }}>{c.location || '—'}{c.item ? ` · ${c.item}` : ''}</Text><Muted>{c.description} · {when(c.created_at)} · {c.status.toLowerCase()}</Muted></Card>) : <Card><Muted>No food-safety reports in 30 days.</Muted></Card>)}
      {tab === 'actions' && (acts?.length ? acts.map((a) => <Card key={a.id}><Text style={{ fontWeight: '600', color: a.overdue ? C.bad : C.ink }}>{a.title}</Text><Muted>{a.source.toLowerCase()} · due {when(a.dueAt)}</Muted><Button title="Mark done (needs evidence)" variant="secondary" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/corrective-actions/${a.id}/complete`, { evidenceNote: note }); setNote(''); await ra(); })} /></Card>) : <Card><Muted>No open corrective actions.</Muted></Card>)}
      {tab === 'actions' && <Input label="Evidence note" value={note} onChangeText={setNote} />}
      {tab === 'sensors' && (sens ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><StatTile label="Sensors" value={sens.total} /><StatTile label="Offline" value={sens.offline} /><StatTile label="Out of range" value={sens.outOfRange} /></View>
          {sens.sensors.map((x) => (
            <Card key={x.id}>
              <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{x.name}</Text><Badge text={x.isOnline ? 'online' : 'offline'} tone={x.isOnline ? 'good' : 'bad'} /></View>
              <Muted>{x.kitchen}{x.storageArea ? ` · ${x.storageArea}` : ''}</Muted>
              <Text style={{ color: x.lastInRange === false ? C.bad : C.ink }}>{x.lastTempC == null ? 'No reading yet' : `${x.lastTempC} °C · ${x.minutesSinceReading} min ago`}{x.batteryPct != null ? ` · battery ${x.batteryPct}%` : ''}</Text>
            </Card>
          ))}
          {!sens.sensors.length && <Card><Muted>No wireless sensors registered. Register them per storage area on the web console.</Muted></Card>}
          <Muted>Sensors silent for {sens.config.offlineAfterMinutes} min raise an offline alert; out-of-range readings raise the usual temperature alert.</Muted>
        </>
      ) : <Loading />)}
    </ScrollView>
  );
}
