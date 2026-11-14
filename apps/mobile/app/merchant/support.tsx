import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s, tone } from '@/ui';
import { Pills, WorkspaceGate } from '@/ops';

interface Case { id: string; category: string; description: string; status: string; orderNumber: string | null; aboutMerchant: boolean; reporterType: string; createdAt: string }
interface Msg { id: string; authorRole: string; authorEmail: string | null; body: string; createdAt: string }

function Support() {
  const { loc } = useMerchantLocation();
  const orgId = loc?.organizationId;
  const { data, reload } = useApi<Case[]>(orgId ? `/organizations/${orgId}/cases` : null, { deps: [orgId] });
  const [open, setOpen] = useState<string | null>(null);
  const { data: msgs, reload: reloadMsgs } = useApi<Msg[]>(open ? `/incidents/${open}/messages` : null, { deps: [open] });
  const { run, error } = useAction();
  const [cat, setCat] = useState<'PAYOUT' | 'ORDER_DISPUTE' | 'TECH' | 'OTHER'>('TECH');
  const [desc, setDesc] = useState('');
  const [reply, setReply] = useState('');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Open a case">
        <Pills value={cat} onChange={setCat} options={[{ id: 'TECH', label: 'Tablet / app' }, { id: 'PAYOUT', label: 'Payouts' }, { id: 'ORDER_DISPUTE', label: 'Dispute' }, { id: 'OTHER', label: 'Other' }]} />
        <Input label="What happened?" multiline value={desc} onChangeText={setDesc} />
        <ErrorText msg={error} />
        <Button title="Send to Gutad" disabled={!orgId || desc.length < 5} onPress={() => run(async () => { await api.post(`/organizations/${orgId}/cases`, { category: cat, description: desc }); setDesc(''); reload(); })} />
      </Card>
      {data?.map((c) => (
        <Card key={c.id}>
          <Pressable onPress={() => setOpen(open === c.id ? null : c.id)}>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink }}>{c.category.toLowerCase().replace(/_/g, ' ')}</Text><Badge text={c.status} tone={tone(c.status === 'OPEN' ? 'PENDING' : c.status)} /></View>
            <Muted>{c.aboutMerchant ? `Complaint from a ${c.reporterType.toLowerCase()}` : 'Opened by you'}{c.orderNumber ? ` · ${c.orderNumber}` : ''} · {when(c.createdAt)}</Muted>
            <Text numberOfLines={open === c.id ? undefined : 2}>{c.description}</Text>
          </Pressable>
          {open === c.id && (
            <View style={{ marginTop: 8 }}>
              {msgs?.map((m) => <View key={m.id} style={{ backgroundColor: m.authorRole === 'STAFF' ? '#e0f2fe' : C.ink1, borderRadius: 10, padding: 8, marginBottom: 6 }}><Muted>{m.authorEmail || m.authorRole.toLowerCase()} · {when(m.createdAt)}</Muted><Text>{m.body}</Text></View>)}
              <Input label="Reply" value={reply} onChangeText={setReply} />
              <Button title="Send" disabled={!reply} onPress={() => run(async () => { await api.post(`/incidents/${c.id}/messages`, { body: reply }); setReply(''); reloadMsgs(); reload(); })} />
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/support"><Support /></WorkspaceGate>;
}
