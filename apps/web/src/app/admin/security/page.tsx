'use client';
import Link from 'next/link';
import { useState } from 'react';
import { STAFF_ROLE_LABELS, STAFF_ROLES, type StaffRole } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, Table, Tabs, Textarea } from '@/components/ui';
import { adoptTokens, askReason, SectionTitle } from '@/components/admin-ui';

interface Grant { id: string; kind: string; userId: string; email: string; roles: string[]; organizationName: string | null; reason: string; ticketRef: string | null; startsAt: string; expiresAt: string; revokedAt: string | null; reviewedAt: string | null; reviewNote: string | null; actionCount: number; readOnly: number }
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
      {tab === 'staff' && <StaffTab />}
      {tab === 'grants' && <GrantsTab onChange={reloadOv} />}
      {tab === 'mine' && <MyEmergency />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
}

function StaffTab() {
  return (
    <Card title="Staff, roles and permissions moved">
      <p className="text-sm text-ink-500">Inviting staff, roles and the permission matrix, access scopes, sessions, two-factor status and offboarding now live in Users, roles &amp; permissions.</p>
      <Link className="mt-3 inline-block" href="/admin/iam"><Button size="sm">Open Users, roles &amp; permissions</Button></Link>
    </Card>
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

