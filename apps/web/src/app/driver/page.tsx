'use client';
import Link from 'next/link';
import { useState } from 'react';
import { COURIER_DOC_LABELS, type CourierDocKind } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Spinner, statusTone } from '@/components/ui';
import { CourierDocUpload, DocLink } from '@/components/courier-docs';

interface Job { id: string; status: string; pickupAddress: { line1: string }; dropoffAddress: { line1: string; instructions?: string }; tipCents: number; batchId: string | null; arrivedPickupAt: string | null; arrivedDropoffAt: string | null; requirements: string[]; exception: { kind: string; attempts: { at: string; method?: string }[]; waitUntil: string; resolution?: string } | null }
interface Standing { status: string; suspendedReason: string | null; appealStatus: string; appealDecisionNote: string | null; vehicleType: string; capabilities: string[]; missingDocs: string[]; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }

/** Web console for Gutad-fleet couriers (the mobile app is the primary surface). */
export default function DriverPage() {
  const { user } = useSession();
  const { data: me, error, reload } = useApi<{ id: string; status: string; isAvailable: boolean }>(user ? '/driver/me' : null);
  const { data: standing, reload: reloadStanding } = useApi<Standing>(me ? '/driver/standing' : null, { deps: [me?.id] });
  const { data: offers, reload: reloadOffers } = useApi<{ id: string; payCents: number; pickupAddress: { line1: string }; dropoffAddress: { line1: string }; expiresAt: string; batchWith: string | null; requirements: string[] }[]>(me ? '/driver/offers' : null, { poll: 5000, deps: [me?.id] });
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>(me ? '/driver/jobs' : null, { poll: 5000, deps: [me?.id] });
  const { data: earnings } = useApi<{ payableCents: number }>(me ? '/driver/earnings' : null, { deps: [me?.id] });
  const { run, error: actErr } = useAction();
  const [vehicle, setVehicle] = useState('Bike');
  if (!user) return <Alert tone="info">Please <Link className="underline" href="/account">sign in</Link> to drive with Gutad.</Alert>;
  if (error && !me) return <Card title="Apply to drive"><Input label="Vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} /><Button className="mt-2" onClick={() => api.post('/driver/apply', { vehicle }).then(reload)}>Apply</Button></Card>;
  if (!me) return <Spinner />;
  const loc = () => new Promise<{ lat: number; lng: number }>((res) => navigator.geolocation?.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({ lat: 40.73, lng: -73.99 })));
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reloadJobs(); await reloadOffers(); await reload(); await reloadStanding(); });
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {actErr && <Alert>{actErr}</Alert>}
      <Card title="Courier status" action={<Badge tone={statusTone(me.status)}>{me.status}</Badge>}>
        <div className="flex items-center justify-between"><span className="text-sm">Payable balance {money(earnings?.payableCents || 0)}</span>{me.status === 'APPROVED' && <Button variant={me.isAvailable ? 'secondary' : 'primary'} onClick={() => act(async () => { const l = await loc(); await api.post('/driver/availability', { isAvailable: !me.isAvailable, ...l }); })}>{me.isAvailable ? 'Go offline' : 'Go online'}</Button>}</div>
        {standing?.metrics && <p className="mt-2 text-xs text-ink-500">Last 30 days: acceptance {standing.metrics.acceptanceRate ?? '—'}% · completion {standing.metrics.completionRate ?? '—'}% · on time {standing.metrics.onTimeRate ?? '—'}% · {standing.metrics.delivered} delivered</p>}
        {standing?.status === 'SUSPENDED' && <Appeal standing={standing} onDone={() => void reloadStanding()} />}
      </Card>
      {standing && standing.missingDocs.length > 0 && <Alert tone="info">Upload and get approved: {standing.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind]).join(', ')}.</Alert>}
      <Card title="Offers">{offers?.length ? offers.map((o) => <div key={o.id} className="flex items-center justify-between border-b border-ink-100 py-2 text-sm"><span>{o.pickupAddress.line1} → {o.dropoffAddress.line1} · <b>{money(o.payCents)}</b>{o.batchWith && <Badge tone="info">adds to your current trip</Badge>}{o.requirements.includes('ALCOHOL') && <Badge tone="warn">ID check</Badge>} · expires {when(o.expiresAt)}</span><div className="flex gap-1"><Button size="sm" onClick={() => act(() => api.post(`/driver/offers/${o.id}`, { accept: true }))}>Accept</Button><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/driver/offers/${o.id}`, { accept: false }))}>Decline</Button></div></div>) : <p className="text-sm text-ink-500">No offers right now.</p>}</Card>
      <Card title="Active deliveries">{jobs?.length ? jobs.map((j) => (
        <div key={j.id} className="border-b border-ink-100 py-2 text-sm">
          <div className="flex justify-between"><span>{j.pickupAddress.line1} → {j.dropoffAddress.line1} · tip {money(j.tipCents)}{j.batchId && <Badge tone="info">batch</Badge>}</span><Badge tone={statusTone(j.status)}>{j.status}</Badge></div>
          {j.dropoffAddress.instructions && <p className="text-xs text-ink-500">“{j.dropoffAddress.instructions}”</p>}
          <div className="mt-1 flex flex-wrap gap-1">
            {j.status === 'ASSIGNED' && !j.arrivedPickupAt && <Button size="sm" variant="secondary" onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'PICKUP', ...(await loc()) }))}>Arrived at pickup</Button>}
            {j.status === 'ASSIGNED' && <Button size="sm" onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', ...(await loc()) }))}>Picked up</Button>}
            {j.status === 'PICKED_UP' && !j.arrivedDropoffAt && <Button size="sm" variant="secondary" onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF', ...(await loc()) }))}>Arrived</Button>}
            {j.status === 'PICKED_UP' && <Button size="sm" onClick={() => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: 'https://placehold.co/600x400?text=Handoff', ...(await loc()) }))}>Delivered (photo proof)</Button>}
          </div>
          {j.status === 'PICKED_UP' && <ExceptionBox job={j} onDone={() => void reloadJobs()} />}
        </div>
      )) : <p className="text-sm text-ink-500">No active deliveries.</p>}</Card>
      <Documents />
      <ShiftsCard />
    </div>
  );
}

/** 17.7 customer unreachable / wrong address: log attempts, wait for the timer, then return, dispose or leave safely. */
function ExceptionBox({ job, onDone }: { job: Job; onDone: () => void }) {
  const { run, error } = useAction();
  const [kind, setKind] = useState('CUSTOMER_UNREACHABLE');
  const ex = job.exception && !job.exception.resolution ? job.exception : null;
  const waiting = ex ? new Date(ex.waitUntil) > new Date() : false;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); onDone(); });
  return (
    <div className="mt-2 rounded-lg bg-ink-50 p-2">
      {error && <Alert>{error}</Alert>}
      {!ex ? (
        <div className="flex flex-wrap items-end gap-1"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="CUSTOMER_UNREACHABLE">Can’t reach the customer</option><option value="WRONG_ADDRESS">Wrong address</option><option value="ACCESS_PROBLEM">Can’t get in</option><option value="UNSAFE_LOCATION">Unsafe to deliver</option></Select><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception`, { kind, method: 'CALL' }))}>Report problem</Button></div>
      ) : (
        <div className="space-y-1 text-xs">
          <div><b>{ex.kind.toLowerCase().replace(/_/g, ' ')}</b> · {ex.attempts.length} attempt(s) · {waiting ? `keep trying until ${new Date(ex.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'wait time is over'}</div>
          <div className="flex flex-wrap gap-1">{['CALL', 'SMS', 'DOOR'].map((m) => <Button key={m} size="sm" variant="secondary" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception`, { kind: ex.kind, method: m }))}>Log {m.toLowerCase()}</Button>)}</div>
          {!waiting && <div className="flex flex-wrap gap-1"><Button size="sm" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'SAFE_PLACE', proofPhotoUrl: 'https://placehold.co/600x400?text=Left+safely' }))}>Leave safely (photo)</Button><Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'RETURN' }))}>Return to restaurant</Button><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/driver/jobs/${job.id}/exception/resolve`, { resolution: 'DISPOSE' }))}>Dispose</Button></div>}
        </div>
      )}
    </div>
  );
}

function Appeal({ standing, onDone }: { standing: Standing; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { run, error } = useAction();
  return (
    <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
      <p>Your account is suspended: {standing.suspendedReason}</p>
      {standing.appealStatus === 'PENDING' && <p className="text-xs text-ink-500">Your appeal is being reviewed by someone who wasn’t involved in the suspension.</p>}
      {standing.appealDecisionNote && <p className="text-xs text-ink-500">Decision: {standing.appealDecisionNote}</p>}
      {standing.appealStatus !== 'PENDING' && <><Input className="mt-2" placeholder="Tell us what happened (at least 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} />{error && <Alert>{error}</Alert>}<Button className="mt-1" size="sm" disabled={note.length < 10} onClick={() => run(async () => { await api.post('/driver/appeal', { note }); onDone(); })}>Send appeal</Button></>}
    </div>
  );
}

function Documents() {
  const { data, reload } = useApi<{ id: string; kind: string; status: string; expiresAt: string | null; reviewNote: string | null; fileUrl: string; fileId: string | null }[]>('/driver/documents');
  return (
    <Card title="Documents">
      {data?.map((d) => <div key={d.id} className="flex justify-between text-sm"><span><DocLink doc={d} label={COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind} />{d.expiresAt ? ` · expires ${when(d.expiresAt)}` : ''}{d.reviewNote && d.status === 'REJECTED' ? ` · ${d.reviewNote}` : ''}</span><Badge tone={statusTone(d.status)}>{d.status}</Badge></div>)}
      <CourierDocUpload onDone={() => void reload()} />
    </Card>
  );
}

function ShiftsCard() {
  const { data, reload } = useApi<{ id: string; startsAt: string; endsAt: string }[]>('/driver/shifts');
  const { run, error } = useAction();
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), from: '17:00', to: '21:00' });
  return (
    <Card title="My shifts">
      {error && <Alert>{error}</Alert>}
      {data?.map((s) => <div key={s.id} className="flex justify-between text-sm"><span>{when(s.startsAt)} – {new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/driver/shifts/${s.id}`); await reload(); })}>Cancel</button></div>)}
      {!data?.length && <p className="text-sm text-ink-500">No shifts booked.</p>}
      <div className="mt-2 flex flex-wrap items-end gap-2"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /><Input label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /><Button size="sm" onClick={() => run(async () => { await api.post('/driver/shifts', { startsAt: new Date(`${f.date}T${f.from}`).toISOString(), endsAt: new Date(`${f.date}T${f.to}`).toISOString() }); await reload(); })}>Add shift</Button></div>
    </Card>
  );
}
