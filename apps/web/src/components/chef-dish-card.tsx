'use client';
import Link from 'next/link';
import { CHEF_FULFILLMENT_FORMATS, type PublicChefDish } from '@gutad/shared';
import { money } from '@/lib/api';
import { Badge } from '@/components/ui';

/** Storefront card: dish first, chef attribution, format, and customization status. */
export function ChefDishCard({ d }: { d: PublicChefDish }) {
  return (
    <Link href={`/chefs/dish/${d.id}`} className="group flex overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card transition hover:-translate-y-0.5">
      <div className="min-w-0 flex-1 space-y-1 p-4">
        <div className="font-semibold leading-snug text-ink-900 group-hover:text-brand-700">{d.title}</div>
        {d.description && <p className="line-clamp-2 text-xs text-ink-500">{d.description}</p>}
        <div className="flex flex-wrap gap-1 pt-1">
          <Badge>{CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat].split(' —')[0]}</Badge>
          {d.mode === 'CUSTOMIZABLE' && <Badge tone="info">Customizable</Badge>}
          {d.minLeadDays > 0 && <Badge>Order {d.minLeadDays}+ day{d.minLeadDays > 1 ? 's' : ''} ahead</Badge>}
          {d.soldOut && <Badge tone="warn">Sold out</Badge>}
        </div>
        <div className="pt-1 text-sm font-semibold">{money(d.priceCents)} <span className="font-normal text-ink-500">· {d.portionDesc}</span></div>
      </div>
      {d.photos[0] && <img src={d.photos[0]} alt="" className="h-auto w-32 shrink-0 object-cover sm:w-40" />}
    </Link>
  );
}
