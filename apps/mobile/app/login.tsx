import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { AuthResponse } from '@gutad/shared';
import { api, session } from '@/api';
import { Button, Card, ErrorText, Input, Muted, s } from '@/ui';
import { BrandLogo } from '@/brand';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const r = await api.post<AuthResponse>(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: f.email, password: f.password } : f);
      await session.set(r);
      router.back();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={{ alignItems: 'center', marginVertical: 24 }}><BrandLogo size={44} /></View>
      <Card title={mode === 'login' ? 'Sign in' : 'Create account'}>
        {mode === 'register' && <Input label="Name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />}
        <Input label="Email" autoCapitalize="none" keyboardType="email-address" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} />
        <Input label="Password" secureTextEntry value={f.password} onChangeText={(v) => setF({ ...f, password: v })} />
        {mode === 'register' && <Input label="Phone" keyboardType="phone-pad" value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} />}
        <ErrorText msg={error} />
        <Button title={mode === 'login' ? 'Sign in' : 'Create account'} onPress={submit} />
        <Button title={mode === 'login' ? 'Create an account' : 'Have an account? Sign in'} variant="ghost" onPress={() => setMode(mode === 'login' ? 'register' : 'login')} />
        <Muted>Demo: customer@demo.gutad.io / customer12345 · owner@demo.gutad.io / merchant12345 · driver@demo.gutad.io / driver12345</Muted>
      </Card>
    </ScrollView>
  );
}
