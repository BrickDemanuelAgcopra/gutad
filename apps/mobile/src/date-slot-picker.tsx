import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CHEF_DAY_STATUS_LABEL, addDaysYmd, chefNoticeText, weekdayYmd, type ChefAvailability } from '@gutad/shared';
import { C, Loading, Muted } from './ui';

const HEAD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ym = (d: string) => d.slice(0, 7);
const monthAdd = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + n, 1)); return t.toISOString().slice(0, 7); };
export const ymdLabel = (d: string, o: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', o);
/** An ISO instant shown in the kitchen's time zone (falls back to device time if Intl time zones are missing). */
export const zoneTime = (iso: string, tz: string) => { const o: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }; try { return new Date(iso).toLocaleString('en-US', { ...o, timeZone: tz }); } catch { return new Date(iso).toLocaleString('en-US', o); } };
/** Phase 5 chef checkout terms returned on quotes at chef kitchens. */
export interface ChefTerms { chargedNow: boolean; freeCancelUntil: string | null; lateRefundPct: number }
/** "Charged now. Full refund if the chef declines …" for one chef order (time in the kitchen's zone when known). */
export const chefTermsText = (t: ChefTerms, tz?: string | null) => `Charged now. Full refund if the chef declines or doesn’t confirm${t.freeCancelUntil ? `, or if you cancel before ${tz ? zoneTime(t.freeCancelUntil, tz) : new Date(t.freeCancelUntil).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}; after that ${t.lateRefundPct}% refund` : ''}.`;
/** "13:30" → "1:30 PM" */
export const hhmmLabel = (t: string) => { const [h, m] = t.split(':').map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/** A Sun–Sat month grid over a range of dated items, with prev/next limited to that range. */
export function MonthGrid<T extends { date: string }>({ days, focus, renderCell }: { days: T[]; focus?: string | null; renderCell: (date: string, day: T | undefined) => ReactNode }) {
  const first = days[0]?.date, last = days[days.length - 1]?.date;
  const [month, setMonth] = useState(ym(focus || first || new Date().toISOString().slice(0, 10)));
  useEffect(() => { if (focus) setMonth(ym(focus)); }, [focus]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  if (!first || !last) return null;
  const start = `${month}-01`;
  const cells: (string | null)[] = Array(weekdayYmd(start)).fill(null);
  for (let d = start; ym(d) === month; d = addDaysYmd(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const canPrev = month > ym(first), canNext = month < ym(last);
  const nav = (dir: -1 | 1, on: boolean) => <Pressable accessibilityRole="button" accessibilityLabel={dir < 0 ? 'Previous month' : 'Next month'} accessibilityState={{ disabled: !on }} disabled={!on} onPress={() => setMonth(monthAdd(month, dir))} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: on ? 1 : 0.3 }}><Text style={{ fontSize: 20, color: C.ink }}>{dir < 0 ? '‹' : '›'}</Text></Pressable>;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>{nav(-1, canPrev)}<Text accessibilityRole="header" style={{ fontWeight: '700', color: C.ink }}>{ymdLabel(start, { month: 'long', year: 'numeric' })}</Text>{nav(1, canNext)}</View>
      <View style={{ flexDirection: 'row' }}>{HEAD.map((h) => <Text key={h} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: C.ink5, fontWeight: '600', marginBottom: 4 }}>{h}</Text>)}</View>
      {Array.from({ length: cells.length / 7 }, (_, w) => <View key={w} style={{ flexDirection: 'row' }}>{cells.slice(w * 7, w * 7 + 7).map((d, i) => <View key={d || `x${w}-${i}`} style={{ flex: 1, padding: 2 }}>{d ? renderCell(d, byDate.get(d)) : null}</View>)}</View>)}
    </View>
  );
}

/**
 * Chef advance-ordering picker: month calendar of orderable dates, then times for the chosen date.
 * Only AVAILABLE dates can be picked; "N left" shows when 5 or fewer portions remain.
 */
export function DateSlotPicker({ availability: a, value, onChange, loading, hideTimes }: { availability: ChefAvailability | null; value: { date: string; time: string } | null; onChange: (v: { date: string; time: string }) => void; loading?: boolean; hideTimes?: boolean }) {
  if (!a) return loading ? <Loading /> : <Muted>Couldn’t load available dates.</Muted>;
  const sel = value ? a.days.find((d) => d.date === value.date) : undefined;
  return (
    <View style={{ opacity: loading ? 0.6 : 1 }}>
      <Muted>{chefNoticeText(a.rules.minLeadDays, a.rules.cutoffHour)} · up to {a.rules.maxAdvanceDays} days ahead</Muted>
      <View style={{ marginTop: 6 }}>
        <MonthGrid days={a.days} focus={value?.date || a.earliestDate} renderCell={(date, d) => {
          const ok = d?.status === 'AVAILABLE';
          const on = value?.date === date;
          const few = ok && d.remaining !== null && d.remaining <= 5;
          const label = `${ymdLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${d ? CHEF_DAY_STATUS_LABEL[d.status] : 'Not available'}${few ? `, ${d.remaining} left` : ''}`;
          return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on, disabled: !ok }} disabled={!ok} onPress={() => onChange({ date, time: '' })} style={{ minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: on ? C.brand : ok ? C.ink1 : 'transparent', backgroundColor: on ? C.brand : ok ? C.white : 'transparent', opacity: ok ? 1 : 0.35 }}>
            <Text style={{ fontWeight: ok ? '700' : '400', color: on ? C.white : C.ink, textDecorationLine: d && d.status === 'SOLD_OUT' ? 'line-through' : 'none' }}>{Number(date.slice(8))}</Text>
            {few && <Text style={{ fontSize: 9, color: on ? C.white : C.warn, fontWeight: '700' }}>{d.remaining} left</Text>}
          </Pressable>;
        }} />
      </View>
      <Muted>Bold dates can be ordered · faded dates are closed, sold out or not open yet</Muted>
      {!a.earliestDate && <Text style={{ color: C.warn, marginTop: 6 }}>No dates open right now.</Text>}
      {sel && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontWeight: '700', color: C.ink }}>{ymdLabel(sel.date, { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
          {sel.orderBy && <Muted>Order by {zoneTime(sel.orderBy, a.timezone)}</Muted>}
          {sel.remaining !== null && <Muted>{sel.remaining} portion{sel.remaining === 1 ? '' : 's'} left</Muted>}
          {!hideTimes && <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {sel.slots.map((t) => { const on = value?.time === t; return <Pressable key={t} accessibilityRole="radio" accessibilityLabel={hhmmLabel(t)} accessibilityState={{ checked: on }} onPress={() => onChange({ date: sel.date, time: t })} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, backgroundColor: on ? C.brand : C.white, borderWidth: 1, borderColor: on ? C.brand : C.ink1 }}><Text style={{ color: on ? C.white : C.ink7, fontSize: 13, fontWeight: '600' }}>{hhmmLabel(t)}</Text></Pressable>; })}
          </View>}
          {hideTimes && !!sel.slots.length && <Muted>Times {hhmmLabel(sel.slots[0])} – {hhmmLabel(sel.slots[sel.slots.length - 1])}</Muted>}
        </View>
      )}
    </View>
  );
}
