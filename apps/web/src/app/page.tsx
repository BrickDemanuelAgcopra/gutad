import Link from 'next/link';
import { serverGet } from '@/lib/server';
import type { LocationSummary, Paginated } from '@gutad/shared';
import { RestaurantCard } from '@/components/restaurant-card';

export const revalidate = 60;

export default async function Home() {
  const res = await serverGet<Paginated<LocationSummary>>('/public/search?pageSize=6');
  const items = res?.items || [];
  return (
    <div>
      <section className="rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 px-6 py-14 text-white shadow-card md:px-12">
        <h1 className="max-w-2xl text-4xl font-bold leading-tight md:text-5xl">One page to order a meal, book a table, or plan a night out.</h1>
        <p className="mt-4 max-w-xl text-brand-100">Pickup and delivery from local kitchens, reservations with real-time availability, ticketed experiences and private events — all from Gutad.</p>
        <form action="/search" className="mt-8 flex max-w-xl flex-col gap-2 sm:flex-row">
          <input name="q" placeholder="Cuisine, dish or restaurant" className="flex-1 rounded-xl px-4 py-3 text-ink-900 outline-none" />
          <input name="city" placeholder="City" defaultValue="New York" className="rounded-xl px-4 py-3 text-ink-900 outline-none sm:w-40" />
          <button className="rounded-xl bg-ink-900 px-5 py-3 font-semibold text-white hover:bg-ink-700">Search</button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          {[['pickup', 'Pickup'], ['delivery', 'Delivery'], ['reservations', 'Book a table'], ['events', 'Experiences'], ['catering', 'Catering']].map(([s, l]) => (
            <Link key={s} href={`/search?service=${s}`} className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25">{l}</Link>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-2xl font-bold">Popular near you</h2>
          <Link href="/search" className="text-sm font-medium text-brand-600">See all</Link>
        </div>
        {items.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map((l) => <RestaurantCard key={l.id} l={l} />)}</div>
        ) : (
          <p className="text-ink-500">No restaurants published yet. <Link className="underline" href="/for-restaurants">List yours</Link>.</p>
        )}
      </section>

      <section className="mt-14 grid gap-4 md:grid-cols-3">
        {[
          ['Order', 'Scheduled pickup, delivery with live tracking, group orders for teams, and multi-brand bags from shared kitchens.'],
          ['Reserve', 'Real table inventory, waitlists, deposits and guarantees — no double booking, ever.'],
          ['Experience', 'Ticketed tastings and classes, private dining inquiries with proposals and deposits.'],
        ].map(([t, d]) => (
          <div key={t} className="rounded-2xl border border-ink-100 bg-white p-6 shadow-card">
            <h3 className="text-lg font-semibold">{t}</h3>
            <p className="mt-2 text-sm text-ink-500">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
