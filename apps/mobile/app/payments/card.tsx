import { useEffect } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Loading, Muted, s } from '@/ui';

/** 18.9-S deep-link target of the processor's hosted card page; the card screen that opened it finishes the setup. */
export default function CardReturn() {
  const router = useRouter();
  useEffect(() => { const t = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/')), 300); return () => clearTimeout(t); }, [router]);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: 'Card' }} />
      <Loading />
      <Muted>Returning from the secure card page…</Muted>
    </ScrollView>
  );
}
