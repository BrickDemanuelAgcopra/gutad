import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { Pills } from '@/ops';

interface A { id: string; type: string; severity: string; status: string; title: string; detail: string | null; subjectType: string; subjectId: string; ownerId: string | null; ownerEmail: string | null; ownerRole: string; escalateAt: string | null; escalationLevel: number; history: { at: string; action: string; note: string | null; email?: string }[]; resolution: string | null; createdAt: string }
const sev = (x: string) => (x === 'CRITICAL' || x === 'HIGH' ? 'bad' : x === 'MEDIUM' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';

/** Alerts on the phone: acknowledge, take ownership, comment, resolve. */
export default function OpsAlerts() {
  const router = useRouter();
  const { user } = useSession();
  const [tab, setTab] = useState<'ACTIVE' | 'MINE' | 'RESOLVED'>('ACTIVE');
  const { data, reload } = useApi<A[]>(`/admin/alerts${tab === 'MINE' ? '?mine=true' : `?status=${tab}`}`, { poll: 15000, deps: [tab] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const act = (id: string, action: string, body: Record<string, unknown>) => run(async () => { await api.post(`/admin/alerts/${id}/${action}`, body); setNote(''); reload(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'ACTIVE', label: 'Active' }, { id: 'MINE', label: 'Mine' }, { id: 'RESOLVED', label: 'Resolved' }]} />
      <ErrorText msg={error} />
      {data?.length === 0 && <Card><Muted>No alerts.</Muted></Card>}
      {data?.map((a) => (
        <Card key={a.id}>
          <Pressable onPress={() => setOpen(open === a.id ? null : a.id)}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={a.severity} tone={sev(a.severity)} />{a.status === 'ACKNOWLEDGED' && <Badge text="ACK" tone="info" />}{a.escalationLevel > 0 && <Badge text={`ESCALATED ×${a.escalationLevel}`} tone="bad" />}</View>
            <Text style={{ fontWeight: '600', color: C.ink, marginTop: 4 }}>{a.title}</Text>
            <Muted>Owner {a.ownerEmail || a.ownerRole.toLowerCase()} · {when(a.createdAt)}{a.escalateAt && a.status !== 'RESOLVED' ? ` · escalates ${when(a.escalateAt)}` : ''}</Muted>
          </Pressable>
          {open === a.id && (
            <View style={{ marginTop: 8 }}>
              {a.detail && <Text style={{ marginBottom: 6 }}>{a.detail}</Text>}
              {a.subjectType === 'order' && <Button title="Open order" variant="secondary" onPress={() => router.push(`/ops/order/${a.subjectId}` as never)} />}
              {a.history.map((h, i) => <Muted key={i}>{when(h.at)} · {h.action.toLowerCase()}{h.email ? ` · ${h.email}` : ''}{h.note ? ` — ${h.note}` : ''}</Muted>)}
              {a.status !== 'RESOLVED' ? (
                <>
                  <Input label="Note / resolution" value={note} onChangeText={setNote} />
                  {a.status === 'OPEN' && <Button title="Acknowledge" onPress={() => act(a.id, 'ack', { note: note || undefined })} />}
                  {a.ownerId !== user?.id && <Button title="Take ownership" variant="secondary" onPress={() => act(a.id, 'assign', { ownerId: user?.id, note: note || 'Taking this' })} />}
                  <Button title="Comment" variant="secondary" disabled={!note} onPress={() => act(a.id, 'comment', { note })} />
                  <Button title="Resolve" variant="danger" disabled={note.trim().length < 3} onPress={() => act(a.id, 'resolve', { resolution: note })} />
                </>
              ) : <Muted>Resolution: {a.resolution}</Muted>}
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}
