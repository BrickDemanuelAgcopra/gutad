import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { money } from '@/api';
import { useApi, useSession } from '@/hooks';
import { C, Card, ErrorText, Loading, Muted, s } from '@/ui';
import { Pills, StatTile } from '@/ops';
import { mins, pct } from '@/chef-ops';

interface Analytics {
  days: number;
  funnel: { started: number; submitted: number; approved: number; payoutsConnected: number; liveDish: number; firstOrder: number; activeInWindow: number };
  orders: { placed: number; completed: number; gmvCents: number; foodCents: number; customers: number; multiChefOrders: number; avgLeadDays: number | null };
  margin: { commissionCents: number; customerFeesCents: number; gutadRevenueCents: number; takeRatePct: number | null };
  fulfilment: { declinedPct: number | null; unconfirmedPct: number | null; canceledPct: number | null; avgAcceptMinutes: number | null };
  requests: { total: number; quoted: number; ordered: number; expired: number; declined: number; escalated: number; avgResponseMinutes: number | null; quoteToOrderPct: number | null };
  repeat: { buyers: number; repeaters: number; repeatPct: number | null };
  daily: { day: string; orders: number; gmvCents: number }[];
  modifiers: { name: string; count: number }[];
  topDishes: { name: string; chef: string; portions: number; revenueCents: number }[];
  topChefs: { chefId: string; displayName: string; orders: number; gmvCents: number; rating: number | null; declineRatePct: number | null; incidentRatePct: number | null }[];
}
type D = '30' | '90';

function Tiles({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

/** Simple horizontal bar row. */
function Bar({ label, value, max, right }: { label: string; value: number; max: number; right: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <Text style={{ width: 92, color: C.ink7, fontSize: 12 }} numberOfLines={1}>{label}</Text>
      <View style={{ flex: 1, height: 10, backgroundColor: C.ink1, borderRadius: 5, overflow: 'hidden' }}>
        <View style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, height: 10, backgroundColor: C.brand, borderRadius: 5 }} />
      </View>
      <Text style={{ width: 64, textAlign: 'right', color: C.ink, fontSize: 12 }}>{right}</Text>
    </View>
  );
}

function Row({ title, sub, right }: { title: string; sub?: string; right: string }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8, flexDirection: 'row', gap: 8 }}>
      <View style={{ flex: 1 }}><Text style={{ color: C.ink, fontWeight: '600' }}>{title}</Text>{sub ? <Muted>{sub}</Muted> : null}</View>
      <Text style={{ color: C.ink, fontWeight: '700' }}>{right}</Text>
    </View>
  );
}

/** Gutad staff: Chef Network dashboard. */
export default function OpsChefAnalytics() {
  const { isStaff, ready } = useSession();
  const [d, setD] = useState<D>('30');
  const { data, error } = useApi<Analytics>(isStaff ? `/admin/chef-network/analytics?days=${d}` : null, { deps: [d, isStaff] });
  if (!ready) return null;
  if (!isStaff) return <View style={[s.screen, s.pad]}><Card title="Chef Network analytics"><Muted>For Gutad staff only.</Muted></Card></View>;
  const maxDay = data ? Math.max(0, ...data.daily.map((x) => x.orders)) : 0;
  const maxMod = data ? Math.max(0, ...data.modifiers.map((x) => x.count)) : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={d} onChange={setD} options={[{ id: '30', label: 'Last 30 days' }, { id: '90', label: 'Last 90 days' }]} />
      <ErrorText msg={error} />
      {!data ? (error ? null : <Loading />) : (
        <>
          <Card title="Chef activation">
            <Tiles>
              <StatTile label="Applications started" value={data.funnel.started} hint={`${data.funnel.submitted} submitted`} />
              <StatTile label="Approved" value={data.funnel.approved} hint={`${data.funnel.payoutsConnected} with payouts`} />
              <StatTile label="With a live dish" value={data.funnel.liveDish} />
              <StatTile label="First order done" value={data.funnel.firstOrder} hint={`${data.funnel.activeInWindow} active in window`} />
            </Tiles>
          </Card>
          <Card title="Orders">
            <Tiles>
              <StatTile label="Placed" value={data.orders.placed} hint={`${data.orders.completed} completed`} />
              <StatTile label="GMV" value={money(data.orders.gmvCents)} hint={`food ${money(data.orders.foodCents)}`} />
              <StatTile label="Customers" value={data.orders.customers} hint={`${data.orders.multiChefOrders} multi-chef orders`} />
              <StatTile label="Ordered ahead" value={data.orders.avgLeadDays === null ? '—' : `${data.orders.avgLeadDays} d`} hint="average" />
            </Tiles>
          </Card>
          <Card title="Gutad margin">
            <Tiles>
              <StatTile label="Gutad revenue" value={money(data.margin.gutadRevenueCents)} hint={`take rate ${pct(data.margin.takeRatePct)}`} />
              <StatTile label="Commission" value={money(data.margin.commissionCents)} hint={`fees ${money(data.margin.customerFeesCents)}`} />
            </Tiles>
          </Card>
          <Card title="Fulfilment">
            <Tiles>
              <StatTile label="Declined" value={pct(data.fulfilment.declinedPct)} />
              <StatTile label="Unconfirmed" value={pct(data.fulfilment.unconfirmedPct)} />
              <StatTile label="Canceled" value={pct(data.fulfilment.canceledPct)} />
              <StatTile label="Time to accept" value={mins(data.fulfilment.avgAcceptMinutes)} hint="average" />
            </Tiles>
          </Card>
          <Card title="Special requests">
            <Tiles>
              <StatTile label="Requests" value={data.requests.total} hint={`${data.requests.escalated} escalated`} />
              <StatTile label="Quoted" value={data.requests.quoted} hint={`${data.requests.ordered} ordered · ${pct(data.requests.quoteToOrderPct)}`} />
              <StatTile label="Expired / declined" value={`${data.requests.expired} / ${data.requests.declined}`} />
              <StatTile label="First reply" value={mins(data.requests.avgResponseMinutes)} hint="average" />
            </Tiles>
          </Card>
          <Card title="Repeat customers">
            <Tiles>
              <StatTile label="Repeat rate" value={pct(data.repeat.repeatPct)} hint={`${data.repeat.repeaters} of ${data.repeat.buyers} buyers, all time`} />
            </Tiles>
          </Card>
          <Card title="Daily orders">
            {!data.daily.length ? <Muted>No orders in this window.</Muted> : data.daily.map((x) => <Bar key={x.day} label={x.day.slice(5)} value={x.orders} max={maxDay} right={`${x.orders} · ${money(x.gmvCents).replace(/\.\d\d$/, '')}`} />)}
          </Card>
          <Card title="Top dishes">
            {!data.topDishes.length ? <Muted>No dishes sold yet.</Muted> : data.topDishes.map((x, i) => <Row key={`${x.name}-${x.chef}-${i}`} title={x.name} sub={`${x.chef} · ${x.portions} portions`} right={money(x.revenueCents)} />)}
          </Card>
          <Card title="Top chefs">
            {!data.topChefs.length ? <Muted>No chef orders yet.</Muted> : data.topChefs.map((x) => <Row key={x.chefId} title={x.displayName} sub={`${x.orders} orders · declined ${pct(x.declineRatePct)} · incidents ${pct(x.incidentRatePct)}${x.rating !== null ? ` · ${x.rating} ★` : ''}`} right={money(x.gmvCents)} />)}
          </Card>
          <Card title="Popular options">
            {!data.modifiers.length ? <Muted>No options chosen yet.</Muted> : data.modifiers.map((x) => <Bar key={x.name} label={x.name} value={x.count} max={maxMod} right={String(x.count)} />)}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
