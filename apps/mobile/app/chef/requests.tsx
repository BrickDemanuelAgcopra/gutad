import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChefRequestSummary } from '@gutad/shared';
import { useApi } from '@/hooks';
import { Card, ErrorText, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';
import { RequestRow } from '@/chef-requests';

type Tab = 'needsReply' | 'waiting' | 'won' | 'closed';
interface Inbox { requests: ChefRequestSummary[]; counts: Record<Tab, number> }
const TABS: { id: Tab; label: string; empty: string }[] = [
  { id: 'needsReply', label: 'Needs reply', empty: 'No requests waiting for you.' },
  { id: 'waiting', label: 'Waiting on customer', empty: 'Nothing waiting on customers.' },
  { id: 'won', label: 'Won', empty: 'No accepted quotes yet.' },
  { id: 'closed', label: 'Closed', empty: 'No closed requests.' },
];

/** Special requests inbox: oldest deadline first under "Needs reply". */
export default function ChefRequests() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('needsReply');
  const { data, error } = useApi<Inbox>(`/chef/requests?status=${tab}`, { deps: [tab], poll: 30000 });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={TABS.map((t) => ({ id: t.id, label: data ? `${t.label} (${data.counts[t.id]})` : t.label }))} />
      <ErrorText msg={error} />
      {!data ? <Loading /> : !data.requests.length ? <Card><Muted>{TABS.find((t) => t.id === tab)!.empty}</Muted></Card> : data.requests.map((r) => <RequestRow key={r.id} r={r} showCustomer onPress={() => router.push({ pathname: '/chef/request/[id]', params: { id: r.id } })} />)}
    </ScrollView>
  );
}
