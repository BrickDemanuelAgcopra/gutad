'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ADMIN_GROUPS, modulesFor, STAFF_ROLE_LABELS, type StaffRole } from '@gutad/shared';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Spinner } from '@/components/ui';
import { AccessBanner } from '@/components/admin-ui';

/**
 * Central admin entry point. Navigation comes from the shared module registry (also used by the mobile Ops
 * workspace) and shows only the modules the signed-in person's permissions allow.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, isAdmin } = useSession();
  const path = usePathname();
  const perms = user?.permissions || (user?.roles.includes('PLATFORM_ADMIN') ? ['merchants.read'] : []);
  const { data: summary } = useApi<{ pending: number }>(isAdmin && perms.includes('approvals.decide') ? '/approvals/summary' : null, { poll: 30000 });
  if (!ready) return <Spinner />;
  if (!user || !isAdmin) return <Alert tone="info">Platform staff only. <Link className="underline" href="/account">Sign in</Link></Alert>;
  const mods = modulesFor(perms);
  const roles = user.roles.filter((r) => r in STAFF_ROLE_LABELS).map((r) => STAFF_ROLE_LABELS[r as StaffRole]);
  const active = (web: string) => (web === '/admin' ? path === '/admin' : path === web || path.startsWith(`${web}/`));
  return (
    <div className="space-y-4">
      <AccessBanner />
      <div className="grid gap-6 md:grid-cols-[230px_1fr]">
        <nav className="space-y-3">
          <div className="rounded-xl bg-ink-50 px-3 py-2 text-xs text-ink-500"><div className="font-semibold text-ink-900">Gutad control center</div>{roles.join(' · ') || 'Staff'}{user.elevated ? ' · elevated' : ''}</div>
          {mods.length === 0 && <p className="px-3 text-xs text-ink-500">No console modules yet. {user.mfaSetupRequired ? 'Set up two-factor authentication first.' : 'Ask an administrator for access.'}</p>}
          {ADMIN_GROUPS.map((g) => {
            const items = mods.filter((m) => m.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{g}</div>
                <div className="flex flex-row flex-wrap gap-1 md:flex-col">
                  {items.map((m) => (
                    <Link key={m.key} href={m.web} title={m.description} className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${active(m.web) ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}>
                      {m.label}
                      {m.key === 'approvals' && !!summary?.pending && <span className="rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-white">{summary.pending}</span>}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <section className="min-w-0">{children}</section>
      </div>
    </div>
  );
}
