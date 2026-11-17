'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GutadApiError, type ChefAvailability, type Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey } from '@/lib/api';
import { cartSubtotal, useCart, type Cart } from '@/lib/cart';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Select } from '@/components/ui';
import { CardField, type CardToken } from '@/components/card-field';
import { SmsNotice } from '@/components/legal';
import { DateSlotPicker, orderByLabel, type DateSlot } from '@/components/date-slot-picker';

type Fulfillment = 'PICKUP' | 'DELIVERY';
interface Loc { id: string; name: string; chefKitchen?: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; timezone: string }
type ChefQuote = Quote & { smallOrderFeeCents?: number; chefTerms?: { chargedNow: boolean; freeCancelUntil: string | null; lateRefundPct: number } | null };
interface GroupResult { id: string; totalCents: number; deliveries: number; orders: { id: string; number: string }[] }
const CAPACITY = ['DISH_CAPACITY_FULL', 'KITCHEN_CAPACITY_FULL', 'CHEF_CUTOFF_PASSED', 'CHEF_PAUSED', 'CHEF_NOT_COOKING', 'CHEF_TIME_UNAVAILABLE'];
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string; quoteId?: string } | null) : null);

/**
 * Gutad Chef Network: check out several chefs at once. Each chef cooks on its own day and time and becomes its own
 * order and delivery; the customer pays once. A chef who declines (or a cancellation before that day's cutoff) is
 * refunded on its own, without touching the other orders.
 */
export default function ChefsCheckoutPage() {
  const { cart, parked, setCartQty, removeCarts } = useCart();
  const { user, ready } = useSession();
  const router = useRouter();
  const all = useMemo(() => [cart, ...parked].filter((c) => c.locationId && c.lines.length), [cart, parked]);
  const [locs, setLocs] = useState<Record<string, Loc>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(all.map((c) => (locs[c.locationId!] ? Promise.resolve(locs[c.locationId!]) : api.get<Loc>(`/public/locations/${c.locationId}`).catch(() => null)))).then((rows) => { if (!cancelled) setLocs((m) => { const n = { ...m }; rows.forEach((r) => { if (r) n[r.id] = r; }); return n; }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.map((c) => c.locationId).join(',')]);
  const chefCarts = all.filter((c) => locs[c.locationId!]?.chefKitchen);
  const others = all.filter((c) => locs[c.locationId!] && !locs[c.locationId!].chefKitchen);

  const [fulfillment, setFulfillment] = useState<Fulfillment>('PICKUP');
  const [address, setAddress] = useState({ line1: '', city: '', region: '', postalCode: '', instructions: '', lat: 0, lng: 0 });
  const [tip, setTip] = useState(15);
  const [quotes, setQuotes] = useState<Record<string, ChefQuote | null>>({});
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const [savedCardId, setSavedCardId] = useState('');
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null);
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedCardId) setSavedCardId(d.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cards]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState<Record<string, number>>({});
  const idem = useRef(newIdempotencyKey());
  const onQuote = useCallback((locationId: string, q: ChefQuote | null) => setQuotes((m) => (m[locationId] === q ? m : { ...m, [locationId]: q })), []);
  const ids = chefCarts.map((c) => c.locationId!);
  const ready4pay = ids.length > 0 && ids.every((id) => quotes[id]);
  const total = ids.reduce((a, id) => a + (quotes[id]?.totalCents || 0), 0);
  const useSaved = !!user && !!savedCardId && savedCardId !== 'new';

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!user && (!guest.name || !guest.email)) throw new Error('Name and email are required for guest checkout');
      if (total > 0 && !useSaved && !card) throw new Error('Choose a card');
      const g = await api.post<GroupResult>('/checkout-groups', { quoteIds: ids.map((id) => quotes[id]!.id), ...(total === 0 ? {} : useSaved ? { savedPaymentMethodId: savedCardId } : { paymentMethodId: card!.token }), guest: user ? undefined : guest }, idem.current);
      removeCarts(ids);
      router.push(`/orders/group/${g.id}${user ? '' : `?email=${encodeURIComponent(guest.email)}`}`);
    } catch (e) {
      const b = codeOf(e);
      setError((e as Error).message);
      idem.current = newIdempotencyKey();
      // a date filled up or a quote lapsed: re-quote (and refresh that chef's calendar)
      if (b?.code && (CAPACITY.includes(b.code) || b.code === 'QUOTE_EXPIRED')) setRefresh((r) => Object.fromEntries(ids.map((id) => [id, (r[id] || 0) + 1])));
    } finally { setBusy(false); }
  };

  if (!ready) return null;
  if (!chefCarts.length) return <div className="py-16 text-center text-ink-500">No chef orders in your cart. <Link href="/chefs" className="text-brand-600 underline">Find a chef</Link>.</div>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Checkout · {chefCarts.length} chef{chefCarts.length === 1 ? '' : 's'}</h1>
          <p className="text-sm text-ink-500">{chefCarts.length} separate deliveries, cooked to order, one payment. Each chef has its own day and time.</p>
        </div>
        {others.length > 0 && <Alert tone="info">{others.map((o) => o.locationName).join(', ')} {others.length === 1 ? 'is' : 'are'} checked out separately. <Link className="underline" href="/checkout">Go to checkout</Link></Alert>}
        <Card title="How you’ll get it">
          <div className="flex gap-2"><Button variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onClick={() => setFulfillment('PICKUP')}>Pickup</Button><Button variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} disabled={chefCarts.some((c) => !locs[c.locationId!]?.acceptsDelivery)} onClick={() => setFulfillment('DELIVERY')}>Delivery</Button></div>
          {fulfillment === 'DELIVERY' && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Input label="Street address" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value, lat: 0, lng: 0 })} className="sm:col-span-2" />
              <Input label="City" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
              <div className="grid grid-cols-2 gap-2"><Input label="State" value={address.region} onChange={(e) => setAddress({ ...address, region: e.target.value })} /><Input label="ZIP" value={address.postalCode} onChange={(e) => setAddress({ ...address, postalCode: e.target.value })} /></div>
              {!address.lat ? <Button variant="secondary" onClick={() => setAddress((a) => ({ ...a, lat: 40.7346, lng: -73.9975 }))}>Verify address</Button> : <p className="text-xs text-emerald-700">Address verified ✓</p>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><span className="text-ink-500">Tip each chef</span>{[0, 10, 15, 20].map((p) => <Button key={p} size="sm" variant={tip === p ? 'primary' : 'secondary'} onClick={() => setTip(p)}>{p ? `${p}%` : 'None'}</Button>)}</div>
        </Card>
        {chefCarts.map((c, i) => <ChefGroup key={c.locationId} n={i + 1} cart={c} loc={locs[c.locationId!]} fulfillment={fulfillment} address={address} tipPct={tip} nonce={refresh[c.locationId!] || 0} onQuote={onQuote} setQty={setCartQty} />)}
      </div>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card title="Pay once">
          <ul className="space-y-1 text-sm">{chefCarts.map((c) => <li key={c.locationId} className="flex justify-between"><span className="truncate pr-2">{c.locationName}</span><span>{quotes[c.locationId!] ? money(quotes[c.locationId!]!.totalCents) : '—'}</span></li>)}</ul>
          <div className="mt-2 flex justify-between border-t border-ink-100 pt-2 text-base font-semibold"><span>{chefCarts.length} deliveries</span><span>{ready4pay ? money(total) : '—'}</span></div>
          <div className="mt-4 space-y-2">
            {!user && (<><Input label="Name" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} /><Input label="Email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} /><Input label="Phone" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} /><SmsNotice /></>)}
            {user && !!cards?.length && <Select label="Pay with" value={savedCardId} onChange={(e) => setSavedCardId(e.target.value)}>{cards.map((c) => <option key={c.id} value={c.id}>{c.brand} •••• {c.last4}</option>)}<option value="new">A different card</option></Select>}
            {(!user || !cards?.length || savedCardId === 'new') && <CardField value={card} onChange={setCard} />}
          </div>
          {error && <div className="mt-3"><Alert>{error}</Alert></div>}
          <Button className="mt-4 w-full" size="lg" disabled={!ready4pay || busy} onClick={pay}>{busy ? 'Paying…' : ready4pay ? `Pay ${money(total)}` : 'Choose a day and time for each chef'}</Button>
          <p className="mt-2 text-xs text-ink-500">Charged now, sold by Gutad. If a chef declines or doesn’t confirm in time, that chef’s order is refunded in full automatically. Each order can be cancelled for a full refund until its order cutoff.</p>
        </Card>
      </aside>
    </div>
  );
}

/** One chef in the multi-chef checkout: its lines, its calendar, its quote (with its own capacity hold). */
function ChefGroup({ n, cart, loc, fulfillment, address, tipPct, nonce, onQuote, setQty }: { n: number; cart: Cart; loc?: Loc; fulfillment: Fulfillment; address: { line1: string; city: string; region: string; postalCode: string; instructions: string; lat: number; lng: number }; tipPct: number; nonce: number; onQuote: (locationId: string, q: ChefQuote | null) => void; setQty: (locationId: string, key: string, q: number) => void }) {
  const locationId = cart.locationId!;
  const holdKey = useRef(newIdempotencyKey());
  const [avail, setAvail] = useState<ChefAvailability | null>(null);
  const [slot, setSlot] = useState<DateSlot | null>(null);
  const [quote, setQuote] = useState<ChefQuote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lineKey = cart.lines.map((l) => `${l.menuItemId}:${l.quantity}`).join(',');
  useEffect(() => {
    let cancelled = false;
    api.post<ChefAvailability>(`/public/chef-kitchens/${locationId}/availability`, { lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })), holdKey: holdKey.current })
      .then((a) => { if (cancelled) return; setAvail(a); setSlot((cur) => { const day = cur && a.days.find((d) => d.date === cur.date && d.status === 'AVAILABLE'); if (day) return day.slots.includes(cur!.time) ? cur : { date: cur!.date, time: '' }; const quoted = cart.lines.find((l) => l.serviceDate)?.serviceDate; const want = quoted && a.days.some((d) => d.date === quoted && d.status === 'AVAILABLE') ? quoted : a.earliestDate; return want ? { date: want, time: '' } : null; }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, lineKey, nonce]);
  useEffect(() => {
    let cancelled = false;
    setQuote(null);
    onQuote(locationId, null);
    if (!slot?.time || (fulfillment === 'DELIVERY' && !address.lat)) return;
    const t = setTimeout(async () => {
      try {
        const iso = (await api.get<{ iso: string }>(`/public/locations/${locationId}/local-time?date=${slot.date}&time=${slot.time}`)).iso;
        const q = await api.post<ChefQuote>('/quotes', { locationId, channel: cart.channel, fulfillmentType: fulfillment, scheduledFor: iso, holdKey: holdKey.current, tipCents: Math.round((cartSubtotal(cart) * tipPct) / 100), lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions, chefRequestQuoteId: l.chefRequestQuoteId })), deliveryAddress: fulfillment === 'DELIVERY' ? { ...address, lat: address.lat || undefined, lng: address.lng || undefined } : undefined });
        if (!cancelled) { setQuote(q); setProblem(null); onQuote(locationId, q); }
      } catch (e) { if (!cancelled) setProblem((e as Error).message); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, lineKey, slot?.date, slot?.time, fulfillment, address.lat, tipPct, nonce]);
  return (
    <Card title={<span>{n}. {cart.locationName}</span>}>
      <ul className="divide-y divide-ink-100 text-sm">
        {cart.lines.map((l) => (
          <li key={l.key} className="flex items-center justify-between py-2">
            <div className="min-w-0"><div className="font-medium">{l.name}</div>{l.modifierNames.length > 0 && <div className="text-xs text-ink-500">{l.modifierNames.join(', ')}</div>}</div>
            <div className="flex items-center gap-2">{l.chefRequestQuoteId ? <span className="text-xs text-ink-500">Quoted × {l.quantity}</span> : <><Button size="sm" variant="secondary" onClick={() => setQty(locationId, l.key, l.quantity - 1)} aria-label={`One less ${l.name}`}>−</Button><span>{l.quantity}</span><Button size="sm" variant="secondary" onClick={() => setQty(locationId, l.key, l.quantity + 1)} aria-label={`One more ${l.name}`}>+</Button></>}</div>
          </li>
        ))}
      </ul>
      <div className="mt-4"><DateSlotPicker availability={avail} value={slot} onChange={setSlot} title={fulfillment === 'DELIVERY' ? 'Delivery day and time' : 'Pickup day and time'} /></div>
      {(() => { const q = cart.lines.find((l) => l.serviceDate)?.serviceDate; return q && slot?.date && slot.date !== q ? <p className="mt-2 text-sm text-amber-700">Your special request is quoted for {new Date(`${q}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}. Choose that day.</p> : null; })()}
      {fulfillment === 'DELIVERY' && loc && !loc.acceptsDelivery && <p className="mt-2 text-sm text-amber-700">This chef offers pickup only.</p>}
      {problem && <div className="mt-3"><Alert>{problem}</Alert></div>}
      {quote && (
        <div className="mt-3 space-y-0.5 border-t border-ink-100 pt-3 text-sm">
          <div className="flex justify-between"><span className="text-ink-500">Food</span><span>{money(quote.subtotalCents)}</span></div>
          {quote.serviceFeeCents > 0 && <div className="flex justify-between"><span className="text-ink-500">Service fee</span><span>{money(quote.serviceFeeCents)}</span></div>}
          {(quote.smallOrderFeeCents || 0) > 0 && <div className="flex justify-between"><span className="text-ink-500">Small-order fee</span><span>{money(quote.smallOrderFeeCents || 0)}</span></div>}
          {fulfillment === 'DELIVERY' && <div className="flex justify-between"><span className="text-ink-500">Delivery</span><span>{quote.deliveryFeeCents ? money(quote.deliveryFeeCents) : 'Free'}</span></div>}
          <div className="flex justify-between"><span className="text-ink-500">Tax</span><span>{money(quote.taxCents)}</span></div>
          {quote.tipCents > 0 && <div className="flex justify-between"><span className="text-ink-500">Tip</span><span>{money(quote.tipCents)}</span></div>}
          <div className="flex justify-between font-semibold"><span>This delivery</span><span>{money(quote.totalCents)}</span></div>
          {quote.chefTerms?.freeCancelUntil && loc && <p className="pt-1 text-xs text-ink-500">Full refund if you cancel before {orderByLabel(quote.chefTerms.freeCancelUntil, loc.timezone)}{quote.chefTerms.lateRefundPct ? `; ${quote.chefTerms.lateRefundPct}% after that` : '; no refund after that'}.</p>}
          {quote.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
        </div>
      )}
    </Card>
  );
}
