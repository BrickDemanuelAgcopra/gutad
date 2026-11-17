'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChefAvailability } from '@gutad/shared';
import { api, money, newIdempotencyKey, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Button, Card, Select, Spinner } from '@/components/ui';
import { QtyStepper } from '@/components/form-kit';
import { CardField, type CardToken } from '@/components/card-field';
import { DateSlotPicker, type DateSlot } from '@/components/date-slot-picker';
import { AuthForm } from '@/components/auth-form';

interface OrderLine { id: string; menuItemId: string | null; name: string; quantity: number; unitPriceCents: number; modifiersCents: number; modifiers: { id: string; name: string; qty?: number }[]; specialInstructions: string | null }
interface Order { id: string; number: string; locationId: string; fulfillmentType: 'PICKUP' | 'DELIVERY'; channel: string; totalCents: number; scheduledFor: string | null; tipCents: number; deliveryAddress: Record<string, unknown> | null; lines: OrderLine[]; chefNetwork: { chefName: string | null; freeCancelUntil: string | null } | null }
interface Amendment { allowed: boolean; code: string; reason: string; until: string | null; chargedCents: number }
interface Quote { id: string; totalCents: number; subtotalCents: number; taxCents: number; serviceFeeCents: number; smallOrderFeeCents: number; deliveryFeeCents: number; warnings: string[]; chefTerms: { freeCancelUntil: string | null } | null }

/**
 * Change a paid Gutad Chef Network order before its cutoff: quantities, removing dishes, day and time. The change
 * is priced as a new order (the original's portions don't count against the day); confirming charges the new total
 * and refunds the original in full.
 */
export default function ChangeOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { user, ready } = useSession();
  if (!ready) return <Spinner />;
  if (!user) return <AuthForm />;
  return <ChangeOrder id={id} />;
}

function ChangeOrder({ id }: { id: string }) {
  const router = useRouter();
  const { data: o, error } = useApi<Order>(`/orders/${id}`);
  const { data: am } = useApi<Amendment>(`/orders/${id}/amendment`);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [slot, setSlot] = useState<DateSlot | null>(null);
  const [avail, setAvail] = useState<ChefAvailability | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<CardToken | null>(null);
  const [savedCardId, setSavedCardId] = useState('');
  const { data: cards } = useApi<{ id: string; brand: string | null; last4: string | null; isDefault: boolean }[]>('/me/payment-methods');
  useEffect(() => { const d = cards?.find((c) => c.isDefault) || cards?.[0]; if (d && !savedCardId) setSavedCardId(d.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cards]);
  const holdKey = useRef(newIdempotencyKey());
  const idem = useRef(newIdempotencyKey());
  const lines = useMemo(() => (o?.lines || []).filter((l) => l.menuItemId).map((l) => ({ ...l, quantity: qty[l.id] ?? l.quantity })), [o, qty]);
  const kept = lines.filter((l) => l.quantity > 0);
  const lineKey = kept.map((l) => `${l.id}:${l.quantity}`).join(',');

  // the order's own day first; the calendar ignores this order's portions while changing it
  useEffect(() => {
    if (!o || !kept.length) return;
    let cancelled = false;
    api.post<ChefAvailability>(`/public/chef-kitchens/${o.locationId}/availability`, { lines: kept.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })), holdKey: holdKey.current, replacesOrderId: o.id })
      .then((a) => {
        if (cancelled) return;
        setAvail(a);
        setSlot((cur) => {
          if (cur && a.days.some((d) => d.date === cur.date && d.status === 'AVAILABLE')) return cur;
          if (!o.scheduledFor) return a.earliestDate ? { date: a.earliestDate, time: '' } : null;
          const local = new Date(o.scheduledFor).toLocaleString('sv-SE', { timeZone: a.timezone }).slice(0, 16);
          const [d, t] = local.split(' ');
          const day = a.days.find((x) => x.date === d && x.status === 'AVAILABLE');
          return day ? { date: d, time: day.slots.includes(t) ? t : '' } : a.earliestDate ? { date: a.earliestDate, time: '' } : null;
        });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.id, lineKey]);

  // price the change
  useEffect(() => {
    if (!o || !slot?.time || !kept.length) { setQuote(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        setProblem(null);
        const iso = (await api.get<{ iso: string }>(`/public/locations/${o.locationId}/local-time?date=${slot.date}&time=${slot.time}`)).iso;
        const q = await api.post<Quote>('/quotes', { locationId: o.locationId, channel: 'MARKETPLACE', fulfillmentType: o.fulfillmentType, scheduledFor: iso, tipCents: o.tipCents, holdKey: holdKey.current, replacesOrderId: o.id, deliveryAddress: o.fulfillmentType === 'DELIVERY' ? o.deliveryAddress : undefined, lines: kept.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifiers.flatMap((m) => Array(m.qty || 1).fill(m.id)), specialInstructions: l.specialInstructions || undefined })) });
        if (!cancelled) setQuote(q);
      } catch (e) { if (!cancelled) { setQuote(null); setProblem((e as Error).message); } }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.id, lineKey, slot?.date, slot?.time]);

  if (error) return <Alert>{error}</Alert>;
  if (!o || !am) return <Spinner />;
  if (!am.allowed) return <div className="space-y-3"><Link href={`/orders/${id}`} className="text-sm text-ink-500 hover:underline">← Order {o.number}</Link><Alert tone="info">{am.reason}</Alert></div>;
  const useSaved = !!savedCardId && savedCardId !== 'new';
  const confirm = async () => {
    if (!quote) return;
    setBusy(true); setProblem(null);
    try {
      if (quote.totalCents > 0 && !useSaved && !card) throw new Error('Choose a card');
      const n = await api.post<{ id: string }>(`/orders/${o.id}/amend`, { quoteId: quote.id, ...(quote.totalCents === 0 ? {} : useSaved ? { savedPaymentMethodId: savedCardId } : { paymentMethodId: card!.token }) }, idem.current);
      router.push(`/orders/${n.id}`);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={`/orders/${id}`} className="text-sm text-ink-500 hover:underline">← Order {o.number}</Link>
      <div><h1 className="text-2xl font-bold">Change order {o.number}</h1><p className="text-sm text-ink-600">Changes are open until {when(am.until)}. {o.chefNetwork?.chefName || 'The chef'} confirms the changed order again.</p></div>
      <Card title="Dishes">
        <ul className="divide-y divide-ink-100">
          {lines.map((l) => (
            <li key={l.id} className={`flex flex-wrap items-center gap-3 py-2 ${l.quantity === 0 ? 'opacity-50' : ''}`}>
              <div className="min-w-0 flex-1"><div className="font-medium">{l.name}</div>{l.modifiers.length > 0 && <div className="text-xs text-ink-500">{l.modifiers.map((m) => m.name).join(', ')}</div>}</div>
              <QtyStepper label={`Quantity of ${l.name}`} size="sm" value={l.quantity} min={0} max={50} onChange={(v) => setQty({ ...qty, [l.id]: v })} />
              <span className="w-20 text-right text-sm">{money((l.unitPriceCents + l.modifiersCents) * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-500">Set a dish to 0 to remove it. To add other dishes, cancel for a full refund and order again.</p>
      </Card>
      {!kept.length ? <Alert tone="info">Nothing left in the order. <Link className="underline" href={`/orders/${id}`}>Cancel it instead</Link> for a full refund.</Alert> : (
        <Card title="Day and time"><DateSlotPicker availability={avail} value={slot} onChange={setSlot} title={o.fulfillmentType === 'DELIVERY' ? 'Delivery day and time' : 'Pickup day and time'} /></Card>
      )}
      {problem && <Alert>{problem}</Alert>}
      {quote && (
        <Card title="What changes">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span>New order total</span><b>{money(quote.totalCents)}</b></div>
            <div className="flex justify-between text-ink-600"><span>Refund of order {o.number} (in full)</span><span>−{money(am.chargedCents)}</span></div>
            <div className="flex justify-between border-t border-ink-100 pt-1"><span>Difference</span><b>{quote.totalCents - am.chargedCents >= 0 ? '+' : '−'}{money(Math.abs(quote.totalCents - am.chargedCents))}</b></div>
            {quote.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
            <p className="text-xs text-ink-500">We charge the new total and refund the original charge in full (refunds take 5–10 business days to appear). If the chef can’t make the changed order, you’re refunded in full automatically.{quote.chefTerms?.freeCancelUntil ? ` Free cancellation until ${when(quote.chefTerms.freeCancelUntil)}.` : ''}</p>
          </div>
          {quote.totalCents > 0 && (
            <div className="mt-3 space-y-2">
              {!!cards?.length && <Select label="Pay with" value={savedCardId} onChange={(e) => setSavedCardId(e.target.value)}>{cards.map((c) => <option key={c.id} value={c.id}>{c.brand || 'Card'} •••• {c.last4}</option>)}<option value="new">A new card</option></Select>}
              {(!cards?.length || savedCardId === 'new') && <CardField value={card} onChange={setCard} />}
            </div>
          )}
          <Button className="mt-3 w-full" size="lg" disabled={busy} onClick={() => void confirm()}>{busy ? 'Saving…' : `Confirm changes — charge ${money(quote.totalCents)}`}</Button>
        </Card>
      )}
    </div>
  );
}
