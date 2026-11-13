'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Tabs, Textarea, statusTone } from '@/components/ui';
import { useMerchant } from '../context';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SettingsPage() {
  const { loc, org, reload } = useMerchant();
  const [tab, setTab] = useState('location');
  if (!loc || !org) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <Tabs tabs={[{ id: 'location', label: 'Location' }, { id: 'hours', label: 'Hours' }, { id: 'publish', label: 'Publishing & QR' }, { id: 'floor', label: 'Floor & shifts' }, { id: 'policy', label: 'Booking policy' }, { id: 'delivery', label: 'Delivery' }, { id: 'team', label: 'Team' }, { id: 'devices', label: 'Devices & POS' }, { id: 'brands', label: 'Brands' }]} active={tab} onChange={setTab} />
      {tab === 'location' && <LocationTab loc={loc} reload={reload} />}
      {tab === 'hours' && <HoursTab locId={loc.id} />}
      {tab === 'publish' && <PublishTab locId={loc.id} />}
      {tab === 'floor' && <FloorTab locId={loc.id} />}
      {tab === 'policy' && <PolicyTab locId={loc.id} />}
      {tab === 'delivery' && <><FleetCard loc={loc} reload={reload} /><ZonesTab locId={loc.id} /></>}
      {tab === 'team' && <TeamTab orgId={org.id} members={org.members} locations={org.locations} reload={reload} />}
      {tab === 'devices' && <DevicesTab locId={loc.id} orgId={org.id} />}
      {tab === 'brands' && <BrandsTab orgId={org.id} brands={org.brands} kitchenId={loc.kitchenId} reload={reload} />}
    </div>
  );
}

function LocationTab({ loc, reload }: { loc: { id: string; status: string }; reload: () => void }) {
  const { data: full } = useApi<Record<string, unknown>>(`/public/locations/${loc.id}`);
  const [f, setF] = useState<Record<string, unknown> | null>(null);
  const { run, error } = useAction();
  const v = f || (full ? { name: full.name, description: full.description || '', phone: full.phone || '', cuisine: (full.cuisine as string[]).join(', '), heroImageUrl: full.heroImageUrl || '', acceptsPickup: full.acceptsPickup, acceptsDelivery: full.acceptsDelivery, acceptsReservations: full.acceptsReservations, acceptsEvents: full.acceptsEvents, acceptsCatering: full.acceptsCatering, defaultPrepMinutes: full.defaultPrepMinutes, minOrderCents: full.minOrderCents, taxRateBps: (full as { taxRateBps?: number }).taxRateBps ?? 800, orderThrottlePer15m: '' } : null);
  if (!v) return null;
  return (
    <Card title="Location details" action={<Badge tone={statusTone(loc.status)}>{loc.status}</Badge>}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Name" value={String(v.name)} onChange={(e) => setF({ ...v, name: e.target.value })} />
        <Input label="Phone" value={String(v.phone)} onChange={(e) => setF({ ...v, phone: e.target.value })} />
        <Input label="Cuisine (comma separated)" value={String(v.cuisine)} onChange={(e) => setF({ ...v, cuisine: e.target.value })} />
        <Input label="Hero image URL" value={String(v.heroImageUrl)} onChange={(e) => setF({ ...v, heroImageUrl: e.target.value })} />
        <Input label="Default prep minutes" type="number" value={Number(v.defaultPrepMinutes)} onChange={(e) => setF({ ...v, defaultPrepMinutes: Number(e.target.value) })} />
        <Input label="Minimum order (cents)" type="number" value={Number(v.minOrderCents)} onChange={(e) => setF({ ...v, minOrderCents: Number(e.target.value) })} />
        <Input label="Tax rate (bps, 888 = 8.88%)" type="number" value={Number(v.taxRateBps)} onChange={(e) => setF({ ...v, taxRateBps: Number(e.target.value) })} />
        <Input label="Throttle: max orders per 15 min (blank = off)" value={String(v.orderThrottlePer15m ?? '')} onChange={(e) => setF({ ...v, orderThrottlePer15m: e.target.value })} />
      </div>
      <Textarea className="mt-2" label="Description" value={String(v.description)} onChange={(e) => setF({ ...v, description: e.target.value })} />
      <div className="mt-2 flex flex-wrap gap-4 text-sm">{(['acceptsPickup', 'acceptsDelivery', 'acceptsReservations', 'acceptsEvents', 'acceptsCatering'] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={!!v[k]} onChange={(e) => setF({ ...v, [k]: e.target.checked })} /> {k.replace('accepts', '')}</label>)}</div>
      {error && <Alert>{error}</Alert>}
      <div className="mt-3 flex gap-2">
        <Button onClick={() => run(async () => { await api.patch(`/locations/${loc.id}`, { ...v, cuisine: String(v.cuisine).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), orderThrottlePer15m: v.orderThrottlePer15m ? Number(v.orderThrottlePer15m) : null }); reload(); })}>Save</Button>
        {loc.status === 'VERIFIED' && <Button variant="secondary" onClick={() => run(async () => { await api.post(`/locations/${loc.id}/status`, { status: 'LIVE' }); reload(); })}>Go live</Button>}
        {loc.status === 'CLAIMED' && <span className="text-xs text-ink-500">Awaiting platform verification before you can go live. <a className="underline" href="/merchant/onboarding">Onboarding status</a></span>}
      </div>
    </Card>
  );
}

function HoursTab({ locId }: { locId: string }) {
  const { data } = useApi<{ hours: { dayOfWeek: number; opens: string; closes: string }[] }>(`/public/locations/${locId}`);
  const [rows, setRows] = useState<{ dayOfWeek: number; opens: string; closes: string }[] | null>(null);
  const { run, error } = useAction();
  const h = rows || data?.hours || [];
  return (
    <Card title="Opening hours">
      {DAYS.map((d, i) => { const r = h.filter((x) => x.dayOfWeek === i); return <div key={d} className="flex items-center gap-2 py-1 text-sm"><span className="w-10">{d}</span>{r.map((x, j) => <span key={j} className="flex items-center gap-1"><Input type="time" value={x.opens} onChange={(e) => setRows(h.map((y) => (y === x ? { ...y, opens: e.target.value } : y)))} /> – <Input type="time" value={x.closes} onChange={(e) => setRows(h.map((y) => (y === x ? { ...y, closes: e.target.value } : y)))} /><Button size="sm" variant="ghost" onClick={() => setRows(h.filter((y) => y !== x))}>✕</Button></span>)}<Button size="sm" variant="ghost" onClick={() => setRows([...h, { dayOfWeek: i, opens: '11:00', closes: '22:00' }])}>+ range</Button></div>; })}
      {error && <Alert>{error}</Alert>}
      <Button className="mt-2" onClick={() => run(() => api.patch(`/locations/${locId}/hours`, { hours: h }))}>Save hours</Button>
    </Card>
  );
}

function PublishTab({ locId }: { locId: string }) {
  const { data, reload } = useApi<{ id: string; kind: string; channel: string; slug: string; url: string; isActive: boolean; partnerName: string | null }[]>(`/locations/${locId}/publications`);
  const [qr, setQr] = useState<Record<string, string>>({});
  const { run } = useAction();
  useEffect(() => { data?.forEach((p) => { if (p.kind === 'QR' && !qr[p.id]) QRCode.toDataURL(p.url, { width: 160 }).then((d) => setQr((q) => ({ ...q, [p.id]: d }))); }); }, [data, qr]);
  return (
    <Card title="Entry points (origin is tracked from entry through billing)">
      <div className="space-y-2">{data?.map((p) => <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 text-sm"><div><b>{p.kind}</b> <Badge tone="info">{p.channel}</Badge> {p.partnerName && `· ${p.partnerName}`}<div className="break-all text-xs text-ink-500">{p.url}</div>{p.kind === 'BOOKING_WIDGET' && <code className="text-[10px]">{`<iframe src="${p.url}" width="100%" height="640"></iframe>`}</code>}</div><div className="flex items-center gap-2">{qr[p.id] && <img src={qr[p.id]} alt="QR" className="h-16 w-16" />}<Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(p.url)}>Copy</Button><Button size="sm" variant="ghost" onClick={() => run(async () => { await api.patch(`/publications/${p.id}`, { isActive: !p.isActive }); reload(); })}>{p.isActive ? 'Disable' : 'Enable'}</Button></div></div>)}</div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={() => run(async () => { await api.post(`/locations/${locId}/publications`, { kind: 'QR', channel: 'QR' }); reload(); })}>+ QR code</Button>
        <Button variant="secondary" onClick={() => run(async () => { await api.post(`/locations/${locId}/publications`, { kind: 'BRANDED_SITE', channel: 'DIRECT' }); reload(); })}>+ Branded order link</Button>
        <Button variant="secondary" onClick={() => { const n = prompt('Partner name'); const u = prompt('Partner URL (https://…)'); if (n && u) run(async () => { await api.post(`/locations/${locId}/publications`, { kind: 'PARTNER_LINK', channel: 'PARTNER', partnerName: n, partnerUrl: u }); reload(); }); }}>+ Partner delivery link</Button>
      </div>
    </Card>
  );
}

function FloorTab({ locId }: { locId: string }) {
  const { data, reload } = useApi<{ rooms: { id: string; name: string }[]; tables: { id: string; name: string; roomId: string | null; minSeats: number; maxSeats: number }[]; combinations: { id: string; name: string; tableIds: string[] }[] }>(`/locations/${locId}/floor`);
  const { data: page } = useApi<{ diningShifts: { id: string; name: string; startTime: string; endTime: string; maxPartySize: number; daysOfWeek: number[] }[] }>(`/public/locations/${locId}`);
  const [room, setRoom] = useState({ name: 'Main dining', tables: 'T1 2-4\nT2 2-4\nT3 1-2' });
  const [shift, setShift] = useState({ name: 'Dinner', startTime: '17:00', endTime: '22:00', maxPartySize: '8', maxCoversPerSlot: '20' });
  const { run, error } = useAction();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Floor plan">
        <ul className="text-sm">{data?.rooms.map((r) => <li key={r.id}><b>{r.name}</b>: {data.tables.filter((t) => t.roomId === r.id).map((t) => `${t.name} (${t.minSeats}–${t.maxSeats})`).join(', ')}</li>)}{data?.combinations.map((c) => <li key={c.id} className="text-ink-500">combo {c.name}</li>)}</ul>
        <Input className="mt-2" label="Add room" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} />
        <Textarea label="Tables: Name min-max per line" value={room.tables} onChange={(e) => setRoom({ ...room, tables: e.target.value })} />
        {error && <Alert>{error}</Alert>}
        <Button className="mt-2" onClick={() => run(async () => { await api.post(`/locations/${locId}/floor`, { rooms: [{ name: room.name, tables: room.tables.split('\n').filter(Boolean).map((l) => { const [n, r] = l.trim().split(/\s+/); const [mn, mx] = (r || '2-4').split('-').map(Number); return { name: n, minSeats: mn, maxSeats: mx }; }) }] }); reload(); })}>Add room & tables</Button>
      </Card>
      <Card title="Shifts (pacing & turn times)">
        <ul className="text-sm">{page?.diningShifts.map((s) => <li key={s.id}>{s.name} {s.startTime}–{s.endTime} · max party {s.maxPartySize} · days {s.daysOfWeek.map((d) => DAYS[d]).join('')}</li>)}</ul>
        <div className="mt-2 grid grid-cols-2 gap-2"><Input label="Name" value={shift.name} onChange={(e) => setShift({ ...shift, name: e.target.value })} /><Input label="Max party" value={shift.maxPartySize} onChange={(e) => setShift({ ...shift, maxPartySize: e.target.value })} /><Input label="Start" type="time" value={shift.startTime} onChange={(e) => setShift({ ...shift, startTime: e.target.value })} /><Input label="End" type="time" value={shift.endTime} onChange={(e) => setShift({ ...shift, endTime: e.target.value })} /><Input label="Max covers per slot" value={shift.maxCoversPerSlot} onChange={(e) => setShift({ ...shift, maxCoversPerSlot: e.target.value })} /></div>
        <Button className="mt-2" onClick={() => run(() => api.post(`/locations/${locId}/shifts`, { ...shift, maxPartySize: Number(shift.maxPartySize), maxCoversPerSlot: Number(shift.maxCoversPerSlot) }))}>Add shift</Button>
      </Card>
    </div>
  );
}

function PolicyTab({ locId }: { locId: string }) {
  const [p, setP] = useState({ cancellationHours: 2, requiresCardAbove: 6, noShowFeeCents: 2500, depositCents: 0, largePartyThreshold: 8, holdMinutes: 10, reminderHoursBefore: 24 });
  const [blackout, setBlackout] = useState('');
  const { run, error } = useAction();
  return (
    <Card title="Booking policy">
      <div className="grid gap-2 sm:grid-cols-3">{(Object.keys(p) as (keyof typeof p)[]).map((k) => <Input key={k} label={k} type="number" value={p[k]} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} />)}</div>
      {error && <Alert>{error}</Alert>}
      <Button className="mt-2" onClick={() => run(() => api.patch(`/locations/${locId}/reservation-policy`, p))}>Save policy</Button>
      <div className="mt-4 flex items-end gap-2"><Input label="Blackout date" type="date" value={blackout} onChange={(e) => setBlackout(e.target.value)} /><Button variant="secondary" onClick={() => run(() => api.post(`/locations/${locId}/blackouts`, { date: blackout, reason: 'Closed' }))}>Add blackout</Button></div>
    </Card>
  );
}

const FLEETS: Record<string, { label: string; detail: string }> = {
  PLATFORM: { label: 'Gutad couriers', detail: 'Couriers hired or contracted by Gutad collect and deliver your orders.' },
  PARTNER: { label: 'Gutad delivery partners', detail: 'Gutad books a partner courier (for example DoorDash Drive or Uber Direct) for each order.' },
  MERCHANT: { label: 'Your own staff', detail: 'Your staff deliver orders and update their status in the Delivery screen. Needs Gutad approval.' },
};

/** Who delivers is set by Gutad; merchants request a change and platform staff approve it. */
function FleetCard({ loc, reload }: { loc: { id: string; deliveryFleet: string; deliveryFleetRequested: string | null; deliveryFleetRequestedAt: string | null }; reload: () => void }) {
  const [fleet, setFleet] = useState('');
  const [note, setNote] = useState('');
  const { run, error } = useAction();
  const cur = FLEETS[loc.deliveryFleet];
  return (
    <Card title="Who delivers your orders" className="mb-4">
      <p className="text-sm"><b>{cur?.label || loc.deliveryFleet}</b> <span className="text-ink-500">{cur?.detail}</span></p>
      {loc.deliveryFleetRequested ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="info">Pending</Badge> You asked to switch to <b>{FLEETS[loc.deliveryFleetRequested]?.label}</b>{loc.deliveryFleetRequestedAt ? ` on ${new Date(loc.deliveryFleetRequestedAt).toLocaleDateString()}` : ''}. Gutad will review it.
          <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.delete(`/locations/${loc.id}/delivery-fleet-request`); reload(); })}>Withdraw</Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <Select label="Request a change" value={fleet} onChange={(e) => setFleet(e.target.value)}><option value="">Choose…</option>{Object.entries(FLEETS).filter(([k]) => k !== loc.deliveryFleet).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          <Input label="Reason (helps approval)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. we employ two insured drivers" />
          <Button disabled={!fleet} onClick={() => run(async () => { await api.post(`/locations/${loc.id}/delivery-fleet-request`, { fleet, note: note || undefined }); setFleet(''); setNote(''); reload(); })}>Send request</Button>
        </div>
      )}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </Card>
  );
}

function ZonesTab({ locId }: { locId: string }) {
  const { data, reload } = useApi<{ id: string; name: string; feeCents: number; minOrderCents: number; etaMinutes: number; isActive: boolean }[]>(`/locations/${locId}/delivery-zones`);
  const [z, setZ] = useState({ name: '', fee: '3.99', min: '15', eta: '40', polygon: '' });
  const { run, error } = useAction();
  return (
    <Card title="Delivery zones (polygon or radius fallback)">
      <p className="mb-2 text-xs text-ink-500">Zones set where you deliver and the minimum order. Customers currently pay a $0 delivery fee on Gutad; the zone fee is kept as your list price.</p>
      <ul className="text-sm">{data?.map((x) => <li key={x.id}>{x.name} · ${(x.feeCents / 100).toFixed(2)} · min ${(x.minOrderCents / 100).toFixed(2)} · {x.etaMinutes} min {!x.isActive && <Badge tone="bad">off</Badge>}</li>)}</ul>
      <div className="mt-2 grid gap-2 sm:grid-cols-4"><Input label="Name" value={z.name} onChange={(e) => setZ({ ...z, name: e.target.value })} /><Input label="Fee (USD)" value={z.fee} onChange={(e) => setZ({ ...z, fee: e.target.value })} /><Input label="Min order (USD)" value={z.min} onChange={(e) => setZ({ ...z, min: e.target.value })} /><Input label="ETA minutes" value={z.eta} onChange={(e) => setZ({ ...z, eta: e.target.value })} /></div>
      <Textarea className="mt-2" label="GeoJSON polygon (optional; leave blank to use the location radius)" value={z.polygon} onChange={(e) => setZ({ ...z, polygon: e.target.value })} rows={2} />
      {error && <Alert>{error}</Alert>}
      <Button className="mt-2" disabled={!z.name} onClick={() => run(async () => { await api.post(`/locations/${locId}/delivery-zones`, { name: z.name, feeCents: Math.round(Number(z.fee) * 100), minOrderCents: Math.round(Number(z.min) * 100), etaMinutes: Number(z.eta), polygon: z.polygon ? JSON.parse(z.polygon) : undefined }); reload(); })}>Add zone</Button>
    </Card>
  );
}

function TeamTab({ orgId, members, locations, reload }: { orgId: string; members: { id: string; email: string; role: string; locationIds: string[] }[]; locations: { id: string; name: string }[]; reload: () => void }) {
  const [m, setM] = useState({ email: '', role: 'MERCHANT_STAFF', locationId: '' });
  const { run, error } = useAction();
  return (
    <Card title="Team & roles (location-scoped)">
      <ul className="text-sm">{members.map((x) => <li key={x.id} className="flex justify-between py-1"><span>{x.email} · <Badge>{x.role}</Badge> {x.locationIds.length ? `· ${x.locationIds.length} location(s)` : '· all locations'}</span><Button size="sm" variant="ghost" onClick={() => run(async () => { await api.delete(`/organizations/${orgId}/members/${x.id}`); reload(); })}>Remove</Button></li>)}</ul>
      <div className="mt-2 grid gap-2 sm:grid-cols-4"><Input label="Email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} /><Select label="Role" value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })}>{['MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST', 'KITCHEN', 'PACKER', 'DISPATCHER'].map((r) => <option key={r}>{r}</option>)}</Select><Select label="Scope" value={m.locationId} onChange={(e) => setM({ ...m, locationId: e.target.value })}><option value="">All locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select><Button className="self-end" onClick={() => run(async () => { await api.post(`/organizations/${orgId}/members`, { email: m.email, role: m.role, locationIds: m.locationId ? [m.locationId] : [] }); setM({ ...m, email: '' }); reload(); })}>Invite</Button></div>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

function DevicesTab({ locId, orgId }: { locId: string; orgId: string }) {
  const { data: devices, reload } = useApi<{ id: string; kind: string; name: string; isOnline: boolean; lastHeartbeatAt: string | null }[]>(`/locations/${locId}/devices`);
  const { data: integrations, reload: reloadInt } = useApi<{ id: string; type: string; provider: string; status: string; healthy: boolean; lastError: string | null }[]>(`/organizations/${orgId}/integrations`);
  const [token, setToken] = useState<string | null>(null);
  const [wh, setWh] = useState<{ id: string; secret: string } | null>(null);
  const { run, error } = useAction();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Devices (tablet, printer, KDS, host & packing screens)">
        <ul className="text-sm">{devices?.map((d) => <li key={d.id} className="flex justify-between py-1"><span>{d.name} <Badge>{d.kind}</Badge></span><Badge tone={d.isOnline ? 'good' : 'bad'}>{d.isOnline ? 'online' : 'offline'}</Badge></li>)}</ul>
        <div className="mt-2 flex gap-2">{['TABLET', 'PRINTER', 'KDS', 'HOST_SCREEN', 'PACKING_SCREEN'].map((k) => <Button key={k} size="sm" variant="secondary" onClick={() => run(async () => { const d = await api.post<{ token: string }>(`/locations/${locId}/devices`, { kind: k, name: `${k} ${Date.now() % 1000}` }); setToken(d.token); reload(); })}>+ {k}</Button>)}</div>
        {token && <Alert tone="info">Device token (shown once): <code className="break-all">{token}</code> — set it in the mobile app’s merchant/tablet mode. It heartbeats to <code>POST /devices/heartbeat</code>.</Alert>}
      </Card>
      <Card title="POS & partner integrations">
        <ul className="text-sm">{integrations?.map((i) => <li key={i.id} className="flex justify-between py-1"><span>{i.provider} <Badge>{i.type}</Badge> {i.lastError && <span className="text-xs text-red-600">{i.lastError}</span>}</span><Badge tone={i.healthy ? 'good' : statusTone(i.status)}>{i.status}</Badge></li>)}</ul>
        <div className="mt-2 flex gap-2">{['POS', 'PARTNER_API'].map((t) => <Button key={t} size="sm" variant="secondary" onClick={() => { const p = prompt('Provider name (e.g. toast, square, custom)', 'custom'); if (p) run(async () => { const r = await api.post<{ id: string; webhookSecret: string }>(`/organizations/${orgId}/integrations`, { locationId: locId, type: t, provider: p }); setWh({ id: r.id, secret: r.webhookSecret }); reloadInt(); }); }}>+ {t}</Button>)}</div>
        {wh && <Alert tone="info">Webhook URL: <code>{process.env.NEXT_PUBLIC_API_URL}/webhooks/integrations/{wh.id}</code><br />HMAC secret (shown once): <code className="break-all">{wh.secret}</code><br />Events: pos.check.closed, pos.item.86, pos.ticket.ack — sign the raw body with HMAC-SHA256 in <code>X-Signature</code>.</Alert>}
        {error && <Alert>{error}</Alert>}
      </Card>
    </div>
  );
}

function BrandsTab({ orgId, brands, kitchenId, reload }: { orgId: string; brands: { id: string; name: string }[]; kitchenId: string | null; reload: () => void }) {
  const [name, setName] = useState('');
  const [royalty, setRoyalty] = useState('0');
  const { run, error } = useAction();
  return (
    <Card title="Brands (virtual concepts produced in a shared kitchen)">
      <ul className="text-sm">{brands.map((b) => <li key={b.id} className="flex justify-between py-1"><span>{b.name}</span>{kitchenId && <Button size="sm" variant="ghost" onClick={() => run(() => api.post(`/kitchens/${kitchenId}/brands`, { brandId: b.id }))}>Link to kitchen</Button>}</li>)}</ul>
      <div className="mt-2 flex items-end gap-2"><Input label="Brand name" value={name} onChange={(e) => setName(e.target.value)} /><Input label="Creator royalty (bps)" value={royalty} onChange={(e) => setRoyalty(e.target.value)} /><Button onClick={() => run(async () => { await api.post(`/organizations/${orgId}/brands`, { name, royaltyBps: Number(royalty) }); setName(''); reload(); })}>Create</Button></div>
      {error && <Alert>{error}</Alert>}
      <p className="mt-2 text-xs text-ink-500">Create a menu per brand under Menu, pick the brand, and link it to your kitchen so customers can combine brands in one bag.</p>
    </Card>
  );
}
