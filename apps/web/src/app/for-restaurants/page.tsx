'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PRODUCT_LINES, type AuthResponse, type PublicPlanDto } from '@gutad/shared';
import { FeeList, planPrice } from '@/components/plan-ui';
import { api, money, session } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input } from '@/components/ui';
import { ApplyForm } from '@/components/merchant-extras';

/** Self-service merchant onboarding: account → organization → first location (claim or create). */
export default function ForRestaurants() {
  const { user } = useSession();
  const { data: plans } = useApi<PublicPlanDto[]>('/public/plans');
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
  if (done) return <Alert tone="good">Your listing is created. Next, <Link className="font-semibold underline" href="/merchant/onboarding">finish onboarding</Link>: accept the Merchant Agreement and upload your business documents so Gutad can verify you. Then add your menu, hours and payout details in the merchant portal.</Alert>;
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div>
        <h1 className="text-3xl font-bold">Sell on your terms, from one place.</h1>
        <p className="mt-3 text-ink-700">Direct ordering with no commission, marketplace reach when you want it, reservations with real inventory, ticketed experiences, delivery through partner fleets, and one statement for all of it.</p>
        <div className="mt-6 space-y-4">{PRODUCT_LINES.filter((l) => plans?.some((p) => p.productLine === l.key)).map((l) => (
          <div key={l.key}>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{l.label}</div>
            <div className="mt-1 grid gap-3 sm:grid-cols-2">{plans!.filter((p) => p.productLine === l.key).map((p) => <div key={p.code} className="rounded-xl border border-ink-100 bg-white p-4 text-sm"><div className="flex justify-between gap-2 font-semibold"><span>{p.name}</span><span className="text-ink-700">{planPrice(p)}</span></div><FeeList fees={p.fees} className="mt-1 text-xs" /></div>)}</div>
          </div>
        ))}</div>
        <Link className="mt-3 inline-block text-sm font-medium text-brand-600 underline" href="/pricing">Compare plans and features</Link>
        <p className="mt-3 text-xs text-ink-300">Published benchmarks for pilots; commercial terms are set per contract by Gutad.</p>
        <div className="mt-6"><ApplyForm /></div>
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
          <p className="text-xs text-ink-500">Next you&apos;ll review and sign the <Link className="underline" href="/merchant-agreement" target="_blank">Merchant Agreement</Link> and upload a business license, food service permit, W-9 and owner ID. Gutad reviews them before your restaurant goes live.</p>
        </div>
      </Card>
    </div>
  );
}
