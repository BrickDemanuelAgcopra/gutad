import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { REVIEW_TAG_LABELS, REVIEW_TAGS_POSITIVE } from '@gutad/shared';
import { api, money, when } from '../api';
import { useAction, useApi } from '../hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '../ui';
import { Pills } from '../ops';
import { label } from './common';

interface Entry { id: string; kind: string; deliveryJobId: string | null; baseCents: number; distanceCents: number; timeCents: number; waitingCents: number; returnCents: number; tipCents: number; bonusCents: number; totalCents: number; reason: string | null; availableAt: string | null; createdAt: string }
interface Earnings {
  payableCents: number; pendingCents: number; availableCents: number;
  entries: Entry[]; days: { date: string; cents: number; deliveries: number }[]; weeks: { weekStart: string; cents: number; deliveries: number }[];
  payouts: { id: string; amountCents: number; status: string; failureReason: string | null; periodStart: string; periodEnd: string; paidAt: string | null }[];
  payoutAccount: { method: string; accountLast4: string } | null;
}
interface Feedback { ratingAvg: number | null; ratingCount: number; tagCounts: Record<string, number>; recent: { id: string; rating: number; tags: string[]; comment: string | null; createdAt: string; excluded: boolean; disputeStatus: string | null }[] }

const PARTS: [keyof Entry, string][] = [['baseCents', 'Base'], ['distanceCents', 'Distance'], ['timeCents', 'Time'], ['waitingCents', 'Waiting'], ['returnCents', 'Return'], ['bonusCents', 'Bonus'], ['tipCents', 'Tip']];
const day = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export function CourierEarnings({ refreshKey }: { refreshKey?: unknown }) {
  const { data: e, reload } = useApi<Earnings>('/driver/earnings', { deps: [refreshKey] });
  const [view, setView] = useState<'trips' | 'days' | 'weeks' | 'payouts'>('trips');
  const [open, setOpen] = useState<string | null>(null);
  const [dispute, setDispute] = useState<{ jobId?: string; note: string } | null>(null);
  const [sent, setSent] = useState(false);
  const { run, error, busy } = useAction();
  if (!e) return <Loading />;
  return (
    <>
      <Card title="Earnings">
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}><Muted>Available</Muted><Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{money(e.availableCents)}</Text></View>
          <View style={{ flex: 1 }}><Muted>Pending</Muted><Text style={{ fontSize: 20, fontWeight: '800', color: C.ink5 }}>{money(e.pendingCents)}</Text></View>
        </View>
        <Muted>Pending earnings become available after a short hold and are paid out weekly{e.payoutAccount ? ` to the account ending ${e.payoutAccount.accountLast4}` : ''}.</Muted>
      </Card>
      <Pills value={view} onChange={setView} options={[{ id: 'trips', label: 'Trips' }, { id: 'days', label: 'Days' }, { id: 'weeks', label: 'Weeks' }, { id: 'payouts', label: 'Payouts' }]} />
      {view === 'trips' && (
        <Card>
          {!e.entries.length && <Muted>No earnings yet.</Muted>}
          {e.entries.map((x) => (
            <Pressable key={x.id} onPress={() => setOpen(open === x.id ? null : x.id)} style={{ paddingVertical: 6, borderBottomWidth: 1, borderColor: C.ink1 }}>
              <View style={s.row}><Text style={{ color: C.ink, flex: 1 }}>{label(x.kind)} · {when(x.createdAt)}</Text><Text style={{ fontWeight: '700', color: x.totalCents < 0 ? C.bad : C.ink }}>{money(x.totalCents)}</Text></View>
              {x.availableAt && new Date(x.availableAt) > new Date() && <Muted>Available {when(x.availableAt)}</Muted>}
              {open === x.id && (
                <View style={{ marginTop: 4 }}>
                  {PARTS.filter(([k]) => (x[k] as number) > 0).map(([k, l]) => <View key={k} style={s.row}><Muted>{l}</Muted><Muted>{money(x[k] as number)}</Muted></View>)}
                  {x.reason && <Muted>{x.reason}</Muted>}
                  {x.deliveryJobId && <Button title="Question this payment" variant="ghost" onPress={() => { setDispute({ jobId: x.deliveryJobId!, note: '' }); setSent(false); }} />}
                </View>
              )}
            </Pressable>
          ))}
        </Card>
      )}
      {view === 'days' && <Card>{e.days.map((d) => <View key={d.date} style={s.row}><Text style={{ color: C.ink }}>{day(d.date)}</Text><Text>{money(d.cents)} · {d.deliveries}</Text></View>)}{!e.days.length && <Muted>Nothing yet.</Muted>}</Card>}
      {view === 'weeks' && <Card>{e.weeks.map((w) => <View key={w.weekStart} style={s.row}><Text style={{ color: C.ink }}>Week of {day(w.weekStart)}</Text><Text>{money(w.cents)} · {w.deliveries}</Text></View>)}{!e.weeks.length && <Muted>Nothing yet.</Muted>}</Card>}
      {view === 'payouts' && (
        <Card>
          {e.payouts.map((p) => (
            <View key={p.id} style={{ marginBottom: 6 }}>
              <View style={s.row}><Text style={{ color: C.ink }}>{day(p.periodStart)} – {day(p.periodEnd)}</Text><Text style={{ fontWeight: '700' }}>{money(p.amountCents)}</Text></View>
              <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={label(p.status)} tone={tone(p.status)} />{p.paidAt && <Muted>Paid {when(p.paidAt)}</Muted>}</View>
              {p.failureReason && <Text style={{ color: C.bad, fontSize: 13 }}>{p.failureReason}. Check your payout details in your application.</Text>}
            </View>
          ))}
          {!e.payouts.length && <Muted>No payouts yet.</Muted>}
        </Card>
      )}
      <Card title="Something not right?">
        {sent && <Text style={{ color: C.good }}>Sent. Our courier team will look into it.</Text>}
        {!dispute ? <Button title="Question my earnings" variant="secondary" onPress={() => { setDispute({ note: '' }); setSent(false); }} /> : (
          <>
            {dispute.jobId && <Muted>About one delivery.</Muted>}
            <Input label="What’s wrong?" multiline value={dispute.note} onChangeText={(v) => setDispute({ ...dispute, note: v })} />
            <ErrorText msg={error} />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button title="Send" disabled={busy || dispute.note.trim().length < 10} onPress={() => run(async () => { await api.post('/driver/earnings/dispute', { deliveryJobId: dispute.jobId, note: dispute.note.trim() }); setDispute(null); setSent(true); await reload(); })} />
              <Button title="Cancel" variant="ghost" onPress={() => setDispute(null)} />
            </View>
          </>
        )}
      </Card>
    </>
  );
}

export function CourierFeedback() {
  const { data: f, reload } = useApi<Feedback>('/driver/feedback');
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { run, error, busy } = useAction();
  if (!f) return <Loading />;
  const tags = Object.entries(f.tagCounts).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <Card title="Customer feedback">
        <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink }}>{f.ratingAvg == null ? '—' : `${f.ratingAvg.toFixed(2)} ★`}</Text>
        <Muted>{f.ratingCount} rating{f.ratingCount === 1 ? '' : 's'}. Delays at the kitchen and sealed-bag issues don’t count against you.</Muted>
        {tags.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>{tags.map(([k, n]) => <Badge key={k} text={`${REVIEW_TAG_LABELS[k] || label(k)} · ${n}`} tone={(REVIEW_TAGS_POSITIVE as readonly string[]).includes(k) ? 'good' : 'warn'} />)}</View>}
      </Card>
      <Card title="Recent">
        {!f.recent.length && <Muted>No ratings yet.</Muted>}
        {f.recent.map((r) => (
          <View key={r.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderColor: C.ink1 }}>
            <View style={s.row}><Text style={{ color: C.brand, fontWeight: '700' }}>{'★'.repeat(r.rating)}<Text style={{ color: C.ink3 }}>{'★'.repeat(5 - r.rating)}</Text></Text><Muted>{when(r.createdAt)}</Muted></View>
            {r.tags.length > 0 && <Muted>{r.tags.map((t) => REVIEW_TAG_LABELS[t] || label(t)).join(' · ')}</Muted>}
            {r.comment && <Text style={{ color: C.ink7 }}>“{r.comment}”</Text>}
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>{r.excluded && <Badge text="Not counted" tone="info" />}{r.disputeStatus && r.disputeStatus !== 'NONE' && <Badge text={`Dispute: ${label(r.disputeStatus)}`} tone={tone(r.disputeStatus)} />}</View>
            {!r.excluded && (!r.disputeStatus || r.disputeStatus === 'NONE') && (open === r.id ? (
              <View>
                <Input label="Why is this rating unfair?" multiline value={note} onChangeText={setNote} />
                <ErrorText msg={error} />
                <View style={{ flexDirection: 'row', gap: 6 }}><Button title="Send dispute" disabled={busy || note.trim().length < 10} onPress={() => run(async () => { await api.post(`/driver/feedback/${r.id}/dispute`, { note: note.trim() }); setNote(''); setOpen(null); await reload(); })} /><Button title="Cancel" variant="ghost" onPress={() => setOpen(null)} /></View>
              </View>
            ) : <Button title="Dispute" variant="ghost" onPress={() => { setOpen(r.id); setNote(''); }} />)}
          </View>
        ))}
      </Card>
    </>
  );
}
