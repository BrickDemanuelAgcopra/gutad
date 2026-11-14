import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SECURITY_ALERT_TYPES, type SecurityAlertType } from '@gutad/shared';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { hours, roleText, type AccessRequest, type IamUser } from '@/iam';
import { AccessBanner, Pills, StatTile } from '@/ops';

interface Overview { users: number; invited: number; inactive: number; withoutMfa: number; superadmins: number; pendingRequests: number; openReviews: number; unacknowledgedAlerts: number; keysExpiring: number; temporary: number; customRoles: number; roles: number }
interface SecAlert { id: string; type: string; severity: string; title: string; detail: string | null; subjectEmail: string | null; createdAt: string }
interface Sess { id: string; userId: string; email: string; name: string | null; amr: string[] | null; client: string | null; ip: string | null; userAgent: string | null; lastSeenAt: string | null; createdAt: string; current: boolean }

const sevTone = (s: string): 'bad' | 'warn' | 'info' => (s === 'CRITICAL' || s === 'HIGH' ? 'bad' : s === 'MEDIUM' ? 'warn' : 'info');

type Tab = 'overview' | 'requests' | 'alerts' | 'people' | 'sessions';

/** Users & access on mobile: monitoring, request/alert queues and one-tap account actions. Role and matrix editing stay on web. */
export default function OpsIam() {
  const { can, ready } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('overview');
  if (!ready) return null;
  const read = can('security.read');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <AccessBanner />
      {read ? (
        <>
          <Pills value={tab} onChange={setTab} options={[{ id: 'overview', label: 'Overview' }, { id: 'requests', label: 'Requests' }, { id: 'alerts', label: 'Alerts' }, { id: 'people', label: 'People' }, { id: 'sessions', label: 'Sessions' }]} />
          {tab === 'overview' && <OverviewTab />}
          {tab === 'requests' && <Requests />}
          {tab === 'alerts' && <Alerts />}
          {tab === 'people' && <People />}
          {tab === 'sessions' && <Sessions />}
        </>
      ) : (
        <Card title="Users & access"><Muted>Staff management needs the security role. You can still see your own access and request more.</Muted></Card>
      )}
      <Button title="My access & requests" variant="secondary" onPress={() => router.push('/ops/my-access')} />
      <View style={{ height: 8 }} />
      <Muted>Edit roles, the permission matrix, reviews and API keys in the web console (gutad.io/admin/iam).</Muted>
    </ScrollView>
  );
}

function OverviewTab() {
  const { data, error } = useApi<Overview>('/admin/iam/overview', { poll: 60000 });
  if (error) return <ErrorText msg={error} />;
  if (!data) return <Loading />;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
      <StatTile label="Staff users" value={data.users} hint={`${data.temporary} with temporary roles`} />
      <StatTile label="Invited" value={data.invited} />
      <StatTile label="Inactive" value={data.inactive} />
      <StatTile label="Without MFA" value={data.withoutMfa} />
      <StatTile label="Superadmins" value={data.superadmins} />
      <StatTile label="Pending requests" value={data.pendingRequests} />
      <StatTile label="Open reviews" value={data.openReviews} />
      <StatTile label="Unacknowledged alerts" value={data.unacknowledgedAlerts} />
      <StatTile label="Keys expiring (14 days)" value={data.keysExpiring} />
      <StatTile label="Roles" value={data.roles} hint={`${data.customRoles} custom`} />
    </View>
  );
}

function Requests() {
  const { data, loading, reload } = useApi<AccessRequest[]>('/iam/access-requests?status=PENDING', { poll: 30000 });
  if (loading && !data) return <Loading />;
  return (
    <>
      {data?.length === 0 && <Card><Muted>No pending access requests.</Muted></Card>}
      {data?.map((r) => <RequestCard key={r.id} r={r} onDone={reload} />)}
    </>
  );
}

function RequestCard({ r, onDone }: { r: AccessRequest; onDone: () => void }) {
  const { run, error, busy } = useAction();
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Text style={{ fontWeight: '700', color: C.ink }}>{r.roleName}</Text>{r.privileged && <Badge text="PRIVILEGED" tone="bad" />}<Badge text={hours(r.durationHours)} tone="info" /></View>
      <Muted>{r.requesterName ? `${r.requesterName} · ` : ''}{r.requesterEmail} · {when(r.createdAt)}</Muted>
      <Text style={{ color: C.ink7, marginTop: 4, fontStyle: 'italic' }}>“{r.justification}”</Text>
      {r.canDecide && (open ? (
        <View style={{ marginTop: 8 }}>
          <Input label="Note (required to reject)" value={note} onChangeText={setNote} />
          <ErrorText msg={error} />
          <Button title="Approve" disabled={busy} onPress={() => run(async () => { await api.post(`/iam/access-requests/${r.id}/approve`, note.trim() ? { note } : {}); onDone(); })} />
          <Button title="Reject" variant="danger" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/iam/access-requests/${r.id}/reject`, { note }); onDone(); })} />
        </View>
      ) : <Button title="Review" onPress={() => setOpen(true)} />)}
    </Card>
  );
}

function Alerts() {
  const { data, loading, reload } = useApi<SecAlert[]>('/admin/iam/alerts?open=true', { poll: 30000 });
  const { run, error, busy } = useAction();
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorText msg={error} />
      {!!data?.length && <Button title={`Acknowledge all (${data.length})`} variant="secondary" disabled={busy} onPress={() => run(async () => { await api.post('/admin/iam/alerts/all/ack', {}); reload(); })} />}
      {data?.length === 0 && <Card><Muted>No open security alerts.</Muted></Card>}
      {data?.map((a) => (
        <Card key={a.id}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Badge text={a.severity} tone={sevTone(a.severity)} /><Badge text={SECURITY_ALERT_TYPES[a.type as SecurityAlertType] || a.type} /></View>
          <Text style={{ marginTop: 6, fontWeight: '600', color: C.ink }}>{a.title}</Text>
          {a.detail ? <Muted>{a.detail}</Muted> : null}
          <Muted>{a.subjectEmail ? `${a.subjectEmail} · ` : ''}{when(a.createdAt)}</Muted>
          <Button title="Acknowledge" variant="ghost" disabled={busy} onPress={() => run(async () => { await api.post(`/admin/iam/alerts/${a.id}/ack`, {}); reload(); })} />
        </Card>
      ))}
    </>
  );
}

function People() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading, error } = useApi<IamUser[]>(`/admin/iam/users${query ? `?q=${encodeURIComponent(query)}` : ''}`, { deps: [query] });
  return (
    <>
      <Input placeholder="Search name or email" value={q} onChangeText={setQ} onSubmitEditing={() => setQuery(q.trim())} returnKeyType="search" autoCapitalize="none" />
      <ErrorText msg={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <Card><Muted>No staff match.</Muted></Card>}
      {data?.map((u) => (
        <Pressable key={u.id} onPress={() => router.push({ pathname: '/ops/iam-user', params: { id: u.id } })}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{u.email}</Text><Badge text={u.status} tone={u.status === 'ACTIVE' ? 'good' : u.status === 'INVITED' ? 'warn' : 'bad'} /></View>
            {u.name ? <Muted>{u.name}{u.title ? ` · ${u.title}` : ''}</Muted> : null}
            <Muted>{u.roles.length ? u.roles.map(roleText).join(' · ') : 'No roles'}</Muted>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              {u.inactive && <Badge text="INACTIVE" tone="warn" />}
              {!u.mfaEnabled && <Badge text="NO MFA" tone="warn" />}
              <Muted>{u.sessions} session(s) · last {u.lastSeenAt || u.lastLoginAt ? when(u.lastSeenAt || u.lastLoginAt) : 'never'}</Muted>
            </View>
          </Card>
        </Pressable>
      ))}
    </>
  );
}

function Sessions() {
  const { can } = useSession();
  const { data, loading, reload } = useApi<Sess[]>('/admin/iam/sessions');
  const { run, error, busy } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  if (loading && !data) return <Loading />;
  return (
    <>
      <ErrorText msg={error} />
      {data?.length === 0 && <Card><Muted>No active staff sessions.</Muted></Card>}
      {data?.map((x) => (
        <Card key={x.id}>
          <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{x.email}</Text>{x.current && <Badge text="THIS DEVICE" tone="info" />}</View>
          <Muted>{x.client || 'unknown client'}{x.ip ? ` · ${x.ip}` : ''}{x.amr?.length ? ` · ${x.amr.join('+')}` : ''}</Muted>
          <Muted>Started {when(x.createdAt)} · last seen {when(x.lastSeenAt)}</Muted>
          {can('security.manage') && !x.current && (open === x.id ? (
            <View style={{ marginTop: 8 }}>
              <Input label="Reason (saved in the audit trail)" value={reason} onChangeText={setReason} />
              <Button title="End session" variant="danger" disabled={busy || reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/iam/sessions/${x.id}/revoke`, { reason }); setReason(''); setOpen(null); reload(); })} />
              <Button title="Cancel" variant="ghost" onPress={() => setOpen(null)} />
            </View>
          ) : <Button title="End" variant="ghost" onPress={() => { setReason(''); setOpen(x.id); }} />)}
        </Card>
      ))}
    </>
  );
}

