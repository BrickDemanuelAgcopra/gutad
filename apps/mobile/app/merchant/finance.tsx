import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api, money, when } from '@/api';
import { useAction, useApi } from '@/hooks';
import { useMerchantLocation } from '@/merchant';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { WorkspaceGate } from '@/ops';

interface Lines { id: string; lines: { category: string; netCents: number; count: number }[]; disputes: { id: string; reason: string; status: string; resolution: string | null }[]; netPayableCents: number }

/** Merchant finance on the phone: balance, payouts, itemized statements and statement disputes. */
function Finance() {
  const { loc } = useMerchantLocation();
  const org = loc?.organizationId;
  const { data: bal } = useApi<{ payableCents: number; pendingPayouts: { id: string; status: string; amountCents: number; periodEnd: string; failureReason: string | null }[] }>(org ? `/organizations/${org}/balance` : null, { deps: [org] });
  const { data: stmts } = useApi<{ id: string; periodStart: string; periodEnd: string; netPayableCents: number; orderCount: number }[]>(org ? `/organizations/${org}/statements` : null, { deps: [org] });
  const [open, setOpen] = useState<string | null>(null);
  const { data: lines, reload } = useApi<Lines>(open ? `/statements/${open}/lines` : null, { deps: [open] });
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  if (!loc) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Balance"><Text style={{ fontSize: 24, fontWeight: '700' }}>{money(bal?.payableCents || 0)}</Text><Muted>Owed to you; paid weekly.</Muted></Card>
      <Card title="Payouts">{bal?.pendingPayouts.map((p) => <View key={p.id} style={{ marginBottom: 6 }}><View style={s.row}><Text>{money(p.amountCents)} · to {p.periodEnd.slice(0, 10)}</Text><Badge text={p.status} tone={tone(p.status)} /></View>{p.failureReason && <Muted>{p.failureReason}</Muted>}</View>)}{!bal?.pendingPayouts.length && <Muted>No pending payouts.</Muted>}</Card>
      <Card title="Statements">
        {stmts?.map((st) => (
          <View key={st.id} style={{ marginBottom: 8 }}>
            <Pressable onPress={() => setOpen(open === st.id ? null : st.id)}><View style={s.row}><Text>{st.periodStart.slice(0, 10)} → {st.periodEnd.slice(0, 10)}</Text><Text style={{ fontWeight: '700' }}>{money(st.netPayableCents)}</Text></View><Muted>{st.orderCount} orders · tap for detail</Muted></Pressable>
            {open === st.id && lines && (
              <View style={{ marginTop: 6 }}>
                {lines.lines.map((l) => <View key={l.category} style={s.row}><Muted>{l.category.toLowerCase().replace('_', ' ')} ({l.count})</Muted><Text style={{ color: l.netCents < 0 ? C.bad : C.ink }}>{money(l.netCents)}</Text></View>)}
                {lines.disputes.map((d) => <Muted key={d.id}>Dispute: {d.reason} · {d.status.toLowerCase()}{d.resolution ? ` · ${d.resolution}` : ''}</Muted>)}
                <Input label="Something wrong? Tell us" value={reason} onChangeText={setReason} />
                <Button title="Dispute statement" variant="secondary" disabled={reason.length < 10} onPress={() => run(async () => { await api.post(`/statements/${st.id}/dispute`, { reason }); setReason(''); await reload(); })} />
              </View>
            )}
          </View>
        ))}
        {!stmts?.length && <Muted>No statements yet.</Muted>}
      </Card>
      <ErrorText msg={error} />
      <Muted>Last updated {when(new Date().toISOString())}</Muted>
    </ScrollView>
  );
}

export default function Screen() {
  return <WorkspaceGate page="/merchant/finance"><Finance /></WorkspaceGate>;
}
