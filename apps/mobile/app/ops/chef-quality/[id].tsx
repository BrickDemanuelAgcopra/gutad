import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { CHEF_QUALITY_ACTIONS, CHEF_QUALITY_EVENT_LABELS, type ChefQualityAction } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills, StatTile } from '@/ops';
import { AdjustmentRow, FLAG_LABELS, mins, pct, signed, type ChefMetrics, type Earnings } from '@/chef-ops';

interface Detail {
  metrics: ChefMetrics;
  events: { id: string; kind: string; label: string; source: string; note: string; chefDishId: string | null; createdAt: string }[];
  dishes: { id: string; dishName: string; reviewStatus: string }[];
}
const DISH_ACTIONS: ChefQualityAction[] = ['DISH_SUSPENDED', 'DISH_REINSTATED'];

/** Gutad staff: one chef's quality metrics, record, earnings, and staff actions. */
export default function OpsChefQualityDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isStaff, ready, can } = useSession();
  const { data, setData, error } = useApi<Detail>(isStaff && id ? `/admin/chefs/${id}/quality` : null, { deps: [isStaff, id] });
  const { data: earn, error: earnErr, reload: reloadEarn } = useApi<Earnings>(isStaff && id ? `/admin/chefs/${id}/earnings` : null, { deps: [isStaff, id] });
  if (!ready) return null;
  if (!isStaff) return <View style={[s.screen, s.pad]}><Card title="Chef quality"><Muted>For Gutad staff only.</Muted></Card></View>;
  if (!data) return <View style={[s.screen, s.pad]}>{error ? <ErrorText msg={error} /> : <Loading />}</View>;
  const m = data.metrics;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Stack.Screen options={{ title: m.displayName }} />
      <Card>
        <View style={[s.row, { gap: 6, flexWrap: 'wrap' }]}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.ink, flex: 1 }}>{m.displayName}</Text>
          <Badge text={m.status} tone={m.status === 'ACTIVE' ? 'good' : 'bad'} />
        </View>
        {m.flags.length > 0 && <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>{m.flags.map((f) => <Badge key={f} text={FLAG_LABELS[f] || f} tone="bad" />)}</View>}
        <Muted>{m.acceptingOrders ? 'Accepting orders' : 'Not accepting orders'}{m.statusCause ? ` · paused for ${m.statusCause.toLowerCase()}` : ''}</Muted>
      </Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <StatTile label="Orders" value={m.orders} hint={`${m.completed} completed · ${money(m.gmvCents)}`} />
        <StatTile label="Declined" value={pct(m.declineRatePct)} hint={`${m.declined} declined · ${m.unconfirmed} unconfirmed`} />
        <StatTile label="Incidents" value={pct(m.incidentRatePct)} hint={`${m.incidents} total · ${m.foodSafety} food safety`} />
        <StatTile label="Canceled" value={m.canceled} />
        <StatTile label="Time to accept" value={mins(m.avgAcceptMinutes)} />
        <StatTile label="Rating" value={m.rating === null ? '—' : `${m.rating} ★`} hint={`${m.ratings} ratings`} />
        <StatTile label="Requests" value={m.requests} hint={`reply in ${mins(m.avgRequestResponseMinutes)}`} />
      </View>
      {can('chefs.manage') && <ActionForm chefId={m.chefId} dishes={data.dishes} onDone={setData} />}
      <Card title="Quality record">
        {!data.events.length ? <Muted>Nothing recorded yet.</Muted> : data.events.map((e) => (
          <View key={e.id} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
            <Text style={{ fontWeight: '600', color: C.ink }}>{e.label}</Text>
            <Text style={{ color: C.ink7 }}>{e.note}</Text>
            <Muted>{e.source === 'AUTO' ? 'Automatic' : 'Staff'} · {when(e.createdAt)}</Muted>
          </View>
        ))}
      </Card>
      <Card title="Dishes">
        {!data.dishes.length ? <Muted>No dishes.</Muted> : data.dishes.map((d) => <View key={d.id} style={[s.row, { marginBottom: 4 }]}><Text style={{ color: C.ink, flex: 1 }}>{d.dishName}</Text><Badge text={d.reviewStatus.toLowerCase().replace(/_/g, ' ')} tone={d.reviewStatus === 'PUBLISHED' ? 'good' : tone(d.reviewStatus)} /></View>)}
      </Card>
      <Card title="Earnings">
        {!earn ? (earnErr ? <ErrorText msg={earnErr} /> : <Loading />) : (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <StatTile label="Payable" value={money(earn.payableCents)} />
              <StatTile label="Held" value={money(earn.heldCents)} hint={`${earn.heldOrders} orders until completion`} />
              <StatTile label="Last 30 days" value={money(earn.last30.netCents)} hint={`${earn.last30.orders} orders · commission ${money(earn.last30.commissionCents)}`} />
            </View>
            {earn.adjustments.length > 0 && <View style={{ marginTop: 8 }}>{earn.adjustments.slice(0, 10).map((a) => <AdjustmentRow key={a.id} a={a} />)}</View>}
            <AdjustForm organizationId={earn.organizationId} onDone={reloadEarn} />
          </>
        )}
      </Card>
    </ScrollView>
  );
}

function ActionForm({ chefId, dishes, onDone }: { chefId: string; dishes: Detail['dishes']; onDone: (d: Detail) => void }) {
  const { run, busy, error } = useAction();
  const [action, setAction] = useState<ChefQualityAction>('WARNING');
  const [dishId, setDishId] = useState<string>('');
  const [note, setNote] = useState('');
  const needsDish = DISH_ACTIONS.includes(action);
  const ok = note.trim().length >= 5 && (!needsDish || !!dishId);
  const danger = action === 'CHEF_PAUSED' || action === 'CHEF_SUSPENDED' || action === 'DISH_SUSPENDED';
  return (
    <Card title="Take action">
      <Pills value={action} onChange={(a) => { setAction(a); setDishId(''); }} options={CHEF_QUALITY_ACTIONS.map((a) => ({ id: a, label: CHEF_QUALITY_EVENT_LABELS[a] || a }))} />
      {needsDish && (dishes.length ? (
        <>
          <Text style={s.label}>Dish</Text>
          <Pills value={dishId} onChange={setDishId} options={dishes.map((d) => ({ id: d.id, label: `${d.dishName}${d.reviewStatus !== 'PUBLISHED' ? ` (${d.reviewStatus.toLowerCase()})` : ''}` }))} />
        </>
      ) : <Muted>This chef has no dishes.</Muted>)}
      <Input label={action === 'NOTE' ? 'Note (staff only)' : 'Note (sent to the chef)'} multiline value={note} onChangeText={setNote} style={[s.input, { minHeight: 70 }]} placeholder="At least 5 characters" />
      <ErrorText msg={error} />
      <Button variant={danger ? 'danger' : 'primary'} disabled={busy || !ok} title={busy ? 'Saving…' : `Record: ${CHEF_QUALITY_EVENT_LABELS[action] || action}`} onPress={() => run(async () => { onDone(await api.post<Detail>(`/admin/chefs/${chefId}/quality`, { action, note: note.trim(), dishId: needsDish ? dishId : null })); setNote(''); setDishId(''); })} />
    </Card>
  );
}

/** Earnings adjustment through finance (needs finance.manage; the API error is shown if missing). */
function AdjustForm({ organizationId, onDone }: { organizationId: string; onDone: () => Promise<void> }) {
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'credit' | 'charge'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const cents = Math.round(Number(amount.replace(',', '.')) * 100) || 0;
  const value = kind === 'credit' ? cents : -cents;
  if (!open) return <Button variant="secondary" title="Adjust earnings" onPress={() => setOpen(true)} />;
  return (
    <View style={{ marginTop: 8 }}>
      <Pills value={kind} onChange={setKind} options={[{ id: 'credit', label: 'Credit the chef' }, { id: 'charge', label: 'Charge the chef' }]} />
      <Input label="Amount (USD)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="10.00" />
      <Input label="Reason" value={reason} onChangeText={setReason} placeholder="At least 5 characters" />
      <ErrorText msg={error} />
      <Button disabled={busy || cents <= 0 || reason.trim().length < 5} title={cents > 0 ? `Apply ${signed(value)}` : 'Apply'} onPress={() => run(async () => { await api.post('/finance/adjustments', { organizationId, cents: value, reason: reason.trim() }); setAmount(''); setReason(''); setOpen(false); await onDone(); })} />
      <Button variant="ghost" title="Cancel" onPress={() => setOpen(false)} />
    </View>
  );
}
