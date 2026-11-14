'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Modal, Table } from '@/components/ui';
import { day, Notice, Panel, useRoles, useStepUp } from './common';

interface Review { id: string; name: string; status: string; dueAt: string; criteria: { roleIds?: string[]; inactiveDays?: number; automatic?: boolean }; completedAt: string | null; createdAt: string; total: number; open: number; revoked: number }
interface ReviewItem { id: string; userId: string; email: string; name: string | null; userStatus: string; flags: string[]; snapshot: { assignmentId: string; roleId: string; key: string; name: string; kind: string; endsAt: string | null }[]; decision: string; note: string | null; decidedAt: string | null; mine: boolean }

const FLAG_TONE: Record<string, 'bad' | 'warn' | 'info' | 'neutral'> = { SUPERADMIN: 'bad', PRIVILEGED: 'bad', NO_MFA: 'warn', INACTIVE: 'warn', NEVER_SIGNED_IN: 'warn', TEMPORARY: 'info' };

export function ReviewsTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const { data, reload } = useApi<Review[]>('/admin/iam/reviews');
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  return (
    <div className="space-y-3">
      {manage && <div className="flex justify-end"><Button onClick={() => setCreate(true)}>New access review</Button></div>}
      <Table rows={data || []} empty="No access reviews yet." cols={[
        { key: 'n', label: 'Review', render: (r) => <button className="text-left" onClick={() => setOpen(r.id)}><span className="font-medium underline">{r.name}</span>{r.criteria?.automatic && <span className="block text-xs text-ink-500">scheduled automatically</span>}</button> },
        { key: 's', label: 'Status', render: (r) => <Badge tone={r.status === 'OPEN' ? (new Date(r.dueAt) < new Date() ? 'bad' : 'warn') : 'good'}>{r.status}</Badge> },
        { key: 'p', label: 'Progress', render: (r) => <div className="w-40"><div className="h-2 rounded-full bg-ink-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${r.total ? Math.round(((r.total - r.open) / r.total) * 100) : 100}%` }} /></div><span className="text-xs text-ink-500">{r.total - r.open}/{r.total} decided · {r.revoked} removed</span></div> },
        { key: 'd', label: 'Due', render: (r) => <span className="text-xs">{r.completedAt ? `completed ${day(r.completedAt)}` : day(r.dueAt)}</span> },
      ]} />
      {open && <ReviewDetail id={open} onClose={() => setOpen(null)} onChange={() => { void reload(); onChange(); }} />}
      {create && <CreateReview onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); onChange(); setOpen(id); }} />}
    </div>
  );
}

function CreateReview({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { data: roles } = useRoles();
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ name: `Access review ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`, dueInDays: '14', inactiveDays: '', roleIds: [] as string[] });
  return (
    <Modal open onClose={onClose} title="New access review">
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label="Due in (days)" type="number" min={1} max={90} value={f.dueInDays} onChange={(e) => setF({ ...f, dueInDays: e.target.value })} />
          <Input label="Flag inactive after (days, empty = policy)" type="number" min={1} max={365} value={f.inactiveDays} onChange={(e) => setF({ ...f, inactiveDays: e.target.value })} />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-500">Only people holding these roles (none ticked = everyone with a role)</span>
          <div className="grid max-h-40 gap-1 overflow-auto rounded-lg border border-ink-100 p-2 sm:grid-cols-2">{(roles || []).map((r) => <label key={r.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.roleIds.includes(r.id)} onChange={(e) => setF({ ...f, roleIds: e.target.checked ? [...f.roleIds, r.id] : f.roleIds.filter((x) => x !== r.id) })} />{r.name}</label>)}</div>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || f.name.trim().length < 3} onClick={() => run(async () => { const r = await api.post<{ id: string }>('/admin/iam/reviews', { name: f.name.trim(), dueInDays: f.dueInDays ? Number(f.dueInDays) : undefined, inactiveDays: f.inactiveDays ? Number(f.inactiveDays) : undefined, roleIds: f.roleIds.length ? f.roleIds : undefined }); onDone(r.id); })}>Start review</Button></div>
      </div>
    </Modal>
  );
}

function ReviewDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const { data: r, reload } = useApi<Review & { items: ReviewItem[] }>(`/admin/iam/reviews/${id}`);
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const decide = (it: ReviewItem, decision: 'KEEP' | 'REVOKE' | 'SUSPEND') => {
    let note: string | undefined;
    if (decision !== 'KEEP') {
      const n = window.prompt(`Why ${decision === 'REVOKE' ? 'remove every role from' : 'suspend'} ${it.email}?`);
      if (n === null) return;
      if (n.trim().length < 3) { window.alert('Please give a short note (at least 3 characters).'); return; }
      note = n.trim();
    }
    void run(async () => { await withStepUp((stepUp) => api.post(`/admin/iam/reviews/${id}/items/${it.id}`, { decision, note, stepUp })); await reload(); onChange(); });
  };
  const isOpen = r?.status === 'OPEN';
  return (
    <Panel open onClose={onClose} title={r?.name || 'Access review'}>
      {r && (
        <div className="space-y-3 text-sm">
          {error && <Alert>{error}</Alert>}
          <Notice text={notice} onClose={() => setNotice(null)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-500">{r.status} · due {when(r.dueAt)} · {r.items.filter((i) => i.decision !== 'PENDING').length}/{r.items.length} decided</span>
            {manage && isOpen && <Button size="sm" disabled={busy} onClick={() => run(async () => { await api.post(`/admin/iam/reviews/${id}/complete`, {}); setNotice('Review completed.'); await reload(); onChange(); })}>Complete review</Button>}
          </div>
          <Table rows={r.items} empty="Nobody matched this review." cols={[
            { key: 'p', label: 'Person', render: (it) => <span>{it.name || it.email}{it.name && <span className="block text-xs text-ink-500">{it.email}</span>}{it.userStatus !== 'ACTIVE' && <Badge tone="warn">{it.userStatus}</Badge>}</span> },
            { key: 'r', label: 'Roles at review start', render: (it) => <div className="flex flex-wrap gap-1">{it.snapshot.map((s) => <Badge key={s.assignmentId} tone={s.key === 'PLATFORM_ADMIN' ? 'bad' : 'info'}>{s.name}{s.endsAt ? ` until ${day(s.endsAt)}` : ''}</Badge>)}</div> },
            { key: 'f', label: 'Flags', render: (it) => <div className="flex flex-wrap gap-1">{it.flags.map((f) => <Badge key={f} tone={FLAG_TONE[f] || 'neutral'}>{f.replace(/_/g, ' ')}</Badge>)}</div> },
            { key: 'd', label: 'Decision', render: (it) => it.decision === 'PENDING' ? (manage && isOpen ? (
              <div className="flex flex-wrap gap-1" title={it.mine ? 'Someone else must review your access' : undefined}>
                <Button size="sm" disabled={busy || it.mine} onClick={() => decide(it, 'KEEP')}>Keep</Button>
                <Button size="sm" variant="secondary" disabled={busy || it.mine} onClick={() => decide(it, 'REVOKE')}>Revoke</Button>
                <Button size="sm" variant="danger" disabled={busy || it.mine} onClick={() => decide(it, 'SUSPEND')}>Suspend</Button>
              </div>
            ) : <Badge tone="warn">pending</Badge>) : <span><Badge tone={it.decision === 'KEEP' ? 'good' : 'bad'}>{it.decision}</Badge>{it.note && <span className="block text-xs text-ink-500">{it.note}</span>}</span> },
          ]} />
        </div>
      )}
    </Panel>
  );
}
