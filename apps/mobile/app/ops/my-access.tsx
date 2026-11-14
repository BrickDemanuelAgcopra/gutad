import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { hours, roleText, type AccessRequest } from '@/iam';
import { AccessBanner } from '@/ops';

interface WhoAmI { id: string; email: string; staff: boolean; roles: string[]; permissions: string[] }
interface Requestable { id: string; key: string; name: string; description: string | null; held: boolean }

/** Any staff member: own roles, request a role, follow and cancel own requests. */
export default function MyAccess() {
  const { user, ready, isStaff } = useSession();
  const { data: who } = useApi<WhoAmI>(isStaff ? '/iam/whoami' : null);
  const { data: mine, loading, reload } = useApi<AccessRequest[]>(isStaff ? '/iam/access-requests?mine=true' : null);
  const { run, error, busy } = useAction();
  if (!ready) return null;
  if (!user || !isStaff) return <View style={[s.screen, s.pad]}><Card title="My access"><Muted>For Gutad staff only.</Muted></Card></View>;
  const roles = user.accessRoles || [];
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <AccessBanner />
      <Card title="My roles">
        {roles.length ? roles.map((r) => <Text key={r.id} style={{ color: C.ink, marginBottom: 2 }}>• {roleText(r)}</Text>) : who?.roles.length ? <Muted>{who.roles.join(' · ')}</Muted> : <Muted>No roles yet.</Muted>}
        {who && <Muted>{who.permissions.length} permission(s) granted.</Muted>}
        <Muted>Roles changed recently show up after you sign in again.</Muted>
      </Card>

      <RequestForm onDone={reload} />

      <Card title="My requests">
        <ErrorText msg={error} />
        {loading && !mine && <Loading />}
        {mine?.length === 0 && <Muted>You have not asked for access.</Muted>}
        {mine?.map((r) => (
          <View key={r.id} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingTop: 8, marginTop: 8 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Text style={{ fontWeight: '600', color: C.ink }}>{r.roleName}</Text><Badge text={r.status} tone={tone(r.status)} /><Badge text={hours(r.durationHours)} tone="info" /></View>
            <Muted>{when(r.createdAt)} · “{r.justification}”</Muted>
            {r.decisionNote ? <Muted>Decision: {r.decisionNote}</Muted> : null}
            {r.status === 'PENDING' && <Button title="Cancel request" variant="ghost" disabled={busy} onPress={() => run(async () => { await api.post(`/iam/access-requests/${r.id}/cancel`, {}); reload(); })} />}
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

function RequestForm({ onDone }: { onDone: () => void }) {
  const { data: roles } = useApi<Requestable[]>('/iam/requestable-roles');
  const { run, error, busy } = useAction();
  const [roleId, setRoleId] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [hrs, setHrs] = useState('');
  const [sent, setSent] = useState(false);
  const h = hrs.trim() ? Number(hrs) : null;
  const badHours = h !== null && (!Number.isInteger(h) || h < 1 || h > 24 * 90);
  return (
    <Card title="Request access">
      {!roles && <Loading />}
      {roles?.length === 0 && <Muted>No roles can be requested right now.</Muted>}
      {roles?.map((r) => (
        <Pressable key={r.id} disabled={r.held} onPress={() => { setRoleId(r.id); setSent(false); }} style={{ padding: 10, borderRadius: 10, borderWidth: 1, borderColor: roleId === r.id ? C.brand : C.ink1, marginBottom: 6, opacity: r.held ? 0.5 : 1 }}>
          <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink }}>{r.name}</Text>{r.held && <Badge text="HELD" tone="good" />}</View>
          {r.description ? <Muted>{r.description}</Muted> : null}
        </Pressable>
      ))}
      {roleId && (
        <>
          <Input label="Why do you need it? (min 10 characters)" value={why} onChangeText={setWhy} multiline />
          <Input label="For how many hours? (empty = permanent, max 2160)" value={hrs} onChangeText={setHrs} keyboardType="number-pad" />
          <ErrorText msg={error || (badHours ? 'Hours must be a whole number from 1 to 2160' : null)} />
          <Button title="Send request" disabled={busy || why.trim().length < 10 || badHours} onPress={() => run(async () => { await api.post('/iam/access-requests', { roleId, justification: why.trim(), durationHours: h }); setRoleId(null); setWhy(''); setHrs(''); setSent(true); onDone(); })} />
        </>
      )}
      {sent && <Text style={{ color: C.good }}>Request sent. Security approvers have been notified.</Text>}
    </Card>
  );
}
