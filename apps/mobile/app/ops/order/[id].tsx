import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';

interface Detail {
  order: { id: string; number: string; status: string; channel: string; fulfillmentType: string; totalCents: number; createdAt: string; promiseAt: string | null; locationName: string; pickupCode: string | null; lines: { id: string; name: string; quantity: number; lineTotalCents: number; status: string }[] };
  events: { type: string; actorRole: string | null; createdAt: string }[];
  tickets: { id: string; stationCode: string; status: string }[];
  payment: { status: string; capturedCents: number; refundedCents: number } | null;
  delivery: { status: string; etaAt: string | null } | null;
  customer: { name: string | null; email: string | null; masked: boolean };
  notes: { id: string; visibility: string; body: string; authorEmail: string | null; createdAt: string }[];
  issues: string[];
  partialFulfillment: boolean;
}

/** One order across payment, kitchen and delivery, with notes, templated messages and the key actions. */
export default function OpsOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/orders/${id}`);
  const { data: tpls } = useApi<{ key: string; title: string; body: string }[]>('/message-templates');
  const { run, error } = useAction();
  const [info, setInfo] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [vis, setVis] = useState<'INTERNAL' | 'CUSTOMER'>('INTERNAL');
  const [tpl, setTpl] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  if (!d) return <Loading />;
  const o = d.order;
  const act = (fn: () => Promise<unknown>) => run(async () => { const r = (await fn()) as { status?: string }; setInfo(r?.status === 'PENDING_APPROVAL' ? 'Sent for approval.' : 'Done.'); reload(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title={`Order ${o.number}`}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={o.status} tone={tone(o.status)} />{d.partialFulfillment && <Badge text="PARTIAL" tone="warn" />}</View>
        <Muted>{o.locationName} · {o.channel.toLowerCase()} · {o.fulfillmentType.toLowerCase()} · {when(o.createdAt)}</Muted>
        <Muted>{d.customer.name || 'Guest'}{d.customer.masked ? '' : ` · ${d.customer.email || ''}`}</Muted>
        {d.issues.map((x) => <Text key={x} style={{ color: C.bad, marginTop: 4 }}>⚠ {x}</Text>)}
        {o.lines.map((l) => <View key={l.id} style={s.row}><Text>{l.quantity}× {l.name}{l.status === 'CREDITED' || l.status === 'UNAVAILABLE' ? ` (${l.status.toLowerCase()})` : ''}</Text><Text>{money(l.lineTotalCents)}</Text></View>)}
        <View style={[s.row, { marginTop: 4 }]}><Text style={{ fontWeight: '700' }}>Total</Text><Text style={{ fontWeight: '700' }}>{money(o.totalCents)}</Text></View>
      </Card>
      <Card title="Payment · kitchen · delivery">
        <Muted>Payment: {d.payment ? `${d.payment.status} · captured ${money(d.payment.capturedCents)} · refunded ${money(d.payment.refundedCents)}` : 'none'}</Muted>
        <Muted>Kitchen: {d.tickets.length ? d.tickets.map((t) => `${t.stationCode} ${t.status.toLowerCase()}`).join(', ') : 'no tickets'}</Muted>
        <Muted>Delivery: {d.delivery ? `${d.delivery.status} · ETA ${when(d.delivery.etaAt)}` : '—'}</Muted>
      </Card>
      {can('orders.manage') && (
        <Card title="Actions">
          <ErrorText msg={error} />{info && <Muted>{info}</Muted>}
          {o.status === 'SUBMITTED' && <Button title="Accept for merchant" onPress={() => act(() => api.post(`/orders/${id}/accept`, {}))} />}
          {['ACCEPTED', 'PREPARING'].includes(o.status) && <Button title="Mark ready" variant="secondary" onPress={() => act(() => api.post(`/orders/${id}/ready`, {}))} />}
          <Input label="Reason (required for credits, refunds and cancels)" value={reason} onChangeText={setReason} />
          <Input label="Credit amount (USD)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          <Button title="Give credit" variant="secondary" disabled={reason.trim().length < 5 || !Number(amount)} onPress={() => act(() => api.post(`/admin/orders/${id}/remedy`, { remedy: 'CREDIT', remedyCents: Math.round(Number(amount) * 100), owner: 'PLATFORM', reason }))} />
          {!['COMPLETED', 'CANCELED', 'REJECTED'].includes(o.status) && <Button title="Cancel order (platform pays)" variant="danger" disabled={reason.trim().length < 5} onPress={() => act(() => api.post(`/orders/${id}/staff-cancel`, { reason, funder: 'PLATFORM' }))} />}
        </Card>
      )}
      <Card title="Notes & messages">
        <Pills value={vis} onChange={setVis} options={[{ id: 'INTERNAL', label: 'Internal note' }, { id: 'CUSTOMER', label: 'Message customer' }]} />
        {vis === 'CUSTOMER' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{tpls?.map((t) => <Button key={t.key} title={t.title} variant={tpl === t.key ? 'primary' : 'secondary'} onPress={() => { setTpl(t.key); setNote(t.body); }} />)}</View>}
        <Input label="Text ({{number}} and {{name}} are filled in)" multiline value={note} onChangeText={setNote} />
        <Button title={vis === 'CUSTOMER' ? 'Send' : 'Add note'} disabled={!note.trim()} onPress={() => act(async () => { await api.post(`/orders/${id}/notes`, { body: note, visibility: vis, templateKey: tpl || undefined }); setNote(''); setTpl(null); })} />
        {d.notes.map((n) => <View key={n.id} style={{ marginTop: 6 }}><Muted>{when(n.createdAt)} · {n.visibility === 'CUSTOMER' ? 'to customer' : 'internal'} · {n.authorEmail}</Muted><Text>{n.body}</Text></View>)}
      </Card>
      <Card title="Timeline">{d.events.map((e, i) => <Muted key={i}>{new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {e.type.toLowerCase()}{e.actorRole ? ` · ${e.actorRole.toLowerCase()}` : ''}</Muted>)}</Card>
    </ScrollView>
  );
}
