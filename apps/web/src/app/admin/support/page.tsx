'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Textarea } from '@/components/ui';

interface Incident { id: string; category: string; description: string; status: string; owner: string | null; remedy: string | null; remedyCents: number; orderId: string | null; createdAt: string }

export default function AdminSupport() {
  const [status, setStatus] = useState('OPEN');
  const { data, reload } = useApi<Incident[]>(`/incidents?status=${status}`, { poll: 10000, deps: [status] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<{ incident: Incident; order: { order: { number: string; status: string; totalCents: number; guestEmail: string | null }; events: { type: string; createdAt: string; actorRole: string | null }[]; payment: { status: string; capturedCents: number; refundedCents: number } | null; delivery: { status: string; proofPhotoUrl: string | null } | null } | null } | null>(null);
  const [res, setRes] = useState({ owner: 'MERCHANT', remedy: 'REFUND', cents: '', note: '' });
  const [strike, setStrike] = useState({ subjectType: 'MERCHANT', subjectId: '', reason: '' });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Support queue</h1><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['OPEN', 'INVESTIGATING', 'APPEALED', 'RESOLVED', 'CLOSED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="Queue is empty." cols={[{ key: 'c', label: 'Category', render: (r) => <Badge>{r.category}</Badge> }, { key: 'd', label: 'Description', render: (r) => <button className="text-left underline" onClick={() => api.get<typeof sel>(`/incidents/${r.id}`).then(setSel)}>{r.description}</button> }, { key: 'o', label: 'Owner', render: (r) => r.owner }, { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> }, { key: 'r', label: 'Remedy', render: (r) => r.remedy ? `${r.remedy} ${r.remedyCents ? money(r.remedyCents) : ''}` : '—' }, { key: 't', label: 'Opened', render: (r) => when(r.createdAt) }]} />
      {sel && (
        <Card title={`Case ${sel.incident.id.slice(0, 8)} — ${sel.incident.category}`} action={<Button size="sm" variant="ghost" onClick={() => setSel(null)}>Close</Button>}>
          <p className="text-sm">{sel.incident.description}</p>
          {sel.order && (
            <div className="mt-2 rounded-lg bg-ink-50 p-3 text-xs">
              <div>Order {sel.order.order.number} · {sel.order.order.status} · {money(sel.order.order.totalCents)} · {sel.order.order.guestEmail}</div>
              <div>Payment {sel.order.payment?.status} captured {money(sel.order.payment?.capturedCents || 0)} refunded {money(sel.order.payment?.refundedCents || 0)}</div>
              {sel.order.delivery && <div>Delivery {sel.order.delivery.status} {sel.order.delivery.proofPhotoUrl && <a className="underline" href={sel.order.delivery.proofPhotoUrl} target="_blank" rel="noreferrer">proof</a>}</div>}
              <div className="mt-1">Timeline: {sel.order.events.map((e) => `${e.type}(${e.actorRole || 'sys'}) ${new Date(e.createdAt).toLocaleTimeString()}`).join(' → ')}</div>
            </div>
          )}
          {['OPEN', 'INVESTIGATING', 'APPEALED'].includes(sel.incident.status) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <Select label="Cost owner" value={res.owner} onChange={(e) => setRes({ ...res, owner: e.target.value })}>{['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER'].map((o) => <option key={o}>{o}</option>)}</Select>
              <Select label="Remedy" value={res.remedy} onChange={(e) => setRes({ ...res, remedy: e.target.value })}>{['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY', 'REASSIGN', 'NONE'].map((o) => <option key={o}>{o}</option>)}</Select>
              <Input label="Amount (USD)" value={res.cents} onChange={(e) => setRes({ ...res, cents: e.target.value })} />
              <Button className="self-end" onClick={() => run(async () => { await api.post(`/incidents/${sel.incident.id}/resolve`, { owner: res.owner, remedy: res.remedy, remedyCents: Math.round(Number(res.cents || 0) * 100), note: res.note }); setSel(null); reload(); })}>Resolve</Button>
              <Textarea className="sm:col-span-4" label="Evidence / note" value={res.note} onChange={(e) => setRes({ ...res, note: e.target.value })} rows={2} />
            </div>
          )}
        </Card>
      )}
      <Card title="Policy enforcement">
        <div className="grid gap-2 sm:grid-cols-4"><Select label="Subject" value={strike.subjectType} onChange={(e) => setStrike({ ...strike, subjectType: e.target.value })}>{['MERCHANT', 'DRIVER', 'CUSTOMER'].map((s) => <option key={s}>{s}</option>)}</Select><Input label="Subject id (org / driver / user)" value={strike.subjectId} onChange={(e) => setStrike({ ...strike, subjectId: e.target.value })} /><Input label="Reason" value={strike.reason} onChange={(e) => setStrike({ ...strike, reason: e.target.value })} /><Button className="self-end" variant="danger" onClick={() => run(async () => { const r = await api.post('/policy/strikes', strike); alert(JSON.stringify(r)); })}>Issue strike</Button></div>
        <p className="mt-1 text-xs text-ink-500">Three severity points auto-suspend the subject; appeals re-open the case.</p>
      </Card>
    </div>
  );
}
