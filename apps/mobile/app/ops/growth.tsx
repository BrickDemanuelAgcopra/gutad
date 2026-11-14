import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { MEMBERSHIP_STATUS_LABELS } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { StatTile } from '@/ops';

interface Ov {
  promotions: { orders: number; discountCents: number; platformFundedCents: number; merchantFundedCents: number; salesCents: number; top: { id: string; name: string; merchant: string; orders: number; discountCents: number }[] };
  giftCards: { outstandingCents: number; cards: number; ledgerLiabilityCents: number; redeemedLast30dCents: number; byStatus: { status: string; n: number }[] };
  referrals: { pending: number; review: number; rewarded: number; queue: { id: string; referrer_email: string; referee_email: string; signals: { kind: string; detail: string }[]; reward_points: number }[] };
  memberships: { active: number; trialing: number; past_due: number; suspended: number; canceling: number; recovered30d: number; pastDue: { id: string; email: string; plan: string; status: string; renewalFailures: number; nextRetryAt: string | null; graceUntil: string | null; lastFailureReason: string | null }[] };
  campaigns: { id: string; name: string; holdoutPct: number; spentCents: number; conversions: number }[];
}

/** Growth on the phone: promotion cost, gift-card liability, referral reviews and failed membership payments (quick actions); editing is on the web. */
export default function OpsGrowth() {
  const { can } = useSession();
  const { data, reload } = useApi<Ov>('/admin/growth/overview', { poll: 60000 });
  const { run, error, busy } = useAction();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading />;
  const p = data.promotions, g = data.giftCards, m = data.memberships;
  const pending = g.byStatus.filter((x) => x.status === 'PENDING_REVIEW').reduce((a, x) => a + x.n, 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontWeight: '700', color: C.ink, marginBottom: 6 }}>Promotions, last 30 days</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <StatTile label="Discount given" value={money(p.discountCents)} hint={`${p.orders} orders`} />
        <StatTile label="Gutad / merchants" value={money(p.platformFundedCents)} hint={`merchants ${money(p.merchantFundedCents)}`} />
      </View>
      <Card title="Top promotions">{p.top.length ? p.top.map((t) => <View key={t.id} style={s.row}><Text style={{ flex: 1 }}>{t.name}</Text><Muted>{t.orders} · {money(t.discountCents)}</Muted></View>) : <Muted>No promotions used.</Muted>}</Card>

      <Card title="Gift cards">
        <Text>Outstanding {money(g.outstandingCents)} · {g.cards} cards</Text>
        <Muted>Ledger {money(g.ledgerLiabilityCents)} · spent in 30 days {money(g.redeemedLast30dCents)}{pending ? ` · ${pending} waiting for review (web)` : ''}</Muted>
      </Card>

      <Card title={`Referrals to review (${data.referrals.review})`}>
        <ErrorText msg={error} />
        {msg && <Text style={{ color: C.good }}>{msg}</Text>}
        {data.referrals.queue.length ? data.referrals.queue.map((r) => (
          <View key={r.id} style={{ marginBottom: 10 }}>
            <Text style={{ color: C.ink }}>{r.referrer_email} → {r.referee_email}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 4 }}>{r.signals.map((x) => <Badge key={x.kind} text={x.detail} tone="warn" />)}</View>
            {can('growth.manage') && <View style={{ flexDirection: 'row', gap: 6 }}><Button title="Approve" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/referrals/${r.id}/decision`, { approve: true, note }); setMsg('Approved: points paid.'); setNote(''); reload(); })} /><Button title="Reject" variant="secondary" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/referrals/${r.id}/decision`, { approve: false, note }); setMsg('Rejected.'); setNote(''); reload(); })} /></View>}
          </View>
        )) : <Muted>Nothing waiting. {data.referrals.pending} referrals wait for a first order.</Muted>}
        {can('growth.manage') && data.referrals.queue.length > 0 && <Input label="Note for the decision (required)" value={note} onChangeText={setNote} />}
      </Card>

      <Card title="Memberships">
        <Muted>{m.active} active · {m.trialing} on trial · {m.canceling} canceling · {m.past_due} payment failed · {m.suspended} suspended · {m.recovered30d} recovered in 30 days</Muted>
        {m.pastDue.map((x) => (
          <View key={x.id} style={{ marginTop: 8 }}>
            <View style={s.row}><Text style={{ flex: 1 }}>{x.email}</Text><Badge text={MEMBERSHIP_STATUS_LABELS[x.status] || x.status} tone="warn" /></View>
            <Muted>{x.plan} · {x.renewalFailures} failed · next try {when(x.nextRetryAt)} · benefits until {when(x.graceUntil)}{x.lastFailureReason ? ` · ${x.lastFailureReason}` : ''}</Muted>
            {can('growth.manage') && <Button title="Retry payment now" variant="secondary" disabled={busy} onPress={() => run(async () => { const r = await api.post<{ ok: boolean; error?: string }>(`/admin/memberships/${x.id}/retry`, {}); setMsg(r.ok ? `${x.email} is active again.` : `Still failing: ${r.error}`); reload(); })} />}
          </View>
        ))}
      </Card>

      <Card title="Active campaigns">{data.campaigns.length ? data.campaigns.map((c) => <View key={c.id} style={s.row}><Text style={{ flex: 1 }}>{c.name}</Text><Muted>{c.holdoutPct ? `${c.holdoutPct}% holdout · ` : ''}{c.conversions} orders · {money(c.spentCents)}</Muted></View>) : <Muted>None running.</Muted>}</Card>
      <Muted>Offers, gift cards, challenges and campaign results are managed on the web console.</Muted>
    </ScrollView>
  );
}
