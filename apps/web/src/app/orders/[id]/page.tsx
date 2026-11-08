'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Spinner, statusTone, Textarea } from '@/components/ui';

interface Order {
  id: string; number: string; status: string; fulfillmentType: string; locationName: string; locationSlug: string; locationPhone: string | null; totalCents: number; subtotalCents: number; taxCents: number; tipCents: number; deliveryFeeCents: number; serviceFeeCents: number; discountCents: number; promiseAt: string | null; readyAt: string | null; pickupCode: string | null; canCancel: boolean; createdAt: string;
  lines: { id: string; name: string; quantity: number; lineTotalCents: number; status: string; replacementNote: string | null; modifiers: { name: string }[] }[];
  payment: { status: string; capturedCents: number; refundedCents: number } | null;
  delivery: { id: string; status: string; etaAt: string | null; trackingUrl: string | null; proofPhotoUrl: string | null } | null;
}

const STEPS = ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED', 'COMPLETED'];

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const email = sp.get('email');
  const { user } = useSession();
  const { data: o, reload } = useApi<Order>(`/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`, { poll: 5000 });
  const { data: track } = useApi<{ status: string; etaAt: string | null; courierLocation: { lat: number; lng: number } | null; events: { type: string; at: string }[] }>(o?.delivery ? `/public/delivery/${o.delivery.id}/track` : null, { poll: 7000, deps: [o?.delivery?.id] });
  const [review, setReview] = useState({ rating: 5, body: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (!o) return <Spinner />;
  const stepIdx = STEPS.indexOf(o.status);
  const terminalBad = ['REJECTED', 'CANCELED'].includes(o.status);
  const unavailable = o.lines.filter((l) => l.status === 'UNAVAILABLE');
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between">
        <div><h1 className="text-2xl font-bold">Order {o.number}</h1><p className="text-sm text-ink-500">{o.locationName} · {when(o.createdAt)}</p></div>
        <Badge tone={statusTone(o.status)}>{o.status}</Badge>
      </div>
      {!terminalBad && (
        <ol className="grid grid-cols-6 gap-1 text-center text-[11px]">
          {STEPS.filter((s) => o.fulfillmentType !== 'DELIVERY' || s !== 'COMPLETED' || true).map((s, i) => <li key={s} className={`rounded-md py-1 ${i <= stepIdx ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-500'}`}>{s === 'COLLECTED' && o.fulfillmentType === 'DELIVERY' ? 'PICKED UP' : s}</li>)}
        </ol>
      )}
      {o.status === 'READY' && o.fulfillmentType === 'PICKUP' && <Alert tone="good">Ready for pickup — show code <b className="text-lg">{o.pickupCode}</b> at the counter.</Alert>}
      {o.promiseAt && !terminalBad && o.status !== 'COMPLETED' && <p className="text-sm text-ink-700">Estimated {o.fulfillmentType === 'DELIVERY' ? 'delivery' : 'ready'} time: <b>{when(o.promiseAt)}</b></p>}
      {unavailable.length > 0 && (
        <Card title="One item needs your decision">
          {unavailable.map((l) => (
            <div key={l.id} className="flex items-center justify-between py-2 text-sm">
              <span>{l.name} is unavailable{l.replacementNote ? ` — suggested: ${l.replacementNote}` : ''}</span>
              <div className="flex gap-2"><Button size="sm" onClick={async () => { await api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'REPLACE' }); reload(); }}>Accept replacement</Button><Button size="sm" variant="secondary" onClick={async () => { await api.post(`/orders/${o.id}/resolve-line`, { lineId: l.id, choice: 'CREDIT' }); reload(); }}>Credit me</Button></div>
            </div>
          ))}
        </Card>
      )}
      {o.delivery && (
        <Card title="Delivery">
          <div className="flex items-center justify-between text-sm"><span>Courier status</span><Badge tone={statusTone(track?.status || o.delivery.status)}>{track?.status || o.delivery.status}</Badge></div>
          {track?.etaAt && <p className="mt-1 text-sm">ETA {when(track.etaAt)}</p>}
          {track?.courierLocation && <p className="text-xs text-ink-500">Courier at {track.courierLocation.lat.toFixed(4)}, {track.courierLocation.lng.toFixed(4)}</p>}
          {o.delivery.proofPhotoUrl && <a className="mt-2 inline-block text-sm text-brand-600 underline" href={o.delivery.proofPhotoUrl} target="_blank" rel="noreferrer">Proof of delivery photo</a>}
          {o.delivery.trackingUrl && <a className="ml-3 text-sm text-brand-600 underline" href={o.delivery.trackingUrl} target="_blank" rel="noreferrer">Provider tracking</a>}
          <ul className="mt-2 text-xs text-ink-500">{track?.events.slice(-5).map((e, i) => <li key={i}>{e.type} · {when(e.at)}</li>)}</ul>
        </Card>
      )}
      <Card title="Items">
        <ul className="divide-y divide-ink-100 text-sm">{o.lines.map((l) => <li key={l.id} className="flex justify-between py-1.5"><span>{l.quantity}× {l.name}{l.modifiers?.length ? <span className="text-ink-500"> ({l.modifiers.map((m) => m.name).join(', ')})</span> : null} {l.status === 'CREDITED' && <Badge tone="warn">Credited</Badge>}</span><span>{money(l.lineTotalCents)}</span></li>)}</ul>
        <div className="mt-2 space-y-0.5 text-sm text-ink-500">
          {o.discountCents > 0 && <div className="flex justify-between"><span>Promo</span><span>−{money(o.discountCents)}</span></div>}
          <div className="flex justify-between"><span>Tax</span><span>{money(o.taxCents)}</span></div>
          {o.serviceFeeCents > 0 && <div className="flex justify-between"><span>Service fee</span><span>{money(o.serviceFeeCents)}</span></div>}
          {o.deliveryFeeCents > 0 && <div className="flex justify-between"><span>Delivery</span><span>{money(o.deliveryFeeCents)}</span></div>}
          <div className="flex justify-between"><span>Tip</span><span>{money(o.tipCents)}</span></div>
          <div className="flex justify-between font-semibold text-ink-900"><span>Total</span><span>{money(o.totalCents)}</span></div>
          {o.payment && <div className="flex justify-between"><span>Payment</span><span><Badge tone={statusTone(o.payment.status)}>{o.payment.status}</Badge>{o.payment.refundedCents > 0 && ` refunded ${money(o.payment.refundedCents)}`}</span></div>}
        </div>
      </Card>
      <div className="flex flex-wrap gap-2">
        {o.canCancel && user && <Button variant="danger" onClick={async () => { await api.post(`/orders/${o.id}/cancel`, { reason: 'Changed my mind' }); reload(); }}>Cancel order</Button>}
        {user && <Button variant="secondary" onClick={async () => { const q = await api.post<{ id: string; warnings: string[] }>(`/orders/${o.id}/reorder`, {}); setMsg(`Rebuilt as quote ${q.id.slice(0, 8)}${q.warnings.length ? ' — ' + q.warnings.join('; ') : ''}. Open the restaurant page to add items to your cart.`); }}>Reorder</Button>}
        {user && !terminalBad && <Button variant="secondary" onClick={async () => { await api.post('/incidents', { orderId: o.id, category: 'OTHER', description: 'Customer reported a problem from the order page' }); setMsg('Support case opened. We will follow up by email.'); }}>Report a problem</Button>}
        <Link href={`/r/${o.locationSlug}`}><Button variant="ghost">Back to {o.locationName}</Button></Link>
      </div>
      {msg && <Alert tone="info">{msg}</Alert>}
      {o.status === 'COMPLETED' && user && (
        <Card title="Rate your order">
          <div className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} onClick={() => setReview({ ...review, rating: n })} className={`text-2xl ${n <= review.rating ? 'text-amber-500' : 'text-ink-100'}`}>★</button>)}</div>
          <Textarea rows={2} value={review.body} onChange={(e) => setReview({ ...review, body: e.target.value })} placeholder="How was it?" />
          <Button className="mt-2" onClick={async () => { try { await api.post('/reviews', { locationId: (await api.get<{ id: string }>(`/public/locations/${o.locationSlug}`)).id, orderId: o.id, ...review }); setMsg('Thanks for your verified review!'); } catch (e) { setMsg((e as Error).message); } }}>Submit review</Button>
        </Card>
      )}
    </div>
  );
}
