'use client';
import { useState } from 'react';
import { CAMPAIGN_KIND_LABELS, type CampaignKind } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';
import { useCourierAction } from './common';

// Courier Release 3 (courier side): busy times, campaigns, instant cash-out, payout hold and review notices.

interface Busy { zoneId: string; zoneName: string; hourStart: string; expectedJobs: number; gapCouriers: number; campaignId: string | null; campaignName: string | null }
interface Campaign {
  id: string; kind: CampaignKind; name: string; description: string | null; status: string; windowStart: string; windowEnd: string; zones: { id: string; name: string }[]; terms: string;
  enrolment: 'AUTO' | 'OPT_IN'; enrolled: boolean; eligible: boolean; ineligibleReason: string | null; budgetLeft: boolean;
  progress: { deliveries: number; onlineMinutes: number | null; earnedCents: number | null; targetDeliveries: number | null; nextTier: { deliveries: number; bonusCents: number } | null; estimatedPayoutCents: number } | null;
}
interface Instant { enabled: boolean; availableCents: number; feeCents: number; minCents: number; remainingToday: { count: number; cents: number }; blockedReason: string | null; recent: { id: string; amountCents: number; feeCents: number; status: string; failureReason: string | null; createdAt: string }[] }
interface Notices { hold: boolean; holdMessage: string | null; notices: { decision: string; notice: string; decidedAt: string }[] }

const hour = (d: string) => new Date(d).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' });
const span = (a: string, b: string) => `${new Date(a).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} – ${new Date(b).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;

/** Hours the forecast expects too few couriers, grouped by zone. */
export function BusyTimesCard() {
  const { data } = useApi<Busy[]>('/driver/busy-times?days=3', { poll: 300000 });
  return (
    <Card title="Busy times ahead">
      {!data?.length ? <p className="text-sm text-ink-500">No busy times expected in the next 3 days.</p> : (
        <ul className="space-y-1 text-sm">{data.slice(0, 12).map((b) => <li key={`${b.zoneId}${b.hourStart}`} className="flex flex-wrap items-center gap-2"><b>{hour(b.hourStart)}</b><span>{b.zoneName}</span><Badge tone="warn">about {Math.ceil(b.gapCouriers)} more courier{Math.ceil(b.gapCouriers) === 1 ? '' : 's'} needed</Badge>{b.campaignName && <Badge tone="good">{b.campaignName}</Badge>}</li>)}</ul>
      )}
      <p className="mt-2 text-xs text-ink-500">Based on past demand. Book a shift or go online then to get more offers.</p>
    </Card>
  );
}

function Progress({ c }: { c: Campaign }) {
  const p = c.progress;
  if (!p) return null;
  if (c.kind === 'QUEST') {
    const target = p.nextTier?.deliveries ?? p.targetDeliveries ?? 1;
    return <div className="mt-2"><div className="h-2 rounded bg-ink-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${Math.min(100, (p.deliveries / Math.max(1, target)) * 100)}%` }} /></div><p className="mt-1 text-xs">{p.deliveries} of {target} deliveries{p.estimatedPayoutCents ? ` · ${money(p.estimatedPayoutCents)} earned so far` : ''}{p.nextTier ? ` · next: ${money(p.nextTier.bonusCents)}` : ''}</p></div>;
  }
  if (c.kind === 'GUARANTEE') return <p className="mt-2 text-xs">{Math.round(p.onlineMinutes ?? 0)} min online · {money(p.earnedCents ?? 0)} earned · top-up so far {money(p.estimatedPayoutCents)}</p>;
  return <p className="mt-2 text-xs">{p.deliveries} boosted deliver{p.deliveries === 1 ? 'y' : 'ies'} · {money(p.earnedCents ?? 0)} extra</p>;
}

export function CampaignsCard() {
  const { data, reload } = useApi<Campaign[]>('/driver/campaigns', { poll: 120000 });
  const { run, error, busy } = useCourierAction();
  const live = (data ?? []).filter((c) => c.status !== 'ENDED');
  const ended = (data ?? []).filter((c) => c.status === 'ENDED');
  return (
    <Card title="Incentives">
      {error && <Alert>{error}</Alert>}
      {!live.length ? <p className="text-sm text-ink-500">No incentives running right now.</p> : <div className="space-y-2">{live.map((c) => (
        <div key={c.id} className="rounded-xl border border-ink-100 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><b>{c.name}</b><Badge tone="info">{CAMPAIGN_KIND_LABELS[c.kind]}</Badge>{c.status === 'SCHEDULED' && <Badge>starts soon</Badge>}{!c.budgetLeft && <Badge tone="warn">fully used</Badge>}</div>
          <p className="mt-1">{c.terms}</p>
          <p className="text-xs text-ink-500">{span(c.windowStart, c.windowEnd)}{c.zones.length ? ` · ${c.zones.map((z) => z.name).join(', ')}` : ''}</p>
          {c.description && <p className="mt-1 text-xs text-ink-600">{c.description}</p>}
          {!c.eligible ? <p className="mt-1 text-xs text-ink-500">Not available to you: {c.ineligibleReason}</p>
            : !c.enrolled ? <Button className="mt-2" size="sm" disabled={busy} onClick={() => run(async () => { await api.post(`/driver/campaigns/${c.id}/join`, {}); await reload(); })}>Join</Button>
            : <Progress c={c} />}
        </div>
      ))}</div>}
      {ended.length > 0 && <div className="mt-3"><p className="text-xs font-semibold text-ink-500">Recently ended</p><ul className="text-xs">{ended.map((c) => <li key={c.id}>{c.name}: {c.progress ? `${money(c.progress.estimatedPayoutCents)} earned` : 'not joined'}</li>)}</ul></div>}
    </Card>
  );
}

/** Cash out available earnings now, for a small fee. */
export function InstantCashOut({ onDone }: { onDone: () => void }) {
  const { data, reload } = useApi<Instant>('/driver/payouts/instant');
  const { run, error, busy } = useCourierAction();
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  if (!data || !data.enabled) return null;
  const cents = amount ? Math.round(Number(amount) * 100) : data.availableCents;
  const max = Math.min(data.availableCents, data.remainingToday.cents);
  return (
    <Card title="Cash out now">
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="good">{done}</Alert>}
      <p className="text-sm">{money(data.availableCents)} available. Fee {money(data.feeCents)} per cash-out · {data.remainingToday.count} left today.</p>
      {data.blockedReason ? <p className="mt-1 text-sm text-ink-500">{data.blockedReason}.</p> : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Input label="Amount ($)" inputMode="decimal" placeholder={(max / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button disabled={busy || cents < data.minCents || cents > max} onClick={() => run(async () => { const r = await api.post<{ amountCents: number; status: string; failureReason: string | null }>('/driver/payouts/instant', { amountCents: cents }); setDone(r.status === 'FAILED' ? `The transfer failed: ${r.failureReason}. Nothing was taken from your balance.` : `${money(r.amountCents)} is on its way to your account.`); setAmount(''); await reload(); onDone(); })}>Cash out {money(Math.max(0, cents - data.feeCents))}</Button>
        </div>
      )}
      {data.recent.length > 0 && <ul className="mt-2 text-xs text-ink-500">{data.recent.slice(0, 3).map((r) => <li key={r.id}>{when(r.createdAt)} · {money(r.amountCents)} (+{money(r.feeCents)} fee) · {r.status.toLowerCase()}{r.failureReason ? ` · ${r.failureReason}` : ''}</li>)}</ul>}
    </Card>
  );
}

/** Payout hold and decisions from an account review, in plain words. */
export function ReviewNotices() {
  const { data } = useApi<Notices>('/driver/notices', { poll: 300000 });
  if (!data) return null;
  const recent = data.notices.filter((n) => Date.now() - new Date(n.decidedAt).getTime() < 14 * 86_400_000);
  if (!data.hold && !recent.length) return null;
  return (
    <div className="space-y-2">
      {data.hold && <Alert tone="info">{data.holdMessage}</Alert>}
      {recent.map((n, i) => <Alert key={i} tone={n.decision === 'CLEAR' ? 'good' : 'info'}>{n.notice} <span className="text-xs opacity-70">({when(n.decidedAt)})</span></Alert>)}
    </div>
  );
}
