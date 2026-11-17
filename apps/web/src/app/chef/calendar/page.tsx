'use client';
import { useEffect, useState } from 'react';
import { addDaysYmd, chefNoticeText, formatHour, GutadApiError, WEEKDAYS, type ChefCalendarDay, type ChefOperatingSettings, type ChefPause } from '@gutad/shared';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner } from '@/components/ui';
import { ChipGroup, QtyStepper } from '@/components/form-kit';
import { orderByLabel } from '@/components/date-slot-picker';

interface Calendar { timezone: string; today: string; maxAdvanceCap: number; settings: ChefOperatingSettings; pauses: ChefPause[]; dishLimits: { menuItemId: string; name: string; limit: number | null }[]; days: ChefCalendarDay[] }

const short = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const codeOf = (e: unknown) => (e instanceof GutadApiError ? (e.body as unknown as { code?: string } | null)?.code : undefined);

/**
 * The chef's cooking calendar: weekly cooking days and pickup window, notice and cutoff, daily capacity and how far
 * ahead orders open; per-date changes (close a day, open an extra one, a smaller batch); holiday pauses; and what is
 * booked or held for each day.
 */
export default function ChefCalendarPage() {
  const [from, setFrom] = useState<string | null>(null);
  const { data, setData, loading, error, reload } = useApi<Calendar>(`/chef/calendar${from ? `?from=${from}&to=${addDaysYmd(from, 41)}` : ''}`);
  const { run, busy, error: actErr, setError } = useAction();
  const [form, setForm] = useState<ChefOperatingSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<null | { kind: 'day' | 'pause'; message: string; retry: () => Promise<unknown> }>(null);
  const [pause, setPause] = useState({ startDate: '', endDate: '', reason: '' });
  useEffect(() => { if (data && !form) setForm(data.settings); }, [data, form]);
  const day = data?.days.find((d) => d.date === sel) || null;
  useEffect(() => { setCap(day?.override?.capacity != null ? String(day.override.capacity) : ''); setNote(day?.override?.note || ''); }, [day?.date, day?.override?.capacity, day?.override?.note]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert tone="info">Only approved chefs have a cooking calendar.</Alert>;
  const start = data.days[0]?.date || data.today;
  const lead = data.days.length ? data.days[0].weekday : 0;
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(data.settings);

  const saveSettings = () => run(async () => { const c = await api.put<Calendar>('/chef/calendar/settings', form); setData({ ...c, days: from ? data.days : c.days }); setForm(c.settings); setSaved(true); setTimeout(() => setSaved(false), 2500); if (from) await reload(); });
  /** a change that could affect existing orders asks once, then retries with acknowledgeOrders */
  const guarded = (kind: 'day' | 'pause', fn: (ack: boolean) => Promise<unknown>) => run(async () => {
    try { await fn(false); }
    catch (e) { if (codeOf(e) === 'HAS_ORDERS') { setConfirm({ kind, message: (e as Error).message, retry: () => fn(true) }); return; } throw e; }
    await reload();
  });
  const setDay = (body: { open?: boolean | null; capacity?: number | null; note?: string | null }) => guarded('day', (ack) => api.put(`/chef/calendar/days/${sel}`, { ...body, ...(ack ? { acknowledgeOrders: true } : {}) }));
  const addPause = () => guarded('pause', async (ack) => { await api.post('/chef/calendar/pauses', { ...pause, reason: pause.reason || null, ...(ack ? { acknowledgeOrders: true } : {}) }); setPause({ startDate: '', endDate: '', reason: '' }); });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cooking calendar</h1>
        <p className="text-sm text-ink-500">Customers can order {form ? chefNoticeText(form.minLeadDays, form.cutoffHour).toLowerCase() : ''}, up to {data.settings.maxAdvanceDays} days ahead. Times are in {data.timezone.replace('_', ' ')}.</p>
      </div>
      {actErr && <Alert>{actErr}</Alert>}
      {confirm && (
        <Alert tone="info">
          <div className="space-y-2"><p>{confirm.message}</p><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => { const r = confirm.retry; setConfirm(null); void run(async () => { await r(); await reload(); }); }}>{confirm.kind === 'pause' ? 'Pause anyway' : 'Close anyway'}</Button><Button size="sm" variant="secondary" onClick={() => setConfirm(null)}>Keep it open</Button></div></div>
        </Alert>
      )}

      {form && (
        <Card title="Every week" action={saved ? <Badge tone="good">Saved</Badge> : undefined}>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <div className="text-sm font-medium">Cooking days</div>
              <ChipGroup name="Cooking days" values={form.cookingDays} onChange={(v) => setForm({ ...form, cookingDays: [...v].sort() })} options={WEEKDAYS.map((w, i) => ({ value: i, label: w }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="Pickup from" type="time" step={1800} value={form.opens} onChange={(e) => setForm({ ...form, opens: e.target.value })} />
              <Input label="Until" type="time" step={1800} value={form.closes} onChange={(e) => setForm({ ...form, closes: e.target.value })} />
            </div>
            <div className="space-y-1.5"><div className="text-sm font-medium">Cutoff hour</div><div className="flex items-center gap-3"><QtyStepper label="Cutoff hour" value={form.cutoffHour} min={0} max={23} onChange={(v) => setForm({ ...form, cutoffHour: v })} /><span className="text-sm">{formatHour(form.cutoffHour)}</span></div></div>
            <div className="space-y-1.5"><div className="text-sm font-medium">Notice (days before)</div><div className="flex items-center gap-3"><QtyStepper label="Notice days" value={form.minLeadDays} min={0} max={30} onChange={(v) => setForm({ ...form, minLeadDays: v })} /><span className="text-xs text-ink-500">{chefNoticeText(form.minLeadDays, form.cutoffHour)}</span></div></div>
            <div className="space-y-1.5"><div className="text-sm font-medium">Kitchen capacity per day</div><div className="flex items-center gap-3"><QtyStepper label="Portions per day" value={form.dailyCapacity} min={1} max={2000} onChange={(v) => setForm({ ...form, dailyCapacity: v })} /><span className="text-xs text-ink-500">portions across all dishes</span></div></div>
            <div className="space-y-1.5"><div className="text-sm font-medium">Orders open</div><div className="flex items-center gap-3"><QtyStepper label="Days ahead" value={form.maxAdvanceDays} min={1} max={data.maxAdvanceCap} onChange={(v) => setForm({ ...form, maxAdvanceDays: v })} /><span className="text-xs text-ink-500">days ahead (Gutad allows up to {data.maxAdvanceCap})</span></div></div>
          </div>
          {data.dishLimits.some((d) => d.limit) && <p className="mt-4 text-xs text-ink-500">Per-dish daily limits: {data.dishLimits.filter((d) => d.limit).map((d) => `${d.name} ${d.limit}`).join(' · ')}. Change them in each dish’s availability step.</p>}
          <div className="mt-4 flex gap-2"><Button disabled={!dirty || busy} onClick={saveSettings}>Save weekly settings</Button>{dirty && <Button variant="ghost" onClick={() => setForm(data.settings)}>Undo</Button>}</div>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card title={`${short(start)} – ${short(data.days[data.days.length - 1]?.date || start)}`} action={<div className="flex gap-1"><Button size="sm" variant="secondary" disabled={start <= data.today} onClick={() => setFrom(addDaysYmd(start, -42) < data.today ? data.today : addDaysYmd(start, -42))} aria-label="Earlier dates">‹</Button><Button size="sm" variant="secondary" onClick={() => setFrom(addDaysYmd(start, 42))} aria-label="Later dates">›</Button></div>}>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium uppercase text-ink-500">{WEEKDAYS.map((w) => <div key={w}>{w}</div>)}</div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: lead }).map((_, i) => <div key={`b${i}`} />)}
            {data.days.map((d) => {
              const used = d.booked + d.held;
              const pct = d.capacity ? Math.min(100, Math.round((used / d.capacity) * 100)) : 0;
              const tone = d.pause ? 'bg-ink-100 text-ink-400' : !d.open ? 'bg-white text-ink-300' : pct >= 100 ? 'bg-red-50' : 'bg-emerald-50';
              return (
                <button key={d.date} type="button" onClick={() => setSel(d.date)} aria-pressed={sel === d.date} aria-label={`${short(d.date)}: ${d.pause ? 'paused' : d.open ? `${d.booked} of ${d.capacity} booked` : 'closed'}`} className={`min-h-[64px] rounded-lg border p-1 text-left text-[11px] ${tone} ${sel === d.date ? 'border-brand-500 ring-2 ring-brand-200' : 'border-ink-100'}`}>
                  <div className="flex items-center justify-between"><span className="text-xs font-semibold text-ink-900">{Number(d.date.slice(8))}</span>{d.override && <span title="Changed for this date">•</span>}</div>
                  {d.pause ? <div>Away</div> : d.open ? <><div className="text-ink-700">{d.booked}/{d.capacity}</div>{d.held > 0 && <div className="text-amber-700">+{d.held} held</div>}<div className="mt-0.5 h-1 rounded bg-ink-100"><div className={`h-1 rounded ${pct >= 100 ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} /></div></> : <div>Closed</div>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-ink-500">Booked / capacity in portions. Held portions are in customers’ checkouts (up to 10 minutes).</p>
        </Card>

        <div className="space-y-6">
          <Card title={day ? short(day.date) : 'Pick a date'}>
            {!day ? <p className="text-sm text-ink-500">Select a date to close it, open it as an extra cooking day, or change its capacity.</p> : (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-1">{day.pause ? <Badge tone="warn">Paused{day.pause.reason ? `: ${day.pause.reason}` : ''}</Badge> : day.open ? <Badge tone="good">Cooking</Badge> : <Badge>Closed</Badge>}{day.override && <Badge tone="info">Changed for this date</Badge>}{day.closedForOrders && day.open && <Badge>Ordering closed</Badge>}</div>
                {day.orderBy && !day.closedForOrders && <p className="text-xs text-ink-500">Customers can order until {orderByLabel(day.orderBy, data.timezone)}.</p>}
                <p>{day.orders} order{day.orders === 1 ? '' : 's'} · {day.booked} portions booked{day.held ? ` · ${day.held} held` : ''} of {day.capacity}</p>
                {day.dishes.length > 0 && <ul className="space-y-0.5 text-xs">{day.dishes.map((x) => <li key={x.menuItemId} className="flex justify-between"><span>{x.name}</span><span>{x.units}{x.limit ? ` / ${x.limit}` : ''}</span></li>)}</ul>}
                {!day.pause && (
                  <div className="flex flex-wrap gap-2">
                    {day.open ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDay({ open: false })}>Close this day</Button> : <Button size="sm" disabled={busy} onClick={() => setDay({ open: true })}>Cook this day</Button>}
                    {day.override?.open !== null && day.override?.open !== undefined && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDay({ open: null })}>Back to weekly</Button>}
                  </div>
                )}
                {day.open && (
                  <div className="space-y-2 border-t border-ink-100 pt-3">
                    <div className="flex items-end gap-2"><Input label="Capacity this day" type="number" min={0} placeholder={String(data.settings.dailyCapacity)} value={cap} onChange={(e) => setCap(e.target.value)} className="w-32" /><Button size="sm" disabled={busy} onClick={() => setDay({ capacity: cap === '' ? null : Number(cap), note: note || null })}>Save</Button></div>
                    <Input label="Note (only you see it)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title="Holidays and time away">
            {data.pauses.length ? <ul className="mb-3 space-y-1 text-sm">{data.pauses.map((p) => <li key={p.id} className="flex items-center justify-between gap-2"><span>{short(p.startDate)}{p.endDate !== p.startDate ? ` – ${short(p.endDate)}` : ''}{p.reason ? <span className="text-ink-500"> · {p.reason}</span> : null}</span><button className="text-xs text-red-600 underline" disabled={busy} onClick={() => run(async () => { await api.delete(`/chef/calendar/pauses/${p.id}`); await reload(); })}>Remove</button></li>)}</ul> : <p className="mb-3 text-sm text-ink-500">No time away planned.</p>}
            <div className="grid grid-cols-2 gap-2">
              <Input label="From" type="date" min={data.today} value={pause.startDate} onChange={(e) => { setError(null); setPause({ ...pause, startDate: e.target.value, endDate: pause.endDate && pause.endDate >= e.target.value ? pause.endDate : e.target.value }); }} />
              <Input label="Until" type="date" min={pause.startDate || data.today} value={pause.endDate} onChange={(e) => setPause({ ...pause, endDate: e.target.value })} />
              <Input className="col-span-2" label="Reason (optional, only Gutad sees it)" value={pause.reason} maxLength={200} onChange={(e) => setPause({ ...pause, reason: e.target.value })} />
            </div>
            <Button className="mt-3" size="sm" disabled={busy || !pause.startDate || !pause.endDate} onClick={addPause}>Add time away</Button>
            <p className="mt-2 text-xs text-ink-500">Customers see “chef is away” on these dates. Orders you already have still need cooking or cancelling.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
