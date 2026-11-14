'use client';
import { CardField, type CardToken } from '@/components/card-field';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, statusTone } from '@/components/ui';

export default function InquiryPage() {
  const { id } = useParams<{ id: string }>();
  const { data: i, reload } = useApi<{ id: string; status: string; eventDate: string; partySize: number; finalHeadcount: number | null; proposalCents: number | null; depositCents: number; proposalExpiresAt: string | null; contractUrl: string | null; balanceCents: number }>(`/event-inquiries/${id}`, { poll: 15000 });
  const [card, setCard] = useState<CardToken | null>(null);
  const [head, setHead] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!i) return <Spinner />;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card title="Private event inquiry" action={<Badge tone={statusTone(i.status)}>{i.status}</Badge>}>
        <p className="text-sm">{when(i.eventDate)} · {i.partySize} guests{i.finalHeadcount ? ` (final ${i.finalHeadcount})` : ''}</p>
        {i.status === 'INQUIRY' && <p className="mt-2 text-sm text-ink-500">The venue is reviewing your request. You will get a proposal by email.</p>}
        {i.status === 'PROPOSED' && (
          <div className="mt-3 space-y-2">
            <p className="text-sm">Proposal: <b>{money(i.proposalCents || 0)}</b> with a <b>{money(i.depositCents)}</b> deposit. Valid until {when(i.proposalExpiresAt)}.</p>
            {i.contractUrl && <a className="text-sm underline" href={i.contractUrl} target="_blank" rel="noreferrer">Review contract</a>}
            <CardField label="Card for the deposit" value={card} onChange={setCard} />
            <Button onClick={async () => { try { await api.post(`/event-inquiries/${i.id}/accept`, { paymentMethodId: card?.token }); setMsg('Space confirmed!'); reload(); } catch (e) { setMsg((e as Error).message); } }}>Accept & pay deposit</Button>
          </div>
        )}
        {i.status === 'CONFIRMED' && (
          <div className="mt-3 flex items-end gap-2">
            <Input label="Final headcount" type="number" value={head} onChange={(e) => setHead(e.target.value)} />
            <Button variant="secondary" onClick={async () => { await api.post(`/event-inquiries/${i.id}/headcount`, { finalHeadcount: Number(head) }); reload(); }}>Save</Button>
          </div>
        )}
        {i.status === 'COMPLETED' && <p className="mt-2 text-sm">Final balance {money(i.balanceCents)} settled. Thank you!</p>}
        {!['COMPLETED', 'CANCELED', 'EXPIRED'].includes(i.status) && <Button className="mt-3" variant="ghost" onClick={async () => { await api.post(`/event-inquiries/${i.id}/cancel`, { reason: 'Customer canceled' }); reload(); }}>Cancel inquiry</Button>}
      </Card>
      {msg && <Alert tone="info">{msg}</Alert>}
    </div>
  );
}
