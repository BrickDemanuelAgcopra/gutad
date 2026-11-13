import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { when } from '@/api';
import { useApi } from '@/hooks';
import { Badge, Button, C, Card, Input, Loading, Muted, s } from '@/ui';

interface Row { id: string; createdAt: string; actorEmail: string | null; action: string; entityType: string; entityId: string; reason: string | null; grantId: string | null; ip: string | null }

/** Audit history on mobile: recent entries, filter by person or action. Export lives on the web console. */
export default function OpsAudit() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('?limit=100');
  const { data, loading } = useApi<Row[]>(`/admin/audit/search${q}`, { deps: [q] });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card>
        <Input label="Person (email)" autoCapitalize="none" value={actor} onChangeText={setActor} />
        <Input label="Action starts with" autoCapitalize="none" placeholder="staff., approval., location." value={action} onChangeText={setAction} />
        <Button title="Search" onPress={() => setQ(`?limit=100${actor ? `&actor=${encodeURIComponent(actor)}` : ''}${action ? `&action=${encodeURIComponent(action)}` : ''}`)} />
      </Card>
      {loading && !data && <Loading />}
      {data?.map((r) => (
        <Card key={r.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{r.action}</Text>{r.grantId && <Badge text="grant" tone="bad" />}</View>
          <Muted>{r.entityType} {r.entityId.slice(0, 8)} · {r.actorEmail || 'system'} · {when(r.createdAt)}</Muted>
          {r.reason && <Text style={{ color: C.ink7, fontStyle: 'italic', marginTop: 4 }}>“{r.reason}”</Text>}
        </Card>
      ))}
      {data?.length === 0 && <Card><Muted>No matching entries.</Muted></Card>}
    </ScrollView>
  );
}
