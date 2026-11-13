'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Textarea } from '@/components/ui';
import { askReason, pendingNotice } from '@/components/admin-ui';

interface Line { id: string; name: string; quantity: number; lineTotalCents: number; modifiers: { name: string }[] | null; specialInstructions: string | null; status: string; replacementNote: string | null }
interface Detail {
  order: { id: string; number: string; status: string; channel: string; fulfillmentType: string; subtotalCents: number; discountCents: number; taxCents: number; serviceFeeCents: number; deliveryFeeCents: number; tipCents: number; totalCents: number; promoCode: string | null; scheduledFor: string | null; promiseAt: string | null; acceptedAt: string | null; readyAt: string | null; collectedAt: string | null; completedAt: string | null; cancelReason: string | null; rejectReason: string | null; specialInstructions: string | null; createdAt: string; lines: Line[]; locationName: string; pickupCode: string | null };
  events: { id: string; type: string; actorRole: string | null; data: Record<string, unknown>; createdAt: string }[];
  tickets: { id: string; stationCode: string; status: string; startedAt: string | null; doneAt: string | null; createdAt: string }[];
  payment: { id: string; status: string; provider: string; providerIntentId: string | null; amountCents: number; authorizedCents: number; capturedCents: number; refundedCents: number; processingFeeCents: number; disputeStatus: string | null } | null;
  refunds: { id: string; amountCents: number; reason: string | null; funder: string; status: string; createdAt: string }[];
  delivery: { id: string; status: string; etaAt: string | null; fleet: string; trackingUrl: string | null; proofPhotoUrl: string | null; events: { type: string; at: string }[] } | null;
  location: { id: string; name: string; organizationId: string; kitchenId: string | null; platformOperated: boolean };
  organization: { id: string; name: string };
  customer: { id: string | null; name: string | null; email: string | null; phone: string | null; masked: boolean };
  notes: { id: string; visibility: string; body: string; authorEmail: string | null; createdAt: string }[];
  incidents: { id: string; category: string; status: string; remedy: string | null; remedyCents: number; description: string; createdAt: string }[];
  approvals: { id: string; status: string; summary: string }[];
  messages: { id: string; template: string; channel: string; status: string; createdAt: string }[];
  issues: string[];
  partialFulfillment: boolean;
}

/** One order across payment, kitchen and delivery, with notes, customer messages and controlled actions. */
export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/orders/${id}`);
  const { data: tpls } = useApi<{ key: string; title: string; body: string }[]>('/message-templates');
  const { run, error } = useAction();
  const [info, setInfo] = useState<string | null>(null);
  const [note, setNote] = useState({ body: '', visibility: 'INTERNAL', templateKey: '' });
  const [rem, setRem] = useState({ remedy: 'CREDIT', amount: '', owner: 'PLATFORM' });
  if (!d) return null;
  const o = d.order;
  const manage = can('orders.manage');
  const act = (fn: () => Promise<unknown>) => run(async () => { const r = await fn(); setInfo(pendingNotice(r) || 'Done.'); await reload(); });
  const timeline = [
    ...d.events.map((e) => ({ at: e.createdAt, what: `Order ${e.type.toLowerCase().replace(/_/g, ' ')}`, who: e.actorRole, kind: 'order' })),
    ...d.tickets.flatMap((t) => [{ at: t.createdAt, what: `Kitchen ticket ${t.stationCode} queued`, who: 'KITCHEN', kind: 'kitchen' }, ...(t.startedAt ? [{ at: t.startedAt, what: `${t.stationCode} started`, who: 'KITCHEN', kind: 'kitchen' }] : []), ...(t.doneAt ? [{ at: t.doneAt, what: `${t.stationCode} done`, who: 'KITCHEN', kind: 'kitchen' }] : [])]),
    ...(d.delivery?.events || []).map((e) => ({ at: e.at, what: `Delivery ${e.type.toLowerCase().replace(/_/g, ' ')}`, who: 'COURIER', kind: 'delivery' })),
    ...d.refunds.map((r) => ({ at: r.createdAt, what: `Refund ${money(r.amountCents)} (${r.funder.toLowerCase()})`, who: 'PAYMENTS', kind: 'payment' })),
    ...d.notes.map((n) => ({ at: n.createdAt, what: `${n.visibility === 'CUSTOMER' ? 'Message to customer' : 'Note'}: ${n.body}`, who: n.authorEmail, kind: 'note' })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const kindTone: Record<string, 'neutral' | 'info' | 'good' | 'warn'> = { order: 'neutral', kitchen: 'info', delivery: 'good', payment: 'warn', note: 'neutral' };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><Link href="/admin/orders" className="text-xs text-ink-500 underline">← Orders</Link><h1 className="text-2xl font-bold">Order {o.number}</h1><p className="text-sm text-ink-500">{d.organization.name} · {o.locationName} · {o.channel.toLowerCase()} · {o.fulfillmentType.toLowerCase()} · placed {when(o.createdAt)}</p></div>
        <div className="flex flex-wrap gap-1"><Badge tone={statusTone(o.status)}>{o.status}</Badge>{d.partialFulfillment && <Badge tone="warn">partially fulfilled</Badge>}</div>
      </div>
      {error && <Alert>{error}</Alert>}{info && <Alert tone="info">{info}</Alert>}
      {d.issues.length > 0 && <Alert>⚠ {d.issues.join(' · ')}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Customer order">
          <ul className="divide-y divide-ink-50 text-sm">{o.lines.map((l) => <li key={l.id} className="flex justify-between py-1.5"><span>{l.quantity}× {l.name}{l.modifiers?.length ? <span className="block text-xs text-ink-500">{l.modifiers.map((m) => m.name).join(', ')}</span> : null}{l.status !== 'PENDING' && l.status !== 'READY' && <Badge tone={statusTone(l.status)}>{l.status}</Badge>}</span><span className="tabular-nums">{money(l.lineTotalCents)}</span></li>)}</ul>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 text-xs"><dt className="text-ink-500">Subtotal</dt><dd className="text-right">{money(o.subtotalCents)}</dd>{o.discountCents > 0 && <><dt className="text-ink-500">Discount {o.promoCode}</dt><dd className="text-right">−{money(o.discountCents)}</dd></>}<dt className="text-ink-500">Tax</dt><dd className="text-right">{money(o.taxCents)}</dd><dt className="text-ink-500">Fees</dt><dd className="text-right">{money(o.serviceFeeCents + o.deliveryFeeCents)}</dd><dt className="text-ink-500">Tip</dt><dd className="text-right">{money(o.tipCents)}</dd><dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{money(o.totalCents)}</dd></dl>
          <div className="mt-3 rounded-lg bg-ink-50 p-2 text-xs">Customer: {d.customer.name || '—'} {d.customer.masked ? <i className="text-ink-500">(contact hidden for your role)</i> : <>· {d.customer.email} {d.customer.phone && `· ${d.customer.phone}`}</>}{o.specialInstructions && <div>Instructions: {o.specialInstructions}</div>}</div>
        </Card>
        <div className="space-y-4">
          <Card title="Payment">
            {d.payment ? <div className="text-sm"><div className="flex flex-wrap gap-2"><Badge tone={statusTone(d.payment.status)}>{d.payment.status}</Badge>{d.payment.disputeStatus && <Badge tone="bad">dispute {d.payment.disputeStatus}</Badge>}<span className="text-xs text-ink-500">{d.payment.provider} · {d.payment.providerIntentId}</span></div><div className="mt-1 text-xs">Authorized {money(d.payment.authorizedCents)} · captured {money(d.payment.capturedCents)} · refunded {money(d.payment.refundedCents)} · processing fee {money(d.payment.processingFeeCents)}</div>{d.refunds.map((r) => <div key={r.id} className="text-xs text-ink-500">Refund {money(r.amountCents)} · {r.funder.toLowerCase()} · {r.reason} · {r.status}</div>)}</div> : <p className="text-sm text-ink-500">No payment.</p>}
          </Card>
          <Card title="Kitchen">
            {d.tickets.length ? <ul className="text-sm">{d.tickets.map((t) => <li key={t.id} className="flex justify-between"><span>{t.stationCode}</span><Badge tone={statusTone(t.status === 'DONE' ? 'COMPLETED' : t.status)}>{t.status}</Badge></li>)}</ul> : <p className="text-sm text-ink-500">No kitchen tickets yet.</p>}
            {manage && d.tickets.some((t) => t.status !== 'DONE') && <Button className="mt-2" size="sm" variant="ghost" onClick={() => { const from = window.prompt('Move tickets from station (code)', d.tickets[0].stationCode); const to = from && window.prompt('To station (code)'); if (from && to) act(() => api.post(`/admin/orders/${id}/reroute`, { fromStation: from, toStation: to })); }}>Re-route station</Button>}
          </Card>
          <Card title="Delivery">
            {d.delivery ? <div className="text-sm"><Badge tone={statusTone(d.delivery.status)}>{d.delivery.status}</Badge> <span className="text-xs text-ink-500">{d.delivery.fleet.toLowerCase()} fleet · ETA {when(d.delivery.etaAt)}</span>{d.delivery.proofPhotoUrl && <a className="ml-2 text-xs underline" href={d.delivery.proofPhotoUrl} target="_blank" rel="noreferrer">proof of delivery</a>}</div> : <p className="text-sm text-ink-500">{o.fulfillmentType === 'DELIVERY' ? 'No delivery job.' : 'Not a delivery order.'}</p>}
          </Card>
        </div>
      </div>
      {manage && (
        <Card title="Actions">
          <div className="flex flex-wrap gap-2">
            {o.status === 'SUBMITTED' && <Button size="sm" onClick={() => act(() => api.post(`/orders/${id}/accept`, {}))}>Accept for merchant</Button>}
            {['ACCEPTED', 'PREPARING'].includes(o.status) && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/orders/${id}/ready`, {}))}>Mark ready</Button>}
            {o.status === 'READY' && o.pickupCode && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/orders/${id}/handoff`, { pickupCode: o.pickupCode }))}>Confirm handoff</Button>}
            {!['COMPLETED', 'CANCELED', 'REJECTED'].includes(o.status) && <Button size="sm" variant="danger" onClick={() => { const reason = askReason('canceling this order'); const funder = reason && window.prompt('Who pays? MERCHANT, PLATFORM, PROVIDER or DRIVER', 'PLATFORM'); if (reason && funder) act(() => api.post(`/orders/${id}/staff-cancel`, { reason, funder: funder.toUpperCase() })); }}>Cancel order</Button>}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[150px_120px_150px_auto]">
            <Select label="Remedy" value={rem.remedy} onChange={(e) => setRem({ ...rem, remedy: e.target.value })}>{['CREDIT', 'REFUND', 'REMAKE', 'REDELIVERY'].map((r) => <option key={r}>{r}</option>)}</Select>
            <Input label="Amount (USD)" value={rem.amount} onChange={(e) => setRem({ ...rem, amount: e.target.value })} disabled={!['CREDIT', 'REFUND'].includes(rem.remedy)} />
            <Select label="Cost owner" value={rem.owner} onChange={(e) => setRem({ ...rem, owner: e.target.value })}>{['PLATFORM', 'MERCHANT', 'PROVIDER', 'DRIVER'].map((r) => <option key={r}>{r}</option>)}</Select>
            <Button className="self-end" size="sm" variant="secondary" onClick={() => { const reason = askReason(`${rem.remedy.toLowerCase()} on ${o.number}`); if (reason) act(() => api.post(`/admin/orders/${id}/remedy`, { remedy: rem.remedy, remedyCents: Math.round(Number(rem.amount || 0) * 100), owner: rem.owner, reason })); }}>Apply remedy</Button>
          </div>
          <p className="mt-1 text-xs text-ink-500">Refunds and credits above your limit, or repeat compensation on this order, go to Approvals.</p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Timeline">
          <ol className="space-y-1.5 text-sm">{timeline.map((t, i) => <li key={i} className="flex gap-2"><span className="w-16 shrink-0 text-xs tabular-nums text-ink-500">{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><Badge tone={kindTone[t.kind]}>{t.kind}</Badge><span className="min-w-0">{t.what}{t.who && <span className="text-xs text-ink-500"> · {String(t.who).toLowerCase()}</span>}</span></li>)}</ol>
        </Card>
        <Card title="Notes & customer messages">
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2"><Select label="Type" value={note.visibility} onChange={(e) => setNote({ ...note, visibility: e.target.value })}><option value="INTERNAL">Internal note</option><option value="CUSTOMER">Message to customer</option></Select><Select label="Template" value={note.templateKey} onChange={(e) => { const t = tpls?.find((x) => x.key === e.target.value); setNote({ ...note, templateKey: e.target.value, body: t ? t.body : note.body, visibility: t ? 'CUSTOMER' : note.visibility }); }}><option value="">—</option>{tpls?.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}</Select></div>
            <Textarea rows={3} value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} placeholder="{{number}} and {{name}} are filled in" />
            <Button size="sm" disabled={!note.body.trim()} onClick={() => act(async () => { await api.post(`/orders/${id}/notes`, { body: note.body, visibility: note.visibility, templateKey: note.templateKey || undefined }); setNote({ body: '', visibility: 'INTERNAL', templateKey: '' }); })}>{note.visibility === 'CUSTOMER' ? 'Send to customer' : 'Add note'}</Button>
            {d.messages.length > 0 && <div className="border-t border-ink-100 pt-2 text-xs"><div className="font-semibold text-ink-500">Messages sent</div>{d.messages.map((m) => <div key={m.id}>{when(m.createdAt)} · {m.template} · {m.channel.toLowerCase()} · {m.status.toLowerCase()}</div>)}</div>}
          </div>
        </Card>
      </div>
      {(d.incidents.length > 0 || d.approvals.length > 0) && (
        <Card title="Support tickets & approvals">
          {d.incidents.map((i) => <div key={i.id} className="flex justify-between border-b border-ink-50 py-1 text-sm"><span>{i.category.toLowerCase().replace(/_/g, ' ')} — {i.description}</span><span className="flex gap-1"><Badge tone={statusTone(i.status)}>{i.status}</Badge>{i.remedy && <span className="text-xs">{i.remedy} {i.remedyCents ? money(i.remedyCents) : ''}</span>}</span></div>)}
          {d.approvals.map((a) => <div key={a.id} className="text-xs">Approval: {a.summary} · <b>{a.status}</b> <Link className="underline" href="/admin/approvals">open</Link></div>)}
        </Card>
      )}
    </div>
  );
}
