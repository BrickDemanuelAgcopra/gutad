'use client';
import { useState } from 'react';
import { MEMBERSHIP_STATUS_LABELS } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Select, Stat, statusTone, Table, Tabs } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';
import { Challenges, type Challenge } from '@/components/growth';

interface Ref { id: string; status: string; referrer_email: string; referrer_name: string | null; referee_email: string; referee_name: string | null; signals: { kind: string; detail: string }[]; reward_points: number; created_at: string; review_note: string | null }
interface Sub { id: string; userId: string; email: string; name: string | null; plan: string; status: string; currentPeriodEnd: string; trialEndsAt: string | null; cancelAtPeriodEnd: boolean; renewalFailures: number; nextRetryAt: string | null; graceUntil: string | null; lastFailureReason: string | null }

/** 25.5–25.8 referrals under review, reward challenges, and memberships (trials, cancellations, failed renewals). */
export default function AdminRewards() {
  const [tab, setTab] = useState('referrals');
  return (
    <div className="space-y-4">
      <SectionTitle title="Rewards & memberships" hint="Referral rewards held for review, reward challenges, and memberships that are trialing, canceling or behind on payment." />
      <Tabs tabs={[{ id: 'referrals', label: 'Referrals' }, { id: 'challenges', label: 'Challenges' }, { id: 'memberships', label: 'Memberships' }]} active={tab} onChange={setTab} />
      {tab === 'referrals' && <Referrals />}
      {tab === 'challenges' && <ChallengesTab />}
      {tab === 'memberships' && <Memberships />}
    </div>
  );
}

function Referrals() {
  const { can } = useSession();
  const [status, setStatus] = useState('REVIEW');
  const { data, reload } = useApi<{ stats: Record<string, number>; items: Ref[] }>(`/admin/referrals?status=${status}`, { deps: [status] });
  const { run, error } = useAction();
  const decide = (r: Ref, approve: boolean) => { const note = askReason(approve ? 'approving this referral' : 'rejecting this referral', 3); if (note) run(async () => { await api.post(`/admin/referrals/${r.id}/decision`, { approve, note }); await reload(); }); };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {data && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Waiting for first order" value={data.stats.pending} /><Stat label="Under review" value={data.stats.review} /><Stat label="Rewarded" value={data.stats.rewarded} /><Stat label="Rejected" value={data.stats.rejected} /></div>}
      <Card title="Referrals" action={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="REVIEW">Under review</option><option value="PENDING">Waiting for first order</option><option value="REWARDED">Rewarded</option><option value="REJECTED">Rejected</option></Select>}>
        <Table rows={data?.items || []} empty="Nothing here." cols={[
          { key: 'r', label: 'Referrer', render: (r) => <div>{r.referrer_name}<div className="text-xs text-ink-500">{r.referrer_email}</div></div> },
          { key: 'e', label: 'New customer', render: (r) => <div>{r.referee_name}<div className="text-xs text-ink-500">{r.referee_email}</div></div> },
          { key: 's', label: 'Signals', render: (r) => (r.signals.length ? r.signals.map((x) => <Badge key={x.kind} tone="warn">{x.detail}</Badge>) : <span className="text-xs text-ink-500">none</span>) },
          { key: 'p', label: 'Reward', render: (r) => `${r.reward_points} pts each` },
          { key: 'd', label: 'Since', render: (r) => when(r.created_at) },
          { key: 'a', label: '', render: (r) => r.status === 'REVIEW' && can('growth.manage') ? <span className="flex gap-1"><Button size="sm" onClick={() => decide(r, true)}>Approve</Button><Button size="sm" variant="secondary" onClick={() => decide(r, false)}>Reject</Button></span> : r.review_note ? <span className="text-xs text-ink-500">{r.review_note}</span> : null },
        ]} />
        <p className="mt-2 text-xs text-ink-500">Rewards are paid when the new customer’s first order is completed. A shared phone, card or delivery address between the two accounts holds the reward here for a decision.</p>
      </Card>
    </div>
  );
}

function ChallengesTab() {
  const { data, reload } = useApi<Challenge[]>('/admin/challenges');
  return <Challenges base="/admin/challenges" list={data || []} onChange={reload} />;
}

function Memberships() {
  const { can } = useSession();
  const { data, reload } = useApi<{ stats: Record<string, number>; items: Sub[]; dunning: { retryDays: number[]; graceDays: number } }>('/admin/memberships');
  const { run, error } = useAction();
  const [ok, setOk] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      {data && <div className="grid gap-3 sm:grid-cols-6"><Stat label="Active" value={data.stats.active} /><Stat label="Free trial" value={data.stats.trialing} /><Stat label="Canceling" value={data.stats.canceling} hint="at period end" /><Stat label="Payment failed" value={data.stats.past_due} /><Stat label="Suspended" value={data.stats.suspended} /><Stat label="Recovered (30 d)" value={data.stats.recovered30d} /></div>}
      <Card title="Needs attention">
        <Table rows={data?.items || []} empty="No trials, cancellations or failed payments." cols={[
          { key: 'm', label: 'Member', render: (s) => <div>{s.name || s.email}<div className="text-xs text-ink-500">{s.email} · {s.plan}</div></div> },
          { key: 's', label: 'Status', render: (s) => <span className="flex flex-wrap gap-1"><Badge tone={statusTone(s.status)}>{MEMBERSHIP_STATUS_LABELS[s.status] || s.status}</Badge>{s.cancelAtPeriodEnd && <Badge>cancels at period end</Badge>}</span> },
          { key: 'p', label: 'Period / trial ends', render: (s) => when(s.trialEndsAt && s.status === 'TRIALING' ? s.trialEndsAt : s.currentPeriodEnd) },
          { key: 'f', label: 'Failed payments', render: (s) => s.renewalFailures ? <div>{s.renewalFailures}× · next try {when(s.nextRetryAt)}<div className="text-xs text-ink-500">{s.lastFailureReason}{s.graceUntil ? ` · benefits until ${when(s.graceUntil)}` : ''}</div></div> : '—' },
          { key: 'a', label: '', render: (s) => (s.status === 'PAST_DUE' || s.status === 'SUSPENDED') && can('growth.manage') ? <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api.post<{ ok: boolean; status: string; error?: string }>(`/admin/memberships/${s.id}/retry`, {}); setOk(r.ok ? `Payment collected; ${s.email} is active again.` : `Still failing: ${r.error}`); await reload(); })}>Retry now</Button> : null },
        ]} />
        {data && <p className="mt-2 text-xs text-ink-500">Failed renewals retry after {data.dunning.retryDays.join(', ')} day(s); benefits continue for {data.dunning.graceDays} days after the first failure, then the membership is suspended until the card is updated. Change this in Settings (<code>membership.dunning</code>). Free trials are charged only when the trial ends.</p>}
      </Card>
    </div>
  );
}
