import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { STAFF_ROLE_LABELS, type StaffRole } from '@gutad/shared';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { AccessBanner, adoptTokens, Pills, StatTile } from '@/ops';

interface Grant { id: string; kind: string; email: string; roles: string[]; organizationName: string | null; reason: string; expiresAt: string; revokedAt: string | null; reviewedAt: string | null; reviewNote: string | null; actionCount: number }
interface Staff { id: string; email: string; roles: string[]; status: string; mfaEnabled: boolean; scope: { maxSensitivity: string } | null; sessions: number; lastSeenAt: string | null }
const label = (r: string) => STAFF_ROLE_LABELS[r as StaffRole] || r;

/** Staff & access on mobile: overview, staff (with sign-out everywhere / disable), grants with review, break-glass. */
export default function OpsSecurity() {
  const { can } = useSession();
  const [tab, setTab] = useState<'overview' | 'staff' | 'grants' | 'emergency'>('overview');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <AccessBanner />
      <Pills value={tab} onChange={setTab} options={[{ id: 'overview', label: 'Overview' }, ...(can('security.read') ? [{ id: 'staff' as const, label: 'Staff' }, { id: 'grants' as const, label: 'Access grants' }] : []), { id: 'emergency', label: 'Break-glass' }]} />
      {tab === 'overview' && <Overview />}
      {tab === 'staff' && <StaffList />}
      {tab === 'grants' && <Grants />}
      {tab === 'emergency' && <Emergency />}
    </ScrollView>
  );
}

function Overview() {
  const { can } = useSession();
  const { data } = useApi<{ staff: number; withoutMfa: number; disabled: number; scoped: number; activeEmergency: number; unreviewedEmergency: number; sso: { enabled: boolean } }>(can('security.read') ? '/admin/security/overview' : null);
  if (!data) return <Card><Muted>Use Break-glass for emergency access. Staff management needs the security role.</Muted></Card>;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <StatTile label="Staff" value={data.staff} hint={`${data.scoped} scoped · ${data.disabled} disabled`} />
      <StatTile label="Without MFA" value={data.withoutMfa} />
      <StatTile label="Emergency access" value={data.activeEmergency} hint={`${data.unreviewedEmergency} to review`} />
      <StatTile label="Single sign-on" value={data.sso.enabled ? 'On' : 'Off'} />
    </View>
  );
}

function StaffList() {
  const { can } = useSession();
  const { data, reload } = useApi<Staff[]>('/admin/security/staff');
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <ErrorText msg={error} />
      {data?.map((p) => (
        <Card key={p.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }} onPress={() => setOpen(open === p.id ? null : p.id)}>{p.email}</Text><Badge text={p.status} tone={p.status === 'ACTIVE' ? 'good' : 'bad'} /></View>
          <Muted>{p.roles.map(label).join(' · ')} · MFA {p.mfaEnabled ? 'on' : 'off'}{p.scope ? ` · scoped (${p.scope.maxSensitivity.toLowerCase()})` : ''}</Muted>
          <Muted>{p.sessions} session(s) · last {p.lastSeenAt ? when(p.lastSeenAt) : 'never'}</Muted>
          {open === p.id && can('security.manage') && (
            <View style={{ marginTop: 8 }}>
              <Input label="Reason (saved in the audit trail)" value={reason} onChangeText={setReason} />
              <Button title="Sign out everywhere" variant="secondary" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/security/staff/${p.id}/revoke-sessions`, { reason }); setReason(''); reload(); })} />
              {p.status === 'ACTIVE' ? <Button title="Disable & revoke all access" variant="danger" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/security/staff/${p.id}/disable`, { reason }); setReason(''); reload(); })} /> : <Button title="Re-enable" disabled={reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/security/staff/${p.id}/enable`, { reason }); setReason(''); reload(); })} />}
              <Muted>Roles and scopes are edited on the web console.</Muted>
            </View>
          )}
        </Card>
      ))}
    </>
  );
}

function Grants() {
  const { can } = useSession();
  const [f, setF] = useState<'active=true' | 'kind=EMERGENCY&unreviewed=true' | 'kind=SUPPORT'>('active=true');
  const { data, reload } = useApi<Grant[]>(`/access-grants?${f}`, { deps: [f] });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  return (
    <>
      <Pills value={f} onChange={setF} options={[{ id: 'active=true', label: 'Active' }, { id: 'kind=EMERGENCY&unreviewed=true', label: 'To review' }, { id: 'kind=SUPPORT', label: 'Support' }]} />
      <ErrorText msg={error} />
      {data?.length === 0 && <Card><Muted>Nothing here.</Muted></Card>}
      {data?.map((g) => (
        <Card key={g.id}>
          <View style={s.row}><Badge text={g.kind} tone={g.kind === 'EMERGENCY' ? 'bad' : 'warn'} /><Muted>{g.actionCount} actions</Muted></View>
          <Text style={{ marginTop: 6, fontWeight: '600' }}>{g.email}</Text>
          <Muted>{g.kind === 'EMERGENCY' ? g.roles.map(label).join(', ') : g.organizationName} · until {when(g.revokedAt || g.expiresAt)}{g.revokedAt ? ' (ended)' : ''}</Muted>
          <Text style={{ fontStyle: 'italic', color: C.ink7 }}>“{g.reason}”</Text>
          {g.reviewedAt ? <Muted>Reviewed: {g.reviewNote}</Muted> : g.kind === 'EMERGENCY' && can('security.manage') ? <><Input label="Review note" value={note} onChangeText={setNote} /><Button title="Mark reviewed" disabled={note.trim().length < 3} onPress={() => run(async () => { await api.post(`/access-grants/${g.id}/review`, { note }); setNote(''); reload(); })} /></> : null}
          {!g.revokedAt && new Date(g.expiresAt) > new Date() && can('security.manage') && <Button title="End now" variant="ghost" onPress={() => run(async () => { await api.post(`/access-grants/${g.id}/end`, {}); reload(); })} />}
        </Card>
      ))}
    </>
  );
}

function Emergency() {
  const { user } = useSession();
  const { data: policy } = useApi<{ emergency: { maxMinutes: number; grantableRoles: string[] } }>('/admin/security/settings');
  const { run, error } = useAction();
  const [roles, setRoles] = useState<string[]>([]);
  const [minutes, setMinutes] = useState('60');
  const [reason, setReason] = useState('');
  const grantable = policy?.emergency.grantableRoles || ['OPERATIONS', 'FINANCE', 'SUPPORT'];
  if (user?.elevated) return <Card title="You are elevated"><Muted>{user.elevated.roles.join(', ')} until {when(user.elevated.until)}. End it from the banner above.</Muted></Card>;
  return (
    <Card title="Break-glass access">
      <Muted>Starts now, expires automatically, alerts every platform admin, and every action is tagged for review.</Muted>
      {grantable.map((r) => <View key={r} style={[s.row, { marginVertical: 4 }]}><Text>{label(r)}</Text><Switch value={roles.includes(r)} onValueChange={(v) => setRoles(v ? [...roles, r] : roles.filter((x) => x !== r))} /></View>)}
      <Input label={`Minutes (max ${policy?.emergency.maxMinutes || 240})`} keyboardType="number-pad" value={minutes} onChangeText={setMinutes} />
      <Input label="What is the emergency?" value={reason} onChangeText={setReason} multiline />
      <ErrorText msg={error} />
      <Button title="Activate emergency access" variant="danger" disabled={!roles.length || reason.trim().length < 10} onPress={() => run(async () => adoptTokens(await api.post('/access-grants/emergency', { roles, minutes: Number(minutes) || 60, reason })))} />
    </Card>
  );
}
