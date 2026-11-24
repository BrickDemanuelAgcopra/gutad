'use client';
import Link from 'next/link';
import { useApi } from '@/lib/hooks';
import { Spinner } from '@/components/ui';

interface PublicPolicy { version: number; label: string; summary: string[]; cities: { city: string; summary: string[] }[] }

/** How search ranks restaurants and the food Gutad sells itself; the first-party part is read live from the admin policy. */
export default function MarketplacePolicyPage() {
  const { data } = useApi<PublicPolicy>('/public/marketplace-policy');
  return (
    <article className="mx-auto max-w-3xl space-y-6 py-6">
      <header>
        <h1 className="text-3xl font-bold">How Gutad ranks restaurants</h1>
        <p className="mt-2 text-ink-700">Gutad is a marketplace for independent restaurants, and Gutad also sells some food itself. This page explains how search results are ordered and the rules Gutad follows for its own food.</p>
      </header>
      <section>
        <h2 className="text-xl font-semibold">Search order</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-700">
          <li>Sponsored results come first and are always marked “Sponsored”.</li>
          <li>Then restaurants whose plan includes extra visibility.</li>
          <li>Then places that are open now, ahead of closed ones.</li>
          <li>Then higher customer ratings.</li>
          <li>Then the shortest distance from you.</li>
        </ol>
      </section>
      <section>
        <h2 className="text-xl font-semibold">Food sold by Gutad</h2>
        {!data ? <Spinner /> : (
          <>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-700">{data.summary.map((s) => <li key={s}>{s}</li>)}</ul>
            {data.cities.map((c) => (
              <div key={c.city} className="mt-3">
                <h3 className="font-semibold capitalize">In {c.city}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-700">{c.summary.map((s) => <li key={s}>{s}</li>)}</ul>
              </div>
            ))}
            <p className="mt-3 text-sm text-ink-500">You can show only Gutad&rsquo;s food or only restaurants with the “Sold by” filter in <Link className="underline" href="/search">search</Link>. Policy version {data.version || 'default'}.</p>
          </>
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold">Restaurant data</h2>
        <p className="mt-2 text-ink-700">The team that runs Gutad&rsquo;s own kitchens works only inside Gutad&rsquo;s own account. They don&rsquo;t see any individual restaurant&rsquo;s sales, menu performance or customers, and they can&rsquo;t use that information to compete with restaurants.</p>
      </section>
    </article>
  );
}
