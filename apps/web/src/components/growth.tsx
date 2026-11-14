'use client';
import { useState } from 'react';
import { WEEKDAYS } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, Table } from '@/components/ui';

/** Phase J growth building blocks shared by the admin console and the merchant workspace. */

export interface Offer {
  id: string; code: string; name: string | null; automatic: boolean; kind: string; value: number; funder: string; platformSharePct: number | null;
  minSubtotalCents: number; maxDiscountCents: number | null; maxUses: number | null; uses: number; perUserLimit: number; locationIds: string[];
  segmentId: string | null; firstOrderOnly: boolean; itemIds: string[]; categoryIds: string[]; daysOfWeek: number[]; startTime: string | null; endTime: string | null;
  stacking: string; priority: number; buyQty?: number | null; getQty?: number | null; startsAt: string | null; expiresAt: string | null; isActive: boolean; campaignId: string | null; organizationId: string | null;
  redemptions?: number; discountCents?: number;
}

export const offerValue = (o: Pick<Offer, 'kind' | 'value' | 'maxDiscountCents'> & { buyQty?: number | null; getQty?: number | null }) => (o.kind === 'BOGO' ? `Buy ${o.buyQty || 1}, get ${o.getQty || 1} free` : o.kind === 'FREE_ITEM' ? 'Free item' : o.kind === 'PERCENT' ? `${o.value / 100}% off${o.maxDiscountCents ? ` (up to ${money(o.maxDiscountCents)})` : ''}` : o.kind === 'FIXED' ? `${money(o.value)} off` : 'Free delivery');

export function offerRules(o: Offer) {
  const r: string[] = [];
  if (o.minSubtotalCents) r.push(`min ${money(o.minSubtotalCents)}`);
  if (o.firstOrderOnly) r.push('first order');
  if (o.segmentId) r.push('segment');
  if (o.itemIds.length || o.categoryIds.length) r.push(`${o.itemIds.length + o.categoryIds.length} item/category`);
  if (o.daysOfWeek.length) r.push(o.daysOfWeek.map((d) => WEEKDAYS[d]).join(' '));
  if (o.startTime) r.push(`${o.startTime}–${o.endTime}`);
  if (o.perUserLimit) r.push(`${o.perUserLimit}× per customer`);
  if (o.maxUses) r.push(`${o.uses}/${o.maxUses} uses`);
  return r.join(' · ') || 'everyone';
}

interface MenuRef { items: { id: string; name: string }[]; categories: { id: string; name: string }[] }

/** Create or edit an offer. `base` is the API prefix: `/admin/offers` or `/organizations/:id/offers`. */
export function OfferEditor({ base, offer, staff, segments, menu, campaigns, onSaved, onClose }: { base: string; offer?: Offer | null; staff?: boolean; segments?: { id: string; name: string }[]; menu?: MenuRef; campaigns?: { id: string; name: string }[]; onSaved: () => void; onClose: () => void }) {
  const { run, error } = useAction();
  const o = offer;
  const [f, setF] = useState({
    name: o?.name || '', code: o && !o.automatic ? o.code : '', automatic: o ? o.automatic : true, kind: o?.kind || 'PERCENT',
    value: o ? (o.kind === 'PERCENT' ? String(o.value / 100) : String(o.value / 100)) : '10', funder: o?.funder || (staff ? 'PLATFORM' : 'MERCHANT'), share: o?.platformSharePct != null ? String(o.platformSharePct) : '',
    min: o?.minSubtotalCents ? String(o.minSubtotalCents / 100) : '', cap: o?.maxDiscountCents ? String(o.maxDiscountCents / 100) : '', maxUses: o?.maxUses ? String(o.maxUses) : '', perUser: o ? String(o.perUserLimit) : '0',
    segmentId: o?.segmentId || '', firstOrderOnly: !!o?.firstOrderOnly, itemIds: o?.itemIds || [], categoryIds: o?.categoryIds || [], days: o?.daysOfWeek || [], start: o?.startTime || '', end: o?.endTime || '',
    stacking: o?.stacking || 'EXCLUSIVE', priority: String(o?.priority ?? 0), buy: String(o?.buyQty ?? 1), get: String(o?.getQty ?? 1), expires: o?.expiresAt ? o.expiresAt.slice(0, 10) : '', campaignId: o?.campaignId || '', isActive: o ? o.isActive : true,
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const toggle = (k: 'itemIds' | 'categoryIds' | 'days', v: never) => set({ [k]: (f[k] as never[]).includes(v) ? (f[k] as never[]).filter((x) => x !== v) : [...(f[k] as never[]), v] } as Partial<typeof f>);
  const save = () => run(async () => {
    const cents = (s: string) => Math.round(Number(s || 0) * 100);
    const body = {
      name: f.name || undefined, code: !f.automatic && f.code ? f.code : undefined, automatic: f.automatic, kind: f.kind, value: f.kind === 'PERCENT' ? Math.round(Number(f.value) * 100) : f.kind === 'FIXED' ? cents(f.value) : 0, buyQty: f.kind === 'BOGO' ? Number(f.buy || 1) : null, getQty: f.kind === 'BOGO' ? Number(f.get || 1) : null,
      funder: f.funder, platformSharePct: staff && f.share ? Number(f.share) : null, minSubtotalCents: cents(f.min), maxDiscountCents: f.cap ? cents(f.cap) : null, maxUses: f.maxUses ? Number(f.maxUses) : null,
      perUserLimit: Number(f.perUser || 0), segmentId: f.segmentId || null, firstOrderOnly: f.firstOrderOnly, itemIds: f.itemIds, categoryIds: f.categoryIds, daysOfWeek: f.days,
      startTime: f.start || null, endTime: f.end || null, stacking: f.stacking, priority: Number(f.priority || 0), expiresAt: f.expires ? new Date(`${f.expires}T23:59:00`).toISOString() : null, campaignId: f.campaignId || null, isActive: f.isActive,
      ...(o ? { locationIds: o.locationIds } : {}),
      ...(staff && o ? { organizationId: o.organizationId } : {}),
    };
    if (o) await api.patch(`${base}/${o.id}`, body); else await api.post(base, body);
    onSaved();
  });
  return (
    <Modal open onClose={onClose} title={o ? 'Edit offer' : 'New offer'}>
      <div className="space-y-3 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-2"><Button size="sm" variant={f.automatic ? 'primary' : 'secondary'} onClick={() => set({ automatic: true })}>Automatic (no code)</Button><Button size="sm" variant={!f.automatic ? 'primary' : 'secondary'} onClick={() => set({ automatic: false })}>Promo code</Button></div>
        <Input label="Name customers see" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Weekday lunch: 10% off" />
        {!f.automatic && <Input label="Code (blank = random)" value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />}
        <div className="grid grid-cols-2 gap-2">
          <Select label="Discount" value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="PERCENT">Percent off</option><option value="FIXED">Amount off</option><option value="FREE_DELIVERY">Free delivery</option><option value="BOGO">Buy X, get Y free</option><option value="FREE_ITEM">Free item</option></Select>
          {f.kind === 'BOGO' && <><Input label="Buy" value={f.buy} onChange={(e) => set({ buy: e.target.value })} /><Input label="Get free (cheapest)" value={f.get} onChange={(e) => set({ get: e.target.value })} /></>}
          {f.kind === 'FREE_ITEM' && <p className="col-span-2 text-xs text-ink-500">Pick the free item under “Only on” below; one is free when it is in the cart and the order qualifies.</p>}
          {['PERCENT', 'FIXED'].includes(f.kind) && <Input label={f.kind === 'PERCENT' ? 'Percent' : 'Amount (USD)'} value={f.value} onChange={(e) => set({ value: e.target.value })} />}
          {f.kind === 'PERCENT' && <Input label="Cap (USD, optional)" value={f.cap} onChange={(e) => set({ cap: e.target.value })} />}
          <Input label="Minimum subtotal (USD)" value={f.min} onChange={(e) => set({ min: e.target.value })} />
        </div>
        <fieldset className="rounded-lg border border-ink-100 p-3">
          <legend className="px-1 text-xs font-semibold text-ink-500">Who can use it</legend>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.firstOrderOnly} onChange={(e) => set({ firstOrderOnly: e.target.checked })} /> First order only</label>
          {segments && <Select className="mt-2" label="Customer segment" value={f.segmentId} onChange={(e) => set({ segmentId: e.target.value })}><option value="">Everyone</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
          <div className="mt-2 grid grid-cols-2 gap-2"><Input label="Uses per customer (0 = unlimited)" value={f.perUser} onChange={(e) => set({ perUser: e.target.value })} /><Input label="Total uses (blank = unlimited)" value={f.maxUses} onChange={(e) => set({ maxUses: e.target.value })} /></div>
        </fieldset>
        <fieldset className="rounded-lg border border-ink-100 p-3">
          <legend className="px-1 text-xs font-semibold text-ink-500">When</legend>
          <div className="flex flex-wrap gap-1">{WEEKDAYS.map((d, i) => <button key={d} type="button" onClick={() => toggle('days', i as never)} className={`rounded-md px-2 py-1 text-xs ${f.days.includes(i) ? 'bg-brand-600 text-white' : 'bg-ink-100'}`}>{d}</button>)}</div>
          <p className="mt-1 text-xs text-ink-500">No days selected = every day. Times are the restaurant’s local time.</p>
          <div className="mt-2 grid grid-cols-3 gap-2"><Input label="From" type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} /><Input label="Until" type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} /><Input label="Ends on" type="date" value={f.expires} onChange={(e) => set({ expires: e.target.value })} /></div>
        </fieldset>
        {menu && (menu.items.length > 0) && (
          <fieldset className="rounded-lg border border-ink-100 p-3">
            <legend className="px-1 text-xs font-semibold text-ink-500">Only on (leave empty for the whole order)</legend>
            <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">{menu.categories.map((c) => <button key={c.id} type="button" onClick={() => toggle('categoryIds', c.id as never)} className={`rounded-md px-2 py-1 text-xs ${f.categoryIds.includes(c.id) ? 'bg-brand-600 text-white' : 'bg-ink-100'}`}>{c.name} (all)</button>)}{menu.items.map((it) => <button key={it.id} type="button" onClick={() => toggle('itemIds', it.id as never)} className={`rounded-md px-2 py-1 text-xs ${f.itemIds.includes(it.id) ? 'bg-brand-600 text-white' : 'bg-ink-50'}`}>{it.name}</button>)}</div>
          </fieldset>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Select label="Combining" value={f.stacking} onChange={(e) => set({ stacking: e.target.value })}><option value="EXCLUSIVE">Exclusive (on its own)</option><option value="STACKABLE">Stackable (with other stackable offers)</option></Select>
          <Input label="Priority (higher applies first)" value={f.priority} onChange={(e) => set({ priority: e.target.value })} />
        </div>
        {staff && <div className="grid grid-cols-2 gap-2"><Select label="Funded by" value={f.funder} onChange={(e) => set({ funder: e.target.value })}><option value="PLATFORM">Gutad</option><option value="MERCHANT">Merchant</option></Select><Input label="Gutad share % (split)" value={f.share} onChange={(e) => set({ share: e.target.value })} placeholder="e.g. 50" /></div>}
        {campaigns && campaigns.length > 0 && <Select label="Campaign (budget, holdout, results)" value={f.campaignId} onChange={(e) => set({ campaignId: e.target.value })}><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active</label>
        <p className="text-xs text-ink-500">Without a code, a customer gets the better of the best exclusive offer and all stackable offers combined. A typed code always applies; an exclusive code replaces automatic offers.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>{o ? 'Save' : 'Create offer'}</Button></div>
      </div>
    </Modal>
  );
}

export function OffersTable({ rows, onEdit, showOwner }: { rows: Offer[]; onEdit?: (o: Offer) => void; showOwner?: (o: Offer) => string }) {
  return (
    <Table rows={rows} empty="No offers yet." cols={[
      { key: 'n', label: 'Offer', render: (o) => <div><div className="font-medium">{o.name || o.code}</div><div className="text-xs text-ink-500">{o.automatic ? 'Automatic' : <>Code <b>{o.code}</b></>}{showOwner ? ` · ${showOwner(o)}` : ''}</div></div> },
      { key: 'v', label: 'Discount', render: (o) => offerValue(o) },
      { key: 'r', label: 'Rules', render: (o) => <span className="text-xs">{offerRules(o)}</span> },
      { key: 's', label: 'Combining', render: (o) => <span className="text-xs">{o.stacking === 'STACKABLE' ? 'stackable' : 'exclusive'} · p{o.priority}</span> },
      { key: 'f', label: 'Funded', render: (o) => <span className="text-xs">{o.platformSharePct ? `split ${o.platformSharePct}% Gutad` : o.funder === 'PLATFORM' ? 'Gutad' : 'merchant'}</span> },
      { key: 'u', label: 'Used / cost', render: (o) => `${o.redemptions ?? 0} · ${money(o.discountCents ?? 0)}` },
      { key: 'a', label: '', render: (o) => <span className="flex items-center gap-2"><Badge tone={o.isActive ? 'good' : 'neutral'}>{o.isActive ? 'active' : 'off'}</Badge>{onEdit && <Button size="sm" variant="ghost" onClick={() => onEdit(o)}>Edit</Button>}</span> },
    ]} />
  );
}

interface Report { days: number; items: { id: string; name: string; code: string | null; automatic: boolean; merchant: string; orders: number; customers: number; discountCents: number; platformFundedCents: number; merchantFundedCents: number; salesCents: number; costPctOfSales: number | null }[]; totals: { orders: number; discountCents: number; platformFundedCents: number; merchantFundedCents: number; salesCents: number }; ledgerPromotionExpenseCents: number | null }

/** 25.4 promotion cost with the funding split. */
export function PromotionReport({ path }: { path: string }) {
  const [days, setDays] = useState(30);
  const { data } = useApi<Report>(`${path}?days=${days}`, { deps: [days] });
  return (
    <Card title="Promotion cost" action={<Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select>}>
      {data && <>
        <div className="grid gap-3 sm:grid-cols-4"><Stat label="Discount given" value={money(data.totals.discountCents)} hint={`${data.totals.orders} orders`} /><Stat label="Funded by Gutad" value={money(data.totals.platformFundedCents)} /><Stat label="Funded by merchants" value={money(data.totals.merchantFundedCents)} /><Stat label="Sales with a promotion" value={money(data.totals.salesCents)} hint={data.totals.salesCents ? `cost ${Math.round((data.totals.discountCents / data.totals.salesCents) * 1000) / 10}% of sales` : undefined} /></div>
        {data.ledgerPromotionExpenseCents !== null && <p className="mt-2 text-xs text-ink-500">Ledger promotion expense in the period: {money(data.ledgerPromotionExpenseCents)} (Gutad-funded discounts and promotional gift cards).</p>}
        <div className="mt-3"><Table rows={data.items} empty="No promotions used in this period." cols={[{ key: 'n', label: 'Promotion', render: (r) => <div>{r.name}<div className="text-xs text-ink-500">{r.automatic ? 'automatic' : r.code} · {r.merchant}</div></div> }, { key: 'o', label: 'Orders', render: (r) => `${r.orders} (${r.customers} customers)` }, { key: 'd', label: 'Discount', render: (r) => money(r.discountCents) }, { key: 'p', label: 'Gutad / merchant', render: (r) => `${money(r.platformFundedCents)} / ${money(r.merchantFundedCents)}` }, { key: 's', label: 'Sales', render: (r) => money(r.salesCents) }, { key: 'c', label: 'Cost % of sales', render: (r) => (r.costPctOfSales === null ? '—' : `${r.costPctOfSales}%`) }]} /></div>
      </>}
    </Card>
  );
}

export interface Challenge { id: string; name: string; description: string | null; goalOrders: number; windowDays: number; minSubtotalCents: number; rewardCents: number; rewardExpiresDays: number; maxCompletions: number; isActive: boolean; endsAt: string | null; active?: number; completed?: number; rewardsIssuedCents?: number }

/** 25.6 challenges: list with progress counts and a simple editor. */
export function Challenges({ base, list, onChange }: { base: string; list: Challenge[]; onChange: () => void }) {
  const { run, error } = useAction();
  const [f, setF] = useState({ name: '', description: '', goal: '3', window: '14', reward: '5', expires: '30', min: '', ends: '' });
  const save = (c: Challenge, isActive: boolean) => run(async () => { await api.post(base, { id: c.id, name: c.name, description: c.description ?? undefined, goalOrders: c.goalOrders, windowDays: c.windowDays, minSubtotalCents: c.minSubtotalCents, rewardCents: c.rewardCents, rewardExpiresDays: c.rewardExpiresDays, maxCompletions: c.maxCompletions, isActive }); onChange(); });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card title="Reward challenges">
        {error && <Alert>{error}</Alert>}
        <Table rows={list} empty="No challenges yet." cols={[{ key: 'n', label: 'Challenge', render: (c) => <div>{c.name}<div className="text-xs text-ink-500">{c.goalOrders} orders in {c.windowDays} days{c.minSubtotalCents ? ` · min ${money(c.minSubtotalCents)}` : ''}</div></div> }, { key: 'r', label: 'Reward', render: (c) => `${money(c.rewardCents)} credit · ${c.rewardExpiresDays} d` }, { key: 'p', label: 'In progress / done', render: (c) => `${c.active ?? 0} / ${c.completed ?? 0}` }, { key: 'i', label: 'Credit issued', render: (c) => money(c.rewardsIssuedCents ?? 0) }, { key: 'a', label: '', render: (c) => <Button size="sm" variant="ghost" onClick={() => save(c, !c.isActive)}>{c.isActive ? 'Pause' : 'Start'}</Button> }]} />
      </Card>
      <Card title="New challenge">
        <div className="space-y-2 text-sm">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="3 orders in 14 days" />
          <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <div className="grid grid-cols-2 gap-2"><Input label="Orders" value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} /><Input label="Within days" value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })} /><Input label="Reward (USD credit)" value={f.reward} onChange={(e) => setF({ ...f, reward: e.target.value })} /><Input label="Credit expires (days)" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /><Input label="Min order (USD)" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /><Input label="Ends on" type="date" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></div>
          <Button disabled={f.name.length < 2} onClick={() => run(async () => { await api.post(base, { name: f.name, description: f.description || undefined, goalOrders: Number(f.goal), windowDays: Number(f.window), rewardCents: Math.round(Number(f.reward) * 100), rewardExpiresDays: Number(f.expires), minSubtotalCents: Math.round(Number(f.min || 0) * 100), endsAt: f.ends ? new Date(`${f.ends}T23:59:00`).toISOString() : null }); setF({ ...f, name: '', description: '' }); onChange(); })}>Create</Button>
          <p className="text-xs text-ink-500">Orders count when they are completed. The window starts with the first qualifying order; the credit expires after the set number of days.</p>
        </div>
      </Card>
    </div>
  );
}

interface Results { campaign: { name: string; holdoutPct: number; status: string }; groups: { treatment: { users: number; buyers: number; orders: number; revenueCents: number; conversionPct: number | null }; holdout: { users: number; buyers: number; orders: number; revenueCents: number; conversionPct: number | null } }; attributed: { orders: number; revenueCents: number; redemptions: number }; incrementalOrders: number | null; incrementalOrdersRange: { low: number; high: number; significant: boolean } | null; incrementalRevenueRange: { low: number; high: number; significant: boolean } | null; incrementalRevenueCents: number | null; incrementalMarginCents: number | null; contributionMarginBps: number; promotionCostCents: number; platformFundedCents: number; profitCents: number | null; roi: number | null; note: string | null }

/** 25.10 profitability against the holdout group. */
export function CampaignResults({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useApi<Results>(`/campaigns/${id}/results`);
  return (
    <Modal open onClose={onClose} title={data ? `Results: ${data.campaign.name}` : 'Results'}>
      {!data ? <p className="text-sm text-ink-500">Loading…</p> : (
        <div className="space-y-3 text-sm">
          {data.note && <Alert tone="info">{data.note}</Alert>}
          <Table rows={[{ g: 'Received the campaign', ...data.groups.treatment }, { g: `Holdout (${data.campaign.holdoutPct}%)`, ...data.groups.holdout }]} cols={[{ key: 'g', label: 'Group', render: (r) => r.g }, { key: 'u', label: 'Customers', render: (r) => r.users }, { key: 'b', label: 'Ordered', render: (r) => `${r.buyers} (${r.conversionPct ?? '—'}%)` }, { key: 'o', label: 'Orders', render: (r) => r.orders }, { key: 'r', label: 'Sales', render: (r) => money(r.revenueCents) }]} />
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Incremental orders" value={data.incrementalOrders ?? '—'} hint={data.incrementalOrdersRange ? `95% range ${data.incrementalOrdersRange.low} to ${data.incrementalOrdersRange.high}${data.incrementalOrdersRange.significant ? '' : ' · not conclusive yet'}` : 'vs. what the holdout rate predicts'} />
            <Stat label="Incremental sales" value={data.incrementalRevenueCents === null ? '—' : money(data.incrementalRevenueCents)} hint={data.incrementalRevenueRange ? `95% range ${money(data.incrementalRevenueRange.low)} to ${money(data.incrementalRevenueRange.high)}` : undefined} />
            <Stat label="Promotion cost" value={money(data.promotionCostCents)} hint={`${data.attributed.redemptions} redemptions · ${money(data.platformFundedCents)} Gutad-funded`} />
            <Stat label="Profit" value={data.profitCents === null ? '—' : money(data.profitCents)} hint={`at ${data.contributionMarginBps / 100}% contribution margin${data.roi !== null ? ` · ROI ${data.roi}×` : ''}`} />
          </div>
          <p className="text-xs text-ink-500">Attributed (used the offer): {data.attributed.orders} orders, {money(data.attributed.revenueCents)}. Incremental figures compare the campaign group with the holdout group over the same window.</p>
        </div>
      )}
    </Modal>
  );
}

export function campaignRow(c: { status: string; holdoutPct: number; budgetCents: number; spentCents: number; endsAt: string | null }) {
  return `${c.holdoutPct ? `${c.holdoutPct}% holdout · ` : ''}${c.budgetCents ? `${money(c.spentCents)} of ${money(c.budgetCents)}` : `${money(c.spentCents)} spent`}${c.endsAt ? ` · ends ${when(c.endsAt)}` : ''}`;
}
