'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { allowed, MerchantCtx, type Ent, type Org } from './context';
import { api } from '@/lib/api';
import { useLocalState, useSession } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';


/** Nav items that need a plan feature (any one of the listed keys unlocks the page). */
const NEEDS: Record<string, string[]> = { '/merchant/host': ['floor_plan'], '/merchant/dispatch': ['delivery'], '/merchant/events': ['experiences', 'private_events'] };

const NAV = [
  ['/merchant', 'Dashboard'], ['/merchant/onboarding', 'Onboarding'], ['/merchant/orders', 'Orders'], ['/merchant/menu', 'Menu'], ['/merchant/host', 'Host stand'], ['/merchant/dispatch', 'Delivery'], ['/merchant/kitchen', 'Kitchen'], ['/merchant/events', 'Events'], ['/merchant/guests', 'Guests'], ['/merchant/growth', 'Growth'], ['/merchant/finance', 'Finance'], ['/merchant/shift', 'Shift'], ['/merchant/settings', 'Settings'],
];

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const path = usePathname();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [locId, setLocId] = useLocalState<string | null>('gutad.merchant.loc', null);
  const load = async () => {
    try {
      const list = await api.get<{ id: string }[]>('/organizations');
      const full = await Promise.all(list.map((o) => api.get<Org>(`/organizations/${o.id}`)));
      setOrgs(full);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (ready && user) void load(); else if (ready) setLoading(false); }, [ready, user]);
  const all = useMemo(() => orgs.flatMap((o) => o.locations.map((l) => ({ ...l, organizationId: o.id }))), [orgs]);
  const loc = all.find((l) => l.id === locId) || all[0] || null;
  const org = orgs.find((o) => o.id === loc?.organizationId) || orgs[0] || null;
  const [ent, setEnt] = useState<Ent | null>(null);
  useEffect(() => { setEnt(null); if (loc?.id) api.get<Ent>(`/locations/${loc.id}/entitlements`).then(setEnt).catch(() => setEnt(null)); }, [loc?.id]);
  const locked = (h: string) => !!NEEDS[h] && !NEEDS[h].some((k) => allowed(ent, k));
  if (!ready || loading) return <Spinner />;
  if (!user) return <Alert tone="info">Sign in with a merchant account to use the portal. <Link className="underline" href="/account">Sign in</Link></Alert>;
  if (!orgs.length) return <Alert tone="info">No merchant organization yet. <Link className="underline" href="/for-restaurants">Create your listing</Link>.</Alert>;
  return (
    <MerchantCtx.Provider value={{ org, loc, orgs, ent, setLoc: setLocId, reload: load }}>
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <aside className="space-y-2">
          <select className="w-full rounded-lg border border-ink-100 bg-white px-2 py-2 text-sm" value={loc?.id || ''} onChange={(e) => setLocId(e.target.value)}>{all.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <nav className="flex flex-row flex-wrap gap-1 md:flex-col">{NAV.map(([h, l]) => <Link key={h} href={h} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm ${path === h ? 'bg-brand-50 font-medium text-brand-700' : locked(h) ? 'text-ink-300 hover:bg-ink-50' : 'text-ink-700 hover:bg-ink-50'}`}>{l}{locked(h) && <span aria-label="Not in your plan" title="Not in your plan">🔒</span>}</Link>)}</nav>
          {ent && <div className="text-xs text-ink-500">Plan: <b>{ent.planName || 'Default'}</b>{ent.source === 'LEGACY' ? ' (all features)' : ''}</div>}
          {loc && <div className="text-xs text-ink-500">Status: {loc.status}{loc.isPaused ? ' · paused' : ''}</div>}
        </aside>
        <section>{locked(path) ? <Locked keys={NEEDS[path]} ent={ent} /> : children}</section>
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
      <p className="mt-1 text-sm text-ink-500">You&apos;re on {ent?.planName || 'the default plan'}. Compare plans to see which ones include {names.toLowerCase()}, then contact Gutad to switch.</p>
      <Link href="/pricing" className="mt-4 inline-block rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">Compare plans</Link>
    </div>
  );
}
