'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Card, Spinner, statusTone } from '@/components/ui';

interface Group { id: string; totalCents: number; deliveries: number; createdAt: string; orders: { id: string; number: string; status: string; totalCents: number; scheduledFor: string | null; fulfillmentType: string; locationName: string; payment: { refundedCents: number } | null; chefNetwork: { chefName: string | null; acceptBy: string | null } | null }[] }

const LABEL: Record<string, string> = { SUBMITTED: 'Waiting for the chef', ACCEPTED: 'Confirmed', PREPARING: 'Cooking', READY: 'Ready', COLLECTED: 'On the way', COMPLETED: 'Done', REJECTED: 'Declined — refunded', CANCELED: 'Canceled' };

/** Confirmation for a multi-chef checkout: one payment, one delivery per chef. */
export default function CheckoutGroupPage() {
  const { id } = useParams<{ id: string }>();
  const email = useSearchParams().get('email');
  const q = email ? `?email=${encodeURIComponent(email)}` : '';
  const { data: g, error } = useApi<Group>(`/checkout-groups/${id}${q}`, { poll: 15000 });
  if (error) return <Alert tone="info">We couldn’t open this checkout. Sign in with the account you ordered from.</Alert>;
  if (!g) return <Spinner />;
  const refunded = g.orders.reduce((a, o) => a + (o.payment?.refundedCents || 0), 0);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">You’re all set</h1>
        <p className="text-sm text-ink-500">{g.deliveries} chef orders · paid {money(g.totalCents)} in one payment · {when(g.createdAt)}{refunded ? ` · ${money(refunded)} refunded` : ''}</p>
      </div>
      <Alert tone="info">Each chef confirms their own order. If a chef can’t take it, that order is refunded in full automatically; the others go ahead.</Alert>
      {g.orders.map((o) => (
        <Card key={o.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">{o.chefNetwork?.chefName || o.locationName}</div>
              <div className="text-sm text-ink-700">{o.fulfillmentType === 'DELIVERY' ? 'Delivery' : 'Pickup'}{o.scheduledFor ? ` · ${when(o.scheduledFor)}` : ''}</div>
              {o.status === 'SUBMITTED' && o.chefNetwork?.acceptBy && <div className="text-xs text-ink-500">Confirms by {when(o.chefNetwork.acceptBy)}</div>}
              <Link className="mt-1 inline-block text-sm text-brand-700 underline" href={`/orders/${o.id}${q}`}>Order {o.number}</Link>
            </div>
            <div className="text-right"><Badge tone={statusTone(o.status)}>{LABEL[o.status] || o.status}</Badge><div className="mt-1 text-sm font-medium">{money(o.totalCents)}</div></div>
          </div>
        </Card>
      ))}
    </div>
  );
}
