import { Text, View } from 'react-native';
import { CHEF_DOC_STATE_LABELS, type ChefDocState } from '@gutad/shared';
import { money, when } from './api';
import { Badge, C, Muted } from './ui';

/** A required kitchen document and its state (GET /chef/compliance, /admin/chef-kitchens). */
export interface DocStatus { key: string; label: string; needsExpiry: boolean; state: ChefDocState; expiresAt: string | null; docId: string | null; pendingDocId: string | null; pendingFileId: string | null; note: string | null }

/** Chef earnings (GET /chef/earnings, /admin/chefs/:id/earnings). */
export interface Earnings {
  chefId: string;
  organizationId: string;
  displayName: string;
  payableCents: number;
  heldCents: number;
  heldOrders: number;
  last30: { orders: number; foodCents: number; commissionCents: number; netCents: number };
  orders: { id: string; number: string | number; status: string; createdAt: string; scheduledFor: string | null; foodCents: number; taxCents: number; commissionCents: number; netCents: number; state: 'HELD' | 'EARNED' | 'NONE'; recognizedAt: string | null }[];
  adjustments: { id: string; createdAt: string; memo: string; cents: number }[];
}

/** Per-chef quality metrics over a window (GET /admin/chef-quality, /admin/chefs/:id/quality). */
export interface ChefMetrics { chefId: string; displayName: string; slug: string; organizationId: string; status: string; statusCause: string | null; acceptingOrders: boolean; orders: number; completed: number; declined: number; unconfirmed: number; canceled: number; gmvCents: number; avgAcceptMinutes: number | null; incidents: number; foodSafety: number; incidentRatePct: number | null; declineRatePct: number | null; rating: number | null; ratings: number; requests: number; avgRequestResponseMinutes: number | null; flags: string[] }
export const FLAG_LABELS: Record<string, string> = { FOOD_SAFETY: 'Food safety', INCIDENT_RATE: 'Incident rate', DECLINE_RATE: 'Decline rate' };

export const DOC_TONE: Record<ChefDocState, 'good' | 'warn' | 'bad' | 'info'> = { VALID: 'good', EXPIRING: 'warn', EXPIRED: 'bad', MISSING: 'bad', IN_REVIEW: 'info', REJECTED: 'bad' };
export const NEEDS_RENEWAL: ChefDocState[] = ['EXPIRING', 'EXPIRED', 'REJECTED', 'MISSING'];

export const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
export const mins = (m: number | null | undefined) => (m === null || m === undefined ? '—' : m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`);
export const signed = (c: number) => `${c < 0 ? '−' : '+'}${money(Math.abs(c))}`;

export function DocBadge({ state }: { state: ChefDocState }) {
  return <Badge text={CHEF_DOC_STATE_LABELS[state] || state} tone={DOC_TONE[state] || 'neutral'} />;
}

/** One line per document: label, state, expiry. */
export function DocLine({ d }: { d: DocStatus }) {
  return (
    <View style={{ marginBottom: 6 }}>
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }]}><Text style={{ flex: 1, color: C.ink, fontSize: 13 }}>{d.label}</Text><DocBadge state={d.state} /></View>
      {d.expiresAt ? <Muted>{d.state === 'EXPIRED' ? 'Expired' : 'Expires'} {day(d.expiresAt)}</Muted> : null}
      {d.note ? <Text style={{ color: C.bad, fontSize: 12 }}>Reviewer: {d.note}</Text> : null}
    </View>
  );
}

const STATE_LABEL = { HELD: 'Held', EARNED: 'Earned', NONE: 'No earnings' } as const;
const STATE_TONE = { HELD: 'warn', EARNED: 'good', NONE: 'neutral' } as const;

/** Per-order earnings row. */
export function EarningsOrder({ o }: { o: Earnings['orders'][number] }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ flex: 1, fontWeight: '600', color: C.ink }}>#{o.number}</Text>
        <Badge text={STATE_LABEL[o.state]} tone={STATE_TONE[o.state]} />
        <Text style={{ fontWeight: '700', color: o.state === 'NONE' ? C.ink5 : C.ink }}>{money(o.netCents)}</Text>
      </View>
      <Muted>{when(o.scheduledFor || o.createdAt)} · {o.status.toLowerCase().replace(/_/g, ' ')}</Muted>
      {o.state !== 'NONE' && <Muted>Food {money(o.foodCents)} + tax {money(o.taxCents)} − commission {money(o.commissionCents)}</Muted>}
    </View>
  );
}

export function AdjustmentRow({ a }: { a: Earnings['adjustments'][number] }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8, flexDirection: 'row', gap: 8 }}>
      <View style={{ flex: 1 }}><Text style={{ color: C.ink }}>{a.memo || 'Adjustment'}</Text><Muted>{when(a.createdAt)}</Muted></View>
      <Text style={{ fontWeight: '700', color: a.cents < 0 ? C.bad : C.good }}>{signed(a.cents)}</Text>
    </View>
  );
}
