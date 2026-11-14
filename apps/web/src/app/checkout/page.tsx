'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GutadApiError, type Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/lib/api';
import { cartSubtotal, useCart } from '@/lib/cart';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Select, Textarea } from '@/components/ui';
import { CardField, type CardToken } from '@/components/card-field';

type Fulfillment = 'PICKUP' | 'DELIVERY' | 'DINE_IN';

export default function CheckoutPage() {
  const { cart, parked, setQty, clear, switchTo, discardParked, subtotal } = useCart();
  const { user, ready } = useSession();
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<Fulfillment>('PICKUP');
  const [schedule, setSchedule] = useState<{ date: string; time: string } | null>(null);
  const [tip, setTip] = useState(15);
  const [promo, setPromo] = useState('');
  const [address, setAddress] = useState({ line1: '', city: '', region: '', postalCode: '', instructions: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const [savedCardId, setSavedCardId] = useState<string>('');
  const [saveCard, setSaveCard] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [blocked, setBlocked] = useState<{ code: string; message: string; nextOpenAt?: string } | null>(null);
  const [useCredits, setUseCredits] = useState(0);
  const [utensils, setUtensils] = useState(false);
  const [table, setTable] = useState(() => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('table') || '' : ''));
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const { data: loc } = useApi<{ id: string; name: string; acceptsDelivery: boolean; acceptsPickup: boolean; acceptsDineIn?: boolean; pickupTimes: { date: string; slots: string[] }[]; timezone: string }>(cart.locationId ? `/public/locations/${cart.locationId}` : null);
  const { data: credits } = useApi<{ availableCents: number }>(user ? '/me/credits' : null);
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null);
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedCardId) setSavedCardId(d.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cards]);
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
        if (!cancelled) { setQuote(q); setBlocked(null); }
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          const body = e instanceof GutadApiError ? (e.body as unknown as { code?: string; nextOpenAt?: string } | null) : null;
          if (body?.code) { setBlocked({ code: body.code, message: (e as Error).message, nextOpenAt: body.nextOpenAt }); setError(null); }
          else { setBlocked(null); setError((e as Error).message); }
        }
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
      if (!(user && savedCardId && savedCardId !== 'new') && !card) throw new Error('Choose a card');
      const useSaved = !!user && !!savedCardId && savedCardId !== 'new';
      if (user && saveCard && !useSaved && card) await api.post('/me/payment-methods', { paymentMethodId: card.token, last4: card.last4, brand: card.brand }).catch(() => undefined);
      const order = await api.post<{ id: string }>('/orders', { quoteId: quote.id, utensils, tableNumber: fulfillment === 'DINE_IN' ? table || undefined : undefined, ...(useSaved ? { savedPaymentMethodId: savedCardId } : { paymentMethodId: card!.token }), guest: user ? undefined : guest }, idem.current);
      setDeclined(false);
      clear();
      router.push(`/orders/${order.id}${user ? '' : `?email=${encodeURIComponent(guest.email)}`}`);
    } catch (e) {
      setError((e as Error).message);
      const code = e instanceof GutadApiError ? (e.body as unknown as { code?: string } | null)?.code : undefined;
      // A declined card keeps the same quote; a fresh idempotency key lets the next card be tried.
      if (code === 'PAYMENT_DECLINED') { setDeclined(true); idem.current = newIdempotencyKey(); }
      if ((e as Error).message.includes('expired')) idem.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  if (!cart.lines.length) return <div className="py-16 text-center text-ink-500">Your cart is empty. <Link href="/search" className="text-brand-600 underline">Find a restaurant</Link>.</div>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {parked.length > 0 && (
          <Card title="Your other saved orders">
            <p className="text-xs text-ink-500">These are separate orders. After you place this one, the next starts automatically.</p>
            <ul className="mt-1 divide-y divide-ink-100 text-sm">{parked.map((p) => <li key={p.locationId} className="flex items-center justify-between py-1.5"><span>{p.locationName} · {p.lines.reduce((a, l) => a + l.quantity, 0)} items · {money(cartSubtotal(p))}</span><span className="flex gap-2"><button className="text-xs underline" onClick={() => switchTo(p.locationId!)}>Check out this one first</button><button className="text-xs text-red-600" onClick={() => discardParked(p.locationId!)}>Remove</button></span></li>)}</ul>
          </Card>
        )}
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
            {(cart.channel === 'QR' || !!table) && loc?.acceptsDineIn !== false && <Button variant={fulfillment === 'DINE_IN' ? 'primary' : 'secondary'} onClick={() => setFulfillment('DINE_IN')}>Dine in</Button>}
          </div>
          {fulfillment === 'DINE_IN' && <Input className="mt-3 w-40" label="Table number" value={table} onChange={(e) => setTable(e.target.value)} />}
          {fulfillment !== 'DINE_IN' && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={utensils} onChange={(e) => setUtensils(e.target.checked)} /> Include utensils and napkins</label>}
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
          {user && !!cards?.length && (
            <Select className="mt-2" label="Pay with" value={savedCardId} onChange={(e) => { setSavedCardId(e.target.value); setDeclined(false); }}>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.brand} •••• {c.last4}{c.isDefault ? ' (default)' : ''}</option>)}
              <option value="new">A different card</option>
            </Select>
          )}
          {(!user || !cards?.length || savedCardId === 'new') && <CardField value={card} onChange={(t) => { setCard(t); setDeclined(false); }} />}
          {user && (!cards?.length || savedCardId === 'new') && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} /> Save this card for next time</label>}
          {declined && <div className="mt-2"><Alert>That card was declined. Your order is still held at the same price; choose another card and try again.</Alert></div>}
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
              {quote.serviceFeeCents > 0 && <Row l="Service fee (delivery)" v={money(quote.serviceFeeCents)} />}
              {fulfillment === 'DELIVERY' && <Row l="Delivery" v={quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Free'} />}
              <Row l="Tip" v={money(quote.tipCents)} />
              {(quote as Quote & { creditsCents?: number }).creditsCents ? <Row l="Credits" v={`−${money((quote as Quote & { creditsCents: number }).creditsCents)}`} /> : null}
              <div className="flex justify-between border-t border-ink-100 pt-2 text-base font-semibold"><span>Total</span><span>{money(quote.totalCents)}</span></div>
              <p className="pt-1 text-xs text-ink-500">{quote.promiseAt ? `Estimated ${fulfillment === 'DELIVERY' ? 'delivery' : 'ready'}: ${when(quote.promiseAt)}` : ''}</p>
              {fulfillment === 'DELIVERY' && quote.serviceFeeCents > 0 && <p className="text-xs text-ink-500">Delivery is free. Delivery orders carry a service fee, waived for Gutad+ members. Pickup has no service fee.</p>}
              {quote.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
              <Button className="mt-3 w-full" size="lg" disabled={busy} onClick={place}>{busy ? 'Placing…' : `Place order · ${money(quote.totalCents)}`}</Button>
              <p className="text-[11px] text-ink-300">Quote valid until {when(quote.expiresAt)}; prices revalidate automatically.</p>
            </div>
          ) : blocked ? (
            <div className="space-y-2 text-sm"><Alert tone="info">{BLOCKED_TEXT[blocked.code] || blocked.message}{blocked.nextOpenAt ? ` Opens ${when(blocked.nextOpenAt)}.` : ''}</Alert>{['CLOSED', 'PAUSED', 'SCHEDULE_TOO_SOON', 'SLOT_FULL', 'KITCHEN_BUSY'].includes(blocked.code) && <p className="text-xs text-ink-500">Choose “Schedule for later” to pick another time.</p>}{blocked.code === 'ACCOUNT_RESTRICTED' && <Link className="text-xs underline" href="/account">See account notice</Link>}</div>
          ) : (
            <p className="text-sm text-ink-500">{fulfillment === 'DELIVERY' && !address.lat ? 'Verify your address to get a delivery quote.' : 'Calculating…'}</p>
          )}
        </Card>
      </aside>
    </div>
  );
}

const BLOCKED_TEXT: Record<string, string> = {
  PAUSED: 'This restaurant has paused new orders for a moment.',
  CLOSED: 'This restaurant is closed right now.',
  SCHEDULE_TOO_SOON: 'That time is too soon for this restaurant to prepare your order.',
  SLOT_FULL: 'That time slot is full.',
  DELIVERY_UNAVAILABLE: 'Delivery is not available to this address right now. Pickup may still be possible.',
  ITEM_UNAVAILABLE: 'Something in your cart is no longer available. Remove it to continue.',
  SEPARATE_ORDER_REQUIRED: 'Items from different places need separate orders.',
  ACCOUNT_RESTRICTED: 'Ordering is paused on your account.',
  KITCHEN_BUSY: 'The kitchen is at capacity right now. Schedule for a little later and it will be ready on time.',
};

function Row({ l, v }: { l: string; v: string }) {
  return <div className="flex justify-between"><span className="text-ink-500">{l}</span><span>{v}</span></div>;
}
