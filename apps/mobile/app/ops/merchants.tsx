import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';

const STAGES = ['LEAD', 'CONTACTED', 'APPLIED', 'APPROVED', 'ONBOARDING', 'LIVE', 'LOST'];
interface App { id: string; businessName: string; contactName: string; email: string; city: string | null; stage: string; ownerEmail: string | null; organizationId: string | null; updatedAt: string }
interface Board { id: string; name: string; status: string; progressPct: number; accountManager: string | null; outstanding: string[] }
interface Perf { locationId: string; name: string; merchant: string; orders: number; acceptanceRate: number | null; cancellationRate: number | null; avgPrepMinutes: number | null; lateRate: number | null }
interface Change { id: string; summary: string; organizationName: string; changes: Record<string, unknown>; status: string }
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

/** Merchants on the phone: sales pipeline, onboarding progress, performance and change requests. */
export default function OpsMerchants() {
  const { can, user } = useSession();
  const [tab, setTab] = useState<'pipeline' | 'onboarding' | 'performance' | 'changes'>('pipeline');
  const { data: pipe, reload: reloadPipe } = useApi<{ counts: Record<string, number>; items: App[] }>(tab === 'pipeline' ? '/admin/pipeline' : null, { deps: [tab] });
  const { data: board } = useApi<Board[]>(tab === 'onboarding' ? '/admin/merchants/onboarding' : null, { deps: [tab] });
  const { data: perf } = useApi<Perf[]>(tab === 'performance' ? '/admin/merchants/performance' : null, { deps: [tab] });
  const { data: changes, reload: reloadChanges } = useApi<Change[]>(tab === 'changes' ? '/admin/change-requests?status=PENDING' : null, { deps: [tab] });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const manage = can('merchants.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'pipeline', label: 'Pipeline' }, { id: 'onboarding', label: 'Onboarding' }, { id: 'performance', label: 'Performance' }, { id: 'changes', label: 'Changes' }]} />
      <ErrorText msg={error} />
      {tab === 'pipeline' && (pipe ? (
        <>
          <Muted>{STAGES.map((st) => `${st.toLowerCase()} ${pipe.counts[st] || 0}`).join(' · ')}</Muted>
          {pipe.items.filter((a) => a.stage !== 'LOST' && a.stage !== 'LIVE').map((a) => (
            <Card key={a.id}>
              <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{a.businessName}</Text><Badge text={a.stage} tone="info" /></View>
              <Muted>{a.contactName} · {a.email} · {a.city || '—'} · {a.ownerEmail || 'unassigned'} · {when(a.updatedAt)}</Muted>
              {manage && !a.organizationId && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {a.stage === 'APPLIED' || a.stage === 'LEAD' ? <Button title="Mark contacted" variant="secondary" onPress={() => run(async () => { await api.patch(`/admin/pipeline/${a.id}`, { stage: 'CONTACTED', ownerId: a.ownerEmail ? undefined : user?.id }); reloadPipe(); })} /> : null}
                  <Button title="Approve & create merchant" onPress={() => run(async () => { await api.post(`/admin/pipeline/${a.id}/convert`, {}); reloadPipe(); })} />
                </View>
              )}
            </Card>
          ))}
        </>
      ) : <Loading />)}
      {tab === 'onboarding' && (board ? board.map((b) => (
        <Card key={b.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{b.name}</Text><Text>{b.progressPct}%</Text></View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: C.ink1, marginVertical: 4 }}><View style={{ height: 6, borderRadius: 3, backgroundColor: C.brand, width: `${b.progressPct}%` }} /></View>
          <Muted>{b.status.toLowerCase()} · {b.accountManager || 'no account manager'}</Muted>
          {b.outstanding.length > 0 && <Muted>Open: {b.outstanding.slice(0, 3).join('; ')}</Muted>}
        </Card>
      )) : <Loading />)}
      {tab === 'performance' && (perf ? perf.filter((p) => p.orders > 0).map((p) => (
        <Card key={p.locationId}>
          <Text style={{ fontWeight: '600', color: C.ink }}>{p.name} <Text style={{ color: C.ink5, fontWeight: '400' }}>· {p.merchant}</Text></Text>
          <Muted>{p.orders} orders · accept {pct(p.acceptanceRate)} · cancel {pct(p.cancellationRate)} · late {pct(p.lateRate)} · prep {p.avgPrepMinutes ?? '—'} min</Muted>
        </Card>
      )) : <Loading />)}
      {tab === 'changes' && (changes ? (
        <>
          {changes.length === 0 && <Card><Muted>Nothing waiting.</Muted></Card>}
          {changes.map((c) => (
            <Card key={c.id} title={c.summary}>
              <Muted>{c.organizationName}</Muted>
              {Object.entries(c.changes).map(([k, v]) => <Muted key={k}>{k}: {JSON.stringify(v)}</Muted>)}
              {manage && <><Input label="Note (required to reject)" value={note} onChangeText={setNote} /><Button title="Approve & apply" onPress={() => run(async () => { await api.post(`/admin/change-requests/${c.id}/approve`, {}); reloadChanges(); })} /><Button title="Reject" variant="danger" disabled={note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/change-requests/${c.id}/reject`, { note }); setNote(''); reloadChanges(); })} /></>}
            </Card>
          ))}
        </>
      ) : <Loading />)}
    </ScrollView>
  );
}
