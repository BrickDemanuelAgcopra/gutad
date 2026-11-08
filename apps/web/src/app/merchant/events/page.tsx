'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, statusTone, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

export default function MerchantEvents() {
  const { loc } = useMerchant();
  const { data: exps, reload } = useApi<{ id: string; name: string; pricingMode: string; priceCents: number; sessions: { id: string; startAt: string; capacity: number; remaining: number }[] }[]>(loc ? `/public/locations/${loc.id}/experiences` : null, { deps: [loc?.id] });
  const { data: inq, reload: reloadInq } = useApi<{ id: string; status: string; contactName: string; contactEmail: string; eventDate: string; partySize: number; finalHeadcount: number | null; budgetCents: number | null; notes: string | null; proposalCents: number | null; depositCents: number; balanceCents: number }[]>(loc ? `/locations/${loc.id}/event-inquiries` : null, { poll: 15000, deps: [loc?.id] });
  const { run, error } = useAction();
  const [n, setN] = useState<{ name: string; description: string; pricingMode: 'FREE' | 'PREPAID_PER_PERSON' | 'PREPAID_PER_PARTY' | 'PAY_AT_VENUE'; price: string; sessions: string; capacity: string; addOns: string } | null>(null);
  const [prop, setProp] = useState<{ id: string; proposal: string; deposit: string } | null>(null);
  const [ticketCode, setTicketCode] = useState('');
  if (!loc) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); await reloadInq(); });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Experiences & private events</h1><Button onClick={() => setN({ name: '', description: '', pricingMode: 'PREPAID_PER_PERSON', price: '', sessions: '', capacity: '12', addOns: '' })}>+ Experience</Button></div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 md:grid-cols-2">
        {exps?.map((e) => <Card key={e.id} title={e.name}><p className="text-sm text-ink-500">{e.pricingMode} {e.priceCents ? money(e.priceCents) : ''}</p><ul className="mt-2 text-sm">{e.sessions.map((s) => <li key={s.id} className="flex items-center justify-between py-1"><span>{when(s.startAt)} · {s.capacity - s.remaining}/{s.capacity} sold</span><Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/experience-sessions/${s.id}/close`, {}).then((r) => alert(JSON.stringify(r))))}>Close & reconcile</Button></li>)}</ul></Card>)}
      </div>
      <Card title="Validate attendance"><div className="flex gap-2"><Input placeholder="Ticket id" value={ticketCode} onChange={(e) => setTicketCode(e.target.value)} /><Button variant="secondary" onClick={() => act(() => api.post(`/tickets/${ticketCode}/attend`, { extrasOnsiteCents: 0 }))}>Mark attended</Button></div></Card>
      <Card title="Private event inquiries">
        <div className="space-y-2">
          {inq?.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 text-sm">
              <div><b>{i.contactName}</b> · {i.contactEmail} · {when(i.eventDate)} · {i.partySize} guests{i.finalHeadcount ? ` (final ${i.finalHeadcount})` : ''}{i.budgetCents ? ` · budget ${money(i.budgetCents)}` : ''}{i.proposalCents ? ` · proposal ${money(i.proposalCents)} / deposit ${money(i.depositCents)}` : ''}{i.notes && <div className="text-xs italic text-ink-500">{i.notes}</div>}</div>
              <div className="flex items-center gap-1"><Badge tone={statusTone(i.status)}>{i.status}</Badge>{['INQUIRY', 'QUALIFIED', 'PROPOSED'].includes(i.status) && <Button size="sm" onClick={() => setProp({ id: i.id, proposal: '', deposit: '' })}>Send proposal</Button>}{i.status === 'CONFIRMED' && <Button size="sm" onClick={() => { const f = prompt('Final total (USD)', ((i.proposalCents || 0) / 100).toFixed(2)); if (f) act(() => api.post(`/event-inquiries/${i.id}/settle`, { finalCents: Math.round(Number(f) * 100), paymentMethodId: 'mock_pm_4242' })); }}>Settle balance</Button>}{!['COMPLETED', 'CANCELED', 'EXPIRED'].includes(i.status) && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/event-inquiries/${i.id}/cancel`, { reason: 'Venue canceled' }))}>Cancel</Button>}</div>
            </div>
          ))}
          {!inq?.length && <p className="text-sm text-ink-500">No inquiries yet.</p>}
        </div>
      </Card>
      <Modal open={!!n} onClose={() => setN(null)} title="New experience">
        {n && (<div className="space-y-2"><Input label="Name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /><Textarea label="Description" value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /><Select label="Pricing" value={n.pricingMode} onChange={(e) => setN({ ...n, pricingMode: e.target.value as never })}><option value="FREE">Free</option><option value="PREPAID_PER_PERSON">Prepaid per person</option><option value="PREPAID_PER_PARTY">Prepaid per party</option><option value="PAY_AT_VENUE">Pay at venue</option></Select><Input label="Price (USD)" value={n.price} onChange={(e) => setN({ ...n, price: e.target.value })} /><Textarea label="Session start times (ISO or YYYY-MM-DDTHH:MM, one per line)" value={n.sessions} onChange={(e) => setN({ ...n, sessions: e.target.value })} /><Input label="Capacity per session" value={n.capacity} onChange={(e) => setN({ ...n, capacity: e.target.value })} /><Textarea label="Add-ons (Name=price per line)" value={n.addOns} onChange={(e) => setN({ ...n, addOns: e.target.value })} /><Button onClick={() => act(async () => { await api.post(`/locations/${loc.id}/experiences`, { name: n.name, description: n.description, pricingMode: n.pricingMode, priceCents: Math.round(Number(n.price || 0) * 100), sessions: n.sessions.split('\n').filter(Boolean).map((s) => ({ startAt: new Date(s).toISOString(), capacity: Number(n.capacity) })), addOns: n.addOns.split('\n').filter(Boolean).map((l) => { const [a, p] = l.split('='); return { name: a.trim(), priceCents: Math.round(Number(p || 0) * 100) }; }) }); setN(null); })}>Publish</Button></div>)}
      </Modal>
      <Modal open={!!prop} onClose={() => setProp(null)} title="Proposal">
        {prop && (<div className="space-y-2"><Input label="Proposal total (USD)" value={prop.proposal} onChange={(e) => setProp({ ...prop, proposal: e.target.value })} /><Input label="Deposit (USD)" value={prop.deposit} onChange={(e) => setProp({ ...prop, deposit: e.target.value })} /><p className="text-xs text-ink-500">Valid 7 days; the space is held only until the proposal expires or the deposit is paid.</p><Button onClick={() => act(async () => { await api.post(`/event-inquiries/${prop.id}/propose`, { proposalCents: Math.round(Number(prop.proposal) * 100), depositCents: Math.round(Number(prop.deposit || 0) * 100) }); setProp(null); })}>Send</Button></div>)}
      </Modal>
    </div>
  );
}
