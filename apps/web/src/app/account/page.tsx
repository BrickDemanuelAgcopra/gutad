'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { AuthResponse, MfaChallenge } from '@gutad/shared';
import { AccountSecurity } from '@/components/account-security';
import { Rewards } from '@/components/rewards';
import { CardField, type CardToken } from '@/components/card-field';
import { api, money, session, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, Tabs, statusTone, Textarea } from '@/components/ui';
import { AuthForm } from '@/components/auth-form';
import { SmsNotice } from '@/components/legal';
import { MyRequests } from '@/components/chef-requests';


function AccountInner() {
  const { user, ready } = useSession();
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get('tab') || 'orders');
  if (!ready) return <Spinner />;
  if (!user) return <AuthForm />;
  return (
    <div>
      <h1 className="text-2xl font-bold">Hi {user.name || user.email}</h1>
      <RestrictionBanner />
      <div className="mt-4"><Tabs tabs={[{ id: 'orders', label: 'Orders' }, { id: 'requests', label: 'Special requests' }, { id: 'reservations', label: 'Reservations' }, { id: 'tickets', label: 'Tickets' }, { id: 'kits', label: 'Meal kits' }, { id: 'rewards', label: 'Rewards & membership' }, { id: 'profile', label: 'Profile' }, { id: 'payments', label: 'Payments' }, { id: 'notifications', label: 'Notifications' }, { id: 'privacy', label: 'Privacy' }, { id: 'security', label: 'Security' }]} active={tab} onChange={setTab} /></div>
      <div className="mt-6">
        {tab === 'orders' && <Orders />}
        {tab === 'requests' && <MyRequests />}
        {tab === 'reservations' && <Reservations />}
        {tab === 'tickets' && <Tickets />}
        {tab === 'kits' && <Kits />}
        {tab === 'rewards' && <Rewards />}
        {tab === 'profile' && <Profile />}
        {tab === 'payments' && <Payments />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'privacy' && <Privacy />}
        {tab === 'security' && <AccountSecurity />}
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
          <SmsNotice />
          <Textarea label="Dietary notes" value={String(v.dietaryNotes)} onChange={(e) => setF({ ...v, dietaryNotes: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.marketingConsent} onChange={(e) => setF({ ...v, marketingConsent: e.target.checked })} /> Marketing email</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.smsConsent} onChange={(e) => setF({ ...v, smsConsent: e.target.checked })} /> Marketing SMS</label>
          <Button onClick={() => api.patch('/auth/me', v).then(() => { setF(null); reload(); })}>Save</Button>
        </div>
      </Card>
      <Card title="Addresses">
        <ul className="text-sm">{data.addresses.map((a) => <li key={a.id} className="flex justify-between py-1"><span>{a.line1}, {a.city} {a.isDefault && <Badge tone="info">Default</Badge>}</span><button className="text-xs text-red-600" onClick={() => api.delete(`/auth/me/addresses/${a.id}`).then(reload)}>Remove</button></li>)}</ul>
        <div className="mt-2 grid grid-cols-2 gap-2"><Input placeholder="Street" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} className="col-span-2" /><Input placeholder="City" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /><Input placeholder="State" value={addr.region} onChange={(e) => setAddr({ ...addr, region: e.target.value })} /><Input placeholder="ZIP" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} /><Button onClick={() => api.post('/auth/me/addresses', { ...addr, isDefault: true }).then(() => { setAddr({ line1: '', city: '', region: '', postalCode: '' }); reload(); })}>Add</Button></div>
      </Card>
    </div>
  );
}

const RESTRICTION_TEXT: Record<string, string> = { ORDERING_BLOCKED: 'Ordering is paused on your account', PROMOTIONS_BLOCKED: 'Promotions and promo codes are paused on your account', REFUND_REVIEW: 'Refund requests on your account are reviewed by a second person' };

function RestrictionBanner() {
  const { data, reload } = useApi<{ id: string; kind: string; reason: string; expiresAt: string | null; appealStatus: string; appealDecisionNote: string | null }[]>('/me/restrictions');
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!data?.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {data.map((r) => (
        <div key={r.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="font-medium">{RESTRICTION_TEXT[r.kind] || r.kind}{r.expiresAt ? ` until ${when(r.expiresAt)}` : ''}.</div>
          <div className="text-ink-700">Reason: {r.reason}</div>
          {r.appealStatus === 'PENDING' && <div className="text-xs text-ink-500">Your appeal is with our team. We will email you with the outcome.</div>}
          {r.appealStatus === 'UPHELD' && <div className="text-xs text-ink-500">Appeal reviewed: {r.appealDecisionNote}</div>}
          {['NONE', 'UPHELD'].includes(r.appealStatus) && (open === r.id ? (
            <div className="mt-2 space-y-2">
              <Textarea rows={2} placeholder="Tell us what happened (at least 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} />
              {err && <Alert>{err}</Alert>}
              <Button size="sm" disabled={note.length < 10} onClick={() => api.post(`/me/restrictions/${r.id}/appeal`, { note }).then(() => { setOpen(null); setNote(''); reload(); }).catch((e) => setErr((e as Error).message))}>Send appeal</Button>
            </div>
          ) : <button className="mt-1 text-xs underline" onClick={() => setOpen(r.id)}>Appeal this decision</button>)}
        </div>
      ))}
    </div>
  );
}

interface SavedCard { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean }

function Payments() {
  const { data, reload } = useApi<SavedCard[]>('/me/payment-methods');
  const [card, setCard] = useState<CardToken | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const add = async () => {
    setErr(null);
    if (!card) return;
    // 18.9 only the processor token, brand and last 4 digits are sent to Gutad
    try { await api.post('/me/payment-methods', { paymentMethodId: card.token, brand: card.brand, last4: card.last4 }); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Saved cards">
        {!data.length && <p className="text-sm text-ink-500">No saved cards yet. You can save one here or at checkout.</p>}
        <ul className="divide-y divide-ink-100 text-sm">{data.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <span className="capitalize">{c.brand} •••• {c.last4}{c.expMonth ? <span className="text-xs text-ink-500"> · exp {c.expMonth}/{String(c.expYear).slice(-2)}</span> : null} {c.isDefault && <Badge tone="info">Default</Badge>}</span>
            <span className="flex gap-2">{!c.isDefault && <button className="text-xs underline" onClick={() => api.post(`/me/payment-methods/${c.id}/default`, {}).then(reload)}>Make default</button>}<button className="text-xs text-red-600" onClick={() => api.delete(`/me/payment-methods/${c.id}`).then(reload)}>Remove</button></span>
          </li>
        ))}</ul>
      </Card>
      <Card title="Add a card">
        <div className="space-y-2">
          <CardField value={card} onChange={setCard} purpose="save" />
          {err && <Alert>{err}</Alert>}
          <Button onClick={add}>Save card</Button>
          <p className="text-xs text-ink-500">Your card is stored by our payment processor. Gutad keeps only a token and the last 4 digits.</p>
        </div>
      </Card>
    </div>
  );
}

const TOPIC_TEXT: Record<string, [string, string]> = { orders: ['Order updates', 'Accepted, ready, on the way, delivered, problems'], reservations: ['Reservations', 'Confirmations, reminders, waitlist'], account: ['Account & security', 'Sign-ins, password, privacy (always on in the app)'], marketing: ['Offers', 'Promotions from restaurants you order from'] };

function Notifications() {
  const { data, reload } = useApi<{ topics: { topic: string; email: boolean; sms: boolean; push: boolean }[] }>('/me/notification-prefs');
  const [saved, setSaved] = useState(false);
  if (!data) return <Spinner />;
  const toggle = (topic: string, ch: 'email' | 'sms' | 'push', v: boolean) => {
    setSaved(false);
    const t = data.topics.find((x) => x.topic === topic)!;
    api.put('/me/notification-prefs', { topics: [{ ...t, [ch]: v }] }).then(() => { setSaved(true); reload(); });
  };
  return (
    <Card title="How we reach you">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-ink-500"><th className="py-1">Topic</th><th>Email</th><th>SMS</th><th>Push</th></tr></thead>
        <tbody>{data.topics.map((t) => (
          <tr key={t.topic} className="border-t border-ink-100">
            <td className="py-2"><div className="font-medium">{TOPIC_TEXT[t.topic]?.[0] || t.topic}</div><div className="text-xs text-ink-500">{TOPIC_TEXT[t.topic]?.[1]}</div></td>
            {(['email', 'sms', 'push'] as const).map((ch) => <td key={ch}><input type="checkbox" aria-label={`${t.topic} ${ch}`} checked={!!t[ch]} onChange={(e) => toggle(t.topic, ch, e.target.checked)} /></td>)}
          </tr>
        ))}</tbody>
      </table>
      <p className="mt-2 text-xs text-ink-500">In-app notices and essential account emails (receipts, security, privacy) are always sent.</p>
      {saved && <p className="text-xs text-emerald-700">Saved.</p>}
    </Card>
  );
}

function Privacy() {
  const { data, reload } = useApi<{ id: string; kind: string; status: string; scheduledFor: string | null; createdAt: string }[]>('/me/data-requests');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const pending = data?.find((r) => r.kind === 'DELETE' && r.status === 'PENDING');
  const download = () => api.post('/me/data-request', { kind: 'ACCESS' }).then((r) => { const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'gutad-data.json'; a.click(); reload(); }).catch((e) => setErr((e as Error).message));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Your data">
        <p className="text-sm text-ink-700">Download a copy of your profile, addresses, orders, reservations and preferences.</p>
        <Button className="mt-2" variant="secondary" onClick={download}>Download my data</Button>
      </Card>
      <Card title="Delete account">
        {pending ? (
          <div className="space-y-2 text-sm">
            <Alert tone="info">Your account is scheduled for deletion on {when(pending.scheduledFor)}.</Alert>
            <Button variant="secondary" onClick={() => api.post(`/me/data-request/${pending.id}/cancel`, {}).then(() => { setMsg('Deletion canceled. Your account stays open.'); reload(); })}>Keep my account</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-ink-700">We remove your name, contact details, addresses and saved cards after a short grace period. Receipts and payment records are kept without your personal details because the law requires it. Open orders or disputes must finish first.</p>
            <Input label='Type "DELETE" to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button variant="danger" disabled={confirm !== 'DELETE'} onClick={() => api.post<{ note?: string }>('/me/data-request', { kind: 'DELETE' }).then((r) => { setMsg(r.note || 'Deletion requested.'); setConfirm(''); reload(); }).catch((e) => setErr((e as Error).message))}>Delete my account</Button>
          </div>
        )}
      </Card>
      {(msg || err) && <div className="md:col-span-2">{msg && <Alert tone="good">{msg}</Alert>}{err && <Alert>{err}</Alert>}</div>}
      {!!data?.length && <Card title="Request history"><ul className="text-sm">{data.map((r) => <li key={r.id}>{r.kind === 'ACCESS' ? 'Data download' : 'Account deletion'} · {r.status.toLowerCase()} · {when(r.createdAt)}</li>)}</ul></Card>}
    </div>
  );
}

export default function AccountPage() {
  return <Suspense fallback={<Spinner />}><AccountInner /></Suspense>;
}
