'use client';
import { useState } from 'react';
import { APPROVAL_LIMIT_KINDS, type ApprovalLimitKind } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Modal, Select, Table, Textarea } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { Notice, pendingApprovalText, SUPERADMIN, useRoles, useStepUp, type Role } from './common';

const LIMIT_KINDS = Object.keys(APPROVAL_LIMIT_KINDS) as ApprovalLimitKind[];

export function RolesTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const [archived, setArchived] = useState(false);
  const { data, reload } = useRoles(archived);
  const { run, error } = useAction();
  const [edit, setEdit] = useState<Role | null>(null);
  const [create, setCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = async (text?: string | null) => { if (text) setNotice(text); await reload(); onChange(); };
  const duplicate = (r: Role) => {
    const name = window.prompt(`Name for the copy of "${r.name}"`, `${r.name} (copy)`);
    if (!name || name.trim().length < 2) return;
    const reason = askReason(`duplicating ${r.name}`);
    if (reason) void run(async () => { await api.post(`/admin/iam/roles/${r.id}/duplicate`, { name: name.trim(), reason }); await changed(`Created "${name.trim()}".`); });
  };
  const toggleArchive = (r: Role) => {
    const restore = r.status !== 'ACTIVE';
    const reason = askReason(`${restore ? 'restoring' : 'archiving'} ${r.name}`);
    if (reason) void run(async () => { await api.post(`/admin/iam/roles/${r.id}/${restore ? 'restore' : 'archive'}`, { reason }); await changed(`${r.name} ${restore ? 'restored' : 'archived'}.`); });
  };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Notice text={notice} onClose={() => setNotice(null)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived roles</label>
        {manage && <Button onClick={() => setCreate(true)}>New role</Button>}
      </div>
      <Table rows={data || []} empty="No roles." cols={[
        { key: 'n', label: 'Role', render: (r) => <button className="text-left" onClick={() => setEdit(r)}><span className="font-medium underline">{r.name}</span><span className="block max-w-md text-xs text-ink-500">{r.description}</span></button> },
        { key: 'b', label: '', render: (r) => <div className="flex flex-wrap gap-1"><Badge tone={r.kind === 'SYSTEM' ? 'info' : 'neutral'}>{r.kind === 'SYSTEM' ? 'built-in' : 'custom'}</Badge>{r.privileged && <Badge tone="bad">privileged</Badge>}{r.mfaRequired && <Badge>MFA</Badge>}{r.requestable && r.key !== SUPERADMIN && <Badge tone="good">requestable</Badge>}{r.status !== 'ACTIVE' && <Badge tone="warn">archived</Badge>}{r.key === SUPERADMIN && <Badge tone="bad">locked</Badge>}</div> },
        { key: 'p', label: 'Permissions', render: (r) => <span className="text-xs">{r.key === SUPERADMIN ? 'all' : r.permissions.length}</span> },
        { key: 'h', label: 'Holders', render: (r) => r.holders },
        { key: 'a', label: '', render: (r) => manage ? <div className="flex flex-wrap gap-1">{r.key !== SUPERADMIN && r.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => duplicate(r)}>Duplicate</Button>}{r.kind === 'CUSTOM' && <Button size="sm" variant="ghost" onClick={() => toggleArchive(r)}>{r.status === 'ACTIVE' ? 'Archive' : 'Restore'}</Button>}</div> : null },
      ]} />
      {edit && <RoleModal role={edit} onClose={() => setEdit(null)} onSaved={async (t) => { setEdit(null); await changed(t); }} />}
      {create && <CreateRole roles={data || []} onClose={() => setCreate(false)} onSaved={async (t) => { setCreate(false); await changed(t); }} />}
    </div>
  );
}

function CreateRole({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: (t: string) => Promise<void> }) {
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ name: '', description: '', copyFromRoleId: '' });
  const save = () => {
    const reason = askReason(`creating the ${f.name} role`);
    if (reason) void run(async () => { await api.post('/admin/iam/roles', { name: f.name.trim(), description: f.description, copyFromRoleId: f.copyFromRoleId || undefined, reason }); await onSaved(`Role "${f.name.trim()}" created. Set its permissions in the matrix.`); });
  };
  return (
    <Modal open onClose={onClose} title="New role">
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Textarea label="Description" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <Select label="Start from" value={f.copyFromRoleId} onChange={(e) => setF({ ...f, copyFromRoleId: e.target.value })}><option value="">Empty (no permissions)</option>{roles.filter((r) => r.key !== SUPERADMIN && r.status === 'ACTIVE').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || f.name.trim().length < 2} onClick={save}>Create</Button></div>
      </div>
    </Modal>
  );
}

const toDollars = (c?: number) => (c === undefined || c === null ? '' : String(c / 100));

function RoleModal({ role, onClose, onSaved }: { role: Role; onClose: () => void; onSaved: (t: string | null) => Promise<void> }) {
  const { can } = useSession();
  const locked = role.key === SUPERADMIN;
  const editable = can('security.manage') && !locked && role.status === 'ACTIVE';
  const withStepUp = useStepUp();
  const { run, error, busy } = useAction();
  const [f, setF] = useState({ name: role.name, description: role.description, requestable: role.requestable, mfaRequired: role.mfaRequired });
  const initialLimits = Object.fromEntries(LIMIT_KINDS.map((k) => [k, toDollars(role.approvalLimits?.[k])])) as Record<ApprovalLimitKind, string>;
  const [limits, setLimits] = useState(initialLimits);
  const limitsChanged = LIMIT_KINDS.some((k) => limits[k] !== initialLimits[k]);
  const badLimit = LIMIT_KINDS.some((k) => limits[k] !== '' && !(Number(limits[k]) >= 0));
  const save = () => {
    const body: Record<string, unknown> = {};
    if (f.name !== role.name) body.name = f.name.trim();
    if (f.description !== role.description) body.description = f.description;
    if (f.requestable !== role.requestable) body.requestable = f.requestable;
    if (f.mfaRequired !== role.mfaRequired) body.mfaRequired = f.mfaRequired;
    if (limitsChanged) body.approvalLimits = Object.fromEntries(LIMIT_KINDS.map((k) => [k, limits[k] === '' ? null : Math.round(Number(limits[k]) * 100)]));
    if (!Object.keys(body).length) return onClose();
    const reason = askReason(`changing the ${role.name} role`);
    if (!reason) return;
    void run(async () => {
      const r = await withStepUp((stepUp) => api.patch(`/admin/iam/roles/${role.id}`, { ...body, reason, stepUp }));
      await onSaved(pendingApprovalText(r) || `${f.name} saved.`);
    });
  };
  return (
    <Modal open onClose={onClose} title={role.name}>
      <div className="space-y-3 text-sm">
        {error && <Alert>{error}</Alert>}
        {locked && <Alert tone="info">Superadmin always has every permission and cannot be edited.</Alert>}
        <div className="grid gap-2">
          <Input label="Name" disabled={!editable} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Textarea label="Description" rows={2} disabled={!editable} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!editable} checked={f.requestable} onChange={(e) => setF({ ...f, requestable: e.target.checked })} /> Staff can request this role</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!editable} checked={f.mfaRequired} onChange={(e) => setF({ ...f, mfaRequired: e.target.checked })} /> Holders must use two-factor authentication</label>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold text-ink-500">Approval limits (USD per request; empty = no cap)</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {LIMIT_KINDS.map((k) => <Input key={k} label={APPROVAL_LIMIT_KINDS[k]} type="number" min={0} step="0.01" disabled={!editable} placeholder={locked ? 'unlimited' : 'no cap'} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />)}
          </div>
          {!editable && LIMIT_KINDS.some((k) => role.approvalLimits?.[k] !== undefined) && <p className="mt-1 text-xs text-ink-500">{LIMIT_KINDS.filter((k) => role.approvalLimits?.[k] !== undefined).map((k) => `${APPROVAL_LIMIT_KINDS[k]} ${money(role.approvalLimits[k])}`).join(' · ')}</p>}
        </div>
        <p className="text-xs text-ink-500">Permission, limit and MFA changes are critical: you confirm with your password or authenticator code, and privileged grants may need a second superadmin. Edit permissions in the Permission matrix tab.</p>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button>{editable && <Button disabled={busy || badLimit || f.name.trim().length < 2} onClick={save}>Save</Button>}</div>
      </div>
    </Modal>
  );
}
