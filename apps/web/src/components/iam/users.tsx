'use client';
import { useState } from 'react';
import { USER_STATUSES } from '@gutad/shared';
import { api, downloadFile, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Modal, Select, Table, Textarea } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { Notice, personLabel, RoleChips, SecretModal, statusBadge, useRoles, useStaff, useStepUp, type StaffRow } from './common';
import { UserDetail } from './user-detail';

export function UsersTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [roleId, setRoleId] = useState('');
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(roleId ? { roleId } : {}) }).toString();
  const { data, reload, loading } = useApi<StaffRow[]>(`/admin/iam/users${qs ? `?${qs}` : ''}`, { deps: [qs] });
  const { data: roles } = useRoles();
  const { run, error } = useAction();
  const [sel, setSel] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);
  const [imp, setImp] = useState(false);
  const changed = () => { void reload(); onChange(); };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <Input className="min-w-[200px] flex-1" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{USER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">Any role</option>{(roles || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        <Button variant="secondary" onClick={() => run(() => downloadFile('/admin/iam/users/export.csv', `gutad-staff-${new Date().toISOString().slice(0, 10)}.csv`))}>Export CSV</Button>
        {manage && <Button variant="secondary" onClick={() => setImp(true)}>Bulk import</Button>}
        {manage && <Button onClick={() => setInvite(true)}>Invite staff</Button>}
      </div>
      <Table rows={data || []} empty={loading ? 'Loading…' : 'No staff match.'} cols={[
        { key: 'p', label: 'Person', render: (u) => <button className="text-left" onClick={() => setSel(u.id)}><span className="font-medium underline">{u.name || u.email}</span>{u.name && <span className="block text-xs text-ink-500">{u.email}</span>}</button> },
        { key: 't', label: 'Title / department', render: (u) => <span className="text-xs">{u.title || '—'}{u.department && <span className="block text-ink-500">{u.department}{u.team ? ` · ${u.team}` : ''}</span>}</span> },
        { key: 'r', label: 'Roles', render: (u) => <RoleChips roles={u.roles} /> },
        { key: 's', label: 'Status', render: (u) => <div className="flex flex-wrap gap-1">{statusBadge(u.status)}{u.inactive && <Badge tone="warn">inactive</Badge>}{u.scoped && <Badge>scoped</Badge>}</div> },
        { key: 'm', label: 'MFA', render: (u) => u.mfaEnabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge> },
        { key: 'l', label: 'Last sign-in', render: (u) => <span className="text-xs">{u.lastLoginAt ? when(u.lastLoginAt) : 'never'}{u.sessions > 0 && <span className="block text-ink-500">{u.sessions} session(s)</span>}</span> },
      ]} />
      {sel && <UserDetail id={sel} onClose={() => setSel(null)} onChange={changed} />}
      {invite && <InviteModal onClose={() => setInvite(false)} onDone={changed} />}
      {imp && <ImportModal onClose={() => setImp(false)} onDone={changed} />}
    </div>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { data: roles } = useRoles();
  const { data: staff } = useStaff();
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ email: '', name: '', title: '', department: '', team: '', managerId: '', roleIds: [] as string[], primaryRoleId: '' });
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = () => {
    const reason = askReason(`inviting ${f.email}`);
    if (!reason) return;
    void run(async () => {
      const res = await withStepUp((stepUp) => api.post<{ inviteLink?: string; pendingApprovals?: { summary?: string }[] }>('/admin/iam/users', {
        email: f.email.trim(), name: f.name || null, title: f.title || null, department: f.department || null, team: f.team || null, managerId: f.managerId || null,
        roleIds: f.roleIds, primaryRoleId: f.primaryRoleId || f.roleIds[0] || null, reason, stepUp,
      }));
      onDone();
      if (res.pendingApprovals?.length) setNotice(`Sent for approval: ${res.pendingApprovals.map((p) => p.summary).filter(Boolean).join('; ') || 'superadmin role'}. A second superadmin must approve it in Admin → Approvals before it applies.`);
      if (res.inviteLink) setLink(res.inviteLink);
      else if (!res.pendingApprovals?.length) onClose();
    });
  };
  const chosen = (roles || []).filter((r) => f.roleIds.includes(r.id));
  return (
    <>
      <Modal open={!link} onClose={onClose} title="Invite staff">
        <div className="space-y-2 text-sm">
          {error && <Alert>{error}</Alert>}
          <Notice text={notice} onClose={() => setNotice(null)} />
          <Input label="Work email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Input label="Job title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            <Input label="Department" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />
            <Input label="Team" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} />
          </div>
          <Select label="Manager" value={f.managerId} onChange={(e) => setF({ ...f, managerId: e.target.value })}><option value="">None</option>{(staff || []).filter((s) => s.status === 'ACTIVE').map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}</Select>
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-500">Roles</span>
            <div className="grid max-h-40 gap-1 overflow-auto rounded-lg border border-ink-100 p-2 sm:grid-cols-2">{(roles || []).map((r) => <label key={r.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.roleIds.includes(r.id)} onChange={(e) => setF({ ...f, roleIds: e.target.checked ? [...f.roleIds, r.id] : f.roleIds.filter((x) => x !== r.id), primaryRoleId: !e.target.checked && f.primaryRoleId === r.id ? '' : f.primaryRoleId })} />{r.name}{r.privileged && <Badge tone="bad">privileged</Badge>}</label>)}</div>
          </div>
          {chosen.length > 1 && <Select label="Primary role" value={f.primaryRoleId || chosen[0].id} onChange={(e) => setF({ ...f, primaryRoleId: e.target.value })}>{chosen.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}
          <p className="text-xs text-ink-500">They get an email with a link to set a password. Superadmin grants may need a second superadmin&apos;s approval.</p>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !/^\S+@\S+\.\S+$/.test(f.email)} onClick={submit}>Send invitation</Button></div>
        </div>
      </Modal>
      <SecretModal title="Invitation sent" secret={link} note={<>The invitation was also emailed to {f.email}. You can share this link directly; it is shown only now.{notice && <span className="mt-1 block font-medium">{notice}</span>}</>} onClose={() => { setLink(null); onClose(); }} />
    </>
  );
}

interface ImportRow { email: string; name?: string; title?: string; department?: string; team?: string; roles?: string[] }
interface ImportResult { row: number; email: string; status: 'CREATED' | 'SKIPPED' | 'ERROR' | 'VALID'; message?: string }

/** Minimal CSV reader: commas, double-quoted cells with "" escapes, one record per line. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    out.push(cells);
  }
  return out;
}

function toRows(text: string): ImportRow[] {
  const lines = parseCsv(text);
  if (lines[0]?.[0]?.toLowerCase() === 'email') lines.shift();
  return lines.map(([email, name, title, department, team, roles]) => ({
    email: email || '', ...(name ? { name } : {}), ...(title ? { title } : {}), ...(department ? { department } : {}), ...(team ? { team } : {}),
    roles: (roles || '').split(';').map((x) => x.trim()).filter(Boolean),
  }));
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { run, error, busy } = useAction();
  const [text, setText] = useState('email,name,title,department,team,roles\n');
  const [sendInvites, setSendInvites] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ results: ImportResult[]; errors: number } | null>(null);
  const [done, setDone] = useState<{ results: ImportResult[]; created: number; errors: number } | null>(null);
  const rows = toRows(text);
  const check = () => {
    const r = reason || askReason('importing staff');
    if (!r) return;
    setReason(r);
    void run(async () => { setChecked(await api.post('/admin/iam/users/import', { rows, dryRun: true, sendInvites, reason: r })); setDone(null); });
  };
  const doImport = () => run(async () => { setDone(await api.post('/admin/iam/users/import', { rows, sendInvites, reason })); onDone(); });
  const results = done?.results || checked?.results;
  return (
    <Modal open onClose={onClose} title="Bulk import staff">
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <p className="text-xs text-ink-500">Paste CSV with columns <code>email,name,title,department,team,roles</code>. Separate several roles with <code>;</code> (role keys or names). Up to 500 rows. Superadmin cannot be granted by import.</p>
        <Textarea rows={8} className="font-mono" value={text} onChange={(e) => { setText(e.target.value); setChecked(null); setDone(null); }} />
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} /> Email invitations to new people</label>
        {results && (
          <div className="max-h-56 overflow-auto rounded-lg border border-ink-100">
            <table className="w-full text-xs"><tbody className="divide-y divide-ink-100">{results.map((r) => <tr key={r.row}><td className="px-2 py-1 text-ink-500">{r.row}</td><td className="px-2 py-1">{r.email || '—'}</td><td className="px-2 py-1"><Badge tone={r.status === 'ERROR' ? 'bad' : r.status === 'SKIPPED' ? 'warn' : 'good'}>{r.status}</Badge></td><td className="px-2 py-1 text-ink-500">{r.message}</td></tr>)}</tbody></table>
          </div>
        )}
        {done && <Alert tone="good">Created {done.created}; {done.errors} error(s).</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && <Button variant="secondary" disabled={busy || !rows.length} onClick={check}>Check {rows.length} row(s)</Button>}
          {checked && !done && <Button disabled={busy || checked.results.every((r) => r.status !== 'VALID')} onClick={doImport}>Import {checked.results.filter((r) => r.status === 'VALID').length} valid</Button>}
        </div>
        {checked && !done && checked.errors > 0 && <p className="text-xs text-ink-500">Rows with errors are skipped on import (the server re-checks every row).</p>}
      </div>
    </Modal>
  );
}

