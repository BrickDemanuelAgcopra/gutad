'use client';
import { useEffect, useState } from 'react';
import { PACKAGED_CATEGORIES, PACKAGED_CATEGORY_LABELS, PACKAGED_DATE_LABELS, PACKAGED_REVIEW_LABELS, PACKAGED_STORAGE, PACKAGED_STORAGE_LABELS, type PackagedGoodsPolicy, type PackagedReviewStatus } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, Table, Tabs, Textarea } from '@/components/ui';
import { askReason, KeyValue, pendingNotice } from '@/components/admin-ui';

interface Overview {
  review: Record<string, number>; stock: { lots: number; units: number; reserved: number; value_cents: number }; expiringIn7Days: { lots: number; units: number }; openRecalls: number;
  sales30d: { category: string; units: number; revenue_cents: number; orders: number; first_party_units: number }[]; waste30d: { kind: string; units: number }[]; policy: PackagedGoodsPolicy;
}
interface Row {
  menuItemId: string; name: string; description: string | null; priceCents: number; imageUrl: string | null; allergens: string[]; taxCategory: string; size: string | null; organizationName: string | null; organizationId: string; firstParty: boolean; locationName: string | null;
  sku: string | null; gtin: string | null; brandName: string | null; category: string; storage: string; dateType: string; ingredientsText: string | null; countryOfOrigin: string | null; labelImageUrl: string | null;
  reviewStatus: PackagedReviewStatus; reviewNote: string | null; submittedAt: string | null; onHand: number; lots: number;
}
interface Recall { id: string; scope: string; gtin: string | null; reason: string; severity: string; status: string; lotsAffected: number; unitsOnHand: number; ordersAffected: number; customersNotified: number; createdAt: string; organizationName: string | null; closedNote: string | null }
interface Detail { lots: { id: string; lotCode: string; expiresOn: string | null; onHand: number; reserved: number; status: string; locationName: string }[]; movements: { id: string; kind: string; quantity: number; reason: string | null; createdAt: string }[] }

const tone = (s: string) => (s === 'APPROVED' ? 'good' : s === 'PENDING' ? 'warn' : s === 'DRAFT' ? 'neutral' : 'bad');

export default function AdminPackagedPage() {
  const { can } = useSession();
  const manage = can('catalog.manage');
  const [tab, setTab] = useState('overview');
  const { data: ov, reload: reloadOv } = useApi<Overview>('/admin/packaged');
  const [status, setStatus] = useState('PENDING');
  const [q, setQ] = useState('');
  const { data: products, reload } = useApi<Row[]>(`/admin/packaged/products?${new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) })}`, { deps: [status, q] });
  const { data: recalls, reload: reloadRecalls } = useApi<Recall[]>(tab === 'recalls' ? '/admin/packaged/recalls' : null, { deps: [tab] });
  const { data: pol, reload: reloadPol } = useApi<{ policy: PackagedGoodsPolicy; commission: { commissionBps: number | null } }>(tab === 'policy' ? '/admin/packaged/policy' : null, { deps: [tab] });
  const { run, error, busy } = useAction();
  const [sel, setSel] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<PackagedGoodsPolicy | null>(null);
  const [commission, setCommission] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [recall, setRecall] = useState<{ scope: 'GTIN' | 'PRODUCT'; gtin: string; itemId: string; reason: string; severity: string } | null>(null);
  useEffect(() => { if (pol) { setDraft(pol.policy); setCommission(pol.commission.commissionBps == null ? '' : String(pol.commission.commissionBps / 100)); } }, [pol]);
  useEffect(() => { setDetail(null); setNote(''); if (sel) void api.get<Detail>(`/admin/packaged/products/${sel.menuItemId}`).then(setDetail).catch(() => undefined); }, [sel?.menuItemId]);

  const decide = (decision: 'APPROVE' | 'REJECT' | 'SUSPEND') => sel && run(async () => { await api.post(`/admin/packaged/products/${sel.menuItemId}/review`, { decision, note: note || (decision === 'APPROVE' ? 'Label and details checked' : '') }); setSel(null); await reload(); await reloadOv(); });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Packaged goods</h1>
        <p className="text-sm text-ink-500">Shelf-stable, chilled and frozen products sold by merchants and by Gutad next to cooked food. Review new products, recall batches or a barcode across every seller, and set the rules for expiry, categories, sellers and commission.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="good">{msg}</Alert>}
      {ov && !ov.policy.enabled && <Alert>The kill switch is on: every packaged product shows as sold out and checkout refuses them.</Alert>}
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'review', label: `Review queue${ov?.review.PENDING ? ` (${ov.review.PENDING})` : ''}` }, { id: 'recalls', label: `Recalls${ov?.openRecalls ? ` (${ov.openRecalls} open)` : ''}` }, { id: 'policy', label: 'Rules & commission' }]} active={tab} onChange={(t) => { setTab(t); if (t === 'review') setStatus('PENDING'); }} />

      {tab === 'overview' && ov && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Products live" value={ov.review.APPROVED ?? 0} hint={`${ov.review.PENDING ?? 0} waiting · ${(ov.review.REJECTED ?? 0) + (ov.review.SUSPENDED ?? 0)} rejected/suspended`} />
            <Stat label="Units in stock" value={ov.stock.units} hint={`${ov.stock.lots} batches · ${ov.stock.reserved} held · cost ${money(Number(ov.stock.value_cents))}`} />
            <Stat label="Expiring in 7 days" value={ov.expiringIn7Days.units} hint={`${ov.expiringIn7Days.lots} batches`} />
            <Stat label="Open recalls" value={ov.openRecalls} />
          </div>
          <Card title="Sales, last 30 days (by category)">
            <Table rows={ov.sales30d} empty="No packaged sales yet." cols={[
              { key: 'c', label: 'Category', render: (r) => PACKAGED_CATEGORY_LABELS[r.category as 'PANTRY'] || r.category },
              { key: 'u', label: 'Units', render: (r) => r.units, className: 'text-right' }, { key: 'o', label: 'Orders', render: (r) => r.orders, className: 'text-right' },
              { key: 'r', label: 'Sales', render: (r) => money(Number(r.revenue_cents)), className: 'text-right' }, { key: 'f', label: 'Of which Gutad’s own', render: (r) => `${r.first_party_units} units`, className: 'text-right' },
            ]} />
            <p className="mt-2 text-xs text-ink-500">Waste and short picks (30 days): {ov.waste30d.length ? ov.waste30d.map((w) => `${w.kind === 'WASTE' ? 'disposed' : 'not found at pick'} ${w.units}`).join(' · ') : 'none'}.</p>
          </Card>
          <div className="flex gap-2"><Button variant="secondary" onClick={() => { setTab('review'); setStatus(''); }}>Browse all products</Button>{manage && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ expired: number }>('/admin/packaged/sweep', {}); setMsg(`Expiry check done: ${r.expired} batch(es) moved past sell-by.`); await reloadOv(); })}>Run expiry check now</Button>}</div>
        </div>
      )}

      {tab === 'review' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(PACKAGED_REVIEW_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Input label="Search name, brand, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Table rows={products || []} empty={status === 'PENDING' ? 'Nothing waiting for review.' : 'No products.'} cols={[
            { key: 'n', label: 'Product', render: (r) => <button className="text-left" onClick={() => setSel(r)}><div className="font-medium text-brand-700 underline-offset-2 hover:underline">{r.name}</div><div className="text-xs text-ink-500">{[r.brandName, r.size, PACKAGED_CATEGORY_LABELS[r.category as 'PANTRY']].filter(Boolean).join(' · ')}</div></button> },
            { key: 's', label: 'Seller', render: (r) => <div>{r.organizationName}{r.firstParty && <Badge tone="info">Gutad</Badge>}<div className="text-xs text-ink-500">{r.locationName}</div></div> },
            { key: 'g', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.gtin || '—'}</span> },
            { key: 'st', label: 'Status', render: (r) => <Badge tone={tone(r.reviewStatus)}>{PACKAGED_REVIEW_LABELS[r.reviewStatus]}</Badge> },
            { key: 'k', label: 'Stock', render: (r) => `${r.onHand} in ${r.lots} batch(es)`, className: 'text-right' },
            { key: 'a', label: '', render: (r) => <Button size="sm" variant="secondary" onClick={() => setSel(r)}>Open</Button> },
          ]} />
        </div>
      )}

      {tab === 'recalls' && (
        <div className="space-y-3">
          {manage && <div className="flex justify-end"><Button onClick={() => setRecall({ scope: 'GTIN', gtin: '', itemId: '', reason: '', severity: 'HIGH' })}>New Gutad-wide recall</Button></div>}
          <p className="text-xs text-ink-500">A barcode recall pulls every batch with that GTIN from every seller, including Gutad&apos;s own stores: use it for a manufacturer or FDA recall. Open orders get the item marked unavailable; customers who received it get a safety notice.</p>
          <Table rows={recalls || []} empty="No recalls." cols={[
            { key: 'd', label: 'Started', render: (r) => new Date(r.createdAt).toLocaleString() }, { key: 'o', label: 'Seller', render: (r) => r.organizationName || <Badge tone="info">Gutad-wide</Badge> },
            { key: 's', label: 'Scope', render: (r) => `${r.scope}${r.gtin ? ` ${r.gtin}` : ''}` }, { key: 'r', label: 'Reason', render: (r) => r.reason },
            { key: 'i', label: 'Impact', render: (r) => `${r.lotsAffected} batches · ${r.unitsOnHand} units · ${r.ordersAffected} orders · ${r.customersNotified} notified` },
            { key: 'st', label: 'Status', render: (r) => r.status === 'OPEN' && manage ? <Button size="sm" variant="ghost" onClick={() => { const n = askReason('closing this recall', 3); if (n) run(async () => { await api.post(`/packaged-recalls/${r.id}/close`, { note: n }); await reloadRecalls(); await reloadOv(); }); }}>Close</Button> : <span title={r.closedNote || ''}><Badge tone={r.status === 'OPEN' ? 'bad' : 'neutral'}>{r.status}</Badge></span> },
          ]} />
        </div>
      )}

      {tab === 'policy' && draft && (
        <div className="space-y-4">
          <Card title="Switches">
            <div className="grid gap-2 md:grid-cols-2">
              {([['enabled', 'Packaged goods on (off = kill switch: everything sold out)'], ['requireReview', 'Gutad reviews new products and label changes'], ['reviewFirstParty', 'Gutad’s own products go through the same review'], ['requireGtin', 'Barcode required (house-made goods exempt)'], ['requireLabelImage', 'Label photo required']] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!manage} checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />{label}</label>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Input label="Show “Only N left” at or below" type="number" disabled={!manage} value={draft.showStockBelow} onChange={(e) => setDraft({ ...draft, showStockBelow: Number(e.target.value) })} />
              <Input label="Max units of one product per order" type="number" disabled={!manage} value={draft.maxPerOrder} onChange={(e) => setDraft({ ...draft, maxPerOrder: Number(e.target.value) })} />
            </div>
          </Card>
          <Card title="Shelf life (days)">
            <Table rows={[...PACKAGED_STORAGE]} cols={[
              { key: 's', label: 'Storage', render: (s) => PACKAGED_STORAGE_LABELS[s] },
              { key: 'm', label: 'Stop selling this many days before the date', render: (s) => <Input type="number" disabled={!manage} value={draft.minRemainingDays[s]} onChange={(e) => setDraft({ ...draft, minRemainingDays: { ...draft.minRemainingDays, [s]: Number(e.target.value) } })} /> },
              { key: 'n', label: 'Warn the store this many days ahead', render: (s) => <Input type="number" disabled={!manage} value={draft.nearExpiryDays[s]} onChange={(e) => setDraft({ ...draft, nearExpiryDays: { ...draft.nearExpiryDays, [s]: Number(e.target.value) } })} /> },
            ]} />
            <p className="mt-2 text-xs text-ink-500">A {PACKAGED_DATE_LABELS.USE_BY.toLowerCase()} batch also stops a day earlier: it is never sold on its date. A store can set a longer period for one product.</p>
          </Card>
          <Card title="Categories">
            <Table rows={[...PACKAGED_CATEGORIES]} cols={[
              { key: 'c', label: 'Category', render: (c) => PACKAGED_CATEGORY_LABELS[c] },
              { key: 'a', label: 'Allowed', render: (c) => <input type="checkbox" disabled={!manage} checked={draft.categories[c].allowed} onChange={(e) => setDraft({ ...draft, categories: { ...draft.categories, [c]: { ...draft.categories[c], allowed: e.target.checked } } })} /> },
              { key: 'r', label: 'Review', render: (c) => <input type="checkbox" disabled={!manage} checked={draft.categories[c].review} onChange={(e) => setDraft({ ...draft, categories: { ...draft.categories, [c]: { ...draft.categories[c], review: e.target.checked } } })} /> },
              { key: 't', label: 'Tax category', render: (c) => <Select disabled={!manage} value={draft.categories[c].taxCategory} onChange={(e) => setDraft({ ...draft, categories: { ...draft.categories, [c]: { ...draft.categories[c], taxCategory: e.target.value } } })}>{['GROCERY', 'BEVERAGE', 'ALCOHOL', 'PREPARED_FOOD', 'STANDARD', 'EXEMPT'].map((t) => <option key={t}>{t}</option>)}</Select> },
            ]} />
            <p className="mt-2 text-xs text-ink-500">Alcohol needs the store&apos;s licence on file. Its tax category ALCOHOL turns on the courier age check at the door.</p>
          </Card>
          <Card title="Sellers">
            <Select label="Who may sell packaged goods" disabled={!manage} value={draft.sellers} onChange={(e) => setDraft({ ...draft, sellers: e.target.value as 'ALL' })}><option value="ALL">Every merchant</option><option value="ALLOW_LIST">Only merchants on the allow list</option></Select>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <Textarea label="Allow list (organization ids, one per line)" disabled={!manage} value={draft.allowOrgIds.join('\n')} onChange={(e) => setDraft({ ...draft, allowOrgIds: e.target.value.split(/\s+/).filter(Boolean) })} />
              <Textarea label="Blocked (organization ids, one per line)" disabled={!manage} value={draft.blockedOrgIds.join('\n')} onChange={(e) => setDraft({ ...draft, blockedOrgIds: e.target.value.split(/\s+/).filter(Boolean) })} />
            </div>
            <p className="mt-1 text-xs text-ink-500">Gutad&apos;s own stores are never blocked by the seller list. Use the kill switch to stop them too.</p>
          </Card>
          {manage && <Button disabled={busy} onClick={() => { const reason = askReason('changing the packaged goods rules'); if (reason) run(async () => { await api.put('/admin/packaged/policy', { policy: draft, reason }); setMsg('Rules saved. Stores and menus pick them up within a minute.'); await reloadPol(); await reloadOv(); }); }}>Save rules</Button>}
          <Card title="Commission on packaged goods">
            <p className="mb-2 text-xs text-ink-500">Charged on the packaged part of an order instead of the store&apos;s normal commission. Leave blank to use each store&apos;s normal rate. Gutad&apos;s own sales carry none. Changes need a second admin (Approvals).</p>
            <div className="flex items-end gap-2"><Input label="Commission %" value={commission} disabled={!manage} onChange={(e) => setCommission(e.target.value)} placeholder="normal rate" />
              {manage && <Button variant="secondary" disabled={busy} onClick={() => { const reason = askReason('changing the packaged goods commission'); if (reason) run(async () => { const r = await api.post('/admin/settings', { key: 'fees.packaged', value: { commissionBps: commission === '' ? null : Math.round(Number(commission) * 100) }, reason }); setMsg(pendingNotice(r) || 'Saved.'); }); }}>Request change</Button>}</div>
            <p className="mt-1 text-xs text-ink-500">In force now: {pol?.commission.commissionBps == null ? 'each store’s normal rate' : `${pol.commission.commissionBps / 100}%`}.</p>
          </Card>
        </div>
      )}

      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.name || ''}>
        {sel && (
          <div className="space-y-3 text-sm">
            <div className="flex gap-3">{sel.imageUrl && <img src={sel.imageUrl} alt="" className="h-20 w-20 rounded-lg object-cover" />}{sel.labelImageUrl && <a href={sel.labelImageUrl} target="_blank" rel="noreferrer"><img src={sel.labelImageUrl} alt="Label" className="h-20 w-20 rounded-lg border object-cover" /></a>}</div>
            <KeyValue rows={[
              ['Seller', `${sel.organizationName || ''}${sel.firstParty ? ' (Gutad)' : ''} · ${sel.locationName || ''}`], ['Status', <Badge key="s" tone={tone(sel.reviewStatus)}>{PACKAGED_REVIEW_LABELS[sel.reviewStatus]}</Badge>],
              ['Category', PACKAGED_CATEGORY_LABELS[sel.category as 'PANTRY']], ['Storage / date', `${PACKAGED_STORAGE_LABELS[sel.storage as 'AMBIENT']} · ${PACKAGED_DATE_LABELS[sel.dateType as 'BEST_BEFORE']}`],
              ['Brand / size', [sel.brandName, sel.size].filter(Boolean).join(' · ') || '—'], ['Barcode / SKU', `${sel.gtin || '—'} / ${sel.sku || '—'}`], ['Price / tax', `${money(sel.priceCents)} · ${sel.taxCategory}`],
              ['Ingredients', sel.ingredientsText || '—'], ['Allergens', sel.allergens.join(', ') || 'none declared'], ['Origin', sel.countryOfOrigin || '—'], ['Description', sel.description || '—'], ['Last note', sel.reviewNote || '—'],
            ]} />
            {detail && <div><div className="mb-1 font-semibold">Batches</div><Table rows={detail.lots} empty="No stock received yet." cols={[{ key: 'l', label: 'Batch', render: (l) => <span className="font-mono text-xs">{l.lotCode}</span> }, { key: 'w', label: 'Where', render: (l) => l.locationName }, { key: 'd', label: 'Date', render: (l) => l.expiresOn || '—' }, { key: 'q', label: 'On hand / held', render: (l) => `${l.onHand} / ${l.reserved}` }, { key: 's', label: 'Status', render: (l) => l.status }]} /></div>}
            {manage && (
              <div className="space-y-2 border-t border-ink-100 pt-3">
                <Textarea label="Note to the store (required to reject or suspend)" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  {['PENDING', 'REJECTED', 'SUSPENDED', 'DRAFT'].includes(sel.reviewStatus) && <Button disabled={busy} onClick={() => decide('APPROVE')}>Approve</Button>}
                  {['PENDING', 'DRAFT'].includes(sel.reviewStatus) && <Button variant="secondary" disabled={busy || note.length < 3} onClick={() => decide('REJECT')}>Reject</Button>}
                  {['APPROVED', 'PENDING'].includes(sel.reviewStatus) && <Button variant="ghost" disabled={busy || note.length < 3} onClick={() => decide('SUSPEND')}>Suspend</Button>}
                  <Button variant="ghost" onClick={() => { setRecall({ scope: 'PRODUCT', gtin: '', itemId: sel.menuItemId, reason: '', severity: 'HIGH' }); setSel(null); setTab('recalls'); }}>Recall this product…</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!recall} onClose={() => setRecall(null)} title="Recall">
        {recall && (
          <div className="space-y-2">
            {recall.scope === 'GTIN' ? <Input label="Barcode (GTIN/UPC/EAN)" value={recall.gtin} onChange={(e) => setRecall({ ...recall, gtin: e.target.value })} /> : <p className="text-sm">Every batch of this product, at every location.</p>}
            <Select label="Severity" value={recall.severity} onChange={(e) => setRecall({ ...recall, severity: e.target.value })}><option>LOW</option><option>HIGH</option><option>CRITICAL</option></Select>
            <Textarea label="Reason (customers who received it see this)" value={recall.reason} onChange={(e) => setRecall({ ...recall, reason: e.target.value })} />
            <Button disabled={busy || recall.reason.length < 5 || (recall.scope === 'GTIN' && !recall.gtin)} onClick={() => confirm('Recall now? Sales stop at once and affected customers are notified.') && run(async () => { const r = await api.post<{ lotsAffected: number; ordersAffected: number; customersNotified: number }>('/admin/packaged/recalls', { scope: recall.scope, gtin: recall.scope === 'GTIN' ? recall.gtin : undefined, itemId: recall.scope === 'PRODUCT' ? recall.itemId : undefined, reason: recall.reason, severity: recall.severity }); setRecall(null); setMsg(`Recall started: ${r.lotsAffected} batches pulled, ${r.ordersAffected} orders affected, ${r.customersNotified} customers notified.`); await reloadRecalls(); await reloadOv(); })}>Recall</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
