'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { chefDishTitle, chefNoticeText, WEEKDAYS } from '@gutad/shared';
import { api, refreshSession, session } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';

export interface ChefMe {
  profile: { id: string; displayName: string; slug: string; bio: string | null; cuisines: string[]; languages: string[]; experienceYears: number | null; portraitFileId: string | null; portraitUrl: string | null; portfolio: { id: string; url: string }[]; acceptingOrders: boolean; status: string; statusReason: string | null; operating: { cookingDays?: number[]; cutoffHour?: number; minLeadDays?: number; dailyCapacity?: number; maxAdvanceDays?: number }; serviceRadiusKm: number | null };
  organization: { id: string; name: string; status: string } | null;
  location: { id: string; name: string; addressLine1: string; city: string; region: string; isPaused: boolean; pausedReason: string | null; status: string; acceptsPickup: boolean; acceptsDelivery: boolean } | null;
  payouts: { legalSellerId: string; state: string; bankLast4: string | null } | null;
  checklist: { key: string; label: string; done: boolean }[];
}

function Dashboard() {
  const sp = useSearchParams();
  const { data, setData, error, loading } = useApi<ChefMe>('/chef/me');
  const { run, busy, error: actErr } = useAction();
  const { data: reqs } = useApi<{ counts: { needsReply: number } }>('/chef/requests?status=needsReply', { poll: 60_000 });
  // a fresh approval adds the chef organization to the session; refresh tokens so the merchant tools open
  const orgId = data?.organization?.id;
  useEffect(() => { if (orgId && !session.user()?.memberRoles?.[orgId]) void refreshSession(); }, [orgId]);
  if (loading) return <Spinner />;
  if (error || !data)
    return (
      <Alert tone="info">
        You’re not an approved Gutad chef yet. <Link href="/chefs/apply" className="underline">Continue your application</Link>.
      </Alert>
    );
  const p = data.profile;
  const op = p.operating || {};
  const connect = () => run(async () => {
    const r = await api.post<{ onboardingUrl?: string | null; state: string }>('/chef/me/payouts', {});
    if (r.onboardingUrl) window.location.href = r.onboardingUrl;
    else setData(await api.get<ChefMe>('/chef/me'));
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        {p.portraitUrl ? <img src={p.portraitUrl} alt="" className="h-16 w-16 rounded-full object-cover" /> : <div className="grid h-16 w-16 place-items-center rounded-full bg-brand-100 text-2xl">👩‍🍳</div>}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{p.displayName}</h1>
          <p className="text-sm text-ink-500">Your dishes appear as <strong>{chefDishTitle('Spaghetti', p.displayName)}</strong></p>
        </div>
        <Badge tone={p.status !== 'ACTIVE' ? 'bad' : p.acceptingOrders ? 'good' : 'warn'}>{p.status !== 'ACTIVE' ? p.status.toLowerCase() : p.acceptingOrders ? 'Accepting orders' : 'Not accepting orders'}</Badge>
      </div>
      {sp.get('done') && <Alert tone="good">Thanks — your payout details were submitted to our payment provider.</Alert>}
      {p.status !== 'ACTIVE' && <Alert>Your chef account is {p.status.toLowerCase()}{p.statusReason ? `: ${p.statusReason}` : ''}. {(p as { statusCause?: string | null }).statusCause === 'DOCUMENTS' ? <Link className="underline" href="/chef/compliance">Upload your renewal</Link> : 'Contact Gutad support.'}</Alert>}
      {actErr && <Alert>{actErr}</Alert>}
      {!!reqs?.counts.needsReply && <Link href='/chef/requests' className='block rounded-2xl border border-brand-200 bg-brand-50 p-4 hover:border-brand-400'><span className='font-semibold'>{reqs.counts.needsReply} special request{reqs.counts.needsReply === 1 ? "" : "s"} need{reqs.counts.needsReply === 1 ? "s" : ""} your reply</span><span className='block text-sm text-ink-600'>Quote, suggest an alternative, ask or decline before the deadline. →</span></Link>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Getting started">
          <ol className="space-y-2">
            {data.checklist.map((c, i) => (
              <li key={c.key} className="flex items-center gap-3 text-sm">
                <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${c.done ? 'bg-emerald-500 text-white' : 'bg-ink-100 text-ink-500'}`}>{c.done ? '✓' : i + 1}</span>
                <span className={c.done ? 'text-ink-500 line-through' : ''}>{c.label}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Card title="Availability">
          <p className="text-sm text-ink-700">{p.acceptingOrders ? 'Customers can order your published dishes for your cooking days.' : 'Your dishes are hidden from customers until you open availability.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {p.acceptingOrders ? (
              <Button variant="secondary" disabled={busy} onClick={() => run(async () => setData(await api.post<ChefMe>('/chef/me/availability', { accepting: false })))}>Pause availability</Button>
            ) : (
              <Button disabled={busy || p.status !== 'ACTIVE'} onClick={() => run(async () => setData(await api.post<ChefMe>('/chef/me/availability', { accepting: true })))}>Open availability</Button>
            )}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-ink-500">
            <div><dt>Cooking days</dt><dd className="font-medium text-ink-900">{(op.cookingDays || []).map((d) => WEEKDAYS[d]).join(', ') || '—'}</dd></div>
            <div><dt>Ordering</dt><dd className="font-medium text-ink-900">{chefNoticeText(op.minLeadDays ?? 1, op.cutoffHour ?? 12)}</dd></div>
            <div><dt>Daily capacity</dt><dd className="font-medium text-ink-900">{op.dailyCapacity ?? '—'} portions</dd></div>
            <div><dt>Orders open</dt><dd className="font-medium text-ink-900">{op.maxAdvanceDays ?? 30} days ahead</dd></div>
          </dl>
          <Link href="/chef/calendar" className="mt-3 inline-block text-sm font-medium text-brand-700 underline">Cooking calendar, holidays and capacity →</Link>
        </Card>
        <Card title="Payouts">
          {data.payouts?.state === 'COMPLETE' ? (
            <p className="text-sm text-emerald-700">✓ Payouts connected{data.payouts.bankLast4 ? ` (account ending ${data.payouts.bankLast4})` : ''}. Earnings are paid weekly after completed orders.</p>
          ) : (
            <>
              <p className="text-sm text-ink-700">Connect payouts through our payment provider’s secure onboarding. They verify your identity and collect bank and tax details; Gutad never stores them.</p>
              <Button className="mt-3" disabled={busy} onClick={connect}>{data.payouts?.state === 'PENDING' ? 'Continue payout setup' : 'Connect payouts'}</Button>
            </>
          )}
        </Card>
        <Card title="Kitchen">
          {data.location ? (
            <div className="text-sm">
              <div className="font-medium">{data.location.name}</div>
              <div className="text-ink-500">{data.location.addressLine1}, {data.location.city}, {data.location.region}</div>
              <div className="mt-2 flex flex-wrap gap-1">{data.location.acceptsPickup && <Badge>Pickup</Badge>}{data.location.acceptsDelivery && <Badge>Delivery</Badge>}{data.location.isPaused && <Badge tone="warn">Paused</Badge>}</div>
              <p className="mt-3 text-xs text-ink-500">Orders and kitchen tickets open in your <Link className="underline" href="/merchant/orders">order workspace</Link>.</p>
            </div>
          ) : <p className="text-sm text-ink-500">No kitchen on file.</p>}
        </Card>
      </div>
    </div>
  );
}

export default function ChefDashboard() {
  return <Suspense fallback={<Spinner />}><Dashboard /></Suspense>;
}
