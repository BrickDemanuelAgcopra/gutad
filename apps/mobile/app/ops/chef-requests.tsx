import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChefRequestSummary } from '@gutad/shared';
import { useApi, useSession } from '@/hooks';
import { Card, ErrorText, Loading, Muted, s } from '@/ui';
import { Pills, StatTile } from '@/ops';
import { RequestRow } from '@/chef-requests';

type F = 'open' | 'overdue' | 'all';
interface Stats { open: number; waitingOnChef: number; dueSoon: number; avgResponseMinutes: number | null; quoteAcceptancePct: number | null; total30?: number; expired30?: number }
const Q: Record<F, string> = { open: '?status=OPEN', overdue: '?overdue=true', all: '' };
const mins = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`);

/** Gutad staff: special requests across all chefs, deadlines and response times. */
export default function OpsChefRequests() {
  const router = useRouter();
  const { isStaff, ready } = useSession();
  const [f, setF] = useState<F>('open');
  const { data, error } = useApi<{ requests: ChefRequestSummary[]; stats: Stats }>(isStaff ? `/admin/chef-requests${Q[f]}` : null, { deps: [f, isStaff], poll: 30000 });
  if (!ready) return null;
  if (!isStaff) return <View style={[s.screen, s.pad]}><Card title="Special requests"><Muted>For Gutad staff only.</Muted></Card></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {data && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <StatTile label="Open" value={data.stats.open} />
          <StatTile label="Waiting on chef" value={data.stats.waitingOnChef} hint={`${data.stats.dueSoon} due within 4 h`} />
          <StatTile label="First response" value={mins(data.stats.avgResponseMinutes)} hint="average, last 30 days" />
          <StatTile label="Quotes ordered" value={data.stats.quoteAcceptancePct === null ? '—' : `${data.stats.quoteAcceptancePct}%`} hint="last 30 days" />
        </View>
      )}
      <Pills value={f} onChange={setF} options={[{ id: 'open', label: 'Open' }, { id: 'overdue', label: 'Overdue / due soon' }, { id: 'all', label: 'All' }]} />
      <ErrorText msg={error} />
      {!data ? (error ? null : <Loading />) : !data.requests.length ? <Card><Muted>No requests here.</Muted></Card> : data.requests.map((r) => <RequestRow key={r.id} r={r} showCustomer showChef onPress={() => router.push({ pathname: '/requests/[id]', params: { id: r.id } })} />)}
    </ScrollView>
  );
}
