'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { modulesFor } from '@gutad/shared';
import { money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Card, Spinner, Table, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { BarList, FilterBar, KpiTile, pct, TrendBars, useFilter } from '@/components/ops-ui';

interface M { orders: number; completed: number; canceled: number; rejected: number; partial: number; cancellationRate: number; grossSalesCents: number; foodSalesCents: number; discountsCents: number; taxCents: number; tipsCents: number; refundsCents: number; refundCount: number; aovCents: number; platformRevenueCents: number; platformExpenseCents: number; merchantPayableCents: number; revenueByStream: Record<string, number> }
interface Exec { window: { from: string; to: string }; current: M; previous: M; trend: { day: string; orders: number; grossCents: number }[]; locations: number }
interface Row { key: string | null; label: string; orders: number; salesCents: number; canceled: number; aovCents: number }
interface Contribution { orders: number; laborRateCentsPerHour: number; average: Record<string, number>; marginPct: number; negative: number; worst: { id: string; number: string; locationName?: string; revenueCents: number; contributionCents: number; marginPct: number }[]; note: string }

/** Executive dashboard (landing page of the admin console). People without the overview permission go to their first module. */
export default function AdminHome() {
  const { user, can } = useSession();
  const router = useRouter();
  const allowed = can('overview.read');
  useEffect(() => {
    if (user && !allowed) {
      const first = modulesFor(user.permissions || []).find((m) => m.web !== '/admin');
      if (first) router.replace(first.web);
    }
  }, [user, allowed, router]);
  if (!allowed) return <Spinner />;
  return <Executive />;
}

function Executive() {
  const { f, setF, q } = useFilter();
  const [dim, setDim] = useState('location');
  const { data: ex } = useApi<Exec>(`/admin/ops/executive?${q}`, { deps: [q] });
  const { data: rows } = useApi<Row[]>(`/admin/ops/breakdown?dim=${dim}&${q}`, { deps: [q, dim] });
  const { data: cm } = useApi<Contribution>(`/admin/ops/contribution?${q}`, { deps: [q] });
  const c = ex?.current, p = ex?.previous;
  const drill = (extra: string) => `/admin/orders?${q}${extra}`;
  const dimParam: Record<string, string> = { location: 'locationId', merchant: 'organizationId', region: 'regionId', brand: 'brandId', channel: 'channel' };
  return (
    <div className="space-y-4">
      <SectionTitle title="Executive dashboard" hint={ex ? `${when(ex.window.from)} – now · ${ex.locations} locations · compared with the previous period` : undefined} />
      <FilterBar f={f} setF={setF} />
      {!c ? <Spinner /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label="Orders" value={c.orders.toLocaleString()} cur={c.orders} prev={p?.orders} href={drill('')} hint={`${c.completed} completed`} />
            <KpiTile label="Gross sales" value={money(c.grossSalesCents)} cur={c.grossSalesCents} prev={p?.grossSalesCents} href={drill('')} hint="incl. tax, fees, tips" />
            <KpiTile label="Average order value" value={money(c.aovCents)} cur={c.aovCents} prev={p?.aovCents} />
            <KpiTile label="Refunds" value={money(c.refundsCents)} cur={c.refundsCents} prev={p?.refundsCents} invert href={drill('&bucket=refunded')} hint={`${c.refundCount} refunds`} />
            <KpiTile label="Cancellations & rejections" value={pct(c.cancellationRate)} cur={c.cancellationRate} prev={p?.cancellationRate} invert href={drill('&bucket=canceled')} hint={`${c.canceled} canceled · ${c.rejected} rejected`} />
            <KpiTile label="Gross food sales" value={money(c.foodSalesCents)} cur={c.foodSalesCents} prev={p?.foodSalesCents} hint={`after ${money(c.discountsCents)} discounts`} />
            <KpiTile label="Platform revenue" value={money(c.platformRevenueCents)} cur={c.platformRevenueCents} prev={p?.platformRevenueCents} hint={`expenses ${money(c.platformExpenseCents)}`} />
            <KpiTile label="Merchant amounts payable" value={money(c.merchantPayableCents)} cur={c.merchantPayableCents} prev={p?.merchantPayableCents} hint="owed to sellers (ledger)" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card title="Gross sales per day"><TrendBars data={ex!.trend.map((t) => ({ day: t.day, value: t.grossCents }))} label={(v) => money(v)} /></Card>
            <Card title="Platform revenue by stream"><BarList rows={Object.entries(c.revenueByStream).map(([k, v]) => ({ key: k, label: k.toLowerCase().replace(/_/g, ' '), v }))} value={(r: { v: number }) => r.v} fmt={money} /></Card>
          </div>
          <Card title="Performance">
            <Tabs tabs={[{ id: 'location', label: 'Location' }, { id: 'merchant', label: 'Merchant' }, { id: 'brand', label: 'Brand' }, { id: 'region', label: 'Region' }, { id: 'channel', label: 'Channel' }]} active={dim} onChange={setDim} />
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <BarList rows={rows || []} value={(r: Row) => r.salesCents} fmt={money} href={(r: Row) => drill(r.key && r.key !== 'none' ? `&${dimParam[dim]}=${r.key}` : '')} />
              <Table rows={rows || []} cols={[{ key: 'l', label: dim[0].toUpperCase() + dim.slice(1), render: (r) => r.label }, { key: 'o', label: 'Orders', render: (r) => r.orders }, { key: 's', label: 'Sales', render: (r) => money(r.salesCents) }, { key: 'a', label: 'AOV', render: (r) => money(r.aovCents) }, { key: 'c', label: 'Canceled', render: (r) => r.canceled }]} />
            </div>
          </Card>
          {cm && (
            <Card title="Contribution margin per order">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
                {([['Revenue', 'revenueCents'], ['Food', 'foodCents'], ['Labor', 'laborCents'], ['Delivery', 'deliveryCents'], ['Processing', 'processingCents'], ['Promotions', 'promotionsCents'], ['Contribution', 'contributionCents']] as const).map(([l, k]) => <div key={k} className={`rounded-xl p-3 ${k === 'contributionCents' ? 'bg-brand-50' : 'bg-ink-50'}`}><div className="text-xs text-ink-500">{l}</div><div className="font-semibold tabular-nums">{k !== 'revenueCents' && k !== 'contributionCents' ? '−' : ''}{money(cm.average[k])}</div></div>)}
              </div>
              <p className="mt-2 text-xs text-ink-500">Average of {cm.orders} completed orders · margin {pct(cm.marginPct)} · {cm.negative} orders below zero · platform contribution {money(cm.average.platformContributionCents)}/order from the ledger. {cm.note} Labor at {money(cm.laborRateCentsPerHour)}/h.</p>
              {cm.worst.length > 0 && <div className="mt-3"><div className="mb-1 text-xs font-semibold text-ink-500">Lowest-margin orders</div><Table rows={cm.worst.slice(0, 8)} cols={[{ key: 'n', label: 'Order', render: (r) => <a className="underline" href={`/admin/orders/${r.id}`}>{r.number}</a> }, { key: 'l', label: 'Location', render: (r) => r.locationName }, { key: 'r', label: 'Revenue', render: (r) => money(r.revenueCents) }, { key: 'c', label: 'Contribution', render: (r) => money(r.contributionCents) }, { key: 'm', label: 'Margin', render: (r) => pct(r.marginPct) }]} /></div>}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
