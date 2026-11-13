import Link from 'next/link';
import type { LocationSummary } from '@gutad/shared';
import { GBadge } from './made-at-gutad';

/** Stable React key: a Made at Gutad food hall appears once per brand. */
export const cardKey = (l: LocationSummary) => `${l.id}:${l.brand?.id ?? ''}`;

export function RestaurantCard({ l }: { l: LocationSummary }) {
  const href = l.brand ? `/r/${l.slug}?brand=${encodeURIComponent(l.brand.slug)}` : `/r/${l.slug}`;
  return (
    <Link href={href} className="group overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card transition hover:-translate-y-0.5">
      <div className="relative h-40 bg-ink-100">
        {(l.brand?.logoUrl || l.heroImageUrl) && <img src={l.brand?.logoUrl || l.heroImageUrl!} alt="" className="h-full w-full object-cover" />}
        {l.sponsored && <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold uppercase text-ink-700">Sponsored</span>}
        <span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${l.isOpenNow ? 'bg-emerald-500 text-white' : 'bg-ink-900/70 text-white'}`}>{l.isOpenNow ? 'Open' : 'Closed'}</span>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex items-center gap-1.5 font-semibold group-hover:text-brand-600">
            {l.platformOperated && <GBadge className="h-5 w-5" />}
            {l.name}
          </h3>
          {l.rating && <span className="text-sm text-ink-700">★ {l.rating.toFixed(1)} <span className="text-ink-300">({l.ratingCount})</span></span>}
        </div>
        {l.brand ? (
          <p className="mt-1 text-xs text-ink-500"><span className="font-medium text-emerald-700">Made at Gutad</span> · {l.foodHallName} · {l.city}{typeof l.distanceKm === 'number' ? ` · ${l.distanceKm.toFixed(1)} km` : ''}</p>
        ) : (
          <p className="mt-1 text-xs text-ink-500">{l.platformOperated && <span className="font-medium text-emerald-700">Made at Gutad · </span>}{l.cuisine.join(' · ')} · {l.city}{typeof l.distanceKm === 'number' ? ` · ${l.distanceKm.toFixed(1)} km` : ''}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-1 text-[11px] font-medium text-ink-700">
          {l.acceptsPickup && <span className="rounded-full bg-ink-100 px-2 py-0.5">Pickup</span>}
          {l.acceptsDelivery && <span className="rounded-full bg-ink-100 px-2 py-0.5">Delivery</span>}
          {l.acceptsReservations && <span className="rounded-full bg-ink-100 px-2 py-0.5">Reservations</span>}
          {l.acceptsEvents && <span className="rounded-full bg-ink-100 px-2 py-0.5">Events</span>}
          {l.brand && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">Combine with other menus</span>}
        </div>
      </div>
    </Link>
  );
}
