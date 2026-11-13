import { Linking, Text, View } from 'react-native';
import { money, when } from './api';
import { useApi } from './hooks';
import { Badge, Button, C, Card, Muted, s } from './ui';

/** Where merchants change plans. The app links out instead of selling plans in-app. */
export const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || 'https://gutad.io';
export const openBilling = () => Linking.openURL(`${WEB_URL}/merchant/billing`);

export interface Ent { source: 'PLAN' | 'LEGACY' | 'DEFAULT'; planName: string | null; unrestricted: boolean; features: Record<string, boolean>; limits: Record<string, { max: number | null; used: number }>; names: Record<string, string> }
export const allowed = (e: Ent | null | undefined, key: string) => !e || e.unrestricted || !!e.features[key];

export function useEntitlements(locationId: string | null | undefined) {
  return useApi<Ent>(locationId ? `/locations/${locationId}/entitlements` : null, { deps: [locationId] });
}

interface Billing {
  current: { name: string; legacy: boolean; subscriptionCents: number; interval: string } | null;
  subscription: { status: string; currentPeriodEnd: string; trialEndsAt: string | null } | null;
  scheduledChange: { name: string; effectiveFrom: string } | null;
  usage: { orders: { orders: number; commissionCents: number }[]; covers: number; coverFeeCents: number };
  nextInvoice: { date: string; totalCents: number } | null;
}
const STATUS: Record<string, string> = { TRIAL: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment overdue', PAUSED: 'Paused', CANCELED: 'Ended' };

/** Plan, status and this month's usage at a glance on the merchant screen. */
export function PlanSummary({ orgId }: { orgId: string | null | undefined }) {
  const { data: b } = useApi<Billing>(orgId ? `/organizations/${orgId}/billing` : null, { deps: [orgId] });
  if (!b) return null;
  const orders = b.usage.orders.reduce((a, r) => a + r.orders, 0);
  const commission = b.usage.orders.reduce((a, r) => a + r.commissionCents, 0);
  const sub = b.subscription;
  return (
    <Card>
      <View style={s.row}>
        <Text style={{ fontWeight: '700' }}>{b.current?.name || 'No plan yet'}</Text>
        {sub ? <Badge text={STATUS[sub.status] || sub.status} tone={sub.status === 'ACTIVE' || sub.status === 'TRIAL' ? 'good' : 'warn'} /> : b.current?.legacy ? <Badge text="All features" tone="info" /> : null}
      </View>
      <Muted>
        {b.current?.subscriptionCents ? `${money(b.current.subscriptionCents)}/${b.current.interval === 'YEAR' ? 'yr' : 'mo'}` : 'No subscription'}
        {sub && sub.status !== 'CANCELED' ? ` · ${sub.status === 'TRIAL' ? `trial ends ${when(sub.trialEndsAt)}` : `renews ${when(sub.currentPeriodEnd)}`}` : ''}
      </Muted>
      <Muted>This month: {orders} orders · {money(commission)} commission · {b.usage.covers} covers{b.nextInvoice ? ` · next invoice ${money(b.nextInvoice.totalCents)}` : ''}</Muted>
      {b.scheduledChange && <Text style={{ color: C.warn, marginTop: 4 }}>Switching to {b.scheduledChange.name} on {when(b.scheduledChange.effectiveFrom)}</Text>}
      {sub?.status === 'PAST_DUE' && <Text style={{ color: C.bad, marginTop: 4 }}>An invoice is overdue.</Text>}
      <View style={{ marginTop: 6 }}><Button title="Plan & billing" variant="ghost" onPress={openBilling} /></View>
    </Card>
  );
}

/** Shown instead of a screen whose feature isn't in the plan. */
export function Locked({ name, planName }: { name: string; planName?: string | null }) {
  return (
    <View style={[s.screen, s.pad, { justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ fontSize: 40 }}>🔒</Text>
      <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 8, textAlign: 'center' }}>{name} isn&apos;t in your plan</Text>
      <Text style={{ color: C.ink5, marginTop: 4, textAlign: 'center' }}>You&apos;re on {planName || 'the default plan'}. Switch plans or add it on the web.</Text>
      <View style={{ marginTop: 12 }}><Button title="See plans & add-ons" onPress={openBilling} /></View>
    </View>
  );
}
