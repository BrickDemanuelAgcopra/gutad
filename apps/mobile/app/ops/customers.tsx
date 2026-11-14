import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';

interface Row { id: string; name: string | null; email: string; phone: string | null; status: string; isGuest: boolean; orders: number; spendCents: number; lastOrderAt: string | null }
interface Profile {
  customer: { id: string; name: string | null; email: string; phone: string | null; status: string; createdAt: string };
  stats: { orders: number; spendCents: number };
  orders: { id: string; number: string; status: string; totalCents: number; createdAt: string }[];
  incidents: { id: string; category: string; status: string; remedyCents: number }[];
  credits: { balanceCents: number };
  restrictions: { id: string; kind: string; reason: string; liftedAt: string | null; appealStatus: string; appealNote: string | null }[];
  goodwill: { count90d: number; cents90d: number; overCount: boolean; overCents: boolean };
  duplicates: { id: string; email: string; why: string[] }[];
}

/** Customers on the phone: search, 360 summary, restrict / lift, send recovery, appeals. Merges, segments and privacy decisions are on the web console. */
export default function OpsCustomers() {
  const [tab, setTab] = useState<'search' | 'appeals'>('search');
  const [sel, setSel] = useState<string | null>(null);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={(t) => { setTab(t); setSel(null); }} options={[{ id: 'search', label: 'Customers' }, { id: 'appeals', label: 'Appeals' }]} />
      {sel ? <Customer id={sel} onBack={() => setSel(null)} /> : tab === 'search' ? <Search onOpen={setSel} /> : <Appeals onOpen={setSel} />}
    </ScrollView>
  );
}

function Search({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [qs, setQs] = useState('');
  const { data } = useApi<{ total: number; items: Row[] }>(`/admin/customers?q=${encodeURIComponent(qs)}&limit=30`, { deps: [qs] });
  return (
    <>
      <Input label="Name, email, phone or id" value={q} onChangeText={setQ} onSubmitEditing={() => setQs(q)} autoCapitalize="none" />
      <Button title="Search" onPress={() => setQs(q)} />
      {data?.items.map((r) => (
        <Pressable key={r.id} onPress={() => onOpen(r.id)}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink }}>{r.name || r.email}</Text><Badge text={r.status} tone={tone(r.status)} /></View>
            <Muted>{r.email}{r.phone ? ` · ${r.phone}` : ''}</Muted>
            <Muted>{r.orders} orders · {money(r.spendCents)} · last {when(r.lastOrderAt)}</Muted>
          </Card>
        </Pressable>
      ))}
    </>
  );
}

function Appeals({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, reload } = useApi<{ id: string; userId: string; kind: string; reason: string; appealNote: string; email: string; name: string | null }[]>('/admin/appeals');
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  if (!data) return <Loading />;
  return (
    <>
      <ErrorText msg={error} />
      {!data.length && <Card><Muted>No appeals waiting.</Muted></Card>}
      {data.map((a) => (
        <Card key={a.id} title={`${a.name || a.email} · ${a.kind.toLowerCase().replace(/_/g, ' ')}`}>
          <Muted>Restricted: {a.reason}</Muted>
          <Text style={{ marginVertical: 4 }}>“{a.appealNote}”</Text>
          <Input label="Decision note" value={note} onChangeText={setNote} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button title="Lift" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/restrictions/${a.id}/appeal-decision`, { lift: true, note }); setNote(''); reload(); })} />
            <Button title="Uphold" variant="secondary" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/restrictions/${a.id}/appeal-decision`, { lift: false, note }); setNote(''); reload(); })} />
            <Button title="Profile" variant="ghost" onPress={() => onOpen(a.userId)} />
          </View>
        </Card>
      ))}
    </>
  );
}

function Customer({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useSession();
  const { data: p, reload } = useApi<Profile>(`/admin/customers/${id}`);
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  if (!p) return <Loading />;
  const c = p.customer;
  const restrict = (kind: string) => run(async () => { await api.post(`/admin/customers/${id}/restrictions`, { kind, reason }); setReason(''); reload(); });
  return (
    <>
      <Button title="← Back" variant="ghost" onPress={onBack} />
      <Card title={c.name || c.email}>
        <Muted>{c.email}{c.phone ? ` · ${c.phone}` : ''} · since {when(c.createdAt)}</Muted>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}><Badge text={c.status} tone={tone(c.status)} />{(p.goodwill.overCount || p.goodwill.overCents) && <Badge text="goodwill cap reached" tone="warn" />}</View>
        <Text style={{ marginTop: 6 }}>{p.stats.orders} orders · {money(p.stats.spendCents)} · credit {money(p.credits.balanceCents)}</Text>
        <Muted>Goodwill 90 days: {p.goodwill.count90d}× {money(p.goodwill.cents90d)}</Muted>
      </Card>
      <Card title="Recent orders">{p.orders.slice(0, 8).map((o) => <View key={o.id} style={s.row}><Text>{o.number}</Text><Muted>{o.status.toLowerCase()} · {money(o.totalCents)}</Muted></View>)}{!p.orders.length && <Muted>None.</Muted>}</Card>
      <Card title="Complaints">{p.incidents.slice(0, 8).map((i) => <Muted key={i.id}>{i.category.toLowerCase().replace(/_/g, ' ')} · {i.status.toLowerCase()}{i.remedyCents ? ` · ${money(i.remedyCents)}` : ''}</Muted>)}{!p.incidents.length && <Muted>None.</Muted>}</Card>
      <Card title="Restrictions">
        {p.restrictions.map((r) => <View key={r.id} style={{ marginBottom: 6 }}><Text>{r.kind.toLowerCase().replace(/_/g, ' ')}{r.liftedAt ? ' (lifted)' : ''}</Text><Muted>{r.reason}</Muted>{!r.liftedAt && can('support.manage') && <Button title="Lift (uses reason below)" variant="ghost" disabled={reason.length < 3} onPress={() => run(async () => { await api.post(`/admin/restrictions/${r.id}/lift`, { note: reason }); setReason(''); reload(); })} />}</View>)}
        {can('support.manage') && <><Input label="Reason (for restrict, lift or recovery)" value={reason} onChangeText={setReason} /><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Button title="Block ordering" variant="danger" disabled={reason.length < 5} onPress={() => restrict('ORDERING_BLOCKED')} /><Button title="Block promos" variant="secondary" disabled={reason.length < 5} onPress={() => restrict('PROMOTIONS_BLOCKED')} /><Button title="Review refunds" variant="secondary" disabled={reason.length < 5} onPress={() => restrict('REFUND_REVIEW')} /></View></>}
      </Card>
      {can('customers.pii') && <Card title="Account recovery"><Button title="Send recovery link" variant="secondary" disabled={reason.length < 5} onPress={() => run(async () => { await api.post(`/admin/customers/${id}/send-recovery`, { reason }); setOk('Recovery link sent.'); })} /><Muted>Enter a reason above first.</Muted></Card>}
      {!!p.duplicates.length && <Card title="Possible duplicates">{p.duplicates.map((d) => <Muted key={d.id}>{d.email} · {d.why.join(', ')}</Muted>)}<Muted>Merge accounts on the web console.</Muted></Card>}
      {ok && <Text style={{ color: C.good }}>{ok}</Text>}
      <ErrorText msg={error} />
    </>
  );
}
