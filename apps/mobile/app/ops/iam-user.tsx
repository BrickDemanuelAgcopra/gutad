import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { roleText, type IamUser } from '@/iam';
import { AccessBanner, useStepUp, type StepUpProof } from '@/ops';

interface Assignment { id: string; roleKey: string; roleName: string; kind: string; isPrimary: boolean; responsibility: string | null; startsAt: string; endsAt: string | null; revokedAt: string | null; revokeReason: string | null; state: string }
interface Session { id: string; amr: string[] | null; client: string | null; userAgent: string | null; ip: string | null; lastSeenAt: string | null; createdAt: string; current: boolean }
interface Login { id: string; outcome: string; method: string; reason: string | null; ip: string | null; userAgent: string | null; suspicious: boolean; createdAt: string }
type Detail = IamUser & { assignments: Assignment[]; sessions: Session[] | number; logins: Login[]; locked: boolean };
interface Effective { superadmin: boolean; mfaRequired: boolean; notes: string[]; modules: { key: string; label: string; group: string }[]; matrix: { resource: string; label: string; group: string; actions: { action: string; granted: boolean }[] }[]; fields: { field: string; label: string; view: boolean; export: boolean }[] }

/** One staff member: roles, sessions, sign-ins, effective access (read-only) and quick account actions. */
export default function OpsIamUser() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can, user: me } = useSession();
  const { data, error, reload } = useApi<Detail>(id ? `/admin/iam/users/${id}` : null, { deps: [id] });
  const { data: eff } = useApi<Effective>(id ? `/admin/iam/users/${id}/effective` : null, { deps: [id] });
  if (error) return <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View>;
  if (!data) return <View style={s.screen}><Loading /></View>;
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const self = me?.id === data.id;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <AccessBanner />
      <Card title={data.name || data.email}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge text={data.status} tone={data.status === 'ACTIVE' ? 'good' : data.status === 'INVITED' ? 'warn' : 'bad'} />
          {data.inactive && <Badge text="INACTIVE" tone="warn" />}
          {data.locked && <Badge text="SIGN-IN LOCKED" tone="bad" />}
          <Badge text={data.mfaEnabled ? 'MFA ON' : 'NO MFA'} tone={data.mfaEnabled ? 'good' : 'warn'} />
        </View>
        <Muted>{data.email}{data.title ? ` · ${data.title}` : ''}{data.department ? ` · ${data.department}` : ''}</Muted>
        {data.statusReason ? <Muted>Status reason: {data.statusReason}</Muted> : null}
        {data.suspendedUntil ? <Muted>Suspended until {when(data.suspendedUntil)}</Muted> : null}
        <Muted>Last sign-in {when(data.lastLoginAt)} · last seen {when(data.lastSeenAt)}</Muted>
      </Card>

      {can('security.manage') && !self && <QuickActions u={data} onDone={reload} />}

      <Card title="Roles">
        {data.roles?.length ? data.roles.map((r) => <Text key={`${r.key}-${r.assignmentId}`} style={{ color: C.ink, marginBottom: 2 }}>• {roleText(r)}{r.kind !== 'STANDARD' ? ` · ${r.kind.toLowerCase()}` : ''}</Text>) : <Muted>No roles.</Muted>}
        {data.assignments?.some((a) => a.state !== 'ACTIVE') && (
          <View style={{ marginTop: 8 }}>
            <Text style={s.label}>History</Text>
            {data.assignments.filter((a) => a.state !== 'ACTIVE').slice(0, 10).map((a) => <Muted key={a.id}>{a.roleName} · {a.state.toLowerCase()} · {when(a.revokedAt || a.endsAt || a.startsAt)}{a.revokeReason ? ` · ${a.revokeReason}` : ''}</Muted>)}
          </View>
        )}
      </Card>

      {eff && (
        <Card title="Effective access">
          {eff.superadmin && <Badge text="SUPERADMIN" tone="bad" />}
          {eff.notes.map((n, i) => <Muted key={i}>• {n}</Muted>)}
          <Text style={[s.label, { marginTop: 8 }]}>Console modules ({eff.modules.length})</Text>
          <Muted>{eff.modules.length ? eff.modules.map((m) => m.label).join(' · ') : 'None'}</Muted>
          <Text style={[s.label, { marginTop: 8 }]}>Granted permissions</Text>
          {eff.matrix.map((r) => { const g = r.actions.filter((a) => a.granted); return g.length ? <Muted key={r.resource}>{r.label}: {g.length}/{r.actions.length} ({g.map((a) => a.action.replace('_', ' ')).join(', ')})</Muted> : null; })}
          {!eff.matrix.some((r) => r.actions.some((a) => a.granted)) && <Muted>Nothing granted.</Muted>}
          <Muted>Read-only here. Change roles and the matrix in the web console.</Muted>
        </Card>
      )}

      <Card title={`Sessions (${sessions.length})`}>
        {!sessions.length && <Muted>No active sessions.</Muted>}
        {sessions.map((x) => <Muted key={x.id}>{x.client || 'unknown'}{x.ip ? ` · ${x.ip}` : ''} · since {when(x.createdAt)} · seen {when(x.lastSeenAt)}</Muted>)}
      </Card>

      <Card title="Recent sign-ins">
        {!data.logins?.length && <Muted>None recorded.</Muted>}
        {data.logins?.map((l) => (
          <View key={l.id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <Badge text={l.outcome} tone={l.outcome === 'SUCCESS' ? 'good' : 'bad'} />
            {l.suspicious && <Badge text="SUSPICIOUS" tone="bad" />}
            <Muted>{when(l.createdAt)} · {l.method}{l.ip ? ` · ${l.ip}` : ''}{l.reason ? ` · ${l.reason}` : ''}</Muted>
          </View>
        ))}
      </Card>
      <Muted>Edit roles, the permission matrix, reviews and API keys in the web console (gutad.io/admin/iam).</Muted>
    </ScrollView>
  );
}

function QuickActions({ u, onDone }: { u: Detail; onDone: () => void }) {
  const { run, error, busy } = useAction();
  const { guard, modal } = useStepUp();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const ok = reason.trim().length >= 5;
  const act = (label: string, call: (stepUp?: StepUpProof) => Promise<unknown>) => run(async () => {
    setMsg(null);
    const res = await guard(async (stepUp) => { const r = await call(stepUp); setReason(''); setMsg(`${label}: done`); onDone(); return r; });
    return res;
  });
  const blocked = ['SUSPENDED', 'DISABLED'].includes(u.status);
  return (
    <Card title="Quick actions">
      <Input label="Reason (min 5 characters, saved in the audit trail)" value={reason} onChangeText={setReason} />
      <ErrorText msg={error} />
      {msg && <Text style={{ color: C.good, marginBottom: 4 }}>{msg}</Text>}
      <Button title="Force sign-out everywhere" variant="secondary" disabled={busy || !ok} onPress={() => act('Signed out', (stepUp) => api.post(`/admin/iam/users/${u.id}/force-logout`, { reason, stepUp }))} />
      {u.status === 'ACTIVE' && <Button title="Suspend" variant="danger" disabled={busy || !ok} onPress={() => act('Suspended', (stepUp) => api.post(`/admin/iam/users/${u.id}/status`, { status: 'SUSPENDED', reason, stepUp }))} />}
      {blocked && <Button title="Reactivate" disabled={busy || !ok} onPress={() => act('Reactivated', (stepUp) => api.post(`/admin/iam/users/${u.id}/status`, { status: 'ACTIVE', reason, stepUp }))} />}
      {u.locked && <Badge text="LOCKED AFTER FAILED SIGN-INS" tone={tone('FAILED')} />}
      <Button title="Unlock sign-in" variant="ghost" disabled={busy} onPress={() => act('Unlocked', () => api.post(`/admin/iam/users/${u.id}/unlock`, {}))} />
      <Muted>Superadmin accounts need your authenticator code or password to confirm.</Muted>
      {modal}
    </Card>
  );
}
