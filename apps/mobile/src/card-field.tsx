import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { TEST_CARDS } from '@gutad/shared';
import { api } from './api';
import { useApi, useSession } from './hooks';
import { Button, ErrorText, Muted } from './ui';

export interface CardToken { token: string; brand: string; last4: string }

/**
 * 18.9-S live processor on mobile: the native payment sheet SDK is not bundled, so the card is saved on the
 * processor's hosted setup page in the system browser (SetupIntent via a hosted session). It returns to the app's
 * deep link and Gutad reads the token and masked details back from the processor.
 */
function HostedCard({ value, onChange }: { value: CardToken | null; onChange: (t: CardToken) => void }) {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return <Muted>Sign in to add a card. Card details are entered on the payment processor’s secure page and never sent to Gutad.</Muted>;
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const returnTo = Linking.createURL('payments/card');
      const s = await api.post<{ url?: string; sessionId?: string }>('/me/payment-methods/setup', { hosted: true, returnTo });
      if (!s.url || !s.sessionId) throw new Error('Card setup is unavailable right now');
      const r = await WebBrowser.openAuthSessionAsync(s.url, returnTo);
      if (r.type !== 'success') return;
      const q = Linking.parse(r.url).queryParams || {};
      if (q.status !== 'done') return;
      onChange(await api.post<CardToken>('/me/payment-methods/setup/complete', { sessionId: String(q.session_id || s.sessionId) }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <View style={{ marginVertical: 6 }}>
      {value && <Text style={{ fontSize: 14, color: '#059669', marginBottom: 4 }}>{value.brand} •••• {value.last4} ready</Text>}
      <Button title={busy ? 'Opening secure page…' : value ? 'Use a different card' : 'Add card on secure page'} variant="secondary" disabled={busy} onPress={add} />
      <ErrorText msg={error} />
      <Muted>Card details go straight to our payment processor and never reach Gutad.</Muted>
    </View>
  );
}

/** 18.9 card entry: the processor's page returns a token; in test mode pick a test card. A card number is never typed into Gutad. */
export function CardField({ value, onChange }: { value: CardToken | null; onChange: (t: CardToken) => void }) {
  const { data } = useApi<{ provider: string }>('/public/payments/provider');
  useEffect(() => { if (!value && data?.provider === 'mock') onChange({ token: TEST_CARDS[0].token, brand: TEST_CARDS[0].brand, last4: TEST_CARDS[0].last4 }); }, [data, value, onChange]);
  if (!data) return null;
  if (data.provider !== 'mock') return <HostedCard value={value} onChange={onChange} />;
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={{ fontSize: 12, color: '#6b655f', marginBottom: 4 }}>Card (test mode)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TEST_CARDS.map((c) => <Button key={c.token} title={c.label} variant={value?.token === c.token ? 'primary' : 'secondary'} onPress={() => onChange({ token: c.token, brand: c.brand, last4: c.last4 })} />)}</View>
    </View>
  );
}
