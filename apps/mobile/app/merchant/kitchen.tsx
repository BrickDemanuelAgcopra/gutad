import { WorkspaceGate } from '@/ops';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { GutadApiError, HANDLING_LABELS, KITCHEN_REASONS, REFUSAL_LABELS, SPECIAL_CATEGORY_LABELS, type HandlingFlag, type RefusalReason, type SpecialCategory } from '@gutad/shared';
import { api, when } from '@/api';
import { useAction, useApi, useStored } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';
import { Toggle } from '@/chef-ui';

interface KLine { id: string; name: string; quantity: number; modifiers: { name: string }[]; specialInstructions: string | null; status: string; handling: string[] }
interface Ticket { id: string; orderId: string; stationCode: string | null; status: string; kind: string; orderNumber: string; fireAt: string | null; readyBy: string | null; fireState: 'HOLD' | 'FIRE'; delayed: boolean; targetMinutes: number; minutesInProgress: number; tableNumber: string | null; lines: KLine[] }
interface Pack { id: string; orderId: string; orderNumber: string; bagCode: string; status: string; verifiedLineIds: string[]; blockedReason: string | null; checklist: { key: string; label: string; done: boolean }[]; bagCount: number; handling: string[]; tableNumber: string | null; lines: KLine[] }
interface Expo { orderId: string; number: string; tableNumber: string | null; holding: { stationCode: string | null }[]; readyLines: number; totalLines: number; foodWaitingMinutes: number; lateMinutes: number; status: string; shelfSlot: string | null }
interface Board { orders: { id: string; number: string; fulfillmentType: string; name: string | null; shelfSlot: string | null; waitingMinutes: number; overWait: boolean }[] }
interface Return { jobId: string; orderId: string | null; orderNumber: string | null; courierFirstName: string | null; categories: string[]; refusal: { reason: RefusalReason; note?: string | null; at: string } | null; since: string }
interface Runner { id: string; number: string; status: string; tableNumber: string | null; lines: { name: string; quantity: number }[] }

const hhmm = (d?: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const flagText = (f: string[]) => f.map((x) => HANDLING_LABELS[x as HandlingFlag] || x).join(' · ');
const REASON_SHORT = ['WRONG_BUILD', 'UNDERCOOKED', 'OVERCOOKED', 'COLD_FOOD', 'DROPPED', 'NOT_PACKED'];

/** Station, expo, packing and pickup screens (large type for the line). Works offline from the last known queue (13.8). */
function Kitchen() {
  const { loc } = useMerchantLocation();
  const kid = loc?.kitchenId || null;
  const [mode, setMode] = useState<'stations' | 'expo' | 'packing' | 'pickup'>(kid ? 'stations' : 'packing');
  const [cache, setCache] = useStored<{ at: string; tickets: Ticket[] } | null>(`gutad.kds.${kid}`, null);
  const [pending, setPending] = useStored<{ path: string; body: unknown }[]>('gutad.kds.pending', []);
  const { data: live, error: qErr, reload } = useApi<Ticket[]>(kid && mode === 'stations' ? `/kitchens/${kid}/stations/queue` : null, { poll: 4000, deps: [kid, mode] });
  const { data: expo } = useApi<Expo[]>(kid && mode === 'expo' ? `/kitchens/${kid}/expo` : null, { poll: 5000, deps: [kid, mode] });
  const { data: packs, reload: reloadPacks } = useApi<Pack[]>(loc && mode === 'packing' ? (kid ? `/kitchens/${kid}/packing` : `/locations/${loc.id}/packing`) : null, { poll: 4000, deps: [kid, loc?.id, mode] });
  const { data: board, reload: reloadBoard } = useApi<Board>(loc && mode === 'pickup' ? `/locations/${loc.id}/pickup-board` : null, { poll: 5000, deps: [loc?.id, mode] });
  const { data: runner, reload: reloadRunner } = useApi<Runner[]>(loc && mode === 'pickup' ? `/locations/${loc.id}/runner` : null, { poll: 5000, deps: [loc?.id, mode] });
  const { run, error } = useAction();
  const [problem, setProblem] = useState<{ orderId: string; line: KLine } | null>(null);
  const [code, setCode] = useState<Record<string, string>>({});
  useEffect(() => { if (live) setCache({ at: new Date().toISOString(), tickets: live }); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const offline = !!qErr && /fetch|network|timed? ?out/i.test(qErr);
  const tickets = live ?? cache?.tickets ?? [];
  // replay actions saved while offline
  const flush = useCallback(async () => {
    let q = pending;
    while (q.length) {
      try { await api.post(q[0].path, q[0].body); } catch (e) { if (!(e instanceof GutadApiError)) break; }
      q = q.slice(1);
    }
    if (q.length !== pending.length) { setPending(q); void reload(); }
  }, [pending, setPending, reload]);
  useEffect(() => { if (!offline && pending.length) void flush(); }, [offline, pending.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = (path: string, body: unknown = {}) => run(async () => {
    try { await api.post(path, body); } catch (e) { if (e instanceof GutadApiError) throw e; setPending((p) => [...p, { path, body }]); }
    await reload(); await reloadPacks(); await reloadBoard(); await reloadRunner();
  });
  if (!loc) return <Loading />;
  const modes = [...(kid ? [{ id: 'stations' as const, label: 'Stations' }, { id: 'expo' as const, label: 'Expo' }] : []), { id: 'packing' as const, label: 'Packing' }, { id: 'pickup' as const, label: 'Pickup' }];
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={mode} onChange={setMode} options={modes} />
      <ErrorText msg={error} />
      {mode === 'stations' && (
        <>
          {offline && <Card><Text style={{ color: C.bad, fontWeight: '700' }}>Offline</Text><Muted>Showing the queue from {when(cache?.at)}. Bumps are saved on this device{pending.length ? ` (${pending.length} waiting)` : ''} and sent when the connection returns. Use paper tickets (see the runbook on the web) if the screen goes blank.</Muted></Card>}
          {!tickets.length && <Muted>No tickets.</Muted>}
          {tickets.map((t) => (
            <Card key={t.id} style={t.delayed ? { borderColor: C.bad, borderWidth: 2 } : t.fireState === 'HOLD' ? { opacity: 0.7 } : undefined}>
              <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{t.orderNumber} · {t.stationCode}{t.kind === 'REMAKE' ? ' · REMAKE' : ''}{t.tableNumber ? ` · T${t.tableNumber}` : ''}</Text><Badge text={t.delayed ? 'LATE' : t.fireState === 'HOLD' ? `FIRE ${hhmm(t.fireAt)}` : t.status} tone={t.delayed ? 'bad' : tone(t.status)} /></View>
              <Muted>Ready by {hhmm(t.readyBy)} · target {t.targetMinutes} min{t.status === 'IN_PROGRESS' ? ` · ${t.minutesInProgress} min in` : ''}</Muted>
              {t.lines.map((l) => (
                <View key={l.id} style={[s.row, { marginTop: 6 }]}>
                  <Text style={{ flex: 1, fontSize: 18, textDecorationLine: l.status === 'READY' || l.status === 'UNAVAILABLE' ? 'line-through' : 'none', color: l.status === 'READY' ? C.good : C.ink }}><Text style={{ fontWeight: '800' }}>{l.quantity}× </Text>{l.name}{l.modifiers?.length ? <Text style={{ color: C.ink5 }}> — {l.modifiers.map((m) => m.name).join(', ')}</Text> : null}{l.specialInstructions ? <Text style={{ color: C.warn }}> “{l.specialInstructions}”</Text> : null}{l.handling?.includes('ALLERGEN') ? <Text style={{ color: C.bad }}> ALLERGY</Text> : null}</Text>
                  {l.status !== 'READY' && l.status !== 'UNAVAILABLE' ? <Button title="Bump" onPress={() => post(`/order-lines/${l.id}/bump`, { ready: true })} /> : <Button title="Undo" variant="ghost" onPress={() => post(`/order-lines/${l.id}/bump`, { ready: false })} />}
                  <Button title="!" variant="ghost" onPress={() => setProblem({ orderId: t.orderId, line: l })} />
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                {t.status === 'QUEUED' && <Button title={t.fireState === 'HOLD' ? 'Fire early' : 'Start'} variant={t.fireState === 'HOLD' ? 'secondary' : 'primary'} onPress={() => post(`/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' })} />}
                {t.status === 'IN_PROGRESS' && <Button title="All done" onPress={() => post(`/tickets/${t.id}/transition`, { status: 'DONE' })} />}
              </View>
            </Card>
          ))}
        </>
      )}
      {mode === 'expo' && (expo?.length ? expo.map((o) => (
        <Card key={o.orderId}>
          <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{o.number}{o.tableNumber ? ` · T${o.tableNumber}` : ''}</Text><Text>{o.readyLines}/{o.totalLines} ready</Text></View>
          <Text style={{ fontSize: 16, marginTop: 4 }}>{o.holding.length ? `Waiting on ${o.holding.map((h) => h.stationCode).join(', ')}` : o.status === 'READY' ? `Ready${o.shelfSlot ? ` · shelf ${o.shelfSlot}` : ''}` : 'All stations done → pack'}</Text>
          {o.foodWaitingMinutes > 0 && <Text style={{ color: o.foodWaitingMinutes >= 5 ? C.bad : C.ink5 }}>Finished food waiting {o.foodWaitingMinutes} min</Text>}
          {o.lateMinutes > 0 && <Text style={{ color: C.bad }}>{o.lateMinutes} min late</Text>}
        </Card>
      )) : <Muted>No active orders.</Muted>)}
      {mode === 'packing' && (packs?.length ? packs.map((p) => {
        const ready = p.lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status)).every((l) => p.verifiedLineIds.includes(l.id)) && p.checklist.every((c) => c.done);
        return (
          <Card key={p.id}>
            <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{p.orderNumber} · {p.bagCode}</Text><Badge text={p.status} tone={tone(p.status)} /></View>
            {!!p.handling.length && <Text style={{ color: p.handling.includes('ALLERGEN') ? C.bad : C.warn, fontWeight: '600' }}>{flagText(p.handling)}</Text>}
            {p.blockedReason && <Text style={{ color: C.bad }}>{p.blockedReason}</Text>}
            {p.lines.map((l) => <View key={l.id} style={[s.row, { marginTop: 6 }]}><Text style={{ fontSize: 16, flex: 1, textDecorationLine: l.status === 'UNAVAILABLE' ? 'line-through' : 'none' }}>{l.quantity}× {l.name} · {l.status}</Text>{p.verifiedLineIds.includes(l.id) ? <Text style={{ color: C.good }}>✓ in bag</Text> : l.status === 'READY' ? <Button title="In bag" variant="secondary" onPress={() => post(`/packing/${p.id}/verify`, { lineId: l.id })} /> : null}</View>)}
            {p.checklist.map((c) => <View key={c.key} style={[s.row, { marginTop: 4 }]}><Text style={{ flex: 1 }}>{c.done ? '☑' : '☐'} {c.label}</Text><Button title={c.done ? 'Undo' : 'Done'} variant="ghost" onPress={() => post(`/packing/${p.id}/checklist`, { key: c.key, done: !c.done })} /></View>)}
            <View style={[s.row, { marginTop: 6 }]}><Text>Bags: {p.bagCount}</Text><View style={{ flexDirection: 'row', gap: 6 }}><Button title="−" variant="secondary" disabled={p.bagCount <= 1} onPress={() => post(`/packing/${p.id}/bags`, { count: p.bagCount - 1 })} /><Button title="+" variant="secondary" onPress={() => post(`/packing/${p.id}/bags`, { count: p.bagCount + 1 })} /></View></View>
            <Button title={ready ? 'Release bag' : 'Verify items & checklist'} disabled={!ready || p.status === 'BLOCKED'} onPress={() => post(`/packing/${p.id}/release`)} />
          </Card>
        );
      }) : <Muted>Nothing to pack.</Muted>)}
      {mode === 'pickup' && (
        <>
          <Card title="Pickup shelves">
            {!board?.orders.length && <Muted>Nothing waiting.</Muted>}
            {board?.orders.map((o) => (
              <View key={o.id} style={{ marginBottom: 10 }}>
                <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{o.shelfSlot || '—'} · {o.number}</Text><Text style={{ color: o.overWait ? C.bad : C.ink5 }}>{o.waitingMinutes} min</Text></View>
                {o.fulfillmentType === 'DELIVERY' ? <Button title="Courier collected" onPress={() => post(`/orders/${o.id}/handoff`)} /> : <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Input label={`Code from ${o.name || 'customer'}`} autoCapitalize="characters" value={code[o.id] || ''} onChangeText={(v) => setCode({ ...code, [o.id]: v.toUpperCase() })} /></View><Button title="Collected" disabled={!code[o.id]} onPress={() => post(`/orders/${o.id}/handoff`, { pickupCode: code[o.id] })} /></View>}
              </View>
            ))}
          </Card>
          <DeliveryReturns locationId={loc.id} />
          <Card title="Runner: tables">
            {!runner?.length && <Muted>No dine-in orders.</Muted>}
            {runner?.map((o) => <View key={o.id} style={[s.row, { marginBottom: 8 }]}><View style={{ flex: 1 }}><Text style={{ fontSize: 18, fontWeight: '700' }}>Table {o.tableNumber || '—'} · {o.number}</Text><Muted>{o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}</Muted></View>{o.status === 'READY' ? <Button title="Served" onPress={() => post(`/orders/${o.id}/handoff`, { tableNumber: o.tableNumber || undefined })} /> : <Badge text={o.status} tone={tone(o.status)} />}</View>)}
          </Card>
        </>
      )}
      {problem && (
        <Card title={`Problem: ${problem.line.name}`}>
          <Muted>Remake it (goes back to the station):</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6 }}>{REASON_SHORT.map((r) => <Button key={r} title={KITCHEN_REASONS[r]} variant="secondary" onPress={() => { void post('/kitchen-events', { orderId: problem.orderId, orderLineId: problem.line.id, kind: r === 'NOT_PACKED' ? 'MISSING' : 'REMAKE', reasonCode: r }); setProblem(null); }} />)}</View>
          <View style={{ flexDirection: 'row', gap: 6 }}><Button title="86 (out of stock)" variant="danger" onPress={() => { void post(`/order-lines/${problem.line.id}/unavailable`, { note: 'Out of stock' }); setProblem(null); }} /><Button title="Cancel" variant="ghost" onPress={() => setProblem(null)} /></View>
        </Card>
      )}
    </ScrollView>
  );
}

/** Courier R4: refused restricted orders a courier is bringing back; the kitchen confirms receipt (chain of custody). */
function DeliveryReturns({ locationId }: { locationId: string }) {
  const { data, reload } = useApi<Return[]>(`/locations/${locationId}/delivery-returns`, { poll: 15000, deps: [locationId] });
  const { run, error, busy } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [sealIntact, setSealIntact] = useState(true);
  const [note, setNote] = useState('');
  if (!data?.length) return null;
  return (
    <Card title="Refused orders coming back">
      <ErrorText msg={error} />
      {data.map((r) => (
        <View key={r.jobId} style={{ marginBottom: 10, paddingBottom: 8, borderBottomWidth: 1, borderColor: C.ink1 }}>
          <View style={s.row}><Text style={{ fontSize: 18, fontWeight: '700' }}>{r.orderNumber || r.jobId.slice(0, 8)}</Text><Text style={{ color: C.ink5 }}>since {hhmm(r.since)}</Text></View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{r.categories.map((c) => <Badge key={c} text={SPECIAL_CATEGORY_LABELS[c as SpecialCategory] || c} tone="warn" />)}</View>
          <Muted>{r.refusal ? `Refused: ${REFUSAL_LABELS[r.refusal.reason] || r.refusal.reason}${r.refusal.note ? ` — ${r.refusal.note}` : ''}` : 'Returned'}{r.courierFirstName ? ` · courier ${r.courierFirstName}` : ''}</Muted>
          {open === r.jobId ? (
            <View style={{ marginTop: 6 }}>
              <Toggle on={sealIntact} onChange={setSealIntact} title="Seal intact" text={sealIntact ? undefined : 'Note what was opened or missing.'} />
              <Input label={sealIntact ? 'Note (optional)' : 'What was wrong?'} value={note} onChangeText={setNote} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Button title="Confirm received" disabled={busy || (!sealIntact && note.trim().length < 3)} onPress={() => run(async () => { await api.post(`/delivery-jobs/${r.jobId}/return-received`, { sealIntact, note: note.trim() || undefined }); setOpen(null); setNote(''); setSealIntact(true); await reload(); })} />
                <Button title="Cancel" variant="ghost" onPress={() => setOpen(null)} />
              </View>
            </View>
          ) : <Button title="Confirm received" variant="secondary" onPress={() => { setOpen(r.jobId); setSealIntact(true); setNote(''); }} />}
        </View>
      ))}
    </Card>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/kitchen"><Kitchen /></WorkspaceGate>;
}
