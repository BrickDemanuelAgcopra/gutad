'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, when, money } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, statusTone } from '@/components/ui';

export default function ReservationPage() {
  const { code } = useParams<{ code: string }>();
  const email = useSearchParams().get('email') || '';
  const { data: r, reload, error } = useApi<{ id: string; status: string; confirmationCode: string; partySize: number; startAt: string; guestName: string; location: { name: string; addressLine1: string; city: string }; policy: { cancellationHours: number; noShowFeeCents: number; depositCents: number } | null; requiresPayment: boolean; depositCents: number }>(`/public/reservations/by-code/${code}?email=${encodeURIComponent(email)}`);
  const [card, setCard] = useState('');
  const [party, setParty] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!r) return <Spinner />;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card title={`Reservation ${r.confirmationCode}`} action={<Badge tone={statusTone(r.status)}>{r.status}</Badge>}>
        <p className="text-sm"><b>{r.location.name}</b> · {r.location.addressLine1}, {r.location.city}</p>
        <p className="text-sm">{when(r.startAt)} · party of {r.partySize} · {r.guestName}</p>
        {r.policy && <p className="mt-2 text-xs text-ink-500">Cancel free up to {r.policy.cancellationHours}h before.{r.depositCents ? ` Deposit ${money(r.depositCents)} applies to your check.` : ''}{r.policy.noShowFeeCents ? ` No-show fee ${money(r.policy.noShowFeeCents)}/guest.` : ''}</p>}
      </Card>
      {r.requiresPayment && (
        <Card title="Add a card to confirm">
          <Input placeholder="4242 4242 4242 4242" value={card} onChange={(e) => setCard(e.target.value)} />
          <Button className="mt-2" onClick={() => act(() => api.post(`/reservations/${r.id}/confirm`, { paymentMethodId: `mock_pm_${card.slice(-4) || '4242'}` }), 'Confirmed!')}>Confirm reservation</Button>
        </Card>
      )}
      {['CONFIRMED', 'HELD'].includes(r.status) && (
        <Card title="Change or cancel">
          <div className="flex items-end gap-2">
            <Input label="New party size" type="number" value={party ?? r.partySize} onChange={(e) => setParty(Number(e.target.value))} />
            <Button variant="secondary" onClick={() => act(() => api.patch(`/reservations/${r.id}`, { partySize: party ?? r.partySize }), 'Updated')}>Update</Button>
            <Button variant="danger" onClick={() => act(() => api.post(`/reservations/${r.id}/cancel`, { reason: 'Guest canceled' }), 'Canceled')}>Cancel</Button>
          </div>
        </Card>
      )}
      {msg && <Alert tone="info">{msg}</Alert>}
    </div>
  );
}
