'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { MenuDto } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Spinner, statusTone } from '@/components/ui';

/** Invitees pick dishes before the cutoff; the organizer submits one consolidated, labeled order. */
export default function GroupOrderPage() {
  const { code } = useParams<{ code: string }>();
  const { user } = useSession();
  const { data: g, reload } = useApi<{ id: string; name: string; status: string; mode: string; locationId: string; cutoffAt: string; deliverAt: string; isOpen: boolean; allowanceCents: number | null; organizerUserId: string; participants: { id: string; name: string; lines: { name: string; quantity: number; cents: number }[]; overageCents: number }[] }>(`/public/group-orders/${code}`, { poll: 10000 });
  const { data: menus } = useApi<MenuDto[]>(g ? `/public/locations/${g.locationId}/menus?channel=CORPORATE` : null, { deps: [g?.locationId] });
  const [name, setName] = useState(user?.name || '');
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);
  if (!g) return <Spinner />;
  const items = menus?.flatMap((m) => m.categories.flatMap((c) => c.items)) || [];
  const chosen = Object.entries(picks).filter(([, q]) => q > 0);
  const total = chosen.reduce((a, [id, q]) => a + (items.find((i) => i.id === id)?.priceCents || 0) * q, 0);
  const submit = async () => {
    try {
      await api.post(`/public/group-orders/${code}/choices`, { name, lines: chosen.map(([menuItemId, quantity]) => ({ menuItemId, quantity })) });
      setMsg('Your picks are in!');
      setPicks({});
      reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const isOrganizer = user?.id === g.organizerUserId;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card title={g.name} action={<Badge tone={statusTone(g.status)}>{g.status}</Badge>}>
        <p className="text-sm text-ink-500">Order by <b>{when(g.cutoffAt)}</b> · arrives {when(g.deliverAt)} {g.allowanceCents !== null && `· allowance ${money(g.allowanceCents)} per person`}</p>
        <ul className="mt-2 text-sm">{g.participants.map((p) => <li key={p.id}>{p.name}: {p.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}{p.overageCents ? <span className="text-amber-700"> (+{money(p.overageCents)} over allowance)</span> : null}</li>)}</ul>
        {isOrganizer && g.status === 'OPEN' && <Button className="mt-3" onClick={async () => { try { const r = await api.post<{ order: { id: string } }>(`/group-orders/${code}/submit`, {}); setMsg(`Submitted as order ${r.order.id.slice(0, 8)}`); reload(); } catch (e) { setMsg((e as Error).message); } }}>Lock & submit group order</Button>}
      </Card>
      {g.isOpen && (
        <Card title="Pick your dishes">
          <Input label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{items.map((i) => <div key={i.id} className="flex items-center justify-between rounded-lg border border-ink-100 px-3 py-2 text-sm"><span>{i.name} <span className="text-ink-500">{money(i.priceCents)}</span></span><div className="flex items-center gap-1"><Button size="sm" variant="secondary" onClick={() => setPicks({ ...picks, [i.id]: Math.max(0, (picks[i.id] || 0) - 1) })}>−</Button><span className="w-5 text-center">{picks[i.id] || 0}</span><Button size="sm" variant="secondary" onClick={() => setPicks({ ...picks, [i.id]: (picks[i.id] || 0) + 1 })}>+</Button></div></div>)}</div>
          <div className="mt-3 flex items-center justify-between"><span className="text-sm">Your total {money(total)}{g.allowanceCents !== null && total > g.allowanceCents && <span className="text-amber-700"> ({money(total - g.allowanceCents)} over allowance, charged to you)</span>}</span><Button disabled={!name || !chosen.length} onClick={submit}>Submit picks</Button></div>
        </Card>
      )}
      {msg && <Alert tone="info">{msg}</Alert>}
    </div>
  );
}
