'use client';
import { Fragment, useState } from 'react';
import { LOT_ADJUST_KINDS, LOT_ADJUST_LABELS, PACKAGED_CATEGORIES, PACKAGED_CATEGORY_LABELS, PACKAGED_DATE_LABELS, PACKAGED_DATE_TYPES, PACKAGED_REVIEW_LABELS, PACKAGED_STORAGE, PACKAGED_STORAGE_LABELS, SIZE_UOMS, type LotAdjustKind, type PackagedCategory, type PackagedReviewStatus } from '@gutad/shared';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, Input, Modal, Select, Stat, Table, Tabs, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

interface Lot { id: string; lotCode: string; expiresOn: string | null; sellBy: string | null; onHand: number; reserved: number; receivedQty: number; unitCostCents: number; status: string; supplierName: string | null; receivedAt: string }
interface Product {
  itemId: string; name: string; priceCents: number; isActive: boolean; imageUrl: string | null; taxCategory: string; menuName: string; categoryName: string; size: string | null; gate: string | null; minRemainingDays: number | null;
  available: number; onHand: number; reserved: number; lowStock: boolean; nextExpiry: string | null; lots: Lot[];
  product: { sku: string | null; gtin: string | null; brandName: string | null; category: PackagedCategory; storage: string; dateType: string; reviewStatus: PackagedReviewStatus; reviewNote: string | null; lowStockThreshold: number; ingredientsText: string | null; countryOfOrigin: string | null; labelImageUrl: string | null; size: number | null; sizeUom: string | null; unitCount: number; minRemainingDays: number | null };
}
interface View {
  policy: { enabled: boolean; requireReview: boolean; categories: Record<PackagedCategory, { allowed: boolean; review: boolean; taxCategory: string }>; minRemainingDays: Record<string, number>; requireGtin: boolean; requireLabelImage: boolean; sellerAllowed: boolean };
  chefKitchen: boolean; today: string; products: Product[];
  expiringSoon: { itemId: string; name: string; lotId: string; lotCode: string; expiresOn: string; sellBy: string; units: number; pastSellBy: boolean }[];
  toRemove: { itemId: string; name: string; lotId: string; lotCode: string; status: string; expiresOn: string | null; units: number }[];
  lowStock: { itemId: string; name: string; available: number; threshold: number }[];
}
interface Recall { id: string; scope: string; gtin: string | null; reason: string; severity: string; status: string; lotsAffected: number; unitsOnHand: number; ordersAffected: number; customersNotified: number; createdAt: string; organizationId: string | null }
interface Move { id: string; kind: string; quantity: number; reason: string | null; lotCode: string; orderNumber: string | null; createdAt: string }
interface Menu { id: string; name: string; categories: { id: string; name: string }[] }

const reviewTone = (s: string) => (s === 'APPROVED' ? 'good' : s === 'PENDING' ? 'warn' : s === 'DRAFT' ? 'neutral' : 'bad');
const blank = { name: '', priceCents: '', description: '', categoryId: '', category: 'PANTRY' as PackagedCategory, storage: 'AMBIENT', dateType: 'BEST_BEFORE', brandName: '', size: '', sizeUom: 'g', unitCount: '1', sku: '', gtin: '', ingredientsText: '', allergens: '', countryOfOrigin: '', imageUrl: '', labelImageUrl: '', lowStockThreshold: '5', minRemainingDays: '' };
type Form = typeof blank;

export default function ProductsPage() {
  const { loc } = useMerchant();
  const { data, reload, loading } = useApi<View>(loc ? `/locations/${loc.id}/packaged` : null, { deps: [loc?.id] });
  const { data: menus } = useApi<Menu[]>(loc ? `/locations/${loc.id}/menus` : null, { deps: [loc?.id] });
  const { data: recalls, reload: reloadRecalls } = useApi<Recall[]>(loc ? `/locations/${loc.id}/packaged/recalls` : null, { deps: [loc?.id] });
  const { run, error, busy } = useAction();
  const [tab, setTab] = useState('stock');
  const [form, setForm] = useState<(Form & { itemId?: string }) | null>(null);
  const [receive, setReceive] = useState<{ itemId: string; name: string; dateType: string; quantity: string; expiresOn: string; lotCode: string; unitCost: string; supplier: string } | null>(null);
  const [adjust, setAdjust] = useState<{ lot: Lot; name: string; kind: LotAdjustKind; quantity: string; reason: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [moves, setMoves] = useState<{ name: string; rows: Move[] } | null>(null);
  const [recall, setRecall] = useState<{ scope: 'LOT' | 'PRODUCT' | 'GTIN'; lotIds: string[]; itemId: string; gtin: string; reason: string; severity: string } | null>(null);
  if (!loc) return null;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  const categories = (menus || []).flatMap((m) => m.categories.map((c) => ({ id: c.id, label: `${m.name} › ${c.name}` })));
  const p = data?.policy;

  const save = (f: Form & { itemId?: string }) => act(async () => {
    const body = {
      name: f.name, priceCents: Math.round(Number(f.priceCents) * 100), description: f.description || null, category: f.category, storage: f.storage, dateType: f.dateType,
      brandName: f.brandName || null, size: f.size ? Number(f.size) : null, sizeUom: f.size ? f.sizeUom : null, unitCount: Number(f.unitCount) || 1, sku: f.sku || null, gtin: f.gtin || null,
      ingredientsText: f.ingredientsText || null, allergens: f.allergens ? f.allergens.split(',').map((s) => s.trim()).filter(Boolean) : [], countryOfOrigin: f.countryOfOrigin || null,
      imageUrl: f.imageUrl || null, labelImageUrl: f.labelImageUrl || null, lowStockThreshold: Number(f.lowStockThreshold) || 0, minRemainingDays: f.minRemainingDays === '' ? null : Number(f.minRemainingDays),
    };
    if (f.itemId) { const { priceCents: _p, ...rest } = body; await api.patch(`/packaged/${f.itemId}`, rest); }
    else await api.post(`/categories/${f.categoryId}/packaged`, body);
    setForm(null);
  });
  const edit = (x: Product) => setForm({ ...blank, itemId: x.itemId, name: x.name, priceCents: (x.priceCents / 100).toFixed(2), category: x.product.category, storage: x.product.storage, dateType: x.product.dateType, brandName: x.product.brandName || '', size: x.product.size ? String(x.product.size) : '', sizeUom: x.product.sizeUom || 'g', unitCount: String(x.product.unitCount || 1), sku: x.product.sku || '', gtin: x.product.gtin || '', ingredientsText: x.product.ingredientsText || '', countryOfOrigin: x.product.countryOfOrigin || '', labelImageUrl: x.product.labelImageUrl || '', imageUrl: x.imageUrl || '', lowStockThreshold: String(x.product.lowStockThreshold), minRemainingDays: x.product.minRemainingDays == null ? '' : String(x.product.minRemainingDays) });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Packaged products</h1>
          <p className="text-sm text-ink-500">Sauces, snacks, drinks, frozen and other packaged goods you sell next to your food. Stock is kept in dated batches. Checkout reserves the batch with the earliest date first, and sells a batch only while it has at least the minimum days left.</p>
        </div>
        <Button disabled={!p?.enabled || !p?.sellerAllowed || data?.chefKitchen} onClick={() => setForm({ ...blank, categoryId: categories[0]?.id || '' })}>+ New product</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data?.chefKitchen && <Alert tone="info">Chef Network kitchens cook to order and can&apos;t sell packaged goods.</Alert>}
      {p && !p.enabled && <Alert tone="info">Gutad has paused packaged goods on the marketplace. Your products show as sold out until it is back on.</Alert>}
      {p && p.enabled && !p.sellerAllowed && <Alert tone="info">Your business isn&apos;t enabled for packaged goods yet. Contact Gutad support to apply.</Alert>}
      {p?.requireReview && <p className="text-xs text-ink-500">New products, and changes to what&apos;s printed on the label, are checked by Gutad before they go on sale. Price and stock changes are not.</p>}
      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Products" value={data.products.length} hint={`${data.products.filter((x) => x.product.reviewStatus === 'PENDING').length} waiting for review`} />
          <Stat label="Units for sale" value={data.products.reduce((a, x) => a + x.available, 0)} hint={`${data.products.reduce((a, x) => a + x.reserved, 0)} held for open orders`} />
          <Stat label="Expiring soon" value={data.expiringSoon.length} hint="batches near their sell-by point" />
          <Stat label="Low stock" value={data.lowStock.length} hint={data.toRemove.length ? `${data.toRemove.length} batch(es) to remove` : 'at or below your threshold'} />
        </div>
      )}
      <Tabs tabs={[{ id: 'stock', label: 'Products & stock' }, { id: 'expiry', label: `Expiring & to remove${data ? ` (${data.expiringSoon.length + data.toRemove.length})` : ''}` }, { id: 'recalls', label: 'Recalls' }]} active={tab} onChange={setTab} />

      {tab === 'stock' && (loading && !data ? <p className="text-sm text-ink-500">Loading…</p> : !data?.products.length ? <Empty>No packaged products yet. Add one with “New product”; it goes into a category of one of your menus, next to your dishes.</Empty> : (
        <div className="overflow-x-auto rounded-xl border border-ink-100">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500"><tr><th className="px-3 py-2">Product</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">For sale</th><th className="px-3 py-2 text-right">On shelf / held</th><th className="px-3 py-2">Next date</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-ink-100 bg-white">
              {data.products.map((x) => (
                <Fragment key={x.itemId}>
                  <tr>
                    <td className="px-3 py-2 align-top"><div className="font-medium">{x.name}</div><div className="text-xs text-ink-500">{[x.product.brandName, x.size, PACKAGED_STORAGE_LABELS[x.product.storage as 'AMBIENT'], money(x.priceCents)].filter(Boolean).join(' · ')}</div><div className="text-xs text-ink-300">{x.menuName} › {x.categoryName}{x.product.gtin ? ` · GTIN ${x.product.gtin}` : ''}{x.product.sku ? ` · SKU ${x.product.sku}` : ''}</div></td>
                    <td className="px-3 py-2 align-top"><Badge tone={reviewTone(x.product.reviewStatus)}>{PACKAGED_REVIEW_LABELS[x.product.reviewStatus]}</Badge>{x.product.reviewNote && x.product.reviewStatus !== 'APPROVED' && <div className="mt-1 max-w-[14rem] text-xs text-ink-500">{x.product.reviewNote}</div>}{x.gate && x.product.reviewStatus === 'APPROVED' && <div className="mt-1 text-xs text-red-700">{x.gate}</div>}</td>
                    <td className={`px-3 py-2 text-right align-top font-semibold ${x.available === 0 ? 'text-red-700' : x.lowStock ? 'text-amber-700' : ''}`}>{x.available}{x.available === 0 ? ' · sold out' : x.lowStock ? ' · low' : ''}</td>
                    <td className="px-3 py-2 text-right align-top">{x.onHand} / {x.reserved}</td>
                    <td className="px-3 py-2 align-top text-xs">{x.nextExpiry ? `${PACKAGED_DATE_LABELS[x.product.dateType as 'BEST_BEFORE']} ${x.nextExpiry}` : '—'}{x.minRemainingDays != null && <div className="text-ink-500">sold until {x.minRemainingDays} day(s) before</div>}</td>
                    <td className="px-3 py-2 align-top"><div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" onClick={() => setReceive({ itemId: x.itemId, name: x.name, dateType: x.product.dateType, quantity: '', expiresOn: '', lotCode: '', unitCost: '', supplier: '' })}>Receive</Button>
                      <Button size="sm" variant="secondary" onClick={() => setOpen(open === x.itemId ? null : x.itemId)}>Batches ({x.lots.length})</Button>
                      <Button size="sm" variant="ghost" onClick={() => edit(x)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => run(async () => setMoves({ name: x.name, rows: await api.get<Move[]>(`/packaged/${x.itemId}/movements?locationId=${loc.id}`) }))}>History</Button>
                      {x.product.reviewStatus === 'REJECTED' && <Button size="sm" variant="ghost" onClick={() => act(() => api.post(`/packaged/${x.itemId}/submit`, {}))}>Resubmit</Button>}
                    </div></td>
                  </tr>
                  {open === x.itemId && (
                    <tr><td colSpan={6} className="bg-ink-50/60 px-3 py-2">
                      {!x.lots.length ? <p className="text-xs text-ink-500">No batches. Use “Receive” when stock arrives.</p> : (
                        <table className="w-full text-xs"><thead className="text-left text-ink-500"><tr><th className="py-1">Batch</th><th>Date</th><th>Sell until</th><th className="text-right">On shelf</th><th className="text-right">Held</th><th>Status</th><th /></tr></thead><tbody>
                          {x.lots.map((l) => (
                            <tr key={l.id} className="border-t border-ink-100">
                              <td className="py-1 font-mono">{l.lotCode}{l.supplierName && <span className="ml-1 font-sans text-ink-500">({l.supplierName})</span>}</td>
                              <td>{l.expiresOn || '—'}</td><td className={l.sellBy && data && l.sellBy < data.today ? 'text-red-700' : ''}>{l.sellBy || '—'}</td>
                              <td className="text-right">{l.onHand}</td><td className="text-right">{l.reserved}</td>
                              <td><Badge tone={l.status === 'ACTIVE' ? 'good' : l.status === 'DEPLETED' ? 'neutral' : 'bad'}>{l.status}</Badge></td>
                              <td className="text-right"><div className="flex justify-end gap-1">
                                <Button size="sm" variant="ghost" onClick={() => setAdjust({ lot: l, name: x.name, kind: 'COUNT', quantity: String(l.onHand), reason: '' })}>Adjust</Button>
                                {l.status !== 'RECALLED' && <Button size="sm" variant="ghost" onClick={() => setRecall({ scope: 'LOT', lotIds: [l.id], itemId: x.itemId, gtin: '', reason: '', severity: 'HIGH' })}>Recall</Button>}
                              </div></td>
                            </tr>
                          ))}
                        </tbody></table>
                      )}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {tab === 'expiry' && data && (
        <div className="space-y-4">
          <Card title="Remove from the shelf">
            <p className="mb-2 text-xs text-ink-500">These batches are past their sell-by point, or were recalled. They are no longer sold. Record what you throw away (or return to the supplier) so stock stays right.</p>
            <Table rows={data.toRemove} empty="Nothing to remove." cols={[
              { key: 'n', label: 'Product', render: (r) => r.name }, { key: 'l', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.lotCode}</span> },
              { key: 'd', label: 'Date', render: (r) => r.expiresOn || '—' }, { key: 's', label: 'Why', render: (r) => <Badge tone="bad">{r.status === 'RECALLED' ? 'Recalled' : 'Past sell-by'}</Badge> },
              { key: 'u', label: 'Units', render: (r) => r.units, className: 'text-right' },
              { key: 'a', label: '', render: (r) => <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => api.post(`/packaged-lots/${r.lotId}/adjust`, { kind: 'WASTE', quantity: r.units, reason: r.status === 'RECALLED' ? 'Recalled batch removed' : 'Past sell-by, disposed' }))}>Record removal</Button> },
            ]} />
          </Card>
          <Card title="Expiring soon">
            <p className="mb-2 text-xs text-ink-500">Sell these first, or plan a promotion. On the sell-by date they stop selling automatically.</p>
            <Table rows={data.expiringSoon} empty="Nothing close to its date." cols={[
              { key: 'n', label: 'Product', render: (r) => r.name }, { key: 'l', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.lotCode}</span> },
              { key: 'd', label: 'Date on pack', render: (r) => r.expiresOn }, { key: 's', label: 'Sells until', render: (r) => <span className={r.pastSellBy ? 'text-red-700' : ''}>{r.sellBy}</span> },
              { key: 'u', label: 'Units for sale', render: (r) => r.units, className: 'text-right' },
            ]} />
          </Card>
          <Card title="Low stock">
            <Table rows={data.lowStock} empty="Nothing is low." cols={[{ key: 'n', label: 'Product', render: (r) => r.name }, { key: 'a', label: 'For sale', render: (r) => r.available, className: 'text-right' }, { key: 't', label: 'Your threshold', render: (r) => r.threshold, className: 'text-right' }]} />
          </Card>
        </div>
      )}

      {tab === 'recalls' && (
        <div className="space-y-3">
          <div className="flex justify-end"><Button variant="secondary" onClick={() => setRecall({ scope: 'PRODUCT', lotIds: [], itemId: data?.products[0]?.itemId || '', gtin: '', reason: '', severity: 'HIGH' })}>Start a recall</Button></div>
          <p className="text-xs text-ink-500">A recall stops the batches selling at once. Open orders holding them get the item marked unavailable (the customer picks a replacement or a credit). Customers who already got them receive a safety notice.</p>
          <Table rows={recalls || []} empty="No recalls." cols={[
            { key: 'd', label: 'Started', render: (r) => new Date(r.createdAt).toLocaleString() }, { key: 's', label: 'Scope', render: (r) => `${r.scope}${r.gtin ? ` ${r.gtin}` : ''}${r.organizationId ? '' : ' (Gutad-wide)'}` },
            { key: 'r', label: 'Reason', render: (r) => r.reason }, { key: 'v', label: 'Severity', render: (r) => <Badge tone={r.severity === 'LOW' ? 'warn' : 'bad'}>{r.severity}</Badge> },
            { key: 'i', label: 'Impact', render: (r) => `${r.lotsAffected} batches · ${r.unitsOnHand} units · ${r.ordersAffected} orders · ${r.customersNotified} notified` },
            { key: 'st', label: 'Status', render: (r) => r.status === 'OPEN' && r.organizationId ? <Button size="sm" variant="ghost" onClick={() => { const note = prompt('Closing note (what was done)'); if (note) run(async () => { await api.post(`/packaged-recalls/${r.id}/close`, { note }); await reloadRecalls(); }); }}>Close</Button> : <Badge tone={r.status === 'OPEN' ? 'bad' : 'neutral'}>{r.status}</Badge> },
          ]} />
        </div>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.itemId ? 'Edit packaged product' : 'New packaged product'}>
        {form && p && (
          <div className="space-y-2">
            {!form.itemId && (categories.length ? <Select label="Menu category" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>{categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select> : <Alert tone="info">Create a menu and a category first (Menu page).</Alert>)}
            <Input label="Name (as on the pack)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              {!form.itemId && <Input label="Price (USD)" value={form.priceCents} onChange={(e) => setForm({ ...form, priceCents: e.target.value })} />}
              <Input label="Brand / maker" value={form.brandName} onChange={(e) => setForm({ ...form, brandName: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input label="Size" value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} placeholder="340" />
              <Select label="Unit" value={form.sizeUom} onChange={(e) => setForm({ ...form, sizeUom: e.target.value })}>{SIZE_UOMS.map((u) => <option key={u}>{u}</option>)}</Select>
              <Input label="Pack of" value={form.unitCount} onChange={(e) => setForm({ ...form, unitCount: e.target.value })} />
            </div>
            <Select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as PackagedCategory })}>{PACKAGED_CATEGORIES.map((c) => <option key={c} value={c} disabled={!p.categories[c].allowed}>{PACKAGED_CATEGORY_LABELS[c]}{p.categories[c].allowed ? '' : ' (not allowed)'}</option>)}</Select>
            <div className="grid grid-cols-2 gap-2">
              <Select label="Storage" value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>{PACKAGED_STORAGE.map((s) => <option key={s} value={s}>{PACKAGED_STORAGE_LABELS[s]}</option>)}</Select>
              <Select label="Date on the pack" value={form.dateType} onChange={(e) => setForm({ ...form, dateType: e.target.value })}>{PACKAGED_DATE_TYPES.map((s) => <option key={s} value={s}>{PACKAGED_DATE_LABELS[s]}</option>)}</Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label={`Barcode (GTIN/UPC/EAN)${p.requireGtin && form.category !== 'HOUSE_MADE' ? '' : ' — optional'}`} value={form.gtin} onChange={(e) => setForm({ ...form, gtin: e.target.value })} />
              <Input label="Your SKU (optional)" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </div>
            <Textarea label="Ingredients (as on the label)" value={form.ingredientsText} onChange={(e) => setForm({ ...form, ingredientsText: e.target.value })} />
            <Input label="Allergens (comma separated)" value={form.allergens} onChange={(e) => setForm({ ...form, allergens: e.target.value })} placeholder="milk, soy" />
            <div className="grid grid-cols-2 gap-2">
              <Input label="Country of origin" value={form.countryOfOrigin} onChange={(e) => setForm({ ...form, countryOfOrigin: e.target.value })} />
              <Input label="Low-stock alert at (units)" value={form.lowStockThreshold} onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })} />
            </div>
            <Input label="Product photo URL" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} />
            <Input label={`Label photo URL${p.requireLabelImage ? '' : ' — optional'}`} value={form.labelImageUrl} onChange={(e) => setForm({ ...form, labelImageUrl: e.target.value })} />
            <Input label={`Stop selling this many days before the date (blank = Gutad default: ${p.minRemainingDays[form.storage] ?? 0})`} value={form.minRemainingDays} onChange={(e) => setForm({ ...form, minRemainingDays: e.target.value })} />
            <p className="text-xs text-ink-500">Tax category: {p.categories[form.category].taxCategory}. {p.requireReview && p.categories[form.category].review ? 'Gutad checks the product before it goes on sale.' : 'Goes on sale as soon as it has stock.'}</p>
            <Button disabled={busy || !form.name || (!form.itemId && (!form.categoryId || !form.priceCents))} onClick={() => save(form)}>{form.itemId ? 'Save' : 'Create'}</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!receive} onClose={() => setReceive(null)} title={`Receive stock: ${receive?.name || ''}`}>
        {receive && (
          <div className="space-y-2">
            <Input label="Units received" type="number" value={receive.quantity} onChange={(e) => setReceive({ ...receive, quantity: e.target.value })} />
            {receive.dateType !== 'NONE' && <Input label={`${PACKAGED_DATE_LABELS[receive.dateType as 'BEST_BEFORE']} date printed on the pack`} type="date" value={receive.expiresOn} onChange={(e) => setReceive({ ...receive, expiresOn: e.target.value })} />}
            <Input label="Batch / lot code (optional: we make one)" value={receive.lotCode} onChange={(e) => setReceive({ ...receive, lotCode: e.target.value })} />
            <div className="grid grid-cols-2 gap-2"><Input label="Cost per unit (USD, optional)" value={receive.unitCost} onChange={(e) => setReceive({ ...receive, unitCost: e.target.value })} /><Input label="Supplier (optional)" value={receive.supplier} onChange={(e) => setReceive({ ...receive, supplier: e.target.value })} /></div>
            <Button disabled={busy || !Number(receive.quantity) || (receive.dateType !== 'NONE' && !receive.expiresOn)} onClick={() => act(async () => { await api.post(`/packaged/${receive.itemId}/lots`, { locationId: loc.id, quantity: Number(receive.quantity), expiresOn: receive.expiresOn || null, lotCode: receive.lotCode || undefined, unitCostCents: receive.unitCost ? Math.round(Number(receive.unitCost) * 100) : undefined, supplierName: receive.supplier || undefined }); setReceive(null); })}>Add batch</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!adjust} onClose={() => setAdjust(null)} title={`Adjust batch ${adjust?.lot.lotCode || ''}`}>
        {adjust && (
          <div className="space-y-2">
            <p className="text-xs text-ink-500">{adjust.name}: {adjust.lot.onHand} on the shelf, {adjust.lot.reserved} held for open orders.</p>
            <Select label="What happened" value={adjust.kind} onChange={(e) => setAdjust({ ...adjust, kind: e.target.value as LotAdjustKind, quantity: e.target.value === 'COUNT' ? String(adjust.lot.onHand) : '' })}>{LOT_ADJUST_KINDS.map((k) => <option key={k} value={k}>{LOT_ADJUST_LABELS[k]}</option>)}</Select>
            <Input label={adjust.kind === 'COUNT' ? 'Units counted on the shelf' : adjust.kind === 'ADJUSTMENT' ? 'Change (e.g. -2 or 3)' : 'Units'} type="number" value={adjust.quantity} onChange={(e) => setAdjust({ ...adjust, quantity: e.target.value })} />
            <Input label="Reason" value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
            <Button disabled={busy || adjust.quantity === '' || adjust.reason.length < 3} onClick={() => act(async () => { await api.post(`/packaged-lots/${adjust.lot.id}/adjust`, { kind: adjust.kind, quantity: Number(adjust.quantity), reason: adjust.reason }); setAdjust(null); })}>Save</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!recall} onClose={() => setRecall(null)} title="Recall">
        {recall && data && (
          <div className="space-y-2">
            <Select label="What to recall" value={recall.scope} onChange={(e) => setRecall({ ...recall, scope: e.target.value as 'LOT' })}><option value="LOT">Specific batches</option><option value="PRODUCT">Every batch of a product</option><option value="GTIN">Every product with a barcode</option></Select>
            {recall.scope !== 'GTIN' && <Select label="Product" value={recall.itemId} onChange={(e) => setRecall({ ...recall, itemId: e.target.value, lotIds: [] })}>{data.products.map((x) => <option key={x.itemId} value={x.itemId}>{x.name}</option>)}</Select>}
            {recall.scope === 'LOT' && <div className="space-y-1 text-sm">{(data.products.find((x) => x.itemId === recall.itemId)?.lots || []).map((l) => <label key={l.id} className="flex items-center gap-2"><input type="checkbox" checked={recall.lotIds.includes(l.id)} onChange={(e) => setRecall({ ...recall, lotIds: e.target.checked ? [...recall.lotIds, l.id] : recall.lotIds.filter((i) => i !== l.id) })} /><span className="font-mono">{l.lotCode}</span> {l.expiresOn} · {l.onHand} units</label>)}</div>}
            {recall.scope === 'GTIN' && <Input label="Barcode (GTIN/UPC/EAN)" value={recall.gtin} onChange={(e) => setRecall({ ...recall, gtin: e.target.value })} />}
            <Select label="Severity" value={recall.severity} onChange={(e) => setRecall({ ...recall, severity: e.target.value })}><option>LOW</option><option>HIGH</option><option>CRITICAL</option></Select>
            <Textarea label="Reason (customers who received it see this)" value={recall.reason} onChange={(e) => setRecall({ ...recall, reason: e.target.value })} />
            <Button disabled={busy || recall.reason.length < 5 || (recall.scope === 'LOT' && !recall.lotIds.length)} onClick={() => confirm('Recall now? This stops sales of the batches and notifies affected customers.') && act(async () => { await api.post(`/locations/${loc.id}/packaged/recalls`, { scope: recall.scope, lotIds: recall.scope === 'LOT' ? recall.lotIds : undefined, itemId: recall.scope !== 'GTIN' ? recall.itemId : undefined, gtin: recall.scope === 'GTIN' ? recall.gtin : undefined, reason: recall.reason, severity: recall.severity }); setRecall(null); await reloadRecalls(); setTab('recalls'); })}>Recall</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!moves} onClose={() => setMoves(null)} title={`Stock history: ${moves?.name || ''}`}>
        {moves && <Table rows={moves.rows} empty="No movements yet." cols={[{ key: 'd', label: 'When', render: (r) => new Date(r.createdAt).toLocaleString() }, { key: 'k', label: 'What', render: (r) => r.kind }, { key: 'q', label: 'Units', render: (r) => (r.quantity > 0 ? `+${r.quantity}` : r.quantity), className: 'text-right' }, { key: 'l', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.lotCode}</span> }, { key: 'r', label: 'Note', render: (r) => `${r.orderNumber ? `${r.orderNumber} · ` : ''}${r.reason || ''}` }]} />}
      </Modal>
    </div>
  );
}
