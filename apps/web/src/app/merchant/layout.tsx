'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { merchantPageAllowed } from '@gutad/shared';
import { useEffect, useMemo, useState } from 'react';
import { allowed, MerchantCtx, type Ent, type Org } from './context';
import { api, session } from '@/lib/api';
import { useLocalState, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Input, Spinner } from '@/components/ui';
import { AccessBanner, adoptTokens } from '@/components/admin-ui';
import { NewOrderAlarm, usePendingOrders } from '@/components/new-order-alarm';


/** Nav items that need a plan feature (any one of the listed keys unlocks the page). */
const NEEDS: Record<string, string[]> = { '/merchant/host': ['floor_plan'], '/merchant/dispatch': ['delivery'], '/merchant/events': ['experiences', 'private_events'] };

const NAV = [
  ['/merchant', 'Dashboard'], ['/merchant/onboarding', 'Onboarding'], ['/merchant/orders', 'Orders'], ['/merchant/menu', 'Menu'], ['/merchant/host', 'Host stand'], ['/merchant/dispatch', 'Delivery'], ['/merchant/kitchen', 'Kitchen'], ['/merchant/recipes', 'Recipes'], ['/merchant/inventory', 'Inventory'], ['/merchant/safety', 'Food safety'], ['/merchant/team', 'Team & equipment'], ['/merchant/events', 'Events'], ['/merchant/guests', 'Guests'], ['/merchant/growth', 'Growth'], ['/merchant/finance', 'Finance'], ['/merchant/billing', 'Plan & billing'], ['/merchant/shift', 'Shift'], ['/merchant/location', 'Location & launch'], ['/merchant/support', 'Support'], ['/merchant/settings', 'Settings'],
];

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, isStaff, can } = useSession();
  const path = usePathname();
  const sup = user?.supportAccess && new Date(user.supportAccess.until) > new Date() ? user.supportAccess : null;
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [locId, setLocId] = useLocalState<string | null>('gutad.merchant.loc', null);
  const load = async () => {
    try {
      const mine = Object.keys(session.user()?.memberRoles || {});
      const s = session.user()?.supportAccess;
      // staff see a merchant's portal only through an audited support session; members see their own organizations
      const ids = mine.length ? mine : s && new Date(s.until) > new Date() ? [s.organizationId] : [];
      const full = await Promise.all(ids.map((id) => api.get<Org>(`/organizations/${id}`)));
      setOrgs(full);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (ready && user) void load(); else if (ready) setLoading(false); }, [ready, user?.id, sup?.organizationId]);
  useEffect(() => { const l = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('loc') : null; if (l) setLocId(l); }, []);
  const all = useMemo(() => orgs.flatMap((o) => o.locations.map((l) => ({ ...l, organizationId: o.id }))), [orgs]);
  const loc = all.find((l) => l.id === locId) || all[0] || null;
  const org = orgs.find((o) => o.id === loc?.organizationId) || orgs[0] || null;
  const [ent, setEnt] = useState<Ent | null>(null);
  useEffect(() => { setEnt(null); if (loc?.id) api.get<Ent>(`/locations/${loc.id}/entitlements`).then(setEnt).catch(() => setEnt(null)); }, [loc?.id]);
  const locked = (h: string) => !!NEEDS[h] && !NEEDS[h].some((k) => allowed(ent, k));
  const memberRoles = (org && user?.memberRoles?.[org.id]) || [];
  const viaSupport = !!sup && !memberRoles.length;
  const roleOk = (h: string) => viaSupport || merchantPageAllowed(h, memberRoles);
  const nav = NAV.filter(([h]) => roleOk(h));
  // new-order alarm: the restaurant's own team (not support sessions) whose role covers the order inbox
  const alarmOn = !!user && !viaSupport && Object.keys(user.memberRoles || {}).length > 0 && roleOk('/merchant/orders');
  const { pending, reload: reloadPending } = usePendingOrders(alarmOn);
  if (!ready || loading) return <Spinner />;
  if (!user) return <Alert tone="info">Sign in with a merchant account to use the portal. <Link className="underline" href="/account">Sign in</Link></Alert>;
  if (!orgs.length && isStaff) return <SupportGate initialOrg={typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('support') : null} canWrite={can('merchants.manage')} onStarted={load} />;
  if (!orgs.length) return <Alert tone="info">No merchant organization yet. <Link className="underline" href="/for-restaurants">Create your listing</Link>.</Alert>;
  return (
    <MerchantCtx.Provider value={{ org, loc, orgs, ent, setLoc: setLocId, reload: load }}>
      {viaSupport && <div className="mb-3"><AccessBanner /></div>}
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <aside className="space-y-2">
          <select className="w-full rounded-lg border border-ink-100 bg-white px-2 py-2 text-sm" value={loc?.id || ''} onChange={(e) => setLocId(e.target.value)}>{all.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <nav className="flex flex-row flex-wrap gap-1 md:flex-col">{nav.map(([h, l]) => <Link key={h} href={h} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm ${path === h ? 'bg-brand-50 font-medium text-brand-700' : locked(h) ? 'text-ink-300 hover:bg-ink-50' : 'text-ink-700 hover:bg-ink-50'}`}>{l}{h === '/merchant/orders' && pending.length > 0 && <span className="animate-pulse rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white" aria-label={`${pending.length} orders waiting`}>{pending.length}</span>}{locked(h) && <span aria-label="Not in your plan" title="Not in your plan">🔒</span>}</Link>)}</nav>
          {alarmOn && <NewOrderAlarm pending={pending} reload={reloadPending} onView={(o) => setLocId(o.locationId)} />}
          {ent && <div className="text-xs text-ink-500">Plan: <b>{ent.planName || 'Default'}</b>{ent.source === 'LEGACY' ? ' (all features)' : ''}</div>}
          {loc && <div className="text-xs text-ink-500">Status: {loc.status}{loc.isPaused ? ' · paused' : ''}</div>}
        </aside>
        <section>{!roleOk(path) ? <Alert tone="info">This page isn&apos;t part of your role. {nav[0] && <Link className="underline" href={nav[0][0]}>Go to {nav[0][1]}</Link>}</Alert> : locked(path) ? <Locked keys={NEEDS[path]} ent={ent} /> : children}</section>
      </div>
    </MerchantCtx.Provider>
  );
}

function Locked({ keys, ent }: { keys: string[]; ent: Ent | null }) {
  const names = keys.map((k) => ent?.names[k] || k).join(' or ');
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-ink-100 bg-white p-6 text-center shadow-card">
      <div className="text-3xl">🔒</div>
      <h1 className="mt-2 text-xl font-bold">{names} isn&apos;t in your plan</h1>
      <p className="mt-1 text-sm text-ink-500">You&apos;re on {ent?.planName || 'the default plan'}. Switch to a plan or add-on that includes {names.toLowerCase()}.</p>
      <Link href="/merchant/billing" className="mt-4 inline-block rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">See plans & add-ons</Link>
    </div>
  );
}

/** Staff open a merchant's portal only through an audited, time-limited support session with a reason. */
function SupportGate({ initialOrg, canWrite, onStarted }: { initialOrg: string | null; canWrite: boolean; onStarted: () => void }) {
  const [q, setQ] = useState('');
  const [orgId, setOrgId] = useState(initialOrg || '');
  const [reason, setReason] = useState('');
  const [write, setWrite] = useState(false);
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (q.length >= 2) api.get<{ id: string; name: string }[]>(`/admin/organizations/lookup?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])); }, [q]);
  return (
    <div className="mx-auto max-w-lg">
      <Card title="Open a merchant portal (support access)">
        <div className="space-y-2 text-sm">
          <p className="text-ink-500">Your session is logged with the reason below and ends automatically after an hour. Merchant passwords are never shown.</p>
          {!initialOrg && <><Input label="Find merchant" value={q} onChange={(e) => setQ(e.target.value)} /><div className="flex flex-wrap gap-1">{hits.map((h) => <button key={h.id} className={`rounded-full border px-2 py-0.5 text-xs ${orgId === h.id ? 'border-brand-500 bg-brand-50' : 'border-ink-100'}`} onClick={() => setOrgId(h.id)}>{h.name}</button>)}</div></>}
          <Input label="Reason (e.g. ticket number, what the merchant asked for)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {canWrite && <label className="flex items-center gap-2"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Allow changes (otherwise read-only)</label>}
          {error && <Alert>{error}</Alert>}
          <Button disabled={!orgId || reason.trim().length < 5} onClick={async () => { setError(null); try { adoptTokens(await api.post('/access-grants/support', { organizationId: orgId, reason, readOnly: !write, minutes: 60 })); onStarted(); } catch (e) { setError((e as Error).message); } }}>Start support session</Button>
        </div>
      </Card>
    </div>
  );
}
