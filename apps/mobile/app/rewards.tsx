import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { MEMBERSHIP_STATUS_LABELS, REFERRAL_STATUS_LABELS } from '@gutad/shared';
import { api, money, when } from '@/api';
import { CardField, type CardToken } from '@/card-field';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';

interface Membership { status: string; plan: { name: string; priceCents: number; interval: string }; currentPeriodEnd: string; trialEndsAt: string | null; cancelAtPeriodEnd: boolean; benefitsActive: boolean; nextRetryAt: string | null; graceUntil: string | null; lastFailureReason: string | null }
interface Plan { id: string; name: string; priceCents: number; interval: string; trialDays: number }

/** Rewards on the phone: gift cards, membership (trial, cancel, card update), challenges and referrals. */
export default function Rewards() {
  const { data: loyalty, reload } = useApi<{ points: number; valueCents: number; credits: { availableCents: number }; membership: Membership | null }>('/me/loyalty');
  const { data: gifts, reload: rg } = useApi<{ balanceCents: number; cards: { id: string; code: string; balanceCents: number; status: string }[] }>('/me/gift-cards');
  const { data: plans } = useApi<Plan[]>('/public/membership/plans');
  const { data: ch } = useApi<{ active: { id: string; name: string; description: string | null; goalOrders: number; windowDays: number; rewardCents: number; progress: number; windowEnd: string | null; available: boolean }[] }>('/me/challenges');
  const { data: ref, reload: rr } = useApi<{ code: string; received: { status: string } | null; referred: { id: string; friend: string; status: string }[]; earnedPoints: number }>('/me/referral');
  const { run, error, busy } = useAction();
  const [code, setCode] = useState('');
  const [friend, setFriend] = useState('');
  const [card, setCard] = useState<CardToken | null>(null);
  const [fix, setFix] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!loyalty) return <Loading />;
  const m = loyalty.membership;
  const failing = m && (m.status === 'PAST_DUE' || m.status === 'SUSPENDED');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <ErrorText msg={error} />
      {msg && <Text style={{ color: C.good, marginBottom: 8 }}>{msg}</Text>}
      <Card title="Points & credits"><Text style={{ fontSize: 22, fontWeight: '700' }}>{loyalty.points} points</Text><Muted>≈ {money(loyalty.valueCents)} · credits {money(loyalty.credits.availableCents)}</Muted></Card>

      <Card title="Gift cards">
        <Text style={{ fontSize: 20, fontWeight: '700' }}>{money(gifts?.balanceCents || 0)}</Text>
        <Muted>Use it at checkout. Buy gift cards on gutad.io.</Muted>
        {gifts?.cards.map((c) => <Muted key={c.id}>{c.code}: {money(c.balanceCents)}{c.status !== 'ACTIVE' ? ` · ${c.status.toLowerCase()}` : ''}</Muted>)}
        <Input label="Add a gift card code" autoCapitalize="characters" value={code} onChangeText={(v) => setCode(v.toUpperCase())} />
        <Button title="Add to my wallet" disabled={busy || code.length < 4} onPress={() => run(async () => { const r = await api.post<{ walletCents: number }>('/me/gift-cards/claim', { code }); setCode(''); setMsg(`Gift balance: ${money(r.walletCents)}`); rg(); })} />
      </Card>

      <Card title="Membership">
        {m ? (
          <View>
            <View style={s.row}><Text style={{ fontWeight: '700' }}>{m.plan.name}</Text><Badge text={MEMBERSHIP_STATUS_LABELS[m.status] || m.status} tone={failing ? 'bad' : 'good'} /></View>
            {m.status === 'TRIALING' && <Muted>Free until {when(m.trialEndsAt)}. {m.cancelAtPeriodEnd ? 'You won’t be charged.' : `Then ${money(m.plan.priceCents)}/${m.plan.interval.toLowerCase()}.`}</Muted>}
            {m.status === 'ACTIVE' && <Muted>{m.cancelAtPeriodEnd ? `Ends ${when(m.currentPeriodEnd)}; benefits continue until then.` : `Renews ${when(m.currentPeriodEnd)}.`}</Muted>}
            {failing && <Text style={{ color: C.bad, marginVertical: 4 }}>{m.status === 'SUSPENDED' ? 'Payment failed several times; benefits are paused.' : `Payment failed${m.lastFailureReason ? ` (${m.lastFailureReason})` : ''}. Next try ${when(m.nextRetryAt)}; benefits until ${when(m.graceUntil)}.`} Update your card to fix it now.</Text>}
            {(failing || fix) ? (
              <View><CardField value={card} onChange={setCard} /><Button title={failing ? 'Update card and pay' : 'Save card'} disabled={busy || !card} onPress={() => run(async () => { const r = await api.post<{ ok: boolean; error: string | null }>('/me/membership/payment-method', { paymentMethodId: card!.token }); setFix(false); setMsg(r.ok ? 'Done. Your membership is active.' : `That card didn’t work: ${r.error}`); reload(); })} /></View>
            ) : <Button title="Change card" variant="secondary" onPress={() => setFix(true)} />}
            {m.cancelAtPeriodEnd ? <Button title="Keep my membership" onPress={() => run(async () => { await api.post('/me/membership/resume', {}); reload(); })} /> : !failing && <Button title="Cancel at the end of the period" variant="ghost" onPress={() => run(async () => { const r = await api.post<{ accessUntil: string | null }>('/me/membership/cancel', {}); setMsg(`Canceled. Benefits until ${when(r.accessUntil)}.`); reload(); })} />}
          </View>
        ) : (
          <View>
            {plans?.map((p) => <Muted key={p.id}>{p.name}: {money(p.priceCents)}/{p.interval.toLowerCase()}{p.trialDays ? ` · ${p.trialDays}-day free trial` : ''}</Muted>)}
            <CardField value={card} onChange={setCard} />
            {plans?.map((p) => <Button key={p.id} title={p.trialDays ? `Start free trial: ${p.name}` : `Join ${p.name}`} disabled={busy || !card} onPress={() => run(async () => { const r = await api.post<{ trial: boolean; chargesOn?: string }>('/me/membership', { planId: p.id, paymentMethodId: card!.token }); setMsg(r.trial ? `Trial started. First charge ${when(r.chargesOn)} unless you cancel.` : 'Welcome aboard!'); reload(); })} />)}
          </View>
        )}
      </Card>

      {!!ch?.active.filter((c) => c.available).length && (
        <Card title="Challenges">{ch.active.filter((c) => c.available).map((c) => (
          <View key={c.id} style={{ marginBottom: 10 }}>
            <View style={s.row}><Text style={{ fontWeight: '600' }}>{c.name}</Text><Muted>{money(c.rewardCents)} credit</Muted></View>
            <Muted>{c.description || `${c.goalOrders} orders within ${c.windowDays} days`}</Muted>
            <View style={{ height: 8, backgroundColor: C.ink1, borderRadius: 4, marginTop: 4 }}><View style={{ height: 8, width: `${Math.min(100, (c.progress / c.goalOrders) * 100)}%`, backgroundColor: C.brand, borderRadius: 4 }} /></View>
            <Muted>{c.progress} of {c.goalOrders}{c.windowEnd ? ` · by ${when(c.windowEnd)}` : ''}</Muted>
          </View>
        ))}</Card>
      )}

      {ref && (
        <Card title="Invite friends">
          <Text>Your code: <Text style={{ fontWeight: '700', fontSize: 18 }}>{ref.code}</Text></Text>
          <Muted>You both get points after their first order is completed. Earned: {ref.earnedPoints} points.</Muted>
          {ref.referred.map((r) => <Muted key={r.id}>{r.friend}: {REFERRAL_STATUS_LABELS[r.status] || r.status}</Muted>)}
          {!ref.received && <><Input label="Friend’s code" autoCapitalize="characters" value={friend} onChangeText={setFriend} /><Button title="Apply" variant="secondary" disabled={busy || friend.length < 4} onPress={() => run(async () => { const r = await api.post<{ message: string }>('/me/referral', { code: friend }); setMsg(r.message); rr(); })} /></>}
        </Card>
      )}
    </ScrollView>
  );
}
