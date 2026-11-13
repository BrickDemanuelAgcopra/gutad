'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { MerchantCtx, type Org } from './context';
import { api } from '@/lib/api';
import { useLocalState, useSession } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';


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
  if (!ready || loading) return <Spinner />;
  if (!user) return <Alert tone="info">Sign in with a merchant account to use the portal. <Link className="underline" href="/account">Sign in</Link></Alert>;
  if (!orgs.length) return <Alert tone="info">No merchant organization yet. <Link className="underline" href="/for-restaurants">Create your listing</Link>.</Alert>;
  return (
    <MerchantCtx.Provider value={{ org, loc, orgs, setLoc: setLocId, reload: load }}>
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <aside className="space-y-2">
          <select className="w-full rounded-lg border border-ink-100 bg-white px-2 py-2 text-sm" value={loc?.id || ''} onChange={(e) => setLocId(e.target.value)}>{all.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <nav className="flex flex-row flex-wrap gap-1 md:flex-col">{NAV.map(([h, l]) => <Link key={h} href={h} className={`rounded-lg px-3 py-1.5 text-sm ${path === h ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}>{l}</Link>)}</nav>
          {loc && <div className="text-xs text-ink-500">Status: {loc.status}{loc.isPaused ? ' · paused' : ''}</div>}
        </aside>
        <section>{children}</section>
      </div>
    </MerchantCtx.Provider>
  );
}
