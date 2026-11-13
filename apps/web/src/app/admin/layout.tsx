'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';

const NAV = [['/admin', 'Tenants & verification'], ['/admin/plans', 'Plans & pricing'], ['/admin/finance', 'Finance'], ['/admin/support', 'Support'], ['/admin/integrations', 'Integrations & health'], ['/admin/settings', 'Settings & audit']];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, isAdmin } = useSession();
  const path = usePathname();
  if (!ready) return <Spinner />;
  if (!user || !isAdmin) return <Alert tone="info">Platform staff only. <Link className="underline" href="/account">Sign in</Link></Alert>;
  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <nav className="flex flex-row flex-wrap gap-1 md:flex-col">{NAV.map(([h, l]) => <Link key={h} href={h} className={`rounded-lg px-3 py-1.5 text-sm ${path === h ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}>{l}</Link>)}</nav>
      <section>{children}</section>
    </div>
  );
}
