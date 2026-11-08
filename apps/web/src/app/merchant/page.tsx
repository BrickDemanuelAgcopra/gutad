'use client';
import { money } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Card, Spinner, Stat, Table } from '@/components/ui';
import { useMerchant } from './context';

export default function MerchantDashboard() {
  const { loc, org } = useMerchant();
  const { data: d } = useApi<{ sales: { grossCents: number; orders: number; commissionCents: number; byChannel: { channel: string; orders: number; completed: number; canceled: number; cents: number; commission: number; conversion: number }[] }; acceptance: { submitted: number; accepted: number; rejected: number; avgAcceptSec: number; avgPrepMin: number; lateReady: number }; delivery: { jobs: number; delivered: number; failed: number; onTimeRate: number | null; subsidyCents: number }; reservations: { bookings: number; seated: number; noShows: number; billableCovers: number; coverFees: number; avgWaitMin: number }; waitlist: { joined: number; seated: number; abandoned: number }; refunds: { n: number; cents: number }; incidents: { open: number }; topItems: { name: string; qty: number; cents: number }[]; marginHint: { contributionCents: number } }>(loc ? `/locations/${loc.id}/reports/dashboard` : null, { deps: [loc?.id] });
  const { data: bal } = useApi<{ payableCents: number; negativeBalance: boolean }>(org ? `/organizations/${org.id}/balance` : null, { deps: [org?.id] });
  if (!loc) return null;
  if (!d) return <Spinner />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{loc.name} · last 30 days</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Gross sales" value={money(d.sales.grossCents)} hint={`${d.sales.orders} orders`} />
        <Stat label="Commission paid" value={money(d.sales.commissionCents)} hint="marketplace orders only" />
        <Stat label="Payable balance" value={money(bal?.payableCents || 0)} hint={bal?.negativeBalance ? 'negative: refunds exceed sales' : 'next weekly payout'} />
        <Stat label="Contribution" value={money(d.marginHint.contributionCents)} hint="after commission & merchant-funded refunds" />
        <Stat label="Acceptance" value={`${d.acceptance.submitted ? Math.round((d.acceptance.accepted / d.acceptance.submitted) * 100) : 0}%`} hint={`avg ${d.acceptance.avgAcceptSec}s to accept · ${d.acceptance.avgPrepMin}m prep · ${d.acceptance.lateReady} late`} />
        <Stat label="Delivery on-time" value={d.delivery.onTimeRate === null ? '—' : `${Math.round(d.delivery.onTimeRate * 100)}%`} hint={`${d.delivery.delivered}/${d.delivery.jobs} delivered · ${d.delivery.failed} failed`} />
        <Stat label="Seated covers" value={d.reservations.billableCovers} hint={`${d.reservations.bookings} bookings · ${d.reservations.noShows} no-shows · fees ${money(d.reservations.coverFees)}`} />
        <Stat label="Refunds / incidents" value={money(d.refunds.cents)} hint={`${d.refunds.n} refunds · ${d.incidents.open} open cases`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Conversion by channel"><Table rows={d.sales.byChannel} cols={[{ key: 'c', label: 'Channel', render: (r) => r.channel }, { key: 'o', label: 'Orders', render: (r) => r.orders }, { key: 'x', label: 'Completed', render: (r) => r.completed }, { key: 'k', label: 'Canceled', render: (r) => r.canceled }, { key: 'v', label: 'Sales', render: (r) => money(r.cents) }, { key: 'f', label: 'Fees', render: (r) => money(r.commission) }]} /></Card>
        <Card title="Top items"><Table rows={d.topItems} cols={[{ key: 'n', label: 'Item', render: (r) => r.name }, { key: 'q', label: 'Qty', render: (r) => r.qty }, { key: 'c', label: 'Sales', render: (r) => money(r.cents) }]} /></Card>
      </div>
    </div>
  );
}
