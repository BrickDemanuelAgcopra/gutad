import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { when } from '@/api';
import { useApi } from '@/hooks';
import { Badge, C, Card, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';

/** Workforce & equipment on the phone: equipment status and software, device health. */
export default function OpsWorkforce() {
  const [tab, setTab] = useState<'equipment' | 'devices'>('equipment');
  const { data: eq } = useApi<{ id: string; name: string; kind: string; kitchen: string; status: string; isAutomated: boolean; softwareVersion: string | null; softwareApproved: boolean | null; serviceDue: boolean; openTickets: number }[]>(tab === 'equipment' ? '/equipment' : null, { deps: [tab], poll: 60000 });
  const { data: dev } = useApi<{ id: string; name: string; kind: string; location: string; isOnline: boolean; minutesSinceSeen: number | null; lastError: string | null }[]>(tab === 'devices' ? '/devices/health' : null, { deps: [tab], poll: 60000 });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'equipment', label: 'Equipment' }, { id: 'devices', label: 'Devices' }]} />
      {tab === 'equipment' && (!eq ? <Loading /> : eq.map((e) => (
        <Card key={e.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{e.name} · {e.kitchen}</Text><Badge text={e.status} tone={e.status === 'OK' ? 'good' : e.status === 'DEGRADED' ? 'warn' : 'bad'} /></View>
          <Muted>{e.kind.toLowerCase()}{e.isAutomated ? ` · software ${e.softwareVersion || '—'}${e.softwareApproved === false ? ' (not approved)' : ''}` : ''}{e.serviceDue ? ' · service due' : ''}{e.openTickets ? ` · ${e.openTickets} open ticket(s)` : ''}</Muted>
        </Card>
      )))}
      {tab === 'devices' && (!dev ? <Loading /> : dev.map((d) => (
        <Card key={d.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{d.name} · {d.location}</Text><Badge text={d.isOnline ? 'online' : 'offline'} tone={d.isOnline ? 'good' : 'bad'} /></View>
          <Muted>{d.kind.toLowerCase()} · seen {d.minutesSinceSeen == null ? 'never' : `${d.minutesSinceSeen} min ago`}</Muted>
          {d.lastError && <Text style={{ color: C.bad }}>{d.lastError}</Text>}
        </Card>
      )))}
      <Muted>Updated {when(new Date().toISOString())}. Equipment is never controlled from Gutad; problems are escalated to an operator.</Muted>
    </ScrollView>
  );
}
