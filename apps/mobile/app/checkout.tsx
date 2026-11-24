import { useCallback, useEffect, useRef, useState } from 'react';
import { CardField, type CardToken } from '@/card-field';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { GutadApiError, type ChefAvailability, type Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/api';
import { cartSubtotal, preferredSchedule, useCart } from '@/cart';
import { useApi } from '@/hooks';
import { useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { SmsNotice } from '@/legal';
import { DateSlotPicker, chefTermsText, type ChefTerms } from '@/date-slot-picker';

const BLOCKED: Record<string, string> = { KITCHEN_BUSY: 'The kitchen is at capacity right now. Try again shortly or order for later.', PAUSED: 'This restaurant has paused new orders for a moment.', CLOSED: 'This restaurant is closed right now.', SCHEDULE_TOO_SOON: 'That time is too soon for the kitchen.', SLOT_FULL: 'That time slot is full.', DELIVERY_UNAVAILABLE: 'Delivery is not available to this address right now. Try pickup.', ITEM_UNAVAILABLE: 'Something in your cart is no longer available.', SEPARATE_ORDER_REQUIRED: 'Items from different places need separate orders.', ACCOUNT_RESTRICTED: 'Ordering is paused on your account. See Account for details.', CHEF_QUOTE_QUANTITY: 'The quantity of a chef’s quote can’t change. Remove it and add it again from your request.', CHEF_QUOTE_DATE: 'This quote is for a set day and time. Pick the date the chef quoted.', CHEF_QUOTE_EXPIRED: 'This quote has expired. Ask the chef for a new one from your request.', CHEF_QUOTE_USED: 'This quote was already used for an order.', SCHEDULE_REQUIRED: 'Chef dishes are cooked to order. Pick a cooking day and time.', CHEF_CUTOFF_PASSED: 'Ordering for that day has closed. Pick another date.', CHEF_NOT_COOKING: 'The chef isn’t cooking that day. Pick another date.', CHEF_PAUSED: 'The chef is away that day. Pick another date.', CHEF_TOO_FAR: 'That date isn’t open for orders yet. Pick an earlier date.', CHEF_TIME_UNAVAILABLE: 'That time isn’t available. Pick another time.', DISH_CAPACITY_FULL: 'A dish in your cart just sold out for that day. Pick another date or lower the quantity.', KITCHEN_CAPACITY_FULL: 'The chef is fully booked that day. Pick another date.' };
const CAPACITY = ['DISH_CAPACITY_FULL', 'KITCHEN_CAPACITY_FULL', 'CHEF_CUTOFF_PASSED', 'CHEF_NOT_COOKING', 'CHEF_PAUSED', 'CHEF_TOO_FAR', 'CHEF_TIME_UNAVAILABLE'];
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string; nextOpenAt?: string } | null) : null);

export default function Checkout() {
  const { cart, parked, setQty, clear, switchTo, discardParked, subtotal } = useCart();
  const { user } = useSession();
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [tip, setTip] = useState(15);
  const [promo, setPromo] = useState('');
  const [useGift, setUseGift] = useState(false);
  const [addr, setAddr] = useState({ line1: '', city: '', region: '', postalCode: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const { data: gifts } = useApi<{ balanceCents: number }>(user ? '/me/gift-cards' : null, { deps: [user?.id] });
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null, { deps: [user?.id] });
  const [savedId, setSavedId] = useState<string>('');
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedId) setSavedId(d.id); }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saveCard, setSaveCard] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [utensils, setUtensils] = useState(false);
  const [quote, setQuote] = useState<(Quote & { seller?: { firstParty: boolean; label: string } | null; chefTerms?: ChefTerms | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const tipCents = Math.round((subtotal * tip) / 100);
  // scheduled orders (required for Gutad Chef Network dishes, which need notice)
  const { data: loc } = useApi<{ id: string; chefKitchen?: boolean; timezone?: string; pickupTimes: { date: string; slots: string[] }[] }>(cart.locationId ? `/public/locations/${cart.locationId}` : null, { deps: [cart.locationId] });
  const [schedule, setSchedule] = useState<{ date: string; time: string } | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | undefined>(undefined);
  const days = (loc?.pickupTimes || []).filter((d) => d.slots.length);
  // chef kitchens: cart-wide availability (the quote holds capacity under holdKey for 10 minutes, so our own hold isn't counted)
  const holdKey = useRef(newIdempotencyKey());
  const [avail, setAvail] = useState<ChefAvailability | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const linesKey = cart.lines.map((l) => `${l.menuItemId}:${l.quantity}`).join(',');
  const loadAvail = useCallback(async () => {
    if (!loc?.chefKitchen || !cart.locationId || !cart.lines.length) return;
    setAvailLoading(true);
    const qty = new Map<string, number>();
    cart.lines.forEach((l) => qty.set(l.menuItemId, (qty.get(l.menuItemId) || 0) + l.quantity));
    try { setAvail(await api.post<ChefAvailability>(`/public/chef-kitchens/${cart.locationId}/availability`, { lines: [...qty].map(([menuItemId, quantity]) => ({ menuItemId, quantity })), holdKey: holdKey.current })); } catch { setAvail(null); } finally { setAvailLoading(false); }
  }, [loc?.chefKitchen, cart.locationId, linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAvail(); }, [loadAvail]);
  useEffect(() => {
    if (!loc?.chefKitchen || !avail) return;
    const d = schedule ? avail.days.find((x) => x.date === schedule.date) : undefined;
    // an accepted chef quote fixes the day (and time, when set): preselect it
    const pref = preferredSchedule(cart);
    const pd = pref ? avail.days.find((x) => x.date === pref.date && x.status === 'AVAILABLE') : undefined;
    const first = pd && pref ? { date: pref.date, time: pref.time && pd.slots.includes(pref.time) ? pref.time : '' } : avail.earliestDate ? { date: avail.earliestDate, time: '' } : null;
    if (!d || d.status !== 'AVAILABLE') setSchedule(!schedule ? first : null);
    else if (schedule?.time && !d.slots.includes(schedule.time)) setSchedule({ date: d.date, time: '' });
  }, [avail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!schedule?.time || !cart.locationId) { setScheduledFor(undefined); return; }
    api.get<{ iso: string }>(`/public/locations/${cart.locationId}/local-time?date=${schedule.date}&time=${schedule.time}`).then((r) => setScheduledFor(r.iso)).catch(() => setScheduledFor(undefined));
  }, [schedule, cart.locationId]);
  const needsTime = !!loc?.chefKitchen && !scheduledFor;
  // Phase 5: several chef carts (active + parked) can be paid together in one multi-chef checkout
  const parkedIds = parked.map((p) => p.locationId).filter(Boolean).join(',');
  const [chefParked, setChefParked] = useState(0);
  useEffect(() => {
    if (!loc?.chefKitchen || !parkedIds) { setChefParked(0); return; }
    let live = true;
    Promise.all(parkedIds.split(',').map((lid) => api.get<{ chefKitchen?: boolean }>(`/public/locations/${lid}`).then((l) => !!l.chefKitchen).catch(() => false))).then((r) => { if (live) setChefParked(r.filter(Boolean).length); });
    return () => { live = false; };
  }, [loc?.chefKitchen, parkedIds]);
  useEffect(() => {
    if (!cart.locationId || !cart.lines.length) return;
    if (needsTime || (schedule?.time && !scheduledFor)) { setQuote(null); return; }
    const t = setTimeout(() => {
      api.post<Quote>('/quotes', { locationId: cart.locationId, channel: 'MARKETPLACE', fulfillmentType: fulfillment, scheduledFor, holdKey: loc?.chefKitchen ? holdKey.current : undefined, lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions, chefRequestQuoteId: l.chefRequestQuoteId })), tipCents, promoCode: promo || undefined, useGiftBalance: useGift || undefined, deliveryAddress: fulfillment === 'DELIVERY' ? { ...addr, lat: addr.lat || undefined, lng: addr.lng || undefined } : undefined })
        .then((q) => { setQuote(q); setError(null); })
        .catch((e) => { setQuote(null); const b = codeOf(e); if (b?.code && CAPACITY.includes(b.code)) void loadAvail(); setError(b?.code && BLOCKED[b.code] ? `${BLOCKED[b.code]}${b.nextOpenAt ? ` Opens ${when(b.nextOpenAt)}.` : ''}` : (e as Error).message); });
    }, 350);
    return () => clearTimeout(t);
  }, [cart, fulfillment, tipCents, promo, addr, useGift, scheduledFor, needsTime]); // eslint-disable-line react-hooks/exhaustive-deps
  const useMyLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const p = await Location.getCurrentPositionAsync({});
    const [g] = await Location.reverseGeocodeAsync({ latitude: p.coords.latitude, longitude: p.coords.longitude }).catch(() => []);
    setAddr({ line1: g ? `${g.streetNumber || ''} ${g.street || ''}`.trim() : addr.line1, city: g?.city || addr.city, region: g?.region || addr.region, postalCode: g?.postalCode || addr.postalCode, lat: p.coords.latitude, lng: p.coords.longitude });
  };
  const place = async () => {
    if (!quote) return;
    setBusy(true);
    try {
      const useSaved = !!user && !!savedId && savedId !== 'new';
      if (user && saveCard && !useSaved && card) await api.post('/me/payment-methods', { paymentMethodId: card.token, last4: card.last4, brand: card.brand }).catch(() => undefined);
      const o = await api.post<{ id: string }>('/orders', { quoteId: quote.id, utensils, ...(quote.totalCents === 0 ? {} : useSaved ? { savedPaymentMethodId: savedId } : { paymentMethodId: card?.token }), guest: user ? undefined : guest }, idem.current);
      setDeclined(false);
      clear();
      router.replace({ pathname: '/order/[id]', params: { id: o.id, email: user ? '' : guest.email } });
    } catch (e) { setError((e as Error).message); const c = codeOf(e)?.code; if (c === 'PAYMENT_DECLINED') setDeclined(true); if (c && CAPACITY.includes(c)) { setError(BLOCKED[c]); setQuote(null); void loadAvail(); } idem.current = newIdempotencyKey(); } finally { setBusy(false); }
  };
  if (!cart.lines.length) return <View style={[s.screen, s.pad]}><Muted>Your cart is empty.</Muted></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {chefParked > 0 && <Card style={{ borderColor: C.brand, backgroundColor: '#fff4ec' }}><Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>Checking out from {chefParked + 1} chefs?</Text><Muted>Pay once for all {chefParked + 1} deliveries. Each chef cooks on the day you pick.</Muted><Button title={`Check out all ${chefParked + 1} chefs together`} onPress={() => router.push('/checkout-chefs')} /></Card>}
      {parked.length > 0 && <Card title="Your other saved orders"><Muted>Separate orders. The next one opens after you place this one.</Muted>{parked.map((p) => <View key={p.locationId} style={[s.row, { marginTop: 6 }]}><Text style={{ flex: 1 }}>{p.locationName} · {money(cartSubtotal(p))}</Text><Button title="Do first" variant="secondary" onPress={() => switchTo(p.locationId!)} /><Button title="Remove" variant="ghost" onPress={() => discardParked(p.locationId!)} /></View>)}</Card>}
      <Card title={`Order from ${cart.locationName}`}>
        {cart.lines.map((l) => <View key={l.key} style={[s.row, { marginBottom: 6 }]}><View style={{ flex: 1 }}><Text>{l.name}</Text>{l.modifierNames.length > 0 && <Muted>{l.modifierNames.join(', ')}</Muted>}{l.chefRequestQuoteId && <Muted>Price confirmed by the chef · quantity fixed</Muted>}</View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{l.chefRequestQuoteId ? <><Button title="Remove" variant="ghost" onPress={() => setQty(l.key, 0)} /><Text>{l.quantity}×</Text></> : <><Button title="−" variant="secondary" onPress={() => setQty(l.key, l.quantity - 1)} /><Text>{l.quantity}</Text><Button title="+" variant="secondary" onPress={() => setQty(l.key, l.quantity + 1)} /></>}<Text style={{ width: 60, textAlign: 'right' }}>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</Text></View></View>)}
      </Card>
      <Card title="When">
        {!loc?.chefKitchen && <View style={{ flexDirection: 'row', gap: 8 }}><Button title="As soon as possible" variant={schedule ? 'secondary' : 'primary'} onPress={() => setSchedule(null)} /><Button title="Schedule" variant={schedule ? 'primary' : 'secondary'} onPress={() => setSchedule({ date: days[0]?.date || '', time: '' })} /></View>}
        {loc?.chefKitchen && <><Muted>Chef dishes are cooked to order. Pick a cooking day and time.</Muted><View style={{ marginTop: 8 }}><DateSlotPicker availability={avail} loading={availLoading} value={schedule} onChange={(v) => { setSchedule(v); setError(null); }} /></View></>}
        {schedule && !loc?.chefKitchen && (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
              {days.map((d) => { const on = d.date === schedule.date; const dt = new Date(`${d.date}T12:00:00`); return <Pressable key={d.date} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => setSchedule({ date: d.date, time: '' })} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: on ? C.brand : C.ink1, backgroundColor: on ? '#fff4ec' : C.white, alignItems: 'center' }}><Text style={{ fontSize: 11, color: C.ink5 }}>{dt.toLocaleDateString('en-US', { weekday: 'short' })}</Text><Text style={{ fontWeight: '700', color: C.ink }}>{dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</Text></Pressable>; })}
            </ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {(days.find((d) => d.date === schedule.date)?.slots || []).filter((_, i) => i % 2 === 0).map((t) => { const on = t === schedule.time; return <Pressable key={t} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => setSchedule({ ...schedule, time: t })} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: on ? C.brand : C.white, borderWidth: 1, borderColor: on ? C.brand : C.ink1 }}><Text style={{ color: on ? C.white : C.ink7, fontSize: 12, fontWeight: '600' }}>{t}</Text></Pressable>; })}
            </View>
            {!days.length && <Muted>No times available right now.</Muted>}
          </>
        )}
      </Card>
      <Card title="Fulfillment">
        <View style={{ flexDirection: 'row', gap: 8 }}><Button title="Pickup" variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onPress={() => setFulfillment('PICKUP')} /><Button title="Delivery" variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} onPress={() => setFulfillment('DELIVERY')} /></View>
        <Button title={utensils ? 'Utensils & napkins included ✓' : 'Include utensils & napkins'} variant="ghost" onPress={() => setUtensils(!utensils)} />
        {fulfillment === 'DELIVERY' && (<View style={{ marginTop: 8 }}><Input label="Street" value={addr.line1} onChangeText={(v) => setAddr({ ...addr, line1: v })} /><Input label="City" value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })} /><View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="State" value={addr.region} onChangeText={(v) => setAddr({ ...addr, region: v })} /></View><View style={{ flex: 1 }}><Input label="ZIP" value={addr.postalCode} onChangeText={(v) => setAddr({ ...addr, postalCode: v })} /></View></View><Button title={addr.lat ? 'Location set ✓' : 'Use my location'} variant="secondary" onPress={useMyLocation} /></View>)}
      </Card>
      <Card title="Tip & promo">
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[0, 10, 15, 20].map((p) => <Button key={p} title={p ? `${p}%` : 'None'} variant={tip === p ? 'primary' : 'secondary'} onPress={() => setTip(p)} />)}</View>
        <Input label="Promo code" autoCapitalize="characters" value={promo} onChangeText={(v) => setPromo(v.toUpperCase())} />
        {!!gifts?.balanceCents && <Button title={useGift ? `Using gift balance (${money(gifts.balanceCents)}) ✓` : `Use gift balance (${money(gifts.balanceCents)})`} variant={useGift ? 'primary' : 'secondary'} onPress={() => setUseGift(!useGift)} />}
      </Card>
      <Card title="Payment">
        {!user && (<><Input label="Name" value={guest.name} onChangeText={(v) => setGuest({ ...guest, name: v })} /><Input label="Email" autoCapitalize="none" value={guest.email} onChangeText={(v) => setGuest({ ...guest, email: v })} /><Input label="Phone" value={guest.phone} onChangeText={(v) => setGuest({ ...guest, phone: v })} /><SmsNotice /></>)}
        {user && !!cards?.length && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{cards.map((c) => <Button key={c.id} title={`${c.brand} •••• ${c.last4}`} variant={savedId === c.id ? 'primary' : 'secondary'} onPress={() => { setSavedId(c.id); setDeclined(false); }} />)}<Button title="Other card" variant={savedId === 'new' ? 'primary' : 'secondary'} onPress={() => setSavedId('new')} /></View>}
        {(!user || !cards?.length || savedId === 'new') && <CardField value={card} onChange={(t) => { setCard(t); setDeclined(false); }} />}
        {user && (!cards?.length || savedId === 'new') && <Button title={saveCard ? 'Will save this card ✓' : 'Save this card for next time'} variant="ghost" onPress={() => setSaveCard(!saveCard)} />}
        {declined && <Text style={{ color: C.bad, marginBottom: 6 }}>That card was declined. Your order is held at the same price; choose another card and try again.</Text>}
        {quote?.seller?.firstParty ? <Text style={{ fontWeight: '600', marginBottom: 4 }}>{quote.seller.label}. Gutad prepares and sells this food and is responsible for it.</Text> : null}
        <Muted>{quote?.chefTerms ? chefTermsText(quote.chefTerms, loc?.timezone || avail?.timezone) : loc?.chefKitchen ? 'Charged now. Full refund if the chef declines or doesn’t confirm.' : 'Authorized now, captured when the restaurant accepts.'}</Muted>
      </Card>
      <Card title="Summary">
        <ErrorText msg={error} />
        {quote && (<View>{[['Subtotal', quote.subtotalCents], ...(quote.promotions?.length ? quote.promotions.map((p) => [p.name, -p.discountCents] as [string, number]) : [['Promo', -quote.discountCents] as [string, number]]), ['Tax', quote.taxCents], ['Service fee', quote.serviceFeeCents], ['Delivery', quote.deliveryFeeCents], ['Tip', quote.tipCents]].filter(([, v]) => v !== 0).map(([l, v]) => <View key={String(l)} style={s.row}><Muted>{String(l)}</Muted><Text>{money(Number(v))}</Text></View>)}{quote.paymentMix && quote.paymentMix.creditsCents + quote.paymentMix.loyaltyCents + quote.paymentMix.giftCents > 0 && (<View style={{ marginTop: 6 }}><View style={s.row}><Text>Order total</Text><Text>{money(quote.totalCents + quote.paymentMix.creditsCents + quote.paymentMix.loyaltyCents + quote.paymentMix.giftCents)}</Text></View>{quote.paymentMix.creditsCents > 0 && <View style={s.row}><Muted>Gutad credits</Muted><Text>{money(-quote.paymentMix.creditsCents)}</Text></View>}{quote.paymentMix.loyaltyCents > 0 && <View style={s.row}><Muted>Points</Muted><Text>{money(-quote.paymentMix.loyaltyCents)}</Text></View>}{quote.paymentMix.giftCents > 0 && <View style={s.row}><Muted>Gift card</Muted><Text>{money(-quote.paymentMix.giftCents)}</Text></View>}</View>)}<View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>{quote.paymentMix && quote.paymentMix.creditsCents + quote.paymentMix.loyaltyCents + quote.paymentMix.giftCents > 0 ? 'Card pays' : 'Total'}</Text><Text style={{ fontWeight: '700' }}>{money(quote.totalCents)}</Text></View><Muted>{quote.promiseAt ? `Estimated: ${when(quote.promiseAt)}` : ''}</Muted>{quote.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}<Button title={busy ? 'Placing…' : `Place order · ${money(quote.totalCents)}`} disabled={busy || (!user && (!guest.email || !guest.name))} onPress={place} /></View>)}
        {!quote && !error && <Muted>{fulfillment === 'DELIVERY' && !addr.lat ? 'Set your location for a delivery quote.' : 'Calculating…'}</Muted>}
      </Card>
    </ScrollView>
  );
}
