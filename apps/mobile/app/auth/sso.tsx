import { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { finishSso } from '@/sso';
import { Button, Card, ErrorText, Loading, Muted, s } from '@/ui';

/** 2.4c-M deep-link target (gutad://auth/sso): finishes an SSO sign-in when the system delivers the link to the app. */
export default function SsoReturn() {
  const router = useRouter();
  const p = useLocalSearchParams<{ code?: string; state?: string; error?: string; error_description?: string }>();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (p.error) { setError(String(p.error_description || p.error)); return; }
    if (!p.code || !p.state) { setError('Missing sign-in response.'); return; }
    finishSso(String(p.code), String(p.state)).then(() => router.replace('/')).catch((e) => setError((e as Error).message));
  }, [p, router]);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: 'Signing in' }} />
      {error ? <Card title="Sign-in didn’t finish"><ErrorText msg={error} /><Button title="Back to sign in" onPress={() => router.replace('/login')} /></Card> : <><Loading /><Muted>Finishing single sign-on…</Muted></>}
    </ScrollView>
  );
}
