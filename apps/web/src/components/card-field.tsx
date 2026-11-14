'use client';
import { useEffect, useRef, useState } from 'react';
import { TEST_CARDS } from '@gutad/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Button, Select } from '@/components/ui';

export interface CardToken { token: string; brand: string; last4: string }

/* Minimal typing of the parts of Stripe.js we use (loaded from js.stripe.com; no npm dependency). */
interface StripeCardElement { mount(el: HTMLElement): void; destroy(): void; on(ev: 'change', cb: (e: { complete: boolean; error?: { message: string } }) => void): void }
interface StripeJs {
  elements(): { create(type: 'card', opts?: Record<string, unknown>): StripeCardElement };
  createPaymentMethod(o: { type: 'card'; card: StripeCardElement }): Promise<{ paymentMethod?: { id: string; card?: { brand: string; last4: string } }; error?: { message: string } }>;
  confirmCardSetup(secret: string, o: { payment_method: string }): Promise<{ setupIntent?: { payment_method: string | { id: string } | null }; error?: { message: string } }>;
}
declare global { interface Window { Stripe?: (key: string) => StripeJs } }

let stripeJs: Promise<StripeJs> | null = null;
/** Loads Stripe.js once, from Stripe's own CDN (PCI: the card field must come from the processor). */
function loadStripe(key: string): Promise<StripeJs> {
  if (stripeJs) return stripeJs;
  stripeJs = new Promise<StripeJs>((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe(key));
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3';
    s.async = true;
    s.onload = () => (window.Stripe ? resolve(window.Stripe(key)) : reject(new Error('Payment field failed to load')));
    s.onerror = () => { stripeJs = null; reject(new Error('Payment field failed to load')); };
    document.head.appendChild(s);
  });
  return stripeJs;
}

/** 18.9-S the processor's own card field (Stripe Elements). `save` attaches the card through a SetupIntent. */
function ProcessorCard({ publishableKey, purpose, value, onChange }: { publishableKey: string; purpose: 'pay' | 'save'; value: CardToken | null; onChange: (t: CardToken) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<StripeCardElement | null>(null);
  const stripe = useRef<StripeJs | null>(null);
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadStripe(publishableKey).then((s) => {
      if (!alive || !host.current) return;
      stripe.current = s;
      const el = s.elements().create('card', { hidePostalCode: false });
      el.on('change', (e) => { setComplete(e.complete); setError(e.error?.message || null); });
      el.mount(host.current);
      card.current = el;
      setReady(true);
    }).catch((e) => setError((e as Error).message));
    return () => { alive = false; card.current?.destroy(); card.current = null; };
  }, [publishableKey]);
  const use = async () => {
    if (!stripe.current || !card.current) return;
    setBusy(true); setError(null);
    try {
      const pm = await stripe.current.createPaymentMethod({ type: 'card', card: card.current });
      if (pm.error || !pm.paymentMethod) throw new Error(pm.error?.message || 'Card not accepted');
      if (purpose === 'save') {
        const setup = await api.post<{ mode: string; clientSecret?: string | null }>('/me/payment-methods/setup', {});
        if (!setup.clientSecret) throw new Error('Card saving is unavailable right now');
        const r = await stripe.current.confirmCardSetup(setup.clientSecret, { payment_method: pm.paymentMethod.id });
        if (r.error) throw new Error(r.error.message);
      }
      onChange({ token: pm.paymentMethod.id, brand: pm.paymentMethod.card?.brand || 'card', last4: pm.paymentMethod.card?.last4 || '' });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 space-y-2">
      <div ref={host} className="rounded-lg border border-ink-100 bg-white px-3 py-3" />
      {error && <Alert>{error}</Alert>}
      {value ? <p className="text-sm text-emerald-700"><span className="capitalize">{value.brand}</span> •••• {value.last4} ready. <button type="button" className="underline" onClick={use} disabled={!complete || busy}>Use the card above instead</button></p> : <Button type="button" size="sm" variant="secondary" disabled={!ready || !complete || busy} onClick={use}>{busy ? 'Checking card…' : 'Use this card'}</Button>}
      <p className="text-xs text-ink-500">Card details go straight to our payment processor and never reach Gutad.</p>
    </div>
  );
}

/** 10.3-P without a publishable key: save the card on the processor's hosted page, then come back here. */
function HostedSetup({ onChange }: { onChange: (t: CardToken) => void }) {
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const sp = new URLSearchParams(window.location.search);
    const sessionId = sp.get('session_id');
    if (sp.get('card_setup') === 'done' && sessionId) api.post<CardToken>('/me/payment-methods/setup/complete', { sessionId }).then(onChange).catch((e) => setError((e as Error).message));
  }, [onChange]);
  return (
    <div className="mt-2 space-y-2">
      {error && <Alert>{error}</Alert>}
      <Button type="button" size="sm" variant="secondary" onClick={() => api.post<{ url?: string }>('/me/payment-methods/setup', { hosted: true }).then((r) => { if (r.url) window.location.href = r.url; }).catch((e) => setError((e as Error).message))}>Add a card on the secure processor page</Button>
    </div>
  );
}

/**
 * 18.9 card entry: Gutad never sees or stores a card number. With the live processor its hosted field (Stripe
 * Elements) returns a token; in test mode (mock processor) you pick a test card. Only the token, brand and last 4
 * digits reach Gutad. `purpose="save"` stores the card with the processor (SetupIntent) for later use.
 */
export function CardField({ value, onChange, label = 'Card', purpose = 'pay' }: { value: CardToken | null; onChange: (t: CardToken) => void; label?: string; purpose?: 'pay' | 'save' }) {
  const { data } = useApi<{ provider: string; publishableKey?: string | null }>('/public/payments/provider');
  useEffect(() => { if (!value && data?.provider === 'mock') onChange({ token: TEST_CARDS[0].token, brand: TEST_CARDS[0].brand, last4: TEST_CARDS[0].last4 }); }, [data, value, onChange]);
  if (!data) return null;
  if (data.provider !== 'mock') {
    if (data.provider === 'stripe' && data.publishableKey) return <ProcessorCard publishableKey={data.publishableKey} purpose={purpose} value={value} onChange={onChange} />;
    if (purpose === 'save') return <HostedSetup onChange={onChange} />;
    return <p className="mt-2 rounded-lg bg-ink-50 p-2 text-sm text-ink-700">Save a card under Account → Payments to pay with it here. Card details are entered on the payment processor’s secure page and never sent to Gutad.</p>;
  }
  return (
    <div className="mt-2">
      <Select label={`${label} (test mode)`} value={value?.token || ''} onChange={(e) => { const c = TEST_CARDS.find((x) => x.token === e.target.value)!; onChange({ token: c.token, brand: c.brand, last4: c.last4 }); }}>
        {TEST_CARDS.map((c) => <option key={c.token} value={c.token}>{c.label}</option>)}
      </Select>
      <p className="mt-1 text-xs text-ink-500">Test mode: real card numbers are never typed into Gutad. In production the processor’s secure field tokenizes the card.</p>
    </div>
  );
}
