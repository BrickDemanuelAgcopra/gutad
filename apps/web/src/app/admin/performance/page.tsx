'use client';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { Select, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface P { locationId: string; name: string; merchant: string; orders: number; acceptanceRate: number | null; timedOut: number; cancellationRate: number | null; avgAcceptSeconds: number | null; avgPrepMinutes: number | null; lateRate: number | null; errorRate: number | null }
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

/** Merchant performance league table: acceptance, timeouts, cancellations, speed, lateness and errors per location. */
export default function Performance() {
  const [days, setDays] = useState('30');
  const [sort, setSort] = useState<keyof P>('orders');
  const from = new Date(Date.now() - Number(days) * 86400_000).toISOString();
  const { data } = useApi<P[]>(`/admin/merchants/performance?from=${encodeURIComponent(from)}`, { deps: [days] });
  const rows = [...(data || [])].filter((r) => r.orders > 0).sort((a, b) => ((b[sort] as number) ?? -1) - ((a[sort] as number) ?? -1));
  const flag = (bad: boolean) => (bad ? 'font-semibold text-red-700' : '');
  return (
    <div className="space-y-4">
      <SectionTitle title="Merchant performance" hint="Red marks: acceptance under 90%, cancellations over 5%, late over 20%, errors over 3%." action={<div className="flex gap-2"><Select value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select><Select value={sort} onChange={(e) => setSort(e.target.value as keyof P)}>{[['orders', 'Orders'], ['cancellationRate', 'Cancellations'], ['lateRate', 'Lateness'], ['errorRate', 'Errors'], ['avgPrepMinutes', 'Prep time']].map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</Select></div>} />
      <Table rows={rows} empty="No orders in this period." cols={[
        { key: 'n', label: 'Location', render: (r) => <a className="underline" href={`/admin/locations/${r.locationId}`}>{r.name}<span className="block text-xs text-ink-500 no-underline">{r.merchant}</span></a> },
        { key: 'o', label: 'Orders', render: (r) => r.orders },
        { key: 'a', label: 'Acceptance', render: (r) => <span className={flag(r.acceptanceRate !== null && r.acceptanceRate < 0.9)}>{pct(r.acceptanceRate)}{r.timedOut ? <span className="block text-xs text-ink-500">{r.timedOut} timed out</span> : null}</span> },
        { key: 's', label: 'Time to accept', render: (r) => r.avgAcceptSeconds === null ? '—' : `${Math.round(r.avgAcceptSeconds / 6) / 10} min` },
        { key: 'c', label: 'Canceled / rejected', render: (r) => <span className={flag((r.cancellationRate || 0) > 0.05)}>{pct(r.cancellationRate)}</span> },
        { key: 'p', label: 'Avg prep', render: (r) => r.avgPrepMinutes === null ? '—' : `${r.avgPrepMinutes} min` },
        { key: 'l', label: 'Late', render: (r) => <span className={flag((r.lateRate || 0) > 0.2)}>{pct(r.lateRate)}</span> },
        { key: 'e', label: 'Errors', render: (r) => <span className={flag((r.errorRate || 0) > 0.03)}>{pct(r.errorRate)}</span> },
      ]} />
    </div>
  );
}
