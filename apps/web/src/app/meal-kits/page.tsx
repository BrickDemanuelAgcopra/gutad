'use client';
import { useState } from 'react';
import { api, money, newIdempotencyKey } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Spinner } from '@/components/ui';
import Link from 'next/link';

export default function MealKitsPage() {
  const { user } = useSession();
  const [region, setRegion] = useState('NY');
  const { data } = useApi<{ id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null; available: number; earliestDeliveryDate: string; shipRegions: string[] }[]>(`/public/meal-kits?region=${region}`, { deps: [region] });
  const [qty, setQty] = useState<Record<string, number>>({});
  const [addr, setAddr] = useState({ line1: '', city: '', region: 'NY', postalCode: '' });
  const [date, setDate] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const lines = Object.entries(qty).filter(([, q]) => q > 0);
  const total = lines.reduce((a, [id, q]) => a + (data?.find((p) => p.id === id)?.priceCents || 0) * q, 0);
  const order = async () => {
    try {
      const s = await api.post<{ orderNumber: string }>('/meal-kits/orders', { lines: lines.map(([productId, quantity]) => ({ productId, quantity })), deliveryDate: new Date(date).toISOString(), address: addr, paymentMethodId: 'mock_pm_4242' }, newIdempotencyKey());
      setMsg(`Shipment ${s.orderNumber} reserved. Track it under your account.`);
      setQty({});
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div>
        <h1 className="text-2xl font-bold">Meal kits & scheduled delivery</h1>
        <p className="mt-1 text-sm text-ink-500">Chef-designed kits shipped on your chosen date. Showing kits that ship to <select value={region} onChange={(e) => setRegion(e.target.value)} className="rounded border px-1">{['NY', 'NJ', 'CT', 'CA'].map((r) => <option key={r}>{r}</option>)}</select></p>
        {!data ? <Spinner /> : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {data.map((p) => (
              <Card key={p.id} title={p.name}>
                {p.imageUrl && <img src={p.imageUrl} alt="" className="mb-2 h-32 w-full rounded-lg object-cover" />}
                <p className="text-sm text-ink-500">{p.description}</p>
                <p className="mt-1 text-sm font-semibold">{money(p.priceCents)} · {p.available} left · earliest {p.earliestDeliveryDate}</p>
                <div className="mt-2 flex items-center gap-1"><Button size="sm" variant="secondary" onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] || 0) - 1) })}>−</Button><span className="w-5 text-center">{qty[p.id] || 0}</span><Button size="sm" variant="secondary" onClick={() => setQty({ ...qty, [p.id]: (qty[p.id] || 0) + 1 })}>+</Button></div>
              </Card>
            ))}
          </div>
        )}
      </div>
      <Card title="Ship to">
        {!user && <Alert tone="info">Please <Link className="underline" href="/account">sign in</Link> to order meal kits.</Alert>}
        <div className="mt-2 space-y-2">
          <Input label="Address" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} />
          <Input label="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
          <div className="grid grid-cols-2 gap-2"><Input label="State" value={addr.region} onChange={(e) => setAddr({ ...addr, region: e.target.value.toUpperCase() })} /><Input label="ZIP" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} /></div>
          <Input label="Delivery date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div className="text-sm font-semibold">Total {money(total)}</div>
          <Button className="w-full" disabled={!user || !lines.length || !date || !addr.line1} onClick={order}>Pay & schedule</Button>
          {msg && <Alert tone="info">{msg}</Alert>}
        </div>
      </Card>
    </div>
  );
}
