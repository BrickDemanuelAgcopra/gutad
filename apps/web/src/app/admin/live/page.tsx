'use client';
import Link from 'next/link';
import { api, money } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, statusTone, Table } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';
import { FilterBar, filterQuery, useFilter } from '@/components/ops-ui';

interface Item { id: string; number: string; status: string; fulfillmentType: string; channel: string; locationName?: string; totalCents: number; createdAt: string; promiseAt: string | null; deliveryStatus: string | null; bucket: string; overdue: boolean; minutesLate: number }
interface Live { counts: Record<string, number>; items: Item[]; at: string }
interface Cap { couriers: { approved: number; available: number; busy: number; jobsWaitingForCourier: number }; totals: { locations: number; paused: number; overloaded: number; stockouts: number; devicesOffline: number }; locations: { id: string; name: string; city: string; status: string; platformOperated: boolean; isPaused: boolean; pausedReason: string | null; activeOrders: number; ordersLast15m: number; throttlePer15m: number | null; loadPct: number | null; soldOutItems: number; devices: number; devicesOffline: number }[] }

const BUCKETS = [['awaitingAcceptance', 'Awaiting acceptance'], ['cooking', 'Cooking'], ['ready', 'Ready for pickup'], ['awaitingCourier', 'Awaiting courier'], ['outForDelivery', 'Out for delivery'], ['overdue', 'Overdue']] as const;

export default function LiveOps() {
  const { can } = useSession();
  const { f, setF } = useFilter();
  const q = filterQuery({ ...f, range: '90d' }).replace(/from=[^&]*&?/, '');
  const { data: live } = useApi<Live>(`/admin/ops/live?${q}`, { poll: 10000, deps: [q] });
  const { data: cap, reload: reloadCap } = useApi<Cap>(`/admin/ops/capacity?${q}`, { poll: 20000, deps: [q] });
  const { run, error } = useAction();
  return (
    <div className="space-y-4">
      <SectionTitle title="Live operations" hint={`Refreshes every 10 seconds${live ? ` · ${new Date(live.at).toLocaleTimeString()}` : ''}`} />
      <FilterBar f={f} setF={setF} range={false} />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {BUCKETS.map(([k, l]) => <Link key={k} href={k === 'overdue' ? `/admin/orders?overdue=true&${q}` : `/admin/orders?bucket=${k}&${q}`} className={`rounded-2xl border p-4 shadow-card hover:border-brand-200 ${k === 'overdue' && (live?.counts.overdue || 0) > 0 ? 'border-red-200 bg-red-50' : 'border-ink-100 bg-white'}`}><div className="text-xs text-ink-500">{l}</div><div className="text-2xl font-bold tabular-nums">{live?.counts[k] ?? '—'}</div></Link>)}
      </div>
      <Card title="Active orders (most urgent first)">
        <Table rows={(live?.items || []).slice(0, 60)} empty="No active orders." cols={[
          { key: 'n', label: 'Order', render: (r) => <Link className="underline" href={`/admin/orders/${r.id}`}>{r.number}</Link> },
          { key: 'l', label: 'Location', render: (r) => <span className="text-xs">{r.locationName}</span> },
          { key: 's', label: 'Stage', render: (r) => <span className="flex flex-wrap gap-1"><Badge tone={statusTone(r.status)}>{r.status}</Badge>{r.deliveryStatus && <Badge tone={statusTone(r.deliveryStatus)}>{r.deliveryStatus}</Badge>}</span> },
          { key: 'f', label: 'Type', render: (r) => <span className="text-xs">{r.fulfillmentType.toLowerCase()} · {r.channel.toLowerCase()}</span> },
          { key: 'p', label: 'Promise', render: (r) => r.overdue ? <span className="text-xs font-semibold text-red-700">{r.minutesLate} min late</span> : <span className="text-xs">{r.promiseAt ? new Date(r.promiseAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</span> },
          { key: 't', label: 'Total', render: (r) => money(r.totalCents) },
        ]} />
      </Card>
      {cap && (
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <Card title="Couriers & outages">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-ink-500">Couriers available now</dt><dd className="text-xl font-bold">{cap.couriers.available}<span className="text-sm font-normal text-ink-500"> / {cap.couriers.approved}</span></dd></div>
              <div><dt className="text-xs text-ink-500">On a delivery</dt><dd className="text-xl font-bold">{cap.couriers.busy}</dd></div>
              <div><dt className="text-xs text-ink-500">Jobs waiting for a courier</dt><dd className={`text-xl font-bold ${cap.couriers.jobsWaitingForCourier ? 'text-red-700' : ''}`}>{cap.couriers.jobsWaitingForCourier}</dd></div>
              <div><dt className="text-xs text-ink-500">Paused locations</dt><dd className="text-xl font-bold">{cap.totals.paused}</dd></div>
              <div><dt className="text-xs text-ink-500">Items sold out</dt><dd className="text-xl font-bold">{cap.totals.stockouts}</dd></div>
              <div><dt className="text-xs text-ink-500">Devices offline</dt><dd className="text-xl font-bold">{cap.totals.devicesOffline}</dd></div>
            </dl>
          </Card>
          <Card title="Kitchen capacity by location">
            <Table rows={cap.locations.slice(0, 40)} cols={[
              { key: 'n', label: 'Location', render: (l) => <span>{l.name}{l.platformOperated && <Badge tone="good">Gutad</Badge>}{l.isPaused && <Badge tone="bad">paused</Badge>}<span className="block text-xs text-ink-500">{l.pausedReason || l.city}</span></span> },
              { key: 'a', label: 'Cooking', render: (l) => l.activeOrders },
              { key: 'r', label: 'Last 15 min', render: (l) => <span>{l.ordersLast15m}{l.throttlePer15m ? ` / ${l.throttlePer15m}` : ''}{l.loadPct !== null && <span className={`ml-1 text-xs ${l.loadPct >= 90 ? 'font-semibold text-red-700' : 'text-ink-500'}`}>{l.loadPct}%</span>}</span> },
              { key: 's', label: 'Sold out', render: (l) => l.soldOutItems || '—' },
              { key: 'd', label: 'Devices', render: (l) => l.devices ? <span className={l.devicesOffline ? 'text-red-700' : ''}>{l.devices - l.devicesOffline}/{l.devices} online</span> : '—' },
              { key: 'x', label: '', render: (l) => can('ops.manage') ? (l.isPaused ? <Button size="sm" variant="secondary" onClick={() => { const reason = askReason(`reopening ${l.name}`); if (reason) run(async () => { await api.post(`/locations/${l.id}/resume`, { reason }); reloadCap(); }); }}>Resume</Button> : <Button size="sm" variant="ghost" onClick={() => { const reason = askReason(`pausing ${l.name}`); if (reason) run(async () => { await api.post(`/locations/${l.id}/pause`, { reason, minutes: 30 }); reloadCap(); }); }}>Pause 30 min</Button>) : null },
            ]} />
          </Card>
        </div>
      )}
    </div>
  );
}
