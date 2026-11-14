import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { TEST_CARDS } from '@gutad/shared';
import { useApi } from './hooks';
import { Button, Muted } from './ui';

export interface CardToken { token: string; brand: string; last4: string }

/** 18.9 card entry: the processor's sheet returns a token; in test mode pick a test card. A card number is never typed into Gutad. */
export function CardField({ value, onChange }: { value: CardToken | null; onChange: (t: CardToken) => void }) {
  const { data } = useApi<{ provider: string }>('/public/payments/provider');
  useEffect(() => { if (!value && data?.provider === 'mock') onChange({ token: TEST_CARDS[0].token, brand: TEST_CARDS[0].brand, last4: TEST_CARDS[0].last4 }); }, [data, value, onChange]);
  if (!data) return null;
  if (data.provider !== 'mock') return <Muted>Card details are entered in the payment processor’s secure sheet and never sent to Gutad.</Muted>;
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={{ fontSize: 12, color: '#6b655f', marginBottom: 4 }}>Card (test mode)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TEST_CARDS.map((c) => <Button key={c.token} title={c.label} variant={value?.token === c.token ? 'primary' : 'secondary'} onPress={() => onChange({ token: c.token, brand: c.brand, last4: c.last4 })} />)}</View>
    </View>
  );
}
