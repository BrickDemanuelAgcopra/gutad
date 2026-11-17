import { ScrollView, View } from 'react-native';
import { money } from '@/api';
import { useApi } from '@/hooks';
import { Card, ErrorText, Loading, Muted, s } from '@/ui';
import { StatTile } from '@/ops';
import { AdjustmentRow, EarningsOrder, type Earnings } from '@/chef-ops';

/** Chef: payable balance, money held until orders complete, last 30 days, per-order earnings and adjustments. */
export default function ChefEarnings() {
  const { data, error } = useApi<Earnings>('/chef/earnings', { poll: 60000 });
  if (!data) return <View style={[s.screen, s.pad]}>{error ? <ErrorText msg={error} /> : <Loading />}</View>;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <ErrorText msg={error} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <StatTile label="Payable" value={money(data.payableCents)} hint="paid out weekly" />
        <StatTile label="Held until completion" value={money(data.heldCents)} hint={`${data.heldOrders} order${data.heldOrders === 1 ? '' : 's'}`} />
      </View>
      <View style={{ marginBottom: 12 }}><Muted>Customers pay when they order. Your share moves to payable once the order is completed.</Muted></View>
      <Card title="Last 30 days">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <StatTile label="Completed orders" value={data.last30.orders} />
          <StatTile label="Earned" value={money(data.last30.netCents)} hint={`food ${money(data.last30.foodCents)} · commission ${money(data.last30.commissionCents)}`} />
        </View>
      </Card>
      <Card title="Orders">
        {!data.orders.length ? <Muted>No orders yet.</Muted> : data.orders.map((o) => <EarningsOrder key={o.id} o={o} />)}
      </Card>
      <Card title="Adjustments">
        {!data.adjustments.length ? <Muted>No adjustments.</Muted> : data.adjustments.map((a) => <AdjustmentRow key={a.id} a={a} />)}
      </Card>
    </ScrollView>
  );
}
