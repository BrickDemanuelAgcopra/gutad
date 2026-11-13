import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useApi } from '@/hooks';
import { Card, Loading, Muted, s } from '@/ui';
import { ApprovalCard, Pills, type Approval } from '@/ops';

export default function OpsApprovals() {
  const [tab, setTab] = useState<'PENDING' | 'MINE' | 'EXECUTED' | 'REJECTED'>('PENDING');
  const q = tab === 'MINE' ? '?mine=true' : `?status=${tab}`;
  const { data, loading, reload } = useApi<Approval[]>(`/approvals${q}`, { poll: 15000, deps: [tab] });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'PENDING', label: 'Waiting' }, { id: 'MINE', label: 'Mine' }, { id: 'EXECUTED', label: 'Approved' }, { id: 'REJECTED', label: 'Rejected' }]} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <Card><Muted>Nothing here.</Muted></Card>}
      {data?.map((a) => <ApprovalCard key={a.id} a={a} onDone={reload} />)}
    </ScrollView>
  );
}
