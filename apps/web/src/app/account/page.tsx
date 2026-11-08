'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { AuthResponse } from '@gutad/shared';
import { api, money, session, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, Tabs, statusTone, Textarea } from '@/components/ui';

function AuthForm() {
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '', marketingConsent: false });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      if (mode === 'recover') { await api.post('/auth/recover', { email: f.email }); setInfo('If that email exists, a reset link has been sent.'); return; }
      const r = await api.post<AuthResponse>(mode === 'login' ? '/auth/login' : '/auth/register', mode === 'login' ? { email: f.email, password: f.password } : f);
      session.set(r);
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-md">
      <Card title={mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Recover account'}>
        <div className="space-y-2">
          {mode === 'register' && <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
          <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          {mode !== 'recover' && <Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />}
          {mode === 'register' && <Input label="Phone (for SMS updates)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}
          {mode === 'register' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} /> Send me offers from restaurants I order from</label>}
          {error && <Alert>{error}</Alert>}
          {info && <Alert tone="info">{info}</Alert>}
          <Button className="w-full" onClick={submit}>{mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}</Button>
          <div className="flex justify-between text-xs text-ink-500">
            <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="underline">{mode === 'login' ? 'Create an account' : 'Have an account? Sign in'}</button>
            <button onClick={() => setMode('recover')} className="underline">Forgot password</button>
          </div>
        </div>
      </Card>
      <p className="mt-4 text-center text-xs text-ink-500">Demo accounts: customer@demo.gutad.io / customer12345 · owner@demo.gutad.io / merchant12345</p>
    </div>
  );
}

function AccountInner() {
  const { user, ready } = useSession();
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') || 'orders');
  if (!ready) return <Spinner />;
  if (!user) return <AuthForm />;
  return (
    <div>
      <h1 className="text-2xl font-bold">Hi {user.name || user.email}</h1>
      <div className="mt-4"><Tabs tabs={[{ id: 'orders', label: 'Orders' }, { id: 'reservations', label: 'Reservations' }, { id: 'tickets', label: 'Tickets' }, { id: 'kits', label: 'Meal kits' }, { id: 'rewards', label: 'Rewards & membership' }, { id: 'profile', label: 'Profile' }]} active={tab} onChange={setTab} /></div>
      <div className="mt-6">
        {tab === 'orders' && <Orders />}
        {tab === 'reservations' && <Reservations />}
        {tab === 'tickets' && <Tickets />}
        {tab === 'kits' && <Kits />}
        {tab === 'rewards' && <Rewards />}
        {tab === 'profile' && <Profile />}
      </div>
    </div>
  );
}

function Orders() {
  const { data } = useApi<{ id: string; number: string; status: string; locationName: string; totalCents: number; createdAt: string; fulfillmentType: string }[]>('/me/orders');
  if (!data) return <Spinner />;
  if (!data.length) return <p className="text-ink-500">No orders yet.</p>;
  return <div className="space-y-2">{data.map((o) => <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between rounded-xl border border-ink-100 bg-white p-4 hover:border-brand-300"><div><div className="font-medium">{o.locationName} · {o.number}</div><div className="text-xs text-ink-500">{when(o.createdAt)} · {o.fulfillmentType}</div></div><div className="text-right"><div className="font-semibold">{money(o.totalCents)}</div><Badge tone={statusTone(o.status)}>{o.status}</Badge></div></Link>)}</div>;
}

function Reservations() {
  const { data } = useApi<{ id: string; confirmationCode: string; status: string; startAt: string; partySize: number; location: { name: string }; guestEmail: string | null }[]>('/me/reservations');
  if (!data) return <Spinner />;
  if (!data.length) return <p className="text-ink-500">No reservations yet.</p>;
  return <div className="space-y-2">{data.map((r) => <Link key={r.id} href={`/reservations/${r.confirmationCode}?email=${encodeURIComponent(r.guestEmail || '')}`} className="flex items-center justify-between rounded-xl border border-ink-100 bg-white p-4 hover:border-brand-300"><div><div className="font-medium">{r.location.name}</div><div className="text-xs text-ink-500">{when(r.startAt)} · party of {r.partySize} · {r.confirmationCode}</div></div><Badge tone={statusTone(r.status)}>{r.status}</Badge></Link>)}</div>;
}

function Tickets() {
  const { data } = useApi<{ t: { id: string; confirmationCode: string; status: string; spots: number; ticketCents: number }; s: { startAt: string }; e: { name: string } }[]>('/me/tickets');
  if (!data) return <Spinner />;
  if (!data.length) return <p className="text-ink-500">No tickets yet.</p>;
  return <div className="space-y-2">{data.map(({ t, s, e }) => <div key={t.id} className="flex items-center justify-between rounded-xl border border-ink-100 bg-white p-4"><div><div className="font-medium">{e.name}</div><div className="text-xs text-ink-500">{when(s.startAt)} · {t.spots} spots · code {t.confirmationCode}</div></div><div className="flex items-center gap-2"><Badge tone={statusTone(t.status)}>{t.status}</Badge>{t.status === 'CONFIRMED' && <Button size="sm" variant="secondary" onClick={() => api.post(`/tickets/${t.id}/cancel`, {}).then(() => location.reload())}>Cancel</Button>}</div></div>)}</div>;
}

function Kits() {
  const { data } = useApi<{ id: string; orderNumber: string; status: string; deliveryDate: string; totalCents: number; trackingNumber: string | null; lines: { name: string; quantity: number }[] }[]>('/me/shipments');
  if (!data) return <Spinner />;
  if (!data.length) return <p className="text-ink-500">No meal kit shipments. <Link className="underline" href="/meal-kits">Browse kits</Link>.</p>;
  return <div className="space-y-2">{data.map((s) => <div key={s.id} className="rounded-xl border border-ink-100 bg-white p-4"><div className="flex justify-between"><span className="font-medium">{s.orderNumber}</span><Badge tone={statusTone(s.status)}>{s.status}</Badge></div><div className="text-xs text-ink-500">Delivery {s.deliveryDate.slice(0, 10)} · {s.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')} · {money(s.totalCents)}{s.trackingNumber ? ` · tracking ${s.trackingNumber}` : ''}</div><Button size="sm" variant="ghost" className="mt-1" onClick={() => api.post(`/shipments/${s.id}/cases`, { kind: 'DAMAGED' }).then(() => alert('Case opened; support will issue a replacement or credit.'))}>Report a problem</Button></div>)}</div>;
}

function Rewards() {
  const { data, reload } = useApi<{ points: number; valueCents: number; credits: { availableCents: number }; membership: { plan: { name: string }; currentPeriodEnd: string } | null; entries: { id: string; kind: string; points: number; createdAt: string }[] }>('/me/loyalty');
  const { data: plans } = useApi<{ id: string; name: string; priceCents: number; interval: string; benefits: Record<string, unknown> }[]>('/public/membership/plans');
  const [code, setCode] = useState('');
  if (!data) return <Spinner />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Points & credits"><p className="text-3xl font-bold">{data.points} <span className="text-base font-normal text-ink-500">points ≈ {money(data.valueCents)}</span></p><p className="text-sm text-ink-500">Credits available: {money(data.credits.availableCents)}</p><ul className="mt-2 max-h-40 overflow-y-auto text-xs text-ink-500">{data.entries.map((e) => <li key={e.id}>{e.kind} {e.points > 0 ? '+' : ''}{e.points} · {when(e.createdAt)}</li>)}</ul>
        <div className="mt-3 flex gap-2"><Input placeholder="Referral code" value={code} onChange={(e) => setCode(e.target.value)} /><Button variant="secondary" onClick={() => api.post('/me/referral', { code }).then(reload).catch((e) => alert(e.message))}>Apply</Button></div></Card>
      <Card title="Membership">
        {data.membership ? <p className="text-sm">You are a <b>{data.membership.plan.name}</b> member until {when(data.membership.currentPeriodEnd)}. <Button size="sm" variant="ghost" onClick={() => api.post('/me/membership/cancel', {}).then(reload)}>Cancel</Button></p> : (
          <div className="space-y-2">{plans?.map((p) => <div key={p.id} className="flex items-center justify-between rounded-lg border border-ink-100 p-3 text-sm"><div><b>{p.name}</b> · {money(p.priceCents)}/{p.interval.toLowerCase()}<div className="text-xs text-ink-500">{Object.entries(p.benefits).filter(([, v]) => v).map(([k, v]) => `${k}${typeof v === 'number' ? ' ' + money(v) : ''}`).join(' · ')}</div></div><Button size="sm" onClick={() => api.post('/me/membership', { planId: p.id, paymentMethodId: 'mock_pm_4242' }).then(reload).catch((e) => alert(e.message))}>Join</Button></div>)}</div>
        )}
      </Card>
    </div>
  );
}

function Profile() {
  const { data, reload } = useApi<{ name: string | null; phone: string | null; dietaryNotes: string | null; marketingConsent: boolean; smsConsent: boolean; addresses: { id: string; line1: string; city: string; isDefault: boolean }[] }>('/auth/me');
  const [f, setF] = useState<Record<string, unknown> | null>(null);
  const [addr, setAddr] = useState({ line1: '', city: '', region: '', postalCode: '' });
  if (!data) return <Spinner />;
  const v = f || { name: data.name || '', phone: data.phone || '', dietaryNotes: data.dietaryNotes || '', marketingConsent: data.marketingConsent, smsConsent: data.smsConsent };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Profile">
        <div className="space-y-2">
          <Input label="Name" value={String(v.name)} onChange={(e) => setF({ ...v, name: e.target.value })} />
          <Input label="Phone" value={String(v.phone)} onChange={(e) => setF({ ...v, phone: e.target.value })} />
          <Textarea label="Dietary notes" value={String(v.dietaryNotes)} onChange={(e) => setF({ ...v, dietaryNotes: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.marketingConsent} onChange={(e) => setF({ ...v, marketingConsent: e.target.checked })} /> Marketing email</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.smsConsent} onChange={(e) => setF({ ...v, smsConsent: e.target.checked })} /> Marketing SMS</label>
          <Button onClick={() => api.patch('/auth/me', v).then(() => { setF(null); reload(); })}>Save</Button>
          <Button variant="ghost" onClick={() => api.post('/me/data-request', { kind: 'ACCESS' }).then((r) => { const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'gutad-data.json'; a.click(); })}>Download my data</Button>
        </div>
      </Card>
      <Card title="Addresses">
        <ul className="text-sm">{data.addresses.map((a) => <li key={a.id} className="flex justify-between py-1"><span>{a.line1}, {a.city} {a.isDefault && <Badge tone="info">Default</Badge>}</span><button className="text-xs text-red-600" onClick={() => api.delete(`/auth/me/addresses/${a.id}`).then(reload)}>Remove</button></li>)}</ul>
        <div className="mt-2 grid grid-cols-2 gap-2"><Input placeholder="Street" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} className="col-span-2" /><Input placeholder="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /><Input placeholder="State" value={addr.region} onChange={(e) => setAddr({ ...addr, region: e.target.value })} /><Input placeholder="ZIP" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} /><Button onClick={() => api.post('/auth/me/addresses', { ...addr, isDefault: true }).then(() => { setAddr({ line1: '', city: '', region: '', postalCode: '' }); reload(); })}>Add</Button></div>
      </Card>
    </div>
  );
}

export default function AccountPage() {
  return <Suspense fallback={<Spinner />}><AccountInner /></Suspense>;
}
