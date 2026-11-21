import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { REVIEW_ISSUES, REVIEW_TAG_LABELS } from '@gutad/shared';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';

interface Row {
  id: string; deliveryJobId: string; orderId: string; driverId: string; driverName: string | null; rating: number; tags: string[]; comment: string | null; foodRating: number | null; packagingRating: number | null; issues: string[];
  status: string; excluded: boolean; excludedReason: string | null; disputeStatus: string | null; disputeNote: string | null; history: { action?: string; note?: string; at?: string; by?: string }[] | null; createdAt: string;
}
type Filter = 'PENDING_MODERATION' | 'DISPUTED' | 'ALL';
const ACTIONS = [['APPROVE', 'Approve', 'primary'], ['HIDE', 'Hide', 'secondary'], ['EXCLUDE', 'Exclude from score', 'secondary'], ['RESTORE', 'Restore', 'ghost']] as const;
const DISPUTE_ACTIONS = [['UPHOLD_DISPUTE', 'Uphold dispute', 'primary'], ['REJECT_DISPUTE', 'Reject dispute', 'secondary']] as const;
const lc = (x: string) => x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, ' ');

/** Delivery review moderation: customer ratings of couriers waiting for moderation, and courier disputes. */
export default function OpsDeliveryReviews() {
  const { can, ready } = useSession();
  const [filter, setFilter] = useState<Filter>('PENDING_MODERATION');
  const allowed = can('delivery.read');
  const { data, reload } = useApi<Row[]>(allowed ? `/admin/delivery-reviews?status=${filter}` : null, { deps: [filter, allowed] });
  const { run, error, busy } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!ready) return null;
  if (!allowed) return <View style={[s.screen, s.pad]}><Card title="Delivery reviews"><Muted>You don’t have access to delivery reviews.</Muted></Card></View>;
  const manage = can('delivery.manage') || can('support.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} options={[{ id: 'PENDING_MODERATION', label: 'To moderate' }, { id: 'DISPUTED', label: 'Disputed' }, { id: 'ALL', label: 'All' }]} />
      <ErrorText msg={error} />
      {!data ? <Loading /> : !data.length ? <Card><Muted>Nothing here.</Muted></Card> : data.map((r) => (
        <Card key={r.id}>
          <Pressable onPress={() => { setOpen(open === r.id ? null : r.id); setNote(''); }}>
            <View style={s.row}>
              <Text style={{ color: C.brand, fontWeight: '700', fontSize: 16 }}>{'★'.repeat(r.rating)}<Text style={{ color: C.ink3 }}>{'★'.repeat(5 - r.rating)}</Text></Text>
              <View style={{ flexDirection: 'row', gap: 4 }}><Badge text={lc(r.status)} tone={r.status === 'VISIBLE' ? 'good' : r.status === 'HIDDEN' ? 'bad' : 'warn'} />{r.excluded && <Badge text="Excluded" tone="info" />}</View>
            </View>
            <Text style={{ color: C.ink, fontWeight: '600' }}>{r.driverName || 'Courier'}</Text>
            <Muted>{when(r.createdAt)} · food {r.foodRating ?? '—'}/5 · packaging {r.packagingRating ?? '—'}/5</Muted>
            {r.tags.length > 0 && <Muted>{r.tags.map((t) => REVIEW_TAG_LABELS[t] || lc(t)).join(' · ')}</Muted>}
            {r.comment && <Text style={{ color: C.ink7, marginTop: 2 }}>“{r.comment}”</Text>}
            {r.issues.length > 0 && <Text style={{ color: C.bad, fontSize: 13 }}>Issues: {r.issues.map((i) => (REVIEW_ISSUES as Record<string, string>)[i] || lc(i)).join(', ')}</Text>}
            {r.excludedReason && <Muted>Excluded: {r.excludedReason}</Muted>}
            {r.disputeStatus && r.disputeStatus !== 'NONE' && <View style={{ marginTop: 4 }}><Badge text={`Dispute ${lc(r.disputeStatus)}`} tone={tone(r.disputeStatus)} />{r.disputeNote && <Muted>Courier: “{r.disputeNote}”</Muted>}</View>}
          </Pressable>
          {open === r.id && (
            <View style={{ marginTop: 8 }}>
              {!!r.history?.length && <View style={{ marginBottom: 6 }}>{r.history.map((h, i) => <Muted key={i}>{h.at ? `${when(h.at)} · ` : ''}{h.action ? lc(h.action) : ''}{h.note ? `: ${h.note}` : ''}</Muted>)}</View>}
              {manage ? (
                <>
                  <Input label="Note (required)" value={note} onChangeText={setNote} />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {(r.disputeStatus && !['NONE', 'UPHELD', 'REJECTED'].includes(r.disputeStatus) ? DISPUTE_ACTIONS : []).map(([a, l, v]) => <Button key={a} title={l} variant={v} disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/delivery-reviews/${r.id}/moderate`, { action: a, note: note.trim() }); setNote(''); setOpen(null); await reload(); })} />)}
                    {ACTIONS.map(([a, l, v]) => <Button key={a} title={l} variant={v} disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/delivery-reviews/${r.id}/moderate`, { action: a, note: note.trim() }); setNote(''); setOpen(null); await reload(); })} />)}
                  </View>
                  <Muted>Excluded ratings stay visible to the courier but don’t count toward their score.</Muted>
                </>
              ) : <Muted>Moderating needs delivery or support management access.</Muted>}
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}
