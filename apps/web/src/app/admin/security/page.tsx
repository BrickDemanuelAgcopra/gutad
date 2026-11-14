'use client';
import { useState } from 'react';
import { SENSITIVITY, STAFF_ROLE_LABELS, STAFF_ROLES, type StaffRole } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, Table, Tabs, Textarea } from '@/components/ui';
import { adoptTokens, askReason, SectionTitle } from '@/components/admin-ui';

interface Grant { id: string; kind: string; userId: string; email: string; roles: string[]; organizationName: string | null; reason: string; ticketRef: string | null; startsAt: string; expiresAt: string; revokedAt: string | null; reviewedAt: string | null; reviewNote: string | null; actionCount: number; readOnly: number }
interface Scope { regionIds: string[]; organizationIds: string[]; locationIds: string[]; maxSensitivity: string; note: string | null }
interface Staff { id: string; email: string; name: string | null; roles: string[]; status: string; statusReason: string | null; mfaEnabled: boolean; scope: Scope | null; activeGrants: Grant[]; sessions: number; lastSeenAt: string | null }
interface Detail { id: string; email: string; roles: string[]; status: string; mfaEnabled: boolean; scope: Scope | null; sessions: { id: string; client: string | null; userAgent: string | null; ip: string | null; amr: string[]; lastSeenAt: string; createdAt: string }[]; grants: Grant[]; recentActions: { id: string; action: string; entityType: string; entityId: string; reason: string | null; createdAt: string }[] }
interface Region { id: string; code: string; name: string; locations: number }
interface Policy { sso: { enabled: boolean; issuer: string; clientId: string; redirectUri: string; mobileRedirectUri?: string; allowedDomains: string[]; label: string; hasClientSecret: boolean }; mfaRequiredRoles: string[]; sessions: { staffTokenMinutes: number; staffIdleMinutes: number; staffMaxHours: number }; emergency: { maxMinutes: number; grantableRoles: string[] } }

const roleLabel = (r: string) => STAFF_ROLE_LABELS[r as StaffRole] || r;

export default function AdminSecurity() {
  const { can } = useSession();
  const [tab, setTab] = useState('staff');
  const { data: ov, reload: reloadOv } = useApi<{ staff: number; withoutMfa: number; disabled: number; scoped: number; activeEmergency: number; unreviewedEmergency: number; mfaRequiredRoles: string[]; sso: { enabled: boolean } }>('/admin/security/overview');
  return (
    <div className="space-y-4">
      <SectionTitle title="Staff & access" hint="Roles, access scopes, sessions, two-factor authentication, emergency and support access." />
      {ov && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Stat label="Staff" value={ov.staff} hint={`${ov.scoped} scoped · ${ov.disabled} disabled`} /><Stat label="Without MFA" value={ov.withoutMfa} hint={ov.mfaRequiredRoles.length ? `required for ${ov.mfaRequiredRoles.map(roleLabel).join(', ')}` : 'not required for any role'} /><Stat label="Emergency access" value={ov.activeEmergency} hint={`${ov.unreviewedEmergency} waiting for review`} /><Stat label="Single sign-on" value={ov.sso.enabled ? 'On' : 'Off'} /></div>}
      <Tabs tabs={[{ id: 'staff', label: 'Staff' }, { id: 'grants', label: 'Emergency & support access' }, { id: 'mine', label: 'My emergency access' }, ...(can('security.manage') ? [{ id: 'policy', label: 'Security policy' }] : [])]} active={tab} onChange={setTab} />
      {tab === 'staff' && <StaffTab onChange={reloadOv} />}
      {tab === 'grants' && <GrantsTab onChange={reloadOv} />}
      {tab === 'mine' && <MyEmergency />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
}

function StaffTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const { data, reload } = useApi<Staff[]>('/admin/security/staff');
  const { run, error } = useAction();
  const [add, setAdd] = useState({ email: '', role: 'SUPPORT' });
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const rows = (data || []).filter((s) => !q || s.email.includes(q.toLowerCase()) || s.roles.some((r) => r.includes(q.toUpperCase())));
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {can('security.manage') && <Card title="Add staff"><div className="grid gap-2 sm:grid-cols-[1fr_200px_auto]"><Input placeholder="Email of an existing Gutad account" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} /><Select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{STAFF_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</Select><Button onClick={() => { const reason = askReason(`making ${add.email} ${roleLabel(add.role)}`); if (reason) run(async () => { const cur = data?.find((s) => s.email === add.email.toLowerCase()); await api.post('/admin/security/staff/roles', { email: add.email, roles: Array.from(new Set([...(cur?.roles || []), add.role])), reason }); setAdd({ email: '', role: 'SUPPORT' }); reload(); onChange(); }); }}>Grant role</Button></div><p className="mt-1 text-xs text-ink-500">The person signs in again for new access to apply. Only platform admins can grant Platform admin.</p></Card>}
      <Input placeholder="Filter by email or role" value={q} onChange={(e) => setQ(e.target.value)} />
      <Table rows={rows} empty="No staff yet." cols={[
        { key: 'e', label: 'Person', render: (s) => <button className="text-left underline" onClick={() => setSel(s.id)}>{s.email}<span className="block text-xs text-ink-500 no-underline">{s.name}</span></button> },
        { key: 'r', label: 'Roles', render: (s) => <div className="flex flex-wrap gap-1">{s.roles.map((r) => <Badge key={r} tone="info">{roleLabel(r)}</Badge>)}</div> },
        { key: 's', label: 'Scope', render: (s) => s.scope ? <span className="text-xs">{[s.scope.regionIds.length && `${s.scope.regionIds.length} region(s)`, s.scope.organizationIds.length && `${s.scope.organizationIds.length} org(s)`, s.scope.locationIds.length && `${s.scope.locationIds.length} location(s)`].filter(Boolean).join(', ') || 'all'} · up to {s.scope.maxSensitivity.toLowerCase()}</span> : <span className="text-xs text-ink-500">Unrestricted</span> },
        { key: 'm', label: 'MFA', render: (s) => s.mfaEnabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge> },
        { key: 'st', label: 'Status', render: (s) => <span><Badge tone={s.status === 'ACTIVE' ? 'good' : 'bad'}>{s.status}</Badge>{s.activeGrants.length > 0 && <Badge tone="bad">elevated</Badge>}</span> },
        { key: 'l', label: 'Sessions', render: (s) => <span className="text-xs">{s.sessions} · {s.lastSeenAt ? when(s.lastSeenAt) : 'never'}</span> },
      ]} />
      {sel && <StaffDetail id={sel} onClose={() => setSel(null)} onChange={() => { reload(); onChange(); }} />}
    </div>
  );
}

function StaffDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { can, user } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/security/staff/${id}`);
  const { data: regions } = useApi<Region[]>('/admin/regions');
  const { run, error } = useAction();
  const [roles, setRoles] = useState<string[] | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [orgQ, setOrgQ] = useState('');
  const { data: orgHits } = useApi<{ id: string; name: string }[]>(orgQ.length >= 2 ? `/admin/organizations/lookup?q=${encodeURIComponent(orgQ)}` : null, { deps: [orgQ] });
  const manage = can('security.manage');
  const r = roles || d?.roles.filter((x) => (STAFF_ROLES as readonly string[]).includes(x)) || [];
  const sc = scope || d?.scope || { regionIds: [], organizationIds: [], locationIds: [], maxSensitivity: 'RESTRICTED', note: null };
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); onChange(); });
  return (
    <Modal open onClose={onClose} title={d?.email || 'Staff'}>
      {!d ? null : (
        <div className="space-y-4 text-sm">
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2"><Badge tone={d.status === 'ACTIVE' ? 'good' : 'bad'}>{d.status}</Badge><Badge tone={d.mfaEnabled ? 'good' : 'warn'}>MFA {d.mfaEnabled ? 'on' : 'off'}</Badge></div>
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-500">Roles</div>
            <div className="flex flex-wrap gap-2">{STAFF_ROLES.map((x) => <label key={x} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!manage} checked={r.includes(x)} onChange={(e) => setRoles(e.target.checked ? [...r, x] : r.filter((y) => y !== x))} />{roleLabel(x)}</label>)}</div>
            {manage && roles && <Button className="mt-2" size="sm" onClick={() => { const reason = askReason('changing roles'); if (reason) act(async () => { await api.post('/admin/security/staff/roles', { email: d.email, roles, reason }); setRoles(null); }); }}>Save roles</Button>}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-500">Access scope</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select label="Highest data sensitivity" disabled={!manage} value={sc.maxSensitivity} onChange={(e) => setScope({ ...sc, maxSensitivity: e.target.value })}>{SENSITIVITY.map((s) => <option key={s}>{s}</option>)}</Select>
              <div><span className="mb-1 block text-xs font-medium text-ink-500">Regions</span><div className="flex flex-wrap gap-2">{(regions || []).map((g) => <label key={g.id} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!manage} checked={sc.regionIds.includes(g.id)} onChange={(e) => setScope({ ...sc, regionIds: e.target.checked ? [...sc.regionIds, g.id] : sc.regionIds.filter((x) => x !== g.id) })} />{g.name}</label>)}{!regions?.length && <span className="text-xs text-ink-500">No regions yet (Organization structure).</span>}</div></div>
            </div>
            <div className="mt-2"><Input label="Organizations (search to add)" disabled={!manage} value={orgQ} onChange={(e) => setOrgQ(e.target.value)} />{orgHits && orgQ && <div className="mt-1 flex flex-wrap gap-1">{orgHits.map((o) => <button key={o.id} className="rounded-full border border-ink-100 px-2 py-0.5 text-xs hover:bg-ink-50" onClick={() => { setScope({ ...sc, organizationIds: Array.from(new Set([...sc.organizationIds, o.id])) }); setOrgQ(''); }}>+ {o.name}</button>)}</div>}<div className="mt-1 flex flex-wrap gap-1">{sc.organizationIds.map((o) => <span key={o} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs">{o.slice(0, 8)} {manage && <button onClick={() => setScope({ ...sc, organizationIds: sc.organizationIds.filter((x) => x !== o) })}>×</button>}</span>)}</div></div>
            <p className="mt-1 text-xs text-ink-500">Empty lists mean every region and organization. Saving ends the person&apos;s sessions so the new scope applies.</p>
            {manage && scope && <Button className="mt-2" size="sm" onClick={() => { const reason = askReason('changing access scope'); if (reason) act(async () => { await api.put(`/admin/security/staff/${id}/scope`, { ...scope, reason }); setScope(null); }); }}>Save scope</Button>}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ink-500">Active sessions {manage && d.sessions.length > 0 && <Button size="sm" variant="ghost" onClick={() => { const reason = askReason('signing this person out everywhere'); if (reason) act(() => api.post(`/admin/security/staff/${id}/revoke-sessions`, { reason })); }}>Sign out everywhere</Button>}</div>
            {d.sessions.length === 0 ? <p className="text-xs text-ink-500">None.</p> : <ul className="space-y-1">{d.sessions.map((s) => <li key={s.id} className="flex items-center justify-between rounded-lg bg-ink-50 px-2 py-1 text-xs"><span>{s.client || 'web'} · {s.amr.join('+') || 'token'} · {s.ip || '—'} · last {when(s.lastSeenAt)}</span>{manage && <button className="text-red-600" onClick={() => { const reason = askReason('ending this session'); if (reason) act(() => api.post(`/admin/security/staff/${id}/revoke-sessions`, { reason, sessionId: s.id })); }}>End</button>}</li>)}</ul>}
          </div>
          {manage && d.id !== user?.id && <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-3">
            {d.status === 'ACTIVE' ? <Button size="sm" variant="danger" onClick={() => { const reason = askReason('disabling this account'); if (reason) act(() => api.post(`/admin/security/staff/${id}/disable`, { reason })); }}>Disable & revoke all access</Button> : <Button size="sm" onClick={() => { const reason = askReason('re-enabling this account'); if (reason) act(() => api.post(`/admin/security/staff/${id}/enable`, { reason })); }}>Re-enable</Button>}
            {d.mfaEnabled && <Button size="sm" variant="secondary" onClick={() => { const reason = askReason('resetting two-factor authentication'); if (reason) act(() => api.post(`/admin/security/staff/${id}/reset-mfa`, { reason })); }}>Reset MFA</Button>}
          </div>}
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-500">Recent actions</div>
            <ul className="max-h-48 space-y-1 overflow-auto text-xs">{d.recentActions.map((a) => <li key={a.id}><span className="text-ink-500">{when(a.createdAt)}</span> {a.action} · {a.entityType} {a.entityId.slice(0, 8)}{a.reason && <i className="text-ink-500"> — {a.reason}</i>}</li>)}</ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function GrantsTab({ onChange }: { onChange: () => void }) {
  const { can } = useSession();
  const [filter, setFilter] = useState('active=true');
  const { data, reload } = useApi<Grant[]>(`/access-grants?${filter}`, { deps: [filter], poll: 30000 });
  const { run, error } = useAction();
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="active=true">Active now</option><option value="kind=EMERGENCY&unreviewed=true">Emergency, not reviewed</option><option value="kind=EMERGENCY">All emergency</option><option value="kind=SUPPORT">All support sessions</option></Select>
      <Table rows={data || []} empty="Nothing here." cols={[
        { key: 'k', label: 'Kind', render: (g) => <Badge tone={g.kind === 'EMERGENCY' ? 'bad' : 'warn'}>{g.kind}</Badge> },
        { key: 'w', label: 'Who', render: (g) => g.email },
        { key: 'a', label: 'Access', render: (g) => g.kind === 'EMERGENCY' ? g.roles.map(roleLabel).join(', ') : `${g.organizationName} (${g.readOnly ? 'read-only' : 'changes'})` },
        { key: 'r', label: 'Reason', render: (g) => <span className="text-xs">{g.reason}{g.ticketRef && ` · ${g.ticketRef}`}</span> },
        { key: 't', label: 'Window', render: (g) => <span className="text-xs">{when(g.startsAt)} → {when(g.revokedAt || g.expiresAt)}{g.revokedAt ? ' (ended)' : ''}</span> },
        { key: 'n', label: 'Actions', render: (g) => g.actionCount },
        { key: 'v', label: 'Review', render: (g) => g.reviewedAt ? <span className="text-xs text-emerald-700">✓ {g.reviewNote}</span> : g.kind === 'EMERGENCY' && can('security.manage') ? <Button size="sm" variant="secondary" onClick={() => { const note = window.prompt('Review note (was this justified?)'); if (note) run(async () => { await api.post(`/access-grants/${g.id}/review`, { note }); reload(); onChange(); }); }}>Review</Button> : '—' },
        { key: 'e', label: '', render: (g) => !g.revokedAt && new Date(g.expiresAt) > new Date() && can('security.manage') ? <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/access-grants/${g.id}/end`, {}); reload(); onChange(); })}>End</Button> : null },
      ]} />
    </div>
  );
}

function MyEmergency() {
  const { user } = useSession();
  const { data: policy } = useApi<Policy>('/admin/security/settings');
  const { run, error } = useAction();
  const [f, setF] = useState({ roles: [] as string[], minutes: 60, reason: '', ticketRef: '' });
  const grantable = policy?.emergency.grantableRoles || ['OPERATIONS', 'FINANCE', 'SUPPORT'];
  return (
    <Card title="Break-glass access">
      <p className="text-sm text-ink-500">Use only when an incident needs access you don&apos;t normally have. It starts immediately, expires automatically, alerts every platform admin, and everything you do is tagged for review.</p>
      {error && <Alert>{error}</Alert>}
      {user?.elevated ? <Alert tone="info">You are elevated as {user.elevated.roles.join(', ')} until {when(user.elevated.until)}.</Alert> : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">{grantable.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.roles.includes(r)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r] : f.roles.filter((x) => x !== r) })} />{roleLabel(r)}</label>)}</div>
          <div className="grid gap-2 sm:grid-cols-2"><Input label={`Minutes (max ${policy?.emergency.maxMinutes || 240})`} type="number" value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /><Input label="Incident / ticket reference" value={f.ticketRef} onChange={(e) => setF({ ...f, ticketRef: e.target.value })} /></div>
          <Textarea label="What is the emergency? (required)" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Button variant="danger" disabled={!f.roles.length || f.reason.trim().length < 10} onClick={() => run(async () => adoptTokens(await api.post('/access-grants/emergency', { ...f, ticketRef: f.ticketRef || undefined })))}>Activate emergency access</Button>
        </div>
      )}
    </Card>
  );
}

function PolicyTab() {
  const { data: p, reload } = useApi<Policy>('/admin/security/settings');
  const { run, error } = useAction();
  const [mfa, setMfa] = useState<string[] | null>(null);
  const [sess, setSess] = useState<Policy['sessions'] | null>(null);
  const [sso, setSso] = useState<(Policy['sso'] & { clientSecret?: string }) | null>(null);
  const [em, setEm] = useState<Policy['emergency'] | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  if (!p) return null;
  const save = (body: Record<string, unknown>, what: string) => { const reason = askReason(what); if (reason) run(async () => { await api.patch('/admin/security/settings', { ...body, reason }); setOk(`Saved ${what}.`); await reload(); setMfa(null); setSess(null); setSso(null); setEm(null); }); };
  const m = mfa || p.mfaRequiredRoles, s = sess || p.sessions, o: Policy['sso'] & { clientSecret?: string } = sso || p.sso, e = em || p.emergency;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <Card title="Two-factor authentication">
        <p className="text-xs text-ink-500">People with these roles must use an authenticator app (or SSO) before the console opens.</p>
        <div className="mt-2 flex flex-wrap gap-2">{STAFF_ROLES.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={m.includes(r)} onChange={(ev) => setMfa(ev.target.checked ? [...m, r] : m.filter((x) => x !== r))} />{roleLabel(r)}</label>)}</div>
        <Button className="mt-2" size="sm" disabled={!mfa} onClick={() => save({ mfaRequiredRoles: m }, 'the MFA policy')}>Save</Button>
      </Card>
      <Card title="Staff sessions">
        <div className="grid grid-cols-3 gap-2"><Input label="Token minutes" type="number" value={s.staffTokenMinutes} onChange={(ev) => setSess({ ...s, staffTokenMinutes: Number(ev.target.value) })} /><Input label="Idle timeout (min)" type="number" value={s.staffIdleMinutes} onChange={(ev) => setSess({ ...s, staffIdleMinutes: Number(ev.target.value) })} /><Input label="Max session (h)" type="number" value={s.staffMaxHours} onChange={(ev) => setSess({ ...s, staffMaxHours: Number(ev.target.value) })} /></div>
        <Button className="mt-2" size="sm" disabled={!sess} onClick={() => save({ sessions: s }, 'the session policy')}>Save</Button>
      </Card>
      <Card title="Single sign-on (OpenID Connect)">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={o.enabled} onChange={(ev) => setSso({ ...o, enabled: ev.target.checked })} /> Allow staff to sign in with SSO</label>
          <Input label="Issuer URL" placeholder="https://login.example.com" value={o.issuer} onChange={(ev) => setSso({ ...o, issuer: ev.target.value })} />
          <div className="grid grid-cols-2 gap-2"><Input label="Client ID" value={o.clientId} onChange={(ev) => setSso({ ...o, clientId: ev.target.value })} /><Input label={o.hasClientSecret ? 'Client secret (saved; type to replace)' : 'Client secret'} type="password" value={o.clientSecret || ''} onChange={(ev) => setSso({ ...o, clientSecret: ev.target.value })} /></div>
          <Input label="Redirect URI (your web app)" placeholder="https://gutad.io/account/sso" value={o.redirectUri} onChange={(ev) => setSso({ ...o, redirectUri: ev.target.value })} />
          <Input label="Mobile app redirect URI (optional)" placeholder="gutad://auth/sso" value={o.mobileRedirectUri || ''} onChange={(ev) => setSso({ ...o, mobileRedirectUri: ev.target.value })} />
          <p className="text-xs text-ink-500">Leave empty if your identity provider only accepts web redirects: mobile sign-ins then come back through the web redirect above and are handed to the app.</p>
          <Input label="Allowed email domains (comma separated)" value={o.allowedDomains.join(', ')} onChange={(ev) => setSso({ ...o, allowedDomains: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          <Input label="Button label" value={o.label} onChange={(ev) => setSso({ ...o, label: ev.target.value })} />
          <Button size="sm" disabled={!sso} onClick={() => save({ sso: { ...o, clientSecret: o.clientSecret || undefined, hasClientSecret: undefined } }, 'single sign-on')}>Save</Button>
          <p className="text-xs text-ink-500">Only existing Gutad accounts can sign in through SSO; nobody is created automatically.</p>
        </div>
      </Card>
      <Card title="Emergency access">
        <Input label="Longest grant (minutes)" type="number" value={e.maxMinutes} onChange={(ev) => setEm({ ...e, maxMinutes: Number(ev.target.value) })} />
        <div className="mt-2 text-xs text-ink-500">Roles available through break-glass</div>
        <div className="mt-1 flex flex-wrap gap-2">{STAFF_ROLES.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={e.grantableRoles.includes(r)} onChange={(ev) => setEm({ ...e, grantableRoles: ev.target.checked ? [...e.grantableRoles, r] : e.grantableRoles.filter((x) => x !== r) })} />{roleLabel(r)}</label>)}</div>
        <Button className="mt-2" size="sm" disabled={!em} onClick={() => save({ emergency: e }, 'the emergency access policy')}>Save</Button>
      </Card>
    </div>
  );
}

