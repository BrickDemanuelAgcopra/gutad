import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChefQualityPolicy } from '@gutad/shared';
import { money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Badge, C, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';
import { FLAG_LABELS, mins, pct, type ChefMetrics } from '@/chef-ops';

interface QEvent { id: string; chefProfileId: string; kind: string; label: string; source: string; note: string; createdAt: string; chefName: string }
interface FoodSafety { id: string; status: string; description: string | null; created_at: string; number: string; chef: string; chef_id: string; item: string | null }
interface Quality { windowDays: number; policy: ChefQualityPolicy; chefs: ChefMetrics[]; events: QEvent[]; openFoodSafety: FoodSafety[] }

type W = '7' | '30' | '90';

/** Gutad staff: chef quality, flagged chefs first, open food-safety reports and recent actions. */
export default function OpsChefQuality() {
  const router = useRouter();
  const { isStaff, ready } = useSession();
  const [w, setW] = useState<W>('30');
  const { data, error } = useApi<Quality>(isStaff ? `/admin/chef-quality?days=${w}` : null, { deps: [w, isStaff], poll: 60000 });
  if (!ready) return null;
  if (!isStaff) return <View style={[s.screen, s.pad]}><Card title="Chef quality"><Muted>For Gutad staff only.</Muted></Card></View>;
  const open = (id: string) => router.push({ pathname: '/ops/chef-quality/[id]', params: { id } });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={w} onChange={setW} options={[{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }]} />
      <ErrorText msg={error} />
      {!data ? (error ? null : <Loading />) : (
        <>
          <Muted>Limits: incidents {data.policy.maxIncidentRatePct}% · declined or unconfirmed {data.policy.maxDeclineRatePct}% · judged from {data.policy.minOrders} orders</Muted>
          <View style={{ height: 8 }} />
          {data.openFoodSafety.length > 0 && (
            <Card title={`Open food-safety reports (${data.openFoodSafety.length})`}>
              {data.openFoodSafety.map((f) => (
                <Pressable key={f.id} onPress={() => open(f.chef_id)} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
                  <View style={[s.row, { gap: 6 }]}><Text style={{ flex: 1, fontWeight: '600', color: C.ink }}>{f.chef} · #{f.number}</Text><Badge text={f.status} tone="bad" /></View>
                  {f.item ? <Muted>{f.item}</Muted> : null}
                  {f.description ? <Text style={{ color: C.ink7 }} numberOfLines={2}>{f.description}</Text> : null}
                  <Muted>{when(f.created_at)}</Muted>
                </Pressable>
              ))}
            </Card>
          )}
          {!data.chefs.length ? <Card><Muted>No chefs yet.</Muted></Card> : data.chefs.map((m) => (
            <Pressable key={m.chefId} onPress={() => open(m.chefId)}>
              <Card>
                <View style={[s.row, { gap: 6 }]}>
                  <Text style={{ fontWeight: '700', flex: 1, color: C.ink }}>{m.displayName}</Text>
                  {m.status !== 'ACTIVE' && <Badge text={m.status} tone="bad" />}
                  {m.flags.map((f) => <Badge key={f} text={FLAG_LABELS[f] || f} tone="bad" />)}
                </View>
                <Muted>{m.orders} orders · {money(m.gmvCents)} · declined {pct(m.declineRatePct)} · incidents {pct(m.incidentRatePct)}</Muted>
                <Muted>Accepts in {mins(m.avgAcceptMinutes)} · rating {m.rating === null ? '—' : `${m.rating} ★ (${m.ratings})`}{m.foodSafety ? ` · ${m.foodSafety} food-safety` : ''}</Muted>
              </Card>
            </Pressable>
          ))}
          <Card title="Recent actions">
            {!data.events.length ? <Muted>Nothing recorded yet.</Muted> : data.events.map((e) => (
              <Pressable key={e.id} onPress={() => open(e.chefProfileId)} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
                <Text style={{ fontWeight: '600', color: C.ink }}>{e.chefName} · {e.label}</Text>
                <Text style={{ color: C.ink7 }}>{e.note}</Text>
                <Muted>{e.source === 'AUTO' ? 'Automatic' : 'Staff'} · {when(e.createdAt)}</Muted>
              </Pressable>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
