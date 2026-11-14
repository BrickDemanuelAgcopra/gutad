'use client';
import { useState } from 'react';
import { MEMBERSHIP_STATUS_LABELS, REFERRAL_STATUS_LABELS } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, statusTone } from '@/components/ui';
import { CardField, type CardToken } from '@/components/card-field';

interface Loyalty { points: number; valueCents: number; credits: { availableCents: number }; entries: { id: string; kind: string; points: number; createdAt: string }[]; membership: Membership | null }
interface Membership { id: string; planId: string; pendingPlanId: string | null; status: string; plan: { name: string; priceCents: number; interval: string }; currentPeriodEnd: string; trialEndsAt: string | null; cancelAtPeriodEnd: boolean; benefitsActive: boolean; accessUntil: string | null; renewalFailures: number; nextRetryAt: string | null; graceUntil: string | null; lastFailureReason: string | null }
interface Plan { id: string; name: string; priceCents: number; interval: string; trialDays: number; benefits: { freeDeliveryAboveCents?: number; serviceFeeWaived?: boolean; creditCentsPerMonth?: number; priorityWaitlist?: boolean } }

const benefitText = (b: Plan['benefits']) => [b.freeDeliveryAboveCents !== undefined ? `free delivery over ${money(b.freeDeliveryAboveCents)}` : null, b.serviceFeeWaived ? 'no service fee' : null, b.creditCentsPerMonth ? `${money(b.creditCentsPerMonth)} credit each month` : null, b.priorityWaitlist ? 'priority waitlist' : null].filter(Boolean).join(' · ');

/** Customer rewards: points & credits, membership, gift cards, challenges and referrals (Phase J). */
export function Rewards() {
  const { data, reload } = useApi<Loyalty>('/me/loyalty');
  if (!data) return <Spinner />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Points & credits">
        <p className="text-3xl font-bold">{data.points} <span className="text-base font-normal text-ink-500">points ≈ {money(data.valueCents)}</span></p>
        <p className="text-sm text-ink-500">Credits available: {money(data.credits.availableCents)}</p>
        <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-ink-500">{data.entries.map((e) => <li key={e.id}>{e.kind.toLowerCase()} {e.points > 0 ? '+' : ''}{e.points} · {when(e.createdAt)}</li>)}</ul>
      </Card>
      <MembershipCard m={data.membership} reload={reload} />
      <GiftCards />
      <ChallengesCard />
      <Referral reload={reload} />
    </div>
  );
}

function MembershipCard({ m, reload }: { m: Membership | null; reload: () => void }) {
  const { data: plans } = useApi<Plan[]>('/public/membership/plans');
  const { run, error } = useAction();
  const [card, setCard] = useState<CardToken | null>(null);
  const [fixing, setFixing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (m) {
    const trial = m.status === 'TRIALING';
    const failing = m.status === 'PAST_DUE' || m.status === 'SUSPENDED';
    return (
      <Card title="Membership">
        {error && <Alert>{error}</Alert>}{msg && <Alert tone="good">{msg}</Alert>}
        <p className="text-sm"><b>{m.plan.name}</b> <Badge tone={statusTone(m.status === 'TRIALING' ? 'ACTIVE' : m.status)}>{MEMBERSHIP_STATUS_LABELS[m.status] || m.status}</Badge></p>
        {trial && <p className="mt-1 text-sm text-ink-600">Free until {when(m.trialEndsAt)}. {m.cancelAtPeriodEnd ? 'You won’t be charged.' : `Then ${money(m.plan.priceCents)}/${m.plan.interval.toLowerCase()} on your card.`}</p>}
        {m.status === 'ACTIVE' && <p className="mt-1 text-sm text-ink-600">{m.cancelAtPeriodEnd ? `Ends ${when(m.currentPeriodEnd)}; benefits continue until then.` : `Renews ${when(m.currentPeriodEnd)} for ${money(m.plan.priceCents)}.`}</p>}
        {failing && <Alert tone="bad">{m.status === 'SUSPENDED' ? 'We couldn’t collect your membership payment, so benefits are paused.' : `Your last payment failed${m.lastFailureReason ? ` (${m.lastFailureReason})` : ''}. We’ll try again ${when(m.nextRetryAt)}; benefits continue until ${when(m.graceUntil)}.`} Update your card to fix it now.</Alert>}
        <div className="mt-3 flex flex-wrap gap-2">
          {(failing || fixing) ? null : <Button size="sm" variant="secondary" onClick={() => setFixing(true)}>Change card</Button>}
          {m.cancelAtPeriodEnd ? <Button size="sm" onClick={() => run(async () => { await api.post('/me/membership/resume', {}); setMsg('Your membership will renew.'); reload(); })}>Keep my membership</Button> : !failing && <Button size="sm" variant="ghost" onClick={() => run(async () => { const r = await api.post<{ accessUntil: string | null }>('/me/membership/cancel', {}); setMsg(r.accessUntil ? `Canceled. Benefits continue until ${when(r.accessUntil)}.` : 'Canceled.'); reload(); })}>Cancel</Button>}
          {failing && m.status === 'PAST_DUE' && <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post('/me/membership/cancel', { immediate: true }); reload(); })}>End membership</Button>}
        </div>
        {!failing && plans && plans.length > 1 && (
          <div className="mt-3 border-t border-ink-100 pt-2 text-sm">
            {m.pendingPlanId && <p className="text-xs text-ink-500">Moving to {plans.find((p) => p.id === m.pendingPlanId)?.name} at renewal.</p>}
            {plans.filter((p) => p.id !== m.planId).map((p) => <Button key={p.id} size="sm" variant="ghost" onClick={() => run(async () => { const r = await api.post<{ mode: string; chargedCents?: number; creditCents?: number; note: string }>('/me/membership/switch', { planId: p.id }); setMsg(r.mode === 'NOW' && r.chargedCents ? `${r.note}. Charged ${money(r.chargedCents)} after a ${money(r.creditCents || 0)} credit for unused time.` : r.note); reload(); })}>{p.priceCents > m.plan.priceCents ? 'Upgrade' : 'Switch'} to {p.name} ({money(p.priceCents)}/{p.interval.toLowerCase()})</Button>)}
            <p className="text-xs text-ink-500">Upgrades start now with credit for the unused time; cheaper plans start at your next renewal.</p>
          </div>
        )}
        {(failing || fixing) && <div className="mt-2"><CardField value={card} onChange={setCard} /><Button className="mt-2" size="sm" disabled={!card} onClick={() => run(async () => { const r = await api.post<{ ok: boolean; status: string; error: string | null }>('/me/membership/payment-method', { paymentMethodId: card!.token }); setFixing(false); setMsg(r.ok ? (failing ? 'Payment collected. You’re all set.' : 'Card updated.') : `That card didn’t work either: ${r.error}`); reload(); })}>{failing ? 'Update card and pay' : 'Save card'}</Button></div>}
      </Card>
    );
  }
  return (
    <Card title="Membership">
      {error && <Alert>{error}</Alert>}
      <div className="space-y-2">{plans?.map((p) => (
        <div key={p.id} className="rounded-lg border border-ink-100 p-3 text-sm">
          <div className="flex items-center justify-between"><div><b>{p.name}</b> · {money(p.priceCents)}/{p.interval.toLowerCase()}{p.trialDays > 0 && <Badge tone="good">{p.trialDays}-day free trial</Badge>}</div></div>
          <div className="text-xs text-ink-500">{benefitText(p.benefits)}</div>
        </div>
      ))}</div>
      <CardField value={card} onChange={setCard} />
      <div className="mt-2 flex flex-wrap gap-2">{plans?.map((p) => <Button key={p.id} size="sm" disabled={!card} onClick={() => run(async () => { const r = await api.post<{ trial: boolean; chargesOn?: string }>('/me/membership', { planId: p.id, paymentMethodId: card!.token }); setMsg(r.trial ? `Your free trial has started. You’ll be charged on ${when(r.chargesOn)} unless you cancel.` : 'Welcome aboard!'); reload(); })}>{p.trialDays > 0 ? `Start free trial: ${p.name}` : `Join ${p.name}`}</Button>)}</div>
      {msg && <Alert tone="good">{msg}</Alert>}
      <p className="mt-2 text-xs text-ink-500">Free trials are for first-time members. Cancel any time; benefits continue to the end of the period you paid for.</p>
    </Card>
  );
}

function GiftCards() {
  const { data, reload } = useApi<{ balanceCents: number; cards: { id: string; code: string; status: string; balanceCents: number; initialCents: number; expiresAt: string | null }[]; purchased: { id: string; code: string; status: string; amountCents: number; recipientEmail: string | null; claimed: boolean }[]; activity: { id: string; kind: string; cents: number; at: string; card: string }[] }>('/me/gift-cards');
  const { run, error } = useAction();
  const [code, setCode] = useState('');
  const [buy, setBuy] = useState({ amount: '25', email: '', name: '', message: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showBuy, setShowBuy] = useState(false);
  return (
    <Card title="Gift cards">
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="good">{msg}</Alert>}
      <p className="text-2xl font-bold">{money(data?.balanceCents || 0)} <span className="text-sm font-normal text-ink-500">to spend at checkout</span></p>
      <div className="mt-2 flex gap-2"><Input placeholder="Gift card code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><Button variant="secondary" disabled={code.length < 4} onClick={() => run(async () => { const r = await api.post<{ balanceCents: number; walletCents: number }>('/me/gift-cards/claim', { code }); setCode(''); setMsg(`Added ${money(r.balanceCents)}. Your gift balance is ${money(r.walletCents)}.`); reload(); })}>Add</Button></div>
      {data?.cards.length ? <ul className="mt-2 text-xs text-ink-500">{data.cards.map((c) => <li key={c.id}>{c.code}: {money(c.balanceCents)} of {money(c.initialCents)}{c.status !== 'ACTIVE' ? ` · ${c.status.toLowerCase()}` : ''}{c.expiresAt ? ` · expires ${when(c.expiresAt)}` : ''}</li>)}</ul> : null}
      {!!data?.activity.length && <details className="mt-2 text-xs text-ink-500"><summary className="cursor-pointer">Activity</summary><ul>{data.activity.map((a) => <li key={a.id}>{a.kind.toLowerCase()} {money(a.cents)} · {a.card} · {when(a.at)}</li>)}</ul></details>}
      <div className="mt-3 border-t border-ink-100 pt-3">
        {!showBuy ? <Button size="sm" variant="secondary" onClick={() => setShowBuy(true)}>Buy a gift card</Button> : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-1">{['25', '50', '100'].map((a) => <Button key={a} size="sm" variant={buy.amount === a ? 'primary' : 'secondary'} onClick={() => setBuy({ ...buy, amount: a })}>${a}</Button>)}<Input className="w-24" value={buy.amount} onChange={(e) => setBuy({ ...buy, amount: e.target.value })} /></div>
            <Input label="Recipient email (blank = for me)" value={buy.email} onChange={(e) => setBuy({ ...buy, email: e.target.value })} />
            {buy.email && <><Input label="Recipient name" value={buy.name} onChange={(e) => setBuy({ ...buy, name: e.target.value })} /><Input label="Message" value={buy.message} onChange={(e) => setBuy({ ...buy, message: e.target.value })} /></>}
            <CardField value={card} onChange={setCard} />
            <Button disabled={!card} onClick={() => run(async () => { const r = await api.post<{ code: string; note: string }>('/me/gift-cards', { amountCents: Math.round(Number(buy.amount) * 100), recipientEmail: buy.email || undefined, recipientName: buy.name || undefined, message: buy.message || undefined, paymentMethodId: card!.token }); setMsg(`${r.note} Code ${r.code}.`); setShowBuy(false); reload(); })}>Pay {money(Math.round(Number(buy.amount || 0) * 100))}</Button>
          </div>
        )}
        {!!data?.purchased.length && <ul className="mt-2 text-xs text-ink-500">{data.purchased.map((p) => <li key={p.id}>{money(p.amountCents)} → {p.recipientEmail || 'me'} · {p.status === 'PENDING_REVIEW' ? 'being checked' : p.claimed ? 'added' : 'sent'}</li>)}</ul>}
      </div>
    </Card>
  );
}

function ChallengesCard() {
  const { data } = useApi<{ active: { id: string; name: string; description: string | null; merchant: string | null; goalOrders: number; windowDays: number; rewardCents: number; rewardExpiresDays: number; progress: number; windowEnd: string | null; available: boolean; minSubtotalCents: number }[]; history: { id: string; challenge: string; status: string; completedAt: string | null }[] }>('/me/challenges');
  if (!data || (!data.active.length && !data.history.length)) return null;
  return (
    <Card title="Challenges">
      <div className="space-y-3">{data.active.filter((c) => c.available).map((c) => (
        <div key={c.id} className="text-sm">
          <div className="flex justify-between"><b>{c.name}</b><span className="text-ink-500">{money(c.rewardCents)} credit</span></div>
          <div className="text-xs text-ink-500">{c.description || `${c.goalOrders} orders within ${c.windowDays} days`}{c.merchant ? ` at ${c.merchant}` : ''}{c.minSubtotalCents ? ` · orders over ${money(c.minSubtotalCents)}` : ''}</div>
          <div className="mt-1 h-2 rounded-full bg-ink-100"><div className="h-2 rounded-full bg-brand-600" style={{ width: `${Math.min(100, (c.progress / c.goalOrders) * 100)}%` }} /></div>
          <div className="text-xs text-ink-500">{c.progress} of {c.goalOrders}{c.windowEnd ? ` · finish by ${when(c.windowEnd)}` : ' · starts with your next order'}</div>
        </div>
      ))}</div>
      {!!data.history.length && <ul className="mt-3 text-xs text-ink-500">{data.history.map((h) => <li key={h.id}>{h.challenge}: {h.status === 'COMPLETED' ? `completed ${when(h.completedAt)}` : 'time ran out'}</li>)}</ul>}
    </Card>
  );
}

function Referral({ reload }: { reload: () => void }) {
  const { data, reload: rr } = useApi<{ code: string; received: { status: string; rewardPoints: number } | null; referred: { id: string; friend: string; status: string; rewardPoints: number }[]; earnedPoints: number }>('/me/referral');
  const { run, error } = useAction();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  return (
    <Card title="Invite friends">
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="good">{msg}</Alert>}
      <p className="text-sm">Your code: <b className="font-mono text-lg">{data.code}</b></p>
      <p className="text-xs text-ink-500">You and your friend each get points after their first order is completed. Earned so far: {data.earnedPoints} points.</p>
      {!!data.referred.length && <ul className="mt-2 text-xs">{data.referred.map((r) => <li key={r.id}>{r.friend}: {REFERRAL_STATUS_LABELS[r.status] || r.status}</li>)}</ul>}
      {data.received ? <p className="mt-3 text-xs text-ink-500">You joined with a friend’s code: {REFERRAL_STATUS_LABELS[data.received.status] || data.received.status}.</p> : (
        <div className="mt-3 flex gap-2"><Input placeholder="Friend’s code" value={code} onChange={(e) => setCode(e.target.value)} /><Button variant="secondary" disabled={code.length < 4} onClick={() => run(async () => { const r = await api.post<{ message: string }>('/me/referral', { code }); setMsg(r.message); rr(); reload(); })}>Apply</Button></div>
      )}
    </Card>
  );
}
