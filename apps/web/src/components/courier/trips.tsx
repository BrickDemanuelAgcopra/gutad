'use client';
import { useState } from 'react';
import { GutadApiError, TRIP_ISSUES, type Manifest, type PickupCheck, type Readiness, type TripIssue } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { Alert, Badge, Button, Input, Select, statusTone } from '@/components/ui';
import { errCode, friendlyError, getLoc, humanize, PhotoCapture, useCourierAction, useNow, type UploadedPhoto } from './common';

export interface Offer {
  id: string; deliveryJobId: string; expiresAt: string; payCents: number; pay: { baseCents: number; distanceCents: number; timeCents: number; totalCents: number; incentiveCents?: number; incentives?: { campaignId: string; name: string; cents: number }[] }; tipCents: number;
  stops: number; pickup: { name: string; line1: string; city: string }; dropoffArea: { city: string; postalCode: string }; distanceKm: number; toPickupKm: number; estMinutes: number;
  requirements: string[]; equipment: string[]; policy: { version: number; waitingGraceMinutes: number; waitingPerMinuteCents: number; returnCents: number; cancelAfterArrivalCents: number; waitingCapMinutes?: number; dropoffGraceMinutes?: number }; batchWith: string | null;
  readiness?: Readiness | null; manifest?: Manifest | null; market?: { id: string; name: string } | null;
}

export interface Job {
  id: string; status: string; pickupAddress: { line1: string; name?: string }; dropoffAddress: { line1: string; instructions?: string }; tipCents: number; batchId: string | null;
  arrivedPickupAt: string | null; arrivedDropoffAt: string | null; requirements: string[];
  exception: { kind: string; attempts: { at: string; method?: string }[]; waitUntil: string; resolution?: string } | null;
  pickupCheck?: PickupCheck & { at?: string } | null; custody?: unknown; payPolicy?: unknown;
  issues?: { kind: string; note?: string | null; at?: string; outcome?: string }[]; requiresIdCheck?: boolean; pinRequired?: boolean; orderCode?: string | null;
  readiness?: Readiness | null; manifest?: Manifest | null; shelfSlot?: string | null;
}

const km = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 10) / 10} km`);
const hhmm = (d: string) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const itemCount = (b: Manifest['brands'][number]) => b.items.reduce((t, i) => t + i.quantity, 0);

/** "Ready now" once the kitchen marks it ready, else the kitchen's estimate. */
export function ReadyChip({ readiness: r }: { readiness?: Readiness | null }) {
  if (!r) return null;
  if (r.status === 'READY') return <Badge tone="good">Ready now</Badge>;
  return <Badge>{r.estReadyAt ? `Ready ~${hhmm(r.estReadyAt)}` : 'Being prepared'}</Badge>;
}

/** One line per brand in the order ("Smash Society · 1 item · 2 bags") and the total bags. */
export function ManifestList({ manifest: m }: { manifest?: Manifest | null }) {
  if (!m || !m.brands.length) return null;
  return (
    <div className="mt-1 text-xs">
      {m.brands.length > 1 && <ul className="space-y-0.5">{m.brands.map((b) => <li key={b.brandKey}>{b.brandName} · {plural(itemCount(b), 'item')} · {plural(b.bagCount, 'bag')}</li>)}</ul>}
      <div className="text-ink-500">{m.brands.length > 1 ? `${m.brands.length} brands · ` : ''}{plural(m.totals.bags, 'bag')} in total</div>
    </div>
  );
}

export function OfferCard({ offer: o, onAnswer }: { offer: Offer; onAnswer: (accept: boolean) => Promise<unknown> }) {
  const now = useNow();
  const left = Math.max(0, Math.round((new Date(o.expiresAt).getTime() - now) / 1000));
  const { run, error, busy } = useCourierAction();
  const pay = o.pay || { baseCents: o.payCents, distanceCents: 0, timeCents: 0, totalCents: o.payCents };
  const p = o.policy;
  return (
    <div className="rounded-xl border border-ink-100 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xl font-bold">{money(pay.totalCents)} <span className="text-xs font-normal text-ink-500">guaranteed</span></div>
          <div className="text-xs text-ink-500">base {money(pay.baseCents)} + distance {money(pay.distanceCents)}{pay.timeCents ? ` + time ${money(pay.timeCents)}` : ''}</div>
          {(pay.incentiveCents ?? 0) > 0 && <div className="text-xs font-semibold text-brand-700">+ {money(pay.incentiveCents!)} {pay.incentives?.map((i) => i.name).join(', ') || 'boost'}</div>}
          {o.tipCents > 0 && <div className="text-xs text-emerald-700">+ estimated tip {money(o.tipCents)}</div>}
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${left <= 15 ? 'bg-red-100 text-red-800' : 'bg-ink-100 text-ink-700'}`}>{left > 0 ? `${left}s` : 'expired'}</span>
      </div>
      <div className="mt-2 space-y-0.5">
        <div><b>Pickup:</b> {o.pickup.name}, {o.pickup.line1}</div>
        <div><b>Drop-off area:</b> {o.dropoffArea.city} {o.dropoffArea.postalCode}</div>
        <div className="text-xs text-ink-500">{o.stops} stop{o.stops === 1 ? '' : 's'} · {km(o.toPickupKm)} to pickup · {km(o.distanceKm)} trip · about {o.estMinutes} min{o.market ? ` · ${o.market.name}` : ''}</div>
      </div>
      <ManifestList manifest={o.manifest} />
      <div className="mt-1 flex flex-wrap gap-1">
        <ReadyChip readiness={o.readiness} />
        {o.batchWith && <Badge tone="info">adds to your current trip</Badge>}
        {o.requirements.map((r) => <Badge key={r} tone="warn">{r === 'ALCOHOL' ? 'ID check' : humanize(r)}</Badge>)}
        {o.equipment.map((e) => <Badge key={e}>{humanize(e)}</Badge>)}
      </div>
      {p && <p className="mt-1 text-xs text-ink-500">Waiting paid after {p.waitingGraceMinutes} min at pickup{p.dropoffGraceMinutes != null ? ` and ${p.dropoffGraceMinutes} min at drop-off` : ''} ({money(p.waitingPerMinuteCents)}/min{p.waitingCapMinutes ? `, up to ${p.waitingCapMinutes} min` : ''}) · returning an order {money(p.returnCents)} · canceled after you arrive {money(p.cancelAfterArrivalCents)}</p>}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <div className="mt-2 flex gap-2"><Button size="sm" disabled={busy || left <= 0} onClick={() => run(() => onAnswer(true))}>Accept</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => onAnswer(false))}>Decline</Button></div>
    </div>
  );
}

/** One active trip: arrive, pickup check, drop-off proof, problems and release. */
export function JobCard({ job: j, onChange }: { job: Job; onChange: () => Promise<void> }) {
  const { run, error, busy } = useCourierAction();
  const [msg, setMsg] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => run(async () => { setMsg(null); await fn(); await onChange(); });
  return (
    <div className="space-y-2 border-b border-ink-100 py-3 text-sm last:border-0">
      <div className="flex justify-between gap-2"><span>{j.pickupAddress.name ? `${j.pickupAddress.name}, ` : ''}{j.pickupAddress.line1} → {j.dropoffAddress.line1} · tip {money(j.tipCents)}{j.batchId && <Badge tone="info">batch</Badge>}{j.requiresIdCheck && <Badge tone="warn">ID check</Badge>}</span><Badge tone={statusTone(j.status)}>{humanize(j.status)}</Badge></div>
      {j.status === 'ASSIGNED' && (j.readiness || j.shelfSlot) && <div className="flex flex-wrap items-center gap-1"><ReadyChip readiness={j.readiness} />{j.shelfSlot && <Badge tone="info">Shelf {j.shelfSlot}</Badge>}</div>}
      {j.status === 'ASSIGNED' && <ManifestList manifest={j.manifest} />}
      {j.dropoffAddress.instructions && <p className="text-xs text-ink-500">“{j.dropoffAddress.instructions}”</p>}
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="info">{msg}</Alert>}
      {j.status === 'ASSIGNED' && !j.arrivedPickupAt && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'PICKUP', ...(await getLoc()) }))}>Arrived at pickup</Button>}
      {j.status === 'ASSIGNED' && j.arrivedPickupAt && j.manifest && j.manifest.brands.length > 1 && <MultiBrandPickupForm job={j} manifest={j.manifest} onSubmit={async (pickupCheck) => { setMsg(null); await api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', pickupCheck, ...(await getLoc()) }); await onChange(); }} />}
      {j.status === 'ASSIGNED' && j.arrivedPickupAt && !(j.manifest && j.manifest.brands.length > 1) && <PickupForm job={j} busy={busy} onSubmit={(pickupCheck) => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', pickupCheck, ...(await getLoc()) }))} />}
      {j.status === 'PICKED_UP' && !j.arrivedDropoffAt && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF', ...(await getLoc()) }))}>Arrived at drop-off</Button>}
      {j.status === 'PICKED_UP' && j.arrivedDropoffAt && <HandoffForm job={j} busy={busy} onSubmit={(body) => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', ...body, ...(await getLoc()) }))} />}
      {j.status === 'PICKED_UP' && <ExceptionBox job={j} onDone={() => void onChange()} />}
      {!!j.issues?.length && <ul className="text-xs text-ink-500">{j.issues.map((x, i) => <li key={i}>{TRIP_ISSUES[x.kind as TripIssue]?.label || humanize(x.kind)}{x.at ? ` · ${when(x.at)}` : ''}{x.outcome ? ` — ${x.outcome}` : ''}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <IssueMenu job={j} onReported={async (outcome) => { setMsg(outcome); await onChange(); }} />
        {j.status === 'ASSIGNED' && <Release job={j} onDone={onChange} />}
      </div>
    </div>
  );
}

function PickupForm({ job, busy, onSubmit }: { job: Job; busy: boolean; onSubmit: (c: PickupCheck) => void }) {
  const [f, setF] = useState({ orderCode: '', bagCount: '1', drinkCount: '0', sealIntact: false, note: '' });
  const codeMismatch = !!job.orderCode && f.orderCode.length > 0 && f.orderCode.trim().toUpperCase() !== job.orderCode.toUpperCase();
  const bags = Number(f.bagCount);
  return (
    <div className="rounded-lg bg-ink-50 p-3">
      <p className="mb-2 font-medium">Pickup check</p>
      {job.orderCode && <p className="mb-2 text-xs text-ink-500">The order code on the bag should end in <b className="text-ink-900">{job.orderCode}</b>.</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        <Input label="Order code" value={f.orderCode} onChange={(e) => setF({ ...f, orderCode: e.target.value })} />
        <Input label="Bags" type="number" min={1} value={f.bagCount} onChange={(e) => setF({ ...f, bagCount: e.target.value })} />
        <Input label="Drinks" type="number" min={0} value={f.drinkCount} onChange={(e) => setF({ ...f, drinkCount: e.target.value })} />
      </div>
      {codeMismatch && <p className="mt-1 text-xs text-red-700">That code doesn’t match this order. Check you have the right bag.</p>}
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={f.sealIntact} onChange={(e) => setF({ ...f, sealIntact: e.target.checked })} /> Every bag is sealed and the seals are intact</label>
      <Input className="mt-2" label="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <Button className="mt-2" size="sm" disabled={busy || codeMismatch || !(bags >= 1)} onClick={() => onSubmit({ orderCode: f.orderCode.trim() || undefined, bagCount: bags, drinkCount: Number(f.drinkCount) || 0, sealIntact: f.sealIntact, note: f.note.trim() || undefined })}>Picked up</Button>
      {!f.sealIntact && <p className="mt-1 text-xs text-ink-500">If a seal is broken, don’t take the order: use “Report a problem”.</p>}
    </div>
  );
}

/** Courier R2: an order from several brands is checked brand by brand (bags counted, seal intact). */
function MultiBrandPickupForm({ job, manifest, onSubmit }: { job: Job; manifest: Manifest; onSubmit: (c: PickupCheck) => Promise<void> }) {
  const [f, setF] = useState({ orderCode: '', drinkCount: '0', note: '' });
  const [brands, setBrands] = useState<Record<string, { bags: string; sealIntact: boolean }>>(() => Object.fromEntries(manifest.brands.map((b) => [b.brandKey, { bags: String(b.bagCount), sealIntact: false }])));
  const [flags, setFlags] = useState<Record<string, 'missing' | 'broken'>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeMismatch = !!job.orderCode && f.orderCode.length > 0 && f.orderCode.trim().toUpperCase() !== job.orderCode.toUpperCase();
  const seen = manifest.brands.map((b) => ({ brandKey: b.brandKey, bagCount: Math.max(0, Math.floor(Number(brands[b.brandKey]?.bags) || 0)), sealIntact: !!brands[b.brandKey]?.sealIntact }));
  const total = seen.reduce((t, b) => t + b.bagCount, 0);
  const setBrand = (key: string, patch: Partial<{ bags: string; sealIntact: boolean }>) => {
    setBrands({ ...brands, [key]: { ...brands[key], ...patch } });
    if (flags[key]) setFlags(Object.fromEntries(Object.entries(flags).filter(([k]) => k !== key)));
  };
  const submit = async () => {
    setBusy(true); setError(null); setFlags({});
    try {
      await onSubmit({ orderCode: f.orderCode.trim() || undefined, bagCount: total, drinkCount: Number(f.drinkCount) || 0, sealIntact: seen.every((b) => b.sealIntact), note: f.note.trim() || undefined, brands: seen });
    } catch (e) {
      const code = errCode(e);
      const body = (e instanceof GutadApiError ? e.body : null) as unknown as { missing?: string[]; broken?: string[] } | null;
      if (code === 'MANIFEST_INCOMPLETE') {
        setFlags(Object.fromEntries((body?.missing ?? []).map((k) => [k, 'missing' as const])));
        setError('Some bags are missing. Collect every brand’s bags before you leave.');
      } else if (code === 'SEAL_BROKEN') {
        const broken = body?.broken?.length ? body.broken : seen.filter((b) => !b.sealIntact).map((b) => b.brandKey);
        setFlags(Object.fromEntries(broken.map((k) => [k, 'broken' as const])));
        setError('A seal is broken, so you can’t take this order. Report “Damaged packaging or broken seal” below.');
      } else setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg bg-ink-50 p-3">
      <p className="mb-1 font-medium">Pickup check</p>
      <p className="mb-2 text-xs text-ink-500">This order comes from {manifest.brands.length} brands. Count each brand’s bags and check its seal.</p>
      {job.orderCode && <p className="mb-2 text-xs text-ink-500">The order code on the bag should end in <b className="text-ink-900">{job.orderCode}</b>.</p>}
      <div className="space-y-2">
        {manifest.brands.map((b) => {
          const v = brands[b.brandKey] || { bags: '0', sealIntact: false };
          const flag = flags[b.brandKey];
          return (
            <div key={b.brandKey} className={`rounded-lg border bg-white p-2 ${flag ? 'border-red-300 ring-1 ring-red-200' : 'border-ink-100'}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-1"><b>{b.brandName}</b><span className="text-xs text-ink-500">#{b.orderNumber} · {plural(itemCount(b), 'item')} · {plural(b.bagCount, 'bag')}</span></div>
              {b.bagCodes.length > 0 && <p className="text-xs text-ink-500">Bag labels: {b.bagCodes.join(', ')}</p>}
              <div className="mt-1 flex flex-wrap items-end gap-3">
                <Input className="w-24" label="Bags counted" type="number" min={0} value={v.bags} onChange={(e) => setBrand(b.brandKey, { bags: e.target.value })} />
                <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={v.sealIntact} onChange={(e) => setBrand(b.brandKey, { sealIntact: e.target.checked })} /> Seal intact</label>
              </div>
              {flag === 'missing' && <p className="mt-1 text-xs font-medium text-red-700">Collect this brand’s bags.</p>}
              {flag === 'broken' && <p className="mt-1 text-xs font-medium text-red-700">Seal broken: don’t take it. Report damaged packaging below.</p>}
            </div>
          );
        })}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Input label="Order code" value={f.orderCode} onChange={(e) => setF({ ...f, orderCode: e.target.value })} />
        <Input label="Drinks" type="number" min={0} value={f.drinkCount} onChange={(e) => setF({ ...f, drinkCount: e.target.value })} />
      </div>
      {codeMismatch && <p className="mt-1 text-xs text-red-700">That code doesn’t match this order. Check you have the right bag.</p>}
      <Input className="mt-2" label="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <p className="mt-2 text-xs text-ink-500">{plural(total, 'bag')} counted of {manifest.totals.bags}.</p>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <Button className="mt-2" size="sm" disabled={busy || codeMismatch || total < 1} onClick={() => void submit()}>Picked up</Button>
      {seen.some((b) => !b.sealIntact) && <p className="mt-1 text-xs text-ink-500">Tick “Seal intact” for each brand. If a seal is broken, don’t take the order: use “Report a problem”.</p>}
    </div>
  );
}

type Method = 'PHOTO' | 'PIN' | 'SIGNATURE';
function HandoffForm({ job, busy, onSubmit }: { job: Job; busy: boolean; onSubmit: (b: Record<string, unknown>) => void }) {
  const [method, setMethod] = useState<Method>(job.pinRequired ? 'PIN' : 'PHOTO');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [idChecked, setIdChecked] = useState(false);
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const ready = ((method === 'PHOTO' && !!photo) || (method === 'PIN' && pin.length >= 4) || (method === 'SIGNATURE' && name.trim().length >= 2)) && (!job.requiresIdCheck || idChecked);
  const body = () => ({ ...(method === 'PHOTO' ? { proofPhotoUrl: photo!.url } : method === 'PIN' ? { handoffPin: pin } : { proofSignature: name.trim() }), ...(job.requiresIdCheck ? { idChecked } : {}) });
  const methods: Method[] = job.pinRequired ? ['PIN'] : ['PHOTO', 'PIN', 'SIGNATURE'];
  return (
    <div className="rounded-lg bg-ink-50 p-3">
      <p className="mb-2 font-medium">Complete the handoff</p>
      {job.pinRequired && <p className="mb-2 text-xs text-ink-500">This order needs the customer’s PIN. They can see it in their Gutad order.</p>}
      <div className="flex flex-wrap gap-3">{methods.map((m) => <label key={m} className="flex items-center gap-1"><input type="radio" name={`m-${job.id}`} checked={method === m} onChange={() => setMethod(m)} /> {m === 'PHOTO' ? 'Photo' : m === 'PIN' ? 'Customer PIN' : 'Signature'}</label>)}</div>
      {method === 'PIN' && <Input className="mt-2" label="PIN" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />}
      {method === 'SIGNATURE' && <Input className="mt-2" label="Name of the person who received it" value={name} onChange={(e) => setName(e.target.value)} />}
      {method === 'PHOTO' && <div className="mt-2"><p className="mb-1 text-xs text-ink-500">Take a clear photo of the order at the door, with the door number in view if you can.</p><PhotoCapture purpose="HANDOFF" label="Take handoff photo" value={photo} onChange={setPhoto} /></div>}
      {job.requiresIdCheck && <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={idChecked} onChange={(e) => setIdChecked(e.target.checked)} /> I checked the customer’s ID and they are old enough</label>}
      <Button className="mt-2" size="sm" disabled={busy || !ready} onClick={() => onSubmit(body())}>Delivered</Button>
    </div>
  );
}

function IssueMenu({ job, onReported }: { job: Job; onReported: (outcome: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const stage = job.status === 'ASSIGNED' ? 'PICKUP' : job.status === 'PICKED_UP' ? 'DROPOFF' : null;
  const kinds = (Object.keys(TRIP_ISSUES) as TripIssue[]).filter((k) => TRIP_ISSUES[k].stage === 'ANY' || TRIP_ISSUES[k].stage === stage);
  const [kind, setKind] = useState<TripIssue>(kinds[0]);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const { run, error, busy } = useCourierAction();
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Report a problem</Button>;
  const k = kinds.includes(kind) ? kind : kinds[0];
  return (
    <div className="w-full rounded-lg border border-ink-100 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Select label="What happened?" value={k} onChange={(e) => setKind(e.target.value as TripIssue)}>{kinds.map((x) => <option key={x} value={x}>{TRIP_ISSUES[x].label}</option>)}</Select>
        <Input label="Details (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-1"><Button size="sm" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ outcome: string }>(`/driver/jobs/${job.id}/issue`, { kind: k, note: note.trim() || undefined, photoUrl: photo?.url }); setOpen(false); setNote(''); setPhoto(null); await onReported(r.outcome); })}>Send</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      </div>
      <div className="mt-2"><PhotoCapture purpose="ISSUE" label="Add a photo (optional)" value={photo} onChange={setPhoto} /></div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}

function Release({ job, onDone }: { job: Job; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { run, error, busy } = useCourierAction();
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Release this delivery</Button>;
  return (
    <div className="w-full rounded-lg border border-ink-100 p-3">
      <p className="text-xs text-ink-500">The delivery goes back to other couriers. Releasing often affects your completion rate.</p>
      <div className="mt-1 flex flex-wrap items-end gap-2"><Input label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} /><Button size="sm" variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => run(async () => { await api.post(`/driver/jobs/${job.id}/release`, { reason: reason.trim() }); await onDone(); })}>Release</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Keep it</Button></div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}

/** 17.7 customer unreachable / wrong address: log attempts, wait for the timer, then return, dispose or leave safely. */
function ExceptionBox({ job, onDone }: { job: Job; onDone: () => void }) {
  const { run, error } = useCourierAction();
  const [kind, setKind] = useState('CUSTOMER_UNREACHABLE');
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const ex = job.exception && !job.exception.resolution ? job.exception : null;
  const waiting = ex ? new Date(ex.waitUntil) > new Date() : false;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); onDone(); });
  return (
    <div className="rounded-lg bg-ink-50 p-2">
      {error && <Alert>{error}</Alert>}
      {!ex ? (
        <div className="flex flex-wrap items-end gap-1"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="CUSTOMER_UNREACHABLE">Can’t reach the customer</option><option value="WRONG_ADDRESS">Wrong address</option><option value="ACCESS_PROBLEM">Can’t get in</option><option value="UNSAFE_LOCATION">Unsafe to deliver</option></Select><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception`, { kind, method: 'CALL' }))}>Report at drop-off</Button></div>
      ) : (
        <div className="space-y-1 text-xs">
          <div><b>{humanize(ex.kind)}</b> · {ex.attempts.length} attempt(s) · {waiting ? `keep trying until ${new Date(ex.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'wait time is over'}</div>
          <div className="flex flex-wrap gap-1">{['CALL', 'SMS', 'DOOR'].map((m) => <Button key={m} size="sm" variant="secondary" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception`, { kind: ex.kind, method: m }))}>Log {m.toLowerCase()}</Button>)}</div>
          {!waiting && <PhotoCapture purpose="SAFE_PLACE" label="Photo of where you left it" value={photo} onChange={setPhoto} />}
          {!waiting && <div className="flex flex-wrap gap-1"><Button size="sm" disabled={!photo} onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'SAFE_PLACE', proofPhotoUrl: photo!.url }))}>Leave safely</Button><Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'RETURN' }))}>Return to restaurant</Button><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'DISPOSE' }))}>Dispose</Button></div>}
        </div>
      )}
    </div>
  );
}
