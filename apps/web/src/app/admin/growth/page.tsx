'use client';
import { useState } from 'react';
import { Button, Card, Select, Tabs } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';
import { OfferEditor, OffersTable, PromotionReport, type Offer } from '@/components/growth';
import { useApi, useSession } from '@/lib/hooks';

/** 25.1–25.4 offers across Gutad and every merchant: automatic offers and codes, eligibility, stacking, funding and cost. */
export default function AdminGrowth() {
  const { can } = useSession();
  const [tab, setTab] = useState('offers');
  const [owner, setOwner] = useState('all');
  const [edit, setEdit] = useState<Offer | null | undefined>(undefined);
  const { data: offers, reload } = useApi<Offer[]>('/admin/offers');
  const { data: orgs } = useApi<{ org: { id: string; name: string } }[]>('/admin/tenants');
  const { data: segs } = useApi<{ id: string; name: string }[]>('/admin/segments');
  const { data: camps } = useApi<{ id: string; name: string; organizationId: string | null }[]>('/admin/campaigns');
  const name = (o: Offer) => (o.organizationId ? orgs?.find((x) => x.org.id === o.organizationId)?.org.name || 'Merchant' : 'Gutad-wide');
  const rows = (offers || []).filter((o) => owner === 'all' || (owner === 'gutad' ? !o.organizationId : o.organizationId === owner));
  return (
    <div className="space-y-4">
      <SectionTitle title="Promotions & offers" hint="Automatic offers and promo codes, who can use them, how they combine, who pays and what they cost." action={can('growth.manage') && tab === 'offers' ? <Button onClick={() => setEdit(null)}>New Gutad offer</Button> : undefined} />
      <Tabs tabs={[{ id: 'offers', label: 'Offers' }, { id: 'cost', label: 'Promotion cost' }]} active={tab} onChange={setTab} />
      {tab === 'offers' && (
        <Card title="All offers" action={<Select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="all">Everyone</option><option value="gutad">Gutad-wide</option>{orgs?.map((o) => <option key={o.org.id} value={o.org.id}>{o.org.name}</option>)}</Select>}>
          <OffersTable rows={rows} showOwner={name} onEdit={can('growth.manage') ? (o) => setEdit(o) : undefined} />
          <p className="mt-2 text-xs text-ink-500">Merchants manage their own offers in their workspace. Editing a merchant’s offer here keeps it merchant-owned.</p>
        </Card>
      )}
      {tab === 'cost' && <PromotionReport path="/admin/promotions/report" />}
      {edit !== undefined && <OfferEditor base="/admin/offers" offer={edit} staff segments={segs || []} campaigns={(camps || []).filter((c) => !c.organizationId)} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); reload(); }} />}
    </div>
  );
}
