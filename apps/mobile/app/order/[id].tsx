import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CUSTOMER_CATEGORIES, GutadApiError, SUPPORT_CATEGORIES, trackingStages } from '@gutad/shared';
import { CaseThread } from '@/case-thread';
import { api, money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { useCart } from '@/cart';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { DeliveryReview } from '@/delivery-review';

const catLabel = (k: string) => (SUPPORT_CATEGORIES as Record<string, { label: string }>)[k]?.label || k;
const NEEDS_ITEM = ['MISSING_ITEM', 'WRONG_ITEM', 'QUALITY', 'DAMAGED', 'FOOD_SAFETY'];

type CancelPreview = { allowed: boolean; refundCents: number; full: boolean; reason: string; chargedCents?: number; freeCancelUntil: string | null };

interface RebuiltCart { location: { id: string; slug: string; name: string; chefKitchen: boolean }; channel: string; lines: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string }[]; removed: { name: string; reason: string; code: string }[]; warnings: string[]; earliestDate: string | null }

/** Reorder: the past order checked against today's menu, added to the cart (what changed is shown, not hidden). */
function Reorder({ orderId }: { orderId: string }) {
  const { add } = useCart();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; notes: string[]; chef: boolean; earliestDate: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post<RebuiltCart>(`/orders/${orderId}/reorder`, { mode: 'cart' });
      for (const l of r.lines) add({ id: r.location.id, slug: r.location.slug, name: r.location.name }, { menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifierOptionIds: l.modifierOptionIds, modifierNames: l.modifierNames, modifiersCents: l.modifiersCents, specialInstructions: l.specialInstructions }, { park: true });
      setResult({ added: r.lines.reduce((a, l) => a + l.quantity, 0), notes: [...r.removed.map((x) => `${x.name}: ${x.reason}`), ...r.warnings], chef: r.location.chefKitchen, earliestDate: r.earliestDate });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <Button title={busy ? 'Adding…' : 'Reorder'} variant="secondary" disabled={busy} onPress={run} />
      <ErrorText msg={err} />
      {result && (
        <Card>
          <Text style={{ color: C.ink }}>{result.added ? `Added ${result.added} item${result.added === 1 ? '' : 's'} to your cart.` : 'Nothing from this order is available right now.'}</Text>
          {result.added > 0 && result.chef && result.earliestDate && <Muted>Earliest cooking day: {new Date(`${result.earliestDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}. Pick the day at checkout.</Muted>}
          {result.notes.map((n) => <Text key={n} style={{ color: C.warn, fontSize: 13, marginTop: 2 }}>• {n}</Text>)}
          {result.added > 0 && <Button title="Go to checkout" onPress={() => router.push('/checkout')} />}
        </Card>
      )}
    </>
  );
}

const COURIER: Record<string, string> = { QUOTED: 'Waiting for the restaurant', REQUESTED: 'Finding a courier', ASSIGNED: 'Courier heading to pick up', PICKED_UP: 'Courier on the way', DELIVERED: 'Delivered', UNASSIGNED: 'Finding a new courier', CANCELED: 'Delivery canceled', FAILED: 'Delivery problem', RETURNED: 'Returned to the restaurant' };

export default function Order() {
  const { id, email } = useLocalSearchParams<{ id: string; email?: string }>();
  const { user } = useSession();
  const router = useRouter();
  const { data: o, reload } = useApi<{ id: string; number: string; status: string; fulfillmentType: string; locationName: string; totalCents: number; promiseAt: string | null; pickupCode: string | null; shelfSlot?: string | null; tableNumber?: string | null; canCancel: boolean; lines: { id: string; menuItemId: string | null; name: string; quantity: number; lineTotalCents: number; status: string; replacementNote: string | null }[]; payment: { status: string; amountCents?: number; capturedCents?: number; refundedCents: number; chargedAt?: string; sharedWithOrders?: boolean } | null; prepaid?: boolean; scheduledFor?: string | null; amendable?: boolean; amendedFromOrderId?: string | null; chefNetwork?: { chefName: string | null; freeCancelUntil: string | null; lateRefundPct: number | null; acceptBy: string | null; checkoutGroupId: string | null } | null; delivery: { id: string; status: string; etaAt: string | null; hasProof?: boolean; handoffPin?: string | null; courierFirstName?: string | null; arrivedAt?: string | null; exception?: { kind: string; waitUntil?: string; resolution: string | null } | null } | null }>(`/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`, { poll: 5000 });
  const { data: track } = useApi<{ status: string; etaAt: string | null; courierLocation: { lat: number; lng: number } | null }>(o?.delivery ? `/public/delivery/${o.delivery.id}/track` : null, { poll: 7000, deps: [o?.delivery?.id] });
  const [report, setReport] = useState<{ category: string; itemId: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const { data: allTickets, reload: reloadTickets } = useApi<{ id: string; orderId: string | null; category: string; description: string; status: string; remedy: string | null; remedyCents: number }[]>(user ? '/incidents' : null, { deps: [user?.id] });
  const tickets = allTickets?.filter((t) => t.orderId === id) || [];
  // prepaid chef orders: preview the refund, then a two-step confirm
  const prepaidCancel = !!o?.prepaid && !!o?.canCancel && !!user;
  const { data: preview, reload: reloadPreview } = useApi<CancelPreview>(prepaidCancel ? `/orders/${id}/cancellation` : null, { deps: [prepaidCancel, o?.status] });
  const [confirming, setConfirming] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const cancelPrepaid = async () => {
    setCanceling(true); setCancelErr(null);
    try { await api.post(`/orders/${id}/cancel`, { reason: 'Changed my mind' }); setConfirming(false); reload(); }
    catch (e) { setCancelErr((e as Error).message); if (e instanceof GutadApiError && (e.body as unknown as { code?: string } | null)?.code === 'CANCEL_NOT_ALLOWED') setConfirming(false); reloadPreview(); reload(); }
    finally { setCanceling(false); }
  };
  if (!o) return <Loading />;
  const stages = trackingStages({ status: o.status, fulfillmentType: o.fulfillmentType, deliveryStatus: track?.status || o.delivery?.status });
  const current = stages?.find((st) => st.current);
  const bad = ['REJECTED', 'CANCELED'].includes(o.status);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.row}><Text style={{ fontSize: 20, fontWeight: '700' }}>{o.number}</Text><Badge text={bad ? (o.status === 'REJECTED' ? 'Not accepted' : 'Canceled') : current?.label || stages?.[stages.length - 1].label || o.status} tone={bad ? 'bad' : current ? 'info' : 'good'} /></View>
      <Muted>{o.locationName}</Muted>
      {o.chefNetwork && <Text style={{ color: C.ink7, marginTop: 2 }}>Prepared by {o.chefNetwork.chefName || o.locationName} · Sold by Gutad</Text>}
      {o.chefNetwork && o.status === 'SUBMITTED' && o.chefNetwork.acceptBy && <Muted>Chef confirms by {when(o.chefNetwork.acceptBy)}. If not, you get a full refund.</Muted>}
      {o.chefNetwork?.checkoutGroupId && <Muted>Part of a checkout with other chefs</Muted>}
      {o.amendedFromOrderId && <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/order/[id]', params: { id: o.amendedFromOrderId! } })}><Muted>Changed from an earlier order (refunded in full) · view it</Muted></Pressable>}
      {stages && <View style={{ flexDirection: 'row', gap: 4, marginVertical: 10 }}>{stages.map((st) => <View key={st.key} style={{ flex: 1 }}><View style={{ height: 6, borderRadius: 3, backgroundColor: st.done ? C.brand : st.current ? '#fdba74' : C.ink1 }} /><Text style={{ fontSize: 10, textAlign: 'center', marginTop: 3, color: st.done || st.current ? C.ink : C.ink5, fontWeight: st.current ? '700' : '400' }}>{st.label}</Text></View>)}</View>}
      {o.status === 'READY' && o.pickupCode && <Card><Text style={{ fontSize: 16 }}>Ready{o.shelfSlot ? ` on shelf ${o.shelfSlot}` : ''}! Show code</Text><Text style={{ fontSize: 40, fontWeight: '800', letterSpacing: 6 }}>{o.pickupCode}</Text></Card>}
      {o.promiseAt && !bad && o.status !== 'COMPLETED' && <Muted>Estimated {o.fulfillmentType === 'DELIVERY' ? 'delivery' : 'ready'}: {when(o.promiseAt)}</Muted>}
      {o.lines.filter((l) => l.status === 'UNAVAILABLE').map((l) => <Card key={l.id} title="Item unavailable"><Text>{l.name}{l.replacementNote ? ` — suggested: ${l.replacementNote}` : ''}</Text><View style={{ flexDirection: 'row', gap: 8 }}><Button title="Accept replacement" onPress={() => api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'REPLACE' }).then(reload)} /><Button title="Credit me" variant="secondary" onPress={() => api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'CREDIT' }).then(reload)} /></View></Card>)}
      {o.delivery && <Card title="Delivery"><View style={s.row}><Text>{o.delivery.courierFirstName ? `Courier: ${o.delivery.courierFirstName}` : 'Courier'}</Text><Badge text={COURIER[track?.status || o.delivery.status] || track?.status || o.delivery.status} tone={tone(track?.status || o.delivery.status)} /></View>{track?.etaAt && <Muted>ETA {when(track.etaAt)}</Muted>}{track?.courierLocation && <Muted>Courier at {track.courierLocation.lat.toFixed(3)}, {track.courierLocation.lng.toFixed(3)}</Muted>}{o.delivery.exception && !o.delivery.exception.resolution && <Text style={{ color: C.bad, marginTop: 4 }}>Your courier is at the address and trying to reach you. Please answer your phone.</Text>}{o.delivery.arrivedAt && !o.delivery.exception && <Muted>Your courier has arrived.</Muted>}{o.delivery.hasProof && <Muted>Proof of delivery recorded</Muted>}{o.delivery.handoffPin && ['ASSIGNED', 'PICKED_UP'].includes(track?.status || o.delivery.status) && <View style={{ marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: '#fff4ec' }}><Text style={{ color: C.ink7 }}>Give this PIN to {o.delivery.courierFirstName || 'your courier'} at the door</Text><Text style={{ fontSize: 32, fontWeight: '800', letterSpacing: 6, color: C.ink }}>{o.delivery.handoffPin}</Text></View>}</Card>}
      {o.delivery && (track?.status || o.delivery.status) === 'DELIVERED' && user && <DeliveryReview orderId={o.id} />}
      <Card title="Items">{o.lines.map((l) => <View key={l.id} style={s.row}><Text>{l.quantity}× {l.name} {l.status === 'CREDITED' ? '(credited)' : ''}</Text><Text>{money(l.lineTotalCents)}</Text></View>)}<View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>Total</Text><Text style={{ fontWeight: '700' }}>{money(o.totalCents)}</Text></View>{o.payment && (o.prepaid ? <Muted>Charged {money(o.payment.capturedCents ?? o.payment.amountCents ?? o.totalCents)}{o.payment.chargedAt ? ` on ${when(o.payment.chargedAt)}` : ''}{o.payment.sharedWithOrders ? ' (part of one payment for several chefs)' : ''}{o.payment.refundedCents ? ` · refunded ${money(o.payment.refundedCents)}` : ''}</Muted> : <Muted>Payment {o.payment.status}{o.payment.refundedCents ? ` · refunded ${money(o.payment.refundedCents)}` : ''}</Muted>)}</Card>
      {prepaidCancel && preview && (preview.allowed ? (
        <Card>
          {!confirming ? <Button title={`Cancel — refund ${money(preview.refundCents)}`} variant="danger" onPress={() => { setConfirming(true); setCancelErr(null); reloadPreview(); }} /> : <><Text style={{ fontWeight: '600', color: C.ink }}>Cancel this order and refund {money(preview.refundCents)}{preview.chargedCents !== undefined && !preview.full ? ` of ${money(preview.chargedCents)}` : ''}?</Text><View style={{ flexDirection: 'row', gap: 8 }}><Button title={canceling ? 'Canceling…' : 'Confirm cancellation'} variant="danger" disabled={canceling} onPress={cancelPrepaid} /><Button title="Back" variant="ghost" onPress={() => setConfirming(false)} /></View></>}
          <Muted>{preview.reason}{preview.full && preview.freeCancelUntil && o.status === 'ACCEPTED' ? ` until ${when(preview.freeCancelUntil)}` : ''}</Muted>
          <ErrorText msg={cancelErr} />
        </Card>
      ) : <Muted>{preview.reason}</Muted>)}
      {o.amendable && user && <Button title="Change order" variant="secondary" onPress={() => router.push({ pathname: '/order/change/[id]', params: { id: o.id } })} />}
      {user && <Reorder orderId={o.id} />}
      {o.canCancel && user && !o.prepaid && <Button title="Cancel order" variant="danger" onPress={() => api.post(`/orders/${o.id}/cancel`, { reason: 'Changed my mind' }).then(reload)} />}
      {user && !bad && !report && <Button title="Report a problem" variant="secondary" onPress={() => setReport({ category: 'MISSING_ITEM', itemId: '', text: '' })} />}
      {report && (
        <Card title="Report a problem">
          <Muted>What went wrong?</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6 }}>{CUSTOMER_CATEGORIES.map((c) => <Button key={c} title={catLabel(c)} variant={report.category === c ? 'primary' : 'secondary'} onPress={() => setReport({ ...report, category: c })} />)}</View>
          {NEEDS_ITEM.includes(report.category) && <><Muted>Which item?</Muted><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6 }}>{o.lines.filter((l) => l.menuItemId).map((l) => <Button key={l.id} title={`${l.quantity}× ${l.name}`} variant={report.itemId === l.menuItemId ? 'primary' : 'secondary'} onPress={() => setReport({ ...report, itemId: l.menuItemId! })} />)}</View></>}
          {report.category === 'FOOD_SAFETY' && <Text style={{ color: C.warn }}>If anyone is unwell, contact a doctor first. Keep any remaining food and packaging.</Text>}
          <Input label="Tell us more" multiline value={report.text} onChangeText={(v) => setReport({ ...report, text: v })} />
          <ErrorText msg={err} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button title="Send to support" disabled={report.text.trim().length < 3 || (NEEDS_ITEM.includes(report.category) && !report.itemId)} onPress={() => { const line = o.lines.find((l) => l.menuItemId === report.itemId); api.post('/incidents', { orderId: o.id, category: report.category, menuItemId: line?.menuItemId || undefined, description: `${line ? `${line.name}: ` : ''}${report.text}` }).then(() => { setReport(null); setErr(null); reloadTickets(); }).catch((e) => setErr((e as Error).message)); }} />
            <Button title="Cancel" variant="ghost" onPress={() => setReport(null)} />
          </View>
        </Card>
      )}
      {tickets.length > 0 && (
        <Card title="Your support tickets">
          {tickets.map((t) => (
            <View key={t.id} style={{ marginBottom: 8 }}>
              <Pressable onPress={() => setThread(thread === t.id ? null : t.id)}>
                <View style={s.row}><Text style={{ fontWeight: '600' }}>{catLabel(t.category)}</Text><Badge text={t.status === 'OPEN' ? 'With support' : t.status} tone={tone(t.status)} /></View>
                <Muted>{t.description}</Muted>
                {t.remedy && t.remedy !== 'NONE' && <Text style={{ color: C.good }}>Outcome: {t.remedy.toLowerCase()}{t.remedyCents ? ` ${money(t.remedyCents)}` : ''}</Text>}
                <Muted>{thread === t.id ? 'Hide conversation' : 'Tap for conversation'}</Muted>
              </Pressable>
              {thread === t.id && <CaseThread incidentId={t.id} />}
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
