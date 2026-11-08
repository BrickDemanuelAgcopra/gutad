import Link from 'next/link';
import type { LocationSummary } from '@gutad/shared';

export function RestaurantCard({ l }: { l: LocationSummary }) {
  return (
    <Link href={`/r/${l.slug}`} className="group overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card transition hover:-translate-y-0.5">
      <div className="relative h-40 bg-ink-100">
        {l.heroImageUrl && <img src={l.heroImageUrl} alt="" className="h-full w-full object-cover" />}
        {l.sponsored && <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold uppercase text-ink-700">Sponsored</span>}
        <span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${l.isOpenNow ? 'bg-emerald-500 text-white' : 'bg-ink-900/70 text-white'}`}>{l.isOpenNow ? 'Open' : 'Closed'}</span>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold group-hover:text-brand-600">{l.name}</h3>
          {l.rating && <span className="text-sm text-ink-700">★ {l.rating.toFixed(1)} <span className="text-ink-300">({l.ratingCount})</span></span>}
        </div>
        <p className="mt-1 text-xs text-ink-500">{l.cuisine.join(' · ')} · {l.city}{typeof l.distanceKm === 'number' ? ` · ${l.distanceKm.toFixed(1)} km` : ''}</p>
        <div className="mt-3 flex flex-wrap gap-1 text-[11px] font-medium text-ink-700">
          {l.acceptsPickup && <span className="rounded-full bg-ink-100 px-2 py-0.5">Pickup</span>}
          {l.acceptsDelivery && <span className="rounded-full bg-ink-100 px-2 py-0.5">Delivery</span>}
          {l.acceptsReservations && <span className="rounded-full bg-ink-100 px-2 py-0.5">Reservations</span>}
          {l.acceptsEvents && <span className="rounded-full bg-ink-100 px-2 py-0.5">Events</span>}
        </div>
      </div>
    </Link>
  );
}
