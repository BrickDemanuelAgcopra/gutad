import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, money } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { WorkspaceGate } from '@/ops';

interface Row { id: string; name: string; version: number; status: string; portionSize: string | null; plateCostCents: number; allergens: string[] }
interface Detail { recipe: { id: string; name: string; version: number; status: string; portionSize: string | null; yieldPortions: number; steps: { n: number; text: string; stationCode?: string; minutes?: number }[]; equipment: string[]; trainingNotes: string | null; changeSummary: string | null }; costing: { lines: { id: string; name: string; quantity: number; unit: string; allergens: string[] }[]; allergens: string[] }; acknowledgments: { userId: string }[] }

/** Kitchen recipe cards: ingredients, station steps, allergens; staff confirm they have read each new version. */
function Recipes() {
  const { loc } = useMerchantLocation();
  const { user } = useSession();
  const orgId = loc?.organizationId;
  const { data } = useApi<Row[]>(orgId ? `/organizations/${orgId}/recipes` : null, { deps: [orgId] });
  const [open, setOpen] = useState<string | null>(null);
  const { data: d, reload } = useApi<Detail>(open ? `/recipes/${open}` : null, { deps: [open] });
  const { run, error } = useAction();
  if (!data) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <ErrorText msg={error} />
      {data.filter((r) => r.status === 'APPROVED').map((r) => (
        <Card key={r.id}>
          <Pressable onPress={() => setOpen(open === r.id ? null : r.id)}>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{r.name} v{r.version}</Text>{r.allergens.length > 0 && <Badge text={r.allergens.join(', ').toUpperCase()} tone="bad" />}</View>
            <Muted>{r.portionSize || ''}{r.portionSize ? ' · ' : ''}plate cost {money(r.plateCostCents)}</Muted>
          </Pressable>
          {open === r.id && d && d.recipe.id === r.id && (
            <View style={{ marginTop: 8 }}>
              {d.recipe.changeSummary && <Text style={{ color: C.warn, marginBottom: 6 }}>What changed: {d.recipe.changeSummary}</Text>}
              {d.costing.lines.map((l) => <Text key={l.id} style={{ color: C.ink7 }}>• {l.quantity} {l.unit} {l.name}{l.allergens.length ? ` (${l.allergens.join(', ')})` : ''}</Text>)}
              <Text style={{ fontWeight: '600', marginTop: 8 }}>Steps</Text>
              {d.recipe.steps.map((st) => <Text key={st.n} style={{ color: C.ink, marginBottom: 2 }}>{st.n}. {st.stationCode ? `[${st.stationCode}] ` : ''}{st.text}{st.minutes ? ` (${st.minutes} min)` : ''}</Text>)}
              {d.recipe.equipment.length > 0 && <Muted>Equipment: {d.recipe.equipment.join(', ')}</Muted>}
              {d.recipe.trainingNotes && <Muted>Training: {d.recipe.trainingNotes}</Muted>}
              {d.acknowledgments.some((a) => a.userId === user?.id) ? <Muted>✓ You confirmed this version</Muted> : <Button title="I've read this version" onPress={() => run(async () => { await api.post(`/recipes/${r.id}/acknowledge`, {}); reload(); })} />}
            </View>
          )}
        </Card>
      ))}
      {!data.some((r) => r.status === 'APPROVED') && <Card><Muted>No released recipes yet.</Muted></Card>}
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/recipes"><Recipes /></WorkspaceGate>;
}
