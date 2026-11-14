import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills, WorkspaceGate } from '@/ops';

interface Tpl { id: string; name: string; frequency: string; items: { key: string; label: string; requiresValue?: boolean }[] }

/** Shift tools for kitchen staff: clock in/out, checklists, temperatures, expiring stock, counts, equipment problems. */
function Tools() {
  const { user } = useSession();
  const { loc } = useMerchantLocation();
  const [tab, setTab] = useState<'shift' | 'safety' | 'stock' | 'equipment'>('shift');
  const kid = loc?.kitchenId || null;
  const { data: me, reload: rm } = useApi<{ open: { clockInAt: string } | null; entries: { id: string; clockInAt: string; hours: number }[] }>('/attendance/me');
  const { data: tpls } = useApi<Tpl[]>(loc && tab === 'safety' ? `/organizations/${loc.organizationId}/checklists` : null, { deps: [loc?.id, tab] });
  const { data: areas } = useApi<{ id: string; name: string }[]>(kid && tab === 'safety' ? `/kitchens/${kid}/storage-areas` : null, { deps: [kid, tab] });
  const { data: lots } = useApi<{ id: string; ingredient: string; lotCode: string; quantity: number; unit: string; daysLeft: number | null; status: string }[]>(kid && tab === 'stock' ? `/kitchens/${kid}/lots?expiringDays=3` : null, { deps: [kid, tab] });
  const { data: items, reload: ri } = useApi<{ id: string; name: string; unit: string; onHand: number; parLevel: number }[]>(kid && tab === 'stock' ? `/kitchens/${kid}/inventory/items` : null, { deps: [kid, tab] });
  const { data: eq, reload: re } = useApi<{ id: string; name: string; kind: string; status: string; stationCode: string | null }[]>(kid && tab === 'equipment' ? `/equipment?kitchenId=${kid}` : null, { deps: [kid, tab] });
  const { run, error } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const [tpl, setTpl] = useState<Tpl | null>(null);
  const [ans, setAns] = useState<Record<string, boolean>>({});
  const [temp, setTemp] = useState({ area: '', value: '' });
  const [count, setCount] = useState<Record<string, string>>({});
  if (!loc) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={(t) => { setTab(t); setMsg(null); }} options={[{ id: 'shift', label: 'Shift' }, ...(kid ? [{ id: 'safety' as const, label: 'Safety' }, { id: 'stock' as const, label: 'Stock' }, { id: 'equipment' as const, label: 'Equipment' }] : [])]} />
      <ErrorText msg={error} />
      {msg && <Card><Text style={{ color: C.ink }}>{msg}</Text></Card>}
      {tab === 'shift' && (
        <Card title={loc.name}>
          {me?.open ? <><Text style={{ fontSize: 18 }}>Clocked in since {when(me.open.clockInAt)}</Text><Button title="Clock out" onPress={() => run(async () => { await api.post('/attendance/clock-out', { breakMinutes: 0 }); await rm(); setMsg('Clocked out. Your manager approves the hours.'); })} /></> : <Button title="Clock in" onPress={() => run(async () => { await api.post('/attendance/clock-in', { locationId: loc.id }); await rm(); })} />}
          {me?.entries.filter((e) => e.hours).slice(0, 5).map((e) => <Muted key={e.id}>{when(e.clockInAt)} · {e.hours} h</Muted>)}
        </Card>
      )}
      {tab === 'safety' && (
        <>
          <Card title="Temperature check">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{areas?.map((a) => <Button key={a.id} title={a.name} variant={temp.area === a.id ? 'primary' : 'secondary'} onPress={() => setTemp({ ...temp, area: a.id })} />)}</View>
            <Input label="°C" keyboardType="numbers-and-punctuation" value={temp.value} onChangeText={(v) => setTemp({ ...temp, value: v })} />
            <Button title="Log" disabled={!temp.area || temp.value === ''} onPress={() => run(async () => { const r = await api.post<{ inRange: boolean; maxC: number | null }>(`/kitchens/${kid}/temperatures`, { kind: 'STORAGE', storageAreaId: temp.area, tempC: Number(temp.value) }); setMsg(r.inRange ? 'In range ✓' : `Out of range (max ${r.maxC} °C). A manager has been alerted and a corrective action opened.`); setTemp({ ...temp, value: '' }); })} />
          </Card>
          <Card title="Checklists">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{tpls?.map((t) => <Button key={t.id} title={t.name} variant={tpl?.id === t.id ? 'primary' : 'secondary'} onPress={() => { setTpl(t); setAns({}); }} />)}</View>
            {tpl && <View style={{ marginTop: 8 }}>{tpl.items.map((i) => <Button key={i.key} title={`${ans[i.key] ? '☑' : '☐'} ${i.label}`} variant="ghost" onPress={() => setAns({ ...ans, [i.key]: !ans[i.key] })} />)}<Button title={`Sign as ${user?.name || user?.email}`} onPress={() => run(async () => { const r = await api.post<{ missing: string[] }>(`/checklists/${tpl.id}/runs`, { kitchenId: kid, signedName: user?.name || user?.email || 'staff', answers: tpl.items.map((i) => ({ key: i.key, done: !!ans[i.key], value: i.requiresValue && ans[i.key] ? 'ok' : undefined })) }); setMsg(r.missing.length ? `Submitted. Missed: ${r.missing.join(', ')} (a corrective action was opened).` : 'Checklist complete ✓'); setTpl(null); })} /></View>}
          </Card>
        </>
      )}
      {tab === 'stock' && (
        <>
          <Card title="Use first (expiring within 3 days)">{lots?.map((l) => <View key={l.id} style={s.row}><Text style={{ flex: 1 }}>{l.ingredient} · {l.lotCode}</Text><Badge text={l.status === 'QUARANTINED' ? 'QUARANTINED' : l.daysLeft != null && l.daysLeft <= 0 ? 'today' : `${l.daysLeft} d`} tone={l.status === 'QUARANTINED' || (l.daysLeft ?? 9) <= 0 ? 'bad' : 'warn'} /></View>)}{!lots?.length && <Muted>Nothing expiring soon.</Muted>}</Card>
          <Card title="Quick count">
            {items?.filter((i) => i.onHand > 0 || i.parLevel > 0).slice(0, 25).map((i) => <View key={i.id} style={[s.row, { marginBottom: 4 }]}><Text style={{ flex: 1 }}>{i.name} <Text style={{ color: i.onHand <= i.parLevel ? C.bad : C.ink5 }}>({Math.round(i.onHand)} {i.unit})</Text></Text><View style={{ width: 90 }}><Input keyboardType="numeric" value={count[i.id] ?? ''} onChangeText={(v) => setCount({ ...count, [i.id]: v })} /></View></View>)}
            <Button title="Save count" disabled={!Object.values(count).some((v) => v !== '')} onPress={() => run(async () => { await api.post(`/kitchens/${kid}/counts`, { counts: Object.entries(count).filter(([, v]) => v !== '').map(([ingredientId, v]) => ({ ingredientId, counted: Number(v) })), note: 'Mobile count' }); setCount({}); await ri(); setMsg('Count saved.'); })} />
          </Card>
        </>
      )}
      {tab === 'equipment' && (
        <Card title="Equipment">
          {eq?.map((e) => <View key={e.id} style={{ marginBottom: 8 }}><View style={s.row}><Text style={{ flex: 1, fontWeight: '600' }}>{e.name}{e.stationCode ? ` · ${e.stationCode}` : ''}</Text><Badge text={e.status} tone={tone(e.status === 'OK' ? 'COMPLETED' : 'FAILED')} /></View>{e.status === 'OK' ? <Button title="Report a problem (takes it out of service)" variant="danger" onPress={() => run(async () => { const r = await api.post<{ outageState: { soldOutItemIds: string[] } | null }>(`/equipment/${e.id}/status`, { status: 'DOWN', note: 'Reported from the kitchen app' }); setMsg(`${e.name} reported down: ${r.outageState?.soldOutItemIds.length ?? 0} dish(es) paused. A manager has been alerted.`); await re(); })} /> : <Button title="Back in service" onPress={() => run(async () => { await api.post(`/equipment/${e.id}/status`, { status: 'OK', note: 'Fixed' }); await re(); })} />}</View>)}
          {!eq?.length && <Muted>No equipment registered.</Muted>}
          <Muted>For automated equipment, follow the manufacturer’s safety procedure on site; the app only reports.</Muted>
        </Card>
      )}
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/ops"><Tools /></WorkspaceGate>;
}
