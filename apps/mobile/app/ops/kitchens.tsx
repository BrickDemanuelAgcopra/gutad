import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Loading, Muted, s } from '@/ui';

interface K { id: string; name: string; organization: string; city: string; loadLevel: string; loadChangedAt: string | null; queued: number; inProgress: number; delayed: number; remakesToday: number; toPack: number; readyWaiting: number }
interface Perf { stations: { code: string; tickets: number; avgMinutes: number | null; targetMinutes: number; onTargetPct: number | null; remakes: number }[]; reasons: { kind: string; reasonCode: string; count: number }[] }
const tone = (l: string) => (l === 'NORMAL' ? 'good' : l === 'BUSY' ? 'warn' : 'bad') as 'good' | 'warn' | 'bad';

/** Kitchen load, late tickets, packing backlog and remakes across kitchens; per-station performance on tap. */
export default function OpsKitchens() {
  const { can } = useSession();
  const { data, reload } = useApi<K[]>('/admin/kitchens', { poll: 20000 });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const { data: perf } = useApi<Perf>(open ? `/kitchens/${open}/performance?days=1` : null, { deps: [open] });
  if (!data) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {can('kitchens.manage') && <Button title="Re-check load now" variant="secondary" onPress={() => run(async () => { await api.post('/admin/jobs/kitchen-load', {}); await reload(); })} />}
      <ErrorText msg={error} />
      {!data.length && <Muted>No kitchens.</Muted>}
      {data.map((k) => (
        <Card key={k.id}>
          <Pressable onPress={() => setOpen(open === k.id ? null : k.id)}>
            <View style={s.row}><Text style={{ fontWeight: '700', color: C.ink, flex: 1 }}>{k.name}</Text><Badge text={k.loadLevel} tone={tone(k.loadLevel)} /></View>
            <Muted>{k.organization} · {k.city}{k.loadChangedAt ? ` · since ${when(k.loadChangedAt)}` : ''}</Muted>
            <Text style={{ marginTop: 4 }}>{k.queued} queued · {k.inProgress} cooking · <Text style={{ color: k.delayed ? C.bad : C.ink }}>{k.delayed} late</Text> · {k.toPack} to pack · {k.readyWaiting} ready waiting · {k.remakesToday} remakes today</Text>
          </Pressable>
          {open === k.id && perf && (
            <View style={{ marginTop: 8 }}>
              {perf.stations.map((st) => <Muted key={st.code}>{st.code}: {st.tickets} tickets · avg {st.avgMinutes ?? '—'} / {st.targetMinutes} min · {st.onTargetPct ?? '—'}% on target · {st.remakes} remakes</Muted>)}
              {perf.reasons.map((r) => <Muted key={r.kind + r.reasonCode}>{r.kind.toLowerCase()} · {r.reasonCode.toLowerCase().replace(/_/g, ' ')}: {r.count}</Muted>)}
              {!perf.stations.length && <Muted>No finished tickets today.</Muted>}
            </View>
          )}
        </Card>
      ))}
      <Muted>Routing rules, station targets and auto-throttle thresholds are set on the merchant’s Kitchen → Setup screen.</Muted>
    </ScrollView>
  );
}
