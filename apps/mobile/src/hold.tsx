import { useState } from 'react';
import { Text, View } from 'react-native';
import { api, money, when } from './api';
import { Button, C, ErrorText, Input, Muted } from './ui';

/**
 * A HELD reservation needs a card guarantee before holdExpiresAt or it expires.
 * Shown on the booking confirmation and on the Tables tab (POST /reservations/:id/confirm).
 */
export function ConfirmHold({ reservation, onConfirmed }: { reservation: { id: string; holdExpiresAt?: string | null; policy?: { noShowFeeCents: number } | null }; onConfirmed: (r: Record<string, unknown>) => void }) {
  const [card, setCard] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = !!reservation.holdExpiresAt && new Date(reservation.holdExpiresAt).getTime() < Date.now();
  if (expired) return <Text style={{ color: C.bad, marginTop: 6 }}>This hold has expired. Please book again.</Text>;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      // Same mock payment-method convention as checkout until the Stripe card sheet lands.
      const r = await api.post<Record<string, unknown>>(`/reservations/${reservation.id}/confirm`, { paymentMethodId: `mock_pm_${card.replace(/\D/g, '').slice(-4)}` });
      onConfirmed(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: C.warn, marginBottom: 6 }}>
        Add a card to confirm{reservation.holdExpiresAt ? ` by ${when(reservation.holdExpiresAt)}` : ''}. Your card is only charged for a no-show{reservation.policy?.noShowFeeCents ? ` (${money(reservation.policy.noShowFeeCents)}/guest)` : ''}.
      </Text>
      <Input label="Card number" keyboardType="number-pad" value={card} onChangeText={setCard} placeholder="4242 4242 4242 4242" />
      <ErrorText msg={error} />
      <Button title={busy ? 'Confirming…' : 'Confirm with card'} disabled={busy || card.replace(/\D/g, '').length < 12} onPress={confirm} />
      <Muted>The table is held for you until then.</Muted>
    </View>
  );
}
