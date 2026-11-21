'use client';
import { useState } from 'react';
import type { Manifest } from '@gutad/shared';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';

/** `GET /locations/:id/courier-arrivals` (Courier R2). */
export interface CourierArrival {
  jobId: string; orderId: string | null; orderNumber: string | null; status: string; courierFirstName: string | null; fleet: string; provider: string | null;
  etaToPickupMinutes: number | null; arrivedAt: string | null; estReadyAt: string | null; readyAt: string | null; holdUntil: string | null; shelfSlot: string | null; manifest: Manifest | null;
}

const hhmm = (d: string) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const PROVIDERS: Record<string, string> = { doordash: 'DoorDash', uber: 'Uber Direct', ubereats: 'Uber Direct', mock: 'Partner courier' };
const providerName = (p: string | null) => (p ? PROVIDERS[p.toLowerCase()] || p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : 'Partner courier');

function courierText(r: CourierArrival) {
  if (r.holdUntil && new Date(r.holdUntil).getTime() > Date.now()) return `Offer goes out at ${hhmm(r.holdUntil)}`;
  if (r.fleet === 'PARTNER') return providerName(r.provider);
  if (r.courierFirstName) return r.courierFirstName;
  if (r.fleet === 'MERCHANT') return 'Your own courier';
  return 'Finding a courier';
}

/** Couriers on their way to this location (or its shared kitchen): who, when, ready or not, which shelf and which bags. */
export function CourierArrivals({ locationId }: { locationId: string }) {
  const { data, error, reload } = useApi<CourierArrival[]>(`/locations/${locationId}/courier-arrivals`, { poll: 30000, deps: [locationId] });
  return (
    <Card title="Incoming couriers" action={<Button size="sm" variant="ghost" onClick={() => void reload()}>Refresh</Button>}>
      {error && <Alert>{error}</Alert>}
      {!data ? <p className="text-sm text-ink-500">Loading…</p> : !data.length ? <p className="text-sm text-ink-500">No couriers on the way.</p> : (
        <ul className="divide-y divide-ink-100">
          {data.map((r) => (
            <li key={r.jobId} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{r.orderNumber ? `#${r.orderNumber}` : 'Order'}</b>
                  <span className="text-ink-700">{courierText(r)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {r.arrivedAt ? <Badge tone="info">Arrived</Badge> : r.etaToPickupMinutes != null ? <Badge>{r.etaToPickupMinutes <= 1 ? 'Arriving now' : `${r.etaToPickupMinutes} min away`}</Badge> : null}
                  {r.readyAt ? <Badge tone="good">Ready</Badge> : <Badge tone="warn">{r.estReadyAt ? `Ready ~${hhmm(r.estReadyAt)}` : 'Preparing'}</Badge>}
                  {r.shelfSlot && <Badge tone="info">Shelf {r.shelfSlot}</Badge>}
                </div>
              </div>
              {r.manifest && r.manifest.brands.length > 0 && (
                <div className="mt-1 text-xs text-ink-500">
                  {r.manifest.brands.map((b) => `${b.brandName}: ${b.bagCount} bag${b.bagCount === 1 ? '' : 's'}`).join(' · ')}
                  {r.manifest.brands.length > 1 && ` · ${r.manifest.totals.bags} in total`}
                </div>
              )}
              {!r.readyAt && r.orderId && <div className="mt-1"><RunningLate orderId={r.orderId} onDone={() => void reload()} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Kitchen running late: push a new ready estimate (minutes from now) to the courier and any partner fleet. */
export function RunningLate({ orderId, onDone }: { orderId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [readyAt, setReadyAt] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  const send = (minutes: number) => run(async () => {
    const r = await api.post<{ estReadyAt: string | null }>(`/orders/${orderId}/ready-estimate`, { minutes });
    setReadyAt(r.estReadyAt); setOpen(false); setCustom(''); onDone?.();
  });
  const n = Number(custom);
  return (
    <div className="text-xs">
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Running late</Button>
          {readyAt && <span className="text-ink-500">Now ready ~{hhmm(readyAt)}. The courier has been told.</span>}
        </div>
      ) : (
        <div className="rounded-lg border border-ink-100 p-2">
          <p className="mb-1 text-ink-500">Ready in how many minutes from now?</p>
          <div className="flex flex-wrap items-end gap-1">
            {[5, 10, 15, 20].map((m) => <Button key={m} size="sm" variant="secondary" disabled={busy} onClick={() => void send(m)}>{m} min</Button>)}
            <Input className="w-20" type="number" min={0} max={240} placeholder="Other" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button size="sm" disabled={busy || !custom || !Number.isInteger(n) || n < 0 || n > 240} onClick={() => void send(n)}>Set</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <div className="mt-1"><Alert>{error}</Alert></div>}
    </div>
  );
}
