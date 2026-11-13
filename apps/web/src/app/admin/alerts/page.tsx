'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Tabs, Textarea } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

export interface OpsAlert { id: string; type: string; severity: string; status: string; title: string; detail: string | null; subjectType: string; subjectId: string; ownerId: string | null; ownerEmail: string | null; ownerRole: string; escalateAt: string | null; escalationLevel: number; history: { at: string; by: string | null; action: string; note: string | null; email?: string }[]; resolution: string | null; autoResolved: boolean; createdAt: string; resolvedAt: string | null }
const sevTone = (s: string) => (s === 'CRITICAL' || s === 'HIGH' ? 'bad' : s === 'MEDIUM' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';
const subjectLink = (a: OpsAlert) => (a.subjectType === 'order' ? `/admin/orders/${a.subjectId}` : null);

export default function Alerts() {
  const { can } = useSession();
  const [tab, setTab] = useState('ACTIVE');
  const q = tab === 'MINE' ? '?mine=true' : `?status=${tab}`;
  const { data, reload } = useApi<OpsAlert[]>(`/admin/alerts${q}`, { poll: 15000, deps: [tab] });
  const { data: sum } = useApi<{ active: number; unacknowledged: number; overdue: number; mine: number; bySeverity: Record<string, number> }>('/admin/alerts/summary', { poll: 15000 });
  const { run, error } = useAction();
  const [sel, setSel] = useState<OpsAlert | null>(null);
  const [create, setCreate] = useState(false);
  const [nw, setNw] = useState({ title: '', detail: '', severity: 'HIGH', ownerRole: 'OPERATIONS' });
  return (
    <div className="space-y-4">
      <SectionTitle title="Alerts" hint="Raised by detectors every minute (unaccepted, overdue and stuck orders, late deliveries, status conflicts, offline devices, paused locations, failed payouts and webhooks) or by people. Unresolved alerts escalate when their deadline passes." action={can('ops.manage') ? <div className="flex gap-2"><Button variant="secondary" onClick={() => run(async () => { await api.post('/admin/alerts/detect', {}); reload(); })}>Run detectors</Button><Button onClick={() => setCreate(true)}>Raise alert</Button></div> : undefined} />
      {error && <Alert>{error}</Alert>}
      {sum && <div className="flex flex-wrap gap-2 text-sm"><Badge tone="bad">{sum.bySeverity.CRITICAL || 0} critical</Badge><Badge tone="bad">{sum.bySeverity.HIGH || 0} high</Badge><Badge tone="warn">{sum.bySeverity.MEDIUM || 0} medium</Badge><Badge>{sum.bySeverity.LOW || 0} low</Badge><span className="text-ink-500">{sum.unacknowledged} not acknowledged · {sum.overdue} past deadline · {sum.mine} mine</span></div>}
      <Tabs tabs={[{ id: 'ACTIVE', label: 'Active' }, { id: 'MINE', label: 'Assigned to me' }, { id: 'RESOLVED', label: 'Resolved' }]} active={tab} onChange={setTab} />
      <ul className="divide-y divide-ink-100 rounded-xl border border-ink-100 bg-white">
        {(data || []).map((a) => (
          <li key={a.id}><button className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ink-50" onClick={() => setSel(a)}>
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={sevTone(a.severity)}>{a.severity}</Badge><span className="font-medium">{a.title}</span>{a.status === 'ACKNOWLEDGED' && <Badge tone="info">acknowledged</Badge>}{a.escalationLevel > 0 && <Badge tone="bad">escalated ×{a.escalationLevel}</Badge>}</div><div className="text-xs text-ink-500">{a.type.replace(/_/g, ' ').toLowerCase()} · owner {a.ownerEmail || a.ownerRole.toLowerCase()} · raised {when(a.createdAt)}</div></div>
            <div className="text-right text-xs">{a.status === 'RESOLVED' ? <span className="text-emerald-700">resolved {when(a.resolvedAt)}{a.autoResolved ? ' (auto)' : ''}</span> : a.escalateAt && <span className={new Date(a.escalateAt) < new Date() ? 'font-semibold text-red-700' : 'text-ink-500'}>escalates {when(a.escalateAt)}</span>}</div>
          </button></li>
        ))}
        {data?.length === 0 && <li className="p-6 text-center text-sm text-ink-500">No alerts here.</li>}
      </ul>
      {sel && <AlertDetail a={sel} onClose={() => setSel(null)} onChange={async () => { await reload(); setSel(null); }} />}
      <Modal open={create} onClose={() => setCreate(false)} title="Raise an alert">
        <div className="space-y-2">
          <Input label="Title" value={nw.title} onChange={(e) => setNw({ ...nw, title: e.target.value })} />
          <Textarea label="Details" rows={2} value={nw.detail} onChange={(e) => setNw({ ...nw, detail: e.target.value })} />
          <div className="grid grid-cols-2 gap-2"><Select label="Severity" value={nw.severity} onChange={(e) => setNw({ ...nw, severity: e.target.value })}>{['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s}>{s}</option>)}</Select><Select label="Owning team" value={nw.ownerRole} onChange={(e) => setNw({ ...nw, ownerRole: e.target.value })}>{['OPERATIONS', 'DISPATCHER', 'SUPPORT', 'FINANCE', 'IT', 'EXECUTIVE'].map((s) => <option key={s}>{s}</option>)}</Select></div>
          <Button onClick={() => run(async () => { await api.post('/admin/alerts', { ...nw, detail: nw.detail || undefined }); setCreate(false); setNw({ title: '', detail: '', severity: 'HIGH', ownerRole: 'OPERATIONS' }); reload(); })}>Raise</Button>
        </div>
      </Modal>
    </div>
  );
}

function AlertDetail({ a, onClose, onChange }: { a: OpsAlert; onClose: () => void; onChange: () => void }) {
  const { user } = useSession();
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const act = (action: string, body: Record<string, unknown>) => run(async () => { await api.post(`/admin/alerts/${a.id}/${action}`, body); onChange(); });
  const link = subjectLink(a);
  return (
    <Modal open onClose={onClose} title={a.title}>
      <div className="space-y-3 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-2"><Badge tone={sevTone(a.severity)}>{a.severity}</Badge><Badge>{a.status}</Badge><span className="text-xs text-ink-500">owner {a.ownerEmail || a.ownerRole.toLowerCase()} · level {a.escalationLevel}{a.escalateAt && a.status !== 'RESOLVED' ? ` · escalates ${when(a.escalateAt)}` : ''}</span></div>
        {a.detail && <p>{a.detail}</p>}
        {link && <Link className="text-sm underline" href={link}>Open the order</Link>}
        <div><div className="mb-1 text-xs font-semibold text-ink-500">History</div><ol className="space-y-1 text-xs">{a.history.map((h, i) => <li key={i}><span className="text-ink-500">{when(h.at)}</span> <b>{h.action.toLowerCase().replace('_', ' ')}</b>{h.email ? ` by ${h.email}` : h.by ? '' : ' (system)'}{h.note && <> — {h.note}</>}</li>)}</ol></div>
        {a.status !== 'RESOLVED' ? (
          <>
            <Textarea label="Note / resolution" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {a.status === 'OPEN' && <Button size="sm" onClick={() => act('ack', { note: note || undefined })}>Acknowledge</Button>}
              {a.ownerId !== user?.id && <Button size="sm" variant="secondary" onClick={() => act('assign', { ownerId: user?.id, note: note || 'Taking this' })}>Assign to me</Button>}
              <Button size="sm" variant="secondary" disabled={!note} onClick={() => act('comment', { note })}>Comment</Button>
              <Button size="sm" variant="danger" disabled={note.trim().length < 3} onClick={() => act('resolve', { resolution: note })}>Resolve</Button>
            </div>
          </>
        ) : <div className="flex items-center justify-between"><span className="text-xs">Resolution: {a.resolution}</span><Button size="sm" variant="ghost" onClick={() => act('reopen', { note: 'Reopened' })}>Reopen</Button></div>}
      </div>
    </Modal>
  );
}
