import { useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { adoptTokens } from '@/ops';

interface Sess { id: string; amr: string[]; client: string | null; userAgent: string | null; ip: string | null; lastSeenAt: string; current: boolean }

/** Account security: two-factor authentication and signed-in devices. */
export default function Security() {
  const { user } = useSession();
  const { data: me, reload: reloadMe } = useApi<{ mfaEnabledAt: string | null; mfaRecoveryCodesLeft: number }>(user ? '/auth/me' : null);
  const { data: sessions, reload } = useApi<Sess[]>(user ? '/auth/sessions' : null);
  const { run, error } = useAction();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!user) return null;
  const on = !!me?.mfaEnabledAt;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Two-factor authentication">
        {user.mfaSetupRequired && <Muted>Your role requires two-factor authentication.</Muted>}
        {codes && <View style={{ backgroundColor: '#fef3c7', padding: 10, borderRadius: 10, marginVertical: 8 }}><Text style={{ fontWeight: '700' }}>Save these recovery codes</Text>{codes.map((c) => <Text key={c} style={{ fontFamily: 'monospace' }}>{c}</Text>)}</View>}
        {on ? (
          <>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Badge text="ON" tone="good" /><Muted>since {when(me!.mfaEnabledAt)} · {me!.mfaRecoveryCodesLeft} recovery codes left</Muted></View>
            <Input label="Code to turn it off" keyboardType="number-pad" value={code} onChangeText={setCode} />
            <Button title="Turn off" variant="secondary" onPress={() => run(async () => { await api.post('/auth/mfa/disable', { code }); setCode(''); reloadMe(); })} />
          </>
        ) : setup ? (
          <>
            <Muted>Add this key to your authenticator app, then enter the 6-digit code.</Muted>
            <Text selectable style={{ fontFamily: 'monospace', marginVertical: 8, color: C.ink }}>{setup.secret}</Text>
            <Button title="Open authenticator app" variant="secondary" onPress={() => void Linking.openURL(setup.otpauthUrl)} />
            <Input label="6-digit code" keyboardType="number-pad" value={code} onChangeText={setCode} />
            <Button title="Turn on" onPress={() => run(async () => { const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }); await adoptTokens(r); setCodes(r.recoveryCodes); setSetup(null); setCode(''); reloadMe(); })} />
          </>
        ) : (
          <><Muted>Use a code from your phone at every sign-in.</Muted><Button title="Set up" onPress={() => run(async () => setSetup(await api.post('/auth/mfa/setup', {})))} /></>
        )}
        <ErrorText msg={error} />
      </Card>
      <Card title="Signed-in devices">
        {(sessions || []).map((x) => (
          <View key={x.id} style={[s.row, { paddingVertical: 6 }]}>
            <View style={{ flex: 1 }}><Text style={{ color: C.ink }}>{x.client || (x.userAgent?.includes('Mobile') ? 'Phone' : 'Browser')}{x.current ? ' · this device' : ''}</Text><Muted>{x.amr.includes('mfa') ? 'with 2FA · ' : ''}last active {when(x.lastSeenAt)}</Muted></View>
            {!x.current && <Button title="Sign out" variant="ghost" onPress={() => run(async () => { await api.delete(`/auth/sessions/${x.id}`); reload(); })} />}
          </View>
        ))}
        {sessions && sessions.length > 1 && <Button title="Sign out other devices" variant="secondary" onPress={() => run(async () => { await api.post('/auth/sessions/revoke-others', {}); reload(); })} />}
      </Card>
    </ScrollView>
  );
}
