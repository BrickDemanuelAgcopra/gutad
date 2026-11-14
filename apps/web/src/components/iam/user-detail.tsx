'use client';
import { useState } from 'react';
import { SENSITIVITY } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Select, Table, Tabs, Textarea } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { day, FieldLabel, isoOrNull, Notice, Panel, pendingApprovalText, personLabel, RoleChips, SecretModal, statusBadge, SUPERADMIN, TEAMS, toLocalInput, useRoles, useStaff, useStepUp, type LoginEvent, type SessionRow, type StaffRow } from './common';
import { EffectiveAccess } from './effective';

interface Assignment { id: string; roleId: string; roleKey: string; roleName: string; kind: string; isPrimary: boolean; responsibility: string | null; actingForUserId: string | null; startsAt: string; endsAt: string | null; reason: string | null; revokedAt: string | null; revokeReason: string | null; state: string; createdAt: string }
interface Scope { regionIds: string[]; organizationIds: string[]; locationIds: string[]; companyIds: string[]; kitchenIds: string[]; brandIds: string[]; teams: string[]; maxSensitivity: string; note: string | null }
type Detail = Omit<StaffRow, 'sessions'> & { scope: Scope | null; assignments: Assignment[]; sessions: SessionRow[]; logins: LoginEvent[]; locked: boolean };

export function UserDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { user } = useSession();
  const { data: d, reload, error: loadError } = useApi<Detail>(`/admin/iam/users/${id}`);
  const [tab, setTab] = useState('profile');
  const [notice, setNotice] = useState<string | null>(null);
  const changed = async (text?: string | null) => { if (text) setNotice(text); await reload(); onChange(); };
  const self = user?.id === id;
  return (
    <Panel open onClose={onClose} title={d ? personLabel(d) : 'Staff member'}>
      {loadError && <Alert>{loadError}</Alert>}
      {d && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">{statusBadge(d.status)}<Badge tone={d.mfaEnabled ? 'good' : 'warn'}>MFA {d.mfaEnabled ? 'on' : 'off'}</Badge>{d.locked && <Badge tone="bad">sign-in locked</Badge>}{d.inactive && <Badge tone="warn">inactive</Badge>}{d.suspendedUntil && <span className="text-xs text-ink-500">suspended until {when(d.suspendedUntil)}</span>}{d.statusReason && d.status !== 'ACTIVE' && <span className="text-xs text-ink-500">“{d.statusReason}”</span>}</div>
          <RoleChips roles={d.roles} />
          {self && <Alert tone="info">This is you. Someone else must change your access.</Alert>}
          <Notice text={notice} onClose={() => setNotice(null)} />
          <Tabs tabs={[{ id: 'profile', label: 'Profile & status' }, { id: 'roles', label: 'Roles' }, { id: 'scope', label: 'Access scope' }, { id: 'sessions', label: 'Sessions & sign-ins' }, { id: 'effective', label: 'Effective access' }]} active={tab} onChange={setTab} />
          {tab === 'profile' && <ProfileSection d={d} self={self} onChanged={changed} />}
          {tab === 'roles' && <RolesSection d={d} self={self} onChanged={changed} />}
          {tab === 'scope' && <ScopeSection d={d} self={self} onChanged={changed} />}
          {tab === 'sessions' && <SessionsSection d={d} onChanged={changed} />}
          {tab === 'effective' && <EffectiveAccess userId={id} />}
        </div>
      )}
    </Panel>
  );
}

type Changed = (text?: string | null) => Promise<void>;

function ProfileSection({ d, self, onChanged }: { d: Detail; self: boolean; onChanged: Changed }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const withStepUp = useStepUp();
  const { data: staff } = useStaff();
  const { run, error, busy } = useAction();
  const [p, setP] = useState({ name: d.name || '', phone: d.phone || '', title: d.title || '', department: d.department || '', team: d.team || '', managerId: d.managerId || '', employeeId: d.employeeId || '' });
  const [until, setUntil] = useState('');
  const [off, setOff] = useState<{ to: string } | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const others = (staff || []).filter((s) => s.id !== d.id && s.status === 'ACTIVE');
  const setStatus = (status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | 'ARCHIVED', what: string) => {
    const reason = askReason(what);
    if (!reason) return;
    void run(async () => {
      const r = await withStepUp((stepUp) => api.post<{ sessionsRevoked: number }>(`/admin/iam/users/${d.id}/status`, { status, reason, until: status === 'SUSPENDED' ? isoOrNull(until) : null, stepUp }));
      await onChanged(`Status is now ${status}.${r.sessionsRevoked ? ` ${r.sessionsRevoked} session(s) ended.` : ''}`);
    });
  };
  const offboard = () => {
    const reason = askReason(`offboarding ${d.email}`);
    if (!reason) return;
    void run(async () => {
      const r = await withStepUp((stepUp) => api.post<Record<string, unknown>>(`/admin/iam/users/${d.id}/offboard`, { reason, transferToUserId: off?.to || null, stepUp }));
      setSummary(r);
      setOff(null);
      await onChanged();
    });
  };
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Name" disabled={!manage} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        <Input label="Phone" disabled={!manage} value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
        <Input label="Job title" disabled={!manage} value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />
        <Input label="Department" disabled={!manage} value={p.department} onChange={(e) => setP({ ...p, department: e.target.value })} />
        <Input label="Team" disabled={!manage} value={p.team} onChange={(e) => setP({ ...p, team: e.target.value })} />
        <Input label="Employee ID" disabled={!manage} value={p.employeeId} onChange={(e) => setP({ ...p, employeeId: e.target.value })} />
        <Select label="Manager" disabled={!manage} value={p.managerId} onChange={(e) => setP({ ...p, managerId: e.target.value })}><option value="">None</option>{others.map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}</Select>
      </div>
      {manage && <Button size="sm" disabled={busy} onClick={() => run(async () => { await api.patch(`/admin/iam/users/${d.id}`, { name: p.name || null, phone: p.phone || null, title: p.title || null, department: p.department || null, team: p.team || null, managerId: p.managerId || null, employeeId: p.employeeId || null }); await onChanged('Profile saved.'); })}>Save profile</Button>}
      {d.invitation && (
        <div className="rounded-lg bg-ink-50 p-3 text-xs">
          Invitation sent {d.invitation.sentCount}× (last {when(d.invitation.lastSentAt)}), expires {when(d.invitation.expiresAt)}.
          {manage && <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ inviteLink: string }>(`/admin/iam/users/${d.id}/resend-invite`, {}); setLink(r.inviteLink); await onChanged(); })}>Resend invitation</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await api.post(`/admin/iam/users/${d.id}/revoke-invite`, {}); await onChanged('Invitation revoked.'); })}>Revoke invitation</Button></div>}
        </div>
      )}
      {manage && !self && (
        <div className="space-y-2 border-t border-ink-100 pt-3">
          <FieldLabel>Account status</FieldLabel>
          <div className="flex flex-wrap items-end gap-2">
            {d.status !== 'ACTIVE' && d.status !== 'INVITED' && <Button size="sm" disabled={busy} onClick={() => setStatus('ACTIVE', `activating ${d.email}`)}>Activate</Button>}
            {d.status !== 'SUSPENDED' && <><Input label="Suspend until (optional)" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /><Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus('SUSPENDED', `suspending ${d.email}`)}>Suspend</Button></>}
            {d.status !== 'DISABLED' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus('DISABLED', `deactivating ${d.email}`)}>Deactivate</Button>}
            {d.status !== 'ARCHIVED' && <Button size="sm" variant="danger" disabled={busy} onClick={() => setStatus('ARCHIVED', `archiving ${d.email} (removes every role)`)}>Archive</Button>}
          </div>
          <div className="flex flex-wrap gap-2">
            {d.locked && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/admin/iam/users/${d.id}/unlock`, {}); await onChanged('Sign-in unlocked.'); })}>Unlock sign-in</Button>}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const reason = askReason('signing this person out everywhere'); if (reason) void run(async () => { const r = await api.post<{ revoked: number }>(`/admin/iam/users/${d.id}/force-logout`, { reason }); await onChanged(`${r.revoked} session(s) ended.`); }); }}>Force sign-out</Button>
            {!off && <Button size="sm" variant="danger" onClick={() => setOff({ to: '' })}>Offboard…</Button>}
          </div>
          {off && (
            <div className="space-y-2 rounded-lg border border-red-100 bg-red-50 p-3">
              <p className="text-xs text-red-800">Offboarding disables the account, ends sessions, emergency grants, roles, invitations and pending requests, and hands open work (approvals, tickets, alerts, pipeline, accounts, service accounts) to the person you pick.</p>
              <Select label="Transfer work to" value={off.to} onChange={(e) => setOff({ to: e.target.value })}><option value="">Nobody (cancel pending approvals, unassign work)</option>{others.map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}</Select>
              <div className="flex gap-2"><Button size="sm" variant="danger" disabled={busy} onClick={offboard}>Offboard now</Button><Button size="sm" variant="ghost" onClick={() => setOff(null)}>Cancel</Button></div>
            </div>
          )}
          {summary && (
            <Alert tone="good">
              Offboarded. Ended {String(summary.sessions)} session(s), {String(summary.roles)} role(s), {String(summary.grants)} grant(s), {String(summary.accessRequests)} request(s).{' '}
              {summary.approvalsTransferred ? 'Transferred' : 'Canceled'} {String(summary.approvals)} approval(s); moved {String(summary.tickets)} ticket(s), {String(summary.alerts)} alert(s), {String(summary.pipeline)} pipeline item(s), {String(summary.accounts)} account(s), {String(summary.serviceAccounts)} service account(s).
            </Alert>
          )}
        </div>
      )}
      <SecretModal title="Invitation resent" secret={link} note={<>A new invitation was emailed to {d.email}; earlier links stop working. You can also share this link directly.</>} onClose={() => setLink(null)} />
    </div>
  );
}

function RolesSection({ d, self, onChanged }: { d: Detail; self: boolean; onChanged: Changed }) {
  const { can } = useSession();
  const manage = can('security.manage') && !self;
  const withStepUp = useStepUp();
  const { data: roles } = useRoles();
  const { data: staff } = useStaff();
  const { run, error, busy } = useAction();
  const [a, setA] = useState({ roleId: '', isPrimary: false, responsibility: '', startsAt: '', endsAt: '' });
  const [act, setAct] = useState({ forUserId: '', startsAt: '', endsAt: '' });
  const [editEnd, setEditEnd] = useState<{ id: string; value: string } | null>(null);
  const assign = () => {
    const role = roles?.find((r) => r.id === a.roleId);
    const reason = askReason(`giving ${d.email} the ${role?.name} role`);
    if (!reason) return;
    void run(async () => {
      const r = await withStepUp((stepUp) => api.post('/admin/iam/assignments', { userIds: [d.id], roleId: a.roleId, isPrimary: a.isPrimary, responsibility: a.responsibility || null, startsAt: isoOrNull(a.startsAt), endsAt: isoOrNull(a.endsAt), reason, stepUp }));
      setA({ roleId: '', isPrimary: false, responsibility: '', startsAt: '', endsAt: '' });
      await onChanged(pendingApprovalText(r) || `${role?.name} assigned.`);
    });
  };
  const patch = (x: Assignment, body: Record<string, unknown>, what: string) => {
    const reason = askReason(what);
    if (!reason) return;
    void run(async () => { await withStepUp((stepUp) => api.patch(`/admin/iam/assignments/${x.id}`, { ...body, reason, stepUp })); setEditEnd(null); await onChanged('Assignment updated.'); });
  };
  const revoke = (x: Assignment) => {
    const reason = askReason(`removing ${x.roleName} from ${d.email}`);
    if (!reason) return;
    void run(async () => { await withStepUp((stepUp) => api.post(`/admin/iam/assignments/${x.id}/revoke`, { reason, stepUp })); await onChanged(`${x.roleName} removed.`); });
  };
  const acting = () => {
    const reason = askReason('acting-manager cover');
    if (!reason) return;
    void run(async () => { const r = await api.post<{ assignments: unknown[] }>('/admin/iam/assignments/acting', { userId: d.id, forUserId: act.forUserId, startsAt: isoOrNull(act.startsAt), endsAt: isoOrNull(act.endsAt), reason }); setAct({ forUserId: '', startsAt: '', endsAt: '' }); await onChanged(`Acting cover added: ${r.assignments.length} role(s).`); });
  };
  const live = (x: Assignment) => x.state === 'ACTIVE' || x.state === 'SCHEDULED';
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Table rows={d.assignments} empty="No role assignments yet." cols={[
        { key: 'r', label: 'Role', render: (x) => <span>{x.isPrimary && <span title="Primary">★ </span>}<span className="font-medium">{x.roleName}</span>{x.responsibility && <span className="block text-xs text-ink-500">{x.responsibility}</span>}</span> },
        { key: 'k', label: 'Kind', render: (x) => <span className="text-xs">{x.kind.toLowerCase()}</span> },
        { key: 'w', label: 'Window', render: (x) => editEnd?.id === x.id ? <div className="flex items-center gap-1"><input type="datetime-local" className="rounded border border-ink-100 px-1 text-xs" value={editEnd.value} onChange={(e) => setEditEnd({ id: x.id, value: e.target.value })} /><Button size="sm" onClick={() => patch(x, { endsAt: isoOrNull(editEnd.value) }, `changing when ${x.roleName} ends`)}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditEnd(null)}>✕</Button></div> : <span className="text-xs">{day(x.startsAt)} → {x.revokedAt ? `removed ${day(x.revokedAt)}` : x.endsAt ? day(x.endsAt) : 'no end'}</span> },
        { key: 's', label: 'State', render: (x) => <span><Badge tone={x.state === 'ACTIVE' ? 'good' : x.state === 'SCHEDULED' ? 'info' : 'neutral'}>{x.state}</Badge>{x.revokeReason && <span className="block text-xs text-ink-500">{x.revokeReason}</span>}</span> },
        { key: 'a', label: '', render: (x) => manage && live(x) ? <div className="flex flex-wrap gap-1">{!x.isPrimary && <Button size="sm" variant="ghost" onClick={() => patch(x, { isPrimary: true }, `making ${x.roleName} the primary role`)}>Set primary</Button>}<Button size="sm" variant="ghost" onClick={() => setEditEnd({ id: x.id, value: toLocalInput(x.endsAt) })}>Change end</Button><Button size="sm" variant="ghost" className="text-red-600" onClick={() => revoke(x)}>Remove</Button></div> : null },
      ]} />
      {manage && (
        <div className="space-y-2 rounded-xl border border-ink-100 p-3">
          <FieldLabel>Assign a role</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label="Role" value={a.roleId} onChange={(e) => setA({ ...a, roleId: e.target.value })}><option value="">Choose…</option>{(roles || []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.key === SUPERADMIN ? ' (superadmin)' : r.privileged ? ' (privileged)' : ''}</option>)}</Select>
            <Input label="Responsibility (optional)" placeholder="e.g. Owns refunds for NYC" value={a.responsibility} onChange={(e) => setA({ ...a, responsibility: e.target.value })} />
            <Input label="Starts (empty = now)" type="datetime-local" value={a.startsAt} onChange={(e) => setA({ ...a, startsAt: e.target.value })} />
            <Input label="Ends (empty = permanent)" type="datetime-local" value={a.endsAt} onChange={(e) => setA({ ...a, endsAt: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={a.isPrimary} onChange={(e) => setA({ ...a, isPrimary: e.target.checked })} /> Primary role</label>
          <Button size="sm" disabled={busy || !a.roleId} onClick={assign}>Assign</Button>
        </div>
      )}
      {manage && (
        <div className="space-y-2 rounded-xl border border-ink-100 p-3">
          <FieldLabel>Acting-manager cover</FieldLabel>
          <p className="text-xs text-ink-500">Temporarily give {d.name || d.email} the same roles as someone who is away (superadmin is never copied).</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Select label="Covering for" value={act.forUserId} onChange={(e) => setAct({ ...act, forUserId: e.target.value })}><option value="">Choose…</option>{(staff || []).filter((s) => s.id !== d.id).map((s) => <option key={s.id} value={s.id}>{personLabel(s)}</option>)}</Select>
            <Input label="Starts (empty = now)" type="datetime-local" value={act.startsAt} onChange={(e) => setAct({ ...act, startsAt: e.target.value })} />
            <Input label="Ends (required)" type="datetime-local" value={act.endsAt} onChange={(e) => setAct({ ...act, endsAt: e.target.value })} />
          </div>
          <Button size="sm" variant="secondary" disabled={busy || !act.forUserId || !act.endsAt} onClick={acting}>Add acting cover</Button>
        </div>
      )}
    </div>
  );
}

const ids = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function ScopeSection({ d, self, onChanged }: { d: Detail; self: boolean; onChanged: Changed }) {
  const { can } = useSession();
  const manage = can('security.manage') && !self;
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const { run, error, busy } = useAction();
  const base: Scope = d.scope || { regionIds: [], organizationIds: [], locationIds: [], companyIds: [], kitchenIds: [], brandIds: [], teams: [], maxSensitivity: 'RESTRICTED', note: null };
  const [sc, setSc] = useState<Scope>(base);
  const [text, setText] = useState({ locationIds: base.locationIds.join(', '), kitchenIds: base.kitchenIds.join(', '), brandIds: base.brandIds.join(', '), companyIds: base.companyIds.join(', ') });
  const [orgQ, setOrgQ] = useState('');
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const { data: orgHits } = useApi<{ id: string; name: string }[]>(orgQ.length >= 2 ? `/admin/organizations/lookup?q=${encodeURIComponent(orgQ)}` : null, { deps: [orgQ] });
  const toggle = (list: string[], v: string, on: boolean) => (on ? Array.from(new Set([...list, v])) : list.filter((x) => x !== v));
  const save = () => {
    const reason = askReason(`changing ${d.email}'s access scope`);
    if (!reason) return;
    void run(async () => {
      await api.put(`/admin/iam/users/${d.id}/scope`, { regionIds: sc.regionIds, organizationIds: sc.organizationIds, locationIds: ids(text.locationIds), kitchenIds: ids(text.kitchenIds), brandIds: ids(text.brandIds), companyIds: ids(text.companyIds), teams: sc.teams, maxSensitivity: sc.maxSensitivity, note: sc.note || null, reason });
      await onChanged('Access scope saved.');
    });
  };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-ink-500">Empty lists mean no restriction of that kind. With no lists, no teams and the highest sensitivity, the person is unrestricted.</p>
      <div>
        <FieldLabel>Regions</FieldLabel>
        <div className="flex flex-wrap gap-2">{(regions || []).map((g) => <label key={g.id} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!manage} checked={sc.regionIds.includes(g.id)} onChange={(e) => setSc({ ...sc, regionIds: toggle(sc.regionIds, g.id, e.target.checked) })} />{g.name}</label>)}{!regions?.length && <span className="text-xs text-ink-500">No regions yet.</span>}</div>
      </div>
      <div>
        <Input label="Organizations (search to add)" disabled={!manage} value={orgQ} onChange={(e) => setOrgQ(e.target.value)} />
        {orgHits && orgQ && <div className="mt-1 flex flex-wrap gap-1">{orgHits.map((o) => <button key={o.id} className="rounded-full border border-ink-100 px-2 py-0.5 text-xs hover:bg-ink-50" onClick={() => { setOrgNames({ ...orgNames, [o.id]: o.name }); setSc({ ...sc, organizationIds: toggle(sc.organizationIds, o.id, true) }); setOrgQ(''); }}>+ {o.name}</button>)}</div>}
        <div className="mt-1 flex flex-wrap gap-1">{sc.organizationIds.map((o) => <span key={o} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs">{orgNames[o] || o.slice(0, 8)} {manage && <button onClick={() => setSc({ ...sc, organizationIds: sc.organizationIds.filter((x) => x !== o) })}>×</button>}</span>)}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Textarea label="Location IDs (comma separated)" rows={2} disabled={!manage} value={text.locationIds} onChange={(e) => setText({ ...text, locationIds: e.target.value })} />
        <Textarea label="Kitchen IDs (covers every location they serve)" rows={2} disabled={!manage} value={text.kitchenIds} onChange={(e) => setText({ ...text, kitchenIds: e.target.value })} />
        <Textarea label="Brand IDs (covers the brand's organization)" rows={2} disabled={!manage} value={text.brandIds} onChange={(e) => setText({ ...text, brandIds: e.target.value })} />
        <Textarea label="Company IDs (covers child organizations)" rows={2} disabled={!manage} value={text.companyIds} onChange={(e) => setText({ ...text, companyIds: e.target.value })} />
      </div>
      <div>
        <FieldLabel>Teams / queues</FieldLabel>
        <div className="flex flex-wrap gap-3">{TEAMS.map((t) => <label key={t} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!manage} checked={sc.teams.includes(t)} onChange={(e) => setSc({ ...sc, teams: toggle(sc.teams, t, e.target.checked) })} />{t.replace('_', ' ').toLowerCase()}</label>)}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select label="Highest data sensitivity" disabled={!manage} value={sc.maxSensitivity} onChange={(e) => setSc({ ...sc, maxSensitivity: e.target.value })}>{SENSITIVITY.map((s) => <option key={s}>{s}</option>)}</Select>
        <Input label="Note" disabled={!manage} value={sc.note || ''} onChange={(e) => setSc({ ...sc, note: e.target.value })} />
      </div>
      {manage && <Button size="sm" disabled={busy} onClick={save}>Save scope</Button>}
    </div>
  );
}

function SessionsSection({ d, onChanged }: { d: Detail; onChanged: Changed }) {
  const { can } = useSession();
  const manage = can('security.manage');
  const { run, error } = useAction();
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div>
        <FieldLabel>Active sessions</FieldLabel>
        {d.sessions.length === 0 ? <p className="text-xs text-ink-500">None.</p> : (
          <ul className="space-y-1">{d.sessions.map((s) => <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-ink-50 px-2 py-1 text-xs"><span>{s.client || 'web'} · {s.amr.join('+') || 'token'} · {s.ip || '—'} · last {when(s.lastSeenAt)}<span className="block truncate text-ink-500">{s.userAgent}</span></span>{manage && <button className="text-red-600" onClick={() => { const reason = askReason('ending this session'); if (reason) void run(async () => { await api.post(`/admin/iam/sessions/${s.id}/revoke`, { reason }); await onChanged('Session ended.'); }); }}>End</button>}</li>)}</ul>
        )}
      </div>
      <div>
        <FieldLabel>Recent sign-ins</FieldLabel>
        <Table rows={d.logins} empty="No sign-ins recorded." cols={[
          { key: 't', label: 'When', render: (l) => <span className="text-xs">{when(l.createdAt)}</span> },
          { key: 'o', label: 'Outcome', render: (l) => <span><Badge tone={l.outcome === 'SUCCESS' ? 'good' : 'bad'}>{l.outcome}</Badge>{l.suspicious && <Badge tone="warn">suspicious</Badge>}</span> },
          { key: 'm', label: 'Method', render: (l) => <span className="text-xs">{l.method}{l.reason && ` · ${l.reason}`}</span> },
          { key: 'i', label: 'IP', render: (l) => <span className="text-xs">{l.ip || '—'}</span> },
        ]} />
      </div>
    </div>
  );
}
