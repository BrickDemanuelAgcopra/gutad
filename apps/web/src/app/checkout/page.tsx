'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Select, Textarea } from '@/components/ui';

type Fulfillment = 'PICKUP' | 'DELIVERY';

export default function CheckoutPage() {
  const { cart, setQty, clear, subtotal } = useCart();
  const { user, ready } = useSession();
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<Fulfillment>('PICKUP');
  const [schedule, setSchedule] = useState<{ date: string; time: string } | null>(null);
  const [tip, setTip] = useState(15);
  const [promo, setPromo] = useState('');
  const [address, setAddress] = useState({ line1: '', city: '', region: '', postalCode: '', instructions: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState('4242424242424242');
  const [useCredits, setUseCredits] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const { data: loc } = useApi<{ id: string; name: string; acceptsDelivery: boolean; acceptsPickup: boolean; pickupTimes: { date: string; slots: string[] }[]; timezone: string }>(cart.locationId ? `/public/locations/${cart.locationId}` : null);
  const { data: credits } = useApi<{ availableCents: number }>(user ? '/me/credits' : null);
  const { data: me } = useApi<{ addresses: { line1: string; city: string; region: string; postalCode: string; lat: number | null; lng: number | null; isDefault: boolean }[] }>(user ? '/auth/me' : null);

  useEffect(() => {
    const d = me?.addresses?.find((a) => a.isDefault) || me?.addresses?.[0];
    if (d && !address.line1) setAddress({ line1: d.line1, city: d.city, region: d.region, postalCode: d.postalCode, instructions: '', lat: d.lat || 0, lng: d.lng || 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const tipCents = Math.round((subtotal * tip) / 100);

  useEffect(() => {
    if (!cart.locationId || !cart.lines.length) { setQuote(null); return; }
    let cancelled = false;
    const run = async () => {
      setError(null);
      try {
        let scheduledFor: string | null = null;
        if (schedule?.date && schedule.time) scheduledFor = (await api.get<{ iso: string }>(`/public/locations/${cart.locationId}/local-time?date=${schedule.date}&time=${schedule.time}`)).iso;
        const q = await api.post<Quote>('/quotes', { locationId: cart.locationId, channel: cart.channel, fulfillmentType: fulfillment, lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions })), scheduledFor, tipCents, promoCode: promo || undefined, useCreditsCents: useCredits || undefined, deliveryAddress: fulfillment === 'DELIVERY' ? { ...address, lat: address.lat || undefined, lng: address.lng || undefined } : undefined });
        if (!cancelled) setQuote(q);
      } catch (e) {
        if (!cancelled) { setQuote(null); setError((e as Error).message); }
      }
    };
    const t = setTimeout(run, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, fulfillment, schedule, tipCents, promo, address.lat, address.lng, address.line1, useCredits, ready]);

  const geocode = async () => {
    // Pilot geocoder: a demo pin in lower Manhattan. Replace with Google/Mapbox when GEOCODER_PROVIDER=google.
    setAddress((a) => ({ ...a, lat: 40.7346, lng: -73.9975 }));
  };

  const place = async () => {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      if (!user) {
        if (!guest.email || !guest.name) throw new Error('Name and email are required for guest checkout');
      }
      const order = await api.post<{ id: string }>('/orders', { quoteId: quote.id, paymentMethodId: `mock_pm_${card.replace(/\s/g, '').slice(-4)}`, guest: user ? undefined : guest }, idem.current);
      clear();
      router.push(`/orders/${order.id}${user ? '' : `?email=${encodeURIComponent(guest.email)}`}`);
    } catch (e) {
      setError((e as Error).message);
      if ((e as Error).message.includes('expired')) idem.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  if (!cart.lines.length) return <div className="py-16 text-center text-ink-500">Your cart is empty. <Link href="/search" className="text-brand-600 underline">Find a restaurant</Link>.</div>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card title={`Order from ${cart.locationName}`}>
          <ul className="divide-y divide-ink-100 text-sm">
            {cart.lines.map((l) => (
              <li key={l.key} className="flex items-center justify-between py-2">
                <div><div className="font-medium">{l.name}</div>{l.modifierNames.length > 0 && <div className="text-xs text-ink-500">{l.modifierNames.join(', ')}</div>}{l.specialInstructions && <div className="text-xs italic text-ink-500">“{l.specialInstructions}”</div>}</div>
                <div className="flex items-center gap-2"><Button size="sm" variant="secondary" onClick={() => setQty(l.key, l.quantity - 1)}>−</Button><span>{l.quantity}</span><Button size="sm" variant="secondary" onClick={() => setQty(l.key, l.quantity + 1)}>+</Button><span className="w-16 text-right">{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</span></div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Fulfillment">
          <div className="flex gap-2">
            {loc?.acceptsPickup !== false && <Button variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onClick={() => setFulfillment('PICKUP')}>Pickup</Button>}
            {loc?.acceptsDelivery && <Button variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} onClick={() => setFulfillment('DELIVERY')}>Delivery</Button>}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Select label="When" value={schedule ? 'later' : 'now'} onChange={(e) => setSchedule(e.target.value === 'now' ? null : { date: loc?.pickupTimes?.[0]?.date || '', time: '' })}><option value="now">As soon as possible</option><option value="later">Schedule for later</option></Select>
            {schedule && <Select label="Day" value={schedule.date} onChange={(e) => setSchedule({ date: e.target.value, time: '' })}>{loc?.pickupTimes?.map((d) => <option key={d.date} value={d.date}>{d.date}</option>)}</Select>}
            {schedule && <Select label="Time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })}><option value="">Pick a time</option>{loc?.pickupTimes?.find((d) => d.date === schedule.date)?.slots.map((s) => <option key={s} value={s}>{s}</option>)}</Select>}
          </div>
          {fulfillment === 'DELIVERY' && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Input label="Street address" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value, lat: 0, lng: 0 })} className="sm:col-span-2" />
              <Input label="City" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
              <div className="grid grid-cols-2 gap-2"><Input label="State" value={address.region} onChange={(e) => setAddress({ ...address, region: e.target.value })} /><Input label="ZIP" value={address.postalCode} onChange={(e) => setAddress({ ...address, postalCode: e.target.value })} /></div>
              <Input label="Delivery instructions" value={address.instructions} onChange={(e) => setAddress({ ...address, instructions: e.target.value })} className="sm:col-span-2" />
              {!address.lat && <Button variant="secondary" onClick={geocode}>Verify address</Button>}
              {!!address.lat && <p className="text-xs text-emerald-700">Address verified ✓</p>}
            </div>
          )}
        </Card>
        <Card title="Tip & promo">
          <div className="flex flex-wrap gap-2">{[0, 10, 15, 20, 25].map((p) => <Button key={p} size="sm" variant={tip === p ? 'primary' : 'secondary'} onClick={() => setTip(p)}>{p === 0 ? 'No tip' : `${p}%`}</Button>)}</div>
          <div className="mt-3 flex gap-2"><Input placeholder="Promo code" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} /></div>
          {!!credits?.availableCents && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={useCredits > 0} onChange={(e) => setUseCredits(e.target.checked ? credits.availableCents : 0)} /> Apply {money(credits.availableCents)} in credits</label>}
        </Card>
        <Card title={user ? `Paying as ${user.email}` : 'Your details'}>
          {!user && (
            <div className="grid gap-2 sm:grid-cols-3">
              <Input label="Name" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} />
              <Input label="Email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
              <Input label="Phone" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
              <p className="text-xs text-ink-500 sm:col-span-3">Checking out as a guest. <Link href="/account" className="underline">Sign in</Link> to save addresses and earn points.</p>
            </div>
          )}
          <Input className="mt-2" label="Card number" value={card} onChange={(e) => setCard(e.target.value)} />
          <p className="mt-1 text-xs text-ink-300">Card is authorized now and captured only when the restaurant accepts. Test mode: numbers ending in 0002 are declined.</p>
        </Card>
      </div>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card title="Summary">
          {error && <div className="mb-2"><Alert>{error}</Alert></div>}
          {quote ? (
            <div className="space-y-1 text-sm">
              <Row l="Subtotal" v={money(quote.subtotalCents)} />
              {quote.discountCents > 0 && <Row l="Promo" v={`−${money(quote.discountCents)}`} />}
              <Row l="Tax" v={money(quote.taxCents)} />
              {quote.serviceFeeCents > 0 && <Row l="Service fee" v={money(quote.serviceFeeCents)} />}
              {fulfillment === 'DELIVERY' && <Row l="Delivery" v={quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Free'} />}
              <Row l="Tip" v={money(quote.tipCents)} />
              {(quote as Quote & { creditsCents?: number }).creditsCents ? <Row l="Credits" v={`−${money((quote as Quote & { creditsCents: number }).creditsCents)}`} /> : null}
              <div className="flex justify-between border-t border-ink-100 pt-2 text-base font-semibold"><span>Total</span><span>{money(quote.totalCents)}</span></div>
              <p className="pt-1 text-xs text-ink-500">{quote.promiseAt ? `Estimated ${fulfillment === 'DELIVERY' ? 'delivery' : 'ready'}: ${when(quote.promiseAt)}` : ''}</p>
              {quote.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
              <Button className="mt-3 w-full" size="lg" disabled={busy} onClick={place}>{busy ? 'Placing…' : `Place order · ${money(quote.totalCents)}`}</Button>
              <p className="text-[11px] text-ink-300">Quote valid until {when(quote.expiresAt)}; prices revalidate automatically.</p>
            </div>
          ) : (
            <p className="text-sm text-ink-500">{fulfillment === 'DELIVERY' && !address.lat ? 'Verify your address to get a delivery quote.' : 'Calculating…'}</p>
          )}
        </Card>
      </aside>
    </div>
  );
}

function Row({ l, v }: { l: string; v: string }) {
  return <div className="flex justify-between"><span className="text-ink-500">{l}</span><span>{v}</span></div>;
}
