'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, statusTone } from '@/components/ui';
import Link from 'next/link';

/** Lightweight web console for platform-fleet drivers (the mobile app is the primary surface). */
export default function DriverPage() {
  const { user } = useSession();
  const { data: me, error, reload } = useApi<{ id: string; status: string; isAvailable: boolean }>(user ? '/driver/me' : null);
  const { data: offers, reload: reloadOffers } = useApi<{ id: string; payCents: number; pickupAddress: { line1: string }; dropoffAddress: { line1: string }; expiresAt: string }[]>(me ? '/driver/offers' : null, { poll: 5000, deps: [me?.id] });
  const { data: jobs, reload: reloadJobs } = useApi<{ id: string; status: string; pickupAddress: { line1: string }; dropoffAddress: { line1: string }; tipCents: number }[]>(me ? '/driver/jobs' : null, { poll: 5000, deps: [me?.id] });
  const { data: earnings } = useApi<{ payableCents: number }>(me ? '/driver/earnings' : null, { deps: [me?.id] });
  const [vehicle, setVehicle] = useState('Bike');
  if (!user) return <Alert tone="info">Please <Link className="underline" href="/account">sign in</Link> to drive with Gutad.</Alert>;
  if (error && !me) return <Card title="Apply to drive"><Input label="Vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} /><Button className="mt-2" onClick={() => api.post('/driver/apply', { vehicle }).then(reload)}>Apply</Button></Card>;
  if (!me) return <Spinner />;
  const loc = () => new Promise<{ lat: number; lng: number }>((res) => navigator.geolocation?.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({ lat: 40.73, lng: -73.99 })));
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card title="Driver status" action={<Badge tone={statusTone(me.status)}>{me.status}</Badge>}>
        <div className="flex items-center justify-between"><span className="text-sm">Payable balance {money(earnings?.payableCents || 0)}</span><Button variant={me.isAvailable ? 'secondary' : 'primary'} onClick={async () => { const l = await loc(); await api.post('/driver/availability', { isAvailable: !me.isAvailable, ...l }); reload(); }}>{me.isAvailable ? 'Go offline' : 'Go online'}</Button></div>
      </Card>
      <Card title="Offers">{offers?.length ? offers.map((o) => <div key={o.id} className="flex items-center justify-between border-b border-ink-100 py-2 text-sm"><span>{o.pickupAddress.line1} → {o.dropoffAddress.line1} · <b>{money(o.payCents)}</b> · expires {when(o.expiresAt)}</span><div className="flex gap-1"><Button size="sm" onClick={() => api.post(`/driver/offers/${o.id}`, { accept: true }).then(() => { reloadOffers(); reloadJobs(); })}>Accept</Button><Button size="sm" variant="ghost" onClick={() => api.post(`/driver/offers/${o.id}`, { accept: false }).then(reloadOffers)}>Decline</Button></div></div>) : <p className="text-sm text-ink-500">No offers right now.</p>}</Card>
      <Card title="Active jobs">{jobs?.length ? jobs.map((j) => <div key={j.id} className="border-b border-ink-100 py-2 text-sm"><div className="flex justify-between"><span>{j.pickupAddress.line1} → {j.dropoffAddress.line1} · tip {money(j.tipCents)}</span><Badge tone={statusTone(j.status)}>{j.status}</Badge></div><div className="mt-1 flex gap-1">{j.status === 'ASSIGNED' && <Button size="sm" onClick={async () => { const l = await loc(); await api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', ...l }); reloadJobs(); }}>Picked up</Button>}{j.status === 'PICKED_UP' && <Button size="sm" onClick={async () => { const l = await loc(); await api.post(`/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: 'https://placehold.co/600x400?text=Handoff', ...l }); reloadJobs(); }}>Delivered (photo proof)</Button>}<Button size="sm" variant="ghost" onClick={() => api.post(`/driver/jobs/${j.id}/transition`, { status: 'FAILED', reason: 'Customer unreachable' }).then(reloadJobs)}>Can’t deliver</Button></div></div>) : <p className="text-sm text-ink-500">No active jobs.</p>}</Card>
    </div>
  );
}
