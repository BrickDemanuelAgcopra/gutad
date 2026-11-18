'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CHEF_CUISINES } from '@gutad/shared';
import { useApi } from '@/lib/hooks';
import { Empty, Input, Select, Spinner } from '@/components/ui';

export interface PublicChef { id: string; slug: string; displayName: string; bio: string | null; portraitUrl: string | null; portfolio: string[]; cuisines: string[]; languages: string[]; experienceYears: number | null; serviceCity: string | null; serviceRegion: string | null; verifiedCredentials: string[]; acceptingOrders: boolean; operating: { cookingDays?: number[]; minLeadDays?: number; maxAdvanceDays?: number } }

export default function ChefsDirectory() {
  const [q, setQ] = useState('');
  const [cuisine, setCuisine] = useState('');
  const params = new URLSearchParams();
  if (q.trim().length >= 2) params.set('q', q.trim());
  if (cuisine) params.set('cuisine', cuisine);
  const { data, loading } = useApi<PublicChef[]>(`/public/chefs?${params}`, { deps: [q, cuisine] });
  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-brand-50 p-6 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">Gutad Bestie Network</p>
        <h1 className="mt-2 text-3xl font-bold text-ink-900">Dishes by independent chefs, delivered by Gutad</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-700">Every chef is reviewed and cooks in an approved kitchen. Order for today, or schedule ahead for holidays and celebrations.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_220px]">
          <Input aria-label="Search chefs" placeholder="Search chefs or dishes" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select aria-label="Cuisine" value={cuisine} onChange={(e) => setCuisine(e.target.value)}><option value="">All cuisines</option>{CHEF_CUISINES.map((c) => <option key={c}>{c}</option>)}</Select>
        </div>
      </section>
      {loading && !data ? <Spinner /> : !data?.length ? (
        <Empty>No chefs match yet. <Link href="/chefs/apply" className="underline">Are you a chef? Apply to become a Gutad Bestie.</Link></Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((c) => (
            <Link key={c.id} href={`/chefs/${c.slug}`} className="group overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card transition hover:-translate-y-0.5">
              <div className="aspect-[16/9] bg-ink-100">{(c.portfolio[0] || c.portraitUrl) && <img src={c.portfolio[0] || c.portraitUrl!} alt="" className="h-full w-full object-cover" />}</div>
              <div className="flex gap-3 p-4">
                {c.portraitUrl ? <img src={c.portraitUrl} alt="" className="-mt-10 h-14 w-14 shrink-0 rounded-full border-4 border-white object-cover" /> : <div className="-mt-10 grid h-14 w-14 shrink-0 place-items-center rounded-full border-4 border-white bg-brand-100">👩‍🍳</div>}
                <div className="min-w-0">
                  <div className="font-semibold text-ink-900 group-hover:text-brand-700">{c.displayName}</div>
                  <div className="text-xs text-ink-500">{c.cuisines.join(' · ')} · {c.serviceCity}</div>
                  {c.bio && <p className="mt-1 line-clamp-2 text-xs text-ink-700">{c.bio}</p>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      <p className="text-center text-sm text-ink-500">Cook professionally? <Link href="/chefs/apply" className="font-medium text-brand-700 underline">Become a Gutad Bestie</Link></p>
    </div>
  );
}
