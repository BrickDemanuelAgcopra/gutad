'use client';
import { CardField, type CardToken } from '@/components/card-field';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PACKAGED_STORAGE_LABELS, shelfLifePromise, type LocationSummary, type MenuDto, type MenuItemDto, type PackagedFacts } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { useCart } from '@/lib/cart';
import { Alert, Badge, Button, Card, Input, Modal, Select, Tabs, Textarea, Spinner, Empty } from './ui';
import { GBadge, MadeAtGutad } from './made-at-gutad';
import { SmsNotice } from './legal';

type PublicMenu = MenuDto & { brand?: { id: string; slug: string; name: string; description: string | null } | null };

export interface LocationPage extends LocationSummary {
  hours: { dayOfWeek: number; opens: string; closes: string }[];
  pickupTimes: { date: string; slots: string[] }[];
  deliveryTimes: { date: string; slots: string[] }[];
  diningShifts: { id: string; name: string; startTime: string; endTime: string; maxPartySize: number }[];
  experiences: { id: string; name: string; description: string | null; pricingMode: string; priceCents: number; imageUrl: string | null }[];
  partnerLinks: { id: string; partnerName: string | null }[];
  description?: string | null;
  phone?: string | null;
  currency: string;
  amenities: string[];
  isPaused?: boolean;
  pausedReason?: string | null;
}

type Channel = 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function RestaurantView({ loc, channel, src, branded, initialTab, initialBrand }: { loc: LocationPage; channel: Channel; src: string | null; branded?: boolean; initialTab?: string; initialBrand?: string }) {
  const tabs = [
    ...(loc.acceptsPickup || loc.acceptsDelivery ? [{ id: 'order', label: 'Order' }] : []),
    ...(loc.acceptsReservations ? [{ id: 'reserve', label: 'Reserve' }] : []),
    ...(loc.experiences.length ? [{ id: 'experiences', label: 'Experiences' }] : []),
    ...(loc.acceptsEvents ? [{ id: 'events', label: 'Private events' }] : []),
    { id: 'reviews', label: 'Reviews' },
    { id: 'info', label: 'Info' },
  ];
  const [tab, setTab] = useState(initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0].id);
  return (
    <div>
      <div className="relative h-56 overflow-hidden rounded-3xl bg-ink-100 md:h-72">
        {loc.heroImageUrl && <img src={loc.heroImageUrl} alt="" className="h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-900/80 to-transparent" />
        <div className="absolute bottom-0 left-0 p-6 text-white">
          {branded && <div className="mb-1 text-xs uppercase tracking-wide text-white/70">Ordering direct</div>}
          <h1 className="text-3xl font-bold">{loc.name}</h1>
          <p className="mt-1 text-sm text-white/80">{loc.cuisine.join(' · ')} · {loc.addressLine1}, {loc.city} {loc.rating ? `· ★ ${loc.rating.toFixed(1)} (${loc.ratingCount})` : ''}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {loc.platformOperated && <MadeAtGutad tone="dark" />}
            {loc.firstParty && loc.sellerLabel && <span className="rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-ink-900" title="Gutad is the seller of this food">{loc.sellerLabel}</span>}
            <Badge tone={loc.isOpenNow ? 'good' : 'bad'}>{loc.isOpenNow ? 'Open now' : 'Closed'}</Badge>
            {loc.isPaused && <Badge tone="warn">{loc.pausedReason || 'Paused'}</Badge>}
          </div>
        </div>
      </div>
      {loc.description && <p className="mt-4 text-ink-700">{loc.description}</p>}
      <div className="mt-5"><Tabs tabs={tabs} active={tab} onChange={setTab} /></div>
      <div className="mt-6">
        {tab === 'order' && <OrderTab loc={loc} channel={channel} src={src} initialBrand={initialBrand} />}
        {tab === 'reserve' && <ReserveTab loc={loc} channel={channel === 'MARKETPLACE' ? 'MARKETPLACE' : 'WIDGET'} />}
        {tab === 'experiences' && <ExperiencesTab loc={loc} />}
        {tab === 'events' && <EventsTab loc={loc} />}
        {tab === 'reviews' && <ReviewsTab loc={loc} />}
        {tab === 'info' && <InfoTab loc={loc} />}
      </div>
    </div>
  );
}

// ───────────── Order ─────────────

type NewLine = Parameters<ReturnType<typeof useCart>['add']>[1];

function OrderTab({ loc, channel, src, initialBrand }: { loc: LocationPage; channel: Channel; src: string | null; initialBrand?: string }) {
  const { data: menus, loading } = useApi<PublicMenu[]>(`/public/locations/${loc.id}/menus?channel=${channel}`);
  const { data: offers } = useApi<{ id: string; name: string | null; kind: string; value: number; minSubtotalCents: number; maxDiscountCents: number | null; firstOrderOnly: boolean; daysOfWeek: number[]; startTime: string | null; endTime: string | null; itemIds: string[]; categoryIds: string[] }[]>(`/public/locations/${loc.id}/offers`);
  const { cart, add, count, subtotal } = useCart();
  const [picked, setPicked] = useState<{ item: MenuItemDto; brand?: string | null } | null>(null);
  const [pending, setPending] = useState<NewLine | null>(null);
  const hall = !!loc.platformOperated && (menus?.length || 0) > 1;
  useEffect(() => {
    if (!initialBrand || !menus?.length) return;
    document.getElementById(`brand-${initialBrand}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [initialBrand, menus]);
  const [why, setWhy] = useState<string | null>(null);
  const doAdd = (line: NewLine, park = false) => add({ id: loc.id, slug: loc.slug, name: loc.name }, line, channel, src, { park });
  const tryAdd = (line: NewLine) => {
    setPicked(null);
    if (cart.locationId && cart.locationId !== loc.id && cart.lines.length) {
      setWhy(null);
      setPending(line);
      api.get<{ ok: boolean; reason?: string }>(`/public/cart-compatibility?current=${cart.locationId}&adding=${loc.id}`).then((r) => setWhy(r.reason || null)).catch(() => undefined);
    } else doAdd(line);
  };
  const groups = useMemo(() => {
    const by = new Map<string, typeof cart.lines>();
    for (const l of cart.lines) by.set(l.brandName || '', [...(by.get(l.brandName || '') || []), l]);
    return [...by.entries()];
  }, [cart.lines]);
  if (loading) return <Spinner />;
  if (!menus?.length) return <Empty>No menu published for this channel right now.</Empty>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-8">
        {!!offers?.length && (
          <div className="rounded-2xl border border-brand-200 bg-brand-50 p-4">
            <div className="font-semibold text-brand-900">Offers here</div>
            <ul className="mt-1 space-y-0.5 text-sm text-brand-900/90">{offers.map((o) => <li key={o.id}>{o.name || (o.kind === 'BOGO' ? 'Buy one, get one free' : o.kind === 'FREE_ITEM' ? 'Free item' : o.kind === 'PERCENT' ? `${o.value / 100}% off` : o.kind === 'FIXED' ? `${money(o.value)} off` : 'Free delivery')}<span className="text-xs text-brand-900/70">{[o.minSubtotalCents ? ` on orders over ${money(o.minSubtotalCents)}` : '', o.firstOrderOnly ? ' · your first order' : '', o.daysOfWeek.length ? ` · ${o.daysOfWeek.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}` : '', o.startTime ? ` · ${o.startTime}–${o.endTime}` : '', o.itemIds.length || o.categoryIds.length ? ' · selected items' : ''].join('')}</span></li>)}</ul>
            <p className="mt-1 text-xs text-brand-900/70">Applied automatically at checkout when your order qualifies.</p>
          </div>
        )}
        {hall && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 font-semibold text-emerald-900"><GBadge className="h-6 w-6" /> Mix menus in one order</div>
            <p className="mt-1 text-sm text-emerald-900/80">Every menu here is cooked by Gutad&apos;s culinary team in this food hall. Add dishes from any of them: they&apos;re prepared together and arrive in one delivery.</p>
            <div className="mt-3 flex flex-wrap gap-2">{menus.filter((m) => m.brand).map((m) => <a key={m.id} href={`#brand-${m.brand!.slug}`} className="rounded-full bg-white px-3 py-1 text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-100">{m.brand!.name}</a>)}</div>
          </div>
        )}
        {menus.map((m) => (
          <div key={m.id} id={m.brand ? `brand-${m.brand.slug}` : undefined} className={`scroll-mt-24 ${initialBrand && m.brand?.slug === initialBrand ? 'rounded-2xl ring-2 ring-emerald-300 ring-offset-4' : ''}`}>
            {menus.length > 1 && (
              <div className="mb-3">
                <h2 className="flex items-center gap-2 text-xl font-bold">{loc.platformOperated && m.brand && <GBadge className="h-6 w-6" />}{m.brand?.name || m.name}</h2>
                {m.brand?.description && <p className="text-sm text-ink-500">{m.brand.description}</p>}
              </div>
            )}
            {m.categories.map((c) => (
              <div key={c.id} className="mb-6">
                <h3 className="mb-2 text-lg font-semibold">{c.name}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {c.items.map((it) => (
                    <button key={it.id} disabled={it.soldOut} onClick={() => setPicked({ item: it, brand: m.brand?.name })} className="flex gap-3 rounded-xl border border-ink-100 bg-white p-3 text-left shadow-sm transition hover:border-brand-300 disabled:opacity-50">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium">{it.name} {it.soldOut && <Badge tone="bad">Sold out</Badge>}{!it.soldOut && it.packaged?.onlyLeft ? <Badge tone="warn">Only {it.packaged.onlyLeft} left</Badge> : null}</div>
                        {it.packaged && <div className="mt-0.5 text-[11px] text-ink-500">{[it.packaged.brandName, it.packaged.size, it.packaged.storage !== 'AMBIENT' ? PACKAGED_STORAGE_LABELS[it.packaged.storage] : null].filter(Boolean).join(' · ')}</div>}
                        {it.description && <p className="mt-0.5 text-xs text-ink-500">{it.description}</p>}
                        <div className="mt-1 text-sm font-semibold">{money(it.priceCents, loc.currency)}</div>
                        {it.allergens.length > 0 && <div className="mt-1 text-[11px] text-ink-300">Contains: {it.allergens.join(', ')}</div>}
                      </div>
                      {it.imageUrl && <img src={it.imageUrl} alt="" className="h-20 w-20 rounded-lg object-cover" />}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Card title="Your order">
          {cart.locationId === loc.id && count > 0 ? (
            <>
              <div className="space-y-2 text-sm">
                {groups.map(([brand, lines]) => (
                  <div key={brand}>
                    {hall && brand && <div className="mb-0.5 flex items-center gap-1 text-xs font-semibold text-emerald-800"><GBadge className="h-3.5 w-3.5" /> {brand}</div>}
                    <ul className="space-y-1">{lines.map((l) => <li key={l.key} className="flex justify-between"><span>{l.quantity}× {l.name}</span><span>{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</span></li>)}</ul>
                  </div>
                ))}
              </div>
              {hall && groups.length > 1 && <p className="mt-2 text-xs text-emerald-800">{groups.length} menus, one order, one delivery.</p>}
              <div className="mt-3 flex justify-between border-t border-ink-100 pt-2 text-sm font-semibold"><span>Subtotal</span><span>{money(subtotal)}</span></div>
              <Link href="/checkout"><Button className="mt-3 w-full" size="lg">Checkout</Button></Link>
            </>
          ) : (
            <p className="text-sm text-ink-500">Pick items to start an order. {loc.acceptsDelivery ? 'Pickup or delivery' : 'Pickup'}, now or scheduled.{hall ? ' Combine any menus on this page.' : ''}</p>
          )}
          {loc.partnerLinks.length > 0 && (
            <div className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
              Also delivered by {loc.partnerLinks.map((p) => <a key={p.id} className="underline" href={`${process.env.NEXT_PUBLIC_API_URL}/public/referrals/${p.id}/click`} onClick={async (e) => { e.preventDefault(); const r = await api.post<{ redirectUrl: string }>(`/public/referrals/${p.id}/click`); window.open(r.redirectUrl, '_blank'); }}>{p.partnerName}</a>)}
            </div>
          )}
        </Card>
      </aside>
      {picked && <ItemModal item={picked.item} brand={picked.brand} currency={loc.currency} onClose={() => setPicked(null)} onAdd={tryAdd} />}
      <Modal open={!!pending} onClose={() => setPending(null)} title="This will be a separate order">
        <p className="text-sm text-ink-700">Your cart has items from <b>{cart.locationName}</b>. {why || 'Each order comes from one place: a local restaurant, or one Made at Gutad food hall (where you can mix its menus).'}</p>
        <p className="mt-2 text-sm text-ink-500">You can keep your {cart.locationName} cart saved and check out both orders one after the other.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => { if (pending) doAdd(pending, false); setPending(null); }}>Replace my cart</Button>
          <Button onClick={() => { if (pending) doAdd(pending, true); setPending(null); }}>Save it &amp; start a separate order</Button>
        </div>
      </Modal>
    </div>
  );
}

function ItemModal({ item, brand, currency, onClose, onAdd }: { item: MenuItemDto; brand?: string | null; currency: string; onClose: () => void; onAdd: (l: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string; brandName?: string | null }) => void }) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const toggle = (g: MenuItemDto['modifierGroups'][number], optId: string) => {
    setSel((s) => {
      const cur = s[g.id] || [];
      if (g.maxSelect === 1) return { ...s, [g.id]: cur.includes(optId) ? [] : [optId] };
      if (cur.includes(optId)) return { ...s, [g.id]: cur.filter((x) => x !== optId) };
      if (cur.length >= g.maxSelect) return s;
      return { ...s, [g.id]: [...cur, optId] };
    });
  };
  const chosen = item.modifierGroups.flatMap((g) => g.options.filter((o) => (sel[g.id] || []).includes(o.id)));
  const modCents = chosen.reduce((a, o) => a + o.priceCents, 0);
  const invalid = item.modifierGroups.find((g) => (sel[g.id] || []).length < (g.required ? Math.max(1, g.minSelect) : g.minSelect));
  return (
    <Modal open onClose={onClose} title={item.name}>
      {item.description && <p className="text-sm text-ink-500">{item.description}</p>}
      {item.packaged && <PackagedFactsBox f={item.packaged} allergens={item.allergens} />}
      {item.modifierGroups.map((g) => (
        <div key={g.id} className="mt-4">
          <div className="text-sm font-semibold">{g.name} <span className="font-normal text-ink-500">{g.required ? '(required)' : g.maxSelect > 1 ? `(up to ${g.maxSelect})` : '(optional)'}</span></div>
          <div className="mt-2 space-y-1">
            {g.options.map((o) => (
              <label key={o.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${(sel[g.id] || []).includes(o.id) ? 'border-brand-400 bg-brand-50' : 'border-ink-100'} ${o.soldOut ? 'opacity-40' : ''}`}>
                <span className="flex items-center gap-2"><input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} disabled={o.soldOut} checked={(sel[g.id] || []).includes(o.id)} onChange={() => toggle(g, o.id)} /> {o.name}</span>
                {o.priceCents > 0 && <span>+{money(o.priceCents, currency)}</span>}
              </label>
            ))}
          </div>
        </div>
      ))}
      {!item.packaged && <Textarea className="mt-4" label="Special instructions" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />}
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2"><Button variant="secondary" size="sm" onClick={() => setQty(Math.max(1, qty - 1))}>−</Button><span className="w-6 text-center">{qty}</span><Button variant="secondary" size="sm" disabled={!!item.maxPerOrder && qty >= item.maxPerOrder} onClick={() => setQty(qty + 1)}>+</Button></div>
        <Button disabled={!!invalid} onClick={() => onAdd({ menuItemId: item.id, name: item.name, quantity: qty, unitPriceCents: item.priceCents, modifierOptionIds: chosen.map((o) => o.id), modifierNames: chosen.map((o) => o.name), modifiersCents: modCents, specialInstructions: note || undefined, brandName: brand })}>
          Add {money((item.priceCents + modCents) * qty, currency)}
        </Button>
      </div>
      {invalid && <p className="mt-2 text-xs text-red-600">Choose {invalid.name} to continue.</p>}
    </Modal>
  );
}

/** Packaged goods: what is on the pack, how to store it and the shelf-life promise. */
function PackagedFactsBox({ f, allergens }: { f: PackagedFacts; allergens: string[] }) {
  const promise = shelfLifePromise(f);
  return (
    <div className="mt-3 space-y-1 rounded-lg bg-ink-50 p-3 text-xs text-ink-700">
      <div className="flex flex-wrap gap-1">{f.size && <Badge>{f.size}</Badge>}<Badge tone={f.storage === 'AMBIENT' ? 'neutral' : 'info'}>{PACKAGED_STORAGE_LABELS[f.storage]}</Badge>{f.onlyLeft ? <Badge tone="warn">Only {f.onlyLeft} left</Badge> : null}</div>
      {f.brandName && <div><b>Made by:</b> {f.brandName}{f.countryOfOrigin ? ` · ${f.countryOfOrigin}` : ''}</div>}
      {promise && <div>{promise}.</div>}
      {f.ingredients && <div><b>Ingredients:</b> {f.ingredients}</div>}
      <div><b>Allergens:</b> {allergens.length ? allergens.join(', ') : 'none declared'}. Always check the label.</div>
      {f.labelImageUrl && <a className="underline" href={f.labelImageUrl} target="_blank" rel="noreferrer">See the label</a>}
    </div>
  );
}

// ───────────── Reserve ─────────────

export function ReserveTab({ loc, channel, compact }: { loc: LocationPage; channel: 'MARKETPLACE' | 'WIDGET'; compact?: boolean }) {
  const { user } = useSession();
  const today = new Date();
  const [date, setDate] = useState(new Date(today.getTime() + 86400000).toISOString().slice(0, 10));
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState<{ time: string; iso: string } | null>(null);
  const [form, setForm] = useState({ guestName: '', guestEmail: '', guestPhone: '', notes: '', occasion: '' });
  const [card, setCard] = useState<CardToken | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: avail, loading } = useApi<{ slots: { time: string; iso: string }[]; policy: { cancellationHours: number; depositCents: number; noShowFeeCents: number; requiresCardAbove: number | null } | null; reason?: string }>(`/public/locations/${loc.id}/availability?date=${date}&partySize=${party}`, { deps: [date, party] });
  useEffect(() => { if (user) setForm((f) => ({ ...f, guestName: f.guestName || user.name || '', guestEmail: f.guestEmail || user.email })); }, [user]);
  const needsCard = !!avail?.policy?.requiresCardAbove && party >= avail.policy.requiresCardAbove;
  const book = async () => {
    if (!slot) return;
    setError(null);
    try {
      const r = await api.post<Record<string, unknown>>('/reservations', { locationId: loc.id, startAt: slot.iso, partySize: party, ...form, channel, paymentMethodId: card?.token }, crypto.randomUUID());
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (result) {
    return (
      <Card title="Reservation confirmed">
        <p className="text-sm">Confirmation code <b>{String(result.confirmationCode)}</b> — {when(result.startAt as string)} for {String(result.partySize)}.</p>
        {result.status === 'HELD' && <Alert tone="info">A card is required to confirm. <Link className="underline" href={`/reservations/${result.confirmationCode}?email=${form.guestEmail}`}>Add a card</Link> within 10 minutes.</Alert>}
        <Link className="mt-3 inline-block text-sm text-brand-600 underline" href={`/reservations/${result.confirmationCode}?email=${encodeURIComponent(form.guestEmail)}`}>Manage reservation</Link>
      </Card>
    );
  }
  return (
    <div className={`grid gap-6 ${compact ? '' : 'lg:grid-cols-[1fr_340px]'}`}>
      <div>
        <div className="flex flex-wrap gap-2">
          <Input type="date" label="Date" value={date} min={today.toISOString().slice(0, 10)} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
          <Select label="Party size" value={party} onChange={(e) => { setParty(Number(e.target.value)); setSlot(null); }}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'guest' : 'guests'}</option>)}</Select>
        </div>
        <div className="mt-4">
          {loading ? <Spinner /> : avail?.slots?.length ? (
            <div className="flex flex-wrap gap-2">{avail.slots.map((s) => <button key={s.iso} onClick={() => setSlot(s)} className={`rounded-lg border px-3 py-1.5 text-sm ${slot?.iso === s.iso ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-100 bg-white hover:border-brand-300'}`}>{s.time}</button>)}</div>
          ) : (
            <Empty>{avail?.reason || 'No tables available for that date and party size.'} {party > 8 && loc.acceptsEvents ? 'For larger groups, submit a private event inquiry.' : ''}</Empty>
          )}
        </div>
        {avail?.policy && <p className="mt-3 text-xs text-ink-500">Free cancellation up to {avail.policy.cancellationHours}h before. {avail.policy.noShowFeeCents ? `No-show fee ${money(avail.policy.noShowFeeCents)}/guest for parties of ${avail.policy.requiresCardAbove}+.` : ''}{avail.policy.depositCents ? ` Deposit ${money(avail.policy.depositCents)}/guest for large parties.` : ''}</p>}
      </div>
      <Card title={slot ? `Book ${slot.time}` : 'Pick a time'}>
        <div className="space-y-2">
          <Input label="Name" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} />
          <Input label="Email" type="email" value={form.guestEmail} onChange={(e) => setForm({ ...form, guestEmail: e.target.value })} />
          <Input label="Phone" value={form.guestPhone} onChange={(e) => setForm({ ...form, guestPhone: e.target.value })} />
          <SmsNotice />
          <Input label="Occasion (optional)" value={form.occasion} onChange={(e) => setForm({ ...form, occasion: e.target.value })} />
          <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {needsCard && <CardField label="Card (guarantee only — not charged unless no-show)" value={card} onChange={setCard} />}
          {error && <Alert>{error}</Alert>}
          <Button className="w-full" size="lg" disabled={!slot || !form.guestName || !form.guestEmail} onClick={book}>Reserve</Button>
        </div>
      </Card>
    </div>
  );
}

// ───────────── Experiences ─────────────

function ExperiencesTab({ loc }: { loc: LocationPage }) {
  const { data } = useApi<{ id: string; name: string; description: string | null; pricingMode: string; priceCents: number; imageUrl: string | null; refundPolicy: string; sessions: { id: string; startAt: string; remaining: number }[]; addOns: { id: string; name: string; priceCents: number }[] }[]>(`/public/locations/${loc.id}/experiences`);
  const { user } = useSession();
  const [buy, setBuy] = useState<{ expId: string; sessionId: string } | null>(null);
  const [spots, setSpots] = useState(2);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [card, setCard] = useState<CardToken | null>(null);
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const exp = data.find((e) => e.id === buy?.expId);
  const prepaid = exp && exp.pricingMode.startsWith('PREPAID');
  const submit = async () => {
    setError(null);
    try {
      const t = await api.post<Record<string, unknown>>('/tickets', { sessionId: buy!.sessionId, spots, guestName: name, guestEmail: email, addOnIds: addOns, paymentMethodId: prepaid ? card?.token : undefined }, crypto.randomUUID());
      setDone(t);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.map((e) => (
        <Card key={e.id} title={e.name}>
          {e.imageUrl && <img src={e.imageUrl} alt="" className="mb-3 h-36 w-full rounded-lg object-cover" />}
          <p className="text-sm text-ink-500">{e.description}</p>
          <p className="mt-2 text-sm font-semibold">{e.pricingMode === 'FREE' ? 'Free' : e.pricingMode === 'PAY_AT_VENUE' ? 'Pay at venue' : `${money(e.priceCents)} ${e.pricingMode === 'PREPAID_PER_PERSON' ? 'per person' : 'per party'}`}</p>
          <p className="text-xs text-ink-300">{e.refundPolicy}</p>
          <div className="mt-3 space-y-1">
            {e.sessions.map((s) => (
              <button key={s.id} disabled={s.remaining <= 0} onClick={() => { setBuy({ expId: e.id, sessionId: s.id }); setDone(null); }} className="flex w-full items-center justify-between rounded-lg border border-ink-100 px-3 py-2 text-sm hover:border-brand-300 disabled:opacity-40">
                <span>{when(s.startAt)}</span><span className="text-ink-500">{s.remaining} left</span>
              </button>
            ))}
          </div>
        </Card>
      ))}
      <Modal open={!!buy && !done} onClose={() => setBuy(null)} title={exp?.name || 'Tickets'}>
        <div className="space-y-2">
          <Select label="Spots" value={spots} onChange={(e) => setSpots(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
          {exp?.addOns.map((a) => <label key={a.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={addOns.includes(a.id)} onChange={(e) => setAddOns(e.target.checked ? [...addOns, a.id] : addOns.filter((x) => x !== a.id))} /> {a.name} (+{money(a.priceCents)} each)</label>)}
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {prepaid && <CardField value={card} onChange={setCard} />}
          {prepaid && exp && <p className="text-xs text-ink-500">Total {money((exp.pricingMode === 'PREPAID_PER_PERSON' ? exp.priceCents * spots : exp.priceCents) + exp.addOns.filter((a) => addOns.includes(a.id)).reduce((s, a) => s + a.priceCents, 0) * spots)} + 2% service fee.</p>}
          {error && <Alert>{error}</Alert>}
          <Button className="w-full" onClick={submit} disabled={!name || !email}>{prepaid ? 'Pay & confirm' : 'Confirm'}</Button>
        </div>
      </Modal>
      {done && <div className="md:col-span-2"><Alert tone="good">Confirmed! Ticket code <b>{String(done.confirmationCode)}</b>. {done.payAtVenue ? 'Pay at the venue.' : ''} <Link className="underline" href="/account?tab=tickets">View tickets</Link></Alert></div>}
    </div>
  );
}

// ───────────── Private events ─────────────

function EventsTab({ loc }: { loc: LocationPage }) {
  const { user } = useSession();
  const [f, setF] = useState({ contactName: user?.name || '', contactEmail: user?.email || '', contactPhone: '', eventDate: '', partySize: 20, budget: '', notes: '' });
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      setSent(await api.post<Record<string, unknown>>(`/public/locations/${loc.id}/event-inquiries`, { ...f, eventDate: new Date(f.eventDate).toISOString(), budgetCents: f.budget ? Math.round(Number(f.budget) * 100) : undefined }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (sent) return <Alert tone="good">Inquiry received (ref {String(sent.id).slice(0, 8)}). The venue will reply with a proposal; you can track it at <Link className="underline" href={`/events/inquiry/${sent.id}`}>your inquiry page</Link>.</Alert>;
  return (
    <Card title="Private dining & events inquiry">
      <p className="mb-3 text-sm text-ink-500">Tell us about your event. An inquiry never blocks inventory — the venue will send a proposal with a deposit to confirm the space.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Contact name" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        <Input label="Email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
        <Input label="Phone" value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
        <Input label="Event date" type="datetime-local" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />
        <Input label="Guests" type="number" value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} />
        <Input label="Budget (USD)" type="number" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
      </div>
      <Textarea className="mt-2" label="Notes" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <Button className="mt-3" onClick={submit} disabled={!f.contactName || !f.contactEmail || !f.eventDate}>Send inquiry</Button>
    </Card>
  );
}

// ───────────── Reviews & info ─────────────

function ReviewsTab({ loc }: { loc: LocationPage }) {
  const { data } = useApi<{ id: string; rating: number; body: string | null; verified: boolean; merchantReply: string | null; createdAt: string; author: string | null }[]>(`/public/locations/${loc.id}/reviews`);
  if (!data) return <Spinner />;
  if (!data.length) return <Empty>No reviews yet. Reviews are verified against completed orders.</Empty>;
  return (
    <div className="space-y-3">
      {data.map((r) => (
        <Card key={r.id}>
          <div className="flex items-center justify-between text-sm"><span className="font-medium">{r.author || 'Guest'} · {'★'.repeat(r.rating)}</span>{r.verified && <Badge tone="good">Verified order</Badge>}</div>
          {r.body && <p className="mt-1 text-sm text-ink-700">{r.body}</p>}
          {r.merchantReply && <p className="mt-2 rounded-lg bg-ink-50 p-2 text-xs text-ink-500"><b>Reply from {loc.name}:</b> {r.merchantReply}</p>}
        </Card>
      ))}
    </div>
  );
}

function InfoTab({ loc }: { loc: LocationPage }) {
  const byDay = useMemo(() => DAYS.map((d, i) => ({ d, h: loc.hours.filter((h) => h.dayOfWeek === i) })), [loc.hours]);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Hours">
        <ul className="text-sm">{byDay.map(({ d, h }) => <li key={d} className="flex justify-between py-0.5"><span>{d}</span><span>{h.length ? h.map((x) => `${x.opens}–${x.closes}`).join(', ') : 'Closed'}</span></li>)}</ul>
      </Card>
      <Card title="Details">
        <p className="text-sm">{loc.addressLine1}, {loc.city}, {loc.region} {loc.postalCode}</p>
        {loc.phone && <p className="text-sm">{loc.phone}</p>}
        {loc.amenities?.length ? <p className="mt-2 text-sm text-ink-500">{loc.amenities.join(' · ')}</p> : null}
        {loc.lat && loc.lng && <a className="mt-2 inline-block text-sm text-brand-600 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}>Open in maps</a>}
      </Card>
    </div>
  );
}
