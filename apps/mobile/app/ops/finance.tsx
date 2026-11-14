import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills, StatTile } from '@/ops';

interface Payout { id: string; organizationName: string | null; partyType: string; status: string; amountCents: number; failureReason: string | null; batchId: string | null }
interface Dispute { id: string; orderNumber: string | null; amountCents: number; status: string; evidenceDueAt: string | null; overdue: boolean; reason: string | null }

/** Finance on the phone: integrity, payout batches & holds, disputes with deadlines, failures and webhooks, liabilities. */
export default function OpsFinance() {
  const router = useRouter();
  const { can } = useSession();
  const [tab, setTab] = useState<'today' | 'payouts' | 'disputes'>('today');
  const { data: integ } = useApi<{ unbalancedBatches: string[]; heldOrFailedPayouts: number; unmatchedItems: number }>('/finance/integrity');
  const { data: pay } = useApi<{ summary30d: { capturedCents: number; refundedCents: number; failures: number; authorizedOpenCents: number } }>(tab === 'today' ? '/admin/payments' : null, { deps: [tab] });
  const { data: wh } = useApi<{ providers: { provider: string; received: number; failed: number; avgLagSeconds: number | null }[] }>(tab === 'today' ? '/admin/webhooks?hours=24' : null, { deps: [tab] });
  const { data: liab } = useApi<{ totalLiabilitiesCents: number; liabilities: { account: string; balanceCents: number }[] }>(tab === 'today' ? '/finance/liabilities' : null, { deps: [tab] });
  const { data: batches, reload: rb } = useApi<{ id: string; status: string; partyType: string | null; payoutCount: number; totalCents: number }[]>(tab === 'payouts' ? '/finance/payout-batches' : null, { deps: [tab] });
  const { data: stuck, reload: rs } = useApi<Payout[]>(tab === 'payouts' ? '/finance/payouts?status=HELD' : null, { deps: [tab] });
  const { data: failed, reload: rf } = useApi<Payout[]>(tab === 'payouts' ? '/finance/payouts?status=FAILED' : null, { deps: [tab] });
  const { data: disputes, reload: rd } = useApi<Dispute[]>(tab === 'disputes' ? '/admin/disputes' : null, { deps: [tab] });
  const { run, error } = useAction();
  const [reason, setReason] = useState('');
  const manage = can('finance.manage');
  if (!integ) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'today', label: 'Overview' }, { id: 'payouts', label: 'Payouts' }, { id: 'disputes', label: 'Disputes' }]} />
      <ErrorText msg={error} />
      {tab === 'today' && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatTile label="Unbalanced batches" value={integ.unbalancedBatches.length} hint="must be 0" />
            <StatTile label="Held / failed payouts" value={integ.heldOrFailedPayouts} />
            <StatTile label="Unmatched items" value={integ.unmatchedItems} />
            {pay && <StatTile label="Captured 30d" value={money(pay.summary30d.capturedCents)} />}
            {pay && <StatTile label="Payment failures 30d" value={pay.summary30d.failures} />}
            {liab && <StatTile label="Liabilities" value={money(liab.totalLiabilitiesCents)} />}
          </View>
          <Card title="Webhooks (24 h)">{wh?.providers.map((p) => <Muted key={p.provider}>{p.provider}: {p.received} received · <Text style={{ color: p.failed ? C.bad : C.ink5 }}>{p.failed} failed</Text> · lag {p.avgLagSeconds ?? '—'}s</Muted>)}{!wh?.providers.length && <Muted>None.</Muted>}</Card>
          <Card title="Balances owed">{liab?.liabilities.filter((l) => l.balanceCents).map((l) => <View key={l.account} style={s.row}><Muted>{l.account.toLowerCase().replace(/_/g, ' ')}</Muted><Text>{money(l.balanceCents)}</Text></View>)}</Card>
          <Muted>Ledger explorer, reconciliation and accounting reports are on the web console.</Muted>
        </>
      )}
      {tab === 'payouts' && (
        <>
          <Card title="Batches">{batches?.slice(0, 10).map((b) => <View key={b.id} style={[s.row, { marginBottom: 4 }]}><Text style={{ flex: 1 }}>{(b.partyType || 'all').toLowerCase()} · {b.payoutCount} · {money(b.totalCents)}</Text><Badge text={b.status.replace('_', ' ')} tone={b.status === 'DONE' ? 'good' : b.status === 'PENDING_APPROVAL' ? 'warn' : 'info'} /></View>)}{batches?.some((b) => b.status === 'PENDING_APPROVAL') && <Button title="Open approvals" variant="secondary" onPress={() => router.push('/ops/approvals' as never)} />}</Card>
          {manage && <Input label="Reason (for reprocessing)" value={reason} onChangeText={setReason} />}
          {[...(stuck || []), ...(failed || [])].map((p) => (
            <Card key={p.id}>
              <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{p.organizationName || p.partyType.toLowerCase()} · {money(p.amountCents)}</Text><Badge text={p.status} tone={tone(p.status)} /></View>
              <Muted>{p.failureReason}</Muted>
              {manage && p.batchId && <Button title="Reprocess" variant="secondary" disabled={reason.length < 5} onPress={() => run(async () => { await api.post(`/finance/payouts/${p.id}/reprocess`, { reason }); await rs(); await rf(); await rb(); })} />}
            </Card>
          ))}
          {!stuck?.length && !failed?.length && <Card><Muted>No held or failed payouts.</Muted></Card>}
        </>
      )}
      {tab === 'disputes' && (
        <>
          {!disputes?.length && <Card><Muted>No disputes.</Muted></Card>}
          {disputes?.map((d) => (
            <Card key={d.id}>
              <View style={s.row}><Text style={{ fontWeight: '600' }}>{d.orderNumber || 'payment'} · {money(d.amountCents)}</Text><Badge text={d.overdue ? 'OVERDUE' : d.status.replace('_', ' ')} tone={d.overdue ? 'bad' : d.status === 'WON' ? 'good' : d.status === 'LOST' ? 'bad' : 'warn'} /></View>
              <Muted>{d.reason || 'No reason given'} · evidence due {when(d.evidenceDueAt)}</Muted>
              {manage && d.status === 'NEEDS_RESPONSE' && <Button title="Submit evidence packet" onPress={() => run(async () => { await api.post(`/admin/disputes/${d.id}/evidence`, {}); await rd(); })} />}
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}
