import { useState } from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';

const RESTRICTION_TEXT: Record<string, string> = { ORDERING_BLOCKED: 'Ordering is paused on your account', PROMOTIONS_BLOCKED: 'Promotions are paused on your account', REFUND_REVIEW: 'Refund requests are reviewed by a second person' };
const TOPIC_TEXT: Record<string, string> = { orders: 'Order updates', reservations: 'Reservations', account: 'Account & security', marketing: 'Offers' };

/** Customer self-service: account notices & appeals, saved cards, notification preferences, privacy. */
export default function Me() {
  const { user } = useSession();
  const [tab, setTab] = useState<'payments' | 'notifications' | 'privacy'>('payments');
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in first.</Muted></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Restrictions />
      <Pills value={tab} onChange={setTab} options={[{ id: 'payments', label: 'Payments' }, { id: 'notifications', label: 'Notifications' }, { id: 'privacy', label: 'Privacy' }]} />
      {tab === 'payments' && <Payments />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'privacy' && <Privacy />}
    </ScrollView>
  );
}

function Restrictions() {
  const { data, reload } = useApi<{ id: string; kind: string; reason: string; expiresAt: string | null; appealStatus: string; appealDecisionNote: string | null }[]>('/me/restrictions');
  const [note, setNote] = useState('');
  const { run, error } = useAction();
  if (!data?.length) return null;
  return (
    <Card title="Account notice">
      {data.map((r) => (
        <View key={r.id} style={{ marginBottom: 8 }}>
          <Text style={{ color: C.warn, fontWeight: '600' }}>{RESTRICTION_TEXT[r.kind] || r.kind}{r.expiresAt ? ` until ${when(r.expiresAt)}` : ''}</Text>
          <Muted>Reason: {r.reason}</Muted>
          {r.appealStatus === 'PENDING' && <Muted>Your appeal is being reviewed.</Muted>}
          {r.appealStatus === 'UPHELD' && <Muted>Appeal reviewed: {r.appealDecisionNote}</Muted>}
          {['NONE', 'UPHELD'].includes(r.appealStatus) && <><Input label="Appeal (tell us what happened)" multiline value={note} onChangeText={setNote} /><Button title="Send appeal" disabled={note.trim().length < 10} onPress={() => run(async () => { await api.post(`/me/restrictions/${r.id}/appeal`, { note }); setNote(''); reload(); })} /></>}
        </View>
      ))}
      <ErrorText msg={error} />
    </Card>
  );
}

function Payments() {
  const { data, reload } = useApi<{ id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean }[]>('/me/payment-methods');
  const { run, error } = useAction();
  const [num, setNum] = useState('');
  if (!data) return <Loading />;
  return (
    <>
      <Card title="Saved cards">
        {!data.length && <Muted>No saved cards yet.</Muted>}
        {data.map((c) => (
          <View key={c.id} style={[s.row, { marginBottom: 6 }]}>
            <Text style={{ flex: 1 }}>{c.brand} •••• {c.last4}{c.isDefault ? ' (default)' : ''}</Text>
            {!c.isDefault && <Button title="Default" variant="ghost" onPress={() => run(async () => { await api.post(`/me/payment-methods/${c.id}/default`, {}); reload(); })} />}
            <Button title="Remove" variant="ghost" onPress={() => run(async () => { await api.delete(`/me/payment-methods/${c.id}`); reload(); })} />
          </View>
        ))}
      </Card>
      <Card title="Add a card">
        <Input label="Card number" keyboardType="number-pad" value={num} onChangeText={setNum} />
        <ErrorText msg={error} />
        <Button title="Save card" disabled={num.replace(/\D/g, '').length < 12} onPress={() => run(async () => { const d = num.replace(/\D/g, ''); await api.post('/me/payment-methods', { paymentMethodId: `mock_pm_${d.slice(-4)}`, last4: d.slice(-4), brand: d.startsWith('4') ? 'visa' : d.startsWith('5') ? 'mastercard' : 'card' }); setNum(''); reload(); })} />
        <Muted>Your card is stored by our payment processor. Gutad keeps only a token and the last 4 digits.</Muted>
      </Card>
    </>
  );
}

function Notifications() {
  const { data, reload } = useApi<{ topics: { topic: string; email: boolean; sms: boolean; push: boolean }[] }>('/me/notification-prefs');
  if (!data) return <Loading />;
  const set = (t: { topic: string; email: boolean; sms: boolean; push: boolean }, ch: 'email' | 'sms' | 'push', v: boolean) => api.put('/me/notification-prefs', { topics: [{ ...t, [ch]: v }] }).then(reload);
  return (
    <Card title="How we reach you">
      {data.topics.map((t) => (
        <View key={t.topic} style={{ marginBottom: 10 }}>
          <Text style={{ fontWeight: '600', color: C.ink }}>{TOPIC_TEXT[t.topic] || t.topic}</Text>
          <View style={{ flexDirection: 'row', gap: 14, marginTop: 4 }}>{(['email', 'sms', 'push'] as const).map((ch) => <View key={ch} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Switch value={!!t[ch]} onValueChange={(v) => set(t, ch, v)} /><Text>{ch}</Text></View>)}</View>
        </View>
      ))}
      <Muted>In-app notices and essential account emails are always sent.</Muted>
    </Card>
  );
}

function Privacy() {
  const { data, reload } = useApi<{ id: string; kind: string; status: string; scheduledFor: string | null; createdAt: string }[]>('/me/data-requests');
  const { run, error } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const pending = data?.find((r) => r.kind === 'DELETE' && r.status === 'PENDING');
  return (
    <>
      <Card title="Your data">
        <Muted>Request a copy of your profile, orders and preferences. We email it to you from the web account page; on the phone we confirm the request.</Muted>
        <Button title="Request my data" variant="secondary" onPress={() => run(async () => { await api.post('/me/data-request', { kind: 'ACCESS' }); setMsg('Your data export is ready on gutad.io → Account → Privacy.'); reload(); })} />
      </Card>
      <Card title="Delete account">
        {pending ? (
          <><Text>Scheduled for deletion on {when(pending.scheduledFor)}.</Text><Button title="Keep my account" variant="secondary" onPress={() => run(async () => { await api.post(`/me/data-request/${pending.id}/cancel`, {}); setMsg('Deletion canceled.'); reload(); })} /></>
        ) : (
          <><Muted>We remove your name, contact details, addresses and cards after a grace period. Receipts are kept without personal details as the law requires. Open orders or disputes must finish first.</Muted>
            <Button title="Delete my account" variant="danger" onPress={() => Alert.alert('Delete your account?', 'You can cancel during the grace period.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run(async () => { const r = await api.post<{ note?: string }>('/me/data-request', { kind: 'DELETE' }); setMsg(r.note || 'Deletion requested.'); reload(); }) }])} /></>
        )}
      </Card>
      {msg && <Card><Text style={{ color: C.good }}>{msg}</Text></Card>}
      <ErrorText msg={error} />
      {!!data?.length && <Card title="Request history">{data.map((r) => <Muted key={r.id}>{r.kind === 'ACCESS' ? 'Data copy' : 'Deletion'} · {r.status.toLowerCase()} · {when(r.createdAt)}</Muted>)}</Card>}
    </>
  );
}
