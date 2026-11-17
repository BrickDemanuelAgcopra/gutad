'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  ALLERGENS,
  CHEF_REQUEST_REASONS,
  CHEF_REQUEST_STATUS_LABELS,
  CHEF_REQUEST_TYPES,
  DIETARY_TAGS,
  type ChefAvailability,
  type ChefQuoteCartLine,
  type ChefRequestDetail,
  type ChefRequestQuote,
  type ChefRequestReason,
  type ChefRequestStatus,
  type ChefRequestSummary,
  type ChefRequestType,
  type PublicChefDish,
} from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Spinner, Textarea } from '@/components/ui';
import { ChipGroup, QtyStepper, Segmented } from '@/components/form-kit';
import { DateSlotPicker, preferredDate, type DateSlot } from '@/components/date-slot-picker';
import { CustomizationSummary, DishCustomizer, useCustomization } from '@/components/dish-customizer';

type Detail = ChefRequestDetail & { cartLine: ChefQuoteCartLine | null };

const STATUS_TONE: Record<ChefRequestStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = { PENDING: 'info', NEEDS_INFO: 'warn', QUOTED: 'good', ACCEPTED: 'good', ORDERED: 'good', DECLINED: 'bad', WITHDRAWN: 'neutral', EXPIRED: 'neutral', CLOSED: 'neutral' };
export const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const pretty = (s: string) => s.replace(/_/g, ' ');

export function RequestStatusBadge({ status, viewer = 'CUSTOMER' }: { status: ChefRequestStatus; viewer?: 'CUSTOMER' | 'CHEF' | 'STAFF' }) {
  // the chef reads the same states from the kitchen's side
  const chefLabel: Partial<Record<ChefRequestStatus, string>> = { PENDING: 'Needs your reply', NEEDS_INFO: 'Waiting on customer', QUOTED: 'Quote sent', ACCEPTED: 'Accepted, awaiting payment' };
  return <Badge tone={STATUS_TONE[status]}>{(viewer !== 'CUSTOMER' && chefLabel[status]) || CHEF_REQUEST_STATUS_LABELS[status]}</Badge>;
}

/** Deadline text: "Reply by Tue 3:00 PM" (red when under 4 hours). */
function Deadline({ at, label }: { at: string | null; label: string }) {
  if (!at) return null;
  const soon = new Date(at).getTime() - Date.now() < 4 * 3_600_000;
  return <span className={soon ? 'font-medium text-red-700' : 'text-ink-500'}>{label} {when(at)}</span>;
}

/** One row in a list of requests (customer, chef inbox, staff). */
export function RequestRow({ r, href, viewer }: { r: ChefRequestSummary; href: string; viewer: 'CUSTOMER' | 'CHEF' | 'STAFF' }) {
  const q = r.latestQuote;
  return (
    <Link href={href} className="flex gap-3 rounded-xl border border-ink-100 bg-white p-3 hover:border-brand-300">
      {r.dish.photo ? <img src={r.dish.photo} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" /> : <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-ink-50">🍽</div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{r.dish.title}</span><RequestStatusBadge status={r.status} viewer={viewer} />{r.reason === 'ALLERGY' && <Badge tone="bad">Allergy</Badge>}</div>
        <p className="truncate text-sm text-ink-700">{r.details}</p>
        <p className="text-xs text-ink-500">{r.code} · {r.servings} serving{r.servings === 1 ? '' : 's'} · for {dayLabel(r.requestedDate)}{viewer !== 'CUSTOMER' && r.customer?.name ? ` · ${r.customer.name}` : ''}{viewer === 'STAFF' ? ` · ${r.chef.displayName}` : ''}</p>
        <p className="text-xs">{r.status === 'PENDING' ? <Deadline at={r.respondBy} label={viewer === 'CUSTOMER' ? 'Chef replies by' : 'Reply by'} /> : r.status === 'NEEDS_INFO' ? <Deadline at={r.respondBy} label={viewer === 'CUSTOMER' ? 'Reply by' : 'Customer replies by'} /> : null}</p>
      </div>
      {q && <div className="shrink-0 text-right"><div className="font-semibold">{money(q.totalCents)}</div><div className="text-xs text-ink-500">quote v{q.version}</div></div>}
    </Link>
  );
}

/** The customer's requests (account tab and /account/requests). */
export function MyRequests() {
  const { data, error } = useApi<ChefRequestSummary[]>('/chef-requests', { poll: 30_000 });
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  if (!data.length) return <p className="text-ink-500">No special requests yet. On a chef’s dish that takes requests, choose “Request something special”.</p>;
  return <div className="space-y-2">{data.map((r) => <RequestRow key={r.id} r={r} href={`/account/requests/${r.id}`} viewer="CUSTOMER" />)}</div>;
}

// ───── customer: new request ─────

/** "Request something special": what to change, why, servings, day, budget and alternatives. Nothing is charged. */
export function NewRequestModal({ dish, open, onClose, ingredient, baseOptionIds, baseOptionNames }: { dish: PublicChefDish; open: boolean; onClose: () => void; ingredient?: string; baseOptionIds?: string[]; baseOptionNames?: string[] }) {
  const router = useRouter();
  const { user, ready } = useSession();
  const { busy, error, run } = useAction();
  const [type, setType] = useState<ChefRequestType>(ingredient ? 'ADD' : 'OTHER');
  const [ing, setIng] = useState(ingredient || '');
  const [details, setDetails] = useState(ingredient ? `Please add ${ingredient}` : '');
  const [reason, setReason] = useState<ChefRequestReason>('PREFERENCE');
  const [servings, setServings] = useState(1);
  const [day, setDay] = useState<DateSlot | null>(null);
  const [budget, setBudget] = useState('');
  const [altOk, setAltOk] = useState(true);
  const [altNote, setAltNote] = useState('');
  useEffect(() => { if (open && ingredient) { setType('ADD'); setIng(ingredient); setDetails(`Please add ${ingredient}`); } }, [open, ingredient]);
  const { data: avail, loading } = useApi<ChefAvailability>(open ? `/public/chef-dishes/${dish.id}/availability?quantity=${servings}` : null);
  const chef = dish.chef.displayName;
  const submit = () => run(async () => {
    const r = await api.post<{ id: string }>('/chef-requests', { dishId: dish.id, requestType: type, details, ingredient: ['ADD', 'SWAP', 'REMOVE'].includes(type) && ing ? ing : null, servings, requestedDate: day!.date, requestedTime: day!.time || null, reason, budgetCents: budget ? Math.round(Number(budget) * 100) : null, alternativesOk: altOk, alternativesNote: altOk && altNote ? altNote : null, baseOptionIds: baseOptionIds?.length ? baseOptionIds : undefined });
    router.push(`/account/requests/${r.id}`);
  });
  return (
    <Modal open={open} onClose={onClose} title={`Ask ${chef}`}>
      {!ready ? <Spinner /> : !user ? (
        <div className="space-y-3"><p className="text-sm text-ink-700">Sign in to send {chef} a special request. You’ll get a quote to accept before anything is charged.</p><Link href="/account" className="inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white">Sign in or create an account</Link></div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="text-sm text-ink-600">For <strong>{dish.title}</strong>. {chef} confirms the price, allergens and day in a quote. Nothing is charged until you accept and pay.</p>
          {!!baseOptionNames?.length && <p className="rounded-lg bg-ink-50 p-2 text-xs text-ink-600">Starting from your choices: {baseOptionNames.join(', ')}</p>}
          <Select label="What would you like?" value={type} onChange={(e) => setType(e.target.value as ChefRequestType)}>{Object.entries(CHEF_REQUEST_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          {['ADD', 'SWAP', 'REMOVE'].includes(type) && <Input label="Ingredient" value={ing} onChange={(e) => setIng(e.target.value)} placeholder="e.g. shrimp" maxLength={80} />}
          <Textarea label="Details for the chef" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} maxLength={1000} placeholder="How much, how it’s cooked, anything the chef should know" required />
          <div><div className="mb-1 text-sm font-medium">Why</div><Segmented name="reason" size="sm" value={reason} onChange={setReason} options={Object.entries(CHEF_REQUEST_REASONS).map(([k, v]) => ({ value: k as ChefRequestReason, label: v }))} /></div>
          {reason === 'ALLERGY' && <Alert tone="info">Tell the chef exactly which allergen. Home and shared kitchens may still handle it; the quote will list the dish’s allergens.</Alert>}
          <QtyStepper label="Servings" value={servings} min={1} max={50} onChange={setServings} />
          <DateSlotPicker availability={avail ?? null} value={day} onChange={setDay} loading={loading} title="For which day?" />
          <Input label="Budget per order (optional, $)" type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={altOk} onChange={(e) => setAltOk(e.target.checked)} /> I’m open to an alternative if the chef suggests one</label>
          {altOk && <Input label="Acceptable alternatives (optional)" value={altNote} onChange={(e) => setAltNote(e.target.value)} placeholder="e.g. chicken instead of shrimp is fine" maxLength={500} />}
          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="w-full" disabled={busy || !day || details.trim().length < 5}>{busy ? 'Sending…' : !day ? 'Choose a day' : `Send request to ${chef}`}</Button>
        </form>
      )}
    </Modal>
  );
}

// ───── shared detail view ─────

function QuoteCard({ q, current, budgetCents }: { q: ChefRequestQuote; current: boolean; budgetCents: number | null }) {
  const live = current && (q.status === 'SENT' || q.status === 'ACCEPTED');
  return (
    <div className={`rounded-xl border p-4 ${live ? 'border-brand-300 bg-brand-50/40' : 'border-ink-100 bg-white opacity-80'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{q.kind === 'ALTERNATIVE' ? 'Suggested alternative' : 'Quote'} v{q.version}</span>
        <Badge tone={q.status === 'SENT' || q.status === 'ACCEPTED' || q.status === 'ORDERED' ? 'good' : 'neutral'}>{pretty(q.status).toLowerCase()}</Badge>
        <span className="ml-auto text-lg font-bold">{money(q.totalCents)}</span>
      </div>
      {q.kind === 'ALTERNATIVE' && <p className="mt-1 text-sm">Instead: <strong>{q.dish.title}</strong> (prepared by {q.chef.displayName})</p>}
      <p className="mt-2 whitespace-pre-line text-sm">{q.changes}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-ink-500">Price</dt><dd>{money(q.unitPriceCents)} × {q.quantity}{budgetCents !== null && q.totalCents > budgetCents ? <span className="ml-1 text-xs text-amber-700">(over the {money(budgetCents)} budget)</span> : null}</dd></div>
        <div><dt className="text-xs text-ink-500">For</dt><dd>{dayLabel(q.serviceDate)}{q.serviceTime ? ` at ${q.serviceTime}` : ' (any time that day)'}</dd></div>
        <div><dt className="text-xs text-ink-500">Portion</dt><dd>{q.portionDesc || '—'}</dd></div>
        <div><dt className="text-xs text-ink-500">Allergens</dt><dd className={q.allergens.length ? 'font-medium text-red-700' : ''}>{q.allergens.length ? q.allergens.map(pretty).join(', ') : 'None declared'}</dd></div>
        {q.dietaryTags.length > 0 && <div><dt className="text-xs text-ink-500">Dietary</dt><dd>{q.dietaryTags.map(pretty).join(', ')}</dd></div>}
        {q.prepMinutes && <div><dt className="text-xs text-ink-500">Prep</dt><dd>{q.prepMinutes} min</dd></div>}
      </dl>
      {q.note && <p className="mt-2 rounded-lg bg-white p-2 text-sm italic">“{q.note}”</p>}
      {live && <p className="mt-2 text-xs text-ink-500">Valid until {when(q.expiresAt)}. Sold by Gutad; full refund if the chef can’t make it.</p>}
    </div>
  );
}

function Thread({ d, onSend, busy }: { d: Detail; onSend: (body: string) => Promise<unknown>; busy: boolean }) {
  const [body, setBody] = useState('');
  const mine = d.viewerRole;
  return (
    <Card title="Messages">
      <ol className="space-y-2">
        {d.messages.length === 0 && <li className="text-sm text-ink-500">No messages yet.</li>}
        {d.messages.map((m) => m.authorRole === 'SYSTEM' ? (
          <li key={m.id} className="text-center text-xs text-ink-500">{m.body} · {when(m.createdAt)}</li>
        ) : (
          <li key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.authorRole === mine ? 'ml-auto bg-brand-600 text-white' : m.authorRole === 'STAFF' ? 'bg-amber-50' : 'bg-ink-50'}`}>
            <div className={`text-[11px] ${m.authorRole === mine ? 'text-brand-100' : 'text-ink-500'}`}>{m.authorRole === mine ? 'You' : m.authorName || pretty(m.authorRole).toLowerCase()} · {when(m.createdAt)}</div>
            <div className="whitespace-pre-line">{m.body}</div>
          </li>
        ))}
      </ol>
      {d.can.message && (
        <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!body.trim()) return; await onSend(body); setBody(''); }}>
          <Input aria-label="Message" className="flex-1" value={body} onChange={(e) => setBody(e.target.value)} placeholder={mine === 'CUSTOMER' && d.status === 'NEEDS_INFO' ? 'Answer the chef’s question' : 'Write a message'} maxLength={2000} />
          <Button type="submit" disabled={busy || !body.trim()}>Send</Button>
        </form>
      )}
    </Card>
  );
}

/**
 * A request with its quotes, thread and the actions the viewer may take (customer: accept & pay, revise, withdraw;
 * chef: quote, suggest an alternative, ask, decline; Gutad staff: extend, close).
 */
export function RequestView({ id, backHref, backLabel }: { id: string; backHref: string; backLabel: string }) {
  const { data: d, error, setData } = useApi<Detail>(`/chef-requests/${id}`, { poll: 20_000 });
  const act = useAction();
  const router = useRouter();
  const { add } = useCart();
  const [modal, setModal] = useState<null | 'quote' | 'alternative' | 'staff-alt' | 'ask' | 'decline' | 'revise' | 'withdraw' | 'close'>(null);
  const [text, setText] = useState('');
  if (error) return <Alert>{error}</Alert>;
  if (!d) return <Spinner />;
  const current = d.quotes.find((q) => q.id === d.latestQuote?.id) ?? null;
  const post = (path: string, body: unknown) => act.run(async () => { const r = await api.post<Detail>(path, body); setData({ ...r, cartLine: (r as Detail).cartLine ?? null }); setModal(null); setText(''); return r; });
  const toCheckout = (line: ChefQuoteCartLine) => {
    add(line.location, { menuItemId: line.menuItemId, name: line.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents, modifierOptionIds: line.modifierOptionIds, modifierNames: line.modifierNames, modifiersCents: 0, chefRequestQuoteId: line.chefRequestQuoteId, serviceDate: line.serviceDate }, 'MARKETPLACE', 'chef-request', { park: true });
    preferredDate.set(line.location.id, line.serviceDate);
    router.push('/checkout');
  };
  const accept = () => act.run(async () => { const r = await api.post<{ cartLine: ChefQuoteCartLine }>(`/chef-requests/${d.id}/accept`, { quoteId: current!.id }); toCheckout(r.cartLine); });
  const textModal = (kind: 'ask' | 'decline' | 'revise' | 'withdraw' | 'close', title: string, label: string, action: string, go: () => unknown, min = 3) => (
    <Modal open={modal === kind} onClose={() => setModal(null)} title={title}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Textarea label={label} value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={1000} />
        {act.error && <Alert>{act.error}</Alert>}
        <Button type="submit" variant={kind === 'decline' || kind === 'close' || kind === 'withdraw' ? 'danger' : 'primary'} disabled={act.busy || text.trim().length < min}>{action}</Button>
      </form>
    </Modal>
  );

  return (
    <div className="space-y-4">
      <Link href={backHref} className="text-sm text-ink-500 hover:underline">← {backLabel}</Link>
      <div className="flex flex-wrap items-start gap-4">
        {d.dish.photo && <img src={d.dish.photo} alt="" className="h-20 w-20 rounded-xl object-cover" />}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold sm:text-2xl">Special request {d.code}</h1>
          <p className="text-ink-700">{d.dish.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm"><RequestStatusBadge status={d.status} viewer={d.viewerRole} />{d.status === 'PENDING' && <Deadline at={d.respondBy} label={d.viewerRole === 'CHEF' ? 'Reply by' : 'Chef replies by'} />}{d.status === 'NEEDS_INFO' && <Deadline at={d.respondBy} label={d.viewerRole === 'CUSTOMER' ? 'Reply by' : 'Customer replies by'} />}{d.orderId && <Link className="underline" href={d.viewerRole === 'CUSTOMER' ? `/orders/${d.orderId}` : d.viewerRole === 'CHEF' ? '/merchant/orders' : `/admin/orders/${d.orderId}`}>View order</Link>}</div>
        </div>
      </div>

      {/* what the viewer can do now */}
      {d.viewerRole === 'CUSTOMER' && (d.cartLine || d.can.accept) && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="font-medium">{d.cartLine ? 'You accepted this quote. Pay to place the order.' : `${d.chef.displayName} quoted ${money(current!.totalCents)}.`}</p>
          <p className="text-sm text-ink-600">Checkout uses the quoted price, servings and day; you’re charged when you place the order.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {d.cartLine ? <Button onClick={() => toCheckout(d.cartLine!)}>Continue to payment — {money(d.cartLine.unitPriceCents * d.cartLine.quantity)}</Button> : <Button onClick={() => void accept()} disabled={act.busy}>Accept & pay — {money(current!.totalCents)}</Button>}
            {d.can.revise && <Button variant="secondary" onClick={() => setModal('revise')}>Ask for changes</Button>}
          </div>
        </div>
      )}
      {d.viewerRole === 'CHEF' && (d.can.quote || d.can.ask || d.can.decline) && (
        <div className="flex flex-wrap gap-2 rounded-2xl border border-ink-100 bg-white p-3">
          {d.can.quote && <Button onClick={() => setModal('quote')}>{d.latestQuote ? 'Send a new quote' : 'Accept & quote'}</Button>}
          {d.can.quote && <Button variant="secondary" onClick={() => setModal('alternative')}>Suggest alternative</Button>}
          {d.can.ask && <Button variant="secondary" onClick={() => setModal('ask')}>Ask a question</Button>}
          {d.can.decline && <Button variant="ghost" onClick={() => setModal('decline')}>Decline</Button>}
        </div>
      )}
      {d.viewerRole === 'STAFF' && d.can.close && (
        <div className="flex flex-wrap gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <span className="self-center text-sm">Gutad supervision:</span>
          <Button variant="secondary" disabled={act.busy} onClick={() => void post(`/admin/chef-requests/${d.id}/extend`, { hours: 24 })}>Give 24 more hours</Button>
          {d.can.quote && d.alternativesOk && <Button variant="secondary" onClick={() => setModal('staff-alt')}>Suggest another chef’s dish</Button>}
          <Button variant="danger" onClick={() => setModal('close')}>Close request</Button>
        </div>
      )}
      {act.error && !modal && <Alert>{act.error}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {d.quotes.length > 0 && <section aria-label="Quotes" className="space-y-3">{d.quotes.map((q) => <QuoteCard key={q.id} q={q} current={q.id === d.latestQuote?.id} budgetCents={d.budgetCents} />)}</section>}
          <Thread d={d} busy={act.busy} onSend={(body) => post(`/chef-requests/${d.id}/messages`, { body })} />
        </div>
        <Card title="The request">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-ink-500">Asked for</dt><dd>{CHEF_REQUEST_TYPES[d.requestType]}{d.ingredient ? `: ${d.ingredient}` : ''}</dd></div>
            <div><dt className="text-xs text-ink-500">Details</dt><dd className="whitespace-pre-line">{d.details}</dd></div>
            {d.baseOptionNames.length > 0 && <div><dt className="text-xs text-ink-500">Chosen options</dt><dd>{d.baseOptionNames.join(', ')}</dd></div>}
            <div><dt className="text-xs text-ink-500">Why</dt><dd className={d.reason === 'ALLERGY' ? 'font-medium text-red-700' : ''}>{CHEF_REQUEST_REASONS[d.reason]}</dd></div>
            <div><dt className="text-xs text-ink-500">Servings · day</dt><dd>{d.servings} · {dayLabel(d.requestedDate)}{d.requestedTime ? ` at ${d.requestedTime}` : ''}</dd></div>
            <div><dt className="text-xs text-ink-500">Budget</dt><dd>{d.budgetCents !== null ? money(d.budgetCents) : 'Not set'}</dd></div>
            <div><dt className="text-xs text-ink-500">Alternatives</dt><dd>{d.alternativesOk ? `Open to alternatives${d.alternativesNote ? `: ${d.alternativesNote}` : ''}` : 'No alternatives, please'}</dd></div>
            <div><dt className="text-xs text-ink-500">Listed price</dt><dd>{money(d.dish.priceCents)} per serving</dd></div>
            {d.viewerRole !== 'CUSTOMER' && d.customer?.name && <div><dt className="text-xs text-ink-500">Customer</dt><dd>{d.customer.name}</dd></div>}
            {d.viewerRole === 'STAFF' && <div><dt className="text-xs text-ink-500">Chef</dt><dd><Link className="underline" href={`/chefs/${d.chef.slug}`}>{d.chef.displayName}</Link></dd></div>}
          </dl>
          {d.viewerRole === 'CUSTOMER' && d.can.withdraw && <Button variant="ghost" size="sm" className="mt-4" onClick={() => setModal('withdraw')}>Withdraw request</Button>}
        </Card>
      </div>

      {(modal === 'quote' || modal === 'alternative') && <QuoteFormModal d={d} kind={modal === 'alternative' ? 'ALTERNATIVE' : 'QUOTE'} onClose={() => setModal(null)} onDone={(r) => { setData({ ...r, cartLine: null }); setModal(null); }} />}
      {modal === 'staff-alt' && <StaffAlternativeModal d={d} onClose={() => setModal(null)} onDone={(r) => { setData({ ...r, cartLine: null }); setModal(null); }} />}
      {textModal('ask', 'Ask the customer', 'Your question', 'Send question', () => post(`/chef/requests/${d.id}/question`, { body: text }), 1)}
      {textModal('decline', 'Decline this request', 'Reason (the customer sees this)', 'Decline request', () => post(`/chef/requests/${d.id}/decline`, { reason: text }))}
      {textModal('revise', 'Ask for changes', 'What should the chef change?', 'Request a new quote', () => post(`/chef-requests/${d.id}/revise`, { note: text }))}
      {textModal('withdraw', 'Withdraw request', 'Reason (optional)', 'Withdraw', () => post(`/chef-requests/${d.id}/withdraw`, { reason: text || undefined }), 0)}
      {textModal('close', 'Close request', 'Reason (both sides see this)', 'Close request', () => post(`/admin/chef-requests/${d.id}/close`, { reason: text }))}
    </div>
  );
}

// ───── chef: quote / alternative ─────

interface MenuDish { id: string; title: string; dishName: string; reviewStatus: string; live: boolean }

function QuoteFormModal({ d, kind, onClose, onDone }: { d: Detail; kind: 'QUOTE' | 'ALTERNATIVE'; onClose: () => void; onDone: (r: Detail) => void }) {
  const act = useAction();
  const { data: menu } = useApi<{ sections: { dishes: MenuDish[] }[] }>(kind === 'ALTERNATIVE' ? '/chef/menu' : null);
  const options = useMemo(() => (menu?.sections.flatMap((s) => s.dishes) || []).filter((x) => x.reviewStatus === 'PUBLISHED' && x.live), [menu]);
  const [dishId, setDishId] = useState(kind === 'ALTERNATIVE' ? '' : d.dish.id);
  const target = kind === 'ALTERNATIVE' ? dishId : d.dish.id;
  const { data: pub } = useApi<PublicChefDish>(target ? `/public/chef-dishes/${target}` : null);
  const last = d.latestQuote && d.latestQuote.dish.id === target ? d.latestQuote : null;
  const [changes, setChanges] = useState(last?.changes || (kind === 'QUOTE' ? d.details : ''));
  const [price, setPrice] = useState(((last?.unitPriceCents ?? d.dish.priceCents) / 100).toFixed(2));
  const [qty, setQty] = useState(last?.quantity ?? d.servings);
  const [allergens, setAllergens] = useState<string[]>(last?.allergens || []);
  const [tags, setTags] = useState<string[]>(last?.dietaryTags || []);
  const [portion, setPortion] = useState(last?.portionDesc || '');
  const [slot, setSlot] = useState<DateSlot | null>({ date: last?.serviceDate || d.requestedDate, time: last?.serviceTime || d.requestedTime || '' });
  const [fixTime, setFixTime] = useState(!!(last?.serviceTime || d.requestedTime));
  const [valid, setValid] = useState('48');
  const [note, setNote] = useState('');
  // prefill from the dish being quoted (allergens and labels are the chef's to confirm)
  useEffect(() => { if (pub && !last) { setAllergens(pub.allergens); setTags(pub.dietaryTags); setPortion(pub.portionDesc); if (kind === 'ALTERNATIVE') setPrice((pub.priceCents / 100).toFixed(2)); } }, [pub, last, kind]);
  const { data: avail, loading } = useApi<ChefAvailability>(target ? `/public/chef-dishes/${target}/availability?quantity=${qty}` : null);
  const cents = Math.round(Number(price) * 100);
  const submit = () => act.run(async () => {
    const r = await api.post<Detail>(`/chef/requests/${d.id}/quote`, { kind, altDishId: kind === 'ALTERNATIVE' ? dishId : undefined, changes, portionDesc: portion || null, unitPriceCents: cents, quantity: qty, allergens, dietaryTags: tags, serviceDate: slot!.date, serviceTime: fixTime && slot!.time ? slot!.time : null, note: note || null, validHours: Number(valid) });
    onDone(r);
  });
  return (
    <Modal open onClose={onClose} title={kind === 'ALTERNATIVE' ? 'Suggest an alternative' : 'Quote this request'}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {kind === 'ALTERNATIVE' && (
          <Select label="Dish to offer instead" value={dishId} onChange={(e) => setDishId(e.target.value)} required>
            <option value="">Choose one of your live dishes</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.dishName}</option>)}
          </Select>
        )}
        {!d.alternativesOk && kind === 'ALTERNATIVE' && <Alert>The customer asked for no alternatives.</Alert>}
        <Textarea label="Exactly what you’ll make (the customer sees this)" value={changes} onChange={(e) => setChanges(e.target.value)} rows={3} maxLength={1000} required />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Food price per serving ($)" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          <QtyStepper label="Servings" value={qty} min={1} max={50} onChange={setQty} />
        </div>
        <p className="text-sm text-ink-600">Total {money(cents * qty)}{d.budgetCents !== null ? ` · customer’s budget ${money(d.budgetCents)}` : ''}. Gutad adds its customer fees at checkout and takes its commission as usual.</p>
        <Input label="Portion" value={portion} onChange={(e) => setPortion(e.target.value)} maxLength={120} />
        <div><div className="mb-1 text-sm font-medium">Allergens in the finished dish</div><ChipGroup name="allergens" values={allergens} onChange={setAllergens} options={ALLERGENS.map((a) => ({ value: a, label: pretty(a) }))} /></div>
        {d.reason === 'ALLERGY' && <Alert tone="info">The customer mentioned an allergy. Double-check every allergen above.</Alert>}
        <div><div className="mb-1 text-sm font-medium">Dietary labels</div><ChipGroup name="tags" values={tags} onChange={setTags} options={DIETARY_TAGS.map((t) => ({ value: t, label: pretty(t) }))} /></div>
        <DateSlotPicker availability={avail ?? null} value={slot} onChange={setSlot} loading={loading} showTimes={fixTime} title="Cooking day" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fixTime} onChange={(e) => setFixTime(e.target.checked)} /> Fix the time (otherwise the customer picks any time that day)</label>
        <Select label="Quote valid for" value={valid} onChange={(e) => setValid(e.target.value)}><option value="12">12 hours</option><option value="24">24 hours</option><option value="48">2 days</option><option value="72">3 days</option><option value="168">7 days</option></Select>
        <p className="-mt-2 text-xs text-ink-500">Never later than that day’s order cutoff.</p>
        <Textarea label="Note to the customer (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
        {act.error && <Alert>{act.error}</Alert>}
        <Button type="submit" className="w-full" disabled={act.busy || !slot?.date || (fixTime && !slot.time) || !changes.trim() || !(cents >= 0) || (kind === 'ALTERNATIVE' && !dishId)}>{act.busy ? 'Sending…' : `Send quote — ${money(cents * qty)}`}</Button>
      </form>
    </Modal>
  );
}

// ───── Gutad staff: another chef's dish ─────

interface AltDish { id: string; title: string; dishName: string; description: string | null; mode: string; priceCents: number; portionDesc: string | null; allergens: string[]; dietaryTags: string[]; chef: { id: string; slug: string; displayName: string; city: string | null }; sameCity: boolean; sameCuisine: boolean; requestedDay: { status: string; slots: string[] } | null; mentionedAllergens: string[] }
interface Alternatives { requestedDate: string; servings: number; reason: string; alternativesOk: boolean; dishes: AltDish[] }

/**
 * Staff suggest a dish from another chef when the requested chef can't help: candidates (same city first, can they
 * cook it that day, allergens the request mentions), the dish's own options, and a quote at its listed price.
 */
function StaffAlternativeModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (r: Detail) => void }) {
  const { data, error } = useApi<Alternatives>(`/admin/chef-requests/${d.id}/alternatives`);
  const [pick, setPick] = useState<AltDish | null>(null);
  return (
    <Modal open onClose={onClose} title={pick ? `Offer ${pick.title}` : 'Suggest another chef’s dish'}>
      {error ? <Alert>{error}</Alert> : !data ? <Spinner /> : pick ? <StaffAltForm d={d} alt={pick} onBack={() => setPick(null)} onDone={onDone} /> : (
        <div className="space-y-3">
          <p className="text-sm text-ink-600">For {data.servings} serving{data.servings === 1 ? '' : 's'} on {dayLabel(data.requestedDate)}. The customer sees it as an alternative from the other chef, at that chef’s listed price; the chef confirms the order as usual.</p>
          {d.reason === 'ALLERGY' && <Alert tone="info">The customer mentioned an allergy. Check the dish’s allergens with its chef before offering it.</Alert>}
          {!data.dishes.length && <Alert tone="info">No other chef has a live dish right now.</Alert>}
          <ul className="max-h-[60vh] divide-y divide-ink-100 overflow-y-auto">
            {data.dishes.map((x) => {
              const ok = x.requestedDay?.status === 'AVAILABLE';
              return (
                <li key={x.id} className="flex items-start gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{x.title}</div>
                    <div className="text-xs text-ink-500">{money(x.priceCents)} per serving{x.chef.city ? ` · ${x.chef.city}` : ''}{x.sameCuisine ? ' · same cuisine' : ''}{x.mode === 'CUSTOMIZABLE' ? ' · customizable' : ''}</div>
                    <div className="mt-1 flex flex-wrap gap-1 text-xs">
                      <Badge tone={ok ? 'good' : 'warn'}>{ok ? `Open ${dayLabel(data.requestedDate)}` : `${dayLabel(data.requestedDate)}: ${(x.requestedDay?.status || 'unavailable').toLowerCase().replace(/_/g, ' ')}`}</Badge>
                      {!x.sameCity && <Badge tone="warn">Other city</Badge>}
                      {x.allergens.map((a) => <Badge key={a} tone={x.mentionedAllergens.includes(a) ? 'bad' : 'neutral'}>{pretty(a)}</Badge>)}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setPick(x)}>Choose</Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function StaffAltForm({ d, alt, onBack, onDone }: { d: Detail; alt: AltDish; onBack: () => void; onDone: (r: Detail) => void }) {
  const act = useAction();
  const { data: pub } = useApi<PublicChefDish>(`/public/chef-dishes/${alt.id}`);
  const groups = useMemo(() => pub?.groups || [], [pub]);
  const base = useMemo(() => ({ allergens: alt.allergens, dietaryTags: alt.dietaryTags }), [alt]);
  const { picks, setPicks, ev } = useCustomization(alt.dishName, groups, base);
  const customizable = groups.some((g) => g.selectionType !== 'INCLUDED');
  const [changes, setChanges] = useState(`${alt.title} instead of ${d.dish.title}.`);
  const [qty, setQty] = useState(d.servings);
  const [allergens, setAllergens] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<DateSlot | null>({ date: d.requestedDate, time: d.requestedTime || '' });
  const [fixTime, setFixTime] = useState(!!d.requestedTime);
  const [valid, setValid] = useState('48');
  const [note, setNote] = useState('');
  const { data: avail, loading } = useApi<ChefAvailability>(`/public/chef-dishes/${alt.id}/availability?quantity=${qty}`);
  const unit = alt.priceCents + ev.modifiersCents;
  const shown = allergens ?? ev.allergens;
  const submit = () => act.run(async () => {
    const r = await api.post<Detail>(`/admin/chef-requests/${d.id}/quote`, { kind: 'ALTERNATIVE', altDishId: alt.id, optionIds: ev.optionIds, changes, portionDesc: alt.portionDesc, unitPriceCents: unit, quantity: qty, allergens: shown, dietaryTags: ev.dietaryTags, serviceDate: slot!.date, serviceTime: fixTime && slot!.time ? slot!.time : null, note: note || null, validHours: Number(valid) });
    onDone(r);
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <button type="button" className="text-sm text-ink-500 hover:underline" onClick={onBack}>← Other dishes</button>
      <p className="text-sm text-ink-600">Prepared by {alt.chef.displayName}{alt.chef.city ? ` (${alt.chef.city})` : ''}. {alt.description}</p>
      {customizable && <DishCustomizer groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName={alt.chef.displayName} />}
      <Textarea label="What the customer gets (they see this)" value={changes} onChange={(e) => setChanges(e.target.value)} rows={3} maxLength={1000} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <div><div className="text-sm font-medium">Price per serving</div><div className="mt-1 text-lg font-semibold">{money(unit)}</div><div className="text-xs text-ink-500">The chef’s listed price for these options</div></div>
        <QtyStepper label="Servings" value={qty} min={1} max={50} onChange={setQty} />
      </div>
      <CustomizationSummary basePriceCents={alt.priceCents} ev={ev} qty={qty} baseAllergens={alt.allergens} compact />
      <div><div className="mb-1 text-sm font-medium">Allergens in the finished dish</div><ChipGroup name="allergens" values={shown} onChange={setAllergens} options={ALLERGENS.map((a) => ({ value: a, label: pretty(a) }))} /></div>
      {alt.mentionedAllergens.length > 0 && <Alert>The request mentions {alt.mentionedAllergens.map(pretty).join(', ')}, which this dish contains.</Alert>}
      <DateSlotPicker availability={avail ?? null} value={slot} onChange={setSlot} loading={loading} showTimes={fixTime} title="Cooking day" />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fixTime} onChange={(e) => setFixTime(e.target.checked)} /> Fix the time (otherwise the customer picks any time that day)</label>
      <Select label="Offer valid for" value={valid} onChange={(e) => setValid(e.target.value)}><option value="12">12 hours</option><option value="24">24 hours</option><option value="48">2 days</option><option value="72">3 days</option></Select>
      <Textarea label="Note to the customer (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      {act.error && <Alert>{act.error}</Alert>}
      <Button type="submit" className="w-full" disabled={act.busy || !ev.ok || !slot?.date || (fixTime && !slot.time) || changes.trim().length < 3}>{act.busy ? 'Sending…' : `Send to the customer — ${money(unit * qty)}`}</Button>
    </form>
  );
}
