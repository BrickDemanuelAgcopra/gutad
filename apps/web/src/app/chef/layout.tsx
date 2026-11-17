'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';

/** Chef portal. Order handling, tickets and finance reuse the merchant workspace of the chef's organization. */
const NAV: [string, string][] = [
  ['/chef', 'Dashboard'],
  ['/chef/dishes', 'Dishes'],
  ['/chef/profile', 'Public profile'],
  ['/merchant/orders', 'Orders'],
  ['/merchant/kitchen', 'Kitchen tickets'],
  ['/merchant/finance', 'Earnings'],
];

export default function ChefLayout({ children }: { children: React.ReactNode }) {
  const { user, ready } = useSession();
  const path = usePathname();
  if (!ready) return <Spinner />;
  if (!user) return <Alert tone="info">Sign in with your chef account. <Link className="underline" href="/chefs/apply">Apply or sign in</Link></Alert>;
  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <aside className="space-y-2">
        <div className="rounded-xl bg-ink-900 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-brand-300">Chef Network</div>
        <nav className="flex flex-row flex-wrap gap-1 md:flex-col">
          {NAV.map(([h, l]) => (
            <Link key={h} href={h} className={`rounded-lg px-3 py-1.5 text-sm ${path === h || (h !== '/chef' && path.startsWith(`${h}/`)) ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}>{l}</Link>
          ))}
        </nav>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
