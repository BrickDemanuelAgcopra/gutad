'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, statusTone, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';
import { ChecklistCard, ClosuresCard, OperationsCard, type Checklist, type Closure, type LocFields } from '@/components/location-admin';

interface Detail {
  location: LocFields & { name: string; organizationId: string; addressLine1: string; city: string; region: string; postalCode: string; lat: number | null; lng: number | null; phone: string | null; email: string | null; status: string; pausedUntil: string | null; rampUntil: string | null; rampThrottlePer15m: number | null; kitchenId: string | null; platformOperated: boolean };
  region: { name: string } | null;
  hours: { dayOfWeek: number; opens: string; closes: string; service: string }[];
  closures: Closure[];
  kitchen: { id: string; name: string } | null;
  stations: { id: string; code: string; name: string; maxConcurrent: number | null; isAvailable: boolean; equipment: string[] }[];
  menus: { id: string; name: string; brandName: string | null; isActive: boolean; channels: string[]; items: number; soldOut: number; availableFrom: string | null; availableUntil: string | null }[];
  brands: { id: string; name: string; ownershipType: string; rightsStatus: string; authorizedHere: boolean; blockedReason: string | null }[];
  checklist: Checklist;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One location: details, contacts, hours & closures, channels, brands & menus, stations, launch checklist, pause & restart. */
export default function LocationAdmin() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/locations/${id}`);
  const { run, error } = useAction();
  const [ramp, setRamp] = useState({ throttle: '', minutes: '60' });
  const [st, setSt] = useState({ code: '', name: '', maxConcurrent: '' });
  if (!d) return null;
  const l = d.location;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><Link href="/admin/locations" className="text-xs text-ink-500 underline">← Locations</Link><h1 className="text-2xl font-bold">{l.name}</h1><p className="text-sm text-ink-500">{l.addressLine1}, {l.city} {l.region} {l.postalCode} · {l.timezone}{d.region ? ` · ${d.region.name}` : ''}{l.lat !== null ? ` · ${l.lat?.toFixed(4)}, ${l.lng?.toFixed(4)}` : ''}</p><Link className="text-xs underline" href={`/admin/merchants/${l.organizationId}`}>Merchant</Link></div>
        <div className="flex flex-wrap gap-1"><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.isPaused && <Badge tone="bad">paused</Badge>}{l.rampUntil && new Date(l.rampUntil) > new Date() && <Badge tone="warn">ramping {l.rampThrottlePer15m}/15 min until {when(l.rampUntil)}</Badge>}</div>
      </div>
      {error && <Alert>{error}</Alert>}
      {can('ops.manage') && (
        <Card title="Pause & restart">
          {l.isPaused ? (
            <div className="space-y-2"><p className="text-sm">Paused: {l.pausedReason}{l.pausedUntil ? ` · until ${when(l.pausedUntil)}` : ''}</p><div className="flex flex-wrap items-end gap-2"><Input label="Ramp throttle (orders / 15 min)" value={ramp.throttle} placeholder="auto" onChange={(e) => setRamp({ ...ramp, throttle: e.target.value })} /><Input label="Ramp minutes" value={ramp.minutes} onChange={(e) => setRamp({ ...ramp, minutes: e.target.value })} /><Button onClick={() => { const reason = askReason('restarting this location'); if (reason) run(async () => { await api.post(`/locations/${id}/restart`, { reason, rampThrottlePer15m: ramp.throttle ? Number(ramp.throttle) : undefined, rampMinutes: Number(ramp.minutes) || 60 }); reload(); }); }}>Controlled restart</Button></div></div>
          ) : <Button variant="danger" onClick={() => { const reason = askReason('an emergency pause'); if (reason) run(async () => { await api.post('/admin/locations/emergency-pause', { locationIds: [id], reason }); reload(); }); }}>Emergency pause</Button>}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <OperationsCard key={JSON.stringify(l.contacts) + l.autoAccept} loc={l} onChange={reload} />
        <ChecklistCard locationId={id} checklist={d.checklist} onChange={reload} staff={can('merchants.manage') || can('ops.manage')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Regular hours">{d.hours.length ? <ul className="text-sm">{d.hours.map((h, i) => <li key={i}>{DAYS[h.dayOfWeek]} {h.opens}–{h.closes} <span className="text-xs text-ink-500">{h.service.toLowerCase()}</span></li>)}</ul> : <p className="text-sm text-ink-500">No hours set (treated as always open).</p>}</Card>
        <ClosuresCard locationId={id} closures={d.closures} onChange={reload} />
      </div>
      <Card title="Brands & menus offered here">
        <div className="mb-2 flex flex-wrap gap-2">{d.brands.map((b) => <span key={b.id} className="rounded-full border border-ink-100 px-2 py-0.5 text-xs">{b.name} · {b.ownershipType.toLowerCase().replace('_', ' ')}{!b.authorizedHere && ' · not authorized at this kitchen'}{b.blockedReason && <b className="text-red-700"> · {b.blockedReason}</b>}</span>)}</div>
        <Table rows={d.menus} cols={[{ key: 'n', label: 'Menu', render: (m) => <span>{m.name}{m.brandName && <span className="text-xs text-ink-500"> · {m.brandName}</span>}</span> }, { key: 'a', label: 'Active', render: (m) => m.isActive ? 'yes' : 'no' }, { key: 'c', label: 'Channels', render: (m) => <span className="text-xs">{m.channels.length ? m.channels.join(', ').toLowerCase() : 'all'}</span> }, { key: 'w', label: 'Daypart', render: (m) => <span className="text-xs">{m.availableFrom || m.availableUntil ? `${m.availableFrom || '…'}–${m.availableUntil || '…'}` : 'all day'}</span> }, { key: 'i', label: 'Items', render: (m) => <span>{m.items}{m.soldOut ? <span className="text-xs text-red-700"> · {m.soldOut} sold out</span> : null}</span> }]} />
      </Card>
      {d.kitchen && (
        <Card title={`Stations · ${d.kitchen.name}`}>
          <Table rows={d.stations} cols={[{ key: 'c', label: 'Code', render: (s) => s.code }, { key: 'n', label: 'Name', render: (s) => s.name }, { key: 'm', label: 'Capacity', render: (s) => s.maxConcurrent ? `${s.maxConcurrent} tickets` : 'no limit' }, { key: 'e', label: 'Equipment', render: (s) => <span className="text-xs">{s.equipment.join(', ') || '—'}</span> }, { key: 'a', label: 'Available', render: (s) => <button className={`text-xs underline ${s.isAvailable ? '' : 'text-red-700'}`} onClick={() => run(async () => { await api.post(`/kitchens/${d.kitchen!.id}/stations`, { id: s.id, code: s.code, name: s.name, maxConcurrent: s.maxConcurrent, equipment: s.equipment, isAvailable: !s.isAvailable }); reload(); })}>{s.isAvailable ? 'available' : 'down'}</button> }]} />
          <div className="mt-2 grid grid-cols-[100px_1fr_140px_auto] gap-2"><Input placeholder="Code" value={st.code} onChange={(e) => setSt({ ...st, code: e.target.value })} /><Input placeholder="Name" value={st.name} onChange={(e) => setSt({ ...st, name: e.target.value })} /><Input placeholder="Max tickets" value={st.maxConcurrent} onChange={(e) => setSt({ ...st, maxConcurrent: e.target.value })} /><Button size="sm" onClick={() => run(async () => { await api.post(`/kitchens/${d.kitchen!.id}/stations`, { code: st.code, name: st.name, maxConcurrent: st.maxConcurrent ? Number(st.maxConcurrent) : null }); setSt({ code: '', name: '', maxConcurrent: '' }); reload(); })}>Add station</Button></div>
        </Card>
      )}
    </div>
  );
}
