'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Select, statusTone, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

interface Case { id: string; category: string; description: string; status: string; remedy: string | null; orderNumber: string | null; aboutMerchant: boolean; reporterType: string; createdAt: string }
interface Msg { id: string; authorRole: string; authorEmail: string | null; body: string; createdAt: string }
const CATEGORIES = [['PAYOUT', 'Payouts & statements'], ['ORDER_DISPUTE', 'Dispute a complaint or refund'], ['MENU', 'Menu or listing'], ['TECH', 'Tablet, printer or app'], ['DELIVERY', 'Couriers & delivery'], ['OTHER', 'Something else']];

/** Merchant support: cases you opened and complaints about your orders, with a conversation with Gutad. */
export default function MerchantSupport() {
  const { org } = useMerchant();
  const { data, reload } = useApi<Case[]>(org ? `/organizations/${org.id}/cases` : null, { deps: [org?.id] });
  const { run, error } = useAction();
  const [open, setOpen] = useState<Case | null>(null);
  const { data: msgs, reload: reloadMsgs } = useApi<Msg[]>(open ? `/incidents/${open.id}/messages` : null, { deps: [open?.id] });
  const [f, setF] = useState({ category: 'PAYOUT', description: '' });
  const [reply, setReply] = useState('');
  if (!org) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Support</h1>
      {error && <Alert>{error}</Alert>}
      <Card title="Open a case">
        <div className="grid gap-2 sm:grid-cols-[220px_1fr_auto]"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select><Textarea rows={2} placeholder="What happened? Include order numbers and dates." value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /><Button className="self-start" disabled={f.description.length < 5} onClick={() => run(async () => { await api.post(`/organizations/${org.id}/cases`, f); setF({ ...f, description: '' }); reload(); })}>Send</Button></div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white">
          {(data || []).map((c) => <li key={c.id}><button className={`w-full px-4 py-3 text-left hover:bg-ink-50 ${open?.id === c.id ? 'bg-brand-50' : ''}`} onClick={() => setOpen(c)}><div className="flex items-center justify-between"><span className="font-medium">{c.category.toLowerCase().replace(/_/g, ' ')}</span><Badge tone={statusTone(c.status)}>{c.status}</Badge></div><div className="text-xs text-ink-500">{c.aboutMerchant ? `Complaint from a ${c.reporterType.toLowerCase()}` : 'Opened by you'}{c.orderNumber ? ` · order ${c.orderNumber}` : ''} · {when(c.createdAt)}</div><div className="truncate text-sm">{c.description}</div></button></li>)}
          {data?.length === 0 && <li className="p-6 text-center text-sm text-ink-500">No cases.</li>}
        </ul>
        {open && (
          <Card title={open.category.toLowerCase().replace(/_/g, ' ')}>
            <p className="text-sm">{open.description}</p>
            {open.remedy && <p className="mt-1 text-xs">Outcome: {open.remedy.toLowerCase()}</p>}
            <div className="mt-3 space-y-2">{(msgs || []).map((m) => <div key={m.id} className={`rounded-lg p-2 text-sm ${m.authorRole === 'STAFF' ? 'bg-sky-50' : 'bg-ink-50'}`}><div className="text-xs text-ink-500">{m.authorEmail || m.authorRole.toLowerCase()} · {when(m.createdAt)}</div>{m.body}</div>)}</div>
            <Textarea className="mt-3" rows={2} placeholder={open.status === 'RESOLVED' ? 'Replying re-opens the case as an appeal' : 'Reply to Gutad'} value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button className="mt-2" size="sm" disabled={!reply} onClick={() => run(async () => { await api.post(`/incidents/${open.id}/messages`, { body: reply }); setReply(''); reloadMsgs(); reload(); })}>Send reply</Button>
          </Card>
        )}
      </div>
    </div>
  );
}
