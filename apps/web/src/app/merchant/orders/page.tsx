'use client';
import { useState } from 'react';
import { api, money, when, ago } from '@/lib/api';
import { useApi, useAction } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Tabs } from '@/components/ui';
import { useMerchant } from '../context';
import { PrintButton } from '@/components/capacity-printers';
import { CourierArrivals, RunningLate } from '@/components/courier-arrivals';

interface Line { id: string; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null; status: string; label: string | null }
interface Order { id: string; number: string; status: string; channel: string; fulfillmentType: string; guestName: string | null; totalCents: number; promiseAt: string | null; scheduledFor: string | null; createdAt: string; pickupCode: string | null; specialInstructions: string | null; lines: Line[]; delivery: { status: string } | null }

/** Tablet inbox: acknowledge, accept/reject, adjust time, mark ready, hand off, throttle/pause. Polls every 4s; the layout's NewOrderAlarm rings for new orders. */
export default function OrdersInbox() {
  const { loc, reload: reloadLoc } = useMerchant();
  const [tab, setTab] = useState('active');
  const status = tab === 'active' ? 'SUBMITTED,ACCEPTED,PREPARING,READY' : tab === 'scheduled' ? 'SUBMITTED' : 'COMPLETED,COLLECTED,CANCELED,REJECTED';
  const { data, reload } = useApi<Order[]>(loc ? `/locations/${loc.id}/orders?status=${status}` : null, { poll: 4000, deps: [loc?.id, status] });
  const { run, error, busy } = useAction();
  const [reject, setReject] = useState<Order | null>(null);
  const [reason, setReason] = useState('');
  const [prep, setPrep] = useState(20);
  const [counter, setCounter] = useState(false);
  if (!loc) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const orders = (data || []).filter((o) => (tab === 'scheduled' ? !!o.scheduledFor : tab === 'active' ? !o.scheduledFor || new Date(o.scheduledFor).getTime() - Date.now() < 45 * 60_000 : true));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Orders</h1>
        <div className="flex items-center gap-2">
          {loc.isPaused ? <Button variant="secondary" onClick={() => act(async () => { await api.post(`/locations/${loc.id}/resume`, {}); reloadLoc(); })}>Resume orders</Button> : <Button variant="secondary" onClick={() => act(async () => { await api.post(`/locations/${loc.id}/pause`, { minutes: 30, reason: 'Kitchen at capacity' }); reloadLoc(); })}>Pause 30 min</Button>}
          <Button variant="secondary" onClick={() => setCounter(true)}>Counter / phone order</Button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <Tabs tabs={[{ id: 'active', label: 'Active' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'done', label: 'History' }]} active={tab} onChange={setTab} />
      {tab === 'active' && <CourierArrivals locationId={loc.id} />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {orders.map((o) => (
          <Card key={o.id} className={o.status === 'SUBMITTED' ? 'ring-2 ring-brand-400' : ''} title={<span>{o.number} <span className="text-xs font-normal text-ink-500">· {o.channel} · {o.fulfillmentType}</span></span>} action={<Badge tone={statusTone(o.status)}>{o.status}</Badge>}>
            <div className="text-xs text-ink-500">{o.guestName || 'Customer'} · {ago(o.createdAt)} · {o.scheduledFor ? `scheduled ${when(o.scheduledFor)}` : o.promiseAt ? `promise ${when(o.promiseAt)}` : ''}{o.delivery ? ` · courier ${o.delivery.status}` : ''}</div>
            <ul className="mt-2 space-y-1 text-sm">{o.lines.map((l) => <li key={l.id} className={l.status === 'UNAVAILABLE' ? 'text-red-600 line-through' : ''}><b>{l.quantity}×</b> {l.name}{l.label ? ` [${l.label}]` : ''}{l.modifiers?.length ? <span className="text-ink-500"> — {l.modifiers.map((m) => m.name).join(', ')}</span> : null}{l.specialInstructions && <div className="text-xs italic text-amber-700">“{l.specialInstructions}”</div>}</li>)}</ul>
            {o.specialInstructions && <p className="mt-1 text-xs italic text-amber-700">Order note: {o.specialInstructions}</p>}
            <div className="mt-2 flex items-center justify-between text-sm"><span className="font-semibold">{money(o.totalCents)}</span>{o.pickupCode && <span className="font-mono text-xs">code {o.pickupCode}</span>}</div>
            <div className="mt-3 flex flex-wrap gap-1">
              {o.status === 'SUBMITTED' && (<><Select value={prep} onChange={(e) => setPrep(Number(e.target.value))} className="w-24">{[10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</Select><Button disabled={busy} onClick={() => act(() => api.post(`/orders/${o.id}/accept`, { prepMinutes: prep }))}>Accept</Button><Button variant="danger" onClick={() => setReject(o)}>Reject</Button></>)}
              {['ACCEPTED', 'PREPARING'].includes(o.status) && (<><Button onClick={() => act(() => api.post(`/orders/${o.id}/ready`, {}))}>Mark ready</Button><Button variant="secondary" onClick={() => act(() => api.post(`/orders/${o.id}/prep-time`, { prepMinutes: 15 }))}>+15 min</Button><PrintButton path={`/orders/${o.id}/print-tickets`} label="Print tickets" size="md" /></>)}
              {['ACCEPTED', 'PREPARING'].includes(o.status) && o.fulfillmentType === 'DELIVERY' && o.delivery && <div className="w-full"><RunningLate orderId={o.id} onDone={() => void reload()} /></div>}
              {o.status === 'READY' && <Button onClick={() => act(() => api.post(`/orders/${o.id}/handoff`, {}))}>{o.fulfillmentType === 'DELIVERY' ? 'Courier collected' : 'Handed to customer'}</Button>}
              {!['COMPLETED', 'CANCELED', 'REJECTED', 'SUBMITTED'].includes(o.status) && <Button variant="ghost" onClick={() => act(() => api.post(`/orders/${o.id}/staff-cancel`, { reason: 'Merchant canceled', funder: 'MERCHANT' }))}>Cancel & refund</Button>}
              {['ACCEPTED', 'PREPARING'].includes(o.status) && o.lines.filter((l) => l.status !== 'UNAVAILABLE').length > 1 && <Select value="" onChange={(e) => e.target.value && act(() => api.post(`/order-lines/${e.target.value}/unavailable`, { note: 'Out of stock' }))} className="w-40"><option value="">Mark item 86…</option>{o.lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
            </div>
          </Card>
        ))}
        {!orders.length && <p className="text-sm text-ink-500">No orders in this view.</p>}
      </div>
      <Modal open={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.number}`}>
        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose…</option>{['Too busy', 'Item unavailable', 'Closing soon', 'Cannot fulfill delivery', 'Other'].map((r) => <option key={r}>{r}</option>)}</Select>
        <p className="mt-2 text-xs text-ink-500">Rejecting releases the customer’s payment hold immediately. No kitchen ticket is created.</p>
        <Button className="mt-3" variant="danger" disabled={!reason} onClick={() => act(async () => { await api.post(`/orders/${reject!.id}/reject`, { reason }); setReject(null); })}>Reject order</Button>
      </Modal>
      <CounterOrder open={counter} onClose={() => { setCounter(false); reload(); }} locationId={loc.id} />
    </div>
  );
}

function CounterOrder({ open, onClose, locationId }: { open: boolean; onClose: () => void; locationId: string }) {
  const { data: menus } = useApi<{ categories: { items: { id: string; name: string; priceCents: number; modifierGroups: { required: boolean; options: { id: string }[] }[] }[] }[] }[]>(open ? `/public/locations/${locationId}/menus?channel=WALK_IN` : null, { deps: [open] });
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<'WALK_IN' | 'PHONE'>('WALK_IN');
  const { run, error } = useAction();
  const items = menus?.flatMap((m) => m.categories.flatMap((c) => c.items)) || [];
  return (
    <Modal open={open} onClose={onClose} title="Counter / phone order">
      <div className="grid grid-cols-2 gap-2"><Input label="Guest name" value={name} onChange={(e) => setName(e.target.value)} /><Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <Select className="mt-2" label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as 'WALK_IN' | 'PHONE')}><option value="WALK_IN">Walk-in</option><option value="PHONE">Phone</option></Select>
      <div className="mt-3 max-h-60 space-y-1 overflow-y-auto">{items.map((i) => <div key={i.id} className="flex items-center justify-between text-sm"><span>{i.name} <span className="text-ink-500">{money(i.priceCents)}</span></span><div className="flex items-center gap-1"><Button size="sm" variant="secondary" onClick={() => setPicks({ ...picks, [i.id]: Math.max(0, (picks[i.id] || 0) - 1) })}>−</Button><span className="w-5 text-center">{picks[i.id] || 0}</span><Button size="sm" variant="secondary" onClick={() => setPicks({ ...picks, [i.id]: (picks[i.id] || 0) + 1 })}>+</Button></div></div>)}</div>
      {error && <Alert>{error}</Alert>}
      <Button className="mt-3 w-full" disabled={!name} onClick={() => run(async () => { await api.post(`/locations/${locationId}/orders/counter`, { guestName: name, guestPhone: phone || undefined, channel, lines: Object.entries(picks).filter(([, q]) => q > 0).map(([menuItemId, quantity]) => { const it = items.find((x) => x.id === menuItemId)!; return { menuItemId, quantity, modifierOptionIds: it.modifierGroups.filter((g) => g.required).map((g) => g.options[0]?.id).filter(Boolean) }; }) }); setPicks({}); onClose(); })}>Create & accept</Button>
    </Modal>
  );
}
