'use client';
import Link from 'next/link';
import { useState } from 'react';
import { HANDLING_LABELS, KITCHEN_REASONS, type HandlingFlag } from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { useCachedApi, useOfflineActions } from '@/lib/offline';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Table } from '@/components/ui';
import { PrintButton } from '@/components/capacity-printers';
import { CourierArrivals } from '@/components/courier-arrivals';

export interface KLine { id: string; menuItemId: string | null; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null; status: string; handling: string[]; brandId?: string | null }
export interface Ticket { id: string; orderId: string; stationCode: string | null; status: string; kind: string; orderNumber: string; promiseAt: string | null; fireAt: string | null; readyBy: string | null; cookMinutes: number | null; targetMinutes: number; fireState: 'HOLD' | 'FIRE'; minutesInProgress: number; delayed: boolean; fulfillmentType: string; tableNumber: string | null; lines: KLine[] }
export interface Pack { id: string; orderId: string; orderNumber: string; bagCode: string; status: string; verifiedLineIds: string[]; blockedReason: string | null; checklist: { key: string; label: string; done: boolean }[]; bagCount: number; bags: { n: number; code: string; handling: string[] }[]; handling: string[]; fulfillmentType: string; tableNumber: string | null; utensils: boolean; promiseAt: string | null; lines: KLine[] }

const hhmm = (d?: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
export const Flags = ({ flags }: { flags: string[] }) => <>{flags.map((f) => <Badge key={f} tone={f === 'ALLERGEN' ? 'bad' : f === 'HOT' ? 'warn' : 'info'}>{HANDLING_LABELS[f as HandlingFlag] || f}</Badge>)}</>;

/** Remake / missing / quality failure with a reason code (13.6). */
export function KitchenEventModal({ target, onClose, onDone }: { target: { orderId: string; line?: KLine; kind?: string } | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState('REMAKE');
  const [reason, setReason] = useState('WRONG_BUILD');
  const [note, setNote] = useState('');
  const { run, error } = useAction();
  if (!target) return null;
  return (
    <Modal open onClose={onClose} title={target.line ? `Problem with ${target.line.name}` : 'Kitchen problem'}>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-2">
        <Select label="What happened" value={kind} onChange={(e) => setKind(e.target.value)}><option value="REMAKE">Remake it</option><option value="MISSING">Missing from the order</option><option value="QUALITY_FAIL">Quality failure (record only)</option></Select>
        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(KITCHEN_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="text-xs text-ink-500">Remakes and missing items go back to the station as a new ticket and come out of the bag.</p>
        <Button onClick={() => run(async () => { await api.post('/kitchen-events', { orderId: target.orderId, orderLineId: target.line?.id, kind, reasonCode: reason, note: note || undefined }); onDone(); onClose(); })}>Record</Button>
      </div>
    </Modal>
  );
}

/** 13.1 / 13.3 / 13.5 / 13.8 station screen. */
export function StationsBoard({ kitchenId, stations }: { kitchenId: string; stations: { code: string; name: string }[] }) {
  const [station, setStation] = useState('');
  const { data: tickets, reload, offline, cachedAt } = useCachedApi<Ticket[]>(`gutad.kds.${kitchenId}.${station || 'all'}`, `/kitchens/${kitchenId}/stations/queue${station ? `?station=${station}` : ''}`);
  const { post, pending } = useOfflineActions(() => void reload());
  const { run, error } = useAction();
  const [ev, setEv] = useState<{ orderId: string; line?: KLine } | null>(null);
  const act = (path: string, body: unknown = {}) => run(async () => { await post(path, body); await reload(); });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Select value={station} onChange={(e) => setStation(e.target.value)} className="w-48"><option value="">All stations</option>{stations.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>
        <Button size="sm" variant="secondary" onClick={() => window.print()}>Print tickets</Button>
        <Link className="text-xs underline" href="/merchant/kitchen/runbook">Offline runbook</Link>
      </div>
      {offline && <Alert>Connection lost. Showing the last known queue from {when(cachedAt)}. Bumps are saved on this device and sent when the connection returns{pending.length ? ` (${pending.length} waiting)` : ''}. Use printed tickets if this screen goes blank.</Alert>}
      {!offline && pending.length > 0 && <Alert tone="info">Sending {pending.length} saved action(s)…</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tickets?.map((t) => (
          <Card key={t.id} className={t.delayed ? 'border-red-300' : t.fireState === 'HOLD' ? 'opacity-70' : ''} title={<span>{t.orderNumber} <Badge tone="info">{t.stationCode || 'MAIN'}</Badge>{t.kind === 'REMAKE' && <Badge tone="bad">REMAKE</Badge>}{t.tableNumber && <Badge>Table {t.tableNumber}</Badge>}</span>} action={<Badge tone={t.delayed ? 'bad' : statusTone(t.status)}>{t.delayed ? 'LATE' : t.fireState === 'HOLD' ? `FIRE ${hhmm(t.fireAt)}` : t.status}</Badge>}>
            <div className="text-xs text-ink-500">{t.fulfillmentType.toLowerCase()} · ready by {hhmm(t.readyBy || t.promiseAt)} · cook {t.cookMinutes ?? '—'} min · target {t.targetMinutes} min{t.status === 'IN_PROGRESS' ? ` · ${t.minutesInProgress} min in` : ''}</div>
            <ul className="mt-2 space-y-1 text-sm">{t.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-2">
                <span className={l.status === 'READY' ? 'text-emerald-700 line-through' : l.status === 'UNAVAILABLE' ? 'text-red-600 line-through' : ''}><b>{l.quantity}×</b> {l.name}{l.modifiers?.length ? ` — ${l.modifiers.map((m) => m.name).join(', ')}` : ''}{l.specialInstructions && <span className="text-amber-700"> “{l.specialInstructions}”</span>} <Flags flags={l.handling || []} /></span>
                <span className="flex shrink-0 gap-1 print:hidden">
                  {l.status !== 'READY' && l.status !== 'UNAVAILABLE' && <Button size="sm" variant="secondary" onClick={() => act(`/order-lines/${l.id}/bump`, { ready: true })}>Bump</Button>}
                  {l.status === 'READY' && <button className="text-xs underline" onClick={() => act(`/order-lines/${l.id}/bump`, { ready: false })}>undo</button>}
                  <button className="text-xs text-ink-500 underline" onClick={() => setEv({ orderId: t.orderId, line: l })}>problem</button>
                </span>
              </li>
            ))}</ul>
            <div className="mt-2 flex flex-wrap gap-1 print:hidden">
              {t.status === 'QUEUED' && <Button size="sm" variant={t.fireState === 'HOLD' ? 'secondary' : 'primary'} onClick={() => act(`/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' })}>{t.fireState === 'HOLD' ? 'Fire early' : 'Start'}</Button>}
              {t.status === 'IN_PROGRESS' && <Button size="sm" onClick={() => act(`/tickets/${t.id}/transition`, { status: 'DONE' })}>All done</Button>}
              <PrintButton path={`/tickets/${t.id}/print`} label="Print ticket" />
              {t.lines.filter((l) => !['UNAVAILABLE', 'READY'].includes(l.status)).map((l) => <Button key={l.id} size="sm" variant="ghost" onClick={() => act(`/order-lines/${l.id}/unavailable`, { note: 'Out of stock — replacement offered' })}>86 {l.name}</Button>)}
            </div>
          </Card>
        ))}
        {!tickets?.length && <p className="text-sm text-ink-500">No tickets in queue.</p>}
      </div>
      <KitchenEventModal target={ev} onClose={() => setEv(null)} onDone={() => void reload()} />
    </div>
  );
}

interface Expo { orderId: string; number: string; status: string; fulfillmentType: string; tableNumber: string | null; promiseAt: string | null; shelfSlot: string | null; stations: { stationCode: string | null; status: string; kind: string; fireAt: string | null }[]; holding: { stationCode: string | null }[]; readyLines: number; totalLines: number; packingStatus: string | null; foodWaitingMinutes: number; lateMinutes: number }

/** 13.4 expo: which station is holding each order and how long finished food has waited. */
export function ExpoBoard({ kitchenId }: { kitchenId: string }) {
  const { data } = useApi<Expo[]>(`/kitchens/${kitchenId}/expo`, { poll: 4000, deps: [kitchenId] });
  return (
    <Table rows={data || []} empty="No active orders." cols={[
      { key: 'n', label: 'Order', render: (o) => <span className="font-medium">{o.number}{o.tableNumber ? <span className="text-xs text-ink-500"> · table {o.tableNumber}</span> : ''}<span className="block text-xs text-ink-500">{o.fulfillmentType.toLowerCase()} · due {hhmm(o.promiseAt)}</span></span> },
      { key: 's', label: 'Stations', render: (o) => <span className="flex flex-wrap gap-1">{o.stations.map((s, i) => <Badge key={i} tone={s.status === 'DONE' ? 'good' : s.status === 'IN_PROGRESS' ? 'warn' : 'neutral'}>{s.stationCode}{s.kind === 'REMAKE' ? ' (remake)' : ''}</Badge>)}</span> },
      { key: 'h', label: 'Holding', render: (o) => o.holding.length ? <b>{o.holding.map((h) => h.stationCode).join(', ')}</b> : <span className="text-emerald-700">nothing</span> },
      { key: 'r', label: 'Items ready', render: (o) => `${o.readyLines}/${o.totalLines}` },
      { key: 'w', label: 'Food waiting', render: (o) => <span className={o.foodWaitingMinutes >= 5 ? 'font-semibold text-red-700' : ''}>{o.foodWaitingMinutes ? `${o.foodWaitingMinutes} min` : '—'}</span> },
      { key: 'p', label: 'Packing', render: (o) => o.status === 'READY' ? <Badge tone="good">{o.shelfSlot ? `shelf ${o.shelfSlot}` : 'ready'}</Badge> : <Badge>{o.packingStatus?.toLowerCase() || '—'}</Badge> },
      { key: 'l', label: 'Late', render: (o) => o.lateMinutes ? <span className="text-red-700">{o.lateMinutes} min</span> : '' },
    ]} />
  );
}

/** 14.1–14.4 packing: lines, checklist, bags and labels, then release. */
export function PackingBoard({ path }: { path: string }) {
  const { data: packs, reload } = useApi<Pack[]>(path, { poll: 4000, deps: [path] });
  const { run, error } = useAction();
  const [ev, setEv] = useState<{ orderId: string; line?: KLine } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <div className="grid gap-3 md:grid-cols-2">
        {packs?.map((p) => {
          const done = p.lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status)).every((l) => p.verifiedLineIds.includes(l.id)) && p.checklist.every((c) => c.done);
          return (
            <Card key={p.id} title={<span>{p.orderNumber} · <span className="font-mono text-sm">{p.bagCode}</span>{p.tableNumber && <Badge>Table {p.tableNumber}</Badge>}</span>} action={<Badge tone={statusTone(p.status)}>{p.status}</Badge>}>
              <div className="flex flex-wrap items-center gap-1 text-xs text-ink-500">{p.fulfillmentType.toLowerCase()} · due {hhmm(p.promiseAt)} <Flags flags={p.handling} /></div>
              {p.blockedReason && <Alert>{p.blockedReason}</Alert>}
              <ul className="mt-2 space-y-1 text-sm">{p.lines.map((l) => <li key={l.id} className="flex items-center justify-between"><span className={l.status === 'UNAVAILABLE' ? 'text-red-600 line-through' : ''}>{l.quantity}× {l.name} <Flags flags={l.handling || []} /> <Badge tone={statusTone(l.status)}>{l.status}</Badge></span><span className="flex gap-1">{!p.verifiedLineIds.includes(l.id) && l.status === 'READY' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/packing/${p.id}/verify`, { lineId: l.id }))}>In bag ✓</Button>}{p.verifiedLineIds.includes(l.id) && <span className="text-xs text-emerald-700">verified</span>}<button className="text-xs text-ink-500 underline" onClick={() => setEv({ orderId: p.orderId, line: l })}>problem</button></span></li>)}</ul>
              <div className="mt-2 text-xs font-semibold text-ink-500">Checklist</div>
              <div className="flex flex-wrap gap-3">{p.checklist.map((c) => <label key={c.key} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={c.done} onChange={(e) => act(() => api.post(`/packing/${p.id}/checklist`, { key: c.key, done: e.target.checked }))} />{c.label}</label>)}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">Bags <Select value={String(p.bagCount)} onChange={(e) => act(() => api.post(`/packing/${p.id}/bags`, { count: Number(e.target.value) }))}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}</Select>{p.bags.map((b) => <span key={b.n} className="text-xs">#{b.n} <Flags flags={b.handling} /></span>)}<Link className="text-xs underline" href={`/merchant/kitchen/labels/${p.id}`} target="_blank">Print labels</Link><PrintButton path={`/packing/${p.id}/print-labels`} label="Send labels to printer" /></div>
              <Button className="mt-3 w-full" disabled={p.status === 'BLOCKED' || !done} onClick={() => act(async () => { const r = await api.post<{ shelfSlot?: string | null }>(`/packing/${p.id}/release`, {}); setOk(`${p.orderNumber} released${r.shelfSlot ? ` → shelf ${r.shelfSlot}` : ''}.`); })}>{done ? 'Release bag' : 'Verify every item and the checklist'}</Button>
            </Card>
          );
        })}
        {!packs?.length && <p className="text-sm text-ink-500">Nothing to pack.</p>}
      </div>
      <KitchenEventModal target={ev} onClose={() => setEv(null)} onDone={() => void reload()} />
    </div>
  );
}

/** 14.5 / 14.6 / 14.8 pickup shelves, runner (dine-in / kiosk) and handoff. */
export function PickupBoard({ locationId }: { locationId: string }) {
  const { data: board, reload } = useApi<{ shelves: string[]; policy: { waitAlertMinutes: number; noShowNotifyMinutes: number; noShowResolveMinutes: number; noShowResolution: string }; orders: { id: string; number: string; fulfillmentType: string; name: string | null; shelfSlot: string | null; waitingMinutes: number; overWait: boolean; noShowStage: string | null }[] }>(`/locations/${locationId}/pickup-board`, { poll: 5000, deps: [locationId] });
  const { data: runner, reload: reloadRunner } = useApi<{ id: string; number: string; status: string; tableNumber: string | null; channel: string; name: string | null; lines: { name: string; quantity: number }[] }[]>(`/locations/${locationId}/runner`, { poll: 5000, deps: [locationId] });
  const { run, error } = useAction();
  const [codes, setCodes] = useState<Record<string, string>>({});
  const hand = (id: string, body: Record<string, unknown>) => run(async () => { await api.post(`/orders/${id}/handoff`, body); await reload(); await reloadRunner(); });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <CourierArrivals locationId={locationId} />
      <Card title="Pickup shelves">
        <p className="mb-2 text-xs text-ink-500">Shelves: {board?.shelves.join(' · ') || 'none set (Setup tab)'} · flagged after {board?.policy.waitAlertMinutes} min · customer reminded after {board?.policy.noShowNotifyMinutes} min, {board?.policy.noShowResolution === 'REFUND' ? 'refunded' : 'treated as collected'} after {board?.policy.noShowResolveMinutes} min</p>
        <Table rows={board?.orders || []} empty="Nothing waiting." cols={[
          { key: 's', label: 'Shelf', render: (o) => <b className="text-lg">{o.shelfSlot || '—'}</b> },
          { key: 'n', label: 'Order', render: (o) => <span>{o.number} <span className="text-xs text-ink-500">{o.name} · {o.fulfillmentType === 'DELIVERY' ? 'courier' : 'customer'}</span></span> },
          { key: 'w', label: 'Waiting', render: (o) => <span className={o.overWait ? 'font-semibold text-red-700' : ''}>{o.waitingMinutes} min{o.noShowStage === 'NOTIFIED' ? ' · reminded' : ''}</span> },
          { key: 'h', label: 'Hand off', render: (o) => o.fulfillmentType === 'DELIVERY' ? <Button size="sm" onClick={() => hand(o.id, {})}>Courier collected</Button> : <span className="flex gap-1"><Input placeholder="Code" className="w-20" value={codes[o.id] || ''} onChange={(e) => setCodes({ ...codes, [o.id]: e.target.value.toUpperCase() })} /><Button size="sm" disabled={!codes[o.id]} onClick={() => hand(o.id, { pickupCode: codes[o.id] })}>Collected</Button></span> },
        ]} />
      </Card>
      <Card title="Runner: dine-in and kiosk">
        <Table rows={runner || []} empty="No dine-in orders." cols={[
          { key: 't', label: 'Table', render: (o) => <b className="text-lg">{o.tableNumber || '—'}</b> },
          { key: 'n', label: 'Order', render: (o) => <span>{o.number} <span className="text-xs text-ink-500">{o.channel.toLowerCase()} {o.name ? `· ${o.name}` : ''}</span></span> },
          { key: 'l', label: 'Items', render: (o) => <span className="text-xs">{o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}</span> },
          { key: 's', label: 'Status', render: (o) => <Badge tone={statusTone(o.status)}>{o.status}</Badge> },
          { key: 'a', label: '', render: (o) => o.status === 'READY' ? <Button size="sm" onClick={() => hand(o.id, { tableNumber: o.tableNumber || undefined })}>Served</Button> : null },
        ]} />
      </Card>
    </div>
  );
}

interface Perf { kitchen: { loadLevel: string; loadChangedAt: string | null }; stations: { code: string; tickets: number; avgMinutes: number | null; targetMinutes: number; delayed: number; remakes: number; onTargetPct: number | null }[]; waiting: { fulfillmentType: string; orders: number; avgMinutes: number | null; maxMinutes: number | null }[]; reasons: { kind: string; reasonCode: string; count: number }[] }

/** 13.5 / 13.6 performance and the remake log. */
export function KitchenPerformance({ kitchenId }: { kitchenId: string }) {
  const [days, setDays] = useState('7');
  const { data } = useApi<Perf>(`/kitchens/${kitchenId}/performance?days=${days}`, { deps: [kitchenId, days] });
  const { data: events } = useApi<{ id: string; kind: string; reasonCode: string; note: string | null; stationCode: string | null; orderNumber: string; item: string | null; createdAt: string }[]>(`/kitchens/${kitchenId}/events?days=${days}`, { deps: [kitchenId, days] });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Select value={days} onChange={(e) => setDays(e.target.value)}><option value="1">Today</option><option value="7">7 days</option><option value="30">30 days</option></Select>{data && <Badge tone={data.kitchen.loadLevel === 'NORMAL' ? 'good' : data.kitchen.loadLevel === 'BUSY' ? 'warn' : 'bad'}>Load {data.kitchen.loadLevel.toLowerCase()}</Badge>}</div>
      <Card title="Stations">
        <Table rows={data?.stations || []} empty="No finished tickets yet." cols={[{ key: 'c', label: 'Station', render: (s) => s.code }, { key: 't', label: 'Tickets', render: (s) => s.tickets }, { key: 'a', label: 'Avg minutes', render: (s) => <span className={s.avgMinutes != null && s.avgMinutes > s.targetMinutes ? 'text-red-700' : ''}>{s.avgMinutes ?? '—'} / target {s.targetMinutes}</span> }, { key: 'o', label: 'On target', render: (s) => (s.onTargetPct == null ? '—' : `${s.onTargetPct}%`) }, { key: 'r', label: 'Remakes', render: (s) => s.remakes }]} />
      </Card>
      <Card title="Completed food waiting (ready → collected)">
        <Table rows={data?.waiting || []} empty="No collected orders yet." cols={[{ key: 'f', label: 'Fulfillment', render: (w) => w.fulfillmentType.toLowerCase() }, { key: 'n', label: 'Orders', render: (w) => w.orders }, { key: 'a', label: 'Avg min', render: (w) => w.avgMinutes ?? '—' }, { key: 'm', label: 'Longest', render: (w) => w.maxMinutes ?? '—' }]} />
      </Card>
      <Card title="Remakes, missing items and quality failures">
        <div className="mb-2 flex flex-wrap gap-2">{data?.reasons.map((r) => <Badge key={`${r.kind}${r.reasonCode}`}>{r.kind.toLowerCase().replace('_', ' ')} · {KITCHEN_REASONS[r.reasonCode] || r.reasonCode}: {r.count}</Badge>)}</div>
        <Table rows={events || []} empty="None recorded." cols={[{ key: 'd', label: 'When', render: (e) => <span className="text-xs">{when(e.createdAt)}</span> }, { key: 'o', label: 'Order', render: (e) => e.orderNumber }, { key: 'i', label: 'Item', render: (e) => e.item || '—' }, { key: 'k', label: 'Kind', render: (e) => e.kind.toLowerCase().replace('_', ' ') }, { key: 'r', label: 'Reason', render: (e) => KITCHEN_REASONS[e.reasonCode] || e.reasonCode }, { key: 'n', label: 'Note', render: (e) => <span className="text-xs">{e.note}</span> }]} />
      </Card>
    </div>
  );
}

/** 13.2 routing, 13.5 station targets, 13.7 auto-throttle, 14.1/14.4/14.5 location packing settings. */
export function KitchenSetup({ kitchenId, locationId, stations, reloadKitchen }: { kitchenId: string | null; locationId: string; stations: { id: string; code: string; name: string; targetMinutes: number; maxConcurrent: number | null; isAvailable: boolean }[]; reloadKitchen: () => void }) {
  const { data: r, reload } = useApi<{ defaultStationCode: string | null; autoThrottle: Record<string, number | boolean> | null; loadLevel: string; routes: { id: string; matchType: string; matchName: string; stationCode: string }[] }>(kitchenId ? `/kitchens/${kitchenId}/routes` : null, { deps: [kitchenId] });
  const { data: loc, reload: reloadLoc } = useApi<{ pickupShelves: string[]; packingExtras: string[]; requirePackVerification: boolean | null }>(`/locations/${locationId}/packing-settings`, { deps: [locationId] });
  const { data: menus } = useApi<{ brandId?: string | null; brand?: { id: string; name: string } | null; categories: { id: string; name: string; items: { id: string; name: string }[] }[] }[]>(kitchenId ? `/locations/${locationId}/menus` : null, { deps: [locationId, kitchenId] });
  const { run, error } = useAction();
  const [ok, setOk] = useState<string | null>(null);
  const [route, setRoute] = useState({ matchType: 'ITEM', matchId: '', stationCode: '' });
  const [thr, setThr] = useState<Record<string, string>>({});
  const [shelves, setShelves] = useState<string | null>(null);
  const [extras, setExtras] = useState<string | null>(null);
  const options = route.matchType === 'ITEM' ? menus?.flatMap((m) => m.categories.flatMap((c) => c.items.map((i) => ({ id: i.id, name: `${i.name} (${c.name})` })))) : route.matchType === 'CATEGORY' ? menus?.flatMap((m) => m.categories.map((c) => ({ id: c.id, name: c.name }))) : Array.from(new Map((menus || []).filter((m) => m.brand).map((m) => [m.brand!.id, { id: m.brand!.id, name: m.brand!.name }])).values());
  const save = (fn: () => Promise<unknown>, msg = 'Saved.') => run(async () => { await fn(); setOk(msg); reload(); reloadLoc(); reloadKitchen(); });
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      {kitchenId && (
        <>
          <Card title="Stations and prep targets">
            <Table rows={stations} cols={[{ key: 'c', label: 'Code', render: (s) => s.code }, { key: 'n', label: 'Name', render: (s) => s.name }, { key: 't', label: 'Target minutes', render: (s) => <Input className="w-20" defaultValue={String(s.targetMinutes)} onBlur={(e) => Number(e.target.value) !== s.targetMinutes && save(() => api.post(`/kitchens/${kitchenId}/stations`, { id: s.id, code: s.code, name: s.name, maxConcurrent: s.maxConcurrent, isAvailable: s.isAvailable, targetMinutes: Number(e.target.value) }))} /> }, { key: 'd', label: 'Default', render: (s) => <input type="radio" name="default-station" checked={r?.defaultStationCode === s.code} onChange={() => save(() => api.patch(`/kitchens/${kitchenId}/settings`, { defaultStationCode: s.code }))} /> }]} />
          </Card>
          <Card title="Routing rules">
            <p className="mb-2 text-xs text-ink-500">Most specific wins: an item rule, then its category, then its brand, then the item’s own station, then the default station.</p>
            <Table rows={r?.routes || []} empty="No rules: items go to their own station." cols={[{ key: 't', label: 'When', render: (x) => `${x.matchType.toLowerCase()}: ${x.matchName}` }, { key: 's', label: 'Station', render: (x) => <Badge tone="info">{x.stationCode}</Badge> }, { key: 'x', label: '', render: (x) => <button className="text-xs text-red-600" onClick={() => save(() => api.delete(`/station-routes/${x.id}`), 'Rule removed.')}>Remove</button> }]} />
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Select label="Match" value={route.matchType} onChange={(e) => setRoute({ ...route, matchType: e.target.value, matchId: '' })}><option value="ITEM">Item</option><option value="CATEGORY">Category</option><option value="BRAND">Brand</option></Select>
              <Select label="Which" value={route.matchId} onChange={(e) => setRoute({ ...route, matchId: e.target.value })}><option value="">Choose…</option>{options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
              <Select label="Station" value={route.stationCode} onChange={(e) => setRoute({ ...route, stationCode: e.target.value })}><option value="">Choose…</option>{stations.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>
              <Button disabled={!route.matchId || !route.stationCode} onClick={() => save(() => api.post(`/kitchens/${kitchenId}/routes`, route), 'Rule added.')}>Add rule</Button>
            </div>
          </Card>
          <Card title={`Auto-throttle · load now ${r?.loadLevel.toLowerCase() || '—'}`}>
            <p className="mb-2 text-xs text-ink-500">Counts tickets being cooked or due to fire within 5 minutes. Busy adds prep time to new orders; overloaded pauses ASAP orders (scheduling still works). It steps back down when the queue falls below the threshold × recovery ratio. Blank = platform default.</p>
            <div className="grid gap-2 sm:grid-cols-5">
              {(['busyAtActiveTickets', 'overloadAtActiveTickets', 'busyExtraMinutes', 'recoverRatio'] as const).map((k) => <Input key={k} label={{ busyAtActiveTickets: 'Busy at tickets', overloadAtActiveTickets: 'Overloaded at tickets', busyExtraMinutes: 'Extra minutes when busy', recoverRatio: 'Recovery ratio' }[k]} placeholder={String(r?.autoThrottle?.[k] ?? '')} value={thr[k] ?? ''} onChange={(e) => setThr({ ...thr, [k]: e.target.value })} />)}
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={r?.autoThrottle?.enabled !== false} onChange={(e) => save(() => api.patch(`/kitchens/${kitchenId}/settings`, { autoThrottle: { ...(r?.autoThrottle || {}), enabled: e.target.checked } }))} /> Enabled</label>
            </div>
            <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => save(() => api.patch(`/kitchens/${kitchenId}/settings`, { autoThrottle: { ...(r?.autoThrottle || {}), ...Object.fromEntries(Object.entries(thr).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])) } }))}>Save thresholds</Button><Button size="sm" variant="ghost" onClick={() => save(() => api.patch(`/kitchens/${kitchenId}/settings`, { autoThrottle: null }), 'Using platform defaults.')}>Use platform defaults</Button></div>
          </Card>
        </>
      )}
      <Card title="Packing & pickup at this location">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label="Pickup shelves (comma separated)" value={shelves ?? loc?.pickupShelves.join(', ') ?? ''} onChange={(e) => setShelves(e.target.value)} />
          <Input label="Packing checklist extras (comma separated)" placeholder="Napkins, Receipt" value={extras ?? loc?.packingExtras.join(', ') ?? ''} onChange={(e) => setExtras(e.target.value)} />
        </div>
        <Select className="mt-2" label="Bag verification before ready" value={loc?.requirePackVerification == null ? '' : String(loc.requirePackVerification)} onChange={(e) => save(() => api.patch(`/locations/${locationId}`, { requirePackVerification: e.target.value === '' ? null : e.target.value === 'true' }))}><option value="">Default ({kitchenId ? 'required' : 'optional'})</option><option value="true">Required</option><option value="false">Optional</option></Select>
        <Button className="mt-2" size="sm" onClick={() => save(() => api.patch(`/locations/${locationId}`, { pickupShelves: (shelves ?? loc?.pickupShelves.join(',') ?? '').split(',').map((x) => x.trim()).filter(Boolean), packingExtras: (extras ?? loc?.packingExtras.join(',') ?? '').split(',').map((x) => x.trim()).filter(Boolean) }))}>Save packing settings</Button>
      </Card>
    </div>
  );
}
