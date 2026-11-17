import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { GutadApiError, type ChefAvailability, type Quote } from '@gutad/shared';
import { CardField, type CardToken } from '@/card-field';
import { api, money, newIdempotencyKey } from '@/api';
import { cartSubtotal, useCart, type Cart } from '@/cart';
import { useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { SmsNotice } from '@/legal';
import { DateSlotPicker, chefTermsText, hhmmLabel, ymdLabel, type ChefTerms } from '@/date-slot-picker';

type Loc = { id: string; name: string; chefKitchen?: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; timezone?: string };
type CQuote = Quote & { chefTerms?: ChefTerms | null };
type Leg = { quote: CQuote | null; error: string | null };
type Addr = { line1: string; city: string; region: string; postalCode: string; lat: number; lng: number };

const MAX_CHEFS = 6;
const MSG: Record<string, string> = { SCHEDULE_REQUIRED: 'Pick a cooking day and time for each chef.', CHEF_CUTOFF_PASSED: 'Ordering for that day has closed. Pick another date.', CHEF_NOT_COOKING: 'The chef isn’t cooking that day. Pick another date.', CHEF_PAUSED: 'The chef is away that day. Pick another date.', CHEF_TOO_FAR: 'That date isn’t open for orders yet. Pick an earlier date.', CHEF_TIME_UNAVAILABLE: 'That time isn’t available. Pick another time.', DISH_CAPACITY_FULL: 'A dish just sold out for that day. Pick another date.', KITCHEN_CAPACITY_FULL: 'A chef is fully booked that day. Pick another date.', DELIVERY_UNAVAILABLE: 'Delivery is not available to this address. Try pickup.', ITEM_UNAVAILABLE: 'Something in your cart is no longer available.', ACCOUNT_RESTRICTED: 'Ordering is paused on your account. See Account for details.', QUOTE_EXPIRED: 'Prices were refreshed. Check the totals and pay again.', QUOTE_CONSUMED: 'Part of this checkout was already placed. Check your orders before paying again.' };
const CAPACITY = ['DISH_CAPACITY_FULL', 'KITCHEN_CAPACITY_FULL', 'CHEF_CUTOFF_PASSED', 'CHEF_NOT_COOKING', 'CHEF_PAUSED', 'CHEF_TOO_FAR', 'CHEF_TIME_UNAVAILABLE'];
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string; menuItemId?: string; quoteId?: string } | null) : null);
const errMsg = (e: unknown) => { const c = codeOf(e)?.code; return c && MSG[c] ? MSG[c] : (e as Error).message; };

/** One chef's part of the multi-chef checkout: its own date picker, capacity hold, fulfillment and quote. */
function ChefLeg({ c, loc, tipPct, addr, refresh, onLeg }: { c: Cart; loc: Loc; tipPct: number; addr: Addr; refresh: number; onLeg: (locationId: string, leg: Leg) => void }) {
  const lid = c.locationId!;
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>(loc.acceptsPickup || !loc.acceptsDelivery ? 'PICKUP' : 'DELIVERY');
  const holdKey = useRef(newIdempotencyKey());
  const [avail, setAvail] = useState<ChefAvailability | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [schedule, setSchedule] = useState<{ date: string; time: string } | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | undefined>(undefined);
  const [quote, setQuote] = useState<CQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linesKey = c.lines.map((l) => `${l.menuItemId}:${l.quantity}`).join(',');
  const tipCents = Math.round((cartSubtotal(c) * tipPct) / 100);
  const loadAvail = useCallback(async () => {
    setAvailLoading(true);
    const qty = new Map<string, number>();
    c.lines.forEach((l) => qty.set(l.menuItemId, (qty.get(l.menuItemId) || 0) + l.quantity));
    try { setAvail(await api.post<ChefAvailability>(`/public/chef-kitchens/${lid}/availability`, { lines: [...qty].map(([menuItemId, quantity]) => ({ menuItemId, quantity })), holdKey: holdKey.current })); } catch { setAvail(null); } finally { setAvailLoading(false); }
  }, [lid, linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAvail(); }, [loadAvail, refresh]);
  useEffect(() => {
    if (!avail) return;
    const d = schedule ? avail.days.find((x) => x.date === schedule.date) : undefined;
    if (!d || d.status !== 'AVAILABLE') setSchedule(avail.earliestDate && !schedule ? { date: avail.earliestDate, time: '' } : null);
    else if (schedule?.time && !d.slots.includes(schedule.time)) setSchedule({ date: d.date, time: '' });
  }, [avail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!schedule?.time) { setScheduledFor(undefined); return; }
    api.get<{ iso: string }>(`/public/locations/${lid}/local-time?date=${schedule.date}&time=${schedule.time}`).then((r) => setScheduledFor(r.iso)).catch(() => setScheduledFor(undefined));
  }, [schedule, lid]);
  useEffect(() => {
    if (!scheduledFor || !c.lines.length) { setQuote(null); return; }
    const t = setTimeout(() => {
      api.post<CQuote>('/quotes', { locationId: lid, channel: 'MARKETPLACE', fulfillmentType: fulfillment, scheduledFor, holdKey: holdKey.current, lines: c.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions })), tipCents, deliveryAddress: fulfillment === 'DELIVERY' ? { ...addr, lat: addr.lat || undefined, lng: addr.lng || undefined } : undefined })
        .then((q) => { setQuote(q); setError(null); })
        .catch((e) => { setQuote(null); const code = codeOf(e)?.code; if (code && CAPACITY.includes(code)) void loadAvail(); setError(errMsg(e)); });
    }, 350);
    return () => clearTimeout(t);
  }, [linesKey, fulfillment, tipCents, addr, scheduledFor, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onLeg(lid, { quote, error: error || (!schedule?.time ? 'Pick a day and time' : null) }); }, [quote, error, schedule?.time]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title={loc.name || c.locationName || 'Chef'}>
      {c.lines.map((l) => <View key={l.key} style={[s.row, { marginBottom: 4 }]}><View style={{ flex: 1 }}><Text>{l.quantity}× {l.name}</Text>{l.modifierNames.length > 0 && <Muted>{l.modifierNames.join(', ')}</Muted>}</View><Text>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</Text></View>)}
      <View style={{ marginTop: 8 }}><DateSlotPicker availability={avail} loading={availLoading} value={schedule} onChange={(v) => { setSchedule(v); setError(null); }} /></View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>{loc.acceptsPickup && <Button title="Pickup" variant={fulfillment === 'PICKUP' ? 'primary' : 'secondary'} onPress={() => setFulfillment('PICKUP')} />}{loc.acceptsDelivery && <Button title="Delivery" variant={fulfillment === 'DELIVERY' ? 'primary' : 'secondary'} onPress={() => setFulfillment('DELIVERY')} />}</View>
      <ErrorText msg={error} />
      {quote && <View style={{ marginTop: 4 }}>{[['Subtotal', quote.subtotalCents], ['Discount', -quote.discountCents], ['Tax', quote.taxCents], ['Service fee', quote.serviceFeeCents], ['Delivery', quote.deliveryFeeCents], ['Tip', quote.tipCents]].filter(([, v]) => v !== 0).map(([l, v]) => <View key={String(l)} style={s.row}><Muted>{String(l)}</Muted><Text>{money(Number(v))}</Text></View>)}<View style={s.row}><Text style={{ fontWeight: '700' }}>{schedule?.time ? `${ymdLabel(schedule.date)} · ${hhmmLabel(schedule.time)}` : 'Total'}</Text><Text style={{ fontWeight: '700' }}>{money(quote.totalCents)}</Text></View>{quote.chefTerms && <Muted>{chefTermsText(quote.chefTerms, loc.timezone || avail?.timezone)}</Muted>}{quote.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}</View>}
      {!quote && !error && schedule?.time && <Muted>Calculating…</Muted>}
    </Card>
  );
}

export default function ChefCheckout() {
  const { cart, parked, removeCarts } = useCart();
  const { user } = useSession();
  const router = useRouter();
  const carts = [cart, ...parked].filter((c) => c.locationId && c.lines.length);
  const idsKey = carts.map((c) => c.locationId).join(',');
  const [locs, setLocs] = useState<Record<string, Loc> | null>(null);
  useEffect(() => {
    if (!idsKey) { setLocs({}); return; }
    let live = true;
    Promise.all(idsKey.split(',').map((lid) => api.get<Loc>(`/public/locations/${lid}`).catch(() => null))).then((r) => { if (live) setLocs(Object.fromEntries(r.filter((l): l is Loc => !!l).map((l) => [l.id, l]))); });
    return () => { live = false; };
  }, [idsKey]);
  const allChef = carts.filter((c) => locs?.[c.locationId!]?.chefKitchen);
  const chefCarts = allChef.slice(0, MAX_CHEFS);
  const [tip, setTip] = useState(15);
  const [addr, setAddr] = useState<Addr>({ line1: '', city: '', region: '', postalCode: '', lat: 0, lng: 0 });
  const [guest, setGuest] = useState({ name: '', email: '', phone: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null, { deps: [user?.id] });
  const [savedId, setSavedId] = useState<string>('');
  useEffect(() => { const d = cards?.find((x) => x.isDefault) || cards?.[0]; if (d && !savedId) setSavedId(d.id); }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saveCard, setSaveCard] = useState(false);
  const [utensils, setUtensils] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const [legs, setLegs] = useState<Record<string, Leg>>({});
  const onLeg = useCallback((lid: string, leg: Leg) => setLegs((p) => ({ ...p, [lid]: leg })), []);
  const [refresh, setRefresh] = useState<Record<string, number>>({});
  const bump = (lids: string[]) => setRefresh((p) => ({ ...p, ...Object.fromEntries(lids.map((l) => [l, (p[l] || 0) + 1])) }));
  const quotes = chefCarts.map((c) => legs[c.locationId!]?.quote ?? null);
  const ready = chefCarts.length > 0 && quotes.every(Boolean);
  const total = quotes.reduce((a, q) => a + (q?.totalCents || 0), 0);
  const anyDelivery = quotes.some((q) => q?.fulfillmentType === 'DELIVERY') || chefCarts.some((c) => { const l = locs?.[c.locationId!]; return l && !l.acceptsPickup && l.acceptsDelivery; });
  const useMyLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const p = await Location.getCurrentPositionAsync({});
    const [g] = await Location.reverseGeocodeAsync({ latitude: p.coords.latitude, longitude: p.coords.longitude }).catch(() => []);
    setAddr({ line1: g ? `${g.streetNumber || ''} ${g.street || ''}`.trim() : addr.line1, city: g?.city || addr.city, region: g?.region || addr.region, postalCode: g?.postalCode || addr.postalCode, lat: p.coords.latitude, lng: p.coords.longitude });
  };
  const pay = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const useSaved = !!user && !!savedId && savedId !== 'new';
      if (user && saveCard && !useSaved && card) await api.post('/me/payment-methods', { paymentMethodId: card.token, last4: card.last4, brand: card.brand }).catch(() => undefined);
      const g = await api.post<{ id: string; orders: { id: string }[] }>('/checkout-groups', { quoteIds: quotes.map((q) => q!.id), utensils, ...(total === 0 ? {} : useSaved ? { savedPaymentMethodId: savedId } : { paymentMethodId: card?.token }), guest: user ? undefined : guest }, idem.current);
      setDeclined(false);
      removeCarts(chefCarts.map((c) => c.locationId!));
      router.replace({ pathname: '/checkout-group/[id]', params: { id: g.id, email: user ? '' : guest.email, orders: user ? '' : g.orders.map((o) => o.id).join(',') } });
    } catch (e) {
      const b = codeOf(e);
      setError(errMsg(e));
      if (b?.code === 'PAYMENT_DECLINED') setDeclined(true); // quotes stay; a new key lets the same quotes go through with another card
      if (b?.code && CAPACITY.includes(b.code)) { const hit = b.menuItemId ? chefCarts.filter((c) => c.lines.some((l) => l.menuItemId === b.menuItemId)) : []; bump((hit.length ? hit : chefCarts).map((c) => c.locationId!)); }
      if (b?.code === 'QUOTE_EXPIRED' || b?.code === 'QUOTE_CONSUMED') bump(chefCarts.map((c) => c.locationId!));
      idem.current = newIdempotencyKey();
    } finally { setBusy(false); }
  };
  if (!locs) return <Loading />;
  if (!chefCarts.length) return <View style={[s.screen, s.pad]}><Muted>No chef orders in your cart.</Muted></View>;
  const n = chefCarts.length;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>{n} {n === 1 ? 'delivery' : 'deliveries'} · one payment</Text>
      <Muted>Each chef cooks on the day you pick. Sold by Gutad.</Muted>
      {allChef.length > MAX_CHEFS && <Text style={{ color: C.warn, marginTop: 4 }}>You can check out up to {MAX_CHEFS} chefs at a time. The others stay in your cart.</Text>}
      <View style={{ height: 8 }} />
      {chefCarts.map((c) => <ChefLeg key={c.locationId} c={c} loc={locs[c.locationId!]} tipPct={tip} addr={addr} refresh={refresh[c.locationId!] || 0} onLeg={onLeg} />)}
      <Card title="Delivery & extras">
        {anyDelivery ? <><Muted>One delivery address for every chef delivering.</Muted><Input label="Street" value={addr.line1} onChangeText={(v) => setAddr({ ...addr, line1: v })} /><Input label="City" value={addr.city} onChangeText={(v) => setAddr({ ...addr, city: v })} /><View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="State" value={addr.region} onChangeText={(v) => setAddr({ ...addr, region: v })} /></View><View style={{ flex: 1 }}><Input label="ZIP" value={addr.postalCode} onChangeText={(v) => setAddr({ ...addr, postalCode: v })} /></View></View><Button title={addr.lat ? 'Location set ✓' : 'Use my location'} variant="secondary" onPress={useMyLocation} /></> : <Muted>All pickup — no address needed.</Muted>}
        <Button title={utensils ? 'Utensils & napkins included ✓' : 'Include utensils & napkins'} variant="ghost" onPress={() => setUtensils(!utensils)} />
        <Muted>Tip for each chef (share of that chef’s subtotal)</Muted>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[0, 10, 15, 20].map((p) => <Button key={p} title={p ? `${p}%` : 'None'} variant={tip === p ? 'primary' : 'secondary'} onPress={() => setTip(p)} />)}</View>
      </Card>
      <Card title="Payment">
        {!user && (<><Input label="Name" value={guest.name} onChangeText={(v) => setGuest({ ...guest, name: v })} /><Input label="Email" autoCapitalize="none" value={guest.email} onChangeText={(v) => setGuest({ ...guest, email: v })} /><Input label="Phone" value={guest.phone} onChangeText={(v) => setGuest({ ...guest, phone: v })} /><SmsNotice /></>)}
        {user && !!cards?.length && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{cards.map((x) => <Button key={x.id} title={`${x.brand} •••• ${x.last4}`} variant={savedId === x.id ? 'primary' : 'secondary'} onPress={() => { setSavedId(x.id); setDeclined(false); }} />)}<Button title="Other card" variant={savedId === 'new' ? 'primary' : 'secondary'} onPress={() => setSavedId('new')} /></View>}
        {(!user || !cards?.length || savedId === 'new') && <CardField value={card} onChange={(t) => { setCard(t); setDeclined(false); }} />}
        {user && (!cards?.length || savedId === 'new') && <Button title={saveCard ? 'Will save this card ✓' : 'Save this card for next time'} variant="ghost" onPress={() => setSaveCard(!saveCard)} />}
        {declined && <Text style={{ color: C.bad, marginBottom: 6 }}>That card was declined. Your orders are held at the same prices; choose another card and try again.</Text>}
        <Muted>Charged now. Full refund if a chef declines or doesn’t confirm, or if you cancel before each day’s order cutoff (shown per chef).</Muted>
      </Card>
      <Card title="Summary">
        {chefCarts.map((c) => { const leg = legs[c.locationId!]; return <View key={c.locationId} style={s.row}><Muted>{locs[c.locationId!]?.name || c.locationName}</Muted><Text>{leg?.quote ? money(leg.quote.totalCents) : leg?.error ? '—' : '…'}</Text></View>; })}
        <View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>Total · one payment</Text><Text style={{ fontWeight: '700' }}>{ready ? money(total) : '—'}</Text></View>
        <ErrorText msg={error} />
        {!ready && <Muted>Pick a day and time for each chef to see the total.</Muted>}
        <Button title={busy ? 'Paying…' : ready ? `Pay ${money(total)}` : 'Pay'} disabled={busy || !ready || (!user && (!guest.email || !guest.name))} onPress={pay} />
      </Card>
    </ScrollView>
  );
}
