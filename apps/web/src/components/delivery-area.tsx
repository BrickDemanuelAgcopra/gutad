'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';
import { TileMap } from '@/components/tile-map';

export interface Zone { id: string; locationId: string; name: string; kind: string; polygon: { coordinates: number[][][] } | null; feeCents: number; minOrderCents: number; etaMinutes: number; isActive: boolean; locationIds: string[]; travelMinutesPerKm: number | null; capacityPerHour: number | null; hours: { dayOfWeek: number; opens: string; closes: string }[] | null; feeTiers: { upToKm: number; feeCents: number }[] }
interface Area { location: { id: string; name: string; lat: number | null; lng: number | null; radiusKm: number; deliveryWindowMinutes: number | null; deliveryWindowCapacity: number | null }; zones: Zone[]; restrictions: { id: string; kind: string; value: number | null; reason: string; endsAt: string }[] }

const blank = { id: '', name: '', kind: 'SERVICE', fee: '', min: '', capacity: '', travel: '', opens: '', closes: '', tiers: '', shared: '' };

/** 15.1–15.3, 15.6, 15.7: draw service and exclusion zones on the map, with fees, tiers, capacity, hours and delivery windows. */
export function DeliveryAreaEditor({ locationId, siblings = [] }: { locationId: string; siblings?: { id: string; name: string }[] }) {
  const { data, reload } = useApi<Area>(`/locations/${locationId}/delivery-area`, { deps: [locationId] });
  const { run, error } = useAction();
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [f, setF] = useState(blank);
  const [win, setWin] = useState<{ len: string; cap: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  if (!data) return null;
  const loc = data.location;
  if (loc.lat == null || loc.lng == null) return <Alert>Set this location’s address coordinates before drawing delivery zones.</Alert>;
  const edit = (z: Zone) => { setDraft((z.polygon?.coordinates[0] || []).slice(0, -1) as [number, number][]); setF({ id: z.id, name: z.name, kind: z.kind, fee: String(z.feeCents / 100), min: String(z.minOrderCents / 100), capacity: z.capacityPerHour ? String(z.capacityPerHour) : '', travel: z.travelMinutesPerKm ? String(z.travelMinutesPerKm) : '', opens: z.hours?.[0]?.opens || '', closes: z.hours?.[0]?.closes || '', tiers: z.feeTiers.map((t) => `${t.upToKm}:${t.feeCents / 100}`).join(', '), shared: z.locationIds.join(',') }); };
  const save = () => run(async () => {
    if (draft.length < 3) throw new Error('Click at least three points on the map');
    const ring = [...draft, draft[0]];
    const tiers = f.tiers.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, d] = x.split(':'); return { upToKm: Number(k), feeCents: Math.round(Number(d) * 100) }; });
    await api.post(`/locations/${locationId}/delivery-zones`, { id: f.id || undefined, name: f.name, kind: f.kind, polygon: { type: 'Polygon', coordinates: [ring] }, feeCents: Math.round(Number(f.fee || 0) * 100), minOrderCents: Math.round(Number(f.min || 0) * 100), capacityPerHour: f.capacity ? Number(f.capacity) : null, travelMinutesPerKm: f.travel ? Number(f.travel) : null, hours: f.opens && f.closes ? [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opens: f.opens, closes: f.closes })) : null, feeTiers: tiers, locationIds: f.shared ? f.shared.split(',').filter(Boolean) : [] });
    setDraft([]); setF(blank); setOk('Zone saved.'); await reload();
  });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      {data.restrictions.length > 0 && <Alert tone="info">In force now: {data.restrictions.map((r) => `${r.kind.toLowerCase().replace('_', ' ')}${r.value ? ` ${r.value}` : ''} (${r.reason}, until ${when(r.endsAt)})`).join('; ')}</Alert>}
      <TileMap center={{ lat: loc.lat, lng: loc.lng }} zoom={13} draft={draft} onClick={(p) => setDraft([...draft, [p.lng, p.lat]])}
        circles={data.zones.some((z) => z.kind === 'SERVICE' && z.isActive) ? [] : [{ lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm }]}
        markers={[{ lat: loc.lat, lng: loc.lng, label: loc.name, color: '#f45d0a', size: 7 }]}
        polygons={data.zones.filter((z) => z.polygon).map((z) => ({ id: z.id, coords: z.polygon!.coordinates[0] as [number, number][], color: z.kind === 'EXCLUSION' ? '#dc2626' : z.locationId !== locationId ? '#0284c7' : '#059669', dashed: !z.isActive, label: z.name, fillOpacity: z.isActive ? 0.15 : 0.03 }))} />
      <p className="text-xs text-ink-500">Click the map to place corners ({draft.length} so far). Green: service zones · red: exclusions (no delivery inside) · blue: shared from another location · dashed: inactive. With no active service zone the dashed circle (the delivery radius) applies.</p>
      <Card title={f.id ? 'Edit zone' : 'New zone'}>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="SERVICE">Service area</option><option value="EXCLUSION">Exclusion (no delivery)</option></Select>
          <Input label="Fee $" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          <Input label="Minimum order $" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} />
          <Input label="Fee tiers (km:$, …)" placeholder="2:2.99, 4:4.99" value={f.tiers} onChange={(e) => setF({ ...f, tiers: e.target.value })} />
          <Input label="Deliveries per hour (blank = no cap)" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
          <Input label="Travel min per km (blank = 3)" value={f.travel} onChange={(e) => setF({ ...f, travel: e.target.value })} />
          <div className="grid grid-cols-2 gap-1"><Input label="Opens" placeholder="11:00" value={f.opens} onChange={(e) => setF({ ...f, opens: e.target.value })} /><Input label="Closes" placeholder="22:00" value={f.closes} onChange={(e) => setF({ ...f, closes: e.target.value })} /></div>
        </div>
        {siblings.length > 0 && <div className="mt-2 flex flex-wrap gap-3 text-sm"><span className="text-xs text-ink-500">Also serves:</span>{siblings.filter((x) => x.id !== locationId).map((x) => <label key={x.id} className="flex items-center gap-1"><input type="checkbox" checked={f.shared.split(',').includes(x.id)} onChange={(e) => setF({ ...f, shared: (e.target.checked ? [...f.shared.split(',').filter(Boolean), x.id] : f.shared.split(',').filter((y) => y && y !== x.id)).join(',') })} />{x.name}</label>)}</div>}
        <div className="mt-2 flex gap-2"><Button disabled={!f.name || draft.length < 3} onClick={save}>Save zone</Button><Button variant="ghost" onClick={() => { setDraft([]); setF(blank); }}>Clear</Button>{draft.length > 0 && <Button variant="ghost" onClick={() => setDraft(draft.slice(0, -1))}>Undo point</Button>}</div>
      </Card>
      <Table rows={data.zones} empty="No zones yet: the delivery radius applies." cols={[
        { key: 'n', label: 'Zone', render: (z) => <span>{z.name} {z.kind === 'EXCLUSION' && <Badge tone="bad">exclusion</Badge>}{z.locationId !== locationId && <Badge tone="info">shared</Badge>}</span> },
        { key: 'f', label: 'Fee / min', render: (z) => z.kind === 'EXCLUSION' ? '—' : `${money(z.feeCents)}${z.feeTiers.length ? ` (${z.feeTiers.length} tiers)` : ''} / ${money(z.minOrderCents)}` },
        { key: 'c', label: 'Capacity / hours', render: (z) => <span className="text-xs">{z.capacityPerHour ? `${z.capacityPerHour}/h` : 'no cap'} · {z.hours?.length ? `${z.hours[0].opens}–${z.hours[0].closes}` : 'all hours'}</span> },
        { key: 'a', label: 'Active', render: (z) => <Badge tone={z.isActive ? 'good' : 'neutral'}>{z.isActive ? 'on' : 'off'}</Badge> },
        { key: 'x', label: '', render: (z) => z.locationId === locationId ? <span className="flex gap-2"><button className="text-xs underline" onClick={() => edit(z)}>Edit</button><button className="text-xs underline" onClick={() => run(async () => { await api.post(`/locations/${locationId}/delivery-zones`, { ...z, isActive: !z.isActive }); await reload(); })}>{z.isActive ? 'Turn off' : 'Turn on'}</button></span> : null },
      ]} />
      <Card title="Scheduled delivery windows">
        <div className="flex flex-wrap items-end gap-2">
          <Input label="Window minutes" value={win?.len ?? String(loc.deliveryWindowMinutes ?? '')} placeholder="30" onChange={(e) => setWin({ len: e.target.value, cap: win?.cap ?? String(loc.deliveryWindowCapacity ?? '') })} />
          <Input label="Orders per window (blank = no limit)" value={win?.cap ?? String(loc.deliveryWindowCapacity ?? '')} onChange={(e) => setWin({ len: win?.len ?? String(loc.deliveryWindowMinutes ?? ''), cap: e.target.value })} />
          <Button size="sm" disabled={!win} onClick={() => run(async () => { await api.patch(`/locations/${locationId}`, { deliveryWindowMinutes: win?.len ? Number(win.len) : null, deliveryWindowCapacity: win?.cap ? Number(win.cap) : null }); setWin(null); setOk('Windows saved.'); await reload(); })}>Save</Button>
        </div>
      </Card>
    </div>
  );
}
