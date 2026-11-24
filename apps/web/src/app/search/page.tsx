'use client';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { cardKey, RestaurantCard } from '@/components/restaurant-card';
import { Button, Input, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import type { LocationSummary, Paginated } from '@gutad/shared';

function SearchInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(sp.get('q') || '');
  const [city, setCity] = useState(sp.get('city') || '');
  const [service, setService] = useState(sp.get('service') || '');
  const [openNow, setOpenNow] = useState(sp.get('openNow') === 'true');
  const [seller, setSeller] = useState(sp.get('seller') || '');
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [data, setData] = useState<Paginated<LocationSummary> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (city) p.set('city', city);
    if (service) p.set('service', service);
    if (openNow) p.set('openNow', 'true');
    if (seller) p.set('seller', seller);
    if (near) {
      p.set('lat', String(near.lat));
      p.set('lng', String(near.lng));
      p.set('radiusKm', '15');
    }
    setLoading(true);
    api.get<Paginated<LocationSummary>>(`/public/search?${p.toString()}`).then(setData).finally(() => setLoading(false));
    router.replace(`/search?${p.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, city, service, openNow, near, seller]);

  const locate = () => navigator.geolocation?.getCurrentPosition((pos) => setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => alert('Location unavailable'));

  return (
    <div>
      <div className="grid gap-2 rounded-2xl border border-ink-100 bg-white p-4 shadow-card md:grid-cols-[1fr_160px_180px_170px_auto_auto]">
        <Input placeholder="Search cuisine, dish or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <Input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <Select value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Any service</option>
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
          <option value="reservations">Reservations</option>
          <option value="events">Experiences</option>
          <option value="catering">Catering</option>
        </Select>
        <Select value={seller} onChange={(e) => setSeller(e.target.value)} aria-label="Sold by">
          <option value="">All sellers</option>
          <option value="gutad">Gutad Kitchens</option>
          <option value="merchants">Restaurants only</option>
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> Open now</label>
        <Button variant="secondary" onClick={locate}>{near ? 'Near me ✓' : 'Near me'}</Button>
      </div>
      <div className="mt-6">
        {loading ? <Spinner /> : data?.items.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.items.map((l) => <RestaurantCard key={cardKey(l)} l={l} />)}</div> : <p className="text-ink-500">No matches. Try another city or clear filters.</p>}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SearchInner />
    </Suspense>
  );
}
