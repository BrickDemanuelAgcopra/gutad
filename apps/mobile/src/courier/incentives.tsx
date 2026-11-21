import { useState } from 'react';
import { Text, View } from 'react-native';
import { CAMPAIGN_KIND_LABELS, type CampaignKind } from '@gutad/shared';
import { api, money, when } from '../api';
import { useAction, useApi } from '../hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted } from '../ui';

// Courier Release 3 (mobile): busy times, incentives, instant cash-out, payout hold and review notices.

interface Busy { zoneId: string; zoneName: string; hourStart: string; gapCouriers: number; campaignName: string | null }
interface Campaign {
  id: string; kind: CampaignKind; name: string; description: string | null; status: string; windowStart: string; windowEnd: string; zones: { id: string; name: string }[]; terms: string;
  enrolled: boolean; eligible: boolean; ineligibleReason: string | null; budgetLeft: boolean;
  progress: { deliveries: number; onlineMinutes: number | null; earnedCents: number | null; targetDeliveries: number | null; nextTier: { deliveries: number; bonusCents: number } | null; estimatedPayoutCents: number } | null;
}
interface Instant { enabled: boolean; availableCents: number; feeCents: number; minCents: number; remainingToday: { count: number; cents: number }; blockedReason: string | null; recent: { id: string; amountCents: number; feeCents: number; status: string; createdAt: string }[] }
interface Notices { hold: boolean; holdMessage: string | null; notices: { decision: string; notice: string; decidedAt: string }[] }

const hour = (d: string) => new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric' });

export function BusyTimes() {
  const { data } = useApi<Busy[]>('/driver/busy-times?days=3');
  return (
    <Card title="Busy times ahead">
      {!data?.length ? <Muted>No busy times expected in the next 3 days.</Muted> : data.slice(0, 8).map((b) => (
        <View key={`${b.zoneId}${b.hourStart}`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ fontWeight: '700', color: C.ink }}>{hour(b.hourStart)}</Text><Text style={{ color: C.ink7 }}>{b.zoneName}</Text>
          <Badge text={`~${Math.ceil(b.gapCouriers)} more needed`} tone="warn" />{b.campaignName && <Badge text={b.campaignName} tone="good" />}
        </View>
      ))}
      <Muted>Based on past demand. Book a shift or go online then for more offers.</Muted>
    </Card>
  );
}

function progressText(c: Campaign) {
  const p = c.progress;
  if (!p) return null;
  if (c.kind === 'QUEST') { const t = p.nextTier?.deliveries ?? p.targetDeliveries ?? 1; return `${p.deliveries} of ${t} deliveries${p.estimatedPayoutCents ? ` · ${money(p.estimatedPayoutCents)} so far` : ''}${p.nextTier ? ` · next ${money(p.nextTier.bonusCents)}` : ''}`; }
  if (c.kind === 'GUARANTEE') return `${Math.round(p.onlineMinutes ?? 0)} min online · ${money(p.earnedCents ?? 0)} earned · top-up ${money(p.estimatedPayoutCents)}`;
  return `${p.deliveries} boosted · ${money(p.earnedCents ?? 0)} extra`;
}

export function Incentives() {
  const { data, reload } = useApi<Campaign[]>('/driver/campaigns');
  const { run, error, busy } = useAction();
  const live = (data ?? []).filter((c) => c.status !== 'ENDED');
  return (
    <Card title="Incentives">
      <ErrorText msg={error} />
      {!live.length && <Muted>No incentives running right now.</Muted>}
      {live.map((c) => (
        <View key={c.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: C.ink1 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><Text style={{ fontWeight: '700', color: C.ink }}>{c.name}</Text><Badge text={CAMPAIGN_KIND_LABELS[c.kind]} tone="info" />{c.status === 'SCHEDULED' && <Badge text="starts soon" />}{!c.budgetLeft && <Badge text="fully used" tone="warn" />}</View>
          <Text style={{ color: C.ink7 }}>{c.terms}</Text>
          <Muted>{when(c.windowStart)} – {when(c.windowEnd)}{c.zones.length ? ` · ${c.zones.map((z) => z.name).join(', ')}` : ''}</Muted>
          {!c.eligible ? <Muted>Not available to you: {c.ineligibleReason}</Muted>
            : !c.enrolled ? <Button title="Join" disabled={busy} onPress={() => run(async () => { await api.post(`/driver/campaigns/${c.id}/join`, {}); await reload(); })} />
            : <Text style={{ color: C.good }}>{progressText(c)}</Text>}
        </View>
      ))}
    </Card>
  );
}

export function CashOut({ onDone }: { onDone: () => void }) {
  const { data, reload } = useApi<Instant>('/driver/payouts/instant');
  const { run, error, busy } = useAction();
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  if (!data?.enabled) return null;
  const cents = amount ? Math.round(Number(amount) * 100) : data.availableCents;
  const max = Math.min(data.availableCents, data.remainingToday.cents);
  return (
    <Card title="Cash out now">
      <Muted>{money(data.availableCents)} available · fee {money(data.feeCents)} · {data.remainingToday.count} left today</Muted>
      {done && <Text style={{ color: C.good }}>{done}</Text>}
      <ErrorText msg={error} />
      {data.blockedReason ? <Muted>{data.blockedReason}.</Muted> : <>
        <Input label="Amount ($)" keyboardType="decimal-pad" placeholder={(max / 100).toFixed(2)} value={amount} onChangeText={setAmount} />
        <Button title={`Cash out ${money(Math.max(0, cents - data.feeCents))}`} disabled={busy || cents < data.minCents || cents > max} onPress={() => run(async () => { const r = await api.post<{ amountCents: number; status: string; failureReason: string | null }>('/driver/payouts/instant', { amountCents: cents }); setDone(r.status === 'FAILED' ? `Transfer failed: ${r.failureReason}. Nothing was taken.` : `${money(r.amountCents)} is on its way.`); setAmount(''); await reload(); onDone(); })} />
      </>}
    </Card>
  );
}

export function ReviewNotices() {
  const { data } = useApi<Notices>('/driver/notices');
  if (!data) return null;
  const recent = data.notices.filter((n) => Date.now() - new Date(n.decidedAt).getTime() < 14 * 86_400_000);
  if (!data.hold && !recent.length) return null;
  return (
    <Card>
      {data.hold && <Text style={{ color: C.warn }}>{data.holdMessage}</Text>}
      {recent.map((n, i) => <Text key={i} style={{ color: C.ink7, marginTop: 4 }}>{n.notice}</Text>)}
    </Card>
  );
}
