'use client';
import { useEffect } from 'react';
import { TEST_CARDS } from '@gutad/shared';
import { useApi } from '@/lib/hooks';
import { Select } from '@/components/ui';

export interface CardToken { token: string; brand: string; last4: string }

/**
 * 18.9 card entry: Gutad never sees or stores a card number. The processor's hosted field returns a token; in
 * test mode (mock processor) you pick a test card. Only the token, brand and last 4 digits reach Gutad.
 */
export function CardField({ value, onChange, label = 'Card' }: { value: CardToken | null; onChange: (t: CardToken) => void; label?: string }) {
  const { data } = useApi<{ provider: string }>('/public/payments/provider');
  useEffect(() => { if (!value && data?.provider === 'mock') onChange({ token: TEST_CARDS[0].token, brand: TEST_CARDS[0].brand, last4: TEST_CARDS[0].last4 }); }, [data, value, onChange]);
  if (!data) return null;
  if (data.provider !== 'mock') return <p className="mt-2 rounded-lg bg-ink-50 p-2 text-sm text-ink-700">Card details are entered in the payment processor’s secure field. They are never sent to Gutad.</p>;
  return (
    <div className="mt-2">
      <Select label={`${label} (test mode)`} value={value?.token || ''} onChange={(e) => { const c = TEST_CARDS.find((x) => x.token === e.target.value)!; onChange({ token: c.token, brand: c.brand, last4: c.last4 }); }}>
        {TEST_CARDS.map((c) => <option key={c.token} value={c.token}>{c.label}</option>)}
      </Select>
      <p className="mt-1 text-xs text-ink-500">Test mode: real card numbers are never typed into Gutad. In production the processor’s secure field tokenizes the card.</p>
    </div>
  );
}
