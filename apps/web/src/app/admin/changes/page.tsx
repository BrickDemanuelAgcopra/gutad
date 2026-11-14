'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Change { id: string; kind: string; summary: string; organizationName: string; requestedByEmail: string | null; changes: Record<string, unknown>; before: Record<string, unknown> | null; status: string; reviewNote: string | null; createdAt: string }

export default function Changes() {
  const { can } = useSession();
  const [tab, setTab] = useState('PENDING');
  const { data, reload } = useApi<Change[]>(`/admin/change-requests?status=${tab}`, { deps: [tab] });
  const { data: settings } = useApi<{ settings: Record<string, unknown> }>(can('settings.manage') ? '/admin/settings' : null);
  const { run, error } = useAction();
  const review = (settings?.settings['merchants.review_changes'] as { menu?: boolean; business?: boolean } | undefined) || {};
  return (
    <div className="space-y-4">
      <SectionTitle title="Change requests" hint={`Merchant edits to customer-facing menu content and business information wait here when review is on (menu: ${review.menu ? 'on' : 'off'}, business info: ${review.business ? 'on' : 'off'} — setting merchants.review_changes).`} />
      {error && <Alert>{error}</Alert>}
      <Tabs tabs={[{ id: 'PENDING', label: 'Waiting' }, { id: 'APPROVED', label: 'Approved' }, { id: 'REJECTED', label: 'Rejected' }]} active={tab} onChange={setTab} />
      {(data || []).map((c) => (
        <Card key={c.id} title={c.summary} action={<Badge tone={c.status === 'APPROVED' ? 'good' : c.status === 'REJECTED' ? 'bad' : 'warn'}>{c.status}</Badge>}>
          <div className="text-xs text-ink-500">{c.organizationName} · {c.kind.toLowerCase().replace('_', ' ')} · {c.requestedByEmail} · {when(c.createdAt)}</div>
          <table className="mt-2 w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th>Field</th><th>Now</th><th>Proposed</th></tr></thead><tbody>{Object.entries(c.changes).map(([k, v]) => <tr key={k} className="border-t border-ink-50 align-top"><td className="py-1 pr-2 text-xs font-medium">{k}</td><td className="py-1 pr-2 text-xs text-ink-500">{JSON.stringify(c.before?.[k] ?? null)}</td><td className="py-1 text-xs">{JSON.stringify(v)}</td></tr>)}</tbody></table>
          {c.reviewNote && <p className="mt-1 text-xs">Note: {c.reviewNote}</p>}
          {c.status === 'PENDING' && (can('merchants.manage') || can('catalog.manage')) && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => run(async () => { await api.post(`/admin/change-requests/${c.id}/approve`, {}); reload(); })}>Approve & apply</Button><Button size="sm" variant="danger" onClick={() => { const note = window.prompt('Why? (sent to the merchant)'); if (note) run(async () => { await api.post(`/admin/change-requests/${c.id}/reject`, { note }); reload(); }); }}>Reject</Button></div>}
        </Card>
      ))}
      {data?.length === 0 && <p className="text-sm text-ink-500">Nothing here.</p>}
    </div>
  );
}
