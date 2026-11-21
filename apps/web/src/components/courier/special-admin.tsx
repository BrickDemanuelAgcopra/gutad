'use client';
import { useEffect, useState } from 'react';
import { CERTIFIABLE_CATEGORIES, CERTIFICATION_STATUS_LABELS, DEFAULT_SPECIAL, REFUSAL_LABELS, SPECIAL_CATEGORIES, SPECIAL_CATEGORY_LABELS, specialConfig, type CertificationStatus, type SpecialCategoriesConfig, type SpecialCategory } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';

// Courier Release 4 (staff side): certification review, a courier's certifications, the special-categories
// settings and the compliance report.

interface QueueRow { id: string; driverId: string; driverName: string; email: string; category: SpecialCategory; label: string; status: CertificationStatus; certificateUrl: string | null; certificateExpiresAt: string | null; trainingPassedAt: string | null; submittedAt: string | null; expiresAt: string | null; note: string | null; screeningPassed: boolean }
interface CourierCerts { certifications: { id: string | null; category: SpecialCategory; label: string; status: CertificationStatus; expiresAt: string | null; note: string | null; certificateUrl?: string | null; needs: string[] }[]; highValue: { eligible: boolean; reason: string | null; deliveries: number; minDeliveries: number } }

const tone = (s: CertificationStatus) => (s === 'ACTIVE' ? 'good' : s === 'PENDING' ? 'warn' : s === 'NONE' || s === 'TRAINING' ? 'neutral' : 'bad') as 'good' | 'warn' | 'neutral' | 'bad';

/** Admin → Couriers → Certifications: review uploaded certificates and screening-gated categories. */
export function CertificationQueue() {
  const [status, setStatus] = useState('PENDING');
  const { data, reload } = useApi<QueueRow[]>(`/admin/courier-certifications?status=${status}`);
  const { run, error, busy } = useAction();
  const decide = (r: QueueRow, decision: 'APPROVE' | 'REJECT' | 'REVOKE') => {
    const reason = askReason(`${decision.toLowerCase()} ${r.label} for ${r.driverName}`);
    if (!reason) return;
    void run(async () => { await api.post(`/admin/courier-certifications/${r.id}/decide`, { decision, reason }); await reload(); });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>{['PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED', 'REVOKED'].map((s) => <option key={s} value={s}>{CERTIFICATION_STATUS_LABELS[s as CertificationStatus]}</option>)}</Select></div>
      {error && <Alert>{error}</Alert>}
      <Table rows={data ?? []} empty="Nothing waiting for review." cols={[
        { key: 'c', label: 'Courier', render: (r) => <a className="underline" href={`/admin/couriers/${r.driverId}`}>{r.driverName}</a> },
        { key: 'cat', label: 'Category', render: (r) => r.label },
        { key: 'ev', label: 'Evidence', render: (r) => <div className="text-xs">{r.trainingPassedAt ? `Training passed ${when(r.trainingPassedAt)}` : 'No training'}{r.certificateUrl && <> · <a className="underline" href={r.certificateUrl} target="_blank" rel="noreferrer">certificate</a>{r.certificateExpiresAt ? ` (expires ${new Date(r.certificateExpiresAt).toLocaleDateString()})` : ''}</>}{r.category === 'SENSITIVE' && <> · screening {r.screeningPassed ? <Badge tone="good">passed</Badge> : <Badge tone="bad">not passed</Badge>}</>}</div> },
        { key: 's', label: 'Status', render: (r) => <div><Badge tone={tone(r.status)}>{CERTIFICATION_STATUS_LABELS[r.status]}</Badge>{r.expiresAt && r.status === 'ACTIVE' && <div className="text-xs text-ink-500">until {new Date(r.expiresAt).toLocaleDateString()}</div>}{r.note && <div className="text-xs text-ink-500">“{r.note}”</div>}</div> },
        { key: 'a', label: '', render: (r) => <div className="flex gap-1">{r.status === 'PENDING' && <><Button size="sm" disabled={busy} onClick={() => decide(r, 'APPROVE')}>Approve</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(r, 'REJECT')}>Reject</Button></>}{r.status === 'ACTIVE' && <Button size="sm" variant="danger" disabled={busy} onClick={() => decide(r, 'REVOKE')}>Revoke</Button>}</div> },
      ]} />
    </div>
  );
}

/** Courier page: certifications with grant / approve / revoke, and high-value eligibility. */
export function CourierCertificationsCard({ driverId }: { driverId: string }) {
  const { data, reload } = useApi<CourierCerts>(`/admin/couriers/${driverId}/certifications`);
  const [view, setView] = useState<CourierCerts | null>(null);
  const { run, error, busy } = useAction();
  const v = view ?? data;
  const act = (fn: () => Promise<CourierCerts>) => run(async () => { setView(await fn()); await reload(); });
  const decide = (id: string, decision: 'APPROVE' | 'REJECT' | 'REVOKE', label: string) => {
    const reason = askReason(`${decision.toLowerCase()} ${label}`);
    if (reason) void act(() => api.post(`/admin/courier-certifications/${id}/decide`, { decision, reason }));
  };
  const grant = (category: string, label: string) => {
    const reason = askReason(`granting ${label} directly`);
    if (reason) void act(() => api.post(`/admin/couriers/${driverId}/certifications`, { category, reason }));
  };
  return (
    <Card title="Special-category certifications">
      {error && <Alert>{error}</Alert>}
      <ul className="space-y-1 text-sm">{v?.certifications.map((c) => (
        <li key={c.category} className="flex flex-wrap items-center gap-2">
          <b className="w-44">{c.label}</b><Badge tone={tone(c.status)}>{CERTIFICATION_STATUS_LABELS[c.status]}</Badge>
          {c.expiresAt && c.status === 'ACTIVE' && <span className="text-xs text-ink-500">until {new Date(c.expiresAt).toLocaleDateString()}</span>}
          {c.certificateUrl && <a className="text-xs underline" href={c.certificateUrl} target="_blank" rel="noreferrer">certificate</a>}
          {!!c.needs.length && c.status !== 'ACTIVE' && <span className="text-xs text-ink-500">needs {c.needs.map((n) => n.toLowerCase().replace('_', ' ')).join(', ')}</span>}
          <span className="ml-auto flex gap-1">
            {c.status === 'PENDING' && c.id && <><Button size="sm" disabled={busy} onClick={() => decide(c.id!, 'APPROVE', c.label)}>Approve</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(c.id!, 'REJECT', c.label)}>Reject</Button></>}
            {c.status === 'ACTIVE' && c.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(c.id!, 'REVOKE', c.label)}>Revoke</Button>}
            {c.status !== 'ACTIVE' && c.status !== 'PENDING' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => grant(c.category, c.label)}>Grant</Button>}
          </span>
        </li>
      ))}</ul>
      {v && <p className="mt-2 text-xs text-ink-500">High-value orders: {v.highValue.eligible ? 'eligible' : `not eligible — ${v.highValue.reason}`} ({v.highValue.deliveries} deliveries).</p>}
    </Card>
  );
}

interface Report { from: string; to: string; categories: { category: SpecialCategory; label: string; jobs: number; delivered: number; refused: Record<string, number>; refusedTotal: number; idChecks: number; legacyIdChecks: number; breaches: number; awaitingReturn: number; premiumCents: number }[]; certifications: { pending: number; active: Record<string, number> } }

const num = (label: string, value: number, set: (n: number) => void, step = 1) => <Input label={label} type="number" step={step} value={String(value)} onChange={(e) => set(Number(e.target.value))} />;

/** Admin → Delivery → Special categories: settings and compliance. */
export function SpecialCategoriesTab() {
  const { data: settings, reload } = useApi<{ settings: Record<string, unknown> }>('/admin/settings');
  const [cfg, setCfg] = useState<SpecialCategoriesConfig>(DEFAULT_SPECIAL);
  const [days, setDays] = useState('30');
  const { data: report, reload: reloadReport } = useApi<Report>(`/admin/delivery/special/report?from=${encodeURIComponent(new Date(Date.now() - Number(days || 30) * 86400_000).toISOString())}`);
  const { run, error, busy } = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { if (settings) setCfg(specialConfig(settings.settings?.['delivery.special'] as Partial<SpecialCategoriesConfig> | undefined)); }, [settings]);
  const up = <K extends keyof SpecialCategoriesConfig>(k: K, patch: Partial<SpecialCategoriesConfig[K]>) => setCfg({ ...cfg, [k]: typeof cfg[k] === 'object' ? { ...(cfg[k] as object), ...patch } : patch });
  const save = () => {
    const reason = askReason('changing special-category rules');
    if (reason) void run(async () => { await api.post('/admin/settings', { key: 'delivery.special', value: cfg, reason }); setSaved('Saved.'); await reload(); });
  };
  return (
    <div className="space-y-4">
      <Card title="Compliance" action={<div className="flex items-end gap-2"><Select value={days} onChange={(e) => setDays(e.target.value)}>{['7', '30', '90'].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select><Button size="sm" variant="secondary" onClick={() => void run(async () => { await api.post('/admin/delivery/special/sweep', {}); await reloadReport(); })}>Run sweep</Button></div>}>
        <Table rows={report?.categories ?? []} cols={[
          { key: 'c', label: 'Category', render: (r) => <b>{r.label}</b> },
          { key: 'j', label: 'Jobs', render: (r) => `${r.delivered} / ${r.jobs} delivered` },
          { key: 'r', label: 'Refused', render: (r) => r.refusedTotal ? <span className="text-xs">{Object.entries(r.refused).map(([k, n]) => `${REFUSAL_LABELS[k as keyof typeof REFUSAL_LABELS] ?? k}: ${n}`).join(' · ')}</span> : '—' },
          { key: 'i', label: 'ID checks', render: (r) => (r.category === 'ALCOHOL' ? `${r.idChecks}${r.legacyIdChecks ? ` (${r.legacyIdChecks} without DOB)` : ''}` : '—') },
          { key: 'b', label: 'Breaches', render: (r) => (r.breaches ? <Badge tone="bad">{r.breaches}</Badge> : '—') },
          { key: 'w', label: 'Awaiting return', render: (r) => (r.awaitingReturn ? <Badge tone="warn">{r.awaitingReturn}</Badge> : '—') },
          { key: 'p', label: 'Premium paid', render: (r) => money(r.premiumCents) },
        ]} />
        {report && <p className="mt-2 text-xs text-ink-500">Certifications: {report.certifications.pending} waiting for review · active {CERTIFIABLE_CATEGORIES.map((c) => `${SPECIAL_CATEGORY_LABELS[c]} ${report.certifications.active[c] ?? 0}`).join(', ')}.</p>}
      </Card>
      <Card title="Rules">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert tone="good">{saved}</Alert>}
        <p className="mb-2 text-xs font-medium">Premium per delivery (cents)</p>
        <div className="grid gap-2 sm:grid-cols-5">{SPECIAL_CATEGORIES.map((c) => <div key={c}>{num(SPECIAL_CATEGORY_LABELS[c], cfg.premiumCents[c], (n) => setCfg({ ...cfg, premiumCents: { ...cfg.premiumCents, [c]: n } }))}</div>)}</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          {num('Certification valid (days)', cfg.certValidDays, (n) => setCfg({ ...cfg, certValidDays: n }))}
          {num('Return must be received within (h)', cfg.returnReceiveHours, (n) => setCfg({ ...cfg, returnReceiveHours: n }))}
        </div>
        <p className="mb-1 mt-3 text-xs font-medium">Alcohol</p>
        <div className="grid gap-2 sm:grid-cols-4">
          {num('Minimum age', cfg.alcohol.minAge, (n) => up('alcohol', { minAge: n }))}
          <Input label="Handoff from" type="time" value={cfg.alcohol.deliveryHours.start} onChange={(e) => up('alcohol', { deliveryHours: { ...cfg.alcohol.deliveryHours, start: e.target.value } })} />
          <Input label="Handoff until" type="time" value={cfg.alcohol.deliveryHours.end} onChange={(e) => up('alcohol', { deliveryHours: { ...cfg.alcohol.deliveryHours, end: e.target.value } })} />
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={cfg.alcohol.requireDob} onChange={(e) => up('alcohol', { requireDob: e.target.checked })} /> Require date of birth</label>
        </div>
        <p className="mb-1 mt-3 text-xs font-medium">Catering</p>
        <div className="grid gap-2 sm:grid-cols-4">
          {num('From order subtotal (cents)', cfg.catering.minSubtotalCents, (n) => up('catering', { minSubtotalCents: n }))}
          {num('Or from items', cfg.catering.minItems, (n) => up('catering', { minItems: n }))}
          {num('Setup pay per minute (cents)', cfg.catering.setupPerMinuteCents, (n) => up('catering', { setupPerMinuteCents: n }))}
          {num('Setup paid up to (min)', cfg.catering.maxSetupMinutes, (n) => up('catering', { maxSetupMinutes: n }))}
          {num('Offer scheduled orders ahead (min)', cfg.catering.dispatchLeadMinutes, (n) => up('catering', { dispatchLeadMinutes: n }))}
          <Input label="Vehicles (comma-separated)" value={cfg.catering.vehicleTypes.join(', ')} onChange={(e) => up('catering', { vehicleTypes: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={cfg.catering.setupRequired} onChange={(e) => up('catering', { setupRequired: e.target.checked })} /> Setup on every catering order</label>
        </div>
        <p className="mb-1 mt-3 text-xs font-medium">Pharmacy / sensitive · temperature · high value</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={cfg.sensitive.requireNameMatch} onChange={(e) => up('sensitive', { requireNameMatch: e.target.checked })} /> Recipient name must match</label>
          {num('Max transit (min)', cfg.tempControl.maxTransitMinutes, (n) => up('tempControl', { maxTransitMinutes: n }))}
          {num('Cold limit (°C)', cfg.tempControl.coldMaxC, (n) => up('tempControl', { coldMaxC: n }), 0.5)}
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={cfg.tempControl.requireReadings} onChange={(e) => up('tempControl', { requireReadings: e.target.checked })} /> Drop-off reading required</label>
          {num('High value from (cents)', cfg.highValue.thresholdCents, (n) => up('highValue', { thresholdCents: n }))}
          {num('Courier deliveries needed', cfg.highValue.minDeliveries, (n) => up('highValue', { minDeliveries: n }))}
          {num('Minimum rating', cfg.highValue.minRating, (n) => up('highValue', { minRating: n }), 0.1)}
          {num('Account age (days)', cfg.highValue.minAccountDays, (n) => up('highValue', { minAccountDays: n }))}
        </div>
        <Button className="mt-3" disabled={busy} onClick={save}>Save rules</Button>
      </Card>
    </div>
  );
}

interface ReturnRow { jobId: string; orderId: string | null; orderNumber: number | null; courierFirstName: string | null; categories: SpecialCategory[]; refusal: { reason: string; note?: string | null } | null; since: string }

/** Merchant kitchen: refused restricted orders coming back, confirmed on receipt. */
export function ReturnsCard({ locationId }: { locationId: string }) {
  const { data, reload } = useApi<ReturnRow[]>(`/locations/${locationId}/delivery-returns`, { poll: 15000 });
  const { run, error, busy } = useAction();
  if (!data?.length) return null;
  const confirm = (r: ReturnRow, sealIntact: boolean) => {
    const note = sealIntact ? undefined : window.prompt('What’s wrong with the seal?') ?? undefined;
    if (!sealIntact && !note) return;
    void run(async () => { await api.post(`/delivery-jobs/${r.jobId}/return-received`, { sealIntact, note }); await reload(); });
  };
  return (
    <Card title="Refused orders coming back">
      {error && <Alert>{error}</Alert>}
      <ul className="space-y-2 text-sm">{data.map((r) => (
        <li key={r.jobId} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
          <b>#{r.orderNumber ?? r.jobId.slice(0, 6)}</b>{r.categories.map((c) => <Badge key={c} tone="warn">{SPECIAL_CATEGORY_LABELS[c]}</Badge>)}
          <span className="text-xs">{r.refusal ? REFUSAL_LABELS[r.refusal.reason as keyof typeof REFUSAL_LABELS] ?? r.refusal.reason : 'Refused'}{r.courierFirstName ? ` · ${r.courierFirstName} is bringing it back` : ''} · {when(r.since)}</span>
          <span className="ml-auto flex gap-1"><Button size="sm" disabled={busy} onClick={() => confirm(r, true)}>Received, seal intact</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(r, false)}>Seal broken</Button></span>
        </li>
      ))}</ul>
    </Card>
  );
}
