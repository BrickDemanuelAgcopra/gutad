'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input, Stat, Table, Textarea } from '@/components/ui';

export default function AdminFinance() {
  const { data: integ, reload } = useApi<{ unbalancedBatches: string[]; processorClearingNet: number; heldOrFailedPayouts: number; unmatchedItems: number }>('/finance/integrity');
  const { data: unmatched, reload: reloadU } = useApi<{ id: string; source: string; externalId: string; amountCents: number; description: string | null; createdAt: string }[]>('/finance/unmatched');
  const { run, error } = useAction();
  const [period, setPeriod] = useState({ start: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) });
  const [bank, setBank] = useState({ externalId: '', amount: '' });
  const [provider, setProvider] = useState('');
  const [out, setOut] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Finance close & reconciliation</h1>
      {integ && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Unbalanced batches" value={integ.unbalancedBatches.length} hint="must be 0" /><Stat label="Processor clearing" value={money(integ.processorClearingNet)} hint="captured − refunded − fees" /><Stat label="Held/failed payouts" value={integ.heldOrFailedPayouts} /><Stat label="Unmatched items" value={integ.unmatchedItems} /></div>}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Close period (statements → payouts)">
          <div className="flex gap-2"><Input type="date" label="Start" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /><Input type="date" label="End" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></div>
          <div className="mt-2 flex flex-wrap gap-2"><Button onClick={() => run(async () => { setOut(await api.post('/finance/close-period', { periodStart: period.start, periodEnd: period.end })); reload(); })}>Close merchant period</Button><Button variant="secondary" onClick={() => run(async () => { setOut(await api.post('/finance/close-driver-period', { periodStart: period.start, periodEnd: period.end })); })}>Close driver period</Button><Button variant="secondary" onClick={() => run(async () => { setOut(await api.post('/finance/submit-payouts', {})); reload(); })}>Submit payouts</Button></div>
          {out !== null && <pre className="mt-2 max-h-48 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(out, null, 2)}</pre>}
        </Card>
        <Card title="Reconcile">
          <div className="flex items-end gap-2"><Input label="Bank line id" value={bank.externalId} onChange={(e) => setBank({ ...bank, externalId: e.target.value })} /><Input label="Amount (USD)" value={bank.amount} onChange={(e) => setBank({ ...bank, amount: e.target.value })} /><Button variant="secondary" onClick={() => run(async () => { setOut(await api.post('/finance/reconcile/bank', { externalId: bank.externalId, amountCents: Math.round(Number(bank.amount) * 100), currency: 'USD' })); reloadU(); reload(); })}>Match bank line</Button></div>
          <Textarea className="mt-2" label="Provider invoice JSON ({provider, externalId, periodStart, periodEnd, lines:[{providerJobId, cents}]})" rows={3} value={provider} onChange={(e) => setProvider(e.target.value)} />
          <Button className="mt-2" variant="secondary" disabled={!provider} onClick={() => run(async () => { setOut(await api.post('/finance/provider-invoices', JSON.parse(provider))); reloadU(); })}>Ingest provider invoice</Button>
        </Card>
      </div>
      <Card title="Unmatched queue"><Table rows={unmatched || []} empty="Nothing unmatched." cols={[{ key: 's', label: 'Source', render: (r) => r.source }, { key: 'e', label: 'External id', render: (r) => r.externalId }, { key: 'a', label: 'Amount', render: (r) => money(r.amountCents) }, { key: 'd', label: 'Note', render: (r) => r.description }, { key: 't', label: 'Seen', render: (r) => when(r.createdAt) }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="ghost" onClick={() => { const n = prompt('Resolution'); if (n) run(async () => { await api.post(`/finance/unmatched/${r.id}/resolve`, { resolution: n }); reloadU(); reload(); }); }}>Resolve</Button> }]} /></Card>
      {integ && integ.unbalancedBatches.length > 0 && <Alert>Unbalanced journal batches: {integ.unbalancedBatches.join(', ')}</Alert>}
    </div>
  );
}
