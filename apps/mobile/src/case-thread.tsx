import { useState } from 'react';
import { Text, View } from 'react-native';
import { api, when } from './api';
import { useAction, useApi } from './hooks';
import { Button, C, ErrorText, Input, Muted } from './ui';

interface Msg { id: string; authorRole: string; authorEmail: string | null; visibility: string; body: string; createdAt: string }

/** Ticket conversation. Staff (`staff`) can also leave internal notes. */
export function CaseThread({ incidentId, staff = false }: { incidentId: string; staff?: boolean }) {
  const { data, reload } = useApi<Msg[]>(`/incidents/${incidentId}/messages`, { deps: [incidentId], poll: 15000 });
  const { run, error } = useAction();
  const [body, setBody] = useState('');
  const send = (visibility: 'PARTIES' | 'INTERNAL') => run(async () => { await api.post(`/incidents/${incidentId}/messages`, { body, visibility }); setBody(''); reload(); });
  return (
    <View style={{ marginTop: 8 }}>
      {(data || []).map((m) => (
        <View key={m.id} style={{ backgroundColor: m.visibility === 'INTERNAL' ? '#fffbeb' : m.authorRole === 'STAFF' ? '#f0f9ff' : C.ink1, borderRadius: 10, padding: 8, marginBottom: 6 }}>
          <Muted>{m.authorEmail} · {when(m.createdAt)}{m.visibility === 'INTERNAL' ? ' · internal' : ''}</Muted>
          <Text style={{ color: C.ink }}>{m.body}</Text>
        </View>
      ))}
      {data?.length === 0 && <Muted>No messages yet.</Muted>}
      <ErrorText msg={error} />
      <Input label={staff ? 'Reply or note' : 'Message support'} value={body} onChangeText={setBody} multiline />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Send" disabled={!body.trim()} onPress={() => send('PARTIES')} />
        {staff && <Button title="Internal note" variant="secondary" disabled={!body.trim()} onPress={() => send('INTERNAL')} />}
      </View>
    </View>
  );
}
