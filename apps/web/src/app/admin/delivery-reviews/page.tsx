'use client';
import Link from 'next/link';
import { useState } from 'react';
import { REVIEW_ISSUES, REVIEW_TAG_LABELS, type ReviewIssue } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, Input, statusTone, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Review {
  id: string; deliveryJobId: string; orderId: string | null; driverId: string; driverName: string | null; rating: number; tags: string[]; comment: string | null;
  foodRating: number | null; packagingRating: number | null; issues: string[]; status: string; excluded: boolean; excludedReason: string | null;
  disputeStatus: string | null; disputeNote: string | null; history: unknown[] | null; createdAt: string;
}
type Action = 'APPROVE' | 'HIDE' | 'EXCLUDE' | 'RESTORE' | 'UPHOLD_DISPUTE' | 'REJECT_DISPUTE';
const LABEL: Record<Action, string> = { APPROVE: 'Approve', HIDE: 'Hide', EXCLUDE: 'Exclude from rating', RESTORE: 'Restore', UPHOLD_DISPUTE: 'Uphold dispute', REJECT_DISPUTE: 'Reject dispute' };
const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const stars = (n: number | null) => (n ? <span><span className="text-amber-500">{'★'.repeat(n)}</span><span className="text-ink-100">{'★'.repeat(5 - n)}</span></span> : '—');
const openDispute = (r: Review) => !!r.disputeStatus && ['OPEN', 'PENDING'].includes(r.disputeStatus);

/** Customer ratings of couriers: moderation queue, exclusions (kitchen delay, sealed bag) and disputed feedback. */
export default function DeliveryReviews() {
  const [status, setStatus] = useState('PENDING_MODERATION');
  const { data, reload } = useApi<Review[]>(`/admin/delivery-reviews?status=${status}`, { deps: [status] });
  const { can } = useSession();
  const manage = can('delivery.manage') || can('support.manage');
  return (
    <div className="space-y-4">
      <SectionTitle title="Delivery reviews" hint="Customer ratings of couriers. Approve or hide reviews, exclude ratings the courier couldn’t control, and decide disputes. Every action needs a note." />
      <Tabs tabs={[{ id: 'PENDING_MODERATION', label: 'Needs moderation' }, { id: 'DISPUTED', label: 'Disputed' }, { id: 'ALL', label: 'All' }]} active={status} onChange={setStatus} />
      {!data ? null : data.length ? data.map((r) => <ReviewCard key={r.id} r={r} manage={manage} onDone={() => void reload()} />) : <Empty>Nothing here.</Empty>}
    </div>
  );
}

function ReviewCard({ r, manage, onDone }: { r: Review; manage: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { run, error, busy } = useAction();
  const actions: Action[] = [
    ...(r.status !== 'VISIBLE' ? ['APPROVE' as const] : []),
    ...(r.status !== 'HIDDEN' ? ['HIDE' as const] : []),
    ...(!r.excluded ? ['EXCLUDE' as const] : ['RESTORE' as const]),
    ...(openDispute(r) ? ['UPHOLD_DISPUTE' as const, 'REJECT_DISPUTE' as const] : []),
  ];
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">{stars(r.rating)}<Link className="text-sm font-normal underline" href={`/admin/couriers/${r.driverId}`}>{r.driverName || 'Courier'}</Link></span>}
      action={<span className="flex flex-wrap gap-1"><Badge tone={r.status === 'VISIBLE' ? 'good' : r.status === 'HIDDEN' ? 'neutral' : 'warn'}>{humanize(r.status)}</Badge>{r.excluded && <Badge tone="info">excluded</Badge>}{r.disputeStatus && r.disputeStatus !== 'NONE' && <Badge tone={statusTone(r.disputeStatus)}>dispute {humanize(r.disputeStatus)}</Badge>}</span>}>
      <div className="space-y-1 text-sm">
        <p className="text-xs text-ink-500">{when(r.createdAt)}{r.orderId && <> · <Link className="underline" href={`/admin/orders/${r.orderId}`}>order</Link></>}</p>
        {r.tags.length > 0 && <div className="flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t}>{REVIEW_TAG_LABELS[t] || humanize(t)}</Badge>)}</div>}
        {r.comment && <p>“{r.comment}”</p>}
        <p className="text-xs text-ink-500">Food {stars(r.foodRating)} · Packaging {stars(r.packagingRating)}</p>
        {r.issues.length > 0 && <p className="text-xs text-red-700">Issues: {r.issues.map((i) => REVIEW_ISSUES[i as ReviewIssue] || humanize(i)).join(', ')}</p>}
        {r.excluded && r.excludedReason && <p className="text-xs text-ink-500">Excluded: {r.excludedReason}</p>}
        {r.disputeNote && <p className="rounded-lg bg-amber-50 p-2 text-xs">Courier’s dispute: “{r.disputeNote}”</p>}
        {!!r.history?.length && (
          <details className="text-xs text-ink-500"><summary className="cursor-pointer">History ({r.history.length})</summary>
            <ul className="mt-1 space-y-0.5">{r.history.map((h, i) => { const x = h as { at?: string; action?: string; note?: string; by?: string }; return <li key={i}>{x.at ? when(x.at) : ''} {x.action ? humanize(x.action) : ''}{x.by ? ` by ${x.by}` : ''}{x.note ? `: ${x.note}` : ''}</li>; })}</ul>
          </details>
        )}
      </div>
      {manage && (
        <div className="mt-3 space-y-2">
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap items-end gap-2">
            <Input label="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} />
            {actions.map((a) => <Button key={a} size="sm" variant={a === 'HIDE' || a === 'REJECT_DISPUTE' ? 'secondary' : 'primary'} disabled={busy || note.trim().length < 3} onClick={() => run(async () => { await api.post(`/admin/delivery-reviews/${r.id}/moderate`, { action: a, note: note.trim() }); setNote(''); onDone(); })}>{LABEL[a]}</Button>)}
          </div>
        </div>
      )}
    </Card>
  );
}
