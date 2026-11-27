import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { PACKAGED_REVIEW_LABELS, PACKAGED_STORAGE_LABELS, type PackagedReviewStatus } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills, StatTile, WorkspaceGate } from '@/ops';

interface Lot { id: string; lotCode: string; expiresOn: string | null; sellBy: string | null; onHand: number; reserved: number; status: string }
interface Product { itemId: string; name: string; priceCents: number; size: string | null; available: number; onHand: number; reserved: number; lowStock: boolean; nextExpiry: string | null; gate: string | null; lots: Lot[]; product: { storage: string; dateType: string; reviewStatus: PackagedReviewStatus; brandName: string | null } }
interface View_ { products: Product[]; expiringSoon: { lotId: string; name: string; lotCode: string; sellBy: string; units: number; pastSellBy: boolean }[]; toRemove: { lotId: string; name: string; lotCode: string; status: string; units: number }[]; policy: { enabled: boolean } }

/** Packaged products on the phone: stock per product, receive a batch, count or record waste, expiring and to-remove lists. */
function Products() {
  const { loc } = useMerchantLocation();
  const { data, reload } = useApi<View_>(loc ? `/locations/${loc.id}/packaged` : null, { deps: [loc?.id] });
  const { run, error } = useAction();
  const [tab, setTab] = useState<'stock' | 'expiry'>('stock');
  const [open, setOpen] = useState<string | null>(null);
  const [rx, setRx] = useState<{ itemId: string; qty: string; date: string; code: string } | null>(null);
  const [count, setCount] = useState<{ lotId: string; qty: string; kind: 'COUNT' | 'WASTE' } | null>(null);
  if (!loc || !data) return <Loading />;
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {!data.policy.enabled && <Card><Muted>Gutad has paused packaged goods. Your products show as sold out for now.</Muted></Card>}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <StatTile label="For sale" value={data.products.reduce((a, x) => a + x.available, 0)} />
        <StatTile label="Expiring" value={data.expiringSoon.length} />
        <StatTile label="To remove" value={data.toRemove.length} />
      </View>
      <Pills value={tab} onChange={setTab} options={[{ id: 'stock', label: 'Stock' }, { id: 'expiry', label: 'Expiring & remove' }]} />
      <ErrorText msg={error} />
      {tab === 'stock' && data.products.map((x) => (
        <Card key={x.itemId}>
          <Pressable onPress={() => setOpen(open === x.itemId ? null : x.itemId)}>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{x.name}</Text><Badge text={x.available === 0 ? 'SOLD OUT' : x.lowStock ? `LOW · ${x.available}` : `${x.available} FOR SALE`} tone={x.available === 0 ? 'bad' : x.lowStock ? 'warn' : 'good'} /></View>
            <Muted>{[x.product.brandName, x.size, PACKAGED_STORAGE_LABELS[x.product.storage as 'AMBIENT'], money(x.priceCents)].filter(Boolean).join(' · ')}</Muted>
            <Muted>{x.onHand} on shelf · {x.reserved} held{x.nextExpiry ? ` · next date ${x.nextExpiry}` : ''}</Muted>
            {x.product.reviewStatus !== 'APPROVED' && <Text style={{ color: C.warn }}>{PACKAGED_REVIEW_LABELS[x.product.reviewStatus]}</Text>}
          </Pressable>
          {open === x.itemId && (
            <View style={{ marginTop: 6 }}>
              {x.lots.map((l) => (
                <View key={l.id} style={{ borderTopWidth: 1, borderColor: C.ink1, paddingVertical: 4 }}>
                  <Text style={{ color: C.ink7 }}>{l.lotCode} · {l.expiresOn || 'no date'} · {l.onHand} on shelf ({l.reserved} held) · {l.status}</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}><Button title="Count" variant="ghost" onPress={() => setCount({ lotId: l.id, qty: String(l.onHand), kind: 'COUNT' })} /><Button title="Waste" variant="ghost" onPress={() => setCount({ lotId: l.id, qty: '', kind: 'WASTE' })} /></View>
                </View>
              ))}
              <Button title="Receive a batch" onPress={() => setRx({ itemId: x.itemId, qty: '', date: '', code: '' })} />
            </View>
          )}
          {rx?.itemId === x.itemId && (
            <View style={{ marginTop: 6 }}>
              <Input label="Units" keyboardType="number-pad" value={rx.qty} onChangeText={(v) => setRx({ ...rx, qty: v })} />
              {x.product.dateType !== 'NONE' && <Input label="Date on the pack (YYYY-MM-DD)" value={rx.date} onChangeText={(v) => setRx({ ...rx, date: v })} autoCapitalize="none" />}
              <Input label="Batch code (optional)" value={rx.code} onChangeText={(v) => setRx({ ...rx, code: v })} autoCapitalize="characters" />
              <Button title="Add batch" disabled={!Number(rx.qty)} onPress={() => act(async () => { await api.post(`/packaged/${x.itemId}/lots`, { locationId: loc.id, quantity: Number(rx.qty), expiresOn: rx.date || null, lotCode: rx.code || undefined }); setRx(null); })} />
            </View>
          )}
          {count && x.lots.some((l) => l.id === count.lotId) && (
            <View style={{ marginTop: 6 }}>
              <Input label={count.kind === 'COUNT' ? 'Units counted on the shelf' : 'Units thrown away'} keyboardType="number-pad" value={count.qty} onChangeText={(v) => setCount({ ...count, qty: v })} />
              <Button title="Save" disabled={count.qty === ''} onPress={() => act(async () => { await api.post(`/packaged-lots/${count.lotId}/adjust`, { kind: count.kind, quantity: Number(count.qty), reason: count.kind === 'COUNT' ? 'Shelf count (app)' : 'Waste recorded (app)' }); setCount(null); })} />
            </View>
          )}
        </Card>
      ))}
      {tab === 'stock' && !data.products.length && <Card><Muted>No packaged products yet. Add them on the web portal (Packaged products).</Muted></Card>}
      {tab === 'expiry' && (
        <>
          {data.toRemove.map((r) => <Card key={r.lotId} title={r.name}><Muted>{r.lotCode} · {r.status === 'RECALLED' ? 'recalled' : 'past sell-by'} · {r.units} units</Muted><Button title="Record removal" variant="secondary" onPress={() => act(() => api.post(`/packaged-lots/${r.lotId}/adjust`, { kind: 'WASTE', quantity: r.units, reason: r.status === 'RECALLED' ? 'Recalled batch removed' : 'Past sell-by, disposed' }))} /></Card>)}
          {data.expiringSoon.map((r) => <Card key={r.lotId} title={r.name}><Muted>{r.lotCode} · sells until {r.sellBy} · {r.units} units</Muted></Card>)}
          {!data.toRemove.length && !data.expiringSoon.length && <Card><Muted>Nothing near its date.</Muted></Card>}
        </>
      )}
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/products"><Products /></WorkspaceGate>;
}
