'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Row { id: string; name: string | null; email: string; phone: string | null; status: string; isGuest: boolean; orders: number; spendCents: number; lastOrderAt: string | null }
interface Seg { id: string; name: string; rules: Record<string, unknown>; size: number }

export default function Customers() {
  const [tab, setTab] = useState('directory');
  return (
    <div className="space-y-4">
      <SectionTitle title="Customers" hint="Find a customer, see everything about them in one place, and handle restrictions, appeals and privacy requests." />
      <Tabs tabs={[{ id: 'directory', label: 'Directory' }, { id: 'segments', label: 'Segments' }, { id: 'appeals', label: 'Appeals' }, { id: 'privacy', label: 'Privacy requests' }]} active={tab} onChange={setTab} />
      {tab === 'directory' && <Directory />}
      {tab === 'segments' && <Segments />}
      {tab === 'appeals' && <Appeals />}
      {tab === 'privacy' && <Privacy />}
    </div>
  );
}

function Directory() {
  const [f, setF] = useState({ q: '', status: '', minOrders: '', lastOrderBeforeDays: '' });
  const [qs, setQs] = useState('');
  const { data } = useApi<{ total: number; items: Row[] }>(`/admin/customers?${qs}`, { deps: [qs] });
  const { can } = useSession();
  const { run } = useAction();
  const build = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input label="Name, email, phone or id" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && setQs(build())} />
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option>{['ACTIVE', 'RESTRICTED', 'DISABLED'].map((s) => <option key={s}>{s}</option>)}</Select>
        <Input label="Min orders" value={f.minOrders} onChange={(e) => setF({ ...f, minOrders: e.target.value })} />
        <Input label="No order in (days)" value={f.lastOrderBeforeDays} onChange={(e) => setF({ ...f, lastOrderBeforeDays: e.target.value })} />
        <Button onClick={() => setQs(build())}>Search</Button>
        {can('customers.pii') && <Button variant="secondary" onClick={() => run(() => downloadFile(`/admin/customers/export.csv?${build()}`, 'customers.csv'))}>Export CSV</Button>}
        {data && <span className="text-xs text-ink-500">{data.total} customers</span>}
      </div>
      <Table rows={data?.items || []} empty="No customers match." cols={[
        { key: 'n', label: 'Customer', render: (r) => <Link className="underline" href={`/admin/customers/${r.id}`}>{r.name || '—'}<span className="block text-xs text-ink-500 no-underline">{r.email}{r.phone ? ` · ${r.phone}` : ''}</span></Link> },
        { key: 's', label: 'Status', render: (r) => <span><Badge tone={statusTone(r.status)}>{r.status}</Badge>{r.isGuest && <Badge>guest</Badge>}</span> },
        { key: 'o', label: 'Orders', render: (r) => r.orders },
        { key: 'm', label: 'Spend', render: (r) => money(r.spendCents) },
        { key: 'l', label: 'Last order', render: (r) => <span className="text-xs">{when(r.lastOrderAt)}</span> },
      ]} />
    </div>
  );
}

function Segments() {
  const { data, reload } = useApi<Seg[]>('/admin/segments');
  const { run, error } = useAction();
  const [f, setF] = useState({ name: '', minOrders: '', minSpend: '', lastOrderWithinDays: '', lastOrderBeforeDays: '', hasMembership: '', marketingConsent: '' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No segments yet." cols={[{ key: 'n', label: 'Segment', render: (s) => s.name }, { key: 'r', label: 'Rules', render: (s) => <span className="text-xs">{Object.entries(s.rules).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span> }, { key: 's', label: 'Customers', render: (s) => s.size }]} />
      <Card title="New segment">
        <div className="grid gap-2 sm:grid-cols-4">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Min orders" value={f.minOrders} onChange={(e) => setF({ ...f, minOrders: e.target.value })} />
          <Input label="Min spend $" value={f.minSpend} onChange={(e) => setF({ ...f, minSpend: e.target.value })} />
          <Input label="Ordered in last (days)" value={f.lastOrderWithinDays} onChange={(e) => setF({ ...f, lastOrderWithinDays: e.target.value })} />
          <Input label="No order in (days)" value={f.lastOrderBeforeDays} onChange={(e) => setF({ ...f, lastOrderBeforeDays: e.target.value })} />
          <Select label="Membership" value={f.hasMembership} onChange={(e) => setF({ ...f, hasMembership: e.target.value })}><option value="">Any</option><option value="true">Members</option><option value="false">Non-members</option></Select>
          <Select label="Marketing consent" value={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.value })}><option value="">Any</option><option value="true">Opted in</option><option value="false">Opted out</option></Select>
        </div>
        <Button className="mt-2" disabled={!f.name} onClick={() => run(async () => { const n = (v: string) => (v ? Number(v) : undefined); await api.post('/admin/segments', { name: f.name, rules: { minOrders: n(f.minOrders), minSpendCents: f.minSpend ? Math.round(Number(f.minSpend) * 100) : undefined, lastOrderWithinDays: n(f.lastOrderWithinDays), lastOrderBeforeDays: n(f.lastOrderBeforeDays), hasMembership: f.hasMembership ? f.hasMembership === 'true' : undefined, marketingConsent: f.marketingConsent ? f.marketingConsent === 'true' : undefined } }); reload(); })}>Save segment</Button>
      </Card>
    </div>
  );
}

function Appeals() {
  const { data, reload } = useApi<{ id: string; userId: string; kind: string; reason: string; appealNote: string; appealedAt: string; email: string; name: string | null }[]>('/admin/appeals');
  const { run, error } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      {data?.length === 0 && <p className="text-sm text-ink-500">No appeals waiting.</p>}
      {data?.map((a) => (
        <Card key={a.id} title={<span><Link className="underline" href={`/admin/customers/${a.userId}`}>{a.name || a.email}</Link> · {a.kind.toLowerCase().replace(/_/g, ' ')}</span>}>
          <p className="text-sm">Restricted because: {a.reason}</p>
          <p className="text-sm">Appeal ({when(a.appealedAt)}): “{a.appealNote}”</p>
          <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => { const note = window.prompt('Note to the customer'); if (note) run(async () => { await api.post(`/admin/restrictions/${a.id}/appeal-decision`, { lift: true, note }); reload(); }); }}>Lift restriction</Button><Button size="sm" variant="secondary" onClick={() => { const note = window.prompt('Why does it stay?'); if (note) run(async () => { await api.post(`/admin/restrictions/${a.id}/appeal-decision`, { lift: false, note }); reload(); }); }}>Uphold</Button></div>
        </Card>
      ))}
    </div>
  );
}

function Privacy() {
  const [status, setStatus] = useState('PENDING');
  const { data, reload } = useApi<{ id: string; userId: string; email: string; kind: string; status: string; scheduledFor: string | null; createdAt: string; note: string | null }[]>(`/admin/privacy-requests?status=${status}`, { deps: [status] });
  const { can } = useSession();
  const { run, error } = useAction();
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Select value={status} onChange={(e) => setStatus(e.target.value)}>{['PENDING', 'FULFILLED', 'BLOCKED', 'CANCELED'].map((s) => <option key={s}>{s}</option>)}</Select>
      <p className="text-xs text-ink-500">Deletions run automatically after the grace period unless blocked, and never while orders or chargebacks are open. Orders and ledger records are kept anonymized for financial retention; old guest accounts are anonymized by the retention rule.</p>
      <Table rows={data || []} empty="Nothing here." cols={[{ key: 'u', label: 'Customer', render: (r) => <Link className="underline" href={`/admin/customers/${r.userId}`}>{r.email}</Link> }, { key: 'k', label: 'Request', render: (r) => r.kind }, { key: 's', label: 'Status', render: (r) => <Badge>{r.status}</Badge> }, { key: 'd', label: 'Runs on', render: (r) => when(r.scheduledFor) }, { key: 'n', label: 'Note', render: (r) => <span className="text-xs">{r.note}</span> }, { key: 'x', label: '', render: (r) => r.status === 'PENDING' && can('customers.pii') ? <div className="flex gap-1"><Button size="sm" variant="danger" onClick={() => { const note = window.prompt('Checks done (open orders, disputes, balances)?'); if (note) run(async () => { await api.post(`/admin/privacy-requests/${r.id}/decision`, { action: 'EXECUTE', note }); reload(); }); }}>Delete now</Button><Button size="sm" variant="ghost" onClick={() => { const note = window.prompt('Why block it?'); if (note) run(async () => { await api.post(`/admin/privacy-requests/${r.id}/decision`, { action: 'BLOCK', note }); reload(); }); }}>Block</Button></div> : null }]} />
    </div>
  );
}
