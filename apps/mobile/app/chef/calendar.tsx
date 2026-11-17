import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GutadApiError, WEEKDAYS, chefNoticeText, formatHour, type ChefCalendarDay, type ChefOperatingSettings, type ChefPause } from '@gutad/shared';
import { api } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { MonthGrid, ymdLabel } from '@/date-slot-picker';

interface Calendar { timezone: string; today: string; maxAdvanceCap: number; settings: ChefOperatingSettings; pauses: ChefPause[]; dishLimits: { menuItemId: string; name: string; limit: number | null }[]; days: ChefCalendarDay[] }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function Stepper({ label, value, min, max, onChange, format = String }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <View style={[s.row, { marginBottom: 4 }]}>
      <Text style={{ flex: 1, color: C.ink7 }}>{label}</Text>
      <Button title="−" variant="secondary" disabled={value <= min} onPress={() => onChange(Math.max(min, value - 1))} style={{ minWidth: 44, minHeight: 44 }} />
      <Text accessibilityLabel={`${label}: ${format(value)}`} style={{ minWidth: 64, textAlign: 'center', fontWeight: '700' }}>{format(value)}</Text>
      <Button title="+" variant="secondary" disabled={value >= max} onPress={() => onChange(Math.min(max, value + 1))} style={{ minWidth: 44, minHeight: 44 }} />
    </View>
  );
}

const dayState = (d: ChefCalendarDay) => d.pause ? `Away${d.pause.reason ? ` · ${d.pause.reason}` : ''}` : !d.open ? (d.cookingDay ? 'Closed (override)' : 'Not a cooking day') : d.closedForOrders ? 'Open · ordering closed' : 'Open for orders';

/** Chef cooking calendar: weekly settings, per-date overrides (close/open, capacity), and time away. */
export default function ChefCalendarScreen() {
  const { data, setData, error, reload } = useApi<Calendar>('/chef/calendar');
  const { run, busy, error: actErr } = useAction();
  const [draft, setDraft] = useState<ChefOperatingSettings | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState<{ kind: 'day' | 'pause'; msg: string; retry: () => Promise<void> } | null>(null);
  const [pause, setPause] = useState({ startDate: '', endDate: '', reason: '' });
  useEffect(() => { if (data && !draft) setDraft(data.settings); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const day = sel ? data?.days.find((d) => d.date === sel) : undefined;
  useEffect(() => { setCap(day?.override?.capacity != null ? String(day.override.capacity) : ''); setNote(day?.override?.note || ''); setConflict(null); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <View style={[s.screen, s.pad]}><ErrorText msg={error} /></View>;
  if (!data || !draft) return <Loading />;
  const set = (p: Partial<ChefOperatingSettings>) => setDraft({ ...draft, ...p });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const windowOk = HHMM.test(draft.opens) && HHMM.test(draft.closes) && draft.closes > draft.opens;
  const saveSettings = () => run(async () => { const c = await api.put<Calendar>('/chef/calendar/settings', draft); setData(c); setDraft(c.settings); });
  /** Runs a change that may hit HAS_ORDERS; offers "Close anyway" which retries with acknowledgeOrders. */
  const guarded = (kind: 'day' | 'pause', fn: (ack: boolean) => Promise<void>) => run(async () => {
    setConflict(null);
    try { await fn(false); } catch (e) {
      if (e instanceof GutadApiError && (e.body as unknown as { code?: string } | null)?.code === 'HAS_ORDERS') { setConflict({ kind, msg: e.message, retry: () => run(async () => { await fn(true); setConflict(null); }).then(() => undefined) }); return; }
      throw e;
    }
  });
  const putDay = (date: string, body: Record<string, unknown>) => guarded('day', async (ack) => { const d = await api.put<ChefCalendarDay>(`/chef/calendar/days/${date}`, { ...body, ...(ack ? { acknowledgeOrders: true } : {}) }); setData((c) => c && { ...c, days: c.days.map((x) => (x.date === d.date ? d : x)) }); });
  const addPause = () => guarded('pause', async (ack) => { await api.post('/chef/calendar/pauses', { startDate: pause.startDate, endDate: pause.endDate || pause.startDate, reason: pause.reason || null, ...(ack ? { acknowledgeOrders: true } : {}) }); setPause({ startDate: '', endDate: '', reason: '' }); await reload(); });
  const st = data.settings;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Card title="Weekly schedule">
        <Muted>Customers see: {chefNoticeText(st.minLeadDays, st.cutoffHour)} · up to {st.maxAdvanceDays} days ahead · {st.dailyCapacity} portions/day · times in {data.timezone}</Muted>
        <Text style={[s.label, { marginTop: 8 }]}>Cooking days</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{WEEKDAYS.map((w, i) => { const on = draft.cookingDays.includes(i); return <Pressable key={w} accessibilityRole="checkbox" accessibilityLabel={w} accessibilityState={{ checked: on }} onPress={() => set({ cookingDays: on ? draft.cookingDays.filter((x) => x !== i) : [...draft.cookingDays, i].sort() })} style={{ minWidth: 44, minHeight: 44, paddingHorizontal: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: on ? C.brand : C.ink1, backgroundColor: on ? C.brand : C.white }}><Text style={{ color: on ? C.white : C.ink7, fontWeight: '600' }}>{w}</Text></Pressable>; })}</View>
        <Stepper label="Order cutoff" value={draft.cutoffHour} min={0} max={23} format={formatHour} onChange={(v) => set({ cutoffHour: v })} />
        <Stepper label="Notice (days before)" value={draft.minLeadDays} min={0} max={30} onChange={(v) => set({ minLeadDays: v })} />
        <Stepper label="Portions per day" value={draft.dailyCapacity} min={1} max={2000} onChange={(v) => set({ dailyCapacity: v })} />
        <Stepper label="Order up to (days ahead)" value={draft.maxAdvanceDays} min={1} max={data.maxAdvanceCap} onChange={(v) => set({ maxAdvanceDays: v })} />
        <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="Pickup from (HH:MM)" value={draft.opens} onChangeText={(v) => set({ opens: v })} placeholder="11:00" /></View><View style={{ flex: 1 }}><Input label="Until (HH:MM)" value={draft.closes} onChangeText={(v) => set({ closes: v })} placeholder="19:00" /></View></View>
        {!windowOk && <Text style={{ color: C.warn, fontSize: 12 }}>Use 24-hour HH:MM, with the end after the start.</Text>}
        <Muted>{draft.cookingDays.length ? `Preview: ${chefNoticeText(draft.minLeadDays, draft.cutoffHour)}` : 'Pick at least one cooking day (use time away for breaks).'}</Muted>
        <View style={{ flexDirection: 'row', gap: 8 }}><Button title={busy ? 'Saving…' : 'Save schedule'} disabled={busy || !dirty || !windowOk || !draft.cookingDays.length} onPress={saveSettings} />{dirty && <Button title="Undo" variant="ghost" onPress={() => setDraft(data.settings)} />}</View>
      </Card>
      <ErrorText msg={actErr} />
      <Card title="Calendar">
        <Muted>Tap a date to close it, open it, or change its capacity.</Muted>
        <View style={{ marginTop: 6 }}>
          <MonthGrid days={data.days} focus={sel || data.today} renderCell={(date, d) => {
            const on = sel === date;
            if (!d) return <View style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}><Text>{Number(date.slice(8))}</Text></View>;
            const bg = d.pause ? '#fef3c7' : d.open ? C.white : C.ink1;
            return <Pressable accessibilityRole="button" accessibilityLabel={`${ymdLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${dayState(d)}, ${d.booked} of ${d.capacity} booked${d.held ? `, ${d.held} held` : ''}`} accessibilityState={{ selected: on }} onPress={() => setSel(date)} style={{ minHeight: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: on ? 2 : 1, borderColor: on ? C.brand : d.open ? C.good : C.ink1, backgroundColor: bg }}>
              <Text style={{ fontWeight: '700', color: d.open ? C.ink : C.ink5 }}>{Number(date.slice(8))}</Text>
              {d.open ? <Text style={{ fontSize: 9, color: d.booked >= d.capacity ? C.bad : C.ink5 }}>{d.booked}/{d.capacity}</Text> : <Text style={{ fontSize: 9, color: C.ink5 }}>{d.pause ? 'away' : 'off'}</Text>}
              {d.held > 0 && <Text style={{ fontSize: 8, color: C.info }}>+{d.held} held</Text>}
            </Pressable>;
          }} />
        </View>
        <Muted>Green border = open · grey = closed · yellow = time away · booked/capacity · held = in someone’s checkout</Muted>
      </Card>
      {day && (
        <Card title={ymdLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}><Badge text={dayState(day)} tone={day.pause ? 'warn' : day.open ? 'good' : 'neutral'} />{day.override && <Badge text="Override" tone="info" />}</View>
          <Text>{day.booked} of {day.capacity} portions booked · {day.orders} order{day.orders === 1 ? '' : 's'}{day.held ? ` · ${day.held} held` : ''}</Text>
          {day.override?.note && <Muted>Note: {day.override.note}</Muted>}
          {!!day.dishes.length && <View style={{ marginTop: 6 }}><Text style={s.label}>Dishes</Text>{day.dishes.map((x) => <View key={x.menuItemId} style={s.row}><Text style={{ flex: 1 }}>{x.name}</Text><Muted>{x.units}{x.limit !== null ? ` / ${x.limit}` : ''}</Muted></View>)}</View>}
          {conflict?.kind === 'day' && <View style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: '#fef3c7' }}><Text style={{ color: '#92400e' }}>{conflict.msg}</Text><View style={{ flexDirection: 'row', gap: 8 }}><Button title="Close anyway" variant="danger" disabled={busy} onPress={() => void conflict.retry()} /><Button title="Keep open" variant="ghost" onPress={() => setConflict(null)} /></View></View>}
          {!day.pause && <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {day.open ? <Button title="Close this day" variant="secondary" disabled={busy} onPress={() => putDay(day.date, { open: false, note: note || null })} /> : <Button title="Open this day" disabled={busy} onPress={() => putDay(day.date, { open: true, note: note || null })} />}
            {day.override && <Button title="Clear override" variant="ghost" disabled={busy} onPress={() => putDay(day.date, { open: null, capacity: null, note: null })} />}
          </View>}
          {day.pause && <Muted>You’re away this day. Remove the time away below to change it.</Muted>}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
            <View style={{ flex: 1 }}><Input label={`Capacity for this date (default ${data.settings.dailyCapacity})`} keyboardType="number-pad" value={cap} onChangeText={(v) => setCap(v.replace(/\D/g, ''))} placeholder={String(data.settings.dailyCapacity)} /></View>
            <Button title="Set" disabled={busy || cap === ''} onPress={() => putDay(day.date, { capacity: Number(cap) })} style={{ marginBottom: 12 }} />
          </View>
          <Input label="Note (optional, for you)" value={note} onChangeText={setNote} maxLength={200} />
        </Card>
      )}
      <Card title="Time away">
        <Muted>New orders stop for these dates. Existing orders stay; cook or cancel them.</Muted>
        {!data.pauses.length && <Muted>No time away planned.</Muted>}
        {data.pauses.map((p) => <View key={p.id} style={[s.row, { marginTop: 6 }]}><View style={{ flex: 1 }}><Text>{ymdLabel(p.startDate)}{p.endDate !== p.startDate ? ` – ${ymdLabel(p.endDate)}` : ''}</Text>{p.reason && <Muted>{p.reason}</Muted>}</View><Button title="Remove" variant="ghost" disabled={busy} onPress={() => run(async () => { await api.delete(`/chef/calendar/pauses/${p.id}`); await reload(); })} /></View>)}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><View style={{ flex: 1 }}><Input label="From (YYYY-MM-DD)" value={pause.startDate} onChangeText={(v) => setPause({ ...pause, startDate: v })} placeholder={data.today} autoCapitalize="none" /></View><View style={{ flex: 1 }}><Input label="To (YYYY-MM-DD)" value={pause.endDate} onChangeText={(v) => setPause({ ...pause, endDate: v })} placeholder={pause.startDate || data.today} autoCapitalize="none" /></View></View>
        <Input label="Reason (optional)" value={pause.reason} onChangeText={(v) => setPause({ ...pause, reason: v })} maxLength={200} />
        {conflict?.kind === 'pause' && <View style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: '#fef3c7' }}><Text style={{ color: '#92400e' }}>{conflict.msg}</Text><View style={{ flexDirection: 'row', gap: 8 }}><Button title="Add anyway" variant="danger" disabled={busy} onPress={() => void conflict.retry()} /><Button title="Cancel" variant="ghost" onPress={() => setConflict(null)} /></View></View>}
        <Button title="Add time away" disabled={busy || !YMD.test(pause.startDate) || (!!pause.endDate && (!YMD.test(pause.endDate) || pause.endDate < pause.startDate))} onPress={addPause} />
      </Card>
    </ScrollView>
  );
}
