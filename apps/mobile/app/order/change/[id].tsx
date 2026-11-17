import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { GutadApiError, type ChefAvailability } from '@gutad/shared';
import { CardField, type CardToken } from '@/card-field';
import { api, money, newIdempotencyKey, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Button, C, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { DateSlotPicker } from '@/date-slot-picker';

interface OrderLine { id: string; menuItemId: string | null; name: string; quantity: number; unitPriceCents: number; modifiersCents: number; modifiers: { id: string; name: string; qty?: number }[] | null; specialInstructions: string | null }
interface Order { id: string; number: string; locationId: string; fulfillmentType: 'PICKUP' | 'DELIVERY'; totalCents: number; scheduledFor: string | null; tipCents: number; deliveryAddress: Record<string, unknown> | null; lines: OrderLine[]; chefNetwork: { chefName: string | null; freeCancelUntil: string | null } | null }
interface Amendment { allowed: boolean; code: string; reason: string; until: string | null; chargedCents: number; scheduledFor: string | null }
interface Quote { id: string; totalCents: number; warnings: string[]; chefTerms?: { freeCancelUntil: string | null } | null }

/** Plain-language messages for the errors changing an order can hit (falls back to the API's message). */
const PROBLEM: Record<string, string> = {
  NOT_AMENDABLE: 'This order can’t be changed anymore.',
  AMEND_WINDOW_CLOSED: 'Changes closed at the order cutoff for the day. You can still cancel under the order’s terms.',
  HAS_SPECIAL_REQUEST: 'Orders with a special request can’t be changed. Cancel for a full refund and ask the chef again.',
  QUOTE_NOT_FOR_ORDER: 'The price is out of date. Wait for the new price and try again.',
  PAYMENT_DECLINED: 'That card was declined. Your order hasn’t changed; choose another card and try again.',
  DISH_CAPACITY_FULL: 'A dish just sold out for that day. Pick another date or lower the quantity.',
  KITCHEN_CAPACITY_FULL: 'The chef is fully booked that day. Pick another date.',
  CHEF_CUTOFF_PASSED: 'Ordering for that day has closed. Pick another date.',
  CHEF_NOT_COOKING: 'The chef isn’t cooking that day. Pick another date.',
  CHEF_PAUSED: 'The chef is away that day. Pick another date.',
  CHEF_TOO_FAR: 'That date isn’t open for orders yet. Pick an earlier date.',
  CHEF_TIME_UNAVAILABLE: 'That time isn’t available. Pick another time.',
  ITEM_UNAVAILABLE: 'A dish in this order is no longer available.',
};
const CAPACITY = ['DISH_CAPACITY_FULL', 'KITCHEN_CAPACITY_FULL', 'CHEF_CUTOFF_PASSED', 'CHEF_NOT_COOKING', 'CHEF_PAUSED', 'CHEF_TOO_FAR', 'CHEF_TIME_UNAVAILABLE'];
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string } | null)?.code : undefined);
const explain = (e: unknown) => { const c = codeOf(e); return (c && PROBLEM[c]) || (e as Error).message; };

/**
 * Change a paid Gutad Chef Network order before its cutoff: quantities, removing dishes, day and time. The change is
 * priced as a new order (the original's portions don't count against the day); confirming charges the new total and
 * refunds the original in full.
 */
export default function ChangeOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const router = useRouter();
  const { data: o, error } = useApi<Order>(user ? `/orders/${id}` : null, { deps: [user?.id, id] });
  const { data: am, reload: reloadAm } = useApi<Amendment>(user ? `/orders/${id}/amendment` : null, { deps: [user?.id, id] });
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>(user ? '/me/payment-methods' : null, { deps: [user?.id] });
  const [savedId, setSavedId] = useState('');
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedId) setSavedId(d.id); }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const [card, setCard] = useState<CardToken | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [slot, setSlot] = useState<{ date: string; time: string } | null>(null);
  const [avail, setAvail] = useState<ChefAvailability | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availNonce, setAvailNonce] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pricing, setPricing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holdKey = useRef(newIdempotencyKey());
  const idem = useRef(newIdempotencyKey());
  const lines = useMemo(() => (o?.lines || []).filter((l) => l.menuItemId).map((l) => ({ ...l, quantity: qty[l.id] ?? l.quantity })), [o, qty]);
  const kept = lines.filter((l) => l.quantity > 0);
  const lineKey = kept.map((l) => `${l.id}:${l.quantity}`).join(',');

  // availability for the changed dishes (this order's own portions don't count); the order's own day and time first
  useEffect(() => {
    if (!o || !kept.length) return;
    let cancelled = false;
    setAvailLoading(true);
    const qtyBy = new Map<string, number>();
    kept.forEach((l) => qtyBy.set(l.menuItemId!, (qtyBy.get(l.menuItemId!) || 0) + l.quantity));
    api.post<ChefAvailability>(`/public/chef-kitchens/${o.locationId}/availability`, { lines: [...qtyBy].map(([menuItemId, quantity]) => ({ menuItemId, quantity })), holdKey: holdKey.current, replacesOrderId: o.id })
      .then((a) => {
        if (cancelled) return;
        setAvail(a);
        setSlot((cur) => {
          const curDay = cur ? a.days.find((d) => d.date === cur.date && d.status === 'AVAILABLE') : undefined;
          if (cur && curDay) return cur.time && !curDay.slots.includes(cur.time) ? { date: cur.date, time: '' } : cur;
          if (!o.scheduledFor) return a.earliestDate ? { date: a.earliestDate, time: '' } : null;
          let local = '';
          try { local = new Date(o.scheduledFor).toLocaleString('sv-SE', { timeZone: a.timezone }).slice(0, 16); } catch { local = ''; }
          const [d, t] = local.split(' ');
          const day = d ? a.days.find((x) => x.date === d && x.status === 'AVAILABLE') : undefined;
          return day ? { date: d, time: t && day.slots.includes(t) ? t : '' } : a.earliestDate ? { date: a.earliestDate, time: '' } : null;
        });
      })
      .catch(() => { if (!cancelled) setAvail(null); })
      .finally(() => { if (!cancelled) setAvailLoading(false); });
    return () => { cancelled = true; };
  }, [o?.id, lineKey, availNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // price the change (debounced)
  useEffect(() => {
    if (!o || !slot?.time || !kept.length) { setQuote(null); return; }
    let cancelled = false;
    setPricing(true);
    const t = setTimeout(async () => {
      try {
        setProblem(null);
        const iso = (await api.get<{ iso: string }>(`/public/locations/${o.locationId}/local-time?date=${slot.date}&time=${slot.time}`)).iso;
        const q = await api.post<Quote>('/quotes', {
          locationId: o.locationId, channel: 'MARKETPLACE', fulfillmentType: o.fulfillmentType, scheduledFor: iso, tipCents: o.tipCents, holdKey: holdKey.current, replacesOrderId: o.id,
          deliveryAddress: o.fulfillmentType === 'DELIVERY' ? o.deliveryAddress : undefined,
          lines: kept.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: (l.modifiers || []).flatMap((m) => Array(m.qty || 1).fill(m.id)), specialInstructions: l.specialInstructions || undefined })),
        });
        if (!cancelled) setQuote(q);
      } catch (e) {
        if (cancelled) return;
        setQuote(null); setProblem(explain(e));
        const c = codeOf(e); if (c && CAPACITY.includes(c)) setAvailNonce((n) => n + 1);
      } finally { if (!cancelled) setPricing(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [o?.id, lineKey, slot?.date, slot?.time]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to change this order.</Muted><Button title="Sign in" onPress={() => router.push('/login')} /></View>;
  if (error) return <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View>;
  if (!o || !am) return <Loading />;
  if (!am.allowed) return <View style={[s.screen, s.pad]}><Card title={`Order ${o.number}`}><Text style={{ color: C.ink7 }}>{am.reason}</Text></Card><Button title="Back to the order" variant="secondary" onPress={() => router.back()} /></View>;

  const useSaved = !!savedId && savedId !== 'new';
  const confirm = async () => {
    if (!quote) return;
    setBusy(true); setProblem(null);
    try {
      if (quote.totalCents > 0 && !useSaved && !card) throw new Error('Choose a card');
      const n = await api.post<{ id: string }>(`/orders/${o.id}/amend`, { quoteId: quote.id, ...(quote.totalCents === 0 ? {} : useSaved ? { savedPaymentMethodId: savedId } : { paymentMethodId: card!.token }) }, idem.current);
      router.replace({ pathname: '/order/[id]', params: { id: n.id } });
    } catch (e) {
      setProblem(explain(e));
      const c = codeOf(e);
      if (c && CAPACITY.includes(c)) { setQuote(null); setAvailNonce((x) => x + 1); }
      if (c === 'NOT_AMENDABLE' || c === 'AMEND_WINDOW_CLOSED' || c === 'HAS_SPECIAL_REQUEST') reloadAm();
      idem.current = newIdempotencyKey();
      setBusy(false);
    }
  };
  const diff = quote ? quote.totalCents - am.chargedCents : 0;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Change order {o.number}</Text>
      <Muted>Changes are open until {when(am.until)}. {o.chefNetwork?.chefName || 'The chef'} confirms the changed order again.</Muted>
      <Card title="Dishes" style={{ marginTop: 10 }}>
        {lines.map((l) => (
          <View key={l.id} style={[s.row, { marginBottom: 6, opacity: l.quantity === 0 ? 0.5 : 1 }]}>
            <View style={{ flex: 1 }}><Text style={{ color: C.ink }}>{l.name}</Text>{!!l.modifiers?.length && <Muted>{l.modifiers.map((m) => m.name).join(', ')}</Muted>}</View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Button title="−" variant="secondary" disabled={l.quantity <= 0} onPress={() => setQty({ ...qty, [l.id]: Math.max(0, l.quantity - 1) })} />
              <Text accessibilityLabel={`Quantity of ${l.name}`} style={{ minWidth: 18, textAlign: 'center' }}>{l.quantity}</Text>
              <Button title="+" variant="secondary" disabled={l.quantity >= 50} onPress={() => setQty({ ...qty, [l.id]: Math.min(50, l.quantity + 1) })} />
              <Text style={{ width: 64, textAlign: 'right' }}>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</Text>
            </View>
          </View>
        ))}
        <Muted>Set a dish to 0 to remove it. To add other dishes, cancel for a full refund and order again.</Muted>
      </Card>
      {!kept.length ? (
        <Card><Text style={{ color: C.ink7 }}>Nothing left in the order. Cancel it instead for a full refund.</Text><Button title="Back to the order" variant="secondary" onPress={() => router.back()} /></Card>
      ) : (
        <Card title={o.fulfillmentType === 'DELIVERY' ? 'Delivery day and time' : 'Pickup day and time'}>
          <DateSlotPicker availability={avail} loading={availLoading} value={slot} onChange={(v) => { setSlot(v); setProblem(null); }} />
        </Card>
      )}
      <ErrorText msg={problem} />
      {!!kept.length && !quote && !problem && <Muted>{!slot?.time ? 'Pick a day and time to see the new price.' : pricing ? 'Pricing your change…' : ''}</Muted>}
      {quote && (
        <Card title="What changes">
          <View style={s.row}><Text>New order total</Text><Text style={{ fontWeight: '700' }}>{money(quote.totalCents)}</Text></View>
          <View style={s.row}><Muted>Refund of order {o.number} (in full)</Muted><Text style={{ color: C.ink7 }}>−{money(am.chargedCents)}</Text></View>
          <View style={[s.row, { borderTopWidth: 1, borderTopColor: C.ink1, paddingTop: 4, marginTop: 2 }]}><Text>Difference</Text><Text style={{ fontWeight: '700' }}>{diff >= 0 ? '+' : '−'}{money(Math.abs(diff))}</Text></View>
          {quote.warnings.map((w) => <Text key={w} style={{ color: C.warn, marginTop: 4 }}>{w}</Text>)}
          <Muted>We charge the new total and refund the original charge in full (refunds take 5–10 business days to appear). {o.chefNetwork?.chefName || 'The chef'} confirms the changed order again; if they can’t make it, you’re refunded in full automatically.{quote.chefTerms?.freeCancelUntil ? ` Free cancellation until ${when(quote.chefTerms.freeCancelUntil)}.` : ''}</Muted>
          {quote.totalCents > 0 && (
            <View style={{ marginTop: 8 }}>
              {!!cards?.length && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{cards.map((c) => <Button key={c.id} title={`${c.brand || 'Card'} •••• ${c.last4}`} variant={savedId === c.id ? 'primary' : 'secondary'} onPress={() => setSavedId(c.id)} />)}<Button title="Other card" variant={savedId === 'new' ? 'primary' : 'secondary'} onPress={() => setSavedId('new')} /></View>}
              {(!cards?.length || savedId === 'new') && <CardField value={card} onChange={setCard} />}
            </View>
          )}
          <Button title={busy ? 'Saving…' : `Confirm changes — charge ${money(quote.totalCents)}`} disabled={busy || pricing} onPress={confirm} />
        </Card>
      )}
    </ScrollView>
  );
}
