'use client';
import { useState } from 'react';
import { FRAUD_DECISIONS, RISK_SIGNAL_LABELS, RISK_SIGNAL_TYPES, type FraudDecision, type RiskSignalType } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Modal, Select, statusTone, Table, Textarea } from '@/components/ui';
import { KeyValue } from '@/components/admin-ui';

// Courier Release 3: fraud review queue, case page and the risk card on a courier.

interface CaseRow { id: string; driverId: string; driverName: string; score: number; status: string; holdActive: boolean; decision: string | null; openedAt: string; decidedAt: string | null; topSignals: { type: string; label: string; weight: number }[] }
interface Signal { id: string; type: RiskSignalType; label: string; weight: number; status: string; deliveryJobId: string | null; data: Record<string, unknown>; createdAt: string }
interface CaseDetail {
  case: { id: string; driverId: string; status: string; score: number; holdActive: boolean; decision: string | null; reason: string | null; notice: string | null; openedAt: string; decidedAt: string | null };
  courier: { id: string; name: string; email: string; phone: string | null; lifecycleStatus: string | null; ratingAvg: number | null; firstDeliveryAt: string | null; vehicleType: string } | null;
  payableCents: number;
  signals: Signal[];
  jobs: { id: string; status: string; orderNumber: string | null; deliveredAt: string | null; proofUrl: string | null; dropoff: { line1?: string } }[];
  linkedCouriers: { id: string; name: string; lifecycleStatus: string | null }[];
  earnings: { id: string; kind: string; deliveryJobId: string | null; totalCents: number; createdAt: string; reason: string | null }[];
}

const DECISION_LABELS: Record<FraudDecision, string> = { CLEAR: 'Clear: nothing wrong', WARN: 'Warn the courier', CLAWBACK: 'Claw back pay', RESTRICT: 'Restrict the account', SUSPEND: 'Suspend the account' };
const NOTICE_DEFAULTS: Record<FraudDecision, string> = {
  CLEAR: 'We reviewed recent activity on your account and found nothing wrong. Thanks for your patience.',
  WARN: 'We reviewed recent activity on your account. Please make sure every delivery follows the courier agreement.',
  CLAWBACK: 'We reviewed recent deliveries and removed pay for trips that did not meet the courier agreement.',
  RESTRICT: 'After reviewing recent activity, your account is restricted to single orders for now.',
  SUSPEND: 'After reviewing recent activity, your account is suspended. You can appeal this decision.',
};

/** Plain-language detail of a signal for staff. */
function signalDetail(s: Signal) {
  const d = s.data as Record<string, number | string | string[] | { lat: number; lng: number } | undefined>;
  // raised by staff: only their note
  if (typeof d.note === 'string') return d.note;
  switch (s.type) {
    case 'DROPOFF_FAR': return `Marked delivered ${d.meters} m from the drop-off`;
    case 'GPS_JUMP': return `Moved ${d.km} km at ${d.kmh} km/h between two pings`;
    case 'PROOF_REUSED': return `Same photo as ${(d.otherJobs as string[] | undefined)?.length ?? 1} other deliver${(d.otherJobs as string[] | undefined)?.length === 1 ? 'y' : 'ies'}`;
    case 'RELEASE_PATTERN': return `${d.releases} releases after arriving, last ${d.days} days`;
    case 'UNREACHABLE_PATTERN': return `${d.returns} "customer unreachable" returns, last ${d.days} days`;
    case 'COLLUSION': return `${d.deliveries} deliveries to one customer, average tip ${money(Number(d.avgTipCents))} (median ${money(Number(d.medianTipCents))})`;
    case 'INCENTIVE_GAMING': return `${d.fastDeliveries} deliveries under 2 minutes during “${d.campaign}”`;
    case 'SHARED_PAYOUT': return `Payout account${d.accountLast4 ? ` ending ${d.accountLast4}` : ''} also used by another courier`;
    case 'SHARED_PHONE': return 'Phone number also used by another courier';
    case 'MANUAL': return String(d.note ?? '');
    default: return '';
  }
}

export function FraudQueue() {
  const [status, setStatus] = useState('OPEN');
  const { data, reload } = useApi<CaseRow[]>(`/admin/courier-fraud/cases?status=${status}`, { deps: [status], poll: 60000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">Couriers whose risk score passed the review threshold. Above the hold threshold their payouts pause until you decide. Highest score first.</p>
      <Select label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Open cases</option><option value="DECIDED">Decided</option><option value="ALL">All</option></Select>
      <Table rows={data ?? []} empty={status === 'OPEN' ? 'No couriers waiting for review.' : 'No cases.'} cols={[
        { key: 'n', label: 'Courier', render: (c) => <button className="font-medium underline-offset-2 hover:underline" onClick={() => setOpen(c.id)}>{c.driverName}</button> },
        { key: 's', label: 'Score', render: (c) => <Badge tone={c.score >= 70 ? 'bad' : 'warn'}>{c.score}</Badge> },
        { key: 'g', label: 'Main signals', render: (c) => <span className="flex flex-wrap gap-1">{c.topSignals.map((s) => <Badge key={s.type} tone="neutral">{s.label}</Badge>)}</span> },
        { key: 'h', label: 'Payouts', render: (c) => (c.holdActive ? <Badge tone="bad">on hold</Badge> : <span className="text-xs text-ink-500">flowing</span>) },
        { key: 'o', label: 'Opened', render: (c) => <span className="text-xs">{when(c.openedAt)}</span> },
        { key: 'd', label: 'Decision', render: (c) => (c.decision ? <Badge tone={c.decision === 'CLEAR' ? 'good' : 'warn'}>{c.decision.toLowerCase()}</Badge> : <Badge tone={statusTone(c.status)}>{c.status.toLowerCase()}</Badge>) },
        { key: 'a', label: '', render: (c) => <Button size="sm" variant="secondary" onClick={() => setOpen(c.id)}>{c.status === 'OPEN' ? 'Review' : 'View'}</Button> },
      ]} />
      {open && <FraudCase id={open} onClose={() => setOpen(null)} onDecided={async () => { setOpen(null); await reload(); }} />}
    </div>
  );
}

export function FraudCase({ id, onClose, onDecided }: { id: string; onClose: () => void; onDecided: () => void }) {
  const { can } = useSession();
  const { data } = useApi<CaseDetail>(`/admin/courier-fraud/cases/${id}`);
  const { run, error, busy } = useAction();
  const [decision, setDecision] = useState<FraudDecision>('CLEAR');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(NOTICE_DEFAULTS.CLEAR);
  const [claw, setClaw] = useState<string[]>([]);
  const open = data?.case.status === 'OPEN';
  return (
    <Modal open onClose={onClose} title={data?.courier ? `Review: ${data.courier.name}` : 'Fraud review'}>
      {data && <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {data.case.holdActive && <Alert>Payouts for this courier are on hold until you decide. Deliveries and earnings continue.</Alert>}
        <KeyValue rows={[
          ['Courier', data.courier ? <a key="c" className="underline" href={`/admin/couriers/${data.courier.id}`}>{data.courier.name}</a> : '—'],
          ['Contact', data.courier ? `${data.courier.email}${data.courier.phone ? ` · ${data.courier.phone}` : ''}` : '—'],
          ['Account', data.courier ? `${(data.courier.lifecycleStatus ?? '—').toLowerCase()} · ${data.courier.vehicleType.toLowerCase()} · rating ${data.courier.ratingAvg?.toFixed(1) ?? '—'} · first delivery ${when(data.courier.firstDeliveryAt)}` : '—'],
          ['Score', `${data.case.score} (opened ${when(data.case.openedAt)})`],
          ['Owed to courier', money(data.payableCents)],
          ...(data.case.decision ? [['Decision', `${data.case.decision.toLowerCase()} · ${when(data.case.decidedAt)} · ${data.case.reason}`] as [string, React.ReactNode], ['Courier was told', data.case.notice ?? '—'] as [string, React.ReactNode]] : []),
        ]} />
        <Card title="Signals">
          <ul className="space-y-1 text-sm">{data.signals.map((s) => <li key={s.id} className="flex flex-wrap items-baseline gap-2"><Badge tone={s.status === 'OPEN' ? 'warn' : s.status === 'DISMISSED' ? 'neutral' : 'bad'}>+{s.weight}</Badge><b>{s.label}</b><span className="text-ink-600">{signalDetail(s)}</span><span className="ml-auto text-xs text-ink-500">{when(s.createdAt)}{s.status !== 'OPEN' ? ` · ${s.status.toLowerCase()}` : ''}</span></li>)}</ul>
        </Card>
        {data.jobs.length > 0 && <Card title="Deliveries involved">
          <div className="grid gap-2 sm:grid-cols-2">{data.jobs.map((j) => <div key={j.id} className="rounded border border-ink-100 p-2 text-xs">
            <div className="font-medium">{j.orderNumber ? `#${j.orderNumber}` : j.id.slice(0, 8)} · {j.status.toLowerCase()} · {when(j.deliveredAt)}</div>
            <div className="text-ink-500">{j.dropoff?.line1}</div>
            {j.proofUrl && <img src={j.proofUrl} alt="Proof of delivery" className="mt-1 max-h-32 rounded" />}
          </div>)}</div>
        </Card>}
        {data.linkedCouriers.length > 0 && <Card title="Linked couriers"><ul className="text-sm">{data.linkedCouriers.map((l) => <li key={l.id}><a className="underline" href={`/admin/couriers/${l.id}`}>{l.name}</a> <span className="text-xs text-ink-500">{(l.lifecycleStatus ?? '').toLowerCase()}</span></li>)}</ul></Card>}
        {open && can('delivery.manage') && <Card title="Decision">
          <div className="space-y-2">
            <Select label="Decision" value={decision} onChange={(e) => { const d = e.target.value as FraudDecision; setDecision(d); setNotice(NOTICE_DEFAULTS[d]); }}>{FRAUD_DECISIONS.map((d) => <option key={d} value={d}>{DECISION_LABELS[d]}</option>)}</Select>
            {decision === 'CLAWBACK' && <div className="max-h-48 overflow-y-auto rounded border border-ink-100 p-2 text-sm">
              <p className="mb-1 text-xs text-ink-500">Choose the earnings to take back (tips stay with the courier).</p>
              {data.earnings.filter((e) => e.totalCents > 0 && e.kind !== 'DEDUCTION').map((e) => <label key={e.id} className="flex items-center gap-2"><input type="checkbox" checked={claw.includes(e.id)} onChange={() => setClaw(claw.includes(e.id) ? claw.filter((x) => x !== e.id) : [...claw, e.id])} />{e.kind.toLowerCase().replace('_', ' ')} · {money(e.totalCents)} · {when(e.createdAt)}{e.reason ? ` · ${e.reason}` : ''}</label>)}
            </div>}
            <Textarea label="Reason (staff only, audited)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Textarea label="What the courier will read" rows={3} value={notice} onChange={(e) => setNotice(e.target.value)} />
            <p className="text-xs text-ink-500">Any decision releases the payout hold. Restrict and suspend also change the account status; the courier can appeal a suspension.</p>
            <div className="flex justify-end"><Button disabled={busy || reason.trim().length < 3 || notice.trim().length < 10 || (decision === 'CLAWBACK' && !claw.length)} onClick={() => run(async () => { await api.post(`/admin/courier-fraud/cases/${id}/decide`, { decision, reason, noticeToCourier: notice, clawbackEarningIds: decision === 'CLAWBACK' ? claw : undefined }); onDecided(); })}>Record decision</Button></div>
          </div>
        </Card>}
      </div>}
    </Modal>
  );
}

/** Risk score on the courier page, with a way to open the case or raise a manual signal. */
export function CourierRiskCard({ driverId }: { driverId: string }) {
  const { can } = useSession();
  const { data, reload } = useApi<{ score: number; reviewThreshold: number; holdThreshold: number; openCaseId: string | null; holdActive: boolean }>(`/admin/couriers/${driverId}/risk`);
  const { run, error, busy } = useAction();
  const [show, setShow] = useState(false);
  const [flag, setFlag] = useState({ open: false, type: 'MANUAL' as RiskSignalType, note: '' });
  if (!data) return null;
  return (
    <Card title="Risk review" action={can('delivery.manage') && <Button size="sm" variant="ghost" onClick={() => setFlag({ ...flag, open: !flag.open })}>Flag activity</Button>}>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm">Score <Badge tone={data.score >= data.holdThreshold ? 'bad' : data.score >= data.reviewThreshold ? 'warn' : 'good'}>{data.score}</Badge> <span className="text-xs text-ink-500">review at {data.reviewThreshold}, payouts pause at {data.holdThreshold} (last 30 days)</span></p>
      {data.openCaseId && <p className="mt-1 text-sm">{data.holdActive ? <Badge tone="bad">payouts on hold</Badge> : <Badge tone="warn">under review</Badge>} <Button size="sm" variant="secondary" onClick={() => setShow(true)}>Open case</Button></p>}
      {flag.open && <div className="mt-2 space-y-2">
        <Select label="What happened" value={flag.type} onChange={(e) => setFlag({ ...flag, type: e.target.value as RiskSignalType })}>{RISK_SIGNAL_TYPES.map((t) => <option key={t} value={t}>{RISK_SIGNAL_LABELS[t]}</option>)}</Select>
        <Textarea label="Note" rows={2} value={flag.note} onChange={(e) => setFlag({ ...flag, note: e.target.value })} />
        <Button size="sm" disabled={busy || flag.note.trim().length < 3} onClick={() => run(async () => { await api.post(`/admin/couriers/${driverId}/risk-signals`, { type: flag.type, note: flag.note }); setFlag({ open: false, type: 'MANUAL', note: '' }); await reload(); })}>Add signal</Button>
      </div>}
      {show && data.openCaseId && <FraudCase id={data.openCaseId} onClose={() => setShow(false)} onDecided={async () => { setShow(false); await reload(); }} />}
    </Card>
  );
}
