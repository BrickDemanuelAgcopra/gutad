import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api, money } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Loading, Muted, s, tone } from '@/ui';
import { WorkspaceGate } from '@/ops';
import { fulfillmentLabel } from '@/merchant-order-alarm';

interface Stage { key: string; label: string; at: string | null; detail?: string | null; state: 'done' | 'current' | 'todo' | 'skipped' }
interface Track {
  order: {
    id: string; number: string; status: string; fulfillmentType: string; guestName: string | null; locationName: string; pickupCode: string | null;
    totalCents: number; subtotalCents: number; taxCents: number; deliveryFeeCents: number; tipCents: number; promiseAt: string | null; specialInstructions: string | null;
    deliveryAddress: { line1?: string; city?: string; instructions?: string } | null;
    lines: { id: string; name: string; quantity: number; lineTotalCents: number; modifiers: { name: string }[] | null; specialInstructions: string | null; status: string }[];
  };
  ended: boolean; finished: boolean; stages: Stage[];
  next: { text: string; action: 'ACCEPT' | 'READY' | 'HANDOFF' | 'NO_COURIER' | 'SELF_DELIVERY' | null };
  noCourier: { since: string; cancelFrom: string; customerWaiting: boolean; keepCents: number; storePaid: boolean } | null;
  selfDelivery: { status: string } | null;
  priority?: boolean;
  courier: { status: string; assigned: boolean; partner: string | null; firstName: string | null; vehicleType: string | null; etaAt: string | null; location: { at: string } | null } | null;
  review: { rating: number | null; body: string | null; courierRating: number | null; foodRating: number | null; comment: string | null } | null;
}

const t = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const REASONS = ['Too busy', 'Item unavailable', 'Closing soon', 'Cannot fulfill delivery'];

/** Order tracking for the restaurant, from acceptance to the customer's review (same data as the web page). */
function MerchantOrderTrack() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, reload, error: loadErr } = useApi<Track>(id ? `/merchant/orders/${id}/track` : null, { poll: 5000, deps: [id] });
  const { run, error, busy } = useAction();
  const [now, setNow] = useState(Date.now());
  const [prep, setPrep] = useState(20);
  const [rejecting, setRejecting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (!data) return <View style={[s.screen, s.pad]}>{loadErr ? <ErrorText msg={loadErr} /> : <Loading />}</View>;
  const { order: o, next, courier, review } = data;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const delivery = o.fulfillmentType === 'DELIVERY';
  const preparing = ['ACCEPTED', 'PREPARING'].includes(o.status);
  const leftMs = o.promiseAt ? new Date(o.promiseAt).getTime() - now : null;
  const addTime = (m: number) => act(() => api.post(`/orders/${o.id}/prep-time`, { prepMinutes: Math.max(1, Math.ceil((leftMs ?? 0) / 60_000)) + m }));
  const boxColor = data.ended ? ['#fecaca', '#fef2f2'] : data.finished ? ['#bbf7d0', '#f0fdf4'] : ['#fdba74', '#fff7ed'];

  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.pad, { gap: 12 }]}>
      <View>
        <View style={[s.row, { flexWrap: 'wrap', gap: 6 }]}>
          <Text style={{ fontSize: 22, fontWeight: '800' }}>{o.number}</Text>
          <Badge text={o.status} tone={tone(o.status)} />
        </View>
        <Text style={{ fontWeight: '800', color: delivery ? '#1e40af' : '#92400e', marginTop: 4 }}>{fulfillmentLabel(o.fulfillmentType)}</Text>
        <Muted>{o.guestName || 'Customer'} · {o.locationName}</Muted>
      </View>
      <ErrorText msg={error} />

      <View style={{ borderWidth: 2, borderColor: boxColor[0], backgroundColor: boxColor[1], borderRadius: 14, padding: 14, gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', color: C.ink5 }}>{data.ended ? 'ORDER CLOSED' : data.finished ? 'DONE' : 'NEXT STEP'}</Text>
        <Text style={{ fontSize: 17, fontWeight: '700' }}>{next.text}</Text>
        {preparing && leftMs !== null && (
          <Text style={{ fontSize: 30, fontWeight: '800', color: leftMs < 0 ? C.bad : leftMs < 3 * 60_000 ? C.warn : C.ink }}>
            {leftMs < 0 ? `${Math.floor(-leftMs / 60_000)} min late` : `${Math.floor(leftMs / 60_000)}:${String(Math.floor((leftMs % 60_000) / 1000)).padStart(2, '0')}`}
            <Text style={{ fontSize: 13, fontWeight: '500', color: C.ink5 }}>  {leftMs < 0 ? 'past the ready time' : `until ready (${t(o.promiseAt)})`}</Text>
          </Text>
        )}
        {next.action === 'ACCEPT' && !rejecting && (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: C.ink5 }}>Ready in</Text>
              {[10, 15, 20, 30, 45].map((m) => <Pressable key={m} onPress={() => setPrep(m)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: prep === m ? C.ink : '#fff' }}><Text style={{ fontWeight: '700', color: prep === m ? '#fff' : C.ink7 }}>{m}m</Text></Pressable>)}
            </View>
            <Button title={`Accept · ready in ${prep} min`} disabled={busy} onPress={() => act(() => api.post(`/orders/${o.id}/accept`, { prepMinutes: prep }))} />
            <Button title="Reject…" variant="ghost" onPress={() => setRejecting(true)} />
          </>
        )}
        {next.action === 'ACCEPT' && rejecting && (
          <>
            {REASONS.map((r) => <Button key={r} title={r} variant="danger" disabled={busy} onPress={() => act(async () => { await api.post(`/orders/${o.id}/reject`, { reason: r }); setRejecting(false); })} />)}
            <Button title="Back" variant="ghost" onPress={() => setRejecting(false)} />
          </>
        )}
        {next.action === 'READY' && (
          <>
            <Button title="✅ Mark ready" disabled={busy} onPress={() => act(() => api.post(`/orders/${o.id}/ready`, {}))} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><Button title="+5 min" variant="secondary" disabled={busy} onPress={() => addTime(5)} /></View>
              <View style={{ flex: 1 }}><Button title="+10 min" variant="secondary" disabled={busy} onPress={() => addTime(10)} /></View>
            </View>
          </>
        )}
        {next.action === 'HANDOFF' && <Button title={delivery ? `📦 ${courier?.firstName ?? 'Courier'} collected the order` : o.fulfillmentType === 'DINE_IN' ? '🍽️ Served' : '🛍️ Handed to customer'} disabled={busy} onPress={() => act(() => api.post(`/orders/${o.id}/handoff`, {}))} />}
        {next.action === 'NO_COURIER' && data.noCourier && (
          <View style={{ gap: 6, marginTop: 6 }}>
            <Text style={{ fontWeight: '700', color: C.ink }}>🚗 Deliver it ourselves</Text>
            <Muted>Send it with your own driver. You keep the delivery fee and tip{data.noCourier.keepCents ? ` (${money(data.noCourier.keepCents)})` : ''}.</Muted>
            <Button title="We’ll deliver it" disabled={busy} onPress={() => act(() => api.post(`/merchant/orders/${o.id}/self-deliver`, {}))} />
            <Text style={{ fontWeight: '700', color: C.ink, marginTop: 6 }}>⏳ Keep waiting</Text>
            <Muted>Nothing to tap. We search every minute and show the courier here when one accepts.{data.noCourier.customerWaiting ? ' The customer chose to wait.' : ' The customer may switch to pickup.'}</Muted>
            <Text style={{ fontWeight: '700', color: C.ink, marginTop: 6 }}>✖ Cancel the order</Text>
            <Muted>Gutad refunds the customer.{data.noCourier.storePaid ? ' You are still paid for the food.' : ''}</Muted>
            {new Date(data.noCourier.cancelFrom).getTime() > Date.now()
              ? <Muted>Available at {new Date(data.noCourier.cancelFrom).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} if no courier turns up</Muted>
              : !confirmCancel
                ? <Button title="Cancel order" variant="secondary" disabled={busy} onPress={() => setConfirmCancel(true)} />
                : <View style={{ flexDirection: 'row', gap: 8 }}><Button title="Yes, cancel" variant="danger" disabled={busy} onPress={() => act(() => api.post(`/merchant/orders/${o.id}/no-courier-cancel`, {}))} /><Button title="Back" variant="ghost" onPress={() => setConfirmCancel(false)} /></View>}
          </View>
        )}
        {next.action === 'SELF_DELIVERY' && data.selfDelivery?.status !== 'PICKED_UP' && <Button title="🚗 Our driver left with it" disabled={busy || o.status !== 'READY'} onPress={() => act(() => api.post(`/merchant/orders/${o.id}/self-delivery`, { step: 'OUT' }))} />}
        {next.action === 'SELF_DELIVERY' && data.selfDelivery?.status === 'PICKED_UP' && <Button title="✅ Delivered to the customer" disabled={busy} onPress={() => act(() => api.post(`/merchant/orders/${o.id}/self-delivery`, { step: 'DELIVERED' }))} />}
      </View>

      <Card title="Progress">
        {data.stages.map((st, i) => (
          <View key={st.key} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ alignItems: 'center' }}>
              <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: st.state === 'done' ? C.good : st.state === 'current' ? C.brand : C.ink1 }}>
                <Text style={{ color: st.state === 'done' || st.state === 'current' ? '#fff' : C.ink3, fontWeight: '800' }}>{st.state === 'done' ? '✓' : st.state === 'skipped' ? '–' : i + 1}</Text>
              </View>
              {i < data.stages.length - 1 && <View style={{ width: 2, flex: 1, minHeight: 14, backgroundColor: st.state === 'done' ? C.good : C.ink1 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: 12 }}>
              <Text style={{ fontWeight: '700', color: st.state === 'todo' || st.state === 'skipped' ? C.ink3 : C.ink }}>{st.label}</Text>
              <Muted>{st.at ? t(st.at) : st.state === 'current' ? 'In progress…' : ''}{st.detail ? ` · ${st.detail}` : ''}</Muted>
            </View>
          </View>
        ))}
      </Card>

      {delivery && (
        <Card title="🛵 Courier">
          {courier?.firstName || courier?.assigned ? (
            <>
              <Text style={{ fontWeight: '700', fontSize: 16 }}>{courier.firstName || 'Courier'}{courier.partner ? ` · via ${courier.partner}` : ''}{courier.vehicleType ? ` · ${courier.vehicleType.toLowerCase()}` : ''}</Text>
              <Text>{courier.status === 'ASSIGNED' ? 'Heading to you' : courier.status === 'PICKED_UP' ? 'On the way to the customer' : courier.status === 'DELIVERED' ? 'Delivered' : courier.status}</Text>
              {!!courier.etaAt && courier.status !== 'DELIVERED' && <Muted>ETA {t(courier.etaAt)}</Muted>}
            </>
          ) : <Muted>{courier?.status === 'FAILED' ? 'No courier found. Support has been alerted.' : courier?.partner ? `Requested from ${courier.partner}; waiting for them to assign a courier.` : 'Not assigned yet. Offers go out as the food nears ready; Mark ready sends them right away.'}</Muted>}
          {!!o.deliveryAddress?.line1 && <Text style={{ marginTop: 6 }}>Drop-off: {o.deliveryAddress.line1}{o.deliveryAddress.city ? `, ${o.deliveryAddress.city}` : ''}{o.deliveryAddress.instructions ? `\n“${o.deliveryAddress.instructions}”` : ''}</Text>}
        </Card>
      )}
      {!delivery && !!o.pickupCode && <Card title="Pickup code"><Text style={{ fontSize: 28, fontWeight: '800', letterSpacing: 4, fontFamily: 'monospace' }}>{o.pickupCode}</Text><Muted>Ask the customer for this code before handing it over.</Muted></Card>}

      <Card title="⭐ Customer review">
        {review ? (
          <>
            {review.rating != null && <Text style={{ fontSize: 20, color: '#f59e0b' }}>{'★'.repeat(review.rating)}<Text style={{ color: C.ink1 }}>{'★'.repeat(5 - review.rating)}</Text></Text>}
            {!!review.body && <Text>“{review.body}”</Text>}
            {!!review.foodRating && <Muted>Food {review.foodRating}/5</Muted>}
            {!!review.courierRating && <Muted>Courier {review.courierRating}/5</Muted>}
            {!!review.comment && <Muted>“{review.comment}”</Muted>}
          </>
        ) : <Muted>{data.finished ? 'Waiting for the customer to leave a review.' : 'The customer is asked for a review once the order is complete.'}</Muted>}
      </Card>

      <Card title={`Order details · ${money(o.totalCents)}`}>
        {o.lines.map((l) => (
          <View key={l.id} style={[s.row, { marginTop: 4 }]}>
            <Text style={{ flex: 1, textDecorationLine: l.status === 'UNAVAILABLE' ? 'line-through' : 'none' }}><Text style={{ fontWeight: '800' }}>{l.quantity}× </Text>{l.name}{l.modifiers?.length ? <Text style={{ color: C.ink5 }}> — {l.modifiers.map((m) => m.name).join(', ')}</Text> : null}{l.specialInstructions ? <Text style={{ color: C.warn }}> “{l.specialInstructions}”</Text> : null}</Text>
            <Text style={{ color: C.ink5 }}>{money(l.lineTotalCents)}</Text>
          </View>
        ))}
        {!!o.specialInstructions && <Text style={{ marginTop: 6, color: '#92400e' }}>Order note: {o.specialInstructions}</Text>}
        <Muted>Subtotal {money(o.subtotalCents)} · tax {money(o.taxCents)}{o.deliveryFeeCents ? ` · delivery ${money(o.deliveryFeeCents)}` : ''}{o.tipCents ? ` · tip ${money(o.tipCents)}` : ''}</Muted>
      </Card>

      <Button title="← All orders" variant="ghost" onPress={() => (router.canGoBack() ? router.back() : router.replace('/merchant'))} />
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/orders"><MerchantOrderTrack /></WorkspaceGate>;
}
