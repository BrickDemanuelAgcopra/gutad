import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, Text, Vibration, View } from 'react-native';
import { router } from 'expo-router';
import { api, money } from '@/api';
import { useApi } from '@/hooks';
import { Button, C, ErrorText } from '@/ui';

export interface PendingOrder {
  id: string; number: string; locationId: string; locationName: string; fulfillmentType: string; guestName: string | null; totalCents: number;
  createdAt: string; scheduledFor: string | null; rejectAt: string | null;
  subtotalCents?: number; taxCents?: number; deliveryFeeCents?: number; tipCents?: number; discountCents?: number; specialInstructions?: string | null;
  deliveryAddress?: { line1?: string; line2?: string; city?: string; instructions?: string } | null;
  lines: { name: string; quantity: number; modifiers?: string[]; specialInstructions?: string | null; lineTotalCents?: number; allergens?: string[] | null }[];
}

const PATTERN = [0, 800, 400, 800, 1500];
const PREP = [10, 15, 20, 30, 45];
const REASONS = ['Too busy', 'Item unavailable', 'Closing soon', 'Cannot fulfill delivery'];

export function fulfillmentLabel(t: string) { return t === 'DELIVERY' ? '🛵 DELIVERY' : t === 'DINE_IN' ? '🍽️ DINE IN' : '🛍️ PICKUP'; }

/**
 * New-order popup on the merchant tablet: a pulsing sheet with everything needed to decide (items, options, notes,
 * allergens, address, money), a ready-time choice, Accept / Reject, and a repeating vibration until answered. Accepting
 * opens the order's tracking screen. The push on the "orders" channel carries the ringtone when the app is closed.
 */
export function MerchantOrderAlarm() {
  const { data, reload } = useApi<PendingOrder[]>('/merchant/pending-orders', { poll: 5000 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [prep, setPrep] = useState<Record<string, number>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  const pulse = useRef(new Animated.Value(0)).current;
  const open = (data || []).filter((o) => !hidden.has(o.id));
  const ringing = open.length > 0;

  useEffect(() => {
    if (!ringing) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ringing]);

  useEffect(() => {
    if (!ringing) { Vibration.cancel(); return; }
    Vibration.vibrate(PATTERN, true);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: false }),
    ]));
    loop.start();
    return () => { Vibration.cancel(); loop.stop(); };
  }, [ringing, pulse]);

  if (!ringing) return null;
  const hide = (ids: string[]) => setHidden(new Set([...hidden, ...ids]));
  const accept = async (o: PendingOrder) => {
    setBusy(o.id); setErr(null);
    try { await api.post(`/orders/${o.id}/accept`, { prepMinutes: prep[o.id] ?? 20 }); hide([o.id]); await reload(); router.push(`/merchant/order/${o.id}`); }
    catch (e) { setErr((e as Error).message || 'Could not accept the order'); }
    finally { setBusy(null); }
  };
  const reject = async (o: PendingOrder, reason: string) => {
    setBusy(o.id); setErr(null);
    try { await api.post(`/orders/${o.id}/reject`, { reason }); setRejecting(null); hide([o.id]); await reload(); }
    catch (e) { setErr((e as Error).message || 'Could not reject the order'); }
    finally { setBusy(null); }
  };
  const bg = pulse.interpolate({ inputRange: [0, 1], outputRange: ['rgba(244,93,10,0.55)', 'rgba(244,93,10,0.9)'] });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => hide(open.map((o) => o.id))}>
      <Animated.View style={{ flex: 1, backgroundColor: bg, justifyContent: 'center', padding: 14 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden', maxHeight: '92%' }}>
          <View style={{ backgroundColor: C.brand, paddingVertical: 14, paddingHorizontal: 16 }}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{open.length === 1 ? 'New order!' : `${open.length} new orders!`}</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
            {open.map((o) => {
              const left = o.rejectAt ? Math.max(0, new Date(o.rejectAt).getTime() - Date.now()) : null;
              const a = o.deliveryAddress;
              const mins = prep[o.id] ?? 20;
              return (
                <View key={o.id} style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800' }}>{o.number}</Text>
                    <Text style={{ fontSize: 18, fontWeight: '800' }}>{money(o.totalCents)}</Text>
                  </View>
                  <Text style={{ alignSelf: 'flex-start', fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: o.fulfillmentType === 'DELIVERY' ? '#dbeafe' : '#fef3c7', color: o.fulfillmentType === 'DELIVERY' ? '#1e40af' : '#92400e' }}>{fulfillmentLabel(o.fulfillmentType)}</Text>
                  <Text style={{ color: C.ink5 }}>{o.locationName}{o.guestName ? ` · ${o.guestName}` : ''}</Text>
                  {o.fulfillmentType === 'DELIVERY' && !!a?.line1 && <Text>To {a.line1}{a.city ? `, ${a.city}` : ''}{a.instructions ? `\n“${a.instructions}”` : ''}</Text>}
                  {o.lines.map((l, i) => (
                    <View key={i}>
                      <Text><Text style={{ fontWeight: '800' }}>{l.quantity}× </Text>{l.name}{l.modifiers?.length ? <Text style={{ color: C.ink5 }}> — {l.modifiers.join(', ')}</Text> : null}</Text>
                      {!!l.specialInstructions && <Text style={{ color: C.warn, fontStyle: 'italic' }}>“{l.specialInstructions}”</Text>}
                      {!!l.allergens?.length && <Text style={{ color: C.bad, fontSize: 12 }}>Allergens: {l.allergens.join(', ')}</Text>}
                    </View>
                  ))}
                  {!!o.specialInstructions && <Text style={{ color: '#92400e', backgroundColor: '#fffbeb', padding: 6, borderRadius: 6 }}>Order note: {o.specialInstructions}</Text>}
                  {o.subtotalCents != null && <Text style={{ color: C.ink5, fontSize: 12 }}>Subtotal {money(o.subtotalCents)} · tax {money(o.taxCents || 0)}{o.deliveryFeeCents ? ` · delivery ${money(o.deliveryFeeCents)}` : ''}{o.tipCents ? ` · tip ${money(o.tipCents)}` : ''}</Text>}
                  {left !== null && <Text style={{ fontWeight: '700', color: left < 5 * 60_000 ? C.bad : C.ink5 }}>Auto-rejects in {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}</Text>}
                  {rejecting === o.id ? (
                    <View style={{ gap: 6, backgroundColor: '#fef2f2', padding: 8, borderRadius: 8 }}>
                      <Text style={{ color: '#991b1b', fontWeight: '700' }}>Why? The customer is told and their payment hold is released.</Text>
                      {REASONS.map((r) => <Button key={r} title={r} variant="danger" disabled={busy === o.id} onPress={() => void reject(o, r)} />)}
                      <Button title="Back" variant="ghost" onPress={() => setRejecting(null)} />
                    </View>
                  ) : (
                    <>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: C.ink5 }}>Ready in</Text>
                        {PREP.map((m) => (
                          <Pressable key={m} onPress={() => setPrep({ ...prep, [o.id]: m })} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: mins === m ? C.ink : C.ink1 }}>
                            <Text style={{ fontWeight: '700', color: mins === m ? '#fff' : C.ink7 }}>{m}m</Text>
                          </Pressable>
                        ))}
                      </View>
                      <Pressable disabled={busy === o.id} onPress={() => void accept(o)} style={{ backgroundColor: C.good, borderRadius: 12, paddingVertical: 14, alignItems: 'center', opacity: busy === o.id ? 0.6 : 1 }}>
                        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800' }}>{busy === o.id ? 'Accepting…' : `Accept · ready in ${mins} min`}</Text>
                      </Pressable>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <View style={{ flex: 1 }}><Button title="Open order" variant="secondary" onPress={() => { hide(open.map((x) => x.id)); router.push(`/merchant/order/${o.id}`); }} /></View>
                        <View style={{ flex: 1 }}><Button title="Reject" variant="danger" onPress={() => setRejecting(o.id)} /></View>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
            <ErrorText msg={err} />
            <Button title="Silence for now (stays in your order list)" variant="ghost" onPress={() => hide(open.map((o) => o.id))} />
          </ScrollView>
        </View>
      </Animated.View>
    </Modal>
  );
}
