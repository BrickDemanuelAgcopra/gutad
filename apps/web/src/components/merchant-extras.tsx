'use client';
import { useState } from 'react';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Table } from '@/components/ui';

interface Line { orderId: string; number: string; createdAt: string; channel: string; status: string; salesCents: number; taxCents: number; tipCents: number; merchantFundedDiscountCents: number; commissionCents: number; processingCents: number; merchantRefundsCents: number; netPayableCents: number }

/** Per-order statement lines: what each order earned and what was deducted. */
export function StatementLines({ orgId }: { orgId: string }) {
  const [days, setDays] = useState(30);
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const { data } = useApi<{ totals: Record<string, number>; lines: Line[] }>(`/organizations/${orgId}/statement-lines?from=${encodeURIComponent(from)}`, { deps: [orgId, days] });
  const { run } = useAction();
  return (
    <Card title="Order-by-order statement" action={<div className="flex items-center gap-2"><select className="rounded border border-ink-100 px-2 py-1 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select><Button size="sm" variant="secondary" onClick={() => run(() => downloadFile(`/organizations/${orgId}/statement-lines.csv?from=${encodeURIComponent(from)}`, `statement-lines-${new Date().toISOString().slice(0, 10)}.csv`))}>CSV</Button></div>}>
      {data && <div className="mb-2 flex flex-wrap gap-4 text-sm"><span>{data.totals.orders} orders</span><span>Sales {money(data.totals.salesCents)}</span><span>Commission −{money(data.totals.commissionCents)}</span><span>Processing −{money(data.totals.processingCents)}</span><span>Refunds you funded −{money(data.totals.merchantRefundsCents)}</span><b>Net {money(data.totals.netPayableCents)}</b></div>}
      <Table rows={(data?.lines || []).slice(0, 100)} empty="No orders in this period." cols={[
        { key: 'n', label: 'Order', render: (l) => <span>{l.number}<span className="block text-xs text-ink-500">{when(l.createdAt)} · {l.channel.toLowerCase()}</span></span> },
        { key: 's', label: 'Sales', render: (l) => money(l.salesCents) },
        { key: 't', label: 'Tax + tip', render: (l) => money(l.taxCents + l.tipCents) },
        { key: 'c', label: 'Commission', render: (l) => l.commissionCents ? `−${money(l.commissionCents)}` : '—' },
        { key: 'p', label: 'Processing', render: (l) => l.processingCents ? `−${money(l.processingCents)}` : '—' },
        { key: 'r', label: 'Refunds / promos', render: (l) => (l.merchantRefundsCents || l.merchantFundedDiscountCents) ? `−${money(l.merchantRefundsCents + l.merchantFundedDiscountCents)}` : '—' },
        { key: 'x', label: 'Net to you', render: (l) => <b>{money(l.netPayableCents)}</b> },
      ]} />
    </Card>
  );
}

/** Multi-location groups and franchise operators apply to the Gutad sales team instead of self-serve signup. */
export function ApplyForm() {
  const { run, error } = useAction();
  const [f, setF] = useState({ businessName: '', contactName: '', email: '', phone: '', city: '', cuisine: '', locationsCount: '1' });
  const [sent, setSent] = useState(false);
  if (sent) return <Alert tone="good">Thanks — the Gutad partnerships team will contact you within one business day.</Alert>;
  return (
    <Card title="Several locations? Talk to our team">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Business" value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} />
        <Input label="Your name" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        <Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <Input label="Locations" type="number" value={f.locationsCount} onChange={(e) => setF({ ...f, locationsCount: e.target.value })} />
      </div>
      <Button className="mt-2" disabled={!f.businessName || !f.contactName || !f.email} onClick={() => run(async () => { await api.post('/public/merchant-applications', { ...f, locationsCount: Number(f.locationsCount) || 1, phone: f.phone || undefined, city: f.city || undefined, cuisine: f.cuisine || undefined }); setSent(true); })}>Send application</Button>
    </Card>
  );
}
