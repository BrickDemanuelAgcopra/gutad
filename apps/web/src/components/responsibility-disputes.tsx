'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, statusTone, Textarea } from '@/components/ui';

export interface ResponsibilityTicket { id: string; category: string; status: string; owner: string; remedy: string | null; remedyCents: number; resolvedAt: string | null; createdAt: string; orderNumber: string | null; organizationId: string | null; role: 'MERCHANT' | 'DRIVER'; dispute: { status: string | null; reason: string | null; at: string | null; note: string | null; decidedAt: string | null } | null; canDispute: boolean }

const DISPUTE_LABEL: Record<string, string> = { OPEN: 'Under review', UPHELD: 'Upheld — responsibility stays', REVERSED: 'Reversed — Gutad takes responsibility' };

/** 24.6-W tickets where your business was held responsible, with a way to ask Gutad to review that decision. */
export function ResponsibilityDisputes({ organizationId }: { organizationId: string }) {
  const { data, reload } = useApi<ResponsibilityTicket[]>('/me/responsibility-tickets', { deps: [organizationId] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const rows = (data || []).filter((t) => t.role === 'MERCHANT' && t.organizationId === organizationId);
  return (
    <Card title="Responsibility decisions">
      <p className="mb-2 text-xs text-ink-500">Resolved tickets where your business was held responsible (for example a refund charged to you). If you disagree, explain why and Gutad support reviews it; a reversal re-credits any refund you funded.</p>
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <ul className="divide-y divide-ink-100 text-sm">
        {rows.map((t) => (
          <li key={t.id} className="py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><span className="font-medium">{t.category.toLowerCase().replace(/_/g, ' ')}</span>{t.orderNumber ? <span className="text-xs text-ink-500"> · order {t.orderNumber}</span> : null}<span className="text-xs text-ink-500"> · {when(t.resolvedAt || t.createdAt)}</span></span>
              <span className="flex items-center gap-2">{t.remedy && <span className="text-xs">{t.remedy.toLowerCase()}{t.remedyCents ? ` ${money(t.remedyCents)}` : ''}</span>}{t.dispute?.status ? <Badge tone={t.dispute.status === 'REVERSED' ? 'good' : t.dispute.status === 'OPEN' ? 'info' : 'neutral'}>{DISPUTE_LABEL[t.dispute.status] || t.dispute.status}</Badge> : <Badge tone={statusTone(t.status)}>{t.status}</Badge>}</span>
            </div>
            {t.dispute?.reason && <div className="mt-1 text-xs text-ink-500">Your reason: {t.dispute.reason}{t.dispute.note ? ` · Gutad: ${t.dispute.note}` : ''}</div>}
            {t.canDispute && open !== t.id && <Button className="mt-1" size="sm" variant="secondary" onClick={() => { setOpen(t.id); setReason(''); setOk(null); }}>Dispute responsibility</Button>}
            {open === t.id && (
              <div className="mt-2 space-y-2">
                <Textarea rows={3} placeholder="Why your business shouldn’t carry this (e.g. the courier confirmed the bag was sealed and complete at handoff)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex gap-2"><Button size="sm" disabled={reason.trim().length < 5} onClick={() => run(async () => { await api.post(`/incidents/${t.id}/dispute-responsibility`, { reason: reason.trim() }); setOpen(null); setOk('Sent. Gutad support will review the decision.'); reload(); })}>Send dispute</Button><Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button></div>
              </div>
            )}
          </li>
        ))}
        {data && !rows.length && <li className="py-4 text-center text-sm text-ink-500">No tickets were charged to your business.</li>}
      </ul>
    </Card>
  );
}
