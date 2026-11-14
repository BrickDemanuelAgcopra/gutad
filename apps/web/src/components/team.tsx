'use client';
import { useState } from 'react';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, statusTone, Table, Tabs } from '@/components/ui';

interface Eq { id: string; name: string; kind: string; stationCode: string | null; status: string; isAutomated: boolean; softwareVersion: string | null; softwareApproved: boolean | null; nextServiceDueAt: string | null; serviceDue: boolean; openTickets: number; kitchen: string }

/** Phase I team & equipment workspace for a location (merchant Team & equipment page). */
export function TeamWorkspace({ locationId, kitchenId, organizationId, members }: { locationId: string; kitchenId: string | null; organizationId: string; members: { id: string; email: string; role: string }[] }) {
  const [tab, setTab] = useState('attendance');
  return (
    <div className="space-y-4">
      <Tabs tabs={[{ id: 'attendance', label: 'Attendance & payroll' }, { id: 'shifts', label: 'Shifts & staffing' }, { id: 'skills', label: 'Skills' }, { id: 'labor', label: 'Labor vs volume' }, ...(kitchenId ? [{ id: 'equipment', label: 'Equipment' }] : []), { id: 'devices', label: 'Devices' }]} active={tab} onChange={setTab} />
      {tab === 'attendance' && <Attendance locationId={locationId} />}
      {tab === 'shifts' && <Shifts locationId={locationId} members={members} />}
      {tab === 'skills' && <Skills organizationId={organizationId} members={members} />}
      {tab === 'labor' && <Labor locationId={locationId} />}
      {tab === 'equipment' && kitchenId && <Equipment kitchenId={kitchenId} />}
      {tab === 'devices' && <Devices locationId={locationId} />}
    </div>
  );
}

function Attendance({ locationId }: { locationId: string }) {
  const { user } = useSession();
  const { data: me, reload: rm } = useApi<{ open: { clockInAt: string } | null }>('/attendance/me');
  const [r, setR] = useState({ from: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const { data, reload } = useApi<{ id: string; userId: string; name: string | null; email: string; clockInAt: string; clockOutAt: string | null; breakMinutes: number; hours: number; rateCents: number; approvedById: string | null }[]>(`/locations/${locationId}/timesheet?from=${r.from}&to=${r.to}T23:59:59Z`, { deps: [locationId, r.from, r.to] });
  const { run, error } = useAction();
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Card title="Me">{me?.open ? <div className="flex items-center gap-2"><span className="text-sm">Clocked in since {when(me.open.clockInAt)}</span><Button onClick={() => run(async () => { const b = window.prompt('Break minutes', '0'); await api.post('/attendance/clock-out', { breakMinutes: Number(b) || 0 }); await rm(); await reload(); })}>Clock out</Button></div> : <Button onClick={() => run(async () => { await api.post('/attendance/clock-in', { locationId }); await rm(); await reload(); })}>Clock in</Button>}</Card>
      <div className="flex flex-wrap items-end gap-2"><Input type="date" label="From" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /><Input type="date" label="To" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /><Button variant="secondary" onClick={() => run(() => downloadFile(`/locations/${locationId}/payroll.csv?from=${r.from}&to=${r.to}T23:59:59Z`, `payroll-${r.from}-${r.to}.csv`))}>Payroll export (CSV)</Button></div>
      <Table rows={data || []} empty="No hours recorded." cols={[
        { key: 'p', label: 'Person', render: (e) => e.name || e.email }, { key: 'i', label: 'In', render: (e) => <span className="text-xs">{when(e.clockInAt)}</span> }, { key: 'o', label: 'Out', render: (e) => <span className="text-xs">{e.clockOutAt ? when(e.clockOutAt) : <Badge tone="info">on shift</Badge>}</span> },
        { key: 'h', label: 'Hours', render: (e) => `${e.hours}${e.breakMinutes ? ` (−${e.breakMinutes}m)` : ''}` }, { key: 'r', label: 'Rate', render: (e) => money(e.rateCents) },
        { key: 'a', label: '', render: (e) => e.approvedById ? <Badge tone="good">approved</Badge> : e.clockOutAt && e.userId !== user?.id ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.patch(`/time-entries/${e.id}`, { approve: true }); await reload(); })}>Approve</Button> : null },
      ]} />
      <p className="text-xs text-ink-500">Only approved hours are paid; nobody approves their own hours. Overtime is paid above the weekly threshold.</p>
    </div>
  );
}

function Shifts({ locationId, members }: { locationId: string; members: { id: string; email: string; role: string }[] }) {
  const [date, setDate] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const { data: fc } = useApi<{ hours: { hour: number; expectedOrders: number; needed: number; scheduled: number; gap: number }[]; understaffedHours: number[] }>(`/locations/${locationId}/staffing-forecast?date=${date}`, { deps: [locationId, date] });
  const { data: shifts, reload } = useApi<{ id: string; name: string | null; email: string; stationCode: string | null; startsAt: string; endsAt: string }[]>(`/locations/${locationId}/staff-shifts?from=${date}&to=${date}T23:59:59Z`, { deps: [locationId, date] });
  const { run, error } = useAction();
  const [f, setF] = useState({ userId: '', from: '11:00', to: '17:00', station: '' });
  const active = (fc?.hours || []).filter((h) => h.expectedOrders > 0 || h.scheduled > 0);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Input type="date" label="Day" value={date} onChange={(e) => setDate(e.target.value)} />
      <Card title="Staffing forecast">
        <div className="flex flex-wrap gap-1">{active.map((h) => <div key={h.hour} className={`w-16 rounded border p-1 text-center text-xs ${h.gap < 0 ? 'border-red-300 bg-red-50' : 'border-ink-100'}`}><div className="font-semibold">{String(h.hour).padStart(2, '0')}:00</div><div>{h.expectedOrders} orders</div><div>{h.scheduled}/{h.needed} staff</div></div>)}{!active.length && <p className="text-sm text-ink-500">No order history for this weekday yet.</p>}</div>
        <p className="mt-1 text-xs text-ink-500">Needed staff = expected orders per hour ÷ orders one person handles per hour (setting).</p>
      </Card>
      <Card title="Shifts">
        <Table rows={shifts || []} empty="No shifts." cols={[{ key: 'p', label: 'Person', render: (s) => s.name || s.email }, { key: 't', label: 'Time', render: (s) => `${new Date(s.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }, { key: 's', label: 'Station', render: (s) => s.stationCode || '—' }, { key: 'x', label: '', render: (s) => <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/staff-shifts/${s.id}`); await reload(); })}>Cancel</button> }]} />
        <div className="mt-2 grid gap-2 sm:grid-cols-5"><Select label="Person" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.email} ({m.role.toLowerCase().replace('merchant_', '')})</option>)}</Select><Input label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /><Input label="Station (optional)" value={f.station} onChange={(e) => setF({ ...f, station: e.target.value.toUpperCase() })} /><Button className="self-end" disabled={!f.userId} onClick={() => run(async () => { await api.post('/staff-shifts', { locationId, userId: f.userId, startsAt: new Date(`${date}T${f.from}`).toISOString(), endsAt: new Date(`${date}T${f.to}`).toISOString(), stationCode: f.station || undefined }); await reload(); })}>Add shift</Button></div>
        <p className="mt-1 text-xs text-ink-500">Stations that require a skill only take people who hold it.</p>
      </Card>
    </div>
  );
}

function Skills({ organizationId, members }: { organizationId: string; members: { id: string; email: string }[] }) {
  const { data, reload } = useApi<{ userId: string; email: string; name: string | null; skill: string; certifiedAt: string; expiresAt: string | null; expired: boolean }[]>(`/organizations/${organizationId}/skills`, { deps: [organizationId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ userId: '', skill: '', expires: '' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No skills recorded." cols={[{ key: 'p', label: 'Person', render: (s) => s.name || s.email }, { key: 's', label: 'Skill', render: (s) => s.skill.toLowerCase().replace(/_/g, ' ') }, { key: 'c', label: 'Since', render: (s) => when(s.certifiedAt) }, { key: 'e', label: 'Expires', render: (s) => <span className={s.expired ? 'text-red-700' : ''}>{s.expiresAt ? when(s.expiresAt) : '—'}</span> }]} />
      <div className="grid gap-2 sm:grid-cols-4"><Select label="Person" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}</Select><Input label="Skill (e.g. GRILL_CERT, FOOD_HANDLER)" value={f.skill} onChange={(e) => setF({ ...f, skill: e.target.value.toUpperCase() })} /><Input type="date" label="Expires" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /><Button className="self-end" disabled={!f.userId || f.skill.length < 2} onClick={() => run(async () => { await api.post('/skills', { organizationId, userId: f.userId, skill: f.skill, expiresAt: f.expires ? new Date(`${f.expires}T23:59:00Z`).toISOString() : null }); setF({ userId: '', skill: '', expires: '' }); await reload(); })}>Record training</Button></div>
    </div>
  );
}

function Labor({ locationId }: { locationId: string }) {
  const { data } = useApi<{ day: string; orders: number; salesCents: number; laborHours: number; laborCents: number; ordersPerLaborHour: number | null; laborPctOfSales: number | null }[]>(`/locations/${locationId}/labor-report?days=14`, { deps: [locationId] });
  return <Table rows={data || []} empty="No data." cols={[{ key: 'd', label: 'Day', render: (x) => new Date(x.day).toLocaleDateString() }, { key: 'o', label: 'Orders', render: (x) => x.orders }, { key: 's', label: 'Sales', render: (x) => money(x.salesCents) }, { key: 'h', label: 'Labor hours', render: (x) => x.laborHours }, { key: 'c', label: 'Labor cost', render: (x) => money(x.laborCents) }, { key: 'p', label: 'Orders / labor hour', render: (x) => x.ordersPerLaborHour ?? '—' }, { key: 'l', label: 'Labor % of sales', render: (x) => (x.laborPctOfSales == null ? '—' : `${x.laborPctOfSales}%`) }]} />;
}

export function Equipment({ kitchenId }: { kitchenId?: string }) {
  const { data, reload } = useApi<Eq[]>(`/equipment${kitchenId ? `?kitchenId=${kitchenId}` : ''}`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ name: '', kind: '', station: '', automated: false, version: '', interval: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="info">{msg}</Alert>}
      <Table rows={data || []} empty="No equipment registered." cols={[
        { key: 'n', label: 'Equipment', render: (e) => <span>{e.name}<span className="block text-xs text-ink-500">{e.kind.toLowerCase()}{e.stationCode ? ` · station ${e.stationCode}` : ''}{kitchenId ? '' : ` · ${e.kitchen}`}</span></span> },
        { key: 's', label: 'Status', render: (e) => <Badge tone={e.status === 'OK' ? 'good' : e.status === 'DEGRADED' ? 'warn' : 'bad'}>{e.status}</Badge> },
        { key: 'v', label: 'Software', render: (e) => e.isAutomated ? <span className={e.softwareApproved === false ? 'text-red-700' : ''}>{e.softwareVersion || '—'}{e.softwareApproved === false ? ' (not approved)' : ''}</span> : '—' },
        { key: 'm', label: 'Service', render: (e) => <span className={e.serviceDue ? 'text-red-700' : 'text-xs'}>{e.nextServiceDueAt ? `due ${when(e.nextServiceDueAt)}` : '—'}{e.openTickets ? ` · ${e.openTickets} open ticket(s)` : ''}</span> },
        { key: 'x', label: '', render: (e) => kitchenId ? <span className="flex flex-wrap gap-1">{e.status === 'OK' ? <Button size="sm" variant="danger" onClick={() => { const note = window.prompt('What is wrong?'); if (note) run(async () => { const r = await api.post<{ outageState: { soldOutItemIds: string[] } | null }>(`/equipment/${e.id}/status`, { status: 'DOWN', note }); setMsg(`${e.name} marked down: ${r.outageState?.soldOutItemIds.length ?? 0} dish(es) paused.`); await reload(); }); }}>Report down</Button> : <Button size="sm" onClick={() => run(async () => { await api.post(`/equipment/${e.id}/status`, { status: 'OK', note: 'Back in service' }); setMsg(`${e.name} back in service; paused dishes restored.`); await reload(); })}>Back in service</Button>}<Button size="sm" variant="ghost" onClick={() => { const t = window.prompt('Service / maintenance needed'); if (t) run(async () => { await api.post(`/equipment/${e.id}/tickets`, { kind: 'SERVICE', title: t }); await reload(); }); }}>Service ticket</Button></span> : null },
      ]} />
      {kitchenId && <Card title="Register equipment">
        <div className="grid gap-2 sm:grid-cols-6"><Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Kind (GRILL, FRYER…)" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value.toUpperCase() })} /><Input label="Station" value={f.station} onChange={(e) => setF({ ...f, station: e.target.value.toUpperCase() })} /><Input label="Service every (days)" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} /><label className="flex items-center gap-1 self-end text-sm"><input type="checkbox" checked={f.automated} onChange={(e) => setF({ ...f, automated: e.target.checked })} /> Automated</label>{f.automated && <Input label="Software version" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />}</div>
        <Button className="mt-2" disabled={!f.name || !f.kind} onClick={() => run(async () => { await api.post('/equipment', { kitchenId, name: f.name, kind: f.kind, stationCode: f.station || null, isAutomated: f.automated, softwareVersion: f.version || null, serviceIntervalDays: f.interval ? Number(f.interval) : null }); setF({ name: '', kind: '', station: '', automated: false, version: '', interval: '' }); await reload(); })}>Register</Button>
        <p className="mt-1 text-xs text-ink-500">When equipment is down, dishes that need it come off the menu and its station closes (or runs at half capacity if other equipment works there). Automated equipment reports faults and versions; Gutad only records and escalates, it never sends commands.</p>
      </Card>}
    </div>
  );
}

export function Devices({ locationId }: { locationId?: string }) {
  const { data } = useApi<{ id: string; location: string; kind: string; name: string; isOnline: boolean; minutesSinceSeen: number | null; firmwareVersion: string | null; appVersion: string | null; lastError: string | null }[]>(`/devices/health${locationId ? `?locationId=${locationId}` : ''}`, { deps: [locationId], poll: 30000 });
  const off = (data || []).filter((d) => !d.isOnline).length;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3"><Stat label="Devices" value={data?.length ?? 0} /><Stat label="Offline" value={off} /><Stat label="With errors" value={(data || []).filter((d) => d.lastError).length} /></div>
      <Table rows={data || []} empty="No devices registered." cols={[{ key: 'n', label: 'Device', render: (d) => <span>{d.name}<span className="block text-xs text-ink-500">{d.kind.toLowerCase()}{locationId ? '' : ` · ${d.location}`}</span></span> }, { key: 's', label: 'Status', render: (d) => <Badge tone={d.isOnline ? 'good' : 'bad'}>{d.isOnline ? 'online' : 'offline'}</Badge> }, { key: 'l', label: 'Last seen', render: (d) => (d.minutesSinceSeen == null ? 'never' : `${d.minutesSinceSeen} min ago`) }, { key: 'v', label: 'Versions', render: (d) => <span className="text-xs">{d.firmwareVersion || '—'} / {d.appVersion || '—'}</span> }, { key: 'e', label: 'Last error', render: (d) => <span className="text-xs text-red-700">{d.lastError}</span> }]} />
    </div>
  );
}

export { statusTone };
