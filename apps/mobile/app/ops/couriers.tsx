import { useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { COURIER_DOC_LABELS, type CourierDocKind } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';

interface Row { id: string; name: string | null; email: string; status: string; operational: string; vehicleType: string; missingDocs: string[]; appealStatus: string; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }
interface Prof { courier: { id: string; name: string | null; email: string; status: string; vehicleType: string; capabilities: string[]; suspendedReason: string | null; appealStatus: string; appealNote: string | null }; documents: { id: string; kind: string; status: string; expiresAt: string | null; fileUrl: string }[]; records: { id: string; kind: string; title: string; createdAt: string }[]; payableCents: number; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; cancellationRate: number | null } }
const pct = (x: number | null | undefined) => (x == null ? '—' : `${x}%`);

/** Couriers on the phone: directory, document review, suspensions and appeals, pay adjustments. */
export default function OpsCouriers() {
  const [tab, setTab] = useState<'all' | 'docs' | 'appeals'>('all');
  const [sel, setSel] = useState<string | null>(null);
  const { data } = useApi<Row[]>('/admin/couriers', { poll: 30000 });
  const { data: docs, reload: reloadDocs } = useApi<{ pending: { id: string; driverId: string; kind: string; fileUrl: string; expiresAt: string | null; courierName: string | null }[] }>(tab === 'docs' ? '/admin/couriers/documents' : null, { deps: [tab] });
  const { run, error } = useAction();
  if (sel) return <Profile id={sel} onBack={() => setSel(null)} />;
  if (!data) return <Loading />;
  const list = tab === 'appeals' ? data.filter((c) => c.appealStatus === 'PENDING') : data;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'all', label: 'Couriers' }, { id: 'docs', label: 'Documents' }, { id: 'appeals', label: 'Appeals' }]} />
      <ErrorText msg={error} />
      {tab === 'docs' ? (
        <>{!docs?.pending.length && <Card><Muted>Nothing to review.</Muted></Card>}{docs?.pending.map((d) => <Card key={d.id}><Text style={{ fontWeight: '600' }}>{d.courierName} · {COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind}</Text><Muted>{d.expiresAt ? `Expires ${when(d.expiresAt)}` : 'No expiry given'}</Muted><View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}><Button title="Open file" variant="ghost" onPress={() => void Linking.openURL(d.fileUrl)} /><Button title="Approve" disabled={!d.expiresAt && d.kind !== 'BACKGROUND_CHECK'} onPress={() => run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked on mobile' }); await reloadDocs(); })} /><Button title="Reject" variant="secondary" onPress={() => run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: false, note: 'Unreadable or not valid; please upload again' }); await reloadDocs(); })} /></View>{!d.expiresAt && d.kind !== 'BACKGROUND_CHECK' && <Muted>Set the expiry date on the web console to approve.</Muted>}</Card>)}</>
      ) : list.map((c) => (
        <Pressable key={c.id} onPress={() => setSel(c.id)}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '700', color: C.ink, flex: 1 }}>{c.name || c.email}</Text><Badge text={c.operational.replace('_', ' ')} tone={c.operational === 'ONLINE' ? 'good' : c.operational === 'ON_DELIVERY' ? 'warn' : c.status === 'SUSPENDED' ? 'bad' : 'neutral'} /></View>
            <Muted>{c.vehicleType.toLowerCase()} · accept {pct(c.metrics?.acceptanceRate)} · complete {pct(c.metrics?.completionRate)} · on time {pct(c.metrics?.onTimeRate)}</Muted>
            {c.missingDocs.length > 0 && <Text style={{ color: C.bad, fontSize: 12 }}>Missing: {c.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind]).join(', ')}</Text>}
            {c.appealStatus === 'PENDING' && <Text style={{ color: C.warn, fontSize: 12 }}>Appeal waiting</Text>}
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Profile({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useSession();
  const { data: p, reload } = useApi<Prof>(`/admin/couriers/${id}`);
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const [amt, setAmt] = useState('');
  if (!p) return <Loading />;
  const c = p.courier;
  const manage = can('delivery.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Button title="← Couriers" variant="ghost" onPress={onBack} />
      <Card title={c.name || c.email}>
        <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={c.status} tone={tone(c.status)} /><Badge text={c.vehicleType} /></View>
        <Muted>Accept {pct(p.metrics?.acceptanceRate)} · complete {pct(p.metrics?.completionRate)} · cancel {pct(p.metrics?.cancellationRate)} · on time {pct(p.metrics?.onTimeRate)}</Muted>
        <Text style={{ marginTop: 4 }}>Payable {money(p.payableCents)}</Text>
      </Card>
      <ErrorText msg={error} />
      {c.status === 'SUSPENDED' && <Card title="Suspended"><Muted>{c.suspendedReason}</Muted>{c.appealStatus === 'PENDING' && <><Text style={{ marginTop: 4 }}>Appeal: “{c.appealNote}”</Text>{manage && <><Input label="Decision note" value={note} onChangeText={setNote} /><View style={{ flexDirection: 'row', gap: 6 }}><Button title="Reinstate" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: true, note }); setNote(''); await reload(); })} /><Button title="Uphold" variant="secondary" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: false, note }); setNote(''); await reload(); })} /></View><Muted>Must be someone other than the person who suspended them.</Muted></>}</>}</Card>}
      <Card title="Documents">{p.documents.map((d) => <View key={d.id} style={s.row}><Text>{COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind}</Text><Text style={{ color: d.status === 'APPROVED' ? C.good : d.status === 'PENDING' ? C.warn : C.bad }}>{d.status.toLowerCase()}{d.expiresAt ? ` · ${new Date(d.expiresAt).toLocaleDateString()}` : ''}</Text></View>)}{!p.documents.length && <Muted>None uploaded.</Muted>}</Card>
      <Card title="Records">{p.records.slice(0, 10).map((r) => <Muted key={r.id}>{r.kind.toLowerCase().replace('_', ' ')} · {r.title} · {when(r.createdAt)}</Muted>)}{!p.records.length && <Muted>None.</Muted>}</Card>
      {manage && <Card title="Actions">
        <Input label="Reason / amount note" value={note} onChangeText={setNote} />
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Input label="Adjustment $ (− for deduction)" keyboardType="numbers-and-punctuation" value={amt} onChangeText={setAmt} /></View><Button title="Post" disabled={!amt || note.length < 5} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/adjustments`, { cents: Math.round(Number(amt) * 100), reason: note }); setAmt(''); setNote(''); await reload(); })} /></View>
        {c.status !== 'SUSPENDED' && <Button title="Suspend courier" variant="danger" disabled={note.length < 5} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/suspend`, { reason: note }); setNote(''); await reload(); })} />}
      </Card>}
    </ScrollView>
  );
}
