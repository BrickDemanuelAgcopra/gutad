'use client';
import Link from 'next/link';
import { useState } from 'react';
import {
  APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, COURIER_DOC_LABELS, ELIGIBILITY_CHECKS, ELIGIBILITY_LABELS, EQUIPMENT_LABELS, LIFECYCLE_LABELS, TRAINING_MODULES,
  type ApplicationStatus, type CheckStatus, type CourierDocKind, type EligibilityCheck, type EquipmentItem,
} from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { applicationTone, checkTone, humanize, lifecycleTone, minutes, type Onboarding } from './common';
import { FeedbackSummary, type Feedback } from './money';

interface Pipeline {
  counts: Partial<Record<ApplicationStatus, number>>;
  funnel: { started: number; submitted: number; approved: number; firstDelivery: number };
  applicants: { id: string; name: string | null; email: string; city: string | null; transport: string | null; applicationStatus: ApplicationStatus; submittedAt: string | null; updatedAt: string; stalled: boolean; stepsDone: number; stepsTotal: number; checks: Partial<Record<EligibilityCheck, CheckStatus>>; pendingDocs: number }[];
}

const SHORT: Record<EligibilityCheck, string> = { IDENTITY: 'ID', VEHICLE: 'Veh', SCREENING: 'Scr', PAYOUT: 'Pay', AGREEMENT: 'Agr', TRAINING: 'Trn', EQUIPMENT: 'Eqp' };

/** Applications: counts by status, the sign-up funnel and the applicant list. */
export function ApplicationsPipeline() {
  const [status, setStatus] = useState('');
  const [stalledOnly, setStalledOnly] = useState(false);
  const { data } = useApi<Pipeline>('/admin/couriers/pipeline', { poll: 60000 });
  if (!data) return null;
  const rows = data.applicants.filter((a) => (!status || a.applicationStatus === status) && (!stalledOnly || a.stalled));
  const f = data.funnel;
  const pct = (n: number) => (f.started ? `${Math.round((n / f.started) * 100)}%` : '—');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        {([['Started', f.started], ['Submitted', f.submitted], ['Approved', f.approved], ['First delivery', f.firstDelivery]] as const).map(([l, n]) => <div key={l} className="rounded-xl border border-ink-100 bg-white p-3"><div className="text-xs text-ink-500">{l}</div><div className="text-lg font-bold">{n}</div><div className="text-[11px] text-ink-500">{pct(n)} of started</div></div>)}
      </div>
      <div className="flex flex-wrap gap-1">
        <button onClick={() => setStatus('')} className={`rounded-full px-3 py-1 text-xs ${!status ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}>All · {data.applicants.length}</button>
        {APPLICATION_STATUSES.map((s) => <button key={s} onClick={() => setStatus(s)} className={`rounded-full px-3 py-1 text-xs ${status === s ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-700'}`}>{APPLICATION_STATUS_LABELS[s]} · {data.counts[s] ?? 0}</button>)}
        <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={stalledOnly} onChange={(e) => setStalledOnly(e.target.checked)} /> Stalled only</label>
      </div>
      <Table rows={rows} empty="No applicants." cols={[
        { key: 'n', label: 'Applicant', render: (a) => <Link className="underline" href={`/admin/couriers/${a.id}`}>{a.name || a.email}<span className="block text-xs text-ink-500 no-underline">{a.email}</span></Link> },
        { key: 'c', label: 'City / transport', render: (a) => <span className="text-xs">{a.city || '—'} · {a.transport ? humanize(a.transport) : '—'}</span> },
        { key: 's', label: 'Status', render: (a) => <span><Badge tone={applicationTone(a.applicationStatus)}>{APPLICATION_STATUS_LABELS[a.applicationStatus] || a.applicationStatus}</Badge>{a.stalled && <Badge tone="bad">stalled</Badge>}</span> },
        { key: 'p', label: 'Steps', render: (a) => <span className="text-xs">{a.stepsDone}/{a.stepsTotal}</span> },
        { key: 'k', label: 'Checks', render: (a) => <span className="flex flex-wrap gap-0.5">{ELIGIBILITY_CHECKS.map((c) => <span key={c} title={`${ELIGIBILITY_LABELS[c]}: ${humanize(a.checks[c] || 'NOT_STARTED')}`}><Badge tone={checkTone(a.checks[c])}>{SHORT[c]}</Badge></span>)}</span> },
        { key: 'd', label: 'Docs to review', render: (a) => a.pendingDocs ? <Badge tone="warn">{a.pendingDocs}</Badge> : <span className="text-xs text-ink-500">—</span> },
        { key: 'u', label: 'Submitted / updated', render: (a) => <span className="text-xs">{when(a.submittedAt)}<span className="block text-ink-500">{when(a.updatedAt)}</span></span> },
      ]} />
    </div>
  );
}

const CHECK_SET = ['PASSED', 'NEEDS_ACTION', 'FAILED', 'PENDING'] as const;
const DECISIONS = [['APPROVE', 'Approve'], ['NEEDS_ACTION', 'Needs action'], ['WAITLIST', 'Waitlist'], ['REJECT', 'Reject'], ['REOPEN', 'Reopen']] as const;
const LIFECYCLE_SET = ['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED'] as const;

/** Admin view of one courier’s application: steps, data, documents, per-check decisions, overall decision and lifecycle. */
export function OnboardingPanel({ courierId, ob, manage, onChange }: { courierId: string; ob: Onboarding; manage: boolean; onChange: () => Promise<void> }) {
  const { run, error } = useAction();
  const [ok, setOk] = useState<string | null>(null);
  const [decision, setDecision] = useState({ decision: 'APPROVE', note: '' });
  const [life, setLife] = useState({ status: 'ACTIVE', reason: '' });
  const act = (fn: () => Promise<unknown>, msg: string) => run(async () => { setOk(null); await fn(); setOk(msg); await onChange(); });
  const d = ob.driver;
  const allPassed = ob.checks.length > 0 && ob.checks.every((c) => c.status === 'PASSED');
  return (
    <Card title="Onboarding" action={d && <span className="flex gap-1"><Badge tone={applicationTone(d.applicationStatus)}>{APPLICATION_STATUS_LABELS[d.applicationStatus] || d.applicationStatus}</Badge>{d.lifecycleStatus && <Badge tone={lifecycleTone(d.lifecycleStatus)}>{LIFECYCLE_LABELS[d.lifecycleStatus]}</Badge>}</span>}>
      {error && <div className="mb-2"><Alert>{error}</Alert></div>}
      {ok && <div className="mb-2"><Alert tone="good">{ok}</Alert></div>}
      {d && <p className="text-xs text-ink-500">Submitted {when(d.submittedAt)}{d.firstDeliveryAt ? ` · first delivery ${when(d.firstDeliveryAt)}` : ''}{d.decisionNote ? ` · last decision: ${d.decisionNote}` : ''}</p>}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-sm font-semibold">Steps</h4>
          <ul className="space-y-0.5 text-sm">{ob.steps.map((s) => <li key={s.key} className="flex justify-between gap-2"><span>{s.label}{s.note ? <span className="block text-xs text-ink-500">{s.note}</span> : null}</span><Badge tone={s.needsAction ? 'warn' : s.done ? 'good' : 'neutral'}>{s.needsAction ? 'needs action' : s.done ? 'done' : 'to do'}</Badge></li>)}</ul>
          <h4 className="mb-1 mt-3 text-sm font-semibold">Documents</h4>
          <ul className="space-y-0.5 text-sm">
            {ob.requiredDocs.map((k) => { const doc = ob.documents.find((x) => x.kind === k); return <li key={k} className="flex justify-between"><span>{COURIER_DOC_LABELS[k as CourierDocKind] || k}{doc?.expiresAt ? <span className="text-xs text-ink-500"> · expires {when(doc.expiresAt)}</span> : null}</span>{doc ? <Badge tone={statusTone(doc.status)}>{doc.status}</Badge> : <Badge tone="bad">missing</Badge>}</li>; })}
          </ul>
          <p className="mt-1 text-xs text-ink-500">Review files in the Documents card below.</p>
        </div>
        <OnboardingData ob={ob} />
      </div>
      <h4 className="mb-1 mt-4 text-sm font-semibold">Eligibility checks</h4>
      <div className="space-y-1">{ELIGIBILITY_CHECKS.map((c) => <CheckRow key={c} courierId={courierId} check={c} row={ob.checks.find((x) => x.check === c)} manage={manage} onSaved={async (m) => { setOk(m); await onChange(); }} />)}</div>
      {manage && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg bg-ink-50 p-3">
            <h4 className="mb-1 text-sm font-semibold">Decision</h4>
            <div className="flex flex-wrap items-end gap-2">
              <Select label="Decision" value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })}>{DECISIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Input label="Note (shown to the courier)" value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} />
              <Button size="sm" disabled={decision.note.trim().length < 3} onClick={() => act(() => api.post(`/admin/couriers/${courierId}/decision`, { decision: decision.decision, note: decision.note.trim() }), 'Decision saved.')}>Save</Button>
            </div>
            {decision.decision === 'APPROVE' && !allPassed && <p className="mt-1 text-xs text-amber-700">Approval needs every check passed and the vehicle’s documents approved.</p>}
          </div>
          <div className="rounded-lg bg-ink-50 p-3">
            <h4 className="mb-1 text-sm font-semibold">Account lifecycle</h4>
            <div className="flex flex-wrap items-end gap-2">
              <Select label="Set to" value={life.status} onChange={(e) => setLife({ ...life, status: e.target.value })}>{LIFECYCLE_SET.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}</Select>
              <Input label="Reason" value={life.reason} onChange={(e) => setLife({ ...life, reason: e.target.value })} />
              <Button size="sm" variant={life.status === 'ACTIVE' ? 'primary' : 'danger'} disabled={life.reason.trim().length < 5} onClick={() => act(() => api.post(`/admin/couriers/${courierId}/lifecycle`, { status: life.status, reason: life.reason.trim() }), 'Lifecycle updated.')}>Apply</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function CheckRow({ courierId, check, row, manage, onSaved }: { courierId: string; check: EligibilityCheck; row?: Onboarding['checks'][number]; manage: boolean; onSaved: (msg: string) => Promise<void> }) {
  const [f, setF] = useState<{ status: string; note: string; expires: string } | null>(null);
  const { run, error, busy } = useAction();
  const status = row?.status || 'NOT_STARTED';
  return (
    <div className="rounded-lg border border-ink-100 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span><b>{ELIGIBILITY_LABELS[check]}</b>{row?.note ? <span className="text-xs text-ink-500"> · {row.note}</span> : null}{row?.expiresAt ? <span className="text-xs text-ink-500"> · expires {when(row.expiresAt)}</span> : null}</span>
        <span className="flex items-center gap-2"><Badge tone={checkTone(status)}>{humanize(status)}</Badge>{manage && !f && <button className="text-xs underline" onClick={() => setF({ status: status === 'NOT_STARTED' ? 'PASSED' : status, note: '', expires: row?.expiresAt ? row.expiresAt.slice(0, 10) : '' })}>Change</button>}</span>
      </div>
      {f && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{CHECK_SET.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
          <Input label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <Input label="Expires (optional)" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
          <Button size="sm" disabled={busy || (f.status !== 'PASSED' && f.note.trim().length < 3)} onClick={() => run(async () => { await api.post(`/admin/couriers/${courierId}/checks/${check}`, { status: f.status, note: f.note.trim() || undefined, expiresAt: f.expires ? new Date(`${f.expires}T23:59:00Z`).toISOString() : undefined }); setF(null); await onSaved(`${ELIGIBILITY_LABELS[check]}: ${humanize(f.status)}.`); })}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setF(null)}>Cancel</Button>
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </div>
  );
}

function OnboardingData({ ob }: { ob: Onboarding }) {
  const x = ob.data;
  const rows: [string, React.ReactNode][] = [];
  if (x.location) rows.push(['Location', `${x.location.city || '—'}, ${x.location.country || '—'} · ${x.location.transport ? humanize(x.location.transport) : '—'}${x.location.zoneIds?.length ? ` · ${x.location.zoneIds.length} zone(s)` : ''}`]);
  if (x.profile) rows.push(['Profile', <span key="p">{x.profile.legalName} · {x.profile.phone}<span className="block text-xs text-ink-500">{x.profile.addressLine1}, {x.profile.city} {x.profile.postalCode}{x.profile.languages?.length ? ` · ${x.profile.languages.join(', ')}` : ''}</span></span>]);
  if (x.vehicle) rows.push(['Vehicle', [x.vehicle.color, x.vehicle.year, x.vehicle.make, x.vehicle.model].filter(Boolean).join(' ') + (x.vehicle.plate ? ` · ${x.vehicle.plate}` : '') || '—']);
  if (x.screening) rows.push(['Screening consent', `${when(x.screening.consentedAt)} (${x.screening.consentVersion})`]);
  if (x.payout) rows.push(['Payout', `${humanize(x.payout.method)} •••• ${x.payout.accountLast4}${x.payout.taxFormAcceptedAt ? ' · tax confirmed' : ''}`]);
  if (x.agreement) rows.push(['Agreement', `${x.agreement.version} · ${when(x.agreement.acceptedAt)}`]);
  rows.push(['Training', `${TRAINING_MODULES.filter((m) => x.training?.[m.key]).length}/${TRAINING_MODULES.length} modules`]);
  if (x.equipment) rows.push(['Equipment', x.equipment.items.map((i: EquipmentItem) => EQUIPMENT_LABELS[i] || i).join(', ') || '—']);
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">Application details</h4>
      <dl className="space-y-1 text-sm">{rows.map(([k, v]) => <div key={k} className="grid grid-cols-[120px_1fr] gap-2"><dt className="text-xs text-ink-500">{k}</dt><dd>{v}</dd></div>)}</dl>
      {ob.availability && <p className="mt-2 text-xs text-ink-500">{ob.availability.message}</p>}
    </div>
  );
}

/** Feedback and time on the admin courier page. */
export function CourierFeedbackTime({ feedback, time }: { feedback?: Feedback | null; time?: Record<string, number> | null }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Customer feedback">
        {feedback ? <>
          <FeedbackSummary f={feedback} />
          <div className="mt-2 divide-y divide-ink-100">{feedback.recent.slice(0, 8).map((r) => <div key={r.id} className="py-1 text-sm"><span className="text-amber-500">{'★'.repeat(r.rating)}</span> <span className="text-xs text-ink-500">{when(r.createdAt)}</span>{r.excluded && <Badge tone="info">excluded</Badge>}{r.disputeStatus && r.disputeStatus !== 'NONE' && <Badge tone="warn">dispute {humanize(r.disputeStatus)}</Badge>}{r.comment && <div className="text-xs">“{r.comment}”</div>}</div>)}</div>
          <Link className="mt-2 inline-block text-xs underline" href="/admin/delivery-reviews">Moderation queue</Link>
        </> : <p className="text-sm text-ink-500">No feedback yet.</p>}
      </Card>
      <Card title="Time (last 7 days)">
        {time && Object.keys(time).length ? <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{Object.entries(time).map(([k, v]) => <div key={k} className="rounded-lg bg-ink-50 p-2"><div className="text-xs text-ink-500">{humanize(k.replace(/Minutes$/, '').replace(/([a-z])([A-Z])/g, '$1_$2'))}</div><div className="font-semibold">{minutes(typeof v === 'number' ? v : 0)}</div></div>)}</div> : <p className="text-sm text-ink-500">No time recorded.</p>}
      </Card>
    </div>
  );
}
