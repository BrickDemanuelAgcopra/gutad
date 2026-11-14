'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Select, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { InventoryWorkspace } from '@/components/inventory';

/** Supply & inventory across kitchens: pick a kitchen to work in; Gutad-wide suppliers are approved by food safety. */
export default function AdminSupply() {
  const { data: ks } = useApi<{ id: string; name: string; organization: string; city: string; loadLevel: string }[]>('/admin/kitchens');
  const { data: orgs } = useApi<{ org: { id: string; name: string } }[]>('/admin/tenants');
  const { data: sups, reload } = useApi<{ id: string; organizationId: string | null; name: string; approved: boolean; leadTimeDays: number }[]>('/suppliers');
  const { run, error } = useAction();
  const [k, setK] = useState('');
  const orgOf = () => orgs?.find((o) => o.org.name === ks?.find((x) => x.id === k)?.organization)?.org.id;
  return (
    <div className="space-y-4">
      <SectionTitle title="Supply & inventory" hint="Stock, lots and expiry, purchase orders and three-way matching, transfers, forecasts and supplier approvals." />
      {error && <Alert>{error}</Alert>}
      <Card title="All suppliers">
        <Table rows={sups || []} empty="No suppliers." cols={[{ key: 'n', label: 'Supplier', render: (s) => <span>{s.name}{!s.organizationId && <Badge tone="info">Gutad-wide</Badge>}</span> }, { key: 'o', label: 'Merchant', render: (s) => orgs?.find((o) => o.org.id === s.organizationId)?.org.name || '—' }, { key: 'l', label: 'Lead time', render: (s) => `${s.leadTimeDays} d` }, { key: 'a', label: 'Approved', render: (s) => <Badge tone={s.approved ? 'good' : 'warn'}>{s.approved ? 'yes' : 'no'}</Badge> }, { key: 'x', label: '', render: (s) => !s.organizationId ? <Button size="sm" variant="secondary" onClick={() => { const note = window.prompt(s.approved ? 'Why revoke?' : 'Approval note'); if (note) run(async () => { await api.post(`/suppliers/${s.id}/approval`, { approved: !s.approved, note }); await reload(); }); }}>{s.approved ? 'Revoke' : 'Approve'}</Button> : null }]} />
      </Card>
      <Select label="Kitchen" value={k} onChange={(e) => setK(e.target.value)}><option value="">Choose a kitchen…</option>{ks?.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.organization}</option>)}</Select>
      {k && orgOf() && <InventoryWorkspace kitchenId={k} organizationId={orgOf()!} />}
      {!k && <p className="text-sm text-ink-500">Choose a kitchen to see its stock, lots, purchase orders and reports.</p>}
    </div>
  );
}
