'use client';
import { useState } from 'react';
import { downloadFile, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Row { id: string; createdAt: string; actorEmail: string | null; actorId: string | null; action: string; entityType: string; entityId: string; organizationId: string | null; reason: string | null; ip: string | null; grantId: string | null; requestId: string | null; before: unknown; after: unknown }
interface Change { id: string; key: string; before: unknown; after: unknown; actorId: string | null; approvedById: string | null; createdAt: string }

export default function AdminAudit() {
  const [f, setF] = useState({ actor: '', action: '', entityType: '', entityId: '', from: '', to: '', withReason: false });
  const [q, setQ] = useState('');
  const { data, loading } = useApi<Row[]>(`/admin/audit/search${q}`, { deps: [q] });
  const { data: hist } = useApi<Change[]>('/admin/config-history');
  const { run, error } = useAction();
  const [sel, setSel] = useState<Row | null>(null);
  const build = () => {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, String(v)); });
    return p.toString() ? `?${p}` : '';
  };
  return (
    <div className="space-y-4">
      <SectionTitle title="Audit history" hint="Who changed what, when and why. Actions taken under emergency or support access are tagged." action={<Button variant="secondary" onClick={() => run(() => downloadFile(`/admin/audit/export.csv${build()}`, `gutad-audit-${new Date().toISOString().slice(0, 10)}.csv`))}>Export CSV</Button>} />
      {error && <Alert>{error}</Alert>}
      <Card>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Input label="Actor email" value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} />
          <Input label="Action starts with" placeholder="staff., approval., location." value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
          <Input label="Entity type" placeholder="user, location…" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })} />
          <Input label="Entity id" value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })} />
          <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <div className="mt-2 flex items-center gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.withReason} onChange={(e) => setF({ ...f, withReason: e.target.checked })} /> Only entries with a reason</label><Button size="sm" onClick={() => setQ(build())}>Search</Button></div>
      </Card>
      <Table rows={data || []} empty={loading ? 'Loading…' : 'No matching entries.'} cols={[
        { key: 't', label: 'When', render: (r) => <span className="text-xs">{when(r.createdAt)}</span> },
        { key: 'a', label: 'Who', render: (r) => <span className="text-xs">{r.actorEmail || 'system'}{r.grantId && <Badge tone="bad">grant</Badge>}</span> },
        { key: 'x', label: 'What', render: (r) => <button className="text-left text-xs underline" onClick={() => setSel(r)}>{r.action} · {r.entityType} {r.entityId.slice(0, 8)}</button> },
        { key: 'w', label: 'Why', render: (r) => <span className="text-xs">{r.reason || <span className="text-ink-300">—</span>}</span> },
        { key: 'i', label: 'From', render: (r) => <span className="text-xs text-ink-500">{r.ip || ''}</span> },
      ]} />
      <Card title="Configuration history"><Table rows={hist || []} cols={[{ key: 'k', label: 'Key', render: (r) => r.key }, { key: 'b', label: 'Before → after', render: (r) => <span className="text-xs">{JSON.stringify(r.before)} → {JSON.stringify(r.after)}</span> }, { key: 'a', label: 'Changed / approved by', render: (r) => <span className="text-xs">{r.actorId?.slice(0, 8)} / {r.approvedById?.slice(0, 8) || '—'}</span> }, { key: 't', label: 'At', render: (r) => when(r.createdAt) }]} /></Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.action} · ${sel.entityType}` : ''}>
        {sel && <div className="space-y-2 text-xs"><div>{when(sel.createdAt)} by {sel.actorEmail || 'system'} {sel.ip && `from ${sel.ip}`}</div>{sel.reason && <div className="rounded bg-ink-50 p-2">Reason: {sel.reason}</div>}{sel.grantId && <div>Under access grant {sel.grantId}</div>}<div className="grid gap-2 sm:grid-cols-2"><div><div className="font-semibold">Before</div><pre className="max-h-64 overflow-auto rounded bg-ink-50 p-2">{JSON.stringify(sel.before, null, 2)}</pre></div><div><div className="font-semibold">After</div><pre className="max-h-64 overflow-auto rounded bg-ink-50 p-2">{JSON.stringify(sel.after, null, 2)}</pre></div></div></div>}
      </Modal>
    </div>
  );
}
