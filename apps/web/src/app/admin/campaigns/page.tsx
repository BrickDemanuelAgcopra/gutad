'use client';
import { useState } from 'react';
import { api, money } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { CampaignResults, campaignRow } from '@/components/growth';

interface Camp { id: string; organizationId: string | null; name: string; kind: string; status: string; funder: string; holdoutPct: number; budgetCents: number; spentCents: number; conversions: number; attributedRevenueCents: number; sentCount: number; endsAt: string | null }

/** 25.10 every campaign (Gutad-wide and merchants') with profitability against a holdout group. */
export default function AdminCampaigns() {
  const { can } = useSession();
  const { data, reload } = useApi<Camp[]>('/admin/campaigns');
  const { data: orgs } = useApi<{ org: { id: string; name: string } }[]>('/admin/tenants');
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', budget: '', holdout: '10', days: '30' });
  const [owner, setOwner] = useState('all');
  const rows = (data || []).filter((c) => owner === 'all' || (owner === 'gutad' ? !c.organizationId : c.organizationId === owner));
  return (
    <div className="space-y-4">
      <SectionTitle title="Campaigns & holdouts" hint="A holdout group never sees the campaign, so its order rate shows what would have happened anyway. The difference is the campaign’s incremental orders." />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card title="Campaigns" action={<Select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="all">Everyone</option><option value="gutad">Gutad-wide</option>{orgs?.map((o) => <option key={o.org.id} value={o.org.id}>{o.org.name}</option>)}</Select>}>
          <Table rows={rows} empty="No campaigns." cols={[
            { key: 'n', label: 'Campaign', render: (c) => <div>{c.name}<div className="text-xs text-ink-500">{c.kind} · {c.organizationId ? orgs?.find((o) => o.org.id === c.organizationId)?.org.name || 'merchant' : 'Gutad-wide'}</div></div> },
            { key: 's', label: 'Status', render: (c) => <Badge tone={statusTone(c.status)}>{c.status}</Badge> },
            { key: 'b', label: 'Budget & holdout', render: (c) => <span className="text-xs">{campaignRow(c)}</span> },
            { key: 'a', label: 'Attributed', render: (c) => `${c.conversions} orders · ${money(c.attributedRevenueCents)}` },
            { key: 'r', label: '', render: (c) => <Button size="sm" variant="secondary" onClick={() => setOpen(c.id)}>Results</Button> },
          ]} />
        </Card>
        {can('growth.manage') && (
          <Card title="New Gutad-wide campaign">
            <div className="space-y-2 text-sm">
              <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <Input label="Budget (USD, stops when spent; blank = none)" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
              <Select label="Holdout group" value={f.holdout} onChange={(e) => setF({ ...f, holdout: e.target.value })}><option value="0">None</option><option value="5">5%</option><option value="10">10%</option><option value="20">20%</option><option value="50">50%</option></Select>
              <Input label="Runs for days" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
              <Button disabled={f.name.length < 2} onClick={() => run(async () => { await api.post('/admin/campaigns', { name: f.name, kind: 'COUPON', budgetCents: Math.round(Number(f.budget || 0) * 100), holdoutPct: Number(f.holdout), endsAt: new Date(Date.now() + Number(f.days || 30) * 86400_000).toISOString() }); setF({ ...f, name: '' }); await reload(); })}>Create</Button>
              <p className="text-xs text-ink-500">Then attach offers to it in Promotions &amp; offers. Customers are assigned to a group the first time they see the offer.</p>
            </div>
          </Card>
        )}
      </div>
      {open && <CampaignResults id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
