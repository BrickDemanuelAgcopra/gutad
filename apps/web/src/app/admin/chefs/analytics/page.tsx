'use client';
import Link from 'next/link';
import { useState } from 'react';
import { money } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Card, Disclosure, Spinner, Stat, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { Segmented } from '@/components/form-kit';

interface Analytics {
  days: number;
  funnel: { started: number; submitted: number; approved: number; payoutsConnected: number; liveDish: number; firstOrder: number; activeInWindow: number };
  orders: { placed: number; completed: number; gmvCents: number; foodCents: number; customers: number; multiChefOrders: number; avgLeadDays: number | null };
  margin: { commissionCents: number; customerFeesCents: number; gutadRevenueCents: number; takeRatePct: number | null };
  fulfilment: { declinedPct: number | null; unconfirmedPct: number | null; canceledPct: number | null; avgAcceptMinutes: number | null };
  requests: { total: number; quoted: number; ordered: number; expired: number; declined: number; escalated: number; avgResponseMinutes: number | null; quoteToOrderPct: number | null };
  repeat: { buyers: number; repeaters: number; repeatPct: number | null };
  daily: { day: string; orders: number; gmvCents: number }[];
  modifiers: { name: string; count: number }[];
  topDishes: { name: string; chef: string; portions: number; revenueCents: number }[];
  topChefs: { chefId: string; displayName: string; orders: number; gmvCents: number; rating: number | null; declineRatePct: number | null; incidentRatePct: number | null }[];
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Fill the window so days without orders show as zero (a gap reads as missing data). */
function fillDays(daily: Analytics['daily'], days: number) {
  const by = new Map(daily.map((d) => [d.day, d]));
  const out: Analytics['daily'] = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(by.get(d) || { day: d, orders: 0, gmvCents: 0 });
  }
  return out;
}

/** Single-series column chart: one brand hue, 4px rounded tops on a shared baseline, 2px gaps, hover tooltip. */
function DailyOrders({ data }: { data: Analytics['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.orders));
  const h = hover !== null ? data[hover] : null;
  return (
    <div>
      <div className="relative">
        <div className="flex h-40 items-end gap-[2px] border-b border-ink-200" role="img" aria-label={`Orders per day, peak ${max}`} onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => (
            <div key={d.day} className="flex h-full min-w-0 flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}>
              <div className={`w-full rounded-t-[4px] ${hover === i ? 'bg-brand-700' : 'bg-brand-500'}`} style={{ height: d.orders ? `${Math.max(3, (d.orders / max) * 100)}%` : 0 }} />
            </div>
          ))}
        </div>
        {h && (
          <div className="pointer-events-none absolute -top-2 rounded-lg border border-ink-100 bg-white px-2 py-1 text-xs shadow-card" style={{ left: `min(calc(${((hover! + 0.5) / data.length) * 100}% - 40px), calc(100% - 120px))` }}>
            <div className="font-medium text-ink-900">{shortDay(h.day)}</div>
            <div className="text-ink-600">{h.orders} order{h.orders === 1 ? '' : 's'} · {money(h.gmvCents)}</div>
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-500"><span>{shortDay(data[0].day)}</span><span>peak {max}/day</span><span>{shortDay(data[data.length - 1].day)}</span></div>
    </div>
  );
}

/** Activation funnel as horizontal bars (magnitude, one hue), each step labeled with its count and share of applicants. */
function Funnel({ f }: { f: Analytics['funnel'] }) {
  const steps: [string, number][] = [['Started an application', f.started], ['Submitted', f.submitted], ['Approved', f.approved], ['Payouts connected', f.payoutsConnected], ['A dish live', f.liveDish], ['First completed order', f.firstOrder], ['Active in this window', f.activeInWindow]];
  const top = Math.max(1, f.started);
  return (
    <ol className="space-y-2">
      {steps.map(([label, n]) => (
        <li key={label} className="grid grid-cols-[150px_1fr_72px] items-center gap-3 text-sm">
          <span className="text-ink-700">{label}</span>
          <span className="h-3 rounded-r-[4px] bg-brand-500" style={{ width: `${Math.max(n ? 2 : 0, (n / top) * 100)}%` }} title={`${label}: ${n}`} />
          <span className="text-right tabular-nums text-ink-900">{n}<span className="ml-1 text-xs text-ink-500">{Math.round((n / top) * 100)}%</span></span>
        </li>
      ))}
    </ol>
  );
}

export default function ChefAnalyticsPage() {
  const [days, setDays] = useState<'30' | '90'>('30');
  const { data: a, error } = useApi<Analytics>(`/admin/chef-network/analytics?days=${days}`);
  return (
    <div className="space-y-4">
      <SectionTitle title="Chef Network analytics" hint="Activation, orders and margin, fulfilment, special requests and repeat customers." action={<Link href="/admin/chefs" className="text-sm underline">← Chef Network</Link>} />
      <Segmented name="window" size="sm" value={days} onChange={setDays} options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
      {error ? <Alert>{error}</Alert> : !a ? <Spinner /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Orders" value={a.orders.placed} hint={`${a.orders.completed} completed · ${a.orders.customers} customers`} />
            <Stat label="Gross bookings" value={money(a.orders.gmvCents)} hint={`Food ${money(a.orders.foodCents)}`} />
            <Stat label="Gutad revenue" value={money(a.margin.gutadRevenueCents)} hint={`Take rate ${pct(a.margin.takeRatePct)} · commission ${money(a.margin.commissionCents)} + fees ${money(a.margin.customerFeesCents)}`} />
            <Stat label="Repeat customers" value={pct(a.repeat.repeatPct)} hint={`${a.repeat.repeaters} of ${a.repeat.buyers} ordered 2+ times`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Orders per day">
              <DailyOrders data={fillDays(a.daily, a.days)} />
              <Disclosure title="Show as a table"><Table rows={a.daily} empty="No orders in this window." cols={[{ key: 'd', label: 'Day', render: (d) => shortDay(d.day) }, { key: 'o', label: 'Orders', render: (d) => d.orders, className: 'text-right' }, { key: 'g', label: 'Gross', render: (d) => money(d.gmvCents), className: 'text-right' }]} /></Disclosure>
            </Card>
            <Card title="Chef activation"><Funnel f={a.funnel} /></Card>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Declined by chefs" value={pct(a.fulfilment.declinedPct)} />
            <Stat label="Not confirmed in time" value={pct(a.fulfilment.unconfirmedPct)} hint="Refunded automatically" />
            <Stat label="Cancelled" value={pct(a.fulfilment.canceledPct)} />
            <Stat label="Avg time to confirm" value={mins(a.fulfilment.avgAcceptMinutes)} hint={a.orders.avgLeadDays !== null ? `Ordered ${a.orders.avgLeadDays} days ahead on average` : undefined} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Special requests" value={a.requests.total} hint={`${a.requests.quoted} quoted · ${a.requests.declined} declined · ${a.requests.expired} expired`} />
            <Stat label="Quotes that became orders" value={pct(a.requests.quoteToOrderPct)} hint={`${a.requests.ordered} ordered`} />
            <Stat label="Avg chef response" value={mins(a.requests.avgResponseMinutes)} />
            <Stat label="Escalated to Gutad" value={a.requests.escalated} hint={`Multi-chef checkouts: ${a.orders.multiChefOrders} orders`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Top chefs"><Table rows={a.topChefs} empty="No orders yet." cols={[{ key: 'c', label: 'Chef', render: (c) => <span>{c.displayName}{c.rating !== null && <span className="block text-xs text-ink-500">★ {c.rating.toFixed(1)}</span>}</span> }, { key: 'o', label: 'Orders', render: (c) => c.orders, className: 'text-right' }, { key: 'g', label: 'Gross', render: (c) => money(c.gmvCents), className: 'text-right' }]} /></Card>
            <Card title="Top dishes"><Table rows={a.topDishes} empty="No orders yet." cols={[{ key: 'd', label: 'Dish', render: (d) => <span>{d.name}<span className="block text-xs text-ink-500">{d.chef}</span></span> }, { key: 'p', label: 'Portions', render: (d) => d.portions, className: 'text-right' }, { key: 'r', label: 'Sales', render: (d) => money(d.revenueCents), className: 'text-right' }]} /></Card>
            <Card title="Most chosen options"><Table rows={a.modifiers} empty="No customized orders yet." cols={[{ key: 'n', label: 'Option', render: (m) => m.name }, { key: 'c', label: 'Times', render: (m) => m.count, className: 'text-right' }]} /></Card>
          </div>
        </>
      )}
    </div>
  );
}
