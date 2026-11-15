import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { AuthResponse, MfaChallenge } from '@gutad/shared';
import { api, session } from '@/api';
import { Button, Card, ErrorText, Input, Muted, s } from '@/ui';
import { SmsNotice } from '@/legal';
import { BrandLogo } from '@/brand';
import { useApi } from '@/hooks';
import { signInWithSso } from '@/sso';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // 2.4c-M SSO in the system browser (OpenID Connect), same identity provider as the web
  const { data: sso } = useApi<{ enabled: boolean; label: string }>('/auth/sso/config');
  const [ssoBusy, setSsoBusy] = useState(false);
  const startSso = async () => {
    setError(null); setSsoBusy(true);
    try { if (await signInWithSso()) router.back(); } catch (e) { setError((e as Error).message); } finally { setSsoBusy(false); }
  };
  const submit = async () => {
    setError(null);
    try {
      if (challenge) {
        await session.set(await api.post<AuthResponse>('/auth/mfa/verify', { challengeToken: challenge, code }));
        router.back();
        return;
      }
      const r = await api.post<AuthResponse | MfaChallenge>(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: f.email, password: f.password } : f);
      if ('mfaRequired' in r) { setChallenge(r.challengeToken); return; }
      await session.set(r);
      router.back();
    } catch (e) { setError((e as Error).message); }
  };
  if (challenge) return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Two-factor authentication">
        <Muted>Enter the 6-digit code from your authenticator app, or a recovery code.</Muted>
        <Input label="Code" autoFocus keyboardType="number-pad" value={code} onChangeText={setCode} />
        <ErrorText msg={error} />
        <Button title="Verify" onPress={submit} />
        <Button title="Start over" variant="ghost" onPress={() => { setChallenge(null); setCode(''); }} />
      </Card>
    </ScrollView>
  );
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={{ alignItems: 'center', marginVertical: 24 }}><BrandLogo size={44} /></View>
      <Card title={mode === 'login' ? 'Sign in' : 'Create account'}>
        {mode === 'register' && <Input label="Name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />}
        <Input label="Email" autoCapitalize="none" keyboardType="email-address" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} />
        <Input label="Password" secureTextEntry value={f.password} onChangeText={(v) => setF({ ...f, password: v })} />
        {mode === 'register' && <Input label="Phone" keyboardType="phone-pad" value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} />}
        {mode === 'register' && <SmsNotice />}
        <ErrorText msg={error} />
        <Button title={mode === 'login' ? 'Sign in' : 'Create account'} onPress={submit} />
        {mode === 'login' && sso?.enabled && <Button title={ssoBusy ? 'Opening sign-in…' : sso.label} variant="secondary" disabled={ssoBusy} onPress={startSso} />}
        <Button title={mode === 'login' ? 'Create an account' : 'Have an account? Sign in'} variant="ghost" onPress={() => setMode(mode === 'login' ? 'register' : 'login')} />
        <Muted>Demo: customer@demo.gutad.io / customer12345 · owner@demo.gutad.io / merchant12345 · driver@demo.gutad.io / driver12345</Muted>
      </Card>
    </ScrollView>
  );
}
