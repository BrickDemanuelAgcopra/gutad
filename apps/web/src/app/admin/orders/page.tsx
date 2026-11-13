'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Row { id: string; number: string; status: string; channel: string; fulfillmentType: string; locationName?: string; totalCents: number; createdAt: string; promiseAt: string | null; partialFulfillment: boolean; deliveryStatus: string | null; paymentStatus: string | null; refundedCents: number; customer: { name: string | null; email: string | null } }

/** Platform-wide order search. Every dashboard metric links here with its filter in the URL. */
export default function OrdersSearch() {
  const [qs, setQs] = useState<string | null>(null);
  const [form, setForm] = useState({ q: '', customer: '', status: '', from: '', to: '' });
  const [page, setPage] = useState(0);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setForm({ q: sp.get('q') || '', customer: sp.get('customer') || '', status: sp.get('status') || '', from: sp.get('from')?.slice(0, 10) || '', to: sp.get('to')?.slice(0, 10) || '' });
    setQs(sp.toString());
  }, []);
  const { data, loading } = useApi<{ total: number; items: Row[] }>(qs === null ? null : `/admin/orders?${qs}&limit=50&offset=${page * 50}`, { deps: [qs, page] });
  const search = () => {
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(form)) { if (v) sp.set(k, k === 'from' || k === 'to' ? new Date(v).toISOString() : v); else sp.delete(k); }
    window.history.replaceState(null, '', `?${sp}`);
    setPage(0);
    setQs(sp.toString());
  };
  const chips = qs ? Array.from(new URLSearchParams(qs).entries()).filter(([k]) => !['q', 'customer', 'status', 'from', 'to'].includes(k)) : [];
  return (
    <div className="space-y-4">
      <SectionTitle title="Orders" hint="Search by order number, payment or provider transaction id, delivery job, customer name/email/phone, location, courier and time." />
      <Card>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Input label="Order #, transaction or job id" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <Input label="Customer" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="">Any</option>{['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED', 'COMPLETED', 'CANCELED', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <Input label="From" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          <Input label="To" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={search}>Search</Button>
          {chips.map(([k, v]) => <span key={k} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs">{k}: {v.length > 20 ? v.slice(0, 10) : v}</span>)}
          {chips.length > 0 && <button className="text-xs underline" onClick={() => { window.history.replaceState(null, '', '?'); setForm({ q: '', customer: '', status: '', from: '', to: '' }); setQs(''); }}>Clear all</button>}
          {data && <span className="ml-auto text-xs text-ink-500">{data.total} orders</span>}
        </div>
      </Card>
      <Table rows={data?.items || []} empty={loading ? 'Loading…' : 'No orders match.'} cols={[
        { key: 'n', label: 'Order', render: (r) => <Link className="underline" href={`/admin/orders/${r.id}`}>{r.number}</Link> },
        { key: 't', label: 'Placed', render: (r) => <span className="text-xs">{when(r.createdAt)}</span> },
        { key: 'l', label: 'Location', render: (r) => <span className="text-xs">{r.locationName}</span> },
        { key: 'c', label: 'Customer', render: (r) => <span className="text-xs">{r.customer.name}<span className="block text-ink-500">{r.customer.email}</span></span> },
        { key: 's', label: 'Status', render: (r) => <span className="flex flex-wrap gap-1"><Badge tone={statusTone(r.status)}>{r.status}</Badge>{r.partialFulfillment && <Badge tone="warn">partial</Badge>}</span> },
        { key: 'p', label: 'Payment / delivery', render: (r) => <span className="text-xs">{r.paymentStatus || '—'}{r.deliveryStatus ? ` · ${r.deliveryStatus}` : ''}</span> },
        { key: 'm', label: 'Total', render: (r) => <span>{money(r.totalCents)}{r.refundedCents > 0 && <span className="block text-xs text-red-700">−{money(r.refundedCents)} refunded</span>}</span> },
      ]} />
      {data && data.total > 50 && <div className="flex justify-between"><Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-xs text-ink-500">Page {page + 1} of {Math.ceil(data.total / 50)}</span><Button size="sm" variant="secondary" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div>
  );
}
