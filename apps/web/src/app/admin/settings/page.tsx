'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Select, Table } from '@/components/ui';

export default function AdminSettings() {
  const { data: s, reload } = useApi<{ env: Record<string, string>; settings: Record<string, unknown> }>('/admin/settings');
  const { data: hist } = useApi<{ id: string; key: string; before: unknown; after: unknown; actorId: string | null; approvedById: string | null; createdAt: string }[]>('/admin/config-history');
  const { data: audit } = useApi<{ id: string; action: string; entityType: string; entityId: string; actorId: string | null; createdAt: string }[]>('/admin/audit');
  const { run, error } = useAction();
  const [kv, setKv] = useState({ key: '', value: '', approver: '' });
  const [role, setRole] = useState({ email: '', role: 'SUPPORT', grant: 'true' });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings, roles & audit</h1>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Runtime configuration">{s && <pre className="rounded bg-ink-50 p-2 text-xs">{JSON.stringify(s.env, null, 2)}</pre>}<pre className="mt-2 rounded bg-ink-50 p-2 text-xs">{JSON.stringify(s?.settings || {}, null, 2)}</pre>
          <div className="mt-2 grid grid-cols-3 gap-2"><Input placeholder="key (fees.* needs approver)" value={kv.key} onChange={(e) => setKv({ ...kv, key: e.target.value })} /><Input placeholder="JSON value" value={kv.value} onChange={(e) => setKv({ ...kv, value: e.target.value })} /><Input placeholder="approver email" value={kv.approver} onChange={(e) => setKv({ ...kv, approver: e.target.value })} /></div>
          <Button className="mt-2" variant="secondary" onClick={() => run(async () => { await api.post('/admin/settings', { key: kv.key, value: JSON.parse(kv.value), approvedByEmail: kv.approver || undefined }); reload(); })}>Save setting</Button></Card>
        <Card title="Platform roles"><div className="grid grid-cols-3 gap-2"><Input placeholder="email" value={role.email} onChange={(e) => setRole({ ...role, email: e.target.value })} /><Select value={role.role} onChange={(e) => setRole({ ...role, role: e.target.value })}>{['PLATFORM_ADMIN', 'SUPPORT', 'FINANCE', 'DISPATCHER'].map((r) => <option key={r}>{r}</option>)}</Select><Select value={role.grant} onChange={(e) => setRole({ ...role, grant: e.target.value })}><option value="true">Grant</option><option value="false">Revoke</option></Select></div><Button className="mt-2" variant="secondary" onClick={() => run(async () => { const r = await api.post('/admin/roles', { ...role, grant: role.grant === 'true' }); alert(JSON.stringify(r)); })}>Apply</Button><p className="mt-1 text-xs text-ink-500">Role changes revoke sessions so new claims take effect at next sign-in. Enable MFA at your identity provider for privileged users.</p></Card>
      </div>
      <Card title="Configuration history"><Table rows={hist || []} cols={[{ key: 'k', label: 'Key', render: (r) => r.key }, { key: 'b', label: 'Before → after', render: (r) => <span className="text-xs">{JSON.stringify(r.before)} → {JSON.stringify(r.after)}</span> }, { key: 'a', label: 'Actor / approver', render: (r) => <span className="text-xs">{r.actorId?.slice(0, 8)} / {r.approvedById?.slice(0, 8) || '—'}</span> }, { key: 't', label: 'At', render: (r) => when(r.createdAt) }]} /></Card>
      <Card title="Audit trail"><Table rows={audit || []} cols={[{ key: 'a', label: 'Action', render: (r) => r.action }, { key: 'e', label: 'Entity', render: (r) => <span className="text-xs">{r.entityType} {r.entityId.slice(0, 8)}</span> }, { key: 'u', label: 'Actor', render: (r) => <span className="text-xs">{r.actorId?.slice(0, 8) || 'system'}</span> }, { key: 't', label: 'At', render: (r) => when(r.createdAt) }]} /></Card>
    </div>
  );
}
