'use client';
import { useState } from 'react';
import { COURIER_DOC_LABELS, DEFAULT_AVAILABILITY, LIFECYCLE_LABELS, NOT_DISPATCHABLE_LABELS, type CourierDocKind, type LifecycleStatus } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, statusTone } from '@/components/ui';
import { CourierDocUpload, DocLink } from '@/components/courier-docs';
import { getLoc, lifecycleTone, minutes, useCourierAction } from './common';

export interface CourierStatus {
  dispatchable: boolean; reasons: string[]; isAvailable: boolean; mode: 'ON_DEMAND' | 'RESERVED'; onBreak: boolean; finishAfterCurrent: boolean; onlineSince: string | null; activeJobs: number;
  firstDeliveryAt: string | null; lifecycleStatus: LifecycleStatus | null; applicationStatus: string;
  today: { onlineMinutes: number; breakMinutes: number; activeMinutes: number; waitingMinutes: number; deliveries: number; earningsCents: number };
}
export interface Standing { status: string; suspendedReason: string | null; appealStatus: string; appealDecisionNote: string | null; vehicleType: string; capabilities: string[]; missingDocs: string[]; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }

const Toggle = ({ on, label, hint, disabled, onClick }: { on: boolean; label: string; hint?: string; disabled?: boolean; onClick: () => void }) => (
  <button disabled={disabled} onClick={onClick} className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-100 px-3 py-2 text-left text-sm disabled:opacity-50">
    <span><span className="font-medium">{label}</span>{hint && <span className="block text-xs text-ink-500">{hint}</span>}</span>
    <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand-500' : 'bg-ink-100'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? 'left-[22px]' : 'left-0.5'}`} /></span>
  </button>
);

/** Online / break / finish toggles, why offers are not coming, and today’s totals. */
export function StatusCard({ status, standing, onChange }: { status: CourierStatus; standing: Standing | null; onChange: () => Promise<void> }) {
  const { run, error, busy } = useCourierAction();
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await onChange(); });
  const lc = status.lifecycleStatus;
  const canWork = !lc || lc === 'ACTIVE' || lc === 'RESTRICTED';
  const reasons = status.reasons.filter((r) => !(r === 'OFFLINE' && !status.isAvailable));
  return (
    <Card title="Today" action={<span className="flex gap-1">{lc && <Badge tone={lifecycleTone(lc)}>{LIFECYCLE_LABELS[lc]}</Badge>}<Badge tone={status.dispatchable ? 'good' : status.isAvailable ? 'warn' : 'neutral'}>{status.dispatchable ? 'receiving offers' : status.isAvailable ? 'online, no offers' : 'offline'}</Badge></span>}>
      {error && <div className="mb-2"><Alert>{error}</Alert></div>}
      <div className="grid gap-2 sm:grid-cols-3">
        <Toggle on={status.isAvailable} disabled={busy || !canWork} label={status.isAvailable ? 'Online' : 'Offline'} hint={status.isAvailable ? `${status.mode === 'RESERVED' ? 'Reserved shift' : 'On demand'}${status.onlineSince ? ` since ${new Date(status.onlineSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Go online to get offers'}
          onClick={() => act(async () => api.post('/driver/availability', { isAvailable: !status.isAvailable, mode: 'ON_DEMAND', ...(await getLoc()) }))} />
        <Toggle on={status.onBreak} disabled={busy || !status.isAvailable} label="Break" hint={status.onBreak ? 'No new offers until you’re back' : 'Pause new offers'} onClick={() => act(() => api.post('/driver/break', { on: !status.onBreak }))} />
        <Toggle on={status.finishAfterCurrent} disabled={busy || !status.isAvailable} label="Stop after this delivery" hint="Go offline when your current trips are done" onClick={() => act(() => api.post('/driver/finish-after-current', { on: !status.finishAfterCurrent }))} />
      </div>
      {reasons.length > 0 && status.isAvailable && !status.dispatchable && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm"><p className="font-medium">Why you’re not getting offers</p><ul className="list-disc pl-5">{reasons.map((r) => <li key={r}>{NOT_DISPATCHABLE_LABELS[r] || r}</li>)}</ul></div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-6">
        {([['Online', minutes(status.today.onlineMinutes)], ['Active', minutes(status.today.activeMinutes)], ['Waiting', minutes(status.today.waitingMinutes)], ['Break', minutes(status.today.breakMinutes)], ['Deliveries', status.today.deliveries], ['Earned', money(status.today.earningsCents)]] as const).map(([l, v]) => <div key={l} className="rounded-lg bg-ink-50 p-2"><div className="text-xs text-ink-500">{l}</div><div className="font-semibold">{v}</div></div>)}
      </div>
      {standing?.metrics && <p className="mt-2 text-xs text-ink-500">Last 30 days: acceptance {standing.metrics.acceptanceRate ?? '—'}% · completion {standing.metrics.completionRate ?? '—'}% · on time {standing.metrics.onTimeRate ?? '—'}% · {standing.metrics.delivered} delivered</p>}
      {standing?.status === 'SUSPENDED' && <Appeal standing={standing} onDone={() => void onChange()} />}
      {lc === 'DEACTIVATED' && <Reactivation onDone={() => void onChange()} />}
      {lc === 'REACTIVATION_PENDING' && <div className="mt-3"><Alert tone="info">We’re reviewing your reactivation request.</Alert></div>}
      {lc && !canWork && lc !== 'DEACTIVATED' && lc !== 'REACTIVATION_PENDING' && standing?.status !== 'SUSPENDED' && <div className="mt-3"><Alert tone="info">Your account is {LIFECYCLE_LABELS[lc].toLowerCase()}. You can’t go online right now.</Alert></div>}
    </Card>
  );
}

function Appeal({ standing, onDone }: { standing: Standing; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { run, error } = useCourierAction();
  return (
    <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
      <p>Your account is suspended: {standing.suspendedReason}</p>
      {standing.appealStatus === 'PENDING' && <p className="text-xs text-ink-500">Your appeal is being reviewed by someone who wasn’t involved in the suspension.</p>}
      {standing.appealDecisionNote && <p className="text-xs text-ink-500">Decision: {standing.appealDecisionNote}</p>}
      {standing.appealStatus !== 'PENDING' && <><Input className="mt-2" placeholder="Tell us what happened (at least 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} />{error && <Alert>{error}</Alert>}<Button className="mt-1" size="sm" disabled={note.length < 10} onClick={() => run(async () => { await api.post('/driver/appeal', { note }); onDone(); })}>Send appeal</Button></>}
    </div>
  );
}

function Reactivation({ onDone }: { onDone: () => void }) {
  const [note, setNote] = useState('');
  const { run, error, busy } = useCourierAction();
  return (
    <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
      <p>Your account is deactivated. You can ask us to reactivate it.</p>
      <Input className="mt-2" placeholder="Anything we should know (at least 10 characters)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <Alert>{error}</Alert>}
      <Button className="mt-1" size="sm" disabled={busy || note.trim().length < 10} onClick={() => run(async () => { await api.post('/driver/reactivation', { note: note.trim() }); onDone(); })}>Request reactivation</Button>
    </div>
  );
}

/** Shown until the courier’s first completed delivery. */
export function FirstDeliveryGuide() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="rounded-2xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-900">
      <div className="flex items-start justify-between"><p className="font-semibold">Your first delivery</p><button className="text-xs underline" onClick={() => setOpen(false)}>Hide</button></div>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        <li>Go to the pickup and tap <b>Arrived at pickup</b>.</li>
        <li>Check the order code, count the bags and drinks, and make sure every seal is intact.</li>
        <li>Confirm the pickup in the app. If something is wrong, report it before you leave.</li>
        <li>Follow the customer’s delivery instructions.</li>
        <li>Complete the handoff with the proof the order asks for (photo, PIN, signature or ID check).</li>
      </ol>
    </div>
  );
}

export function Documents() {
  const { data, reload } = useApi<{ id: string; kind: string; status: string; expiresAt: string | null; reviewNote: string | null; fileUrl: string; fileId: string | null }[]>('/driver/documents');
  return (
    <Card title="Documents">
      {data?.map((d) => <div key={d.id} className="flex justify-between text-sm"><span><DocLink doc={d} label={COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind} />{d.expiresAt ? ` · expires ${when(d.expiresAt)}` : ''}{d.reviewNote && d.status === 'REJECTED' ? ` · ${d.reviewNote}` : ''}</span><Badge tone={statusTone(d.status)}>{d.status}</Badge></div>)}
      <CourierDocUpload onDone={() => void reload()} />
    </Card>
  );
}

export function ShiftsCard({ onCheckedIn }: { onCheckedIn?: () => void }) {
  const { data, reload } = useApi<{ id: string; startsAt: string; endsAt: string; status?: string; checkedInAt?: string | null }[]>('/driver/shifts');
  const { run, error } = useCourierAction();
  const [f, setF] = useState({ date: new Date().toISOString().slice(0, 10), from: '17:00', to: '21:00' });
  const now = Date.now();
  const inWindow = (s: { startsAt: string; endsAt: string }) => now >= new Date(s.startsAt).getTime() - DEFAULT_AVAILABILITY.checkInEarlyMinutes * 60_000 && now < new Date(s.endsAt).getTime();
  return (
    <Card title="My shifts">
      {error && <Alert>{error}</Alert>}
      {data?.map((s) => {
        const checkedIn = s.status === 'CHECKED_IN' || !!s.checkedInAt;
        return (
          <div key={s.id} className="flex items-center justify-between gap-2 py-0.5 text-sm">
            <span>{when(s.startsAt)} – {new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{checkedIn && <Badge tone="good">checked in</Badge>}</span>
            <span className="flex items-center gap-2">
              {!checkedIn && inWindow(s) && <Button size="sm" onClick={() => run(async () => { await api.post(`/driver/shifts/${s.id}/check-in`, await getLoc()); await reload(); onCheckedIn?.(); })}>Check in</Button>}
              {!checkedIn && <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/driver/shifts/${s.id}`); await reload(); })}>Cancel</button>}
            </span>
          </div>
        );
      })}
      {!data?.length && <p className="text-sm text-ink-500">No shifts booked.</p>}
      <div className="mt-2 flex flex-wrap items-end gap-2"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /><Input label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /><Button size="sm" onClick={() => run(async () => { await api.post('/driver/shifts', { startsAt: new Date(`${f.date}T${f.from}`).toISOString(), endsAt: new Date(`${f.date}T${f.to}`).toISOString() }); await reload(); })}>Add shift</Button></div>
      <p className="mt-1 text-xs text-ink-500">You can check in from {DEFAULT_AVAILABILITY.checkInEarlyMinutes} minutes before a shift starts; you’ll go online for the shift.</p>
    </Card>
  );
}
