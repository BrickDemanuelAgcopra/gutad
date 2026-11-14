'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface Row { id: string; name: string; city: string; status: string; isPaused: boolean; pausedReason: string | null; pausedUntil: string | null; platformOperated: boolean; regionId: string | null; regionName: string | null; readinessApprovedAt: string | null; rampUntil: string | null; acceptsKiosk: boolean; acceptsDelivery: boolean; acceptsPickup: boolean; acceptsDineIn: boolean }

export default function Locations() {
  const { can } = useSession();
  const [f, setF] = useState({ q: '', regionId: '', status: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, reload } = useApi<Row[]>(`/admin/locations?${qs}`, { deps: [qs] });
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const { run, error } = useAction();
  const [picked, setPicked] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const emergency = (body: Record<string, unknown>, what: string) => { const reason = askReason(`emergency pause of ${what}`); if (reason) run(async () => { const r = await api.post<{ paused: number }>('/admin/locations/emergency-pause', { ...body, reason }); setInfo(`Paused ${r.paused} location(s). A critical alert was raised.`); setPicked([]); reload(); }); };
  return (
    <div className="space-y-4">
      <SectionTitle title="Locations" hint="Status, channels, region and launch readiness for every location. Emergency pause stops new orders immediately; restart reopens gradually." />
      {error && <Alert>{error}</Alert>}{info && <Alert tone="info">{info}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <Input placeholder="Search name or city" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}><option value="">All regions</option>{regions?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{['CLAIMED', 'VERIFIED', 'ONBOARDING', 'LIVE', 'PAUSED', 'SUSPENDED'].map((s) => <option key={s}>{s}</option>)}</Select>
        {can('ops.manage') && <Button variant="danger" disabled={!picked.length} onClick={() => emergency({ locationIds: picked }, `${picked.length} location(s)`)}>Emergency pause selected</Button>}
        {can('ops.manage') && f.regionId && <Button variant="danger" onClick={() => emergency({ regionId: f.regionId }, 'the whole region')}>Pause whole region</Button>}
      </div>
      <Table rows={data || []} empty="No locations." cols={[
        { key: 'x', label: '', render: (l) => <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((p) => p !== l.id))} /> },
        { key: 'n', label: 'Location', render: (l) => <Link className="underline" href={`/admin/locations/${l.id}`}>{l.name}<span className="block text-xs text-ink-500 no-underline">{l.city}{l.regionName ? ` · ${l.regionName}` : ''}</span></Link> },
        { key: 's', label: 'Status', render: (l) => <span className="flex flex-wrap gap-1"><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.isPaused && <Badge tone="bad">paused</Badge>}{l.rampUntil && new Date(l.rampUntil) > new Date() && <Badge tone="warn">ramping</Badge>}{l.platformOperated && <Badge tone="good">Gutad</Badge>}</span> },
        { key: 'c', label: 'Channels', render: (l) => <span className="text-xs">{[l.acceptsPickup && 'pickup', l.acceptsDelivery && 'delivery', l.acceptsDineIn && 'dine-in', l.acceptsKiosk && 'kiosk'].filter(Boolean).join(' · ')}</span> },
        { key: 'r', label: 'Readiness', render: (l) => l.readinessApprovedAt ? <span className="text-xs text-emerald-700">approved {when(l.readinessApprovedAt)}</span> : <span className="text-xs text-ink-500">not approved</span> },
        { key: 'p', label: 'Pause reason', render: (l) => <span className="text-xs">{l.pausedReason}{l.pausedUntil ? ` · until ${when(l.pausedUntil)}` : ''}</span> },
      ]} />
      <Card title="How restarts work"><p className="text-sm text-ink-500">Restarting a paused location (from its page) resumes orders with a lower temporary throttle — a third of the normal one by default — for the ramp period, then the regular throttle applies again. After an emergency pause only Gutad operations can restart.</p></Card>
    </div>
  );
}
