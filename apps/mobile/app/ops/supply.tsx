import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { money } from '@/api';
import { useApi } from '@/hooks';
import { Badge, C, Card, Loading, Muted, s } from '@/ui';

interface K { id: string; name: string; organization: string }
interface Rpt { valuationCents: number; expiringIn3DaysCents: number; wasteCents: number; forecastAccuracyPct: number | null; suppliers: { supplier: string; onTimePct: number | null; fillRatePct: number | null; invoiceVariances: number }[] }

/** Supply on the phone: per kitchen value, expiring stock, waste, reorder needs and supplier performance (read-only; ordering is on the web). */
export default function OpsSupply() {
  const { data: ks } = useApi<K[]>('/admin/kitchens');
  const [open, setOpen] = useState<string | null>(null);
  const { data: rpt } = useApi<Rpt>(open ? `/kitchens/${open}/inventory/reports` : null, { deps: [open] });
  const { data: fc } = useApi<{ name: string; needsReorder: boolean; daysOfCover: number | null; proposedPurchaseUnits: number; purchaseUnit: string | null; unit: string }[]>(open ? `/kitchens/${open}/forecast` : null, { deps: [open] });
  if (!ks) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {ks.map((k) => (
        <Card key={k.id}>
          <Pressable onPress={() => setOpen(open === k.id ? null : k.id)}><Text style={{ fontWeight: '700', color: C.ink }}>{k.name}</Text><Muted>{k.organization} · tap for stock</Muted></Pressable>
          {open === k.id && rpt && (
            <View style={{ marginTop: 6 }}>
              <Text>Value {money(rpt.valuationCents)} · expiring in 3 days {money(rpt.expiringIn3DaysCents)} · waste 30d {money(rpt.wasteCents)}</Text>
              <Muted>Forecast accuracy {rpt.forecastAccuracyPct ?? '—'}%</Muted>
              <Text style={{ marginTop: 6, fontWeight: '600' }}>Needs reorder</Text>
              {fc?.filter((x) => x.needsReorder).slice(0, 10).map((x) => <View key={x.name} style={s.row}><Text>{x.name}</Text><Badge text={`${x.proposedPurchaseUnits} ${x.purchaseUnit || x.unit}`} tone="warn" /></View>)}
              {!fc?.some((x) => x.needsReorder) && <Muted>Nothing below its reorder point.</Muted>}
              <Text style={{ marginTop: 6, fontWeight: '600' }}>Suppliers</Text>
              {rpt.suppliers.map((sp) => <Muted key={sp.supplier}>{sp.supplier}: on time {sp.onTimePct ?? '—'}% · fill {sp.fillRatePct ?? '—'}% · {sp.invoiceVariances} invoice variance(s)</Muted>)}
            </View>
          )}
        </Card>
      ))}
      <Muted>Purchase orders, receiving and transfers are on the web console and in the kitchen app.</Muted>
    </ScrollView>
  );
}
