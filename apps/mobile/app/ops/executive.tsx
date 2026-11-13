import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { money } from '@/api';
import { useApi } from '@/hooks';
import { C, Card, Loading, Muted, s } from '@/ui';
import { Pills, StatTile } from '@/ops';

interface M { orders: number; completed: number; canceled: number; rejected: number; cancellationRate: number; grossSalesCents: number; foodSalesCents: number; refundsCents: number; aovCents: number; platformRevenueCents: number; merchantPayableCents: number }
interface Row { key: string | null; label: string; orders: number; salesCents: number; aovCents: number }
const DAYS: Record<string, number> = { today: 0, '7d': 7, '30d': 30 };
const change = (c: number, p: number) => (p ? `${c >= p ? '▲' : '▼'} ${Math.abs(((c - p) / p) * 100).toFixed(0)}% vs previous` : undefined);

/** Executive dashboard on the phone: headline numbers, separate revenue lines, contribution and top performers. */
export default function OpsExecutive() {
  const router = useRouter();
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d');
  const [dim, setDim] = useState<'location' | 'merchant' | 'brand' | 'channel' | 'region'>('location');
  const now = new Date();
  const from = range === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime() - DAYS[range] * 86400_000);
  const q = `from=${encodeURIComponent(from.toISOString())}`;
  const { data } = useApi<{ current: M; previous: M }>(`/admin/ops/executive?${q}`, { deps: [q] });
  const { data: rows } = useApi<Row[]>(`/admin/ops/breakdown?dim=${dim}&${q}`, { deps: [q, dim] });
  const { data: cm } = useApi<{ orders: number; average: Record<string, number>; marginPct: number }>(`/admin/ops/contribution?${q}`, { deps: [q] });
  const c = data?.current, p = data?.previous;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={range} onChange={setRange} options={[{ id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }]} />
      {!c ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatTile label="Orders" value={c.orders} hint={change(c.orders, p?.orders || 0)} />
            <StatTile label="Gross sales" value={money(c.grossSalesCents)} hint={change(c.grossSalesCents, p?.grossSalesCents || 0)} />
            <StatTile label="Average order" value={money(c.aovCents)} />
            <StatTile label="Refunds" value={money(c.refundsCents)} />
            <StatTile label="Canceled / rejected" value={`${(c.cancellationRate * 100).toFixed(1)}%`} hint={`${c.canceled} + ${c.rejected}`} />
            <StatTile label="Food sales" value={money(c.foodSalesCents)} />
            <StatTile label="Platform revenue" value={money(c.platformRevenueCents)} />
            <StatTile label="Merchant payable" value={money(c.merchantPayableCents)} />
          </View>
          {cm && cm.orders > 0 && (
            <Card title="Contribution per order" style={{ marginTop: 12 }}>
              {[['Revenue', 'revenueCents'], ['Food', 'foodCents'], ['Labor', 'laborCents'], ['Delivery', 'deliveryCents'], ['Processing', 'processingCents'], ['Promotions', 'promotionsCents']].map(([l, k]) => <View key={k} style={s.row}><Muted>{l}</Muted><Text style={{ color: C.ink }}>{k === 'revenueCents' ? '' : '−'}{money(cm.average[k])}</Text></View>)}
              <View style={[s.row, { marginTop: 6 }]}><Text style={{ fontWeight: '700' }}>Contribution</Text><Text style={{ fontWeight: '700' }}>{money(cm.average.contributionCents)} ({(cm.marginPct * 100).toFixed(1)}%)</Text></View>
            </Card>
          )}
          <Card title="Performance" style={{ marginTop: cm?.orders ? 0 : 12 }}>
            <Pills value={dim} onChange={setDim} options={[{ id: 'location', label: 'Location' }, { id: 'merchant', label: 'Merchant' }, { id: 'brand', label: 'Brand' }, { id: 'region', label: 'Region' }, { id: 'channel', label: 'Channel' }]} />
            {(rows || []).slice(0, 10).map((r) => {
              const max = Math.max(1, ...(rows || []).map((x) => x.salesCents));
              const param = { location: 'locationId', merchant: 'organizationId', brand: 'brandId', region: 'regionId', channel: 'channel' }[dim];
              return (
                <Pressable key={String(r.key)} onPress={() => router.push(`/ops/orders?${q}${r.key && r.key !== 'none' ? `&${param}=${r.key}` : ''}` as never)} style={{ marginBottom: 8 }}>
                  <View style={s.row}><Text style={{ color: C.ink, flex: 1 }} numberOfLines={1}>{r.label}</Text><Text style={{ color: C.ink }}>{money(r.salesCents)}</Text></View>
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: C.ink1, marginTop: 3 }}><View style={{ height: 8, borderRadius: 4, backgroundColor: C.brand, width: `${Math.max(2, (r.salesCents / max) * 100)}%` }} /></View>
                  <Muted>{r.orders} orders · AOV {money(r.aovCents)}</Muted>
                </Pressable>
              );
            })}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
