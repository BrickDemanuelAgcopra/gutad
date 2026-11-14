import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { WorkspaceGate } from '@/ops';

interface Detail {
  location: { id: string; name: string; isPaused: boolean; pausedReason: string | null; autoAccept: boolean; acceptTimeoutMinutes: number; pickupInstructions: string | null; acceptsKiosk: boolean };
  closures: { id: string; kind: string; startsAt: string; endsAt: string; reason: string | null; opens: string | null; closes: string | null }[];
  checklist: { progressPct: number; items: { key: string; label: string; done: boolean; required: boolean }[]; readinessApprovedAt: string | null };
}

/** Merchant tablet: close for a while, auto-accept, pickup note, launch checklist, reopen gradually. */
function LocationScreen() {
  const { loc } = useMerchantLocation();
  const { data: d, reload } = useApi<Detail>(loc ? `/admin/locations/${loc.id}` : null, { deps: [loc?.id] });
  const { run, error } = useAction();
  const [pickup, setPickup] = useState<string | null>(null);
  if (!d || !loc) return null;
  const l = d.location;
  const close = (hours: number) => run(async () => { await api.post(`/locations/${loc.id}/closures`, { kind: 'CLOSED', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + hours * 3600_000).toISOString(), service: 'ORDERING', reason: `Closed for ${hours}h` }); reload(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <ErrorText msg={error} />
      {l.isPaused && <Card title="Paused"><Muted>{l.pausedReason}</Muted>{!l.pausedReason?.startsWith('Emergency:') ? <Button title="Reopen gradually" onPress={() => run(async () => { await api.post(`/locations/${loc.id}/restart`, { reason: 'Reopened from the tablet' }); reload(); })} /> : <Muted>Gutad will reopen after the emergency.</Muted>}</Card>}
      <Card title="Close ordering">
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[1, 2, 4].map((h) => <Button key={h} title={`${h} hour${h > 1 ? 's' : ''}`} variant="secondary" onPress={() => close(h)} />)}</View>
        {d.closures.filter((c) => new Date(c.endsAt) > new Date()).map((c) => (
          <View key={c.id} style={[s.row, { marginTop: 6 }]}><Muted>{c.kind === 'CLOSED' ? 'Closed' : `Hours ${c.opens}–${c.closes}`} until {when(c.endsAt)} {c.reason ? `· ${c.reason}` : ''}</Muted><Button title="Remove" variant="ghost" onPress={() => run(async () => { await api.delete(`/closures/${c.id}`); reload(); })} /></View>
        ))}
        <Muted>Holidays and special hours are set on the web portal (Location & launch).</Muted>
      </Card>
      <Card title="Orders">
        <View style={s.row}><Text style={{ color: C.ink }}>Auto-accept orders</Text><Switch value={l.autoAccept} onValueChange={(v) => run(async () => { await api.patch(`/locations/${loc.id}`, { autoAccept: v }); reload(); })} /></View>
        <Muted>Unaccepted orders escalate after {l.acceptTimeoutMinutes} min.</Muted>
        <Input label="Pickup instructions for customers" value={pickup ?? l.pickupInstructions ?? ''} onChangeText={setPickup} />
        {pickup !== null && <Button title="Save" onPress={() => run(async () => { await api.patch(`/locations/${loc.id}`, { pickupInstructions: pickup || null }); setPickup(null); reload(); })} />}
      </Card>
      <Card title={`Launch checklist · ${d.checklist.progressPct}%`}>
        {d.checklist.items.map((i) => <Text key={i.key} style={{ color: i.done ? C.good : C.ink5, marginBottom: 2 }}>{i.done ? '✓' : '○'} {i.label}{i.required ? '' : ' (optional)'}</Text>)}
        {d.checklist.readinessApprovedAt ? <Muted>Approved for launch {when(d.checklist.readinessApprovedAt)}</Muted> : <Muted>Gutad approves the launch once everything required is done.</Muted>}
        {!d.checklist.items.find((i) => i.key === 'TRAINING')?.done && <Button title="Staff training done" variant="secondary" onPress={() => run(async () => { await api.post(`/locations/${loc.id}/launch-items/TRAINING`, { done: true, note: 'Signed off from tablet' }); reload(); })} />}
      </Card>
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/location"><LocationScreen /></WorkspaceGate>;
}
