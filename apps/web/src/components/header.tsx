'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { useSession } from '@/lib/hooks';

export function Header() {
  const { user, ready, isMerchant, isAdmin, logout } = useSession();
  const { count } = useCart();
  const path = usePathname();
  if (path?.startsWith('/embed')) return null;
  return (
    <header className="sticky top-0 z-40 border-b border-ink-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink-900">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-white">G</span>
          Gutad
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          <Link href="/search" className="rounded-lg px-3 py-1.5 text-ink-700 hover:bg-ink-50">Restaurants</Link>
          <Link href="/search?service=reservations" className="rounded-lg px-3 py-1.5 text-ink-700 hover:bg-ink-50">Reserve</Link>
          <Link href="/search?service=events" className="rounded-lg px-3 py-1.5 text-ink-700 hover:bg-ink-50">Experiences</Link>
          <Link href="/meal-kits" className="rounded-lg px-3 py-1.5 text-ink-700 hover:bg-ink-50">Meal kits</Link>
          <Link href="/for-restaurants" className="rounded-lg px-3 py-1.5 text-ink-700 hover:bg-ink-50">For restaurants</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/checkout" className="relative rounded-lg border border-ink-100 px-3 py-1.5 text-sm font-medium text-ink-900 hover:bg-ink-50">
            Cart{count > 0 && <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[11px] text-white">{count}</span>}
          </Link>
          {ready && user ? (
            <>
              {isMerchant && <Link href="/merchant" className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">Merchant</Link>}
              {isAdmin && <Link href="/admin" className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">Admin</Link>}
              <Link href="/account" className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">{user.name?.split(' ')[0] || 'Account'}</Link>
              <button onClick={logout} className="rounded-lg px-2 py-1.5 text-sm text-ink-500 hover:bg-ink-50">Sign out</button>
            </>
          ) : (
            ready && <Link href="/account" className="rounded-lg bg-ink-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-ink-700">Sign in</Link>
          )}
        </div>
      </div>
    </header>
  );
}
