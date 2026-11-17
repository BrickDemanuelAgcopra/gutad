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
const Q = { review: 'SUBMITTED,IN_REVIEW,APPEALED', changes: 'CHANGES_REQUESTED', waitlist: 'WAITLISTED', approved: 'APPROVED', dishes: '' } as const;
interface RDish { id: string; title: string; chefName: string; kind: string; priceCents: number; portionDesc: string; ingredients: string[]; allergens: string[]; allergensConfirmed: boolean; photos: string[]; pendingChanges: Record<string, unknown> | null; missing: string[] }

/** Chef applications on the phone: queue, documents, approve / decline / waitlist. */
export default function OpsChefs() {
  const [q, setQ] = useState<keyof typeof Q>('review');
  const [sel, setSel] = useState<string | null>(null);
  const { data, reload } = useApi<{ items: Row[] }>(q === 'dishes' ? null : `/admin/chef-applications?status=${Q[q]}`, { deps: [q], poll: 30000 });
  if (q === 'dishes') return <ScrollView style={s.screen} contentContainerStyle={s.pad}><Pills value={q} onChange={setQ} options={[{ id: 'review', label: 'To review' }, { id: 'changes', label: 'Waiting on chef' }, { id: 'waitlist', label: 'Waitlist' }, { id: 'approved', label: 'Approved' }, { id: 'dishes', label: 'Dishes' }]} /><DishQueue /></ScrollView>;
  if (sel) return <AppDetail id={sel} onBack={() => { setSel(null); void reload(); }} />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={q} onChange={setQ} options={[{ id: 'review', label: 'To review' }, { id: 'changes', label: 'Waiting on chef' }, { id: 'waitlist', label: 'Waitlist' }, { id: 'approved', label: 'Approved' }, { id: 'dishes', label: 'Dishes' }]} />
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

/** Dish review on the phone: new listings and changes to live dishes. */
function DishQueue() {
  const { can } = useSession();
  const { data, reload } = useApi<RDish[]>('/admin/chef-dishes/review');
  const { data: extras, reload: reloadExtras } = useApi<{ id: string; name: string; chefName: string; priceCents: number; allergens: string[] }[]>('/admin/chef-extras/review');
  const { run, error, busy } = useAction();
  const [note, setNote] = useState<Record<string, string>>({});
  if (!data) return <Loading />;
  const extrasCard = !!extras?.length && <Card title="Extras waiting for approval">{extras.map((e) => <View key={e.id} style={{ marginBottom: 8 }}><Text style={{ fontWeight: '600' }}>{e.name} · {e.chefName}</Text><Muted>${(e.priceCents / 100).toFixed(2)} · allergens: {e.allergens.join(', ') || 'none'}</Muted>{can('chefs.manage') && <View style={{ flexDirection: 'row', gap: 6 }}><Button style={{ flex: 1 }} title="Approve" disabled={busy} onPress={() => run(async () => { await api.post(`/admin/chef-extras/${e.id}/review`, { approve: true }); await reloadExtras(); })} /><Button style={{ flex: 1 }} variant="secondary" title="Reject" disabled={busy} onPress={() => run(async () => { await api.post(`/admin/chef-extras/${e.id}/review`, { approve: false, note: 'Not approved as an extra; please contact Gutad' }); await reloadExtras(); })} /></View>}</View>)}</Card>;
  if (!data.length) return <View>{extrasCard}<Card><Muted>No dishes waiting for review.</Muted></Card></View>;
  return (
    <View>
      <ErrorText msg={error} />
      {extrasCard}
      {data.map((d) => (
        <Card key={d.id}>
          {d.photos[0] && <Image source={{ uri: d.photos[0] }} style={{ width: '100%', height: 140, borderRadius: 10, marginBottom: 6 }} />}
          <Text style={{ fontWeight: '700' }}>{d.title}</Text>
          <Badge text={d.kind === 'NEW_LISTING' ? 'New listing' : 'Change to live dish'} tone={d.kind === 'NEW_LISTING' ? 'info' : 'warn'} />
          <Muted>{d.portionDesc} · ${(d.priceCents / 100).toFixed(2)}</Muted>
          <Muted>Ingredients: {d.ingredients.join(', ')}</Muted>
          <Text style={{ color: d.allergensConfirmed ? C.ink7 : C.bad, fontSize: 12 }}>Allergens: {d.allergens.join(', ') || 'none'}{d.allergensConfirmed ? '' : ' (not confirmed)'}</Text>
          {d.pendingChanges && <Text style={{ fontSize: 12, color: C.warn, marginTop: 4 }}>Proposed: {Object.entries(d.pendingChanges).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ')}</Text>}
          {can('chefs.manage') && <>
            <Input placeholder="Note to the chef (needed to send back)" value={note[d.id] || ''} onChangeText={(t) => setNote({ ...note, [d.id]: t })} />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button style={{ flex: 1 }} title="Approve" disabled={busy} onPress={() => run(async () => { await api.post(`/admin/chef-dishes/${d.id}/review`, { decision: 'APPROVE' }); await reload(); })} />
              <Button style={{ flex: 1 }} variant="secondary" title="Send back" disabled={busy || (note[d.id] || '').trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/chef-dishes/${d.id}/review`, { decision: 'CHANGES', note: note[d.id] }); await reload(); })} />
            </View>
          </>}
        </Card>
      ))}
    </View>
  );
}
