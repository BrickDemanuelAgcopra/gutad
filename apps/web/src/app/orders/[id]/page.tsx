'use client';
import type { CustomerHandoffRequirements } from '@gutad/shared';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { CUSTOMER_CATEGORIES, SUPPORT_CATEGORIES, trackingStages } from '@gutad/shared';
import { DeliveryReviewCard } from '@/components/delivery-review';
import { CaseThread } from '@/components/case-thread';
import { api, money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Select, Spinner, statusTone, Textarea } from '@/components/ui';
import { useCart } from '@/lib/cart';
import { preferredDate } from '@/components/date-slot-picker';

interface Order {
  id: string; number: string; status: string; fulfillmentType: string; locationName: string; locationSlug: string; locationPhone: string | null; totalCents: number; subtotalCents: number; taxCents: number; tipCents: number; deliveryFeeCents: number; serviceFeeCents: number; discountCents: number; promiseAt: string | null; readyAt: string | null; pickupCode: string | null; shelfSlot?: string | null; tableNumber?: string | null; canCancel: boolean; createdAt: string;
  lines: { id: string; menuItemId: string | null; name: string; quantity: number; lineTotalCents: number; status: string; replacementNote: string | null; modifiers: { name: string }[] }[];
  payment: { status: string; capturedCents: number; refundedCents: number; chargedAt?: string; sharedWithOrders?: boolean } | null;
  prepaid?: boolean; scheduledFor?: string | null; checkoutGroupId?: string | null; amendable?: boolean; amendedFromOrderId?: string | null;
  chefNetwork?: { chefName: string | null; freeCancelUntil: string | null; lateRefundPct: number | null; acceptBy: string | null; checkoutGroupId: string | null } | null;
  delivery: { id: string; status: string; etaAt: string | null; trackingUrl: string | null; hasProof?: boolean; arrivedAt?: string | null; handoffPin?: string | null; handoffRequirements?: CustomerHandoffRequirements | null; courierFirstName?: string | null; exception?: { kind: string; waitUntil?: string; resolution: string | null } | null } | null;
}


const COURIER: Record<string, string> = { QUOTED: 'Waiting for the restaurant', REQUESTED: 'Finding a courier', ASSIGNED: 'Courier heading to pick up', PICKED_UP: 'Courier on the way', DELIVERED: 'Delivered', UNASSIGNED: 'Finding a new courier', CANCELED: 'Delivery canceled', FAILED: 'Delivery problem: support has been notified', RETURNED: 'Returned to the restaurant', QUOTE_EXPIRED: 'Delivery quote expired' };
const courierLabel = (s: string) => COURIER[s] || s.replace(/_/g, ' ').toLowerCase();

const catLabel = (k: string) => (SUPPORT_CATEGORIES as Record<string, { label: string }>)[k]?.label || k;
const NEEDS_ITEM = ['MISSING_ITEM', 'WRONG_ITEM', 'QUALITY', 'DAMAGED', 'FOOD_SAFETY'];

interface RebuiltCart { location: { id: string; slug: string; name: string; chefKitchen: boolean }; channel: 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR'; lines: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string }[]; removed: { name: string; reason: string }[]; warnings: string[]; earliestDate: string | null }

/** Reorder: the past order checked against today's menu, added to the cart (what changed is shown, not hidden). */
function Reorder({ orderId, onMessage }: { orderId: string; onMessage: (m: React.ReactNode) => void }) {
  const { add } = useCart();
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="secondary" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.post<RebuiltCart>(`/orders/${orderId}/reorder`, { mode: 'cart' });
        for (const l of r.lines) add({ id: r.location.id, slug: r.location.slug, name: r.location.name }, l, r.channel, 'reorder', { park: true });
        if (r.location.chefKitchen && r.earliestDate) preferredDate.set(r.location.id, r.earliestDate);
        const notes = [...r.removed.map((x) => `${x.name}: ${x.reason}`), ...r.warnings];
        onMessage(<>{r.lines.length ? <>Added {r.lines.reduce((a, l) => a + l.quantity, 0)} item(s) to your cart. <Link className="underline" href="/checkout">Go to checkout</Link></> : 'Nothing from this order is available right now.'}{notes.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}</>);
      } catch (e) { onMessage((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Adding…' : 'Reorder'}</Button>
  );
}

/** Gutad Chef Network cancellation: shows what cancelling refunds right now (full before the cutoff), then confirms. */
function ChefCancel({ order, email, onDone }: { order: Order; email: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: pv } = useApi<{ allowed: boolean; refundCents: number; full: boolean; reason: string; chargedCents?: number }>(open ? `/orders/${order.id}/cancellation${email ? `?email=${encodeURIComponent(email)}` : ''}` : null);
  if (!open) return <Button variant="danger" onClick={() => setOpen(true)}>Cancel order…</Button>;
  return (
    <Card title="Cancel this order?" className="w-full">
      {!pv ? <p className="text-sm text-ink-500">Checking the refund…</p> : !pv.allowed ? <Alert tone="info">{pv.reason}. Contact support for changes.</Alert> : (
        <div className="space-y-2 text-sm">
          <p>{pv.full ? <>You’ll get a <b>full refund of {money(pv.refundCents)}</b>.</> : pv.refundCents ? <>The order cutoff has passed: you’ll get <b>{money(pv.refundCents)}</b> back ({pv.reason.toLowerCase()}).</> : <>The order cutoff has passed, so <b>no refund</b> applies under the terms you accepted.</>}</p>
          {err && <Alert>{err}</Alert>}
          <div className="flex gap-2"><Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await api.post(`/orders/${order.id}/cancel`, { reason: 'Changed my mind' }); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>{busy ? 'Cancelling…' : `Cancel${pv.refundCents ? ` and refund ${money(pv.refundCents)}` : ' without refund'}`}</Button><Button variant="ghost" onClick={() => setOpen(false)}>Keep my order</Button></div>
        </div>
      )}
    </Card>
  );
}

function ReportProblem({ order, onDone, onCancel }: { order: Order; onDone: (msg: string) => void; onCancel: () => void }) {
  const [category, setCategory] = useState<string>('MISSING_ITEM');
  const [itemId, setItemId] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const items = order.lines.filter((l) => l.menuItemId);
  const submit = async () => {
    setErr(null);
    const line = items.find((l) => l.menuItemId === itemId);
    try {
      await api.post('/incidents', { orderId: order.id, category, menuItemId: line?.menuItemId || undefined, description: `${line ? `${line.name}: ` : ''}${text}` });
      onDone(category === 'FOOD_SAFETY' ? 'Thank you. Food safety reports go straight to our culinary team, who will contact you shortly.' : 'Thanks. Your ticket is open and you can follow the conversation below.');
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card title="Report a problem">
      <div className="space-y-2">
        <Select label="What went wrong?" value={category} onChange={(e) => setCategory(e.target.value)}>{CUSTOMER_CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</Select>
        {NEEDS_ITEM.includes(category) && <Select label="Which item?" value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">Choose an item</option>{items.map((l) => <option key={l.id} value={l.menuItemId!}>{l.quantity}× {l.name}</option>)}</Select>}
        {category === 'FOOD_SAFETY' && <Alert tone="info">If anyone is unwell, contact a doctor first. Please keep any remaining food and packaging.</Alert>}
        <Textarea label="Tell us more" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        {err && <Alert>{err}</Alert>}
        <div className="flex gap-2"><Button disabled={text.length < 3 || (NEEDS_ITEM.includes(category) && !itemId && items.length > 0)} onClick={submit}>Send to support</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </div>
    </Card>
  );
}

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const email = sp.get('email');
  const { user } = useSession();
  const { data: o, reload } = useApi<Order>(`/orders/${id}${email ? `?email=${encodeURIComponent(email)}` : ''}`, { poll: 5000 });
  const { data: track } = useApi<{ status: string; etaAt: string | null; courierLocation: { lat: number; lng: number } | null; events: { type: string; at: string }[] }>(o?.delivery ? `/public/delivery/${o.delivery.id}/track` : null, { poll: 7000, deps: [o?.delivery?.id] });
  const [review, setReview] = useState({ rating: 5, body: '' });
  const [msg, setMsg] = useState<React.ReactNode>(null);
  const [reporting, setReporting] = useState(false);
  const [thread, setThread] = useState<string | null>(null);
  const { data: allTickets, reload: reloadTickets } = useApi<{ id: string; orderId: string | null; category: string; description: string; status: string; remedy: string | null; remedyCents: number }[]>(user ? '/incidents' : null);
  const tickets = allTickets?.filter((t) => t.orderId === id);
  if (!o) return <Spinner />;
  const stages = trackingStages({ status: o.status, fulfillmentType: o.fulfillmentType, deliveryStatus: track?.status || o.delivery?.status });
  const current = stages?.find((s) => s.current);
  const terminalBad = ['REJECTED', 'CANCELED'].includes(o.status);
  const unavailable = o.lines.filter((l) => l.status === 'UNAVAILABLE');
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between">
        <div><h1 className="text-2xl font-bold">Order {o.number}</h1><p className="text-sm text-ink-500">{o.locationName} · {when(o.createdAt)}</p></div>
        <Badge tone={terminalBad ? 'bad' : current ? 'info' : 'good'}>{terminalBad ? (o.status === 'REJECTED' ? 'Not accepted' : 'Canceled') : current?.label || stages?.[stages.length - 1].label}</Badge>
      </div>
      {stages && (
        <ol className="flex gap-1" aria-label="Order progress">
          {stages.map((st) => (
            <li key={st.key} className="flex-1" aria-current={st.current ? 'step' : undefined}>
              <div className={`h-1.5 rounded-full ${st.done ? 'bg-brand-500' : st.current ? 'animate-pulse bg-brand-300' : 'bg-ink-100'}`} />
              <div className={`mt-1 text-center text-[11px] leading-tight ${st.done || st.current ? 'font-semibold text-ink-900' : 'text-ink-500'}`}>{st.label}</div>
            </li>
          ))}
        </ol>
      )}
      {o.status === 'READY' && o.fulfillmentType === 'PICKUP' && <Alert tone="good">Ready for pickup{o.shelfSlot ? <> on shelf <b className="text-lg">{o.shelfSlot}</b></> : ''} — show code <b className="text-lg">{o.pickupCode}</b> at the counter.</Alert>}
      {o.fulfillmentType === 'DINE_IN' && o.tableNumber && !terminalBad && o.status !== 'COMPLETED' && <Alert tone="info">Dine-in · we’ll bring it to table <b>{o.tableNumber}</b>.</Alert>}
      {o.chefNetwork && (
        <Card>
          <div className="space-y-1 text-sm">
            <p>Prepared by <b>{o.chefNetwork.chefName}</b> · sold by Gutad{o.scheduledFor ? <> · for <b>{when(o.scheduledFor)}</b></> : null}</p>
            {o.status === 'SUBMITTED' && o.chefNetwork.acceptBy && <p className="text-ink-700">{o.chefNetwork.chefName} confirms by {when(o.chefNetwork.acceptBy)}. If they can’t, you’re refunded in full automatically.</p>}
            {!terminalBad && o.chefNetwork.freeCancelUntil && <p className="text-xs text-ink-500">Free cancellation until {when(o.chefNetwork.freeCancelUntil)}{o.chefNetwork.lateRefundPct ? `; ${o.chefNetwork.lateRefundPct}% refund after that` : '; no refund after that'}.</p>}
            {o.chefNetwork.checkoutGroupId && <p className="text-xs"><Link className="underline" href={`/orders/group/${o.chefNetwork.checkoutGroupId}${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Part of a checkout with other chefs</Link></p>}
          </div>
        </Card>
      )}
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
          <div className="flex items-center justify-between text-sm"><span>Courier</span><Badge tone={statusTone(track?.status || o.delivery.status)}>{courierLabel(track?.status || o.delivery.status)}</Badge></div>
          {o.delivery.courierFirstName && ['ASSIGNED', 'PICKED_UP'].includes(track?.status || o.delivery.status) && <p className="mt-1 text-sm">Your courier is {o.delivery.courierFirstName}.</p>}
          {o.delivery.handoffRequirements && <HandoffNotes r={o.delivery.handoffRequirements} />}
          {o.delivery.handoffPin && ['ASSIGNED', 'PICKED_UP'].includes(track?.status || o.delivery.status) && <div className="mt-2"><Alert tone="info">Your handoff PIN: <b className="text-lg tracking-widest">{o.delivery.handoffPin}</b> — give it to your courier.</Alert></div>}
          {track?.etaAt && <p className="mt-1 text-sm">ETA {when(track.etaAt)}</p>}
          {track?.courierLocation && <p className="text-xs text-ink-500">Courier at {track.courierLocation.lat.toFixed(4)}, {track.courierLocation.lng.toFixed(4)}</p>}
          {o.delivery.exception && !o.delivery.exception.resolution && <div className="mt-2"><Alert>Your courier is at the address and trying to reach you{o.delivery.exception.waitUntil ? ` until ${new Date(o.delivery.exception.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Please answer your phone or call {o.locationPhone || 'the restaurant'}.</Alert></div>}
          {o.delivery.arrivedAt && !o.delivery.exception && track?.status !== 'DELIVERED' && <p className="mt-1 text-sm font-medium">Your courier has arrived.</p>}
          {o.delivery.hasProof && <p className="mt-2 text-xs text-ink-500">Proof of delivery was recorded. If something is wrong, report a problem and support will review it.</p>}
          {o.delivery.trackingUrl && <a className="ml-3 text-sm text-brand-600 underline" href={o.delivery.trackingUrl} target="_blank" rel="noreferrer">Provider tracking</a>}
          <ul className="mt-2 text-xs text-ink-500">{track?.events.slice(-5).map((e, i) => <li key={i}>{courierLabel(e.type)} · {when(e.at)}</li>)}</ul>
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
          {o.prepaid && o.payment && <div className="flex justify-between"><span>Charged{o.payment.chargedAt ? ` ${when(o.payment.chargedAt)}` : ''}{o.payment.sharedWithOrders ? ' (one payment with your other chef orders)' : ''}</span><span>{money(o.payment.capturedCents)}</span></div>}
          {o.payment && <div className="flex justify-between"><span>Payment</span><span><Badge tone={statusTone(o.payment.status)}>{o.payment.status}</Badge>{o.payment.refundedCents > 0 && ` refunded ${money(o.payment.refundedCents)}`}</span></div>}
        </div>
      </Card>
      <div className="flex flex-wrap gap-2">
        {o.canCancel && o.prepaid && user && <ChefCancel order={o} email={email} onDone={reload} />}
        {o.canCancel && !o.prepaid && user && <Button variant="danger" onClick={async () => { await api.post(`/orders/${o.id}/cancel`, { reason: 'Changed my mind' }); reload(); }}>Cancel order</Button>}
        {o.amendable && user && <Link href={`/orders/${o.id}/change`}><Button variant="secondary">Change order</Button></Link>}
        {user && <Reorder orderId={o.id} onMessage={setMsg} />}
        {user && !terminalBad && !reporting && <Button variant="secondary" onClick={() => setReporting(true)}>Report a problem</Button>}
        <Link href={`/r/${o.locationSlug}`}><Button variant="ghost">Back to {o.locationName}</Button></Link>
      </div>
      {msg && <Alert tone="info">{msg}</Alert>}
      {user && reporting && <ReportProblem order={o} onDone={(t) => { setReporting(false); setMsg(t); reloadTickets(); }} onCancel={() => setReporting(false)} />}
      {user && !!tickets?.length && (
        <Card title="Your support tickets">
          {tickets.map((t) => (
            <div key={t.id} className="border-b border-ink-100 py-2 last:border-0">
              <div className="flex items-center justify-between text-sm"><span className="font-medium">{catLabel(t.category)}</span><Badge tone={statusTone(t.status)}>{t.status === 'OPEN' ? 'With support' : t.status}</Badge></div>
              <p className="text-xs text-ink-500">{t.description}</p>
              {t.remedy && t.remedy !== 'NONE' && <p className="text-xs text-emerald-700">Outcome: {t.remedy.toLowerCase()}{t.remedyCents ? ` ${money(t.remedyCents)}` : ''}</p>}
              <button className="mt-1 text-xs underline" onClick={() => setThread(thread === t.id ? null : t.id)}>{thread === t.id ? 'Hide conversation' : 'Conversation'}</button>
              {thread === t.id && <CaseThread incidentId={t.id} simple />}
            </div>
          ))}
        </Card>
      )}
      {user && o.delivery && (track?.status || o.delivery.status) === 'DELIVERED' && <DeliveryReviewCard orderId={o.id} />}
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

/** Courier R4: what to have ready when a special-category order arrives. */
function HandoffNotes({ r }: { r: CustomerHandoffRequirements }) {
  const notes = [
    r.ageCheck && `Have a photo ID ready — you must be ${r.ageCheck.minAge} or over.`,
    r.recipientName && `Only ${r.recipientName} can receive this order.`,
    r.signature && 'A signature is required at the door.',
    r.pin && 'Have your delivery PIN ready.',
    r.noSafePlace && 'It won’t be left at the door, so please be there to receive it.',
    r.temperatureControlled && 'Temperature-controlled delivery: please put it in the fridge straight away.',
  ].filter(Boolean) as string[];
  if (!notes.length) return null;
  return <ul className="mt-2 list-disc rounded-lg bg-amber-50 py-2 pl-6 pr-2 text-sm text-amber-900">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;
}
