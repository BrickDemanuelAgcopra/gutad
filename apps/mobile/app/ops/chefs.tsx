import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { CHEF_APPLICATION_STATUS_LABELS, CHEF_KITCHEN_TYPES, type ChefApplicationData, type ChefApplicationStatus } from '@gutad/shared';
import { api, API_URL, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';
import { Progress } from '@/chef-ui';

interface Row { id: string; status: ChefApplicationStatus; displayName: string | null; email: string; city: string | null; region: string | null; kitchenType: string | null; percentComplete: number; flags: string[]; waitingHours: number | null }
interface Detail { id: string; status: ChefApplicationStatus; data: ChefApplicationData; progress: { percent: number }; requirements: { key: string; label: string; required: boolean }[]; documents: { id: string; requirementKey: string; status: string; fileId: string; expiresAt: string | null }[]; history: { at: string; action: string; note?: string }[] }
const Q = { review: 'SUBMITTED,IN_REVIEW,APPEALED', changes: 'CHANGES_REQUESTED', waitlist: 'WAITLISTED', approved: 'APPROVED' } as const;

/** Chef applications on the phone: queue, documents, approve / decline / waitlist. */
export default function OpsChefs() {
  const [q, setQ] = useState<keyof typeof Q>('review');
  const [sel, setSel] = useState<string | null>(null);
  const { data, reload } = useApi<{ items: Row[] }>(`/admin/chef-applications?status=${Q[q]}`, { deps: [q], poll: 30000 });
  if (sel) return <AppDetail id={sel} onBack={() => { setSel(null); void reload(); }} />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={q} onChange={setQ} options={[{ id: 'review', label: 'To review' }, { id: 'changes', label: 'Waiting on chef' }, { id: 'waitlist', label: 'Waitlist' }, { id: 'approved', label: 'Approved' }]} />
      {!data ? <Loading /> : !data.items.length ? <Card><Muted>Nothing in this queue.</Muted></Card> : data.items.map((r) => (
        <Pressable key={r.id} onPress={() => setSel(r.id)}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '700', flex: 1 }}>{r.displayName || r.email}</Text><Badge text={CHEF_APPLICATION_STATUS_LABELS[r.status]} tone={r.status === 'APPROVED' ? 'good' : 'info'} /></View>
            <Muted>{r.kitchenType ? CHEF_KITCHEN_TYPES[r.kitchenType as keyof typeof CHEF_KITCHEN_TYPES].split(' (')[0] : '—'} · {[r.city, r.region].filter(Boolean).join(', ')}{r.waitingHours !== null ? ` · waiting ${r.waitingHours}h` : ''}</Muted>
            {r.flags.length > 0 && <Text style={{ color: C.warn, fontSize: 12 }}>⚠ {r.flags.join('; ')}</Text>}
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function AppDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/chef-applications/${id}`);
  const { run, error, busy } = useAction();
  const [reason, setReason] = useState('');
  if (!d) return <Loading />;
  const x = d.data;
  const manage = can('chefs.manage');
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const open = (fileId: string) => run(async () => { await Linking.openURL((await api.get<{ url: string }>(`/chef/files/${fileId}/link`)).url); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pressable onPress={onBack}><Text style={{ color: C.brand, marginBottom: 8 }}>‹ Applications</Text></Pressable>
      <Card title={x.identity?.displayName || 'Application'}>
        <Badge text={CHEF_APPLICATION_STATUS_LABELS[d.status]} tone="info" />
        <Progress percent={d.progress.percent} />
        {x.profile?.portraitFileId && <Image source={{ uri: `${API_URL}/public/chef-photos/${x.profile.portraitFileId}` }} style={{ width: 64, height: 64, borderRadius: 32, marginVertical: 6 }} />}
        <Muted>{x.identity?.legalName} · {x.account?.phone}</Muted>
        <Text style={{ marginTop: 6 }}>{x.profile?.bio}</Text>
        <Muted>Kitchen: {x.kitchen?.kitchenType ? CHEF_KITCHEN_TYPES[x.kitchen.kitchenType] : '—'} · {x.kitchen?.addressLine1}, {x.kitchen?.city}, {x.kitchen?.region}</Muted>
        <Muted>Menu: {(x.menu?.dishes || []).map((m) => `Gutad’s ${m.name}`).join(', ')}</Muted>
      </Card>
      <Card title="Documents">
        {d.requirements.map((r) => {
          const doc = d.documents.find((z) => z.requirementKey === r.key);
          return (
            <View key={r.key} style={{ marginBottom: 8 }}>
              <View style={s.row}><Text style={{ flex: 1, fontWeight: '600' }}>{r.label}</Text><Badge text={doc ? doc.status.toLowerCase() : r.required ? 'missing' : 'optional'} tone={doc?.status === 'APPROVED' ? 'good' : doc?.status === 'REJECTED' || (!doc && r.required) ? 'bad' : 'info'} /></View>
              {doc && <View style={{ flexDirection: 'row', gap: 6 }}><Button variant="ghost" title="Open" onPress={() => open(doc.fileId)} />{manage && doc.status !== 'APPROVED' && <Button title="Approve" disabled={busy} onPress={() => act(() => api.post(`/admin/chef-documents/${doc.id}/review`, { status: 'APPROVED' }))} />}{manage && doc.status !== 'REJECTED' && <Button variant="secondary" title="Reject" disabled={busy} onPress={() => act(() => api.post(`/admin/chef-documents/${doc.id}/review`, { status: 'REJECTED', note: 'Unreadable, expired or not the right document; please upload again' }))} />}</View>}
              {doc?.expiresAt && <Muted>Expires {when(doc.expiresAt)}</Muted>}
            </View>
          );
        })}
      </Card>
      <ErrorText msg={error} />
      {manage && ['SUBMITTED', 'IN_REVIEW', 'APPEALED', 'WAITLISTED'].includes(d.status) && (
        <Card title="Decision">
          <Button variant="secondary" title="Assign to me" disabled={busy} onPress={() => act(() => api.post(`/admin/chef-applications/${id}/assign`, {}))} />
          <Input label="Reason (shared with the chef)" value={reason} onChangeText={setReason} />
          <Button title="Approve chef & kitchen" disabled={busy || reason.trim().length < 5} onPress={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'APPROVE', reason }))} />
          <Button variant="secondary" title="Waitlist" disabled={busy || reason.trim().length < 5} onPress={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'WAITLIST', reason }))} />
          <Button variant="danger" title="Decline" disabled={busy || reason.trim().length < 5} onPress={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'REJECT', reason }))} />
        </Card>
      )}
      <Card title="History">{d.history.slice().reverse().map((h, i) => <Muted key={i}>{when(h.at)} · {h.action.toLowerCase().replace(/_/g, ' ')}{h.note ? ` — ${h.note}` : ''}</Muted>)}</Card>
    </ScrollView>
  );
}
