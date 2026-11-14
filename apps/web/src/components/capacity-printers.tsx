'use client';
import { useState } from 'react';
import type { LocationThrottle } from '@gutad/shared';
import { api, ago } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';

interface LoadStatus { hasKitchen: boolean; settings: LocationThrottle & { custom: boolean }; openOrders: number; backlogMinutes: number; level: 'NORMAL' | 'BUSY' | 'OVERLOADED'; defaultPrepMinutes: number; lastLevel: string; lastChangedAt: string | null }
export interface Printer { id: string; name: string; stationCode: string | null; role: 'TICKETS' | 'LABELS' | 'BOTH'; protocol: 'LOG' | 'RAW_TCP'; host: string | null; port: number; width: number; autoPrint: boolean; isActive: boolean; lastStatus: string; lastError: string | null; lastPrintedAt: string | null }
interface PrintJob { id: string; printerId: string; kind: string; title: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; nextAttemptAt: string | null; printedAt: string | null; createdAt: string; preview: string }

const levelTone = (l: string) => (l === 'OVERLOADED' ? 'bad' : l === 'BUSY' ? 'warn' : 'good');

/** 13.7-L auto-throttle for a restaurant without a production kitchen. */
export function AutoThrottleCard({ locId }: { locId: string }) {
  const { data, reload } = useApi<LoadStatus>(`/locations/${locId}/load`, { poll: 30000 });
  const [f, setF] = useState<Partial<LocationThrottle> | null>(null);
  const { run, error, busy } = useAction();
  if (!data) return null;
  if (data.hasKitchen) return <Card title="Auto-throttle"><p className="text-sm text-ink-500">This location cooks in a production kitchen; its kitchen’s auto-throttle (Kitchen → Setup) applies.</p></Card>;
  const v = { ...data.settings, ...(f || {}) };
  const num = (k: keyof LocationThrottle, nullable = false) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...(f || {}), [k]: e.target.value === '' && nullable ? null : Number(e.target.value) });
  return (
    <Card title="Auto-throttle" action={<Badge tone={levelTone(data.level)}>{data.level}</Badge>}>
      <p className="text-sm text-ink-500">When the kitchen gets busy, new orders are quoted longer prep times; at capacity, ASAP orders pause until it recovers (scheduled orders are still taken). Load is open orders and the backlog they represent: open orders × prep time ÷ orders cooked at once.</p>
      <div className="mt-2 text-sm">Right now: <b>{data.openOrders}</b> open order{data.openOrders === 1 ? '' : 's'}, about <b>{data.backlogMinutes}</b> min of backlog{data.lastChangedAt ? ` · last change ${ago(data.lastChangedAt)} (${data.lastLevel.toLowerCase()})` : ''}.</div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={v.enabled} onChange={(e) => setF({ ...(f || {}), enabled: e.target.checked })} /> Throttle automatically</label>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Input label="Busy at open orders" type="number" min={1} value={v.busyAtOpenOrders} onChange={num('busyAtOpenOrders')} />
        <Input label="At capacity at open orders" type="number" min={2} value={v.overloadAtOpenOrders} onChange={num('overloadAtOpenOrders')} />
        <Input label="Extra minutes when busy" type="number" min={0} value={v.busyExtraMinutes} onChange={num('busyExtraMinutes')} />
        <Input label="Busy at backlog minutes (blank = off)" type="number" value={v.busyAtBacklogMinutes ?? ''} onChange={num('busyAtBacklogMinutes', true)} />
        <Input label="At capacity at backlog minutes (blank = off)" type="number" value={v.overloadAtBacklogMinutes ?? ''} onChange={num('overloadAtBacklogMinutes', true)} />
        <Input label="Orders cooked at once" type="number" min={1} value={v.parallelOrders} onChange={num('parallelOrders')} />
      </div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <div className="mt-3 flex gap-2"><Button disabled={busy || !f} onClick={() => run(async () => { await api.patch(`/locations/${locId}/load-settings`, v); setF(null); await reload(); })}>Save</Button>{f && <Button variant="ghost" onClick={() => setF(null)}>Discard</Button>}</div>
      <p className="mt-2 text-xs text-ink-500">The per-15-minute order throttle on the Location tab still applies as a hard cap.</p>
    </Card>
  );
}

const EMPTY: Omit<Printer, 'id' | 'lastStatus' | 'lastError' | 'lastPrintedAt'> = { name: '', stationCode: null, role: 'TICKETS', protocol: 'LOG', host: null, port: 9100, width: 42, autoPrint: false, isActive: true };

/** 13.8-P network ticket printers: registry, test print and the print queue with retries. */
export function PrintersCard({ locId }: { locId: string }) {
  const { data: printers, reload } = useApi<Printer[]>(`/locations/${locId}/printers`);
  const { data: jobs, reload: reloadJobs } = useApi<PrintJob[]>(`/locations/${locId}/print-jobs`, { poll: 15000 });
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const { run, error, busy } = useAction();
  const refresh = async () => { await reload(); await reloadJobs(); };
  const name = (id: string) => printers?.find((p) => p.id === id)?.name || 'printer';
  return (
    <Card title="Ticket printers" action={<Button size="sm" onClick={() => setEdit({ ...EMPTY })}>Add printer</Button>}>
      <p className="text-sm text-ink-500">Network thermal printers (ESC/POS on port 9100) for station tickets and bag labels. Choose “Log only” to try it out without a printer: tickets are written to the server log.</p>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <div className="mt-3">
        <Table rows={printers || []} empty="No printers yet. Station tickets and labels print from the browser." cols={[
          { key: 'n', label: 'Printer', render: (p) => <div><div className="font-medium">{p.name}</div><div className="text-xs text-ink-500">{p.protocol === 'RAW_TCP' ? `${p.host || '— no address —'}:${p.port}` : 'log only'} · {p.role.toLowerCase()} · {p.stationCode || 'all stations'}{p.autoPrint ? ' · auto-print' : ''}</div></div> },
          { key: 's', label: 'Status', render: (p) => <div><Badge tone={!p.isActive ? 'neutral' : p.lastStatus === 'OK' ? 'good' : p.lastStatus === 'ERROR' ? 'bad' : 'neutral'}>{p.isActive ? p.lastStatus : 'OFF'}</Badge>{p.lastError && <div className="mt-1 max-w-xs text-xs text-red-700">{p.lastError}</div>}{p.lastPrintedAt && <div className="text-xs text-ink-500">printed {ago(p.lastPrintedAt)}</div>}</div> },
          { key: 'a', label: '', render: (p) => <div className="flex flex-wrap gap-1"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/printers/${p.id}/test`, {}); await refresh(); })}>Test print</Button><Button size="sm" variant="ghost" onClick={() => setEdit({ ...p })}>Edit</Button><Button size="sm" variant="ghost" onClick={() => run(async () => { await api.patch(`/printers/${p.id}`, { isActive: !p.isActive }); await refresh(); })}>{p.isActive ? 'Turn off' : 'Turn on'}</Button></div> },
        ]} />
      </div>
      {edit && (
        <div className="mt-3 rounded-xl border border-ink-100 p-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Grill printer" />
            <Input label="Station code (blank = all)" value={edit.stationCode || ''} onChange={(e) => setEdit({ ...edit, stationCode: e.target.value || null })} placeholder="GRILL" />
            <Select label="Prints" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Printer['role'] })}><option value="TICKETS">Station tickets</option><option value="LABELS">Bag labels</option><option value="BOTH">Both</option></Select>
            <Select label="Connection" value={edit.protocol} onChange={(e) => setEdit({ ...edit, protocol: e.target.value as Printer['protocol'] })}><option value="LOG">Log only (no printer)</option><option value="RAW_TCP">Network (ESC/POS, raw TCP)</option></Select>
            {edit.protocol === 'RAW_TCP' && <><Input label="IP address or host" value={edit.host || ''} onChange={(e) => setEdit({ ...edit, host: e.target.value || null })} placeholder="192.168.1.50" /><Input label="Port" type="number" value={edit.port} onChange={(e) => setEdit({ ...edit, port: Number(e.target.value) })} /></>}
            <Select label="Paper" value={String(edit.width)} onChange={(e) => setEdit({ ...edit, width: Number(e.target.value) })}><option value="32">58 mm (32 characters)</option><option value="42">80 mm (42 characters)</option><option value="48">80 mm (48 characters)</option></Select>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.autoPrint} onChange={(e) => setEdit({ ...edit, autoPrint: e.target.checked })} /> Print new station tickets automatically when an order is accepted</label>
          <div className="mt-2 flex gap-2">
            <Button disabled={busy || !edit.name} onClick={() => run(async () => { const { id, ...body } = edit; const b = { name: body.name, stationCode: body.stationCode, role: body.role, protocol: body.protocol, host: body.host, port: body.port, width: body.width, autoPrint: body.autoPrint, isActive: body.isActive }; if (id) await api.patch(`/printers/${id}`, b); else await api.post(`/locations/${locId}/printers`, b); setEdit(null); await refresh(); })}>Save</Button>
            {edit.id && <Button variant="danger" onClick={() => run(async () => { await api.delete(`/printers/${edit.id}`); setEdit(null); await refresh(); })}>Remove</Button>}
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        </div>
      )}
      <h4 className="mt-4 text-sm font-semibold">Print queue</h4>
      <div className="mt-2">
        <Table rows={jobs || []} empty="Nothing printed yet." cols={[
          { key: 't', label: 'Job', render: (j) => <div><div>{j.title}</div><div className="text-xs text-ink-500">{name(j.printerId)} · {ago(j.createdAt)}</div></div> },
          { key: 's', label: 'Status', render: (j) => <div><Badge tone={j.status === 'PRINTED' ? 'good' : j.status === 'FAILED' ? 'bad' : statusTone(j.status)}>{j.status}</Badge><div className="text-xs text-ink-500">try {j.attempts}/{j.maxAttempts}{j.nextAttemptAt && j.status === 'QUEUED' ? ` · next ${new Date(j.nextAttemptAt).toLocaleTimeString()}` : ''}</div>{j.lastError && <div className="max-w-xs text-xs text-red-700">{j.lastError}</div>}</div> },
          { key: 'a', label: '', render: (j) => (j.status === 'FAILED' || j.status === 'QUEUED' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/print-jobs/${j.id}/retry`, {}); await refresh(); })}>Retry now</Button> : null) },
        ]} />
      </div>
    </Card>
  );
}

/** Sends tickets or labels to the network printers; falls back to a message when none is set up. */
export function PrintButton({ path, label = 'Print', size = 'sm' }: { path: string; label?: string; size?: 'sm' | 'md' }) {
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 print:hidden">
      <Button size={size} variant="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        try {
          const jobs = await api.post<{ status: string; lastError: string | null }[]>(path, {});
          const failed = jobs.filter((j) => j.status !== 'PRINTED');
          setMsg(failed.length ? { tone: 'bad', text: failed[0].lastError || `${failed.length} waiting to retry` } : { tone: 'good', text: `Sent (${jobs.length})` });
        } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(false); }
      }}>{label}</Button>
      {msg && <span className={`text-xs ${msg.tone === 'good' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>}
    </span>
  );
}

/** 14.8-K link to the full-screen self-order kiosk for this location. */
export function KioskCard({ slug, enabled }: { slug: string; enabled?: boolean }) {
  return (
    <Card title="Self-order kiosk">
      <p className="text-sm text-ink-500">Open this on a tablet or touch screen at the counter: big buttons, eat here or take away, table or pager number, pay by card or at the counter. It returns to the start screen after 90 seconds without a touch and never uses the signed-in account.</p>
      {enabled === false && <p className="mt-2 text-sm text-amber-700">Turn on the Kiosk channel on the Location tab first.</p>}
      <div className="mt-2 flex gap-2"><a className="text-sm font-medium text-brand-700 underline" href={`/kiosk/${slug}`} target="_blank" rel="noreferrer">Open kiosk mode</a></div>
    </Card>
  );
}
