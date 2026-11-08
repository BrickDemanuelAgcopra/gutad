'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AuthResponse } from '@gutad/shared';
import { api, money, session } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input } from '@/components/ui';

/** Self-service merchant onboarding: account → organization → first location (claim or create). */
export default function ForRestaurants() {
  const { user } = useSession();
  const { data: plans } = useApi<{ code: string; name: string; subscriptionCents: number; marketplaceCommissionBps: number; coverFeeNetworkCents: number }[]>('/public/plans');
  const [f, setF] = useState({ email: '', password: '', name: '', business: '', location: '', addressLine1: '', city: '', region: '', postalCode: '' });
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      if (!user) session.set(await api.post<AuthResponse>('/auth/register', { email: f.email, password: f.password, name: f.name }));
      const org = await api.post<{ id: string }>('/organizations', { name: f.business });
      await api.post(`/organizations/${org.id}/legal-sellers`, { legalName: f.business });
      await api.post(`/organizations/${org.id}/locations`, { name: f.location || f.business, addressLine1: f.addressLine1, city: f.city, region: f.region, postalCode: f.postalCode });
      session.set(await api.post<AuthResponse>('/auth/refresh', { refreshToken: localStorage.getItem('gutad.refresh') }));
      setDone(org.id);
    } catch (e) { setError((e as Error).message); }
  };
  if (done) return <Alert tone="good">Your listing is created. Platform staff verify operators before going live. Continue in the <Link className="underline" href="/merchant">merchant portal</Link> to import your menu, set hours, floor plan and payouts.</Alert>;
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div>
        <h1 className="text-3xl font-bold">Sell on your terms, from one place.</h1>
        <p className="mt-3 text-ink-700">Direct ordering with no commission, marketplace reach when you want it, reservations with real inventory, ticketed experiences, delivery through partner fleets, and one statement for all of it.</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">{plans?.map((p) => <div key={p.code} className="rounded-xl border border-ink-100 bg-white p-4 text-sm"><div className="font-semibold">{p.name}</div><div className="text-ink-500">{p.subscriptionCents ? `${money(p.subscriptionCents)}/mo` : 'No subscription'} · {p.marketplaceCommissionBps / 100}% marketplace · {money(p.coverFeeNetworkCents)}/network cover</div></div>)}</div>
        <p className="mt-3 text-xs text-ink-300">Published benchmarks for pilots; commercial terms are set per contract by Gutad.</p>
      </div>
      <Card title="Claim or create your listing">
        <div className="space-y-2">
          {!user && (<><Input label="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /><Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></>)}
          <Input label="Business (legal) name" value={f.business} onChange={(e) => setF({ ...f, business: e.target.value })} />
          <Input label="Restaurant name" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          <Input label="Street address" value={f.addressLine1} onChange={(e) => setF({ ...f, addressLine1: e.target.value })} />
          <div className="grid grid-cols-3 gap-2"><Input label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /><Input label="State" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /><Input label="ZIP" value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></div>
          {error && <Alert>{error}</Alert>}
          <Button className="w-full" onClick={submit} disabled={!f.business || !f.addressLine1 || !f.city}>Get started</Button>
        </div>
      </Card>
    </div>
  );
}
