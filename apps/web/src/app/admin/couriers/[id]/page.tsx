'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { COURIER_CAPABILITIES, COURIER_DOC_LABELS, VEHICLE_TYPES, type CourierDocKind } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { DocLink } from '@/components/courier-docs';
import { CourierFeedbackTime, OnboardingPanel } from '@/components/courier/admin';
import type { Onboarding } from '@/components/courier/common';
import { CourierRiskCard } from '@/components/courier/fraud';
import type { Feedback } from '@/components/courier/money';

interface P {
  courier: { id: string; name: string | null; email: string; phone: string | null; status: string; vehicleType: string; capabilities: string[]; zoneIds: string[]; maxConcurrent: number; isAvailable: boolean; lastSeenAt: string | null; suspendedReason: string | null; suspendedAt: string | null; appealStatus: string; appealNote: string | null; appealDecisionNote: string | null };
  documents: { id: string; kind: string; status: string; fileUrl: string; fileId: string | null; expiresAt: string | null; reviewNote: string | null }[];
  shifts: { id: string; startsAt: string; endsAt: string; status: string }[];
  records: { id: string; kind: string; title: string; detail: string | null; createdAt: string }[];
  jobs: { id: string; orderId: string | null; status: string; createdAt: string; deliveredAt: string | null; etaAt: string | null; batchId: string | null }[];
  support: { id: string; category: string; status: string; owner: string | null; remedyCents: number; createdAt: string }[];
  earnings: { id: string; kind: string; baseCents: number; tipCents: number; bonusCents: number; reason: string | null; payoutId: string | null; createdAt: string }[];
  payableCents: number;
  onboarding?: Onboarding | null;
  time?: Record<string, number> | null;
  feedback?: Feedback | null;
  metrics?: { offers: number; acceptanceRate: number | null; completionRate: number | null; cancellationRate: number | null; onTimeRate: number | null; avgPickupWaitMinutes: number | null; delivered: number };
}
const pct = (x: number | null | undefined) => (x == null ? '—' : `${x}%`);

/** Courier profile (16.1–16.8). */
export default function Courier() {
  const { id } = useParams<{ id: string }>();
  const { data: p, reload } = useApi<P>(`/admin/couriers/${id}`);
  const { can } = useSession();
  const { run, error } = useAction();
  const [ok, setOk] = useState<string | null>(null);
  const [adj, setAdj] = useState({ amount: '', reason: '' });
  const [rec, setRec] = useState({ kind: 'TRAINING', title: '' });
  const [veh, setVeh] = useState<{ vehicleType: string; capabilities: string[]; maxConcurrent: string } | null>(null);
  if (!p) return null;
  const c = p.courier;
  const v = veh || { vehicleType: c.vehicleType, capabilities: c.capabilities, maxConcurrent: String(c.maxConcurrent) };
  const manage = can('delivery.manage');
  const act = (fn: () => Promise<unknown>, msg: string) => run(async () => { await fn(); setOk(msg); await reload(); });
  return (
    <div className="space-y-4">
      <div><Link href="/admin/couriers" className="text-xs text-ink-500 underline">← Couriers</Link><h1 className="text-2xl font-bold">{c.name || c.email}</h1><p className="text-sm text-ink-500">{c.email}{c.phone ? ` · ${c.phone}` : ''} · last seen {when(c.lastSeenAt)}</p><div className="mt-1 flex gap-1"><Badge tone={statusTone(c.status)}>{c.status}</Badge><Badge tone={c.isAvailable ? 'good' : 'neutral'}>{c.isAvailable ? 'online' : 'offline'}</Badge></div></div>
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[['Offers (30d)', p.metrics?.offers ?? 0], ['Acceptance', pct(p.metrics?.acceptanceRate)], ['Completion', pct(p.metrics?.completionRate)], ['Cancellations', pct(p.metrics?.cancellationRate)], ['On time', pct(p.metrics?.onTimeRate)], ['Payable', money(p.payableCents)]].map(([l, x]) => <div key={l as string} className="rounded-xl border border-ink-100 bg-white p-3"><div className="text-xs text-ink-500">{l}</div><div className="text-lg font-bold">{x}</div></div>)}
      </div>
      <CourierRiskCard driverId={id} />
      {p.onboarding && <OnboardingPanel courierId={id} ob={p.onboarding} manage={manage} onChange={reload} />}
      {c.status === 'SUSPENDED' && (
        <Card title="Suspension">
          <p className="text-sm">Since {when(c.suspendedAt)}: {c.suspendedReason}</p>
          {c.appealStatus === 'PENDING' && <><p className="mt-1 text-sm">Appeal: “{c.appealNote}”</p>{manage && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => { const note = askReason('reinstating this courier'); if (note) act(() => api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: true, note }), 'Reinstated.'); }}>Reinstate</Button><Button size="sm" variant="secondary" onClick={() => { const note = askReason('upholding the suspension'); if (note) act(() => api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: false, note }), 'Suspension upheld.'); }}>Uphold</Button></div>}<p className="text-xs text-ink-500">The appeal must be decided by someone other than the person who suspended the courier.</p></>}
          {c.appealDecisionNote && <p className="text-xs text-ink-500">Appeal decision: {c.appealDecisionNote}</p>}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Vehicle & capabilities">
          <div className="grid gap-2 sm:grid-cols-2"><Select label="Vehicle" value={v.vehicleType} onChange={(e) => setVeh({ ...v, vehicleType: e.target.value })}>{VEHICLE_TYPES.map((x) => <option key={x}>{x}</option>)}</Select><Input label="Orders at once" value={v.maxConcurrent} onChange={(e) => setVeh({ ...v, maxConcurrent: e.target.value })} /></div>
          <div className="mt-2 flex flex-wrap gap-3">{COURIER_CAPABILITIES.map((k) => <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={v.capabilities.includes(k)} onChange={(e) => setVeh({ ...v, capabilities: e.target.checked ? [...v.capabilities, k] : v.capabilities.filter((x) => x !== k) })} />{k.toLowerCase().replace('_', ' ')}</label>)}</div>
          {manage && <Button className="mt-2" size="sm" disabled={!veh} onClick={() => act(() => api.patch(`/admin/couriers/${id}`, { vehicleType: v.vehicleType, capabilities: v.capabilities, maxConcurrent: Number(v.maxConcurrent) }), 'Saved.')}>Save</Button>}
          <p className="mt-1 text-xs text-ink-500">Dispatch only offers alcohol and large orders to couriers with that capability; a cold bag improves the match for chilled items.</p>
        </Card>
        <Card title="Documents">
          <Table rows={p.documents} empty="No documents uploaded." cols={[{ key: 'k', label: 'Document', render: (d) => <DocLink doc={d} label={COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind} /> }, { key: 's', label: 'Status', render: (d) => <Badge tone={statusTone(d.status)}>{d.status}</Badge> }, { key: 'e', label: 'Expires', render: (d) => when(d.expiresAt) }, { key: 'n', label: 'Note', render: (d) => <span className="text-xs">{d.reviewNote}</span> }]} />
          {c.status === 'PENDING' && manage && !p.onboarding && <Button className="mt-2" size="sm" onClick={() => act(() => api.post(`/drivers/${id}/approve`, { approved: true }), 'Courier approved.')}>Approve courier</Button>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pay: earnings, adjustments, payouts">
          <Table rows={p.earnings.slice(0, 20)} empty="No earnings yet." cols={[{ key: 'd', label: 'When', render: (e) => <span className="text-xs">{when(e.createdAt)}</span> }, { key: 'k', label: 'Kind', render: (e) => e.kind.toLowerCase() }, { key: 'a', label: 'Amount', render: (e) => money(e.baseCents + e.tipCents + e.bonusCents) }, { key: 'r', label: 'Reason', render: (e) => <span className="text-xs">{e.reason || (e.tipCents ? `incl. tip ${money(e.tipCents)}` : '')}</span> }, { key: 'p', label: 'Payout', render: (e) => <span className="text-xs">{e.payoutId ? e.payoutId.slice(0, 8) : 'unpaid'}</span> }]} />
          {manage && <div className="mt-2 flex flex-wrap items-end gap-2"><Input label="Amount $ (negative = deduction)" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /><Input label="Reason" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /><Button size="sm" disabled={!adj.amount || adj.reason.length < 5} onClick={() => act(() => api.post(`/admin/couriers/${id}/adjustments`, { cents: Math.round(Number(adj.amount) * 100), reason: adj.reason }), 'Adjustment posted.')}>Post</Button></div>}
        </Card>
        <Card title="Records: incidents, training, notes">
          {p.records.map((r) => <div key={r.id} className="border-b border-ink-50 py-1 text-sm"><Badge>{r.kind.toLowerCase().replace('_', ' ')}</Badge> {r.title} <span className="text-xs text-ink-500">{when(r.createdAt)}</span>{r.detail && <div className="text-xs text-ink-500">{r.detail}</div>}</div>)}
          {manage && <div className="mt-2 flex flex-wrap items-end gap-2"><Select value={rec.kind} onChange={(e) => setRec({ ...rec, kind: e.target.value })}><option value="TRAINING">Training</option><option value="INCIDENT">Incident</option><option value="SUPPORT_NOTE">Note</option></Select><Input placeholder="Title" value={rec.title} onChange={(e) => setRec({ ...rec, title: e.target.value })} /><Button size="sm" disabled={rec.title.length < 2} onClick={() => act(() => api.post(`/admin/couriers/${id}/records`, rec), 'Recorded.')}>Add</Button></div>}
          {p.support.length > 0 && <><div className="mt-3 text-xs font-semibold text-ink-500">Support tickets on their deliveries</div>{p.support.map((s) => <div key={s.id} className="text-xs">{s.category.toLowerCase().replace(/_/g, ' ')} · {s.status.toLowerCase()} · owner {s.owner?.toLowerCase() || '—'}{s.remedyCents ? ` · ${money(s.remedyCents)}` : ''} · {when(s.createdAt)}</div>)}</>}
        </Card>
      </div>
      {(p.feedback !== undefined || p.time !== undefined) && <CourierFeedbackTime feedback={p.feedback} time={p.time} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent deliveries">
          <Table rows={p.jobs.slice(0, 15)} empty="None." cols={[{ key: 'd', label: 'Created', render: (j) => <span className="text-xs">{when(j.createdAt)}</span> }, { key: 's', label: 'Status', render: (j) => <span><Badge tone={statusTone(j.status)}>{j.status}</Badge>{j.batchId && <Badge tone="info">batch</Badge>}</span> }, { key: 'o', label: 'On time', render: (j) => j.deliveredAt && j.etaAt ? (new Date(j.deliveredAt) <= new Date(new Date(j.etaAt).getTime() + 300000) ? 'yes' : 'late') : '—' }, { key: 'x', label: '', render: (j) => j.orderId ? <Link className="text-xs underline" href={`/admin/orders/${j.orderId}`}>order</Link> : null }]} />
        </Card>
        <Card title="Shifts (this week)">
          {p.shifts.map((s) => <div key={s.id} className="text-sm">{when(s.startsAt)} – {new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {s.status === 'CANCELED' && <Badge>canceled</Badge>}</div>)}
          {!p.shifts.length && <p className="text-sm text-ink-500">No shifts.</p>}
          {manage && c.status !== 'SUSPENDED' && <Button className="mt-3" size="sm" variant="danger" onClick={() => { const reason = askReason('suspending this courier'); if (reason) act(() => api.post(`/admin/couriers/${id}/suspend`, { reason }), 'Suspended.'); }}>Suspend courier</Button>}
        </Card>
      </div>
    </div>
  );
}
