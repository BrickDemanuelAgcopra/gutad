'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Table, Textarea } from '@/components/ui';
import { Notice } from './common';

interface AccessRequest { id: string; requesterId: string; roleId: string; justification: string; durationHours: number | null; status: string; decisionNote: string | null; decidedAt: string | null; expiresAt: string; createdAt: string; roleName: string; roleKey: string; privileged: boolean; requesterEmail: string; requesterName: string | null; canDecide: boolean }
interface Requestable { id: string; key: string; name: string; description: string; permissions: string[]; held: boolean }

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'EXPIRED'];
const duration = (h: number | null) => (h ? (h % 24 === 0 ? `${h / 24} day(s)` : `${h} h`) : 'permanent');

export function RequestsTab({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('PENDING');
  const { data, reload } = useApi<AccessRequest[]>(`/iam/access-requests${status ? `?status=${status}` : ''}`, { deps: [status] });
  const { run, error, busy } = useAction();
  const [approve, setApprove] = useState<AccessRequest | null>(null);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const done = async (t: string) => { setApprove(null); setNote(''); setHours(''); setNotice(t); await reload(); onChange(); };
  const reject = (r: AccessRequest) => {
    const n = window.prompt(`Why reject ${r.requesterEmail}'s request for ${r.roleName}?`);
    if (n === null) return;
    if (n.trim().length < 3) { window.alert('Please give a short note (at least 3 characters).'); return; }
    void run(async () => { await api.post(`/iam/access-requests/${r.id}/reject`, { note: n.trim() }); await done('Request rejected.'); });
  };
  return (
    <div className="space-y-4">
      <MyAccess />
      <Card title="Access requests" action={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>}>
        <div className="space-y-2">
          {error && <Alert>{error}</Alert>}
          <Notice text={notice} onClose={() => setNotice(null)} />
          <Table rows={data || []} empty="No requests." cols={[
            { key: 'w', label: 'Who', render: (r) => <span>{r.requesterName || r.requesterEmail}{r.requesterName && <span className="block text-xs text-ink-500">{r.requesterEmail}</span>}</span> },
            { key: 'r', label: 'Role', render: (r) => <span>{r.roleName} {r.privileged && <Badge tone="bad">privileged</Badge>}</span> },
            { key: 'j', label: 'Why', render: (r) => <span className="text-xs">{r.justification}</span> },
            { key: 'd', label: 'For', render: (r) => <span className="text-xs">{duration(r.durationHours)}</span> },
            { key: 's', label: 'Status', render: (r) => <span><Badge tone={statusTone(r.status === 'APPROVED' ? 'COMPLETED' : r.status)}>{r.status}</Badge>{r.decisionNote && <span className="block text-xs text-ink-500">{r.decisionNote}</span>}</span> },
            { key: 'c', label: 'Asked', render: (r) => <span className="text-xs">{when(r.createdAt)}</span> },
            { key: 'a', label: '', render: (r) => r.canDecide ? <div className="flex gap-1"><Button size="sm" onClick={() => { setApprove(r); setHours(r.durationHours ? String(r.durationHours) : ''); }}>Approve</Button><Button size="sm" variant="ghost" className="text-red-600" disabled={busy} onClick={() => reject(r)}>Reject</Button></div> : null },
          ]} />
        </div>
      </Card>
      <Modal open={!!approve} onClose={() => setApprove(null)} title={approve ? `Give ${approve.requesterEmail} ${approve.roleName}` : ''}>
        {approve && (
          <div className="space-y-2 text-sm">
            {error && <Alert>{error}</Alert>}
            <div className="rounded-lg bg-ink-50 p-2 text-xs">“{approve.justification}” · asked for {duration(approve.durationHours)}</div>
            <Input label="Duration in hours (empty = permanent)" type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(e.target.value)} />
            <Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setApprove(null)}>Cancel</Button><Button disabled={busy || (hours !== '' && !(Number(hours) >= 1))} onClick={() => run(async () => { await api.post(`/iam/access-requests/${approve.id}/approve`, { note: note || undefined, durationHours: hours ? Math.round(Number(hours)) : null }); await done(`${approve.roleName} granted to ${approve.requesterEmail}.`); })}>Approve</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** The signed-in person's own requests (any staff member). */
function MyAccess() {
  const { data: roles, reload: reloadRoles } = useApi<Requestable[]>('/iam/requestable-roles');
  const { data: mine, reload } = useApi<AccessRequest[]>('/iam/access-requests?mine=true');
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ roleId: '', justification: '', hours: '' });
  const [ok, setOk] = useState<string | null>(null);
  const role = roles?.find((r) => r.id === f.roleId);
  const submit = () => run(async () => {
    await api.post('/iam/access-requests', { roleId: f.roleId, justification: f.justification.trim(), durationHours: f.hours ? Math.round(Number(f.hours)) : null });
    setOk(`Request for ${role?.name} sent. You will be notified when someone decides.`);
    setF({ roleId: '', justification: '', hours: '' });
    await Promise.all([reload(), reloadRoles()]);
  });
  return (
    <Card title="Request access for yourself">
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <Notice text={ok} onClose={() => setOk(null)} />
        <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
          <Select label="Role" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}><option value="">Choose…</option>{(roles || []).filter((r) => !r.held).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          <Input label="Hours (empty = permanent)" type="number" min={1} max={2160} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
        </div>
        {role?.description && <p className="text-xs text-ink-500">{role.description}</p>}
        <Textarea label="Why do you need it? (at least 10 characters)" rows={2} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} />
        <Button size="sm" disabled={busy || !f.roleId || f.justification.trim().length < 10 || (f.hours !== '' && !(Number(f.hours) >= 1))} onClick={submit}>Send request</Button>
        {!!mine?.length && (
          <div className="pt-2">
            <div className="mb-1 text-xs font-semibold text-ink-500">My requests</div>
            <ul className="space-y-1">{mine.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-50 px-2 py-1 text-xs"><span>{r.roleName} · {duration(r.durationHours)} · <Badge tone={statusTone(r.status === 'APPROVED' ? 'COMPLETED' : r.status)}>{r.status}</Badge> {r.decisionNote && <i className="text-ink-500">“{r.decisionNote}”</i>} <span className="text-ink-500">{when(r.createdAt)}</span></span>{r.status === 'PENDING' && <button className="text-red-600" onClick={() => run(async () => { await api.post(`/iam/access-requests/${r.id}/cancel`, {}); await reload(); })}>Cancel</button>}</li>)}</ul>
          </div>
        )}
      </div>
    </Card>
  );
}
