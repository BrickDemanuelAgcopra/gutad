'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { addDaysYmd, CHEF_DAY_STATUS_LABEL, chefNoticeText, weekdayYmd, type ChefAvailability, type ChefAvailabilityDay } from '@gutad/shared';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthOf = (ymd: string) => ymd.slice(0, 7);
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shiftMonth = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const timeLabel = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const orderByLabel = (iso: string, tz: string) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export interface DateSlot { date: string; time: string }

/**
 * Calendar of orderable dates plus time chips (Gutad Chef Network advance orders). Only AVAILABLE dates can be
 * chosen; others explain why (cutoff passed, not a cooking day, chef away, sold out). Arrow keys move between
 * dates in the grid (roving tab index), Home/End jump to the week's ends, PageUp/PageDown change month.
 */
export function DateSlotPicker({ availability, value, onChange, loading, showTimes = true, title = 'Choose a day' }: { availability: ChefAvailability | null; value: DateSlot | null; onChange: (v: DateSlot) => void; loading?: boolean; showTimes?: boolean; title?: string }) {
  const byDate = useMemo(() => new Map((availability?.days || []).map((d) => [d.date, d])), [availability]);
  const first = availability?.days[0]?.date;
  const last = availability?.days[availability.days.length - 1]?.date;
  const [month, setMonth] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const start = value?.date || availability?.earliestDate || first || null;
  useEffect(() => { if (start && (!month || (value?.date && monthOf(value.date) !== month))) setMonth(monthOf(start)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [start, value?.date]);
  useEffect(() => { if (focus) grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus(); }, [focus, month]);

  if (!availability) return <div className="h-72 animate-pulse rounded-2xl bg-ink-100" aria-label="Loading dates" />;
  const ym = month || monthOf(availability.today);
  const firstOfMonth = `${ym}-01`;
  const lead = weekdayYmd(firstOfMonth);
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = firstOfMonth; monthOf(d) === ym; d = addDaysYmd(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const canPrev = !!first && shiftMonth(ym, -1) >= monthOf(first);
  const canNext = !!last && shiftMonth(ym, 1) <= monthOf(last);
  const sel = value?.date ? byDate.get(value.date) : undefined;
  const tabbable = (value?.date && monthOf(value.date) === ym ? value.date : null) || cells.find((c) => c && byDate.get(c)?.status === 'AVAILABLE') || cells.find((c) => c) || null;

  const pick = (day: ChefAvailabilityDay) => { if (day.status === 'AVAILABLE') onChange({ date: day.date, time: value?.date === day.date ? value.time : '' }); };
  const onKey = (e: React.KeyboardEvent, date: string) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekdayYmd(date), End: 6 - weekdayYmd(date) };
    let next: string | null = null;
    if (e.key in moves) next = addDaysYmd(date, moves[e.key]);
    else if (e.key === 'PageUp' || e.key === 'PageDown') { const [, , dd] = date.split('-'); const m = shiftMonth(monthOf(date), e.key === 'PageUp' ? -1 : 1); next = `${m}-${dd}`; if (isNaN(Date.parse(next))) next = `${m}-28`; }
    if (!next) return;
    e.preventDefault();
    if ((first && next < first) || (last && next > last)) return;
    if (monthOf(next) !== ym) setMonth(monthOf(next));
    setFocus(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div><div className="font-semibold">{title}</div><div className="text-xs text-ink-500">{chefNoticeText(availability.rules.minLeadDays, availability.rules.cutoffHour)} · up to {availability.rules.maxAdvanceDays} days ahead</div></div>
        {loading && <span className="text-xs text-ink-500" aria-live="polite">Updating…</span>}
      </div>
      <div className="rounded-2xl border border-ink-100 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" className="grid h-10 w-10 place-items-center rounded-full text-lg hover:bg-ink-50 disabled:opacity-30" onClick={() => setMonth(shiftMonth(ym, -1))} disabled={!canPrev} aria-label="Previous month">‹</button>
          <div className="text-sm font-semibold" aria-live="polite">{monthLabel(ym)}</div>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-full text-lg hover:bg-ink-50 disabled:opacity-30" onClick={() => setMonth(shiftMonth(ym, 1))} disabled={!canNext} aria-label="Next month">›</button>
        </div>
        <div ref={grid} role="grid" aria-label={`Available dates, ${monthLabel(ym)}`} className="grid grid-cols-7 gap-1 text-center">
          {DOW.map((d) => <div key={d} role="columnheader" className="py-1 text-[11px] font-medium uppercase text-ink-500">{d}</div>)}
          {cells.map((c, i) => {
            if (!c) return <div key={`x${i}`} role="gridcell" />;
            const day = byDate.get(c);
            const ok = day?.status === 'AVAILABLE';
            const on = value?.date === c;
            const few = ok && day?.remaining !== null && day?.remaining !== undefined && day.remaining <= 5;
            const label = `${longDate(c)}: ${day ? CHEF_DAY_STATUS_LABEL[day.status] : 'Not available'}${few ? `, ${day!.remaining} left` : ''}`;
            return (
              <div key={c} role="gridcell" aria-selected={on}>
                <button type="button" data-date={c} tabIndex={c === tabbable ? 0 : -1} aria-label={label} aria-disabled={!ok} title={label} onKeyDown={(e) => onKey(e, c)} onFocus={() => setFocus(null)} onClick={() => day && pick(day)}
                  className={`relative flex h-11 w-full flex-col items-center justify-center rounded-xl text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${on ? 'bg-brand-600 font-semibold text-white' : ok ? 'bg-brand-50 font-medium text-ink-900 hover:bg-brand-100' : 'cursor-not-allowed text-ink-300'} ${c === availability.today ? 'underline underline-offset-2' : ''}`}>
                  <span>{Number(c.slice(8))}</span>
                  {few && <span className={`text-[9px] leading-none ${on ? 'text-white' : 'text-amber-700'}`}>{day!.remaining} left</span>}
                  {day?.status === 'SOLD_OUT' && <span className="text-[9px] leading-none text-ink-400">full</span>}
                  {day?.status === 'PAUSED' && <span className="text-[9px] leading-none text-ink-400">away</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-500"><span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-brand-50 ring-1 ring-brand-100" /> Available</span><span>“full” sold out · “away” chef is off</span></div>
      </div>
      {!availability.earliestDate && <p className="text-sm text-ink-700">No dates are open right now. Check back soon — chefs add cooking days regularly.</p>}
      {sel && (
        <div className="space-y-2">
          <div className="text-sm"><strong>{longDate(sel.date)}</strong>{sel.orderBy && <span className="text-ink-500"> · order by {orderByLabel(sel.orderBy, availability.timezone)}</span>}</div>
          {showTimes && (
            <div role="radiogroup" aria-label="Pickup or delivery time" className="flex flex-wrap gap-2">
              {sel.slots.map((t) => <button key={t} type="button" role="radio" aria-checked={value?.time === t} onClick={() => onChange({ date: sel.date, time: t })} className={`min-h-[40px] rounded-full border px-3 text-sm font-medium ${value?.time === t ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-200 bg-white text-ink-700 hover:border-brand-400'}`}>{timeLabel(t)}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Remembers the date a customer looked at on a dish page, so checkout can start there (per kitchen, this tab only). */
export const preferredDate = {
  get(locationId: string): string | null { try { return sessionStorage.getItem(`gutad.chefDate.${locationId}`); } catch { return null; } },
  set(locationId: string, date: string) { try { sessionStorage.setItem(`gutad.chefDate.${locationId}`, date); } catch { /* storage unavailable */ } },
};
