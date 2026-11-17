'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { CHEF_FULFILLMENT_FORMATS, type PublicChefDish } from '@gutad/shared';
import { money } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { QtyStepper } from '@/components/form-kit';

type Dish = PublicChefDish & { acceptingOrders: boolean };

/** Dish page: the dish first, chef attribution, format and timing; fixed dishes choose quantity and order. */
export default function ChefDishPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: d, loading, error } = useApi<Dish>(`/public/chef-dishes/${id}`);
  const { cart, add } = useCart();
  const [qty, setQty] = useState(1);
  const [photo, setPhoto] = useState(0);
  const [added, setAdded] = useState(false);
  if (loading) return <Spinner />;
  if (error || !d) return <Alert tone="info">This dish isn’t available right now. <Link className="underline" href="/chefs">Browse chefs</Link></Alert>;
  const otherPlace = !!cart.locationId && cart.locationId !== d.location.id && cart.lines.length > 0;
  const canOrder = d.acceptingOrders && !d.soldOut;
  const addToCart = (go: boolean) => {
    add({ id: d.location.id, slug: d.location.slug, name: `${d.chef.displayName} (Gutad Chef Network)` }, { menuItemId: d.menuItemId, name: d.title, quantity: qty, unitPriceCents: d.priceCents, modifierOptionIds: [], modifierNames: [], modifiersCents: 0 }, 'MARKETPLACE', 'chef-network', { park: true });
    setAdded(true);
    if (go) router.push('/checkout');
  };
  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[1fr_360px] lg:pb-0">
      <div className="space-y-4">
        <Link href={`/chefs/${d.chef.slug}`} className="text-sm text-ink-500 hover:underline">← {d.chef.displayName}</Link>
        <div className="overflow-hidden rounded-3xl bg-ink-100">
          {d.photos[photo] ? <img src={d.photos[photo]} alt={d.title} className="aspect-[4/3] w-full object-cover" /> : <div className="grid aspect-[4/3] place-items-center text-5xl">🍽</div>}
        </div>
        {d.photos.length > 1 && <div className="flex gap-2">{d.photos.map((u, i) => <button key={u} onClick={() => setPhoto(i)} aria-label={`Photo ${i + 1}`} className={`overflow-hidden rounded-lg border-2 ${i === photo ? 'border-brand-500' : 'border-transparent'}`}><img src={u} alt="" className="h-16 w-16 object-cover" /></button>)}</div>}
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{d.title}</h1>
          <Link href={`/chefs/${d.chef.slug}`} className="mt-2 flex items-center gap-2 text-sm text-ink-700">
            {d.chef.portraitUrl ? <img src={d.chef.portraitUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : <span>👩‍🍳</span>}
            <span>Prepared by <strong>{d.chef.displayName}</strong> at an approved partner kitchen · <span className="underline">View chef</span></span>
          </Link>
        </div>
        <div className="flex flex-wrap gap-1"><Badge>{CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat]}</Badge><Badge tone={d.mode === 'CUSTOMIZABLE' ? 'info' : 'neutral'}>{d.mode === 'CUSTOMIZABLE' ? 'Customizable' : 'Fixed recipe'}</Badge>{d.dietaryTags.map((t) => <Badge key={t} tone="good">{t.replace('_', ' ')}</Badge>)}</div>
        {d.description && <p className="text-ink-700">{d.description}</p>}
        <dl className="grid gap-3 rounded-2xl border border-ink-100 bg-white p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-500">Portion</dt><dd>{d.portionDesc}</dd></div>
          <div><dt className="text-xs text-ink-500">Ordering</dt><dd>{d.minLeadDays ? `At least ${d.minLeadDays} day${d.minLeadDays > 1 ? 's' : ''} ahead` : 'Same day available'}, up to {d.maxAdvanceDays} days ahead · cutoff {d.cutoffHour}:00 the day before</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-ink-500">Ingredients</dt><dd>{d.ingredients.join(', ')}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-ink-500">Allergens</dt><dd className={d.allergens.length ? 'font-medium text-red-700' : ''}>{d.allergens.length ? d.allergens.map((a) => a.replace('_', ' ')).join(', ') : 'None of the major allergens declared'}</dd><dd className="mt-1 text-xs text-ink-500">Prepared in a kitchen that may handle other allergens. If you have a severe allergy, contact Gutad support before ordering.</dd></div>
        </dl>
        {d.mode === 'CUSTOMIZABLE' && <p className="text-sm text-ink-500">Customization options for this dish are coming soon; it currently orders as the chef’s standard recipe.</p>}
      </div>
      <aside className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white p-4 shadow-[0_-8px_24px_-12px_rgba(0,0,0,.2)] lg:sticky lg:top-20 lg:self-start lg:rounded-2xl lg:border lg:shadow-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 lg:block lg:space-y-4">
          <div className="hidden lg:block"><div className="text-sm text-ink-500">Price</div><div className="text-2xl font-bold">{money(d.priceCents)}</div></div>
          <QtyStepper label="Quantity" value={qty} min={1} max={20} onChange={setQty} />
          <div className="flex flex-1 flex-col gap-2 lg:flex-none">
            {!canOrder ? (
              <Button size="lg" disabled className="w-full">{d.soldOut ? 'Sold out' : 'Not taking orders right now'}</Button>
            ) : (
              <>
                <Button size="lg" className="w-full" onClick={() => addToCart(true)}>Add to cart — {money(d.priceCents * qty)}</Button>
                <Button variant="secondary" className="hidden w-full lg:inline-flex" onClick={() => addToCart(false)}>Add and keep browsing</Button>
              </>
            )}
          </div>
        </div>
        {otherPlace && <p className="mt-2 text-xs text-ink-500 lg:mt-0">Your cart has items from {cart.locationName}; they’ll be kept as a separate order.</p>}
        {added && <p className="mt-2 text-xs text-emerald-700">Added. <Link href="/checkout" className="underline">Go to checkout</Link> to choose your date and time.</p>}
        <p className="mt-2 hidden text-xs text-ink-500 lg:block">Choose your pickup or delivery date and time at checkout. Sold by Gutad.</p>
      </aside>
    </div>
  );
}
