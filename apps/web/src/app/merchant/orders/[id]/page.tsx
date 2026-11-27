'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, money, ago } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, statusTone } from '@/components/ui';
import { PrintButton } from '@/components/capacity-printers';

interface Stage { key: string; label: string; at: string | null; detail?: string | null; state: 'done' | 'current' | 'todo' | 'skipped' }
interface Track {
  order: {
    id: string; number: string; status: string; fulfillmentType: string; channel: string; guestName: string | null; guestPhone: string | null; locationName: string;
    totalCents: number; subtotalCents: number; taxCents: number; deliveryFeeCents: number; tipCents: number; discountCents: number;
    createdAt: string; acceptedAt: string | null; promiseAt: string | null; readyAt: string | null; pickupCode: string | null; specialInstructions: string | null;
    deliveryAddress: { line1?: string; line2?: string; city?: string; postalCode?: string; instructions?: string } | null;
    lines: { id: string; name: string; quantity: number; lineTotalCents: number; modifiers: { name: string }[] | null; specialInstructions: string | null; status: string }[];
  };
  ended: boolean; finished: boolean; stages: Stage[];
  next: { text: string; action: 'ACCEPT' | 'READY' | 'HANDOFF' | 'NO_COURIER' | 'SELF_DELIVERY' | null };
  noCourier: { since: string; cancelFrom: string; customerWaiting: boolean; keepCents: number; storePaid: boolean } | null;
  selfDelivery: { status: string } | null;
  courier: { status: string; assigned: boolean; partner: string | null; firstName: string | null; vehicleType: string | null; etaAt: string | null; fleet: string; location: { lat: number; lng: number; at: string } | null; trackingUrl: string | null } | null;
  review: { rating: number | null; body: string | null; reply: string | null; courierRating: number | null; foodRating: number | null; packagingRating: number | null; comment: string | null; at: string } | null;
}

const t = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

/**
 * Order tracking for the restaurant, from acceptance to the customer's review. Modelled on the "in progress" view of
 * delivery tablets: one clear next step with its button, a prep countdown, the courier's progress, then the review.
 */
export default function MerchantOrderTrack() {
  const { id } = useParams<{ id: string }>();
  const { data, reload, error: loadErr } = useApi<Track>(`/merchant/orders/${id}/track`, { poll: 5000, deps: [id] });
  const { run, error, busy } = useAction();
  const [now, setNow] = useState(Date.now());
  const [prep, setPrep] = useState(20);
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (loadErr && !data) return <Alert>{loadErr}</Alert>;
  if (!data) return <p className="text-sm text-ink-500">Loading order…</p>;
  const { order: o, next, courier, review } = data;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const delivery = o.fulfillmentType === 'DELIVERY';
  const preparing = ['ACCEPTED', 'PREPARING'].includes(o.status);
  const leftMs = o.promiseAt ? new Date(o.promiseAt).getTime() - now : null;
  const leftMin = leftMs !== null ? Math.ceil(leftMs / 60_000) : null;
  const addTime = (m: number) => act(() => api.post(`/orders/${o.id}/prep-time`, { prepMinutes: Math.max(1, leftMin ?? 0) + m }));
  const a = o.deliveryAddress;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/merchant/orders" className="text-sm text-brand-600 hover:underline">← All orders</Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
            {o.number}
            <span className={`rounded-md px-2 py-0.5 text-sm font-extrabold tracking-wide ${delivery ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>{delivery ? '🛵 DELIVERY' : o.fulfillmentType === 'DINE_IN' ? '🍽️ DINE IN' : '🛍️ PICKUP'}</span>
            <Badge tone={statusTone(o.status)}>{o.status}</Badge>
          </h1>
          <div className="text-sm text-ink-500">{o.guestName || 'Customer'} · {o.locationName} · placed {ago(o.createdAt)}</div>
        </div>
        {preparing && <PrintButton path={`/orders/${o.id}/print-tickets`} label="Print tickets" size="md" />}
      </div>
      {error && <Alert>{error}</Alert>}

      {/* the one thing to do now */}
      <div className={`rounded-2xl border-2 p-4 ${data.ended ? 'border-red-200 bg-red-50' : data.finished ? 'border-green-200 bg-green-50' : 'border-brand-300 bg-brand-50'}`}>
        <div className="text-xs font-bold uppercase tracking-wide text-ink-500">{data.ended ? 'Order closed' : data.finished ? 'Done' : 'Next step'}</div>
        <div className="mt-1 text-lg font-semibold text-ink-900">{next.text}</div>
        {preparing && leftMs !== null && (
          <div className={`mt-2 text-3xl font-extrabold tabular-nums ${leftMs < 0 ? 'text-red-600' : leftMs < 3 * 60_000 ? 'text-amber-600' : 'text-ink-900'}`}>
            {leftMs < 0 ? `${Math.floor(-leftMs / 60_000)} min late` : `${Math.floor(leftMs / 60_000)}:${String(Math.floor((leftMs % 60_000) / 1000)).padStart(2, '0')}`}
            <span className="ml-2 text-sm font-medium text-ink-500">{leftMs < 0 ? 'past the ready time' : `until ready (${t(o.promiseAt)})`}</span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {next.action === 'ACCEPT' && (
            <div className="w-full space-y-2">
              <div className="flex flex-wrap items-center gap-1 text-sm"><span className="mr-1 text-ink-600">Ready in</span>{[10, 15, 20, 30, 45].map((m) => <button key={m} onClick={() => setPrep(m)} className={`rounded-lg px-2.5 py-1 font-semibold ${prep === m ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50'}`}>{m}m</button>)}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="lg" disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/accept`, { prepMinutes: prep }))}>✅ Accept · ready in {prep} min</Button>
                <select className="rounded-lg border border-red-200 bg-white px-2 text-sm text-red-700" value="" disabled={busy} onChange={(e) => e.target.value && act(() => api.post(`/orders/${o.id}/reject`, { reason: e.target.value }))}>
                  <option value="">Reject…</option>{['Too busy', 'Item unavailable', 'Closing soon', 'Cannot fulfill delivery'].map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}
          {next.action === 'READY' && <Button size="lg" disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/ready`, {}))}>✅ Mark ready</Button>}
          {next.action === 'READY' && <><Button variant="secondary" disabled={busy} onClick={() => addTime(5)}>+5 min</Button><Button variant="secondary" disabled={busy} onClick={() => addTime(10)}>+10 min</Button></>}
          {next.action === 'HANDOFF' && <Button size="lg" disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/handoff`, {}))}>{delivery ? `📦 ${courier?.firstName ?? 'Courier'} collected the order` : o.fulfillmentType === 'DINE_IN' ? '🍽️ Served' : '🛍️ Handed to customer'}</Button>}
          {next.action === 'NO_COURIER' && data.noCourier && (() => {
            const nc = data.noCourier;
            const cancelAt = new Date(nc.cancelFrom).getTime();
            const wait = cancelAt - now;
            return (
              <div className="grid w-full gap-2 sm:grid-cols-3">
                <div className="rounded-xl bg-white p-3 ring-1 ring-ink-200">
                  <div className="font-semibold">🚗 Deliver it ourselves</div>
                  <p className="mt-1 text-xs text-ink-500">Send it with your own driver. You keep the delivery fee and tip{nc.keepCents ? ` (${money(nc.keepCents)})` : ''}. The customer is told.</p>
                  <Button className="mt-2" disabled={busy} onClick={() => act(() => api.post(`/merchant/orders/${o.id}/self-deliver`, {}))}>We’ll deliver it</Button>
                </div>
                <div className="rounded-xl bg-white p-3 ring-1 ring-ink-200">
                  <div className="font-semibold">⏳ Keep waiting</div>
                  <p className="mt-1 text-xs text-ink-500">Nothing to tap. Keep the bag warm; we search every minute and show the courier here when one accepts.{nc.customerWaiting ? ' The customer chose to wait.' : ' The customer may switch to pickup.'}</p>
                </div>
                <div className="rounded-xl bg-white p-3 ring-1 ring-ink-200">
                  <div className="font-semibold">✖ Cancel the order</div>
                  <p className="mt-1 text-xs text-ink-500">Gutad refunds the customer.{nc.storePaid ? ' You are still paid for the food.' : ''}</p>
                  {wait > 0
                    ? <p className="mt-2 text-xs font-medium text-ink-600">Available at {t(nc.cancelFrom)} if no courier turns up ({Math.ceil(wait / 60_000)} min)</p>
                    : !confirmCancel
                      ? <Button className="mt-2" variant="secondary" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel order</Button>
                      : <div className="mt-2 flex gap-2"><Button variant="danger" disabled={busy} onClick={() => act(() => api.post(`/merchant/orders/${o.id}/no-courier-cancel`, {}))}>Yes, cancel</Button><Button variant="ghost" onClick={() => setConfirmCancel(false)}>Back</Button></div>}
                </div>
              </div>
            );
          })()}
          {next.action === 'SELF_DELIVERY' && data.selfDelivery?.status !== 'PICKED_UP' && <Button size="lg" disabled={busy || o.status !== 'READY'} onClick={() => act(() => api.post(`/merchant/orders/${o.id}/self-delivery`, { step: 'OUT' }))}>🚗 Our driver left with it</Button>}
          {next.action === 'SELF_DELIVERY' && data.selfDelivery?.status === 'PICKED_UP' && <Button size="lg" disabled={busy} onClick={() => act(() => api.post(`/merchant/orders/${o.id}/self-delivery`, { step: 'DELIVERED' }))}>✅ Delivered to the customer</Button>}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Card className="md:col-span-3" title="Progress">
          <ol className="relative">
            {data.stages.map((st, i) => (
              <li key={st.key} className="flex gap-3 pb-4 last:pb-0">
                <div className="flex flex-col items-center">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${st.state === 'done' ? 'bg-green-600 text-white' : st.state === 'current' ? 'bg-brand-500 text-white ring-4 ring-brand-200 animate-pulse' : 'bg-ink-100 text-ink-400'}`}>{st.state === 'done' ? '✓' : st.state === 'skipped' ? '–' : i + 1}</span>
                  {i < data.stages.length - 1 && <span className={`mt-1 w-0.5 flex-1 ${st.state === 'done' ? 'bg-green-500' : 'bg-ink-100'}`} />}
                </div>
                <div className="pt-0.5">
                  <div className={`font-semibold ${st.state === 'todo' || st.state === 'skipped' ? 'text-ink-400' : 'text-ink-900'}`}>{st.label}</div>
                  <div className="text-xs text-ink-500">{st.at ? t(st.at) : st.state === 'current' ? 'In progress…' : ''}{st.detail ? ` · ${st.detail}` : ''}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-4 md:col-span-2">
          {delivery && (
            <Card title="🛵 Courier">
              {courier?.firstName || courier?.assigned ? (
                <div className="space-y-1 text-sm">
                  <div className="text-base font-semibold">{courier.firstName || 'Courier'}{courier.partner ? <span className="font-normal text-ink-500"> · via {courier.partner}</span> : null}{courier.vehicleType ? <span className="font-normal text-ink-500"> · {courier.vehicleType.toLowerCase()}</span> : null}</div>
                  <div>{courier.status === 'ASSIGNED' ? 'Heading to you' : courier.status === 'PICKED_UP' ? 'On the way to the customer' : courier.status === 'DELIVERED' ? 'Delivered' : courier.status}</div>
                  {courier.etaAt && courier.status !== 'DELIVERED' && <div className="text-ink-600">ETA {t(courier.etaAt)}</div>}
                  {courier.location && <div className="text-xs text-ink-500">Location updated {ago(courier.location.at)}</div>}
                  {courier.trackingUrl && <a className="text-xs text-brand-600 underline" href={courier.trackingUrl} target="_blank" rel="noreferrer">Live map</a>}
                </div>
              ) : (
                <p className="text-sm text-ink-600">{courier?.status === 'FAILED' ? 'No courier found. Support has been alerted.' : courier?.partner ? `Requested from ${courier.partner}; waiting for them to assign a courier.` : 'Not assigned yet. Offers go out as the food nears ready; Mark ready sends them right away.'}</p>
              )}
              {a?.line1 && <div className="mt-2 border-t border-ink-100 pt-2 text-sm"><div className="text-xs font-semibold uppercase text-ink-500">Drop-off</div>{a.line1}{a.line2 ? `, ${a.line2}` : ''}{a.city ? `, ${a.city}` : ''}{a.postalCode ? ` ${a.postalCode}` : ''}{a.instructions && <div className="text-xs italic text-ink-600">“{a.instructions}”</div>}</div>}
            </Card>
          )}
          {!delivery && o.pickupCode && <Card title="Pickup code"><div className="font-mono text-3xl font-bold tracking-widest">{o.pickupCode}</div><p className="text-xs text-ink-500">Ask the customer for this code before handing it over.</p></Card>}

          <Card title="⭐ Customer review">
            {review ? (
              <div className="space-y-1 text-sm">
                {review.rating != null && <div className="text-xl text-amber-500">{'★'.repeat(review.rating)}<span className="text-ink-100">{'★'.repeat(5 - review.rating)}</span></div>}
                {review.body && <p>“{review.body}”</p>}
                {(review.foodRating || review.packagingRating) && <div className="text-xs text-ink-600">{review.foodRating ? `Food ${review.foodRating}/5` : ''}{review.foodRating && review.packagingRating ? ' · ' : ''}{review.packagingRating ? `Packaging ${review.packagingRating}/5` : ''}</div>}
                {review.courierRating && <div className="text-xs text-ink-600">Courier {review.courierRating}/5</div>}
                {review.comment && <p className="text-xs italic text-ink-600">“{review.comment}”</p>}
                <Link href="/merchant/guests" className="text-xs text-brand-600 underline">Reply in Guests → Reviews</Link>
              </div>
            ) : <p className="text-sm text-ink-500">{data.finished ? 'Waiting for the customer to leave a review.' : 'The customer is asked for a review once the order is complete.'}</p>}
          </Card>
        </div>
      </div>

      <Card title={`Order details · ${money(o.totalCents)}`}>
        <ul className="space-y-1 text-sm">
          {o.lines.map((l) => (
            <li key={l.id} className={`flex justify-between gap-2 ${l.status === 'UNAVAILABLE' ? 'text-red-600 line-through' : ''}`}>
              <span><b>{l.quantity}×</b> {l.name}{l.modifiers?.length ? <span className="text-ink-500"> — {l.modifiers.map((m) => m.name).join(', ')}</span> : null}{l.specialInstructions && <span className="block text-xs italic text-amber-700">“{l.specialInstructions}”</span>}</span>
              <span className="text-ink-600">{money(l.lineTotalCents)}</span>
            </li>
          ))}
        </ul>
        {o.specialInstructions && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm italic text-amber-800">Order note: {o.specialInstructions}</p>}
        <div className="mt-2 space-y-0.5 border-t border-ink-100 pt-2 text-sm text-ink-600">
          <div className="flex justify-between"><span>Subtotal</span><span>{money(o.subtotalCents)}</span></div>
          {o.discountCents > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(o.discountCents)}</span></div>}
          <div className="flex justify-between"><span>Tax</span><span>{money(o.taxCents)}</span></div>
          {o.deliveryFeeCents > 0 && <div className="flex justify-between"><span>Delivery fee</span><span>{money(o.deliveryFeeCents)}</span></div>}
          {o.tipCents > 0 && <div className="flex justify-between"><span>Tip</span><span>{money(o.tipCents)}</span></div>}
          <div className="flex justify-between font-semibold text-ink-900"><span>Total</span><span>{money(o.totalCents)}</span></div>
        </div>
      </Card>
    </div>
  );
}
