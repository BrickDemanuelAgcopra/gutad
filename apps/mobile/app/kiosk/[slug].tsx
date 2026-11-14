import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { newIdempotencyKey, TEST_CARDS, type MenuDto, type MenuItemDto } from '@gutad/shared';
import { API_URL, money } from '@/api';
import { C } from '@/ui';

interface KioskLoc { id: string; name: string; heroImageUrl: string | null; acceptsKiosk?: boolean; acceptsPickup?: boolean; isPaused?: boolean; pausedReason?: string | null }
interface Line { key: string; item: MenuItemDto; quantity: number; optionIds: string[]; optionNames: string[]; modsCents: number }
interface Quote { id: string; taxCents: number; serviceFeeCents: number; discountCents: number; totalCents: number; warnings: string[] }
interface Placed { number: string; pickupCode: string | null; tableNumber: string | null; totalCents: number }

const IDLE_MS = 90_000;
const WARN_MS = 15_000;
const DONE_MS = 30_000;

/** Kiosk calls never carry the signed-in session (a staff login on the tablet must not own guest orders). */
async function kioskCall<T>(method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((json as { message?: unknown }).message || `Something went wrong (${res.status})`));
  return json as T;
}

const Big = ({ title, onPress, color = C.brand, disabled, flex }: { title: string; onPress: () => void; color?: string; disabled?: boolean; flex?: number }) => (
  <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flex, backgroundColor: color, opacity: disabled ? 0.4 : pressed ? 0.85 : 1, borderRadius: 20, paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', marginVertical: 6 })}>
    <Text style={{ color: color === C.white ? C.ink : C.white, fontSize: 22, fontWeight: '800', textAlign: 'center' }}>{title}</Text>
  </Pressable>
);

/** 14.8-K tablet self-order kiosk: eat here / take away, big touch menu, cart, card (test mode) or pay at counter, pager / table number, idle reset. */
export default function Kiosk() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [loc, setLoc] = useState<KioskLoc | null>(null);
  const [menus, setMenus] = useState<MenuDto[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState<'welcome' | 'menu' | 'pay' | 'done'>('welcome');
  const [mode, setMode] = useState<'DINE_IN' | 'PICKUP'>('PICKUP');
  const [cat, setCat] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState<MenuItemDto | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [name, setName] = useState('');
  const [pager, setPager] = useState('');
  const [pay, setPay] = useState<'CARD' | 'COUNTER'>('CARD');
  const [card, setCard] = useState<string>(TEST_CARDS[0].token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [warn, setWarn] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const lastTouch = useRef(Date.now());
  const touch = () => { lastTouch.current = Date.now(); if (warn) setWarn(false); };

  useEffect(() => {
    kioskCall<KioskLoc>('GET', `/public/locations/${slug}`).then(async (l) => {
      setLoc(l);
      const m = await kioskCall<MenuDto[]>('GET', `/public/locations/${l.id}/menus?channel=KIOSK`);
      setMenus(m);
      setCat(m.flatMap((x) => x.categories)[0]?.id || '');
      const p = await kioskCall<{ provider: string }>('GET', '/public/payments/provider').catch(() => ({ provider: 'unknown' }));
      setProvider(p.provider);
      if (p.provider !== 'mock') setPay('COUNTER');
    }).catch((e) => setLoadErr((e as Error).message));
  }, [slug]);

  const reset = useCallback(() => {
    setStep('welcome'); setLines([]); setQuote(null); setName(''); setPager(''); setError(null); setPlaced(null); setPicking(null); setWarn(false);
    setPay(provider === 'mock' ? 'CARD' : 'COUNTER');
    idem.current = newIdempotencyKey();
  }, [provider]);

  useEffect(() => {
    const t = setInterval(() => {
      if (step === 'welcome') return;
      const idle = Date.now() - lastTouch.current;
      if (step === 'done' ? idle > DONE_MS : idle > IDLE_MS + WARN_MS) reset();
      else if (step !== 'done' && idle > IDLE_MS) setWarn(true);
    }, 1000);
    return () => clearInterval(t);
  }, [step, reset]);

  const categories = useMemo(() => (menus || []).flatMap((m) => m.categories).filter((c) => c.items.length), [menus]);
  const items = categories.find((c) => c.id === cat)?.items || [];
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const estimate = lines.reduce((a, l) => a + (l.item.priceCents + l.modsCents) * l.quantity, 0);

  const add = (item: MenuItemDto, optionIds: string[] = [], optionNames: string[] = [], modsCents = 0) => {
    const key = `${item.id}:${[...optionIds].sort().join(',')}`;
    setLines((ls) => (ls.some((l) => l.key === key) ? ls.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { key, item, quantity: 1, optionIds, optionNames, modsCents }]));
  };
  const setQty = (key: string, q: number) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: q } : l)).filter((l) => l.quantity > 0));

  const review = async () => {
    if (!loc) return;
    setBusy(true); setError(null);
    try {
      setQuote(await kioskCall<Quote>('POST', '/quotes', { locationId: loc.id, channel: 'KIOSK', fulfillmentType: mode, lines: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, modifierOptionIds: l.optionIds })) }));
      setStep('pay');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const placeOrder = async () => {
    if (!quote) return;
    setBusy(true); setError(null);
    try {
      const o = await kioskCall<Placed>('POST', '/orders', { quoteId: quote.id, guest: { name: name.trim() || 'Kiosk guest', email: `kiosk-${idem.current.slice(0, 12)}@kiosk.gutad.io` }, tableNumber: pager.trim() || undefined, paymentMethodId: pay === 'CARD' ? card : undefined, specialInstructions: pay === 'COUNTER' ? 'PAY AT COUNTER (kiosk)' : undefined }, idem.current);
      setPlaced(o); setStep('done'); lastTouch.current = Date.now();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const screen = (children: React.ReactNode) => <View style={{ flex: 1, backgroundColor: C.bg }} onTouchStart={touch}><Stack.Screen options={{ headerShown: false }} />{children}</View>;
  if (loadErr) return screen(<Text style={{ margin: 40, fontSize: 20, textAlign: 'center' }}>{loadErr}</Text>);
  if (!loc || !menus) return screen(<Text style={{ margin: 40, fontSize: 20, textAlign: 'center', color: C.ink5 }}>Loading…</Text>);
  if (loc.acceptsKiosk === false) return screen(<View style={{ padding: 40 }}><Text style={{ fontSize: 28, fontWeight: '800', textAlign: 'center' }}>{loc.name}</Text><Text style={{ marginTop: 12, fontSize: 18, textAlign: 'center', color: C.ink5 }}>Kiosk ordering is not switched on for this location.</Text></View>);

  return screen(
    <>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.white, paddingHorizontal: 20, paddingTop: 36, paddingBottom: 14 }}>
        <Pressable onPress={reset}><Text style={{ fontSize: 22, fontWeight: '800', color: C.ink }}>{loc.name}</Text></Pressable>
        {step === 'menu' && <Text style={{ fontSize: 16, color: C.ink5 }}>{mode === 'DINE_IN' ? 'Eat here' : 'Take away'}</Text>}
      </View>

      {step === 'welcome' && (
        <ScrollView contentContainerStyle={{ padding: 24, alignItems: 'stretch' }}>
          {loc.heroImageUrl && <Image source={{ uri: loc.heroImageUrl }} style={{ height: 200, borderRadius: 24, marginBottom: 24 }} />}
          <Text style={{ fontSize: 40, fontWeight: '900', textAlign: 'center', color: C.ink }}>Order here</Text>
          {loc.isPaused && <Text style={{ fontSize: 18, color: C.bad, textAlign: 'center', marginTop: 8 }}>{loc.pausedReason || 'Ordering is paused right now.'}</Text>}
          <View style={{ marginTop: 24, gap: 12 }}>
            <Big title="🍽️  Eat here" onPress={() => { setMode('DINE_IN'); setStep('menu'); }} />
            {loc.acceptsPickup !== false && <Big title="🛍️  Take away" color={C.ink} onPress={() => { setMode('PICKUP'); setStep('menu'); }} />}
          </View>
          <Text style={{ textAlign: 'center', marginTop: 16, color: C.ink5, fontSize: 16 }}>Tap to start</Text>
        </ScrollView>
      )}

      {step === 'menu' && (
        <View style={{ flex: 1 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, backgroundColor: C.white }} contentContainerStyle={{ padding: 10, gap: 8 }}>
            {categories.map((c) => <Pressable key={c.id} onPress={() => setCat(c.id)} style={{ paddingHorizontal: 18, paddingVertical: 14, borderRadius: 16, backgroundColor: c.id === cat ? C.brand : C.ink1 }}><Text style={{ fontSize: 18, fontWeight: '700', color: c.id === cat ? C.white : C.ink }}>{c.name}</Text></Pressable>)}
          </ScrollView>
          <ScrollView contentContainerStyle={{ padding: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {items.map((it) => (
              <Pressable key={it.id} disabled={it.soldOut} onPress={() => (it.modifierGroups.length ? setPicking(it) : add(it))} style={{ width: '47%', backgroundColor: C.white, borderRadius: 20, overflow: 'hidden', opacity: it.soldOut ? 0.4 : 1 }}>
                {it.imageUrl ? <Image source={{ uri: it.imageUrl }} style={{ height: 110 }} /> : <View style={{ height: 110, backgroundColor: C.ink1 }} />}
                <View style={{ padding: 12 }}><Text style={{ fontSize: 18, fontWeight: '800', color: C.ink }}>{it.name}</Text><Text style={{ fontSize: 17, marginTop: 6, color: C.ink7 }}>{it.soldOut ? 'Sold out' : money(it.priceCents)}</Text></View>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ backgroundColor: C.white, padding: 12, borderTopWidth: 1, borderColor: C.ink1, maxHeight: 280 }}>
            <ScrollView style={{ maxHeight: 150 }}>
              {lines.map((l) => (
                <View key={l.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <Text style={{ flex: 1, fontSize: 16, color: C.ink }}>{l.item.name}{l.optionNames.length ? ` (${l.optionNames.join(', ')})` : ''}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Pressable onPress={() => setQty(l.key, l.quantity - 1)} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.ink1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>−</Text></Pressable>
                    <Text style={{ fontSize: 18, width: 24, textAlign: 'center' }}>{l.quantity}</Text>
                    <Pressable onPress={() => setQty(l.key, l.quantity + 1)} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.ink1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>+</Text></Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>
            {error && <Text style={{ color: C.bad, fontSize: 15 }}>{error}</Text>}
            <Big title={busy ? '…' : count ? `Pay · ${count} item${count === 1 ? '' : 's'} · ${money(estimate)}` : 'Tap an item to add it'} disabled={!count || busy} onPress={review} />
          </View>
        </View>
      )}

      {step === 'pay' && quote && (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 30, fontWeight: '900', color: C.ink }}>Check and pay</Text>
          <View style={{ backgroundColor: C.white, borderRadius: 20, padding: 16, marginTop: 12 }}>
            {lines.map((l) => <View key={l.key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 17 }}>{l.quantity}× {l.item.name}</Text><Text style={{ fontSize: 17 }}>{money((l.item.priceCents + l.modsCents) * l.quantity)}</Text></View>)}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}><Text style={{ color: C.ink5, fontSize: 16 }}>Tax and fees</Text><Text style={{ color: C.ink5, fontSize: 16 }}>{money(quote.taxCents + quote.serviceFeeCents)}</Text></View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}><Text style={{ fontSize: 24, fontWeight: '900' }}>Total</Text><Text style={{ fontSize: 24, fontWeight: '900' }}>{money(quote.totalCents)}</Text></View>
            {quote.warnings.map((w) => <Text key={w} style={{ color: C.warn, marginTop: 4 }}>{w}</Text>)}
          </View>
          <Text style={{ fontSize: 16, fontWeight: '700', marginTop: 16 }}>Your name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="For your order" style={{ backgroundColor: C.white, borderRadius: 16, padding: 16, fontSize: 22, marginTop: 6 }} />
          <Text style={{ fontSize: 16, fontWeight: '700', marginTop: 12 }}>{mode === 'DINE_IN' ? 'Table or pager number' : 'Pager number (optional)'}</Text>
          <TextInput value={pager} onChangeText={setPager} keyboardType="number-pad" maxLength={10} placeholder="e.g. 12" style={{ backgroundColor: C.white, borderRadius: 16, padding: 16, fontSize: 22, marginTop: 6 }} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            {provider === 'mock' && <Big flex={1} title="💳 Card" color={pay === 'CARD' ? C.brand : C.white} onPress={() => setPay('CARD')} />}
            <Big flex={1} title="🧾 Pay at counter" color={pay === 'COUNTER' ? C.brand : C.white} onPress={() => setPay('COUNTER')} />
          </View>
          {pay === 'CARD' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>{TEST_CARDS.map((c) => <Pressable key={c.token} onPress={() => setCard(c.token)} style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: card === c.token ? C.ink : C.white }}><Text style={{ color: card === c.token ? C.white : C.ink, fontSize: 15 }}>{c.label}</Text></Pressable>)}<Text style={{ color: C.ink5, fontSize: 13 }}>Test mode. In a store, the card reader next to the kiosk takes the payment.</Text></View>}
          {pay === 'COUNTER' && <Text style={{ marginTop: 8, fontSize: 16, color: C.ink7 }}>Your order goes to the kitchen now; pay at the counter when you collect it.</Text>}
          {error && <Text style={{ color: C.bad, fontSize: 16, marginTop: 8 }}>{error}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Big flex={1} title="Back" color={C.white} onPress={() => setStep('menu')} />
            <Big flex={2} title={busy ? 'Placing…' : `Place order · ${money(quote.totalCents)}`} disabled={busy || (mode === 'DINE_IN' && !pager.trim())} onPress={placeOrder} />
          </View>
        </ScrollView>
      )}

      {step === 'done' && placed && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ fontSize: 64 }}>✅</Text>
          <Text style={{ fontSize: 30, fontWeight: '900', marginTop: 8 }}>Thank you{name.trim() ? `, ${name.trim().split(' ')[0]}` : ''}!</Text>
          <Text style={{ fontSize: 20, marginTop: 16 }}>Order number</Text>
          <Text style={{ fontSize: 56, fontWeight: '900', letterSpacing: 2 }}>{placed.number}</Text>
          {placed.tableNumber && <Text style={{ fontSize: 20, marginTop: 8 }}>{mode === 'DINE_IN' ? 'We’ll bring it to' : 'Pager'} {placed.tableNumber}</Text>}
          {placed.pickupCode && <Text style={{ fontSize: 18, color: C.ink5, marginTop: 4 }}>Pickup code {placed.pickupCode}</Text>}
          {pay === 'COUNTER' && <Text style={{ fontSize: 18, marginTop: 12, color: C.warn }}>Please pay {money(placed.totalCents)} at the counter.</Text>}
          <Big title="New order" color={C.ink} onPress={reset} />
          <Text style={{ color: C.ink5 }}>This screen resets in 30 seconds.</Text>
        </View>
      )}

      {picking && <ItemSheet item={picking} onClose={() => setPicking(null)} onAdd={(ids, names, cents) => { add(picking, ids, names, cents); setPicking(null); }} />}
      <Modal visible={warn} transparent animationType="fade" onRequestClose={() => setWarn(false)}>
        <Pressable onPress={() => { lastTouch.current = Date.now(); setWarn(false); }} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ backgroundColor: C.white, padding: 32, borderRadius: 24 }}><Text style={{ fontSize: 26, fontWeight: '900', textAlign: 'center' }}>Still there?</Text><Text style={{ fontSize: 17, color: C.ink5, marginTop: 8, textAlign: 'center' }}>Tap to keep your order.</Text></View>
        </Pressable>
      </Modal>
    </>,
  );
}

function ItemSheet({ item, onClose, onAdd }: { item: MenuItemDto; onClose: () => void; onAdd: (ids: string[], names: string[], cents: number) => void }) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const toggle = (g: MenuItemDto['modifierGroups'][number], id: string) => setSel((s) => {
    const cur = s[g.id] || [];
    if (g.maxSelect === 1) return { ...s, [g.id]: cur.includes(id) ? [] : [id] };
    if (cur.includes(id)) return { ...s, [g.id]: cur.filter((x) => x !== id) };
    return cur.length >= g.maxSelect ? s : { ...s, [g.id]: [...cur, id] };
  });
  const chosen = item.modifierGroups.flatMap((g) => g.options.filter((o) => (sel[g.id] || []).includes(o.id)));
  const invalid = item.modifierGroups.find((g) => (sel[g.id] || []).length < (g.required ? Math.max(1, g.minSelect) : g.minSelect));
  const cents = chosen.reduce((a, o) => a + o.priceCents, 0);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '85%' }}>
          <ScrollView>
            <Text style={{ fontSize: 26, fontWeight: '900' }}>{item.name}</Text>
            {item.modifierGroups.map((g) => (
              <View key={g.id} style={{ marginTop: 14 }}>
                <Text style={{ fontSize: 18, fontWeight: '700' }}>{g.name} <Text style={{ fontWeight: '400', color: C.ink5 }}>{g.required ? 'required' : g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'optional'}</Text></Text>
                {g.options.map((o) => { const on = (sel[g.id] || []).includes(o.id); return <Pressable key={o.id} disabled={o.soldOut} onPress={() => toggle(g, o.id)} style={{ marginTop: 6, padding: 14, borderRadius: 14, borderWidth: 3, borderColor: on ? C.brand : C.ink1, opacity: o.soldOut ? 0.4 : 1, flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ fontSize: 17 }}>{o.name}</Text>{o.priceCents > 0 && <Text style={{ fontSize: 17 }}>+{money(o.priceCents)}</Text>}</Pressable>; })}
              </View>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <Big flex={1} title="Cancel" color={C.white} onPress={onClose} />
            <Big flex={2} title={`Add · ${money(item.priceCents + cents)}`} disabled={!!invalid} onPress={() => onAdd(chosen.map((o) => o.id), chosen.map((o) => o.name), cents)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
