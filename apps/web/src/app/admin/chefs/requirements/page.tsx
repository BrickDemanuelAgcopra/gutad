'use client';
import { useState } from 'react';
import { CHEF_KITCHEN_TYPES } from '@gutad/shared';
import { api } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { ChipGroup } from '@/components/form-kit';

interface Req { id: string; key: string; label: string; description: string | null; regions: string[]; kitchenTypes: string[]; required: boolean; needsExpiry: boolean; active: boolean; sortOrder: number }
const blank = { key: '', label: '', description: '', regions: '', kitchenTypes: [] as string[], required: true, needsExpiry: true, active: true, sortOrder: 50 };

export default function ChefRequirements() {
  const { can } = useSession();
  const { data, reload } = useApi<Req[]>('/admin/chef-requirements');
  const { run, error, busy } = useAction();
  const [f, setF] = useState(blank);
  const edit = (r: Req) => setF({ key: r.key, label: r.label, description: r.description || '', regions: r.regions.join(', '), kitchenTypes: r.kitchenTypes, required: r.required, needsExpiry: r.needsExpiry, active: r.active, sortOrder: r.sortOrder });
  const save = () => run(async () => {
    await api.post('/admin/chef-requirements', { ...f, regions: f.regions.split(',').map((x) => x.trim()).filter(Boolean) });
    setF(blank);
    await reload();
  });
  return (
    <div className="space-y-4">
      <SectionTitle title="Chef document rules" hint="Which permits, certificates and insurance a chef must upload, by state and kitchen type. Food-business rules vary by product, facility and jurisdiction; set them per state as you launch." />
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} cols={[
        { key: 'l', label: 'Document', render: (r) => <div><div className="font-medium">{r.label}</div><div className="text-xs text-ink-500">{r.key}{r.description ? ` · ${r.description}` : ''}</div></div> },
        { key: 'r', label: 'States', render: (r) => <span className="text-xs">{r.regions.length ? r.regions.join(', ') : 'All'}</span> },
        { key: 'k', label: 'Kitchen types', render: (r) => <span className="text-xs">{r.kitchenTypes.length ? r.kitchenTypes.map((k) => k.toLowerCase().replace('_', ' ')).join(', ') : 'All'}</span> },
        { key: 'f', label: 'Rules', render: (r) => <div className="flex flex-wrap gap-1">{r.required ? <Badge tone="warn">required</Badge> : <Badge>optional</Badge>}{r.needsExpiry && <Badge tone="info">expiry</Badge>}{!r.active && <Badge tone="bad">inactive</Badge>}</div> },
        { key: 'e', label: '', render: (r) => (can('chefs.manage') ? <Button size="sm" variant="secondary" onClick={() => edit(r)}>Edit</Button> : null) },
      ]} />
      {can('chefs.manage') && (
        <Card title={f.key && data?.some((r) => r.key === f.key) ? `Edit ${f.key}` : 'Add a document rule'}>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Key" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="NYC_DOHMH_PERMIT" />
              <Input label="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
            </div>
            <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <Input label="States (comma separated, empty = all)" value={f.regions} onChange={(e) => setF({ ...f, regions: e.target.value })} placeholder="NY, NJ" />
            <div><span className="mb-1 block text-xs font-medium text-ink-500">Kitchen types (none selected = all)</span><ChipGroup name="Kitchen types" values={f.kitchenTypes} onChange={(k) => setF({ ...f, kitchenTypes: k })} options={Object.keys(CHEF_KITCHEN_TYPES).map((k) => ({ value: k, label: k.toLowerCase().replace('_', ' ') }))} /></div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Required</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={f.needsExpiry} onChange={(e) => setF({ ...f, needsExpiry: e.target.checked })} /> Has an expiry date</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
            </div>
            <div className="flex gap-2"><Button disabled={busy || f.key.length < 2 || f.label.length < 2} onClick={save}>Save rule</Button>{f.key && <Button variant="ghost" onClick={() => setF(blank)}>Clear</Button>}</div>
          </div>
        </Card>
      )}
    </div>
  );
}
