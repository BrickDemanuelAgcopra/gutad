'use client';
import { useState } from 'react';
import type { ChefRequestSummary } from '@gutad/shared';
import { useApi } from '@/lib/hooks';
import { Alert, Empty, Spinner, Tabs } from '@/components/ui';
import { RequestRow } from '@/components/chef-requests';

const TABS = [
  { id: 'needsReply', label: 'Needs reply' },
  { id: 'waiting', label: 'Waiting on customer' },
  { id: 'won', label: 'Accepted & ordered' },
  { id: 'closed', label: 'Closed' },
] as const;

/** Chef inbox: special requests, oldest deadline first. */
export default function ChefRequestsInbox() {
  const [tab, setTab] = useState<string>('needsReply');
  const { data, error } = useApi<{ requests: ChefRequestSummary[]; counts: Record<string, number> }>(`/chef/requests?status=${tab}`, { poll: 30_000 });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Special requests</h1>
        <p className="text-sm text-ink-600">Customers ask for changes your options don’t cover. Quote them, suggest one of your dishes instead, ask a question or decline. Unanswered requests expire, and response time shows on your Gutad record.</p>
      </div>
      <Tabs tabs={TABS.map((t) => ({ id: t.id, label: `${t.label}${data?.counts[t.id] ? ` (${data.counts[t.id]})` : ''}` }))} active={tab} onChange={setTab} />
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : !data.requests.length ? <Empty>{tab === 'needsReply' ? 'You’re all caught up.' : 'Nothing here.'}</Empty> : <div className="space-y-2">{data.requests.map((r) => <RequestRow key={r.id} r={r} href={`/chef/requests/${r.id}`} viewer="CHEF" />)}</div>}
    </div>
  );
}
