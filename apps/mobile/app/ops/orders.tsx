import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { money, when } from '@/api';
import { useApi } from '@/hooks';
import { Badge, Button, C, Card, Input, Loading, Muted, s, tone } from '@/ui';

interface Row { id: string; number: string; status: string; locationName?: string; totalCents: number; createdAt: string; partialFulfillment: boolean; deliveryStatus: string | null; paymentStatus: string | null; customer: { name: string | null; email: string | null } }

/** Order search: number, transaction id, customer; dashboard drill-downs arrive with their filter. */
export default function OpsOrders() {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const base = Object.entries(params).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&');
  const [term, setTerm] = useState('');
  const [cust, setCust] = useState('');
  const [q, setQ] = useState(base);
  const { data, loading } = useApi<{ total: number; items: Row[] }>(`/admin/orders?${q}&limit=50`, { deps: [q] });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card>
        <Input label="Order #, payment or job id" autoCapitalize="none" value={term} onChangeText={setTerm} />
        <Input label="Customer name, email or phone" autoCapitalize="none" value={cust} onChangeText={setCust} />
        <Button title="Search" onPress={() => setQ([base, term && `q=${encodeURIComponent(term)}`, cust && `customer=${encodeURIComponent(cust)}`].filter(Boolean).join('&'))} />
        {data && <Muted>{data.total} orders</Muted>}
      </Card>
      {loading && !data && <Loading />}
      {data?.items.map((o) => (
        <Pressable key={o.id} onPress={() => router.push(`/ops/order/${o.id}` as never)}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink }}>{o.number}</Text><Text>{money(o.totalCents)}</Text></View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}><Badge text={o.status} tone={tone(o.status)} />{o.partialFulfillment && <Badge text="PARTIAL" tone="warn" />}{o.paymentStatus && <Badge text={o.paymentStatus} />}{o.deliveryStatus && <Badge text={o.deliveryStatus} tone={tone(o.deliveryStatus)} />}</View>
            <Muted>{o.locationName} · {o.customer.name || o.customer.email || 'guest'} · {when(o.createdAt)}</Muted>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}
