import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import type { Quote } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/api';
import { useCart } from '@/cart';
import { useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';

export default function Checkout() {
  const { cart, setQty, clear, subtotal } = useCart();
  const { user } = useSession();
  const router = useRouter();
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [tip, setTip] = useState(15);
  const [promo, setPromo] = useState('');
  const [addr, setAddr] = useState({ line1: '', city: '', region: '', postalCode: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState('4242424242424242');
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
        .catch((e) => { setQuote(null); setError((e as Error).message); });
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
      const o = await api.post<{ id: string }>('/orders', { quoteId: quote.id, paymentMethodId: `mock_pm_${card.slice(-4)}`, guest: user ? undefined : guest }, idem.current);
      clear();
      router.replace({ pathname: '/order/[id]', params: { id: o.id, email: user ? '' : guest.email } });
    } catch (e) { setError((e as Error).message); idem.current = newIdempotencyKey(); } finally { setBusy(false); }
  };
  if (!cart.lines.length) return <View style={[s.screen, s.pad]}><Muted>Your cart is empty.</Muted></View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title={`Order from ${cart.locationName}`}>
        {cart.lines.map((l) => <View key={l.key} style={[s.row, { marginBottom: 6 }]}><View style={{ flex: 1 }}><Text>{l.name}</Text>{l.modifierNames.length > 0 && <Muted>{l.modifierNames.join(', ')}</Muted>}</View><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Button title="−" variant="secondary" onPress={() => setQty(l.key, l.quantity - 1)} /><Text>{l.quantity}</Text><Button title="+" variant="secondary" onPress={() => setQty(l.key, l.quantity + 1)} /><Text style={{ width: 60, textAlign: 'right' }}>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</Text></View></View>)}
      </Card>
      <Card title="Fulfillment">
        <View style={{ flexDirection: 'row', gap: 8 }}><Button title="Pickup" variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onPress={() => setFulfillment('PICKUP')} /><Button title="Delivery" variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} onPress={() => setFulfillment('DELIVERY')} /></View>
        {fulfillment === 'DELIVERY' && (<View style={{ marginTop: 8 }}><Input label="Street" value={addr.line1} onChangeText={(v) => setAddr({ ...addr, line1: v })} /><Input label="City" value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })} /><View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="State" value={addr.region} onChangeText={(v) => setAddr({ ...addr, region: v })} /></View><View style={{ flex: 1 }}><Input label="ZIP" value={addr.postalCode} onChangeText={(v) => setAddr({ ...addr, postalCode: v })} /></View></View><Button title={addr.lat ? 'Location set ✓' : 'Use my location'} variant="secondary" onPress={useMyLocation} /></View>)}
      </Card>
      <Card title="Tip & promo">
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[0, 10, 15, 20].map((p) => <Button key={p} title={p ? `${p}%` : 'None'} variant={tip === p ? 'primary' : 'secondary'} onPress={() => setTip(p)} />)}</View>
        <Input label="Promo code" autoCapitalize="characters" value={promo} onChangeText={(v) => setPromo(v.toUpperCase())} />
      </Card>
      <Card title="Payment">
        {!user && (<><Input label="Name" value={guest.name} onChangeText={(v) => setGuest({ ...guest, name: v })} /><Input label="Email" autoCapitalize="none" value={guest.email} onChangeText={(v) => setGuest({ ...guest, email: v })} /><Input label="Phone" value={guest.phone} onChangeText={(v) => setGuest({ ...guest, phone: v })} /></>)}
        <Input label="Card number" keyboardType="number-pad" value={card} onChangeText={setCard} />
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
