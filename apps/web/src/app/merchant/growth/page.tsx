'use client';
import { useState } from 'react';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Tabs, Textarea } from '@/components/ui';
import { CampaignResults, Challenges, campaignRow, OfferEditor, OffersTable, PromotionReport, type Challenge, type Offer } from '@/components/growth';
import { useMerchant } from '../context';

interface Camp { id: string; name: string; kind: string; status: string; budgetCents: number; spentCents: number; sentCount: number; conversions: number; attributedRevenueCents: number; funder: string; holdoutPct: number; endsAt: string | null }

export default function GrowthPage() {
  const { org } = useMerchant();
  const [tab, setTab] = useState('offers');
  if (!org) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Growth</h1>
      <Tabs tabs={[{ id: 'offers', label: 'Offers & codes' }, { id: 'cost', label: 'Promotion cost' }, { id: 'campaigns', label: 'Campaigns' }, { id: 'challenges', label: 'Challenges' }]} active={tab} onChange={setTab} />
      {tab === 'offers' && <Offers orgId={org.id} />}
      {tab === 'cost' && <PromotionReport path={`/organizations/${org.id}/promotions/report`} />}
      {tab === 'campaigns' && <Campaigns orgId={org.id} />}
      {tab === 'challenges' && <OrgChallenges orgId={org.id} />}
    </div>
  );
}

function Offers({ orgId }: { orgId: string }) {
  const { loc } = useMerchant();
  const { data, reload } = useApi<Offer[]>(`/organizations/${orgId}/offers`);
  const { data: camps } = useApi<Camp[]>(`/organizations/${orgId}/campaigns`);
  const { data: menus } = useApi<{ categories: { id: string; name: string; items: { id: string; name: string }[] }[] }[]>(loc ? `/public/locations/${loc.id}/menus` : null, { deps: [loc?.id] });
  const [edit, setEdit] = useState<Offer | null | undefined>(undefined);
  const menu = menus ? { categories: menus.flatMap((m) => m.categories.map((c) => ({ id: c.id, name: c.name }))), items: menus.flatMap((m) => m.categories.flatMap((c) => c.items.map((i) => ({ id: i.id, name: i.name })))) } : undefined;
  return (
    <Card title="Offers & codes" action={<Button onClick={() => setEdit(null)}>New offer</Button>}>
      <OffersTable rows={data || []} onEdit={(o) => setEdit(o)} />
      <p className="mt-2 text-xs text-ink-500">Automatic offers apply at checkout without a code. Your offers are funded by you; Gutad-funded offers are set up by Gutad. The cost shows on your statement under Promotions.</p>
      {edit !== undefined && <OfferEditor base={`/organizations/${orgId}/offers`} offer={edit} menu={menu} campaigns={(camps || []).filter((c) => c.kind === 'COUPON')} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); reload(); }} />}
    </Card>
  );
}

function Campaigns({ orgId }: { orgId: string }) {
  const { loc } = useMerchant();
  const { data: camps, reload } = useApi<Camp[]>(`/organizations/${orgId}/campaigns`);
  const { data: segs } = useApi<{ id: string; name: string }[]>(`/organizations/${orgId}/segments`);
  const { run, error } = useAction();
  const [c, setC] = useState({ name: '', kind: 'EMAIL', budget: '', segmentId: '', subject: '', body: '', bid: '', keyword: '', holdout: '0' });
  const [open, setOpen] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}{sent && <Alert tone="good">{sent}</Alert>}
      <Table rows={camps || []} cols={[{ key: 'n', label: 'Campaign', render: (r) => <span>{r.name} <span className="text-xs text-ink-500">{r.kind} · {r.funder}</span></span> }, { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> }, { key: 'b', label: 'Budget & holdout', render: (r) => <span className="text-xs">{campaignRow(r)}</span> }, { key: 'o', label: 'Sent / conversions', render: (r) => `${r.sentCount} / ${r.conversions}` }, { key: 'rev', label: 'Attributed revenue', render: (r) => money(r.attributedRevenueCents) }, { key: 'a', label: '', render: (r) => <span className="flex gap-1">{['EMAIL', 'SMS'].includes(r.kind) && r.status === 'ACTIVE' && <Button size="sm" variant="secondary" onClick={() => run(async () => { const res = await api.post<{ queued: number; heldOut: number }>(`/campaigns/${r.id}/send`, {}); setSent(`Queued ${res.queued} consented messages${res.heldOut ? `; ${res.heldOut} customers held out for measurement` : ''}.`); reload(); })}>Send</Button>}<Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>Results</Button></span> }]} />
      <Card title="New campaign">
        <div className="grid gap-2 md:grid-cols-2">
          <Input label="Name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          <Select label="Kind" value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="SPONSORED">Sponsored placement</option><option value="COUPON">Offer campaign (attach offers)</option></Select>
          {['EMAIL', 'SMS'].includes(c.kind) && (<><Select label="Segment" value={c.segmentId} onChange={(e) => setC({ ...c, segmentId: e.target.value })}><option value="">All consented guests</option>{segs?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Input label="Subject" value={c.subject} onChange={(e) => setC({ ...c, subject: e.target.value })} /><Textarea label="Message" value={c.body} onChange={(e) => setC({ ...c, body: e.target.value })} /></>)}
          {c.kind === 'SPONSORED' && (<><Input label="Bid per click (USD)" value={c.bid} onChange={(e) => setC({ ...c, bid: e.target.value })} /><Input label="Keyword (optional)" value={c.keyword} onChange={(e) => setC({ ...c, keyword: e.target.value })} /></>)}
          <Input label="Budget (USD, stops when exhausted)" value={c.budget} onChange={(e) => setC({ ...c, budget: e.target.value })} />
          {c.kind !== 'SPONSORED' && <Select label="Holdout group (measures incremental orders)" value={c.holdout} onChange={(e) => setC({ ...c, holdout: e.target.value })}><option value="0">None</option><option value="10">10%</option><option value="20">20%</option><option value="50">50%</option></Select>}
        </div>
        <Button className="mt-3" disabled={!c.name} onClick={() => run(async () => { await api.post(`/organizations/${orgId}/campaigns`, { name: c.name, kind: c.kind, budgetCents: Math.round(Number(c.budget || 0) * 100), segmentId: c.segmentId || undefined, content: { subject: c.subject, body: c.body }, holdoutPct: Number(c.holdout), endsAt: new Date(Date.now() + 30 * 86400000).toISOString(), sponsored: c.kind === 'SPONSORED' && loc ? { locationId: loc.id, bidCents: Math.round(Number(c.bid || 0.5) * 100), keyword: c.keyword || undefined } : undefined }); setC({ ...c, name: '' }); reload(); })}>Create</Button>
      </Card>
      {open && <CampaignResults id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function OrgChallenges({ orgId }: { orgId: string }) {
  const { data, reload } = useApi<Challenge[]>(`/organizations/${orgId}/challenges`);
  return <Challenges base={`/organizations/${orgId}/challenges`} list={data || []} onChange={reload} />;
}
