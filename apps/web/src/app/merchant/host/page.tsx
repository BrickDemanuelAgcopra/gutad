'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone } from '@/components/ui';
import { useMerchant } from '../context';

interface R { id: string; confirmationCode: string; status: string; partySize: number; actualPartySize: number | null; startAt: string; guestName: string; guestPhone: string | null; channel: string; notes: string | null; occasion: string | null; tableIds: string[] }
interface W { id: string; guestName: string; partySize: number; status: string; quotedMinutes: number; position: number; offerExpiresAt: string | null }
interface Board { date: string; reservations: R[]; waitlist: W[]; floor: { rooms: { id: string; name: string }[]; tables: { id: string; name: string; roomId: string | null; minSeats: number; maxSeats: number; occupied: boolean }[] } }

/** Host stand: phone bookings, walk-ins, queue, table-ready, check-in, seat/move, close, no-show. */
export default function HostStand() {
  const { loc } = useMerchant();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { data: b, reload } = useApi<Board>(loc ? `/locations/${loc.id}/host?date=${date}` : null, { poll: 6000, deps: [loc?.id, date] });
  const { run, error } = useAction();
  const [book, setBook] = useState<{ guestName: string; partySize: number; guestPhone: string; channel: 'PHONE' | 'WALK_IN'; startAt: string } | null>(null);
  const [seat, setSeat] = useState<{ r: R; tableIds: string[]; party: number } | null>(null);
  const [close, setClose] = useState<{ r: R; check: string } | null>(null);
  if (!loc) return null;
  if (!loc.acceptsReservations) return <Alert tone="info">Enable reservations in Settings and set up your floor plan and shifts.</Alert>;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const tableName = (id: string) => b?.floor.tables.find((t) => t.id === id)?.name || '?';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Host stand</h1>
        <div className="flex items-end gap-2"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /><Button onClick={() => setBook({ guestName: '', partySize: 2, guestPhone: '', channel: 'WALK_IN', startAt: '' })}>Walk-in / phone booking</Button></div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          {b?.reservations.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-100 bg-white p-3 text-sm">
              <div><b>{new Date(r.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b> · {r.guestName} · party of {r.actualPartySize ?? r.partySize} · <span className="text-ink-500">{r.channel} · {r.confirmationCode}</span>{r.tableIds.length > 0 && <span className="ml-1 text-ink-500">· {r.tableIds.map(tableName).join('+')}</span>}{r.occasion && <span className="ml-1 text-xs text-brand-600">{r.occasion}</span>}{r.notes && <div className="text-xs italic text-ink-500">{r.notes}</div>}</div>
              <div className="flex items-center gap-1">
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                {r.status === 'CONFIRMED' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/reservations/${r.id}/host`, { action: 'ARRIVE' }))}>Arrived</Button>}
                {['CONFIRMED', 'ARRIVED'].includes(r.status) && <Button size="sm" onClick={() => setSeat({ r, tableIds: r.tableIds, party: r.actualPartySize ?? r.partySize })}>Seat</Button>}
                {['CONFIRMED', 'ARRIVED'].includes(r.status) && <Button size="sm" variant="ghost" onClick={() => confirm('Mark as no-show? Policy fees may apply.') && act(() => api.post(`/reservations/${r.id}/host`, { action: 'NO_SHOW' }))}>No-show</Button>}
                {r.status === 'SEATED' && <Button size="sm" variant="secondary" onClick={() => setSeat({ r, tableIds: r.tableIds, party: r.actualPartySize ?? r.partySize })}>Move</Button>}
                {r.status === 'SEATED' && <Button size="sm" onClick={() => setClose({ r, check: '' })}>Close visit</Button>}
                {['HELD', 'CONFIRMED'].includes(r.status) && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/reservations/${r.id}/cancel`, { reason: 'Host canceled' }))}>Cancel</Button>}
              </div>
            </div>
          ))}
          {!b?.reservations.length && <p className="text-sm text-ink-500">No bookings for this date.</p>}
        </div>
        <div className="space-y-4">
          <Card title={`Waitlist (${b?.waitlist.length || 0})`}>
            {b?.waitlist.map((w) => <div key={w.id} className="flex items-center justify-between border-b border-ink-100 py-2 text-sm"><span>#{w.position} {w.guestName} · {w.partySize} · ~{w.quotedMinutes}m {w.status === 'NOTIFIED' && <Badge tone="warn">notified</Badge>}</span><div className="flex gap-1">{w.status === 'WAITING' && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/waitlist/${w.id}/notify`, {}))}>Table ready</Button>}<Button size="sm" onClick={() => act(() => api.post(`/waitlist/${w.id}/seat`, {}))}>Seat</Button><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/public/waitlist/${w.id}/leave`, {}))}>Left</Button></div></div>)}
            {!b?.waitlist.length && <p className="text-sm text-ink-500">Queue is empty.</p>}
          </Card>
          <Card title="Floor">
            {b?.floor.rooms.map((room) => <div key={room.id} className="mb-2"><div className="text-xs font-semibold uppercase text-ink-500">{room.name}</div><div className="mt-1 flex flex-wrap gap-1">{b.floor.tables.filter((t) => t.roomId === room.id).map((t) => <span key={t.id} className={`rounded-md px-2 py-1 text-xs ${t.occupied ? 'bg-brand-500 text-white' : 'bg-ink-100'}`}>{t.name} ({t.minSeats}–{t.maxSeats})</span>)}</div></div>)}
          </Card>
        </div>
      </div>
      <Modal open={!!book} onClose={() => setBook(null)} title="New booking">
        {book && (<div className="space-y-2"><Select label="Type" value={book.channel} onChange={(e) => setBook({ ...book, channel: e.target.value as 'PHONE' | 'WALK_IN' })}><option value="WALK_IN">Walk-in (now)</option><option value="PHONE">Phone booking</option></Select><Input label="Guest name" value={book.guestName} onChange={(e) => setBook({ ...book, guestName: e.target.value })} /><Input label="Phone" value={book.guestPhone} onChange={(e) => setBook({ ...book, guestPhone: e.target.value })} /><Input label="Party size" type="number" value={book.partySize} onChange={(e) => setBook({ ...book, partySize: Number(e.target.value) })} />{book.channel === 'PHONE' && <Input label="Date & time" type="datetime-local" value={book.startAt} onChange={(e) => setBook({ ...book, startAt: e.target.value })} />}<Button onClick={() => act(async () => { await api.post(`/locations/${loc.id}/host/book`, { ...book, startAt: book.channel === 'PHONE' ? new Date(book.startAt).toISOString() : undefined }); setBook(null); })}>Book</Button></div>)}
      </Modal>
      <Modal open={!!seat} onClose={() => setSeat(null)} title={`Seat ${seat?.r.guestName}`}>
        {seat && (<div className="space-y-2"><Input label="Actual party size" type="number" value={seat.party} onChange={(e) => setSeat({ ...seat, party: Number(e.target.value) })} /><div className="flex flex-wrap gap-1">{b?.floor.tables.map((t) => <button key={t.id} onClick={() => setSeat({ ...seat, tableIds: seat.tableIds.includes(t.id) ? seat.tableIds.filter((x) => x !== t.id) : [...seat.tableIds, t.id] })} className={`rounded-md border px-2 py-1 text-xs ${seat.tableIds.includes(t.id) ? 'border-brand-500 bg-brand-50' : t.occupied ? 'border-ink-100 bg-ink-100 text-ink-300' : 'border-ink-100'}`}>{t.name}</button>)}</div><Button onClick={() => act(async () => { await api.post(`/reservations/${seat.r.id}/host`, { action: seat.r.status === 'SEATED' ? 'MOVE' : 'SEAT', tableIds: seat.tableIds, actualPartySize: seat.party }); setSeat(null); })}>{seat.r.status === 'SEATED' ? 'Move' : 'Seat'}</Button></div>)}
      </Modal>
      <Modal open={!!close} onClose={() => setClose(null)} title="Close visit">
        {close && (<div className="space-y-2"><p className="text-sm text-ink-500">Actual covers drive cover billing. Enter the POS check total for guest history (optional).</p><Input label="Check total (USD)" value={close.check} onChange={(e) => setClose({ ...close, check: e.target.value })} /><Button onClick={() => act(async () => { await api.post(`/reservations/${close.r.id}/host`, { action: 'COMPLETE', checkTotalCents: close.check ? Math.round(Number(close.check) * 100) : undefined }); setClose(null); })}>Close & clear table</Button></div>)}
      </Modal>
      <p className="text-xs text-ink-300">Board for {b?.date} · auto-refreshes · {when(new Date())}</p>
    </div>
  );
}
