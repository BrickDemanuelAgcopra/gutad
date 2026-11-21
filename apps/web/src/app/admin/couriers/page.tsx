'use client';
import Link from 'next/link';
import { useState } from 'react';
import { COURIER_DOC_LABELS, VEHICLE_TYPES, type CourierDocKind } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Input, Select, statusTone, Table, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { DocLink } from '@/components/courier-docs';
import { ApplicationsPipeline } from '@/components/courier/admin';
import { FraudQueue } from '@/components/courier/fraud';

interface Row { id: string; name: string | null; email: string; status: string; operational: string; vehicleType: string; capabilities: string[]; activeJobs: number; missingDocs: string[]; pendingDocs: number; appealStatus: string; lastSeenAt: string | null; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }
const pct = (x: number | null | undefined) => (x == null ? '—' : `${x}%`);

export default function Couriers() {
  const [tab, setTab] = useState('directory');
  return (
    <div className="space-y-4">
      <SectionTitle title="Couriers" hint="Gutad fleet couriers: applications, status, documents, shifts, reliability, pay adjustments, fraud review, suspensions and appeals." />
      <Tabs tabs={[{ id: 'directory', label: 'Directory' }, { id: 'applications', label: 'Applications' }, { id: 'documents', label: 'Documents' }, { id: 'shifts', label: 'Shifts' }, { id: 'fraud', label: 'Fraud review' }]} active={tab} onChange={setTab} />
      {tab === 'directory' && <Directory />}
      {tab === 'applications' && <ApplicationsPipeline />}
      {tab === 'documents' && <Documents />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'fraud' && <FraudQueue />}
    </div>
  );
}

function Directory() {
  const [f, setF] = useState({ status: '', vehicleType: '', q: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data } = useApi<Row[]>(`/admin/couriers?${qs}`, { deps: [qs], poll: 30000 });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input label="Name or email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option>{['PENDING', 'APPROVED', 'SUSPENDED'].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select label="Vehicle" value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })}><option value="">Any</option>{VEHICLE_TYPES.map((s) => <option key={s}>{s}</option>)}</Select>
      </div>
      <Table rows={data || []} empty="No couriers." cols={[
        { key: 'n', label: 'Courier', render: (c) => <Link className="underline" href={`/admin/couriers/${c.id}`}>{c.name || c.email}<span className="block text-xs text-ink-500 no-underline">{c.email}</span></Link> },
        { key: 's', label: 'Status', render: (c) => <span><Badge tone={statusTone(c.status)}>{c.status}</Badge><Badge tone={c.operational === 'ONLINE' ? 'good' : c.operational === 'ON_DELIVERY' ? 'warn' : 'neutral'}>{c.operational.toLowerCase().replace('_', ' ')}</Badge>{c.appealStatus === 'PENDING' && <Badge tone="warn">appeal</Badge>}</span> },
        { key: 'v', label: 'Vehicle', render: (c) => <span className="text-xs">{c.vehicleType.toLowerCase()}{c.capabilities.length ? ` · ${c.capabilities.join(', ').toLowerCase()}` : ''}</span> },
        { key: 'd', label: 'Documents', render: (c) => c.missingDocs.length ? <span className="text-xs text-red-700">missing {c.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind]).join(', ')}</span> : <span className="text-xs text-emerald-700">complete</span> },
        { key: 'm', label: 'Accept / complete / on time', render: (c) => <span className="text-xs">{pct(c.metrics?.acceptanceRate)} / {pct(c.metrics?.completionRate)} / {pct(c.metrics?.onTimeRate)} · {c.metrics?.delivered ?? 0} delivered</span> },
        { key: 'l', label: 'Last seen', render: (c) => <span className="text-xs">{when(c.lastSeenAt)}</span> },
      ]} />
    </div>
  );
}

function Documents() {
  const { data, reload } = useApi<{ pending: { id: string; driverId: string; kind: string; fileUrl: string; fileId: string | null; expiresAt: string | null; courierName: string | null; courierEmail: string; createdAt: string }[]; expiring: { id: string; driverId: string; kind: string; expiresAt: string; courierName: string | null }[] }>('/admin/couriers/documents');
  const { can } = useSession();
  const { run, error } = useAction();
  const [exp, setExp] = useState<Record<string, string>>({});
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Table rows={data?.pending || []} empty="Nothing to review." cols={[
        { key: 'c', label: 'Courier', render: (d) => <Link className="underline" href={`/admin/couriers/${d.driverId}`}>{d.courierName || d.courierEmail}</Link> },
        { key: 'k', label: 'Document', render: (d) => <DocLink doc={d} label={COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind} /> },
        { key: 'e', label: 'Expires', render: (d) => <Input type="date" className="w-40" value={exp[d.id] ?? (d.expiresAt ? d.expiresAt.slice(0, 10) : '')} onChange={(e) => setExp({ ...exp, [d.id]: e.target.value })} /> },
        { key: 'a', label: '', render: (d) => can('delivery.manage') && <span className="flex gap-1"><Button size="sm" onClick={() => run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked', expiresAt: exp[d.id] ? new Date(`${exp[d.id]}T23:59:00Z`).toISOString() : undefined }); await reload(); })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => { const note = window.prompt('Why is it rejected? (shown to the courier)'); if (note) run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: false, note }); await reload(); }); }}>Reject</Button></span> },
      ]} />
      <h3 className="font-semibold">Expiring soon</h3>
      <Table rows={data?.expiring || []} empty="Nothing expiring in the warning window." cols={[{ key: 'c', label: 'Courier', render: (d) => <Link className="underline" href={`/admin/couriers/${d.driverId}`}>{d.courierName}</Link> }, { key: 'k', label: 'Document', render: (d) => COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind }, { key: 'e', label: 'Expires', render: (d) => when(d.expiresAt) }]} />
    </div>
  );
}

function Shifts() {
  const { data } = useApi<{ id: string; driverId: string; name: string | null; vehicleType: string; startsAt: string; endsAt: string }[]>('/admin/couriers/shifts?days=3');
  return <Table rows={data || []} empty="No shifts scheduled." cols={[{ key: 'c', label: 'Courier', render: (s) => <Link className="underline" href={`/admin/couriers/${s.driverId}`}>{s.name}</Link> }, { key: 'v', label: 'Vehicle', render: (s) => s.vehicleType.toLowerCase() }, { key: 's', label: 'From', render: (s) => when(s.startsAt) }, { key: 'e', label: 'To', render: (s) => when(s.endsAt) }]} />;
}
