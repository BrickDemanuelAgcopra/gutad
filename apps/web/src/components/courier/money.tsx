'use client';
import { useState } from 'react';
import { REVIEW_TAG_LABELS, REVIEW_TAGS_NEGATIVE } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { humanize, useCourierAction } from './common';

interface Earnings {
  payableCents: number; pendingCents: number; availableCents: number; policy?: unknown;
  entries: { id: string; kind: string; deliveryJobId: string | null; baseCents: number; distanceCents: number; timeCents: number; waitingCents: number; returnCents: number; tipCents: number; bonusCents: number; totalCents: number; reason: string | null; availableAt: string | null; createdAt: string;
    detail?: { pickupWaitMinutes: number; dropoffWaitMinutes: number; kitchenDelayMinutes: number; marketId: string | null; marketVersion: number | null } | null }[];
  days: { date: string; cents: number; deliveries: number }[];
  weeks: { weekStart: string; cents: number; deliveries: number }[];
  payouts: { id: string; amountCents: number; status: string; failureReason: string | null; periodStart: string | null; periodEnd: string | null; paidAt: string | null }[];
  payoutAccount: { method: string; accountLast4: string } | null;
}

const day = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function breakdown(e: Earnings['entries'][number]) {
  const waited = (e.detail?.pickupWaitMinutes || 0) + (e.detail?.dropoffWaitMinutes || 0);
  const parts: [string, number][] = [['base', e.baseCents], ['distance', e.distanceCents], ['time', e.timeCents], ['waiting', e.waitingCents], ['return', e.returnCents], ['tip', e.tipCents], ['bonus', e.bonusCents]];
  return parts.filter(([, c]) => c).map(([l, c]) => `${l} ${money(c)}${l === 'waiting' && waited > 0 ? ` (${waited} min)` : ''}`).join(' · ');
}

export function EarningsSection() {
  const { data: e, reload } = useApi<Earnings>('/driver/earnings');
  const [view, setView] = useState<'days' | 'weeks'>('days');
  if (!e) return null;
  const now = Date.now();
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {([['Pending', e.pendingCents, 'Held briefly after each delivery'], ['Available', e.availableCents, 'Ready for your next payout'], ['Payable', e.payableCents, 'Total not yet paid out']] as const).map(([l, c, h]) => <div key={l} className="rounded-xl border border-ink-100 bg-white p-3"><div className="text-xs text-ink-500">{l}</div><div className="text-lg font-bold">{money(c)}</div><div className="text-[11px] text-ink-500">{h}</div></div>)}
      </div>
      <Card title="Statements" action={<Select value={view} onChange={(x) => setView(x.target.value as 'days' | 'weeks')}><option value="days">By day</option><option value="weeks">By week</option></Select>}>
        {view === 'days'
          ? <Table rows={e.days} empty="No earnings yet." cols={[{ key: 'd', label: 'Day', render: (r) => day(r.date) }, { key: 'n', label: 'Deliveries', render: (r) => r.deliveries }, { key: 'c', label: 'Earned', render: (r) => money(r.cents) }]} />
          : <Table rows={e.weeks} empty="No earnings yet." cols={[{ key: 'd', label: 'Week of', render: (r) => day(r.weekStart) }, { key: 'n', label: 'Deliveries', render: (r) => r.deliveries }, { key: 'c', label: 'Earned', render: (r) => money(r.cents) }]} />}
      </Card>
      <Card title="Earnings">
        <Table rows={e.entries.slice(0, 50)} empty="No earnings yet." cols={[
          { key: 'w', label: 'When', render: (r) => <span className="text-xs">{when(r.createdAt)}</span> },
          { key: 'k', label: 'Kind', render: (r) => <span className="text-xs">{humanize(r.kind)}{r.reason ? <span className="block text-ink-500">{r.reason}</span> : null}</span> },
          { key: 'b', label: 'Breakdown', render: (r) => <span className="text-xs">{breakdown(r)}{(r.detail?.kitchenDelayMinutes || 0) > 0 && <span className="block text-ink-500">Kitchen was {r.detail!.kitchenDelayMinutes} min late</span>}</span> },
          { key: 't', label: 'Total', render: (r) => <b>{money(r.totalCents)}</b> },
          { key: 'a', label: '', render: (r) => r.availableAt && new Date(r.availableAt).getTime() > now ? <span className="text-xs text-ink-500">available {when(r.availableAt)}</span> : <span className="text-xs text-emerald-700">available</span> },
        ]} />
      </Card>
      <Card title="Payouts" action={e.payoutAccount ? <span className="text-xs text-ink-500">to {humanize(e.payoutAccount.method)} •••• {e.payoutAccount.accountLast4}</span> : <Badge tone="warn">no payout account</Badge>}>
        <Table rows={e.payouts} empty="No payouts yet." cols={[
          { key: 'p', label: 'Period', render: (r) => <span className="text-xs">{r.periodStart ? day(r.periodStart) : '—'} – {r.periodEnd ? day(r.periodEnd) : '—'}</span> },
          { key: 'a', label: 'Amount', render: (r) => money(r.amountCents) },
          { key: 's', label: 'Status', render: (r) => <span><Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>{r.failureReason && <span className="block text-xs text-red-700">{r.failureReason}</span>}</span> },
          { key: 'd', label: 'Paid', render: (r) => <span className="text-xs">{when(r.paidAt)}</span> },
        ]} />
      </Card>
      <EarningsDispute entries={e.entries} onDone={() => void reload()} />
    </div>
  );
}

function EarningsDispute({ entries, onDone }: { entries: Earnings['entries']; onDone: () => void }) {
  const [jobId, setJobId] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const { run, error, busy } = useCourierAction();
  const jobs = Array.from(new Map(entries.filter((x) => x.deliveryJobId).map((x) => [x.deliveryJobId!, x])).values()).slice(0, 30);
  return (
    <Card title="Something wrong with your pay?">
      {sent && <div className="mb-2"><Alert tone="good">Thanks. Our courier team will look into it and reply.</Alert></div>}
      {error && <div className="mb-2"><Alert>{error}</Alert></div>}
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <Select label="Delivery (optional)" value={jobId} onChange={(e) => setJobId(e.target.value)}><option value="">General question</option>{jobs.map((x) => <option key={x.deliveryJobId!} value={x.deliveryJobId!}>{when(x.createdAt)} · {money(x.totalCents)}</option>)}</Select>
        <Input label="What’s wrong?" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" disabled={busy || note.trim().length < 10} onClick={() => run(async () => { await api.post('/driver/earnings/dispute', { deliveryJobId: jobId || undefined, note: note.trim() }); setNote(''); setJobId(''); setSent(true); onDone(); })}>Send</Button>
      </div>
      <p className="mt-1 text-xs text-ink-500">At least 10 characters.</p>
    </Card>
  );
}

interface Feedback { ratingAvg: number | null; ratingCount: number; tagCounts: Record<string, number>; recent: { id: string; rating: number; tags: string[]; comment: string | null; createdAt: string; excluded: boolean; disputeStatus: string | null }[] }

export function FeedbackSummary({ f }: { f: Feedback }) {
  const tags = Object.entries(f.tagCounts || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <div className="flex items-baseline gap-2"><span className="text-3xl font-bold">{f.ratingAvg != null ? f.ratingAvg.toFixed(2) : '—'}</span><span className="text-amber-500">★</span><span className="text-sm text-ink-500">{f.ratingCount} rating{f.ratingCount === 1 ? '' : 's'}</span></div>
      {tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{tags.map(([t, n]) => <Badge key={t} tone={(REVIEW_TAGS_NEGATIVE as readonly string[]).includes(t) ? 'warn' : 'good'}>{REVIEW_TAG_LABELS[t] || humanize(t)} · {n}</Badge>)}</div>}
    </div>
  );
}

export type { Feedback };

export function FeedbackSection() {
  const { data: f, reload } = useApi<Feedback>('/driver/feedback');
  if (!f) return null;
  return (
    <Card title="Customer feedback">
      <FeedbackSummary f={f} />
      <p className="mt-1 text-xs text-ink-500">Feedback is anonymous. Ratings caused by kitchen delays or sealed-bag problems don’t count against you.</p>
      <div className="mt-3 divide-y divide-ink-100">
        {f.recent.map((r) => <FeedbackRow key={r.id} r={r} onDone={() => void reload()} />)}
        {!f.recent.length && <p className="text-sm text-ink-500">No feedback yet.</p>}
      </div>
    </Card>
  );
}

function FeedbackRow({ r, onDone }: { r: Feedback['recent'][number]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { run, error, busy } = useCourierAction();
  const disputed = r.disputeStatus && r.disputeStatus !== 'NONE';
  return (
    <div className="py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span><span className="text-amber-500">{'★'.repeat(r.rating)}</span><span className="text-ink-100">{'★'.repeat(5 - r.rating)}</span> <span className="text-xs text-ink-500">{when(r.createdAt)}</span>{r.excluded && <Badge tone="info">not counted</Badge>}{disputed && <Badge tone={statusTone(r.disputeStatus!)}>dispute {humanize(r.disputeStatus!)}</Badge>}</span>
        {!disputed && !r.excluded && !open && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Dispute</Button>}
      </div>
      {r.tags.length > 0 && <div className="text-xs text-ink-500">{r.tags.map((t) => REVIEW_TAG_LABELS[t] || humanize(t)).join(' · ')}</div>}
      {r.comment && <p className="text-ink-700">“{r.comment}”</p>}
      {open && (
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <Input label="Why is this rating unfair?" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={busy || note.trim().length < 10} onClick={() => run(async () => { await api.post(`/driver/feedback/${r.id}/dispute`, { note: note.trim() }); setOpen(false); onDone(); })}>Send</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </div>
  );
}
