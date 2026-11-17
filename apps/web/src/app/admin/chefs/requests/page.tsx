'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CHEF_REQUEST_STATUSES, CHEF_REQUEST_STATUS_LABELS, type ChefRequestSummary } from '@gutad/shared';
import { useApi } from '@/lib/hooks';
import { Alert, Empty, Select, Spinner, Stat } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { RequestRow } from '@/components/chef-requests';

interface Stats { open: number; waitingOnChef: number; dueSoon: number; escalated: number; total30: number; avgResponseMinutes: number | null; quoteAcceptancePct: number | null; expired30: number }

/** Gutad supervision of special requests: deadlines, response times, quote acceptance; extend or close. */
export default function AdminChefRequests() {
  const [filter, setFilter] = useState('OPEN');
  const q = filter === 'ESCALATED' ? 'escalated=true' : filter === 'OVERDUE' ? 'overdue=true' : filter === 'ALL' ? '' : `status=${filter}`;
  const { data, error } = useApi<{ requests: ChefRequestSummary[]; stats: Stats }>(`/admin/chef-requests?${q}`, { poll: 60_000 });
  const s = data?.stats;
  const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
  return (
    <div className="space-y-4">
      <SectionTitle title="Special requests" hint="Customer requests and chef quotes across the Chef Network." action={<Link href="/admin/chefs" className="text-sm underline">← Chef Network</Link>} />
      {s && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Open" value={s.open} />
          <Stat label="Waiting on chefs" value={s.waitingOnChef} hint={[s.dueSoon ? `${s.dueSoon} due within 4 h` : '', s.escalated ? `${s.escalated} escalated` : ''].filter(Boolean).join(' · ') || undefined} />
          <Stat label="Avg first response" value={mins(s.avgResponseMinutes)} hint="Last 30 days" />
          <Stat label="Quotes ordered" value={s.quoteAcceptancePct === null ? '—' : `${s.quoteAcceptancePct}%`} hint="Last 30 days" />
          <Stat label="Expired" value={s.expired30} hint={`of ${s.total30} in 30 days`} />
        </div>
      )}
      <div className="max-w-xs"><Select label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="OPEN">Open</option><option value="ESCALATED">Escalated to Gutad</option><option value="OVERDUE">Due within 4 hours</option>{CHEF_REQUEST_STATUSES.map((st) => <option key={st} value={st}>{CHEF_REQUEST_STATUS_LABELS[st]}</option>)}<option value="ALL">All</option></Select></div>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : !data.requests.length ? <Empty>No requests.</Empty> : <div className="space-y-2">{data.requests.map((r) => <RequestRow key={r.id} r={r} href={`/admin/chefs/requests/${r.id}`} viewer="STAFF" />)}</div>}
    </div>
  );
}
