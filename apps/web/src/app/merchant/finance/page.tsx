'use client';
import type { FeeRuleDto } from '@gutad/shared';
import { FeeList } from '@/components/plan-ui';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Input, Button, Card, Stat, statusTone, Table } from '@/components/ui';
import { useMerchant } from '../context';
import { StatementLines } from '@/components/merchant-extras';

export default function FinancePage() {
  const { org } = useMerchant();
  const { data: bal } = useApi<{ payableCents: number; unreconciledCents: number; negativeBalance: boolean; pendingPayouts: { id: string; status: string; amountCents: number; periodEnd: string; failureReason: string | null }[] }>(org ? `/organizations/${org.id}/balance` : null, { deps: [org?.id] });
  const { data: stmts } = useApi<{ id: string; periodStart: string; periodEnd: string; grossSalesCents: number; commissionCents: number; refundsCents: number; coverFeesCents: number; netPayableCents: number; orderCount: number; coverCount: number; payoutId: string | null }[]>(org ? `/organizations/${org.id}/statements` : null, { deps: [org?.id] });
  const { data: invs, reload } = useApi<{ id: string; number: string; kind: string; status: string; totalCents: number; dueAt: string }[]>(org ? `/organizations/${org.id}/invoices` : null, { deps: [org?.id] });
  const { data: contracts } = useApi<{ id: string; name: string; planCode: string; version: number; marketplaceCommissionBps: number; directCommissionBps: number; subscriptionCents: number; coverFeeNetworkCents: number; prepaidServiceFeeBps: number; effectiveFrom: string; signedAt: string | null; fees: FeeRuleDto[] }[]>(org ? `/organizations/${org.id}/contracts` : null, { deps: [org?.id] });
  const { run, error } = useAction();
  const [detail, setDetail] = useState<{ id: string; entries: { createdAt: string; memo: string | null; debitCents: number; creditCents: number }[]; lines: { category: string; creditsCents: number; debitsCents: number; netCents: number; count: number }[]; disputes: { id: string; reason: string; status: string; resolution: string | null; adjustmentCents: number | null }[] } | null>(null);
  const [disp, setDisp] = useState({ reason: '', amount: '' });
  if (!org) return null;
  const seller = org.legalSellers[0];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Finance</h1>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Payable balance" value={money(bal?.payableCents || 0)} hint={bal?.negativeBalance ? 'Negative: nets against next sales' : 'Paid weekly (Mon)'} />
        <Stat label="Unreconciled" value={money(bal?.unreconciledCents || 0)} hint="since last statement" />
        <Stat label="Payout account" value={seller?.payoutOnboardingState || 'NOT_STARTED'} hint={seller?.legalName} />
      </div>
      {seller && seller.payoutOnboardingState !== 'COMPLETE' && <Alert tone="info">Payouts are held until bank onboarding is complete. <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api.post<{ onboardingUrl: string | null; state: string }>(`/legal-sellers/${seller.id}/payout-onboarding`, {}); if (r.onboardingUrl) window.open(r.onboardingUrl, '_blank'); else alert(`Payout account ${r.state}`); location.reload(); })}>Set up payouts</Button></Alert>}
      <Card title="Pending payouts"><Table rows={bal?.pendingPayouts || []} empty="No pending payouts." cols={[{ key: 'p', label: 'Period end', render: (r) => when(r.periodEnd) }, { key: 'a', label: 'Amount', render: (r) => money(r.amountCents) }, { key: 's', label: 'Status', render: (r) => <span><Badge tone={statusTone(r.status)}>{r.status}</Badge> {r.failureReason && <span className="text-xs text-red-600">{r.failureReason}</span>}</span> }]} /></Card>
      <Card title="Statements">
        <Table rows={stmts || []} empty="No statements yet — the first closes after your first week of sales." cols={[{ key: 'p', label: 'Period', render: (r) => `${r.periodStart.slice(0, 10)} → ${r.periodEnd.slice(0, 10)}` }, { key: 'g', label: 'Gross', render: (r) => money(r.grossSalesCents) }, { key: 'c', label: 'Commission', render: (r) => money(r.commissionCents) }, { key: 'r', label: 'Refunds', render: (r) => money(r.refundsCents) }, { key: 'cv', label: 'Cover fees', render: (r) => money(r.coverFeesCents) }, { key: 'n', label: 'Net', render: (r) => <b>{money(r.netPayableCents)}</b> }, { key: 'x', label: '', render: (r) => <Button size="sm" variant="ghost" onClick={() => api.get<NonNullable<typeof detail>>(`/statements/${r.id}/lines`).then(setDetail)}>Detail</Button> }]} />
        {detail && (
          <div className="mt-3 space-y-2">
            <table className="w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th>Category</th><th>Items</th><th className="text-right">Credits</th><th className="text-right">Debits</th><th className="text-right">Net</th></tr></thead><tbody>{detail.lines.map((l) => <tr key={l.category} className="border-t border-ink-50"><td>{l.category.toLowerCase().replace('_', ' ')}</td><td>{l.count}</td><td className="text-right">{money(l.creditsCents)}</td><td className="text-right">{money(l.debitsCents)}</td><td className="text-right font-medium">{money(l.netCents)}</td></tr>)}</tbody></table>
            <details><summary className="cursor-pointer text-xs text-ink-500">All ledger lines</summary><div className="max-h-64 overflow-y-auto rounded-lg bg-ink-50 p-3 text-xs">{detail.entries.map((e, k) => <div key={k} className="flex justify-between"><span>{when(e.createdAt)} {e.memo}</span><span>{e.creditCents ? `+${money(e.creditCents)}` : `−${money(e.debitCents)}`}</span></div>)}</div></details>
            {detail.disputes.map((d) => <div key={d.id} className="text-xs">Dispute: {d.reason} · <Badge tone={d.status === 'RESOLVED' ? 'good' : d.status === 'REJECTED' ? 'bad' : 'warn'}>{d.status.toLowerCase()}</Badge>{d.resolution ? ` · ${d.resolution}` : ''}{d.adjustmentCents ? ` · adjusted ${money(d.adjustmentCents)}` : ''}</div>)}
            <div className="flex flex-wrap items-end gap-2"><Input label="Something wrong? Tell us" value={disp.reason} onChange={(e) => setDisp({ ...disp, reason: e.target.value })} /><Input label="Amount $ (optional)" value={disp.amount} onChange={(e) => setDisp({ ...disp, amount: e.target.value })} /><Button size="sm" variant="secondary" disabled={disp.reason.length < 10} onClick={() => run(async () => { await api.post(`/statements/${detail.id}/dispute`, { reason: disp.reason, amountCents: disp.amount ? Math.round(Number(disp.amount) * 100) : undefined }); setDisp({ reason: '', amount: '' }); setDetail(await api.get(`/statements/${detail.id}/lines`)); })}>Dispute statement</Button></div>
          </div>
        )}
      </Card>
      <Card title="Invoices (subscriptions, covers, ads — independent of food payouts)"><Table rows={invs || []} empty="No invoices." cols={[{ key: 'n', label: 'Number', render: (r) => r.number }, { key: 'k', label: 'Kind', render: (r) => r.kind }, { key: 't', label: 'Total', render: (r) => money(r.totalCents) }, { key: 'd', label: 'Due', render: (r) => when(r.dueAt) }, { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> }, { key: 'a', label: '', render: (r) => r.status !== 'PAID' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/invoices/${r.id}/pay`, { paymentMethodId: 'mock_pm_4242' }); reload(); })}>Pay</Button> : null }]} /></Card>
      <StatementLines orgId={org.id} />
      <Card title="Your agreement">{contracts?.length ? contracts.map((c) => <div key={c.id} className="border-b border-ink-50 py-2 text-sm last:border-0"><div>v{c.version} <b>{c.name}</b> · {c.subscriptionCents ? `${money(c.subscriptionCents)}/mo` : 'no subscription'} · effective {when(c.effectiveFrom)} {c.signedAt ? <Badge tone="good">signed</Badge> : <Badge tone="warn">unsigned</Badge>}</div><FeeList fees={c.fees} className="mt-1 text-xs" /></div>) : <p className="text-sm text-ink-500">No contract yet — platform default terms apply (15% marketplace, 0% direct, $1.50 network cover). Gutad commercial ops will set your plan.</p>}</Card>
    </div>
  );
}
