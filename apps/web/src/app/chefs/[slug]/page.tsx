'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { WEEKDAYS, type PublicChefDish } from '@gutad/shared';
import { ChefDishCard } from '@/components/chef-dish-card';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Card, Spinner } from '@/components/ui';
import type { PublicChef } from '../page';

const CRED: Record<string, string> = { GOV_ID: 'Identity verified', FOOD_HANDLER: 'Food handler certified', KITCHEN_PERMIT: 'Permitted kitchen', HOME_KITCHEN_PERMIT: 'Permitted home kitchen', LIABILITY_INSURANCE: 'Insured', KITCHEN_USE_AGREEMENT: 'Approved commissary' };

export default function ChefStorefront() {
  const { slug } = useParams<{ slug: string }>();
  const { data: c, loading, error } = useApi<PublicChef>(`/public/chefs/${slug}`);
  const { data: dishes } = useApi<PublicChefDish[]>(`/public/chefs/${slug}/dishes`);
  const sections = Array.from(new Set((dishes || []).map((d) => d.section || 'Dishes')));
  if (loading) return <Spinner />;
  if (error || !c) return <Alert tone="info">This chef isn’t available. <Link className="underline" href="/chefs">Browse chefs</Link></Alert>;
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-3xl border border-ink-100 bg-white p-6 shadow-card sm:flex-row sm:items-center">
        {c.portraitUrl ? <img src={c.portraitUrl} alt={c.displayName} className="h-28 w-28 rounded-full object-cover" /> : <div className="grid h-28 w-28 place-items-center rounded-full bg-brand-100 text-4xl">👩‍🍳</div>}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">Gutad Besties</p>
          <h1 className="text-3xl font-bold">{c.displayName}</h1>
          <p className="text-sm text-ink-500">{c.cuisines.join(' · ')}{c.experienceYears ? ` · ${c.experienceYears} years cooking` : ''}{c.languages.length ? ` · Speaks ${c.languages.join(', ')}` : ''}</p>
          <div className="mt-2 flex flex-wrap gap-1">{c.verifiedCredentials.filter((k) => CRED[k]).map((k) => <Badge key={k} tone="good">✓ {CRED[k]}</Badge>)}</div>
        </div>
        {!c.acceptingOrders && <Badge tone="warn">Not taking orders right now</Badge>}
      </section>
      {sections.map((s) => (
        <section key={s} className="space-y-3">
          <h2 className="text-xl font-bold">{s}</h2>
          <div className="grid gap-3 md:grid-cols-2">{(dishes || []).filter((d) => (d.section || 'Dishes') === s).map((d) => <ChefDishCard key={d.id} d={d} />)}</div>
        </section>
      ))}
      {dishes && !dishes.length && <Card><p className="text-sm text-ink-500">{c.displayName} hasn’t published dishes yet.</p></Card>}
      {c.bio && <Card title={`About ${c.displayName}`}><p className="whitespace-pre-line text-sm text-ink-700">{c.bio}</p></Card>}
      <Card title="Ordering">
        <p className="text-sm text-ink-700">Cooks on {(c.operating.cookingDays || []).map((d) => WEEKDAYS[d]).join(', ') || 'selected days'} · order at least {c.operating.minLeadDays ?? 1} day(s) ahead, up to {c.operating.maxAdvanceDays ?? 30} days in advance.</p>
        <p className="mt-2 text-xs text-ink-500">Sold by Gutad. Prepared by {c.displayName} in an approved partner kitchen.</p>
      </Card>
      {c.portfolio.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{c.portfolio.map((u) => <img key={u} src={u} alt="" className="aspect-square w-full rounded-xl object-cover" />)}</div>
      )}
    </div>
  );
}
