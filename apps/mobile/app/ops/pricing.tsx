import { ScrollView, Text, View } from 'react-native';
import type { CustomerFeeRules } from '@gutad/shared';
import { money, when } from '@/api';
import { useApi } from '@/hooks';
import { C, Card, Loading, Muted, s } from '@/ui';

interface Ov { commission: { plan: string; version: number; type: string; channel: string; fulfillment: string; bps: number; cents: number }[]; royalties: { id: string; name: string; royaltyBps: number; royaltyRules: unknown[] }[]; promotions: { code: string; funder: string; platformSharePct: number | null }[]; customerFees: CustomerFeeRules; scheduledPriceChanges: { id: string; newPriceCents: number; effectiveAt: string; status: string }[] }

/** Pricing at a glance: customer fees, commission and royalty schedules, promotion funding, upcoming price changes. Editing is on the web console. */
export default function OpsPricing() {
  const { data } = useApi<Ov>('/admin/pricing/overview');
  const { data: members } = useApi<{ id: string; name: string; priceCents: number; benefits: { serviceFeeWaived?: boolean; freeDeliveryAboveCents?: number; creditCentsPerMonth?: number } }[]>('/admin/membership-plans');
  if (!data) return <Loading />;
  const f = data.customerFees;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Customer fees">
        <Muted>Service fee {f.service.bps / 100}% (min {money(f.service.minCents)}, cap {money(f.service.capCents)}) · {f.service.channels.join(', ').toLowerCase() || 'all channels'} · {f.service.fulfillments.join(', ').toLowerCase() || 'all'}</Muted>
        <Muted>Small-order fee {f.smallOrder.thresholdCents ? `${money(f.smallOrder.feeCents)} under ${money(f.smallOrder.thresholdCents)}` : 'off'}</Muted>
        <Muted>Packaging {money(f.packaging.perOrderCents)} per order + {money(f.packaging.perItemCents)} per item</Muted>
      </Card>
      <Card title="Memberships">{members?.map((m) => <Muted key={m.id}>{m.name} {money(m.priceCents)} · {m.benefits.serviceFeeWaived ? 'no service fee · ' : ''}{m.benefits.freeDeliveryAboveCents !== undefined ? `free delivery over ${money(m.benefits.freeDeliveryAboveCents)} · ` : ''}{m.benefits.creditCentsPerMonth ? `${money(m.benefits.creditCentsPerMonth)} credit/month` : ''}</Muted>)}</Card>
      <Card title="Commission">{data.commission.slice(0, 20).map((c, i) => <View key={i} style={s.row}><Text style={{ color: C.ink, flex: 1 }}>{c.plan} · {c.channel.toLowerCase()}/{c.fulfillment.toLowerCase()}</Text><Text>{c.bps ? `${c.bps / 100}%` : ''}{c.cents ? ` ${money(c.cents)}` : ''}</Text></View>)}</Card>
      <Card title="Brand royalties">{data.royalties.map((r) => <Muted key={r.id}>{r.name}: {r.royaltyRules.length ? `${r.royaltyRules.length} rule(s)` : `${r.royaltyBps / 100}%`}</Muted>)}</Card>
      <Card title="Promotion funding">{data.promotions.slice(0, 15).map((p) => <Muted key={p.code}>{p.code}: {p.platformSharePct ? `platform ${p.platformSharePct}% / merchant ${100 - p.platformSharePct}%` : p.funder.toLowerCase()}</Muted>)}</Card>
      <Card title="Upcoming price changes">{data.scheduledPriceChanges.map((p) => <Muted key={p.id}>{money(p.newPriceCents)} from {when(p.effectiveAt)} · {p.status.toLowerCase()}</Muted>)}{!data.scheduledPriceChanges.length && <Muted>None.</Muted>}</Card>
      <Muted>Fee changes, tax rates and the price simulator are on the web console.</Muted>
    </ScrollView>
  );
}
