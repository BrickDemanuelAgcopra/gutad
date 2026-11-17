'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CHEF_FULFILLMENT_FORMATS, chefNoticeText, modifierLabel, type ChefAvailability, type PublicChefDish } from '@gutad/shared';
import { money } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { QtyStepper } from '@/components/form-kit';
import { CustomizationSummary, DishCustomizer, useCustomization } from '@/components/dish-customizer';
import { DateSlotPicker, preferredDate, type DateSlot } from '@/components/date-slot-picker';
import { NewRequestModal } from '@/components/chef-requests';

type Dish = PublicChefDish & { acceptingOrders: boolean };

export default function ChefDishPage() {
  const { id } = useParams<{ id: string }>();
  const { data: d, loading, error } = useApi<Dish>(`/public/chef-dishes/${id}`);
  if (loading) return <Spinner />;
  if (error || !d) return <Alert tone="info">This dish isn’t available right now. <Link className="underline" href="/chefs">Browse chefs</Link></Alert>;
  return <DishView d={d} />;
}

/**
 * Progressive disclosure: the dish first; "Customize" reveals the options. Desktop shows options beside a sticky
 * summary; phones use a full-height sheet with a persistent bottom action. Price updates as you choose.
 */
function DishView({ d }: { d: Dish }) {
  const router = useRouter();
  const { cart, add } = useCart();
  const groups = useMemo(() => d.groups || [], [d.groups]);
  const base = useMemo(() => ({ allergens: d.allergens, dietaryTags: d.dietaryTags }), [d.allergens, d.dietaryTags]);
  const { picks, setPicks, ev } = useCustomization(d.dishName, groups, base);
  const customizable = groups.some((g) => g.selectionType !== 'INCLUDED');
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [qty, setQty] = useState(1);
  const [photo, setPhoto] = useState(0);
  const [added, setAdded] = useState(false);
  // special request: opened from the button or the customizer's “Ask Chef X to add …”
  const [asking, setAsking] = useState<{ ingredient?: string } | null>(null);
  const askChef = (term?: string) => { setSheet(false); setAsking({ ingredient: term }); };
  const optsRef = useRef<HTMLDivElement>(null);
  // advance ordering: which dates this dish (at this quantity) can still be ordered for
  const { data: avail, loading: availLoading } = useApi<ChefAvailability>(`/public/chef-dishes/${d.id}/availability?quantity=${qty}`);
  const [day, setDay] = useState<DateSlot | null>(null);
  const pickDay = (v: DateSlot) => { setDay(v); preferredDate.set(d.location.id, v.date); };
  const nextDate = avail?.earliestDate ? new Date(`${avail.earliestDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : null;
  useEffect(() => { document.body.style.overflow = sheet ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [sheet]);
  // deep link: /chefs/dish/<id>?customize=1 opens the options directly
  useEffect(() => { if (customizable && new URLSearchParams(window.location.search).get('customize') === '1') { setOpen(true); if (!window.matchMedia('(min-width: 1024px)').matches) setSheet(true); } }, [customizable]);
  const otherPlace = !!cart.locationId && cart.locationId !== d.location.id && cart.lines.length > 0;
  const noDates = !!avail && !avail.earliestDate;
  const canOrder = d.acceptingOrders && !d.soldOut && !noDates;
  const unit = d.priceCents + ev.modifiersCents;
  const customize = () => {
    setOpen(true);
    if (window.matchMedia('(min-width: 1024px)').matches) setTimeout(() => optsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    else setSheet(true);
  };
  const addToCart = (go: boolean) => {
    if (!ev.ok) return;
    const names = ev.chosen.filter((c) => c.priceCents > 0 || !groups.find((g) => g.id === c.groupId)?.options.find((o) => o.id === c.id)?.isDefault).map(modifierLabel);
    add({ id: d.location.id, slug: d.location.slug, name: `${d.chef.displayName} (Gutad Chef Network)` }, { menuItemId: d.menuItemId, name: d.title, quantity: qty, unitPriceCents: d.priceCents, modifierOptionIds: ev.optionIds, modifierNames: names, modifiersCents: ev.modifiersCents }, 'MARKETPLACE', 'chef-network', { park: true });
    setAdded(true);
    setSheet(false);
    if (go) router.push('/checkout');
  };
  const action = (full: boolean) =>
    !canOrder ? <Button size="lg" disabled className="w-full">{d.soldOut ? 'Sold out' : noDates ? 'No dates open right now' : 'Not taking orders right now'}</Button>
      : customizable && !open && !full ? <Button size="lg" className="w-full" onClick={customize}>Customize & order — from {money(d.priceCents)}</Button>
      : <Button size="lg" className="w-full" disabled={!ev.ok} onClick={() => addToCart(true)}>Add to cart — {money(unit * qty)}</Button>;

  return (
    <div className="grid gap-6 pb-28 lg:grid-cols-[1fr_360px] lg:pb-0">
      <div className="min-w-0 space-y-4">
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
        <div className="flex flex-wrap gap-1"><Badge>{CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat]}</Badge><Badge tone={customizable ? 'info' : 'neutral'}>{customizable ? 'Customizable' : 'Fixed recipe'}</Badge>{ev.dietaryTags.map((t) => <Badge key={t} tone="good">{t.replace('_', ' ')}</Badge>)}</div>
        {d.description && <p className="text-ink-700">{d.description}</p>}
        <dl className="grid gap-3 rounded-2xl border border-ink-100 bg-white p-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-500">Portion</dt><dd>{d.portionDesc}</dd></div>
          <div><dt className="text-xs text-ink-500">Ordering</dt><dd>{chefNoticeText(d.minLeadDays, d.cutoffHour)} · up to {avail?.rules.maxAdvanceDays ?? d.maxAdvanceDays} days ahead</dd>{nextDate && <dd className="mt-1 font-medium text-emerald-700">Next available: {nextDate}</dd>}{noDates && <dd className="mt-1 font-medium text-amber-700">No dates open right now</dd>}</div>
          <div className="sm:col-span-2"><dt className="text-xs text-ink-500">Ingredients</dt><dd>{d.ingredients.join(', ')}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-ink-500">Allergens{open ? ' (with your choices)' : ''}</dt><dd className={ev.allergens.length ? 'font-medium text-red-700' : ''}>{ev.allergens.length ? ev.allergens.map((a) => a.replace('_', ' ')).join(', ') : 'None of the major allergens declared'}</dd><dd className="mt-1 text-xs text-ink-500">Removing an ingredient doesn’t make a dish allergen-free; the kitchen may handle other allergens. With a severe allergy, contact Gutad support before ordering.</dd></div>
        </dl>
        <section aria-label="Available dates" className="rounded-2xl border border-ink-100 bg-white p-4">
          <DateSlotPicker availability={avail ?? null} value={day} onChange={pickDay} loading={availLoading} title="When would you like it?" />
          {day && <p className="mt-2 text-xs text-ink-500">We’ll start checkout on this day; you can still change it there.</p>}
        </section>
        {customizable && open && (
          <div ref={optsRef} className="hidden scroll-mt-24 rounded-2xl border border-ink-100 bg-white p-4 lg:block">
            <h2 className="mb-4 text-lg font-bold">Customize</h2>
            <DishCustomizer dishId={d.id} groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName={d.chef.displayName} acceptsRequests={d.acceptsSpecialRequests} onAskChef={d.acceptsSpecialRequests ? askChef : undefined} />
          </div>
        )}
        {d.acceptsSpecialRequests && d.acceptingOrders && (
          <section aria-label="Special requests" className="rounded-2xl border border-dashed border-ink-200 bg-white p-4">
            <h2 className="font-semibold">Need something the options don’t cover?</h2>
            <p className="mt-1 text-sm text-ink-600">Ask {d.chef.displayName} for a change. You’ll get a quote with the price, allergens and day; nothing is charged until you accept and pay.</p>
            <Button variant="secondary" className="mt-3" onClick={() => askChef()}>Request something special</Button>
          </section>
        )}
        <NewRequestModal dish={d} open={!!asking} onClose={() => setAsking(null)} ingredient={asking?.ingredient} baseOptionIds={open && ev.ok ? ev.optionIds : undefined} baseOptionNames={open && ev.ok ? ev.chosen.filter((c) => c.priceCents > 0 || !groups.find((g) => g.id === c.groupId)?.options.find((o) => o.id === c.id)?.isDefault).map(modifierLabel) : undefined} />
      </div>

      {/* desktop: sticky summary */}
      <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start">
        <div className="space-y-4 rounded-2xl border border-ink-100 bg-white p-4 shadow-card">
          <div><div className="text-sm text-ink-500">{open ? 'Your order' : 'Price'}</div><div className="text-2xl font-bold">{money(unit)}</div></div>
          {open && <CustomizationSummary basePriceCents={d.priceCents} ev={ev} qty={qty} baseAllergens={d.allergens} />}
          <QtyStepper label="Quantity" value={qty} min={1} max={20} onChange={setQty} />
          {action(false)}
          {canOrder && (!customizable || open) && <Button variant="secondary" className="w-full" disabled={!ev.ok} onClick={() => addToCart(false)}>Add and keep browsing</Button>}
          {otherPlace && <p className="text-xs text-ink-500">Your cart has items from {cart.locationName}; they’ll be kept as a separate order.</p>}
          {added && <p className="text-xs text-emerald-700">Added. <Link href="/checkout" className="underline">Go to checkout</Link> to choose your date and time.</p>}
          <p className="text-xs text-ink-500">{nextDate ? `Earliest ${nextDate}. ` : ''}Confirm your date and time at checkout. Sold by Gutad.</p>
        </div>
      </aside>

      {/* phone: bottom action */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-100 bg-white p-3 shadow-[0_-8px_24px_-12px_rgba(0,0,0,.2)] lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          {!customizable && <QtyStepper label="Quantity" value={qty} min={1} max={20} onChange={setQty} />}
          <div className="flex-1">{customizable ? (canOrder ? <Button size="lg" className="w-full" onClick={customize}>Customize & order — from {money(d.priceCents)}</Button> : action(true)) : action(true)}</div>
        </div>
      </div>

      {/* phone: full-height customization sheet */}
      {sheet && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink-50 lg:hidden" role="dialog" aria-modal="true" aria-label={`Customize ${d.title}`}>
          <div className="flex items-center gap-3 border-b border-ink-100 bg-white px-4 py-3">
            <button onClick={() => setSheet(false)} aria-label="Close" className="text-xl text-ink-500">✕</button>
            <div className="min-w-0 flex-1"><div className="truncate font-semibold">{d.title}</div><div className="text-xs text-ink-500">Prices update as you choose</div></div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <DishCustomizer dishId={d.id} groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName={d.chef.displayName} acceptsRequests={d.acceptsSpecialRequests} onAskChef={d.acceptsSpecialRequests ? askChef : undefined} />
            <div className="mt-6 rounded-xl bg-white p-3"><CustomizationSummary basePriceCents={d.priceCents} ev={ev} qty={qty} baseAllergens={d.allergens} /></div>
          </div>
          <div className="flex items-center gap-3 border-t border-ink-100 bg-white p-3">
            <QtyStepper label="Quantity" value={qty} min={1} max={20} onChange={setQty} />
            <Button size="lg" className="flex-1" disabled={!ev.ok || !canOrder} onClick={() => addToCart(true)}>{ev.ok ? `Add to cart — ${money(unit * qty)}` : 'Finish required choices'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
