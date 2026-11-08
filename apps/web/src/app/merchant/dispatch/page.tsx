'use client';
import { useState } from 'react';
import { api, money, when, ago } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, statusTone } from '@/components/ui';
import { useMerchant } from '../context';

interface Job { id: string; orderId: string | null; externalOrderId: string | null; status: string; fleet: string; provider: string; etaAt: string | null; retailFeeCents: number; providerCostCents: number; tipCents: number; dropoffAddress: { line1: string; city: string }; isLate: boolean; needsAttention: boolean; createdAt: string; cancelReason: string | null }

/** Dispatcher: late/unassigned jobs, merchant-fleet status updates, delivery-only dispatch for outside orders. */
export default function DispatchPage() {
  const { loc } = useMerchant();
  const { data: jobs, reload } = useApi<Job[]>(loc ? `/locations/${loc.id}/dispatch` : null, { poll: 5000, deps: [loc?.id] });
  const { run, error } = useAction();
  const [ext, setExt] = useState({ externalOrderId: '', line1: '', city: '', region: '', postalCode: '', value: '' });
  if (!loc) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Delivery dispatch <span className="text-sm font-normal text-ink-500">fleet: {loc.acceptsDelivery ? 'enabled' : 'off'}</span></h1>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-2">
        {jobs?.map((j) => (
          <div key={j.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-white p-3 text-sm ${j.needsAttention ? 'border-red-300' : j.isLate ? 'border-amber-300' : 'border-ink-100'}`}>
            <div><b>{j.externalOrderId ? `External ${j.externalOrderId}` : `Order ${j.orderId?.slice(0, 8)}`}</b> · {j.dropoffAddress.line1}, {j.dropoffAddress.city} · {j.fleet}/{j.provider} · {ago(j.createdAt)}{j.etaAt && ` · ETA ${when(j.etaAt)}`}<div className="text-xs text-ink-500">diner fee {money(j.retailFeeCents)} · provider cost {money(j.providerCostCents)} · tip {money(j.tipCents)}{j.cancelReason ? ` · ${j.cancelReason}` : ''}</div></div>
            <div className="flex items-center gap-1">
              {j.isLate && <Badge tone="warn">Late</Badge>}<Badge tone={statusTone(j.status)}>{j.status}</Badge>
              {j.fleet === 'MERCHANT' && j.status === 'REQUESTED' && <Button size="sm" onClick={() => act(() => api.post(`/delivery-jobs/${j.id}/transition`, { status: 'ASSIGNED' }))}>Driver assigned</Button>}
              {j.fleet === 'MERCHANT' && j.status === 'ASSIGNED' && <Button size="sm" onClick={() => act(() => api.post(`/delivery-jobs/${j.id}/transition`, { status: 'PICKED_UP' }))}>Picked up</Button>}
              {j.fleet === 'MERCHANT' && j.status === 'PICKED_UP' && <Button size="sm" onClick={() => act(() => api.post(`/delivery-jobs/${j.id}/transition`, { status: 'DELIVERED', proofSignature: 'staff' }))}>Delivered</Button>}
              {['UNASSIGNED', 'QUOTE_EXPIRED', 'REQUESTED'].includes(j.status) && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/delivery-jobs/${j.id}/reassign`, {}))}>Re-dispatch</Button>}
              {!['DELIVERED', 'CANCELED', 'FAILED'].includes(j.status) && <Button size="sm" variant="ghost" onClick={() => { const owner = prompt('Who bears the cost? MERCHANT / PLATFORM / CUSTOMER', 'MERCHANT'); act(() => api.post(`/delivery-jobs/${j.id}/cancel`, { reason: 'Canceled by dispatcher', costOwner: owner || 'MERCHANT' })); }}>Cancel</Button>}
            </div>
          </div>
        ))}
        {!jobs?.length && <p className="text-sm text-ink-500">No active delivery jobs.</p>}
      </div>
      <Card title="Delivery-only dispatch (order sold through your own POS / site)">
        <div className="grid gap-2 sm:grid-cols-3">
          <Input label="Your order id" value={ext.externalOrderId} onChange={(e) => setExt({ ...ext, externalOrderId: e.target.value })} />
          <Input label="Order value (USD)" value={ext.value} onChange={(e) => setExt({ ...ext, value: e.target.value })} />
          <Input label="Street" value={ext.line1} onChange={(e) => setExt({ ...ext, line1: e.target.value })} />
          <Input label="City" value={ext.city} onChange={(e) => setExt({ ...ext, city: e.target.value })} />
          <Input label="State" value={ext.region} onChange={(e) => setExt({ ...ext, region: e.target.value })} />
          <Input label="ZIP" value={ext.postalCode} onChange={(e) => setExt({ ...ext, postalCode: e.target.value })} />
        </div>
        <Button className="mt-2" disabled={!ext.externalOrderId || !ext.line1} onClick={() => act(async () => { await api.post(`/locations/${loc.id}/delivery-jobs/external`, { externalOrderId: ext.externalOrderId, orderValueCents: Math.round(Number(ext.value || 0) * 100), dropoff: { line1: ext.line1, city: ext.city, region: ext.region, postalCode: ext.postalCode, lat: 40.7346, lng: -73.9975 } }, `ext:${ext.externalOrderId}`); setExt({ externalOrderId: '', line1: '', city: '', region: '', postalCode: '', value: '' }); })}>Request courier</Button>
        <p className="mt-1 text-xs text-ink-500">Idempotent by your order id: retrying never dispatches two couriers. You own food-order refunds; we invoice provider cost.</p>
      </Card>
    </div>
  );
}
