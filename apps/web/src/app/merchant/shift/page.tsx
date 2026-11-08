'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

export default function ShiftPage() {
  const { loc } = useMerchant();
  const { data: o, reload } = useApi<{ location: { isPaused: boolean; pausedReason: string | null; throttle: number | null }; soldOut: { id: string; name: string }[]; scheduledOrders: { number: string; scheduledFor: string; status: string }[]; bookingsToday: { n: number; covers: number }; waitlist: { n: number }; openIncidents: { n: number }; carriedForward: string[]; checklist: string[] }>(loc ? `/locations/${loc.id}/shift/open` : null, { deps: [loc?.id] });
  const { run, error } = useAction();
  const [cash, setCash] = useState('');
  const [waste, setWaste] = useState('');
  const [closed, setClosed] = useState<Record<string, unknown> | null>(null);
  if (!loc || !o) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Open shift checklist">
        <ul className="list-disc space-y-1 pl-5 text-sm">{o.checklist.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="mt-3 space-y-1 text-sm">
          <p>Sold out: {o.soldOut.length ? o.soldOut.map((s) => <Button key={s.id} size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/items/${s.id}/sold-out`, { soldOut: false }); reload(); })}>{s.name} ↺</Button>) : 'none'}</p>
          <p>Status: {o.location.isPaused ? `paused (${o.location.pausedReason})` : 'accepting'} · throttle {o.location.throttle ?? 'off'}</p>
          <p>Bookings today: {o.bookingsToday.n} ({o.bookingsToday.covers} covers) · waitlist {o.waitlist.n} · open incidents {o.openIncidents.n}</p>
          <p>Scheduled orders: {o.scheduledOrders.length ? o.scheduledOrders.map((s) => `${s.number} @ ${when(s.scheduledFor)}`).join(', ') : 'none'}</p>
          {o.carriedForward.length > 0 && <Alert tone="info">Carried forward from last close: {o.carriedForward.join('; ')}</Alert>}
        </div>
      </Card>
      <Card title="Close shift">
        <p className="mb-2 text-sm text-ink-500">Confirms collections/deliveries, actual covers and no-shows, open checks, cash and waste. Unresolved items are carried forward explicitly.</p>
        <Input label="Cash collected (USD, if supported)" value={cash} onChange={(e) => setCash(e.target.value)} />
        <Textarea className="mt-2" label="Waste notes" value={waste} onChange={(e) => setWaste(e.target.value)} />
        {error && <Alert>{error}</Alert>}
        <Button className="mt-3" onClick={() => run(async () => { setClosed(await api.post<Record<string, unknown>>(`/locations/${loc.id}/shift/close`, { cashCents: Math.round(Number(cash || 0) * 100), wasteNotes: waste })); reload(); })}>Sign & close</Button>
        {closed && <pre className="mt-3 overflow-x-auto rounded-lg bg-ink-50 p-3 text-xs">{JSON.stringify(closed, null, 2)}</pre>}
      </Card>
    </div>
  );
}
