'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { newIdempotencyKey, type MenuDto, type MenuItemDto } from '@gutad/shared';
import { API_URL, money } from '@/lib/api';
import { CardField, type CardToken } from '@/components/card-field';

interface KioskLoc { id: string; name: string; slug: string; currency: string; heroImageUrl: string | null; acceptsKiosk?: boolean; acceptsDineIn?: boolean; acceptsPickup?: boolean; isPaused?: boolean; pausedReason?: string | null }
interface Line { key: string; item: MenuItemDto; quantity: number; optionIds: string[]; optionNames: string[]; modsCents: number }
interface Quote { id: string; subtotalCents: number; discountCents: number; taxCents: number; serviceFeeCents: number; totalCents: number; warnings: string[]; promiseAt: string | null }
interface Placed { id: string; number: string; pickupCode: string | null; tableNumber: string | null; fulfillmentType: string; totalCents: number }

const IDLE_MS = 90_000;
const WARN_MS = 15_000;
const DONE_MS = 30_000;

/** The kiosk never uses a signed-in session (a staff login on the device must not own guest orders). */
async function kioskCall<T>(method: 'GET' | 'POST', path: string, body?: unknown, idem?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string | string[] }).message?.toString() || `Something went wrong (${res.status})`);
  return json as T;
}

/**
 * 14.8-K full-screen self-order kiosk: big touch menu, cart, pay by card (test card picker in test mode) or at the
 * counter, pager / table number, and an idle reset back to the welcome screen. Orders use the KIOSK channel, so they
 * route to the runner view (dine-in with a table) or the pickup board (take-away with a pager number).
 */
export default function KioskPage() {
  const { slug } = useParams<{ slug: string }>();
  const [loc, setLoc] = useState<KioskLoc | null>(null);
  const [menus, setMenus] = useState<MenuDto[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState<'welcome' | 'menu' | 'pay' | 'done'>('welcome');
  const [mode, setMode] = useState<'DINE_IN' | 'PICKUP'>('PICKUP');
  const [cat, setCat] = useState<string>('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState<MenuItemDto | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [name, setName] = useState('');
  const [pager, setPager] = useState('');
  const [pay, setPay] = useState<'CARD' | 'COUNTER'>('CARD');
  const [card, setCard] = useState<CardToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [warn, setWarn] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const lastTouch = useRef(Date.now());

  useEffect(() => {
    kioskCall<KioskLoc>('GET', `/public/locations/${slug}`).then(async (l) => {
      setLoc(l);
      const m = await kioskCall<MenuDto[]>('GET', `/public/locations/${l.id}/menus?channel=KIOSK`);
      setMenus(m);
      setCat(m.flatMap((x) => x.categories)[0]?.id || '');
    }).catch((e) => setLoadErr((e as Error).message));
  }, [slug]);

  const reset = useCallback(() => {
    setStep('welcome'); setLines([]); setQuote(null); setName(''); setPager(''); setPay('CARD'); setError(null); setPlaced(null); setPicking(null); setWarn(false);
    idem.current = newIdempotencyKey();
  }, []);

  // idle reset: a warning after 90 s without a touch, then back to the welcome screen
  useEffect(() => {
    const touch = () => { lastTouch.current = Date.now(); setWarn(false); };
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    const t = setInterval(() => {
      if (step === 'welcome') return;
      const idle = Date.now() - lastTouch.current;
      if (step === 'done' ? idle > DONE_MS : idle > IDLE_MS + WARN_MS) reset();
      else if (step !== 'done' && idle > IDLE_MS) setWarn(true);
    }, 1000);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); clearInterval(t); };
  }, [step, reset]);

  const categories = useMemo(() => (menus || []).flatMap((m) => m.categories).filter((c) => c.items.length), [menus]);
  const items = categories.find((c) => c.id === cat)?.items || [];
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const estimate = lines.reduce((a, l) => a + (l.item.priceCents + l.modsCents) * l.quantity, 0);
  const cur = loc?.currency || 'USD';

  const add = (item: MenuItemDto, optionIds: string[] = [], optionNames: string[] = [], modsCents = 0) => {
    const key = `${item.id}:${[...optionIds].sort().join(',')}`;
    setLines((ls) => (ls.some((l) => l.key === key) ? ls.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { key, item, quantity: 1, optionIds, optionNames, modsCents }]));
    setQuote(null);
  };
  const setQty = (key: string, q: number) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: q } : l)).filter((l) => l.quantity > 0)); setQuote(null); };

  const review = async () => {
    if (!loc) return;
    setBusy(true); setError(null);
    try {
      const q = await kioskCall<Quote>('POST', '/quotes', { locationId: loc.id, channel: 'KIOSK', fulfillmentType: mode, lines: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, modifierOptionIds: l.optionIds })) });
      setQuote(q);
      setStep('pay');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const placeOrder = async () => {
    if (!quote) return;
    setBusy(true); setError(null);
    try {
      const o = await kioskCall<Placed>('POST', '/orders', {
        quoteId: quote.id,
        guest: { name: name.trim() || 'Kiosk guest', email: `kiosk-${idem.current.slice(0, 12)}@kiosk.gutad.io` },
        tableNumber: pager.trim() || undefined,
        paymentMethodId: pay === 'CARD' ? card?.token : undefined,
        specialInstructions: pay === 'COUNTER' ? 'PAY AT COUNTER (kiosk)' : undefined,
      }, idem.current);
      setPlaced(o);
      setStep('done');
      lastTouch.current = Date.now();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const fullscreen = () => { const el = document.documentElement; if (!document.fullscreenElement) void el.requestFullscreen?.().catch(() => undefined); else void document.exitFullscreen?.(); };

  const shell = (children: React.ReactNode) => <div className="fixed inset-0 z-[60] flex select-none flex-col bg-ink-50 text-ink-900">{children}</div>;
  if (loadErr) return shell(<div className="m-auto max-w-md p-8 text-center text-xl">{loadErr}</div>);
  if (!loc || !menus) return shell(<div className="m-auto text-2xl text-ink-500">Loading…</div>);
  if (loc.acceptsKiosk === false) return shell(<div className="m-auto max-w-lg p-8 text-center"><div className="text-3xl font-bold">{loc.name}</div><p className="mt-4 text-xl text-ink-500">Kiosk ordering is not switched on for this location. Turn it on in Settings → Location channels.</p></div>);

  return shell(
    <>
      <div className="flex items-center justify-between bg-white px-6 py-4 shadow-sm">
        <button onClick={reset} className="text-2xl font-bold">{loc.name}</button>
        <div className="flex items-center gap-3">
          {step === 'menu' && <span className="rounded-full bg-ink-100 px-4 py-2 text-lg">{mode === 'DINE_IN' ? 'Eat here' : 'Take away'}</span>}
          <button onClick={fullscreen} className="rounded-xl border border-ink-100 px-4 py-2 text-base text-ink-500">⛶</button>
        </div>
      </div>

      {step === 'welcome' && (
        <div className="m-auto w-full max-w-3xl p-8 text-center">
          {loc.heroImageUrl && <img src={loc.heroImageUrl} alt="" className="mx-auto mb-8 h-56 w-full rounded-3xl object-cover" />}
          <h1 className="text-5xl font-extrabold">Order here</h1>
          {loc.isPaused && <p className="mt-4 text-xl text-red-700">{loc.pausedReason || 'Ordering is paused right now.'}</p>}
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {loc.acceptsDineIn !== false && <button className="rounded-3xl bg-brand-500 px-8 py-12 text-3xl font-bold text-white shadow-lg active:scale-95" onClick={() => { setMode('DINE_IN'); setStep('menu'); }}>🍽️<br />Eat here</button>}
            {loc.acceptsPickup !== false && <button className="rounded-3xl bg-ink-900 px-8 py-12 text-3xl font-bold text-white shadow-lg active:scale-95" onClick={() => { setMode('PICKUP'); setStep('menu'); }}>🛍️<br />Take away</button>}
          </div>
          <p className="mt-8 text-lg text-ink-500">Tap to start</p>
        </div>
      )}

      {step === 'menu' && (
        <div className="flex min-h-0 flex-1">
          <nav className="w-56 shrink-0 overflow-y-auto bg-white p-3">
            {categories.map((c) => <button key={c.id} onClick={() => setCat(c.id)} className={`mb-2 w-full rounded-2xl px-4 py-5 text-left text-xl font-semibold ${c.id === cat ? 'bg-brand-500 text-white' : 'bg-ink-50'}`}>{c.name}</button>)}
          </nav>
          <section className="min-w-0 flex-1 overflow-y-auto p-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((it) => (
                <button key={it.id} disabled={it.soldOut} onClick={() => (it.modifierGroups.length ? setPicking(it) : add(it))} className="flex flex-col overflow-hidden rounded-3xl bg-white text-left shadow-sm active:scale-[0.98] disabled:opacity-40">
                  {it.imageUrl ? <img src={it.imageUrl} alt="" className="h-40 w-full object-cover" /> : <div className="h-40 w-full bg-ink-100" />}
                  <div className="flex flex-1 flex-col p-4"><div className="text-xl font-bold">{it.name}</div>{it.description && <div className="mt-1 line-clamp-2 text-sm text-ink-500">{it.description}</div>}<div className="mt-auto pt-3 text-xl font-semibold">{it.soldOut ? 'Sold out' : money(it.priceCents, cur)}</div></div>
                </button>
              ))}
            </div>
          </section>
          <aside className="flex w-96 shrink-0 flex-col bg-white p-4">
            <h2 className="text-2xl font-bold">Your order</h2>
            <div className="mt-3 flex-1 space-y-3 overflow-y-auto">
              {lines.map((l) => (
                <div key={l.key} className="rounded-2xl bg-ink-50 p-3">
                  <div className="flex justify-between text-lg font-semibold"><span>{l.item.name}</span><span>{money((l.item.priceCents + l.modsCents) * l.quantity, cur)}</span></div>
                  {l.optionNames.length > 0 && <div className="text-sm text-ink-500">{l.optionNames.join(', ')}</div>}
                  <div className="mt-2 flex items-center gap-3"><button className="h-12 w-12 rounded-xl bg-white text-2xl" onClick={() => setQty(l.key, l.quantity - 1)}>−</button><span className="w-8 text-center text-xl">{l.quantity}</span><button className="h-12 w-12 rounded-xl bg-white text-2xl" onClick={() => setQty(l.key, l.quantity + 1)}>+</button></div>
                </div>
              ))}
              {!lines.length && <p className="text-lg text-ink-500">Tap an item to add it.</p>}
            </div>
            {error && <p className="mt-2 rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}
            <button disabled={!count || busy} onClick={review} className="mt-3 rounded-2xl bg-brand-500 py-6 text-2xl font-bold text-white disabled:opacity-40">{busy ? '…' : `Pay · ${count} item${count === 1 ? '' : 's'} · ${money(estimate, cur)}`}</button>
            <button onClick={reset} className="mt-2 py-3 text-lg text-ink-500">Start over</button>
          </aside>
        </div>
      )}

      {step === 'pay' && quote && (
        <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-8">
          <h1 className="text-4xl font-bold">Check and pay</h1>
          <div className="mt-6 space-y-2 rounded-3xl bg-white p-6 text-xl">
            {lines.map((l) => <div key={l.key} className="flex justify-between"><span>{l.quantity}× {l.item.name}</span><span>{money((l.item.priceCents + l.modsCents) * l.quantity, cur)}</span></div>)}
            <div className="flex justify-between border-t border-ink-100 pt-2 text-ink-500"><span>Tax and fees</span><span>{money(quote.taxCents + quote.serviceFeeCents, cur)}</span></div>
            {quote.discountCents > 0 && <div className="flex justify-between text-emerald-700"><span>Savings</span><span>−{money(quote.discountCents, cur)}</span></div>}
            <div className="flex justify-between text-3xl font-bold"><span>Total</span><span>{money(quote.totalCents, cur)}</span></div>
            {quote.warnings.map((w) => <p key={w} className="text-base text-amber-700">{w}</p>)}
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="text-lg font-semibold">Your name</span><input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-2xl border border-ink-100 px-4 py-4 text-2xl" placeholder="For your order" /></label>
            <label className="block"><span className="text-lg font-semibold">{mode === 'DINE_IN' ? 'Table or pager number' : 'Pager number (optional)'}</span><input value={pager} inputMode="numeric" maxLength={10} onChange={(e) => setPager(e.target.value)} className="mt-1 w-full rounded-2xl border border-ink-100 px-4 py-4 text-2xl" placeholder="e.g. 12" /></label>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <button onClick={() => setPay('CARD')} className={`rounded-3xl border-4 p-6 text-2xl font-bold ${pay === 'CARD' ? 'border-brand-500 bg-brand-50' : 'border-transparent bg-white'}`}>💳 Card</button>
            <button onClick={() => setPay('COUNTER')} className={`rounded-3xl border-4 p-6 text-2xl font-bold ${pay === 'COUNTER' ? 'border-brand-500 bg-brand-50' : 'border-transparent bg-white'}`}>🧾 Pay at the counter</button>
          </div>
          {pay === 'CARD' && <div className="mt-4 rounded-3xl bg-white p-4 text-lg"><CardField value={card} onChange={setCard} /><p className="mt-2 text-sm text-ink-500">In a store, the card reader next to the kiosk takes the payment.</p></div>}
          {pay === 'COUNTER' && <p className="mt-4 rounded-2xl bg-white p-4 text-lg">Your order goes to the kitchen now; pay at the counter when you collect it.</p>}
          {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-lg text-red-800">{error}</p>}
          <div className="mt-6 flex gap-4">
            <button onClick={() => setStep('menu')} className="flex-1 rounded-2xl bg-white py-6 text-2xl">Back</button>
            <button disabled={busy || (mode === 'DINE_IN' && !pager.trim()) || (pay === 'CARD' && !card)} onClick={placeOrder} className="flex-[2] rounded-2xl bg-brand-500 py-6 text-2xl font-bold text-white disabled:opacity-40">{busy ? 'Placing order…' : `Place order · ${money(quote.totalCents, cur)}`}</button>
          </div>
          {mode === 'DINE_IN' && !pager.trim() && <p className="mt-2 text-center text-ink-500">Enter your table or pager number so we can bring it to you.</p>}
        </div>
      )}

      {step === 'done' && placed && (
        <div className="m-auto max-w-xl p-8 text-center">
          <div className="text-7xl">✅</div>
          <h1 className="mt-4 text-4xl font-bold">Thank you{name.trim() ? `, ${name.trim().split(' ')[0]}` : ''}!</h1>
          <p className="mt-6 text-2xl">Order number</p>
          <div className="text-7xl font-extrabold tracking-wider">{placed.number}</div>
          {placed.tableNumber && <p className="mt-4 text-2xl">{mode === 'DINE_IN' ? 'We’ll bring it to' : 'Pager'} <b>{placed.tableNumber}</b></p>}
          {placed.pickupCode && <p className="mt-2 text-xl text-ink-500">Pickup code <b>{placed.pickupCode}</b></p>}
          {pay === 'COUNTER' && <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-xl text-amber-900">Please pay {money(placed.totalCents, cur)} at the counter.</p>}
          <button onClick={reset} className="mt-10 rounded-2xl bg-ink-900 px-10 py-5 text-2xl font-bold text-white">New order</button>
          <p className="mt-3 text-ink-500">This screen resets in 30 seconds.</p>
        </div>
      )}

      {picking && <ItemSheet item={picking} currency={cur} onClose={() => setPicking(null)} onAdd={(ids, names, cents) => { add(picking, ids, names, cents); setPicking(null); }} />}
      {warn && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" onPointerDown={() => setWarn(false)}>
          <div className="rounded-3xl bg-white p-10 text-center"><div className="text-3xl font-bold">Still there?</div><p className="mt-3 text-xl text-ink-500">Tap anywhere to keep your order. Starting over soon.</p></div>
        </div>
      )}
    </>,
  );
}

function ItemSheet({ item, currency, onClose, onAdd }: { item: MenuItemDto; currency: string; onClose: () => void; onAdd: (ids: string[], names: string[], cents: number) => void }) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const toggle = (g: MenuItemDto['modifierGroups'][number], id: string) => setSel((s) => {
    const cur = s[g.id] || [];
    if (g.maxSelect === 1) return { ...s, [g.id]: cur.includes(id) ? [] : [id] };
    if (cur.includes(id)) return { ...s, [g.id]: cur.filter((x) => x !== id) };
    return cur.length >= g.maxSelect ? s : { ...s, [g.id]: [...cur, id] };
  });
  const chosen = item.modifierGroups.flatMap((g) => g.options.filter((o) => (sel[g.id] || []).includes(o.id)));
  const invalid = item.modifierGroups.find((g) => (sel[g.id] || []).length < (g.required ? Math.max(1, g.minSelect) : g.minSelect));
  const cents = chosen.reduce((a, o) => a + o.priceCents, 0);
  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-6 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-3xl font-bold">{item.name}</div>
        {item.modifierGroups.map((g) => (
          <div key={g.id} className="mt-5">
            <div className="text-xl font-semibold">{g.name} <span className="text-base font-normal text-ink-500">{g.required ? 'required' : g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'optional'}</span></div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">{g.options.map((o) => <button key={o.id} disabled={o.soldOut} onClick={() => toggle(g, o.id)} className={`rounded-2xl border-4 px-4 py-4 text-left text-lg ${(sel[g.id] || []).includes(o.id) ? 'border-brand-500 bg-brand-50' : 'border-ink-100'} disabled:opacity-40`}>{o.name}{o.priceCents > 0 && <span className="float-right">+{money(o.priceCents, currency)}</span>}</button>)}</div>
          </div>
        ))}
        <div className="mt-6 flex gap-3"><button onClick={onClose} className="flex-1 rounded-2xl bg-ink-100 py-5 text-xl">Cancel</button><button disabled={!!invalid} onClick={() => onAdd(chosen.map((o) => o.id), chosen.map((o) => o.name), cents)} className="flex-[2] rounded-2xl bg-brand-500 py-5 text-xl font-bold text-white disabled:opacity-40">Add · {money(item.priceCents + cents, currency)}</button></div>
        {invalid && <p className="mt-2 text-center text-ink-500">Choose {invalid.name} to continue.</p>}
      </div>
    </div>
  );
}
