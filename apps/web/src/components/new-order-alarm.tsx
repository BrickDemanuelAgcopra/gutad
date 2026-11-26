'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, money } from '@/lib/api';
import { useApi, useLocalState } from '@/lib/hooks';

export interface PendingOrder {
  id: string; number: string; locationId: string; locationName: string; fulfillmentType: string; channel: string; guestName: string | null;
  totalCents: number; createdAt: string; scheduledFor: string | null; rejectAt: string | null;
  subtotalCents?: number; taxCents?: number; deliveryFeeCents?: number; tipCents?: number; discountCents?: number; specialInstructions?: string | null;
  deliveryAddress?: { line1?: string; line2?: string; city?: string; postalCode?: string; instructions?: string } | null;
  lines: { name: string; quantity: number; modifiers?: string[]; specialInstructions?: string | null; lineTotalCents?: number; allergens?: string[] | null }[];
}

const PREP_CHOICES = [10, 15, 20, 30, 45];
const REJECT_REASONS = ['Too busy', 'Item unavailable', 'Closing soon', 'Cannot fulfill delivery'];

/** Everything needed to decide: items with options and notes, allergens, the drop-off address and the money. Collapsed when several orders wait. */
function OrderDetails({ o, full }: { o: PendingOrder; full: boolean }) {
  const a = o.deliveryAddress;
  const lines = full ? o.lines : o.lines.slice(0, 4);
  return (
    <>
      {o.fulfillmentType === 'DELIVERY' && a?.line1 && <div className="text-sm text-ink-800">To {a.line1}{a.line2 ? `, ${a.line2}` : ''}{a.city ? `, ${a.city}` : ''}{full && a.instructions ? <span className="block text-xs italic text-ink-600">“{a.instructions}”</span> : null}</div>}
      <ul className="space-y-0.5 text-sm text-ink-800">
        {lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span>
              <b>{l.quantity}×</b> {l.name}
              {full && l.modifiers?.length ? <span className="text-ink-500"> — {l.modifiers.join(', ')}</span> : null}
              {full && l.specialInstructions ? <span className="block text-xs italic text-amber-700">“{l.specialInstructions}”</span> : null}
              {full && l.allergens?.length ? <span className="block text-xs text-red-700">Allergens: {l.allergens.join(', ')}</span> : null}
            </span>
            {full && l.lineTotalCents != null && <span className="text-ink-500">{money(l.lineTotalCents)}</span>}
          </li>
        ))}
        {!full && o.lines.length > 4 && <li className="text-ink-500">+{o.lines.length - 4} more</li>}
      </ul>
      {full && o.specialInstructions && <div className="rounded bg-amber-50 px-2 py-1 text-sm italic text-amber-800">Order note: {o.specialInstructions}</div>}
      {full && o.subtotalCents != null && <div className="text-xs text-ink-500">Subtotal {money(o.subtotalCents)} · tax {money(o.taxCents || 0)}{o.deliveryFeeCents ? ` · delivery ${money(o.deliveryFeeCents)}` : ''}{o.tipCents ? ` · tip ${money(o.tipCents)}` : ''}{o.discountCents ? ` · discount −${money(o.discountCents)}` : ''}</div>}
    </>
  );
}

/** Orders waiting for acceptance at every location this person works at, polled every 5 s. */
export function usePendingOrders(enabled: boolean) {
  const { data, reload } = useApi<PendingOrder[]>(enabled ? '/merchant/pending-orders' : null, { poll: 5000, deps: [enabled] });
  return { pending: data || [], reload };
}

const RING_EVERY_MS = 3500;
const URGENT_AFTER_MS = 2 * 60_000;
const BASE_TITLE_KEY = '__gutadTitle';

/**
 * New-order alarm for the merchant portal: a full-screen overlay on every merchant page, a ringtone that repeats until
 * someone responds, a flashing tab title, a browser notification while the tab is hidden, and a screen wake lock so a
 * counter tablet stays awake. Browsers only allow sound after a tap, so the first tap anywhere (or "Turn sound on") arms it.
 */
export function NewOrderAlarm({ pending, reload, onView }: { pending: PendingOrder[]; reload: () => unknown; onView: (o: PendingOrder) => void }) {
  const router = useRouter();
  const [soundOn, setSoundOn] = useLocalState<boolean>('gutad.orderSound', true);
  const [unlocked, setUnlocked] = useState(false);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [prep, setPrep] = useState<Record<string, number>>({});
  const [details, setDetails] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const notified = useRef<Set<string>>(new Set());

  const open = pending.filter((o) => !acked.has(o.id));
  const ringing = open.length > 0;
  const oldest = open.length ? Math.min(...open.map((o) => new Date(o.createdAt).getTime())) : now;
  const urgent = ringing && now - oldest > URGENT_AFTER_MS;

  // clock for the countdowns and the urgency switch
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  // forget acknowledgements for orders that are no longer pending
  useEffect(() => {
    setAcked((a) => { const ids = new Set(pending.map((o) => o.id)); const next = new Set([...a].filter((id) => ids.has(id))); return next.size === a.size ? a : next; });
  }, [pending]);

  // the first tap anywhere unlocks audio (autoplay policy)
  useEffect(() => {
    if (unlocked) return;
    const arm = () => {
      const a = audio.current || (audio.current = new Audio('/sounds/new-order.wav'));
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; setUnlocked(true); }).catch(() => { a.muted = false; });
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return () => { window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
  }, [unlocked]);

  // ring until answered, louder once an order has waited 2 minutes
  useEffect(() => {
    if (!ringing || !soundOn) return;
    const a = audio.current || (audio.current = new Audio('/sounds/new-order.wav'));
    const ring = () => { a.volume = urgent ? 1 : 0.7; a.currentTime = 0; a.play().then(() => setUnlocked(true)).catch(() => undefined); };
    ring();
    const t = setInterval(ring, urgent ? RING_EVERY_MS * 0.6 : RING_EVERY_MS);
    return () => clearInterval(t);
  }, [ringing, soundOn, urgent]);

  // flashing tab title while anything is waiting
  useEffect(() => {
    const w = window as unknown as Record<string, string | undefined>;
    if (!pending.length) { if (w[BASE_TITLE_KEY]) { document.title = w[BASE_TITLE_KEY]!; w[BASE_TITLE_KEY] = undefined; } return; }
    if (!w[BASE_TITLE_KEY]) w[BASE_TITLE_KEY] = document.title;
    let on = false;
    const t = setInterval(() => { on = !on; document.title = on ? `🔔 (${pending.length}) NEW ORDER` : w[BASE_TITLE_KEY]!; }, 1000);
    return () => { clearInterval(t); if (w[BASE_TITLE_KEY]) document.title = w[BASE_TITLE_KEY]!; };
  }, [pending.length]);

  // system notification for orders that arrive while the tab is in the background
  useEffect(() => {
    for (const o of pending) {
      if (notified.current.has(o.id)) continue;
      notified.current.add(o.id);
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) continue;
      const n = new Notification(`New order ${o.number}`, { body: `${o.locationName} · ${o.fulfillmentType.toLowerCase()} · ${money(o.totalCents)}`, tag: `order-${o.id}`, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }, [pending]);

  // keep a counter tablet's screen awake while the portal is open
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release: () => Promise<void> } | null = null;
    const get = () => { if (document.visibilityState === 'visible') nav.wakeLock!.request('screen').then((l) => { lock = l; }).catch(() => undefined); };
    get();
    document.addEventListener('visibilitychange', get);
    return () => { document.removeEventListener('visibilitychange', get); void lock?.release().catch(() => undefined); };
  }, []);

  const ack = (ids: string[]) => setAcked((a) => new Set([...a, ...ids]));
  const accept = async (o: PendingOrder) => {
    setBusy(o.id); setErr(null);
    try {
      await api.post(`/orders/${o.id}/accept`, { prepMinutes: prep[o.id] ?? 20 });
      ack([o.id]); await reload();
      // straight to the order's tracking page, so it's clear what happens next
      onView(o); router.push(`/merchant/orders/${o.id}`);
    } catch (e) { setErr((e as Error).message || 'Could not accept the order'); }
    finally { setBusy(null); }
  };
  const reject = async (o: PendingOrder, reason: string) => {
    setBusy(o.id); setErr(null);
    try { await api.post(`/orders/${o.id}/reject`, { reason }); setRejecting(null); ack([o.id]); await reload(); }
    catch (e) { setErr((e as Error).message || 'Could not reject the order'); }
    finally { setBusy(null); }
  };
  const toggleDetails = (id: string) => setDetails((d) => { const n = new Set(d); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const view = (o: PendingOrder) => { ack(open.map((x) => x.id)); onView(o); router.push(`/merchant/orders/${o.id}`); };
  const enableAlerts = () => {
    setSoundOn(true);
    const a = audio.current || (audio.current = new Audio('/sounds/new-order.wav'));
    a.currentTime = 0; a.play().then(() => setUnlocked(true)).catch(() => undefined);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  };

  return (
    <>
      <AlarmControls soundOn={soundOn} unlocked={unlocked} onEnable={enableAlerts} onMute={() => setSoundOn(false)} />
      {ringing && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-900/70 p-4 backdrop-blur-sm" role="alertdialog" aria-live="assertive" aria-label="New order">
          <div className={`absolute inset-0 animate-pulse ${urgent ? 'bg-red-600/30' : 'bg-brand-500/25'}`} aria-hidden />
          <div className={`relative w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-8 ${urgent ? 'ring-red-500' : 'ring-brand-400'} gutad-shake`}>
            <div className={`flex items-center gap-3 px-5 py-4 text-white ${urgent ? 'bg-red-600' : 'bg-brand-500'}`}>
              <span className="relative flex h-4 w-4"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" /><span className="relative inline-flex h-4 w-4 rounded-full bg-white" /></span>
              <div className="text-xl font-bold">{open.length === 1 ? 'New order!' : `${open.length} new orders!`}{urgent && ' Waiting over 2 min'}</div>
            </div>
            {soundOn && !unlocked && <button className="w-full bg-amber-100 px-5 py-2 text-left text-sm font-medium text-amber-900" onClick={enableAlerts}>🔇 Sound is blocked by the browser. Tap here to turn on the order alarm.</button>}
            <div className="max-h-[60vh] divide-y divide-ink-100 overflow-y-auto">
              {open.map((o) => {
                const left = o.rejectAt ? Math.max(0, new Date(o.rejectAt).getTime() - now) : null;
                return (
                  <div key={o.id} className="space-y-2 px-5 py-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-lg font-bold">{o.number}</div>
                      <div className="text-lg font-bold">{money(o.totalCents)}</div>
                    </div>
                    <div className={`inline-block rounded-md px-2 py-0.5 text-sm font-extrabold tracking-wide ${o.fulfillmentType === 'DELIVERY' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>{o.fulfillmentType === 'DELIVERY' ? '🛵 DELIVERY' : o.fulfillmentType === 'DINE_IN' ? '🍽️ DINE IN' : '🛍️ PICKUP'}</div>
                    <div className="text-sm text-ink-600">{o.locationName}{o.guestName ? ` · ${o.guestName}` : ''}{o.scheduledFor ? ` · scheduled ${new Date(o.scheduledFor).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</div>
                    <OrderDetails o={o} full={open.length === 1 || details.has(o.id)} />
                    {open.length > 1 && <button className="text-sm font-semibold text-brand-600 underline" onClick={() => toggleDetails(o.id)}>{details.has(o.id) ? 'Hide details' : 'View details'}</button>}
                    {left !== null && <div className={`text-sm font-semibold ${left < 5 * 60_000 ? 'text-red-600' : 'text-ink-600'}`}>Auto-rejects in {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}</div>}
                    {rejecting === o.id ? (
                      <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-2">
                        <div className="text-sm font-semibold text-red-800">Why are you rejecting it? The customer is told and their payment hold is released.</div>
                        <div className="flex flex-wrap gap-1">{REJECT_REASONS.map((r) => <button key={r} disabled={busy === o.id} onClick={() => void reject(o, r)} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-60">{r}</button>)}</div>
                        <button className="text-xs text-ink-500 underline" onClick={() => setRejecting(null)}>Back</button>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-1 text-sm"><span className="mr-1 text-ink-600">Ready in</span>{PREP_CHOICES.map((m) => <button key={m} onClick={() => setPrep({ ...prep, [o.id]: m })} className={`rounded-lg px-2.5 py-1 font-semibold ${(prep[o.id] ?? 20) === m ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'}`}>{m}m</button>)}</div>
                        <div className="flex gap-2 pt-1">
                          <button disabled={busy === o.id} onClick={() => void accept(o)} className="flex-[2] rounded-xl bg-green-600 px-4 py-3 text-base font-bold text-white hover:bg-green-700 disabled:opacity-60">{busy === o.id ? 'Accepting…' : `Accept · ready in ${prep[o.id] ?? 20} min`}</button>
                          <button onClick={() => view(o)} className="flex-1 rounded-xl border-2 border-ink-200 px-3 py-3 text-sm font-semibold text-ink-800 hover:bg-ink-50">Open order</button>
                          <button onClick={() => setRejecting(o.id)} className="rounded-xl border-2 border-red-200 px-3 py-3 text-sm font-semibold text-red-700 hover:bg-red-50">Reject</button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {err && <div className="bg-red-50 px-5 py-2 text-sm text-red-700">{err}</div>}
            <button onClick={() => ack(open.map((o) => o.id))} className="w-full border-t border-ink-100 px-5 py-2 text-sm text-ink-500 hover:bg-ink-50">Silence for now (the Orders badge stays until it’s answered)</button>
          </div>
          <style>{'@keyframes gutadShake{0%{transform:rotate(-0.6deg) scale(1)}100%{transform:rotate(0.6deg) scale(1.015)}}.gutad-shake{animation:gutadShake .6s ease-in-out infinite alternate}@media (prefers-reduced-motion: reduce){.gutad-shake{animation:none}}'}</style>
        </div>
      )}
    </>
  );
}

/** Sidebar switch: arm the sound and system notifications with a tap, or mute the alarm on this device. */
function AlarmControls({ soundOn, unlocked, onEnable, onMute }: { soundOn: boolean; unlocked: boolean; onEnable: () => void; onMute: () => void }) {
  const [perm, setPerm] = useState<string>('default');
  useEffect(() => { if (typeof Notification !== 'undefined') setPerm(Notification.permission); }, [soundOn, unlocked]);
  const armed = soundOn && unlocked;
  return (
    <div className={`rounded-lg border px-2 py-1.5 text-xs ${armed ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      {armed ? <>🔔 Order alarm on{perm !== 'granted' && perm !== 'denied' ? <> · <button className="underline" onClick={onEnable}>allow pop-ups</button></> : null} · <button className="underline" onClick={onMute}>mute</button></>
        : <button className="text-left font-medium underline" onClick={onEnable}>🔕 Tap to turn on the new-order alarm</button>}
    </div>
  );
}
