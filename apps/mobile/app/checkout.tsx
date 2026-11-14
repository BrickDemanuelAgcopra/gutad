import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { GutadApiError, type Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/api';
import { cartSubtotal, useCart } from '@/cart';
import { useApi } from '@/hooks';
import { useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';

const BLOCKED: Record<string, string> = { KITCHEN_BUSY: 'The kitchen is at capacity right now. Try again shortly or order for later.', PAUSED: 'This restaurant has paused new orders for a moment.', CLOSED: 'This restaurant is closed right now.', SCHEDULE_TOO_SOON: 'That time is too soon for the kitchen.', SLOT_FULL: 'That time slot is full.', DELIVERY_UNAVAILABLE: 'Delivery is not available to this address right now. Try pickup.', ITEM_UNAVAILABLE: 'Something in your cart is no longer available.', SEPARATE_ORDER_REQUIRED: 'Items from different places need separate orders.', ACCOUNT_RESTRICTED: 'Ordering is paused on your account. See Account for details.' };
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string; nextOpenAt?: string } | null) : null);

export default function Checkout() {
  const { cart, parked, setQty, clear, switchTo, discardParked, subtotal } = useCart();
  const { user } = useSession();
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [tip, setTip] = useState(15);
  const [promo, setPromo] = useState('');
  const [addr, setAddr] = useState({ line1: '', city: '', region: '', postalCode: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState('4242424242424242');
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null, { deps: [user?.id] });
  const [savedId, setSavedId] = useState<string>('');
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedId) setSavedId(d.id); }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saveCard, setSaveCard] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [utensils, setUtensils] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const tipCents = Math.round((subtotal * tip) / 100);
  useEffect(() => {
    if (!cart.locationId || !cart.lines.length) return;
    const t = setTimeout(() => {
      api.post<Quote>('/quotes', { locationId: cart.locationId, channel: 'MARKETPLACE', fulfillmentType: fulfillment, lines: cart.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions })), tipCents, promoCode: promo || undefined, deliveryAddress: fulfillment === 'DELIVERY' ? { ...addr, lat: addr.lat || undefined, lng: addr.lng || undefined } : undefined })
        .then((q) => { setQuote(q); setError(null); })
        .catch((e) => { setQuote(null); const b = codeOf(e); setError(b?.code && BLOCKED[b.code] ? `${BLOCKED[b.code]}${b.nextOpenAt ? ` Opens ${when(b.nextOpenAt)}.` : ''}` : (e as Error).message); });
    }, 350);
    return () => clearTimeout(t);
  }, [cart, fulfillment, tipCents, promo, addr]);
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
      const digits = card.replace(/\D/g, '');
      if (user && saveCard && !useSaved) await api.post('/me/payment-methods', { paymentMethodId: `mock_pm_${digits.slice(-4)}`, last4: digits.slice(-4), brand: digits.startsWith('4') ? 'visa' : 'card' }).catch(() => undefined);
      const o = await api.post<{ id: string }>('/orders', { quoteId: quote.id, utensils, ...(useSaved ? { savedPaymentMethodId: savedId } : { paymentMethodId: `mock_pm_${digits.slice(-4)}` }), guest: user ? undefined : guest }, idem.current);
      setDeclined(false);
      clear();
      router.replace({ pathname: '/order/[id]', params: { id: o.id, email: user ? '' : guest.email } });
    } catch (e) { setError((e as Error).message); if (codeOf(e)?.code === 'PAYMENT_DECLINED') setDeclined(true); idem.current = newIdempotencyKey(); } finally { setBusy(false); }
  };
  if (!cart.lines.length) return <View style={[s.screen, s.pad]}><Muted>Your cart is empty.</Muted></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {parked.length > 0 && <Card title="Your other saved orders"><Muted>Separate orders. The next one opens after you place this one.</Muted>{parked.map((p) => <View key={p.locationId} style={[s.row, { marginTop: 6 }]}><Text style={{ flex: 1 }}>{p.locationName} · {money(cartSubtotal(p))}</Text><Button title="Do first" variant="secondary" onPress={() => switchTo(p.locationId!)} /><Button title="Remove" variant="ghost" onPress={() => discardParked(p.locationId!)} /></View>)}</Card>}
      <Card title={`Order from ${cart.locationName}`}>
        {cart.lines.map((l) => <View key={l.key} style={[s.row, { marginBottom: 6 }]}><View style={{ flex: 1 }}><Text>{l.name}</Text>{l.modifierNames.length > 0 && <Muted>{l.modifierNames.join(', ')}</Muted>}</View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Button title="−" variant="secondary" onPress={() => setQty(l.key, l.quantity - 1)} /><Text>{l.quantity}</Text><Button title="+" variant="secondary" onPress={() => setQty(l.key, l.quantity + 1)} /><Text style={{ width: 60, textAlign: 'right' }}>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</Text></View></View>)}
      </Card>
      <Card title="Fulfillment">
        <View style={{ flexDirection: 'row', gap: 8 }}><Button title="Pickup" variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onPress={() => setFulfillment('PICKUP')} /><Button title="Delivery" variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} onPress={() => setFulfillment('DELIVERY')} /></View>
        <Button title={utensils ? 'Utensils & napkins included ✓' : 'Include utensils & napkins'} variant="ghost" onPress={() => setUtensils(!utensils)} />
        {fulfillment === 'DELIVERY' && (<View style={{ marginTop: 8 }}><Input label="Street" value={addr.line1} onChangeText={(v) => setAddr({ ...addr, line1: v })} /><Input label="City" value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })} /><View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="State" value={addr.region} onChangeText={(v) => setAddr({ ...addr, region: v })} /></View><View style={{ flex: 1 }}><Input label="ZIP" value={addr.postalCode} onChangeText={(v) => setAddr({ ...addr, postalCode: v })} /></View></View><Button title={addr.lat ? 'Location set ✓' : 'Use my location'} variant="secondary" onPress={useMyLocation} /></View>)}
      </Card>
      <Card title="Tip & promo">
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[0, 10, 15, 20].map((p) => <Button key={p} title={p ? `${p}%` : 'None'} variant={tip === p ? 'primary' : 'secondary'} onPress={() => setTip(p)} />)}</View>
        <Input label="Promo code" autoCapitalize="characters" value={promo} onChangeText={(v) => setPromo(v.toUpperCase())} />
      </Card>
      <Card title="Payment">
        {!user && (<><Input label="Name" value={guest.name} onChangeText={(v) => setGuest({ ...guest, name: v })} /><Input label="Email" autoCapitalize="none" value={guest.email} onChangeText={(v) => setGuest({ ...guest, email: v })} /><Input label="Phone" value={guest.phone} onChangeText={(v) => setGuest({ ...guest, phone: v })} /></>)}
        {user && !!cards?.length && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{cards.map((c) => <Button key={c.id} title={`${c.brand} •••• ${c.last4}`} variant={savedId === c.id ? 'primary' : 'secondary'} onPress={() => { setSavedId(c.id); setDeclined(false); }} />)}<Button title="Other card" variant={savedId === 'new' ? 'primary' : 'secondary'} onPress={() => setSavedId('new')} /></View>}
        {(!user || !cards?.length || savedId === 'new') && <Input label="Card number" keyboardType="number-pad" value={card} onChangeText={(v) => { setCard(v); setDeclined(false); }} />}
        {user && (!cards?.length || savedId === 'new') && <Button title={saveCard ? 'Will save this card ✓' : 'Save this card for next time'} variant="ghost" onPress={() => setSaveCard(!saveCard)} />}
        {declined && <Text style={{ color: C.bad, marginBottom: 6 }}>That card was declined. Your order is held at the same price; choose another card and try again.</Text>}
        <Muted>Authorized now, captured when the restaurant accepts.</Muted>
      </Card>
      <Card title="Summary">
        <ErrorText msg={error} />
        {quote && (<View>{[['Subtotal', quote.subtotalCents], ['Promo', -quote.discountCents], ['Tax', quote.taxCents], ['Service fee', quote.serviceFeeCents], ['Delivery', quote.deliveryFeeCents], ['Tip', quote.tipCents]].filter(([, v]) => v !== 0).map(([l, v]) => <View key={String(l)} style={s.row}><Muted>{String(l)}</Muted><Text>{money(Number(v))}</Text></View>)}<View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>Total</Text><Text style={{ fontWeight: '700' }}>{money(quote.totalCents)}</Text></View><Muted>{quote.promiseAt ? `Estimated: ${when(quote.promiseAt)}` : ''}</Muted>{quote.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}<Button title={busy ? 'Placing…' : `Place order · ${money(quote.totalCents)}`} disabled={busy || (!user && (!guest.email || !guest.name))} onPress={place} /></View>)}
        {!quote && !error && <Muted>{fulfillment === 'DELIVERY' && !addr.lat ? 'Set your location for a delivery quote.' : 'Calculating…'}</Muted>}
      </Card>
    </ScrollView>
  );
}
