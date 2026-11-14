'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Textarea } from '@/components/ui';

export interface Closure { id: string; kind: string; startsAt: string; endsAt: string; opens: string | null; closes: string | null; service: string; reason: string | null }
export interface Checklist { items: { key: string; label: string; auto: boolean; required: boolean; done: boolean; doneAt: string | null; note: string | null; signedOff: boolean }[]; done: number; total: number; requiredOpen: string[]; progressPct: number; readinessApprovedAt: string | null }
export interface LocFields { id: string; contacts: { name: string; role?: string; phone?: string; email?: string }[]; pickupInstructions: string | null; parkingInfo: string | null; courierInstructions: string | null; acceptsPickup: boolean; acceptsDelivery: boolean; acceptsDineIn: boolean; acceptsKiosk: boolean; autoAccept: boolean; acceptTimeoutMinutes: number; orderThrottlePer15m: number | null; defaultPrepMinutes: number; isPaused: boolean; pausedReason: string | null; timezone: string }

const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Holiday closures, special hours and "closed until" — shared by the admin location page and the merchant portal. */
export function ClosuresCard({ locationId, closures, onChange }: { locationId: string; closures: Closure[]; onChange: () => void }) {
  const { run, error } = useAction();
  const [f, setF] = useState({ kind: 'CLOSED', startsAt: local(new Date()), endsAt: local(new Date(Date.now() + 86400_000)), opens: '11:00', closes: '15:00', service: 'ALL', reason: '' });
  const add = (body: Record<string, unknown>) => run(async () => { await api.post(`/locations/${locationId}/closures`, body); onChange(); });
  return (
    <Card title="Holidays, closures & special hours">
      {error && <Alert>{error}</Alert>}
      <div className="mb-2 flex flex-wrap gap-2">{[1, 2, 4].map((h) => <Button key={h} size="sm" variant="secondary" onClick={() => add({ kind: 'CLOSED', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + h * 3600_000).toISOString(), service: 'ORDERING', reason: `Closed for ${h}h` })}>Close ordering for {h}h</Button>)}</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="CLOSED">Closed</option><option value="SPECIAL_HOURS">Special hours</option></Select>
        <Input label="From" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        <Input label="Reopens" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />
        {f.kind === 'SPECIAL_HOURS' && <><Input label="Opens" value={f.opens} onChange={(e) => setF({ ...f, opens: e.target.value })} /><Input label="Closes" value={f.closes} onChange={(e) => setF({ ...f, closes: e.target.value })} /></>}
        <Select label="Applies to" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="ALL">Everything</option><option value="ORDERING">Ordering</option><option value="RESERVATIONS">Reservations</option></Select>
        <Input className="sm:col-span-2" label="Reason (shown to guests)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
      <Button className="mt-2" size="sm" onClick={() => add({ ...f, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), opens: f.kind === 'SPECIAL_HOURS' ? f.opens : undefined, closes: f.kind === 'SPECIAL_HOURS' ? f.closes : undefined, reason: f.reason || undefined })}>Add</Button>
      <ul className="mt-3 space-y-1 text-sm">{closures.filter((c) => new Date(c.endsAt) > new Date()).map((c) => <li key={c.id} className="flex justify-between rounded-lg bg-ink-50 px-2 py-1"><span>{c.kind === 'CLOSED' ? 'Closed' : `Special hours ${c.opens}–${c.closes}`} · {when(c.startsAt)} → {when(c.endsAt)} · {c.service.toLowerCase()}{c.reason && <i className="text-ink-500"> — {c.reason}</i>}</span><button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/closures/${c.id}`); onChange(); })}>Remove</button></li>)}</ul>
    </Card>
  );
}

/** Contacts, channels, acceptance settings, pickup / parking / courier instructions. */
export function OperationsCard({ loc, onChange, canThrottle = true }: { loc: LocFields; onChange: () => void; canThrottle?: boolean }) {
  const { run, error } = useAction();
  const [v, setV] = useState<LocFields>(loc);
  const [ok, setOk] = useState(false);
  const set = (p: Partial<LocFields>) => { setV({ ...v, ...p }); setOk(false); };
  return (
    <Card title="Operations settings">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">Saved.</Alert>}
      <div className="flex flex-wrap gap-4 text-sm">{(['acceptsPickup', 'acceptsDelivery', 'acceptsDineIn', 'acceptsKiosk'] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={v[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<LocFields>)} />{k.replace('accepts', '').replace('DineIn', 'Dine-in')}</label>)}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.autoAccept} onChange={(e) => set({ autoAccept: e.target.checked })} /> Auto-accept orders</label>
        <Input label="Accept within (minutes)" type="number" value={v.acceptTimeoutMinutes} onChange={(e) => set({ acceptTimeoutMinutes: Number(e.target.value) })} />
        <Input label="Default prep (minutes)" type="number" value={v.defaultPrepMinutes} onChange={(e) => set({ defaultPrepMinutes: Number(e.target.value) })} />
        {canThrottle && <Input label="Max orders per 15 min (blank = no limit)" type="number" value={v.orderThrottlePer15m ?? ''} onChange={(e) => set({ orderThrottlePer15m: e.target.value ? Number(e.target.value) : null })} />}
      </div>
      <p className="mt-1 text-xs text-ink-500">Unaccepted orders escalate after the accept time and are rejected automatically at four times it.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Textarea label="Pickup instructions (customers)" rows={2} value={v.pickupInstructions || ''} onChange={(e) => set({ pickupInstructions: e.target.value || null })} />
        <Textarea label="Parking" rows={2} value={v.parkingInfo || ''} onChange={(e) => set({ parkingInfo: e.target.value || null })} />
        <Textarea label="Courier collection point" rows={2} value={v.courierInstructions || ''} onChange={(e) => set({ courierInstructions: e.target.value || null })} />
      </div>
      <div className="mt-2 text-xs font-semibold text-ink-500">Contacts</div>
      {v.contacts.map((c, i) => <div key={i} className="mt-1 grid grid-cols-[1fr_1fr_1fr_auto] gap-2"><Input placeholder="Name" value={c.name} onChange={(e) => set({ contacts: v.contacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><Input placeholder="Role" value={c.role || ''} onChange={(e) => set({ contacts: v.contacts.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} /><Input placeholder="Phone" value={c.phone || ''} onChange={(e) => set({ contacts: v.contacts.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)) })} /><button className="text-xs text-red-600" onClick={() => set({ contacts: v.contacts.filter((_, j) => j !== i) })}>×</button></div>)}
      <button className="mt-1 text-xs underline" onClick={() => set({ contacts: [...v.contacts, { name: '' }] })}>+ Add contact</button>
      <div className="mt-3"><Button size="sm" onClick={() => run(async () => { const { id, isPaused: _p, pausedReason: _r, timezone: _t, ...body } = v; await api.patch(`/locations/${id}`, { ...body, contacts: v.contacts.filter((c) => c.name) }); setOk(true); onChange(); })}>Save</Button></div>
    </Card>
  );
}

/** Launch checklist with sign-offs; readiness approval is a Gutad action. */
export function ChecklistCard({ locationId, checklist, onChange, staff }: { locationId: string; checklist: Checklist; onChange: () => void; staff: boolean }) {
  const { run, error } = useAction();
  return (
    <Card title={`Launch checklist · ${checklist.progressPct}%`}>
      {error && <Alert>{error}</Alert>}
      <ul className="space-y-1 text-sm">{checklist.items.map((i) => (
        <li key={i.key} className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><span className={i.done ? 'text-emerald-600' : 'text-ink-300'}>{i.done ? '✓' : '○'}</span>{i.label}{i.required && <Badge tone="warn">required</Badge>}{i.auto && !i.signedOff && <span className="text-xs text-ink-500">automatic</span>}{i.note && <span className="text-xs text-ink-500">— {i.note}</span>}</span>
          {(staff || i.key === 'TRAINING') && (!i.auto || !i.done || i.signedOff) && <button className="text-xs underline" onClick={() => { const note = i.done ? undefined : window.prompt('Note (optional)') || undefined; run(async () => { await api.post(`/locations/${locationId}/launch-items/${i.key}`, { done: !i.signedOff, note }); onChange(); }); }}>{i.signedOff ? 'Undo' : 'Sign off'}</button>}
        </li>
      ))}</ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {checklist.readinessApprovedAt ? <span className="text-sm text-emerald-700">Readiness approved {when(checklist.readinessApprovedAt)}</span> : <span className="text-sm text-ink-500">{checklist.requiredOpen.length ? `Still open: ${checklist.requiredOpen.join('; ')}` : 'Everything required is done.'}</span>}
        {staff && (checklist.readinessApprovedAt ? <Button size="sm" variant="ghost" onClick={() => { const note = window.prompt('Why revoke readiness?'); if (note) run(async () => { await api.post(`/admin/locations/${locationId}/readiness`, { approve: false, note }); onChange(); }); }}>Revoke</Button> : <Button size="sm" disabled={checklist.requiredOpen.length > 0} onClick={() => { const note = window.prompt('Launch review note'); if (note) run(async () => { await api.post(`/admin/locations/${locationId}/readiness`, { approve: true, note }); onChange(); }); }}>Approve readiness</Button>)}
      </div>
    </Card>
  );
}
