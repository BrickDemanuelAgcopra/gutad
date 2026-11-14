'use client';
import { useState } from 'react';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, statusTone, Table } from '@/components/ui';
import { askReason, SectionTitle } from '@/components/admin-ui';

interface GC { id: string; code: string; kind: string; status: string; initialCents: number; balanceCents: number; buyer: string | null; recipientEmail: string | null; claimed: boolean; lockedReason: string | null; expiresAt: string | null; createdAt: string }
interface List { cards: GC[]; velocity: { userId: string; email: string; n: number; cents: number }[]; blocked: { actor_id: string; action: string; created_at: string }[]; limits: { minCardCents: number; maxCardCents: number; maxPurchasesPerDay: number; maxCentsPerDay: number; reviewAboveCents: number; maxFailedRedeemsPerHour: number } }
interface Liab { outstandingCents: number; cards: number; ledgerLiabilityCents: number; redeemedLast30dCents: number; unclaimedCents: number; byStatus: { kind: string; status: string; n: number; cents: number }[] }

/** 25.9 / 20.4-G gift cards: look up, issue, lock, approve and void; liability against the ledger; fraud signals. */
export default function AdminGiftCards() {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { data, reload } = useApi<List>(`/admin/gift-cards?status=${status}&search=${encodeURIComponent(search)}`, { deps: [status, search] });
  const { data: liab, reload: rl } = useApi<Liab>('/admin/gift-cards/liability');
  const { run, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [issue, setIssue] = useState({ amount: '25', count: '1', email: '', reason: '', expires: '' });
  const [issued, setIssued] = useState<{ code: string; amountCents: number }[] | null>(null);
  const act = (c: GC, action: 'LOCK' | 'UNLOCK' | 'APPROVE' | 'VOID') => { const reason = askReason(`${action.toLowerCase()} gift card ${c.code}`, 3); if (reason) run(async () => { await api.post(`/admin/gift-cards/${c.id}/action`, { action, reason }); await reload(); await rl(); }); };
  return (
    <div className="space-y-4">
      <SectionTitle title="Gift cards" hint="Balances are a liability until spent. Purchases are limited per buyer, large cards wait for review, and wrong codes lock a customer out for an hour." />
      {error && <Alert>{error}</Alert>}
      {liab && <div className="grid gap-3 sm:grid-cols-5"><Stat label="Outstanding balance" value={money(liab.outstandingCents)} hint={`${liab.cards} cards`} /><Stat label="Ledger liability" value={money(liab.ledgerLiabilityCents)} hint={liab.ledgerLiabilityCents === liab.outstandingCents ? 'matches balances' : `differs by ${money(liab.ledgerLiabilityCents - liab.outstandingCents)} (orders not yet accepted)`} /><Stat label="Not yet added to a wallet" value={money(liab.unclaimedCents)} /><Stat label="Spent in 30 days" value={money(liab.redeemedLast30dCents)} /><Stat label="Waiting for review" value={liab.byStatus.filter((b) => b.status === 'PENDING_REVIEW').reduce((a, b) => a + b.n, 0)} /></div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card title="Cards" action={<div className="flex gap-2"><Input placeholder="Last 4 or email" value={search} onChange={(e) => setSearch(e.target.value)} /><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="ACTIVE">Active</option><option value="PENDING_REVIEW">Waiting for review</option><option value="LOCKED">Locked</option><option value="VOID">Void</option></Select></div>}>
          <Table rows={data?.cards || []} empty="No gift cards." cols={[
            { key: 'c', label: 'Card', render: (c) => <button className="text-left underline-offset-2 hover:underline" onClick={() => setOpen(c.id)}>{c.code}<div className="text-xs text-ink-500">{c.kind === 'PROMOTIONAL' ? 'promotional' : `bought by ${c.buyer || '—'}`}</div></button> },
            { key: 't', label: 'To', render: (c) => <span className="text-xs">{c.recipientEmail || '—'}{c.claimed ? ' · in wallet' : ''}</span> },
            { key: 'b', label: 'Balance', render: (c) => `${money(c.balanceCents)} of ${money(c.initialCents)}` },
            { key: 's', label: 'Status', render: (c) => <span><Badge tone={statusTone(c.status)}>{c.status.replace('_', ' ').toLowerCase()}</Badge>{c.lockedReason && <div className="text-xs text-ink-500">{c.lockedReason}</div>}</span> },
            { key: 'd', label: 'Issued', render: (c) => when(c.createdAt) },
            { key: 'a', label: '', render: (c) => can('growth.manage') && c.status !== 'VOID' ? <span className="flex flex-wrap gap-1">{c.status === 'PENDING_REVIEW' && <Button size="sm" onClick={() => act(c, 'APPROVE')}>Approve</Button>}{c.status === 'LOCKED' ? <Button size="sm" variant="secondary" onClick={() => act(c, 'UNLOCK')}>Unlock</Button> : <Button size="sm" variant="secondary" onClick={() => act(c, 'LOCK')}>Lock</Button>}<Button size="sm" variant="danger" onClick={() => act(c, 'VOID')}>Void</Button></span> : null },
          ]} />
        </Card>
        <div className="space-y-4">
          {can('growth.manage') && (
            <Card title="Issue promotional cards">
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-2"><Input label="Amount (USD)" value={issue.amount} onChange={(e) => setIssue({ ...issue, amount: e.target.value })} /><Input label="How many" value={issue.count} onChange={(e) => setIssue({ ...issue, count: e.target.value })} /></div>
                <Input label="Send to (optional)" value={issue.email} onChange={(e) => setIssue({ ...issue, email: e.target.value })} />
                <Input label="Reason" value={issue.reason} onChange={(e) => setIssue({ ...issue, reason: e.target.value })} placeholder="Service recovery, partner event…" />
                <Input label="Expires after days (optional, 30+)" value={issue.expires} onChange={(e) => setIssue({ ...issue, expires: e.target.value })} />
                <Button disabled={issue.reason.length < 3} onClick={() => run(async () => { setIssued(await api.post('/admin/gift-cards', { amountCents: Math.round(Number(issue.amount) * 100), count: Number(issue.count || 1), recipientEmail: issue.email || undefined, reason: issue.reason, expiresInDays: issue.expires ? Number(issue.expires) : undefined })); await reload(); await rl(); })}>Issue</Button>
                <p className="text-xs text-ink-500">Promotional cards are Gutad-funded: they are booked as promotion expense and gift-card liability.</p>
                {issued && <Alert tone="good">Issued {issued.length}: {issued.map((c) => c.code).join(', ')}</Alert>}
              </div>
            </Card>
          )}
          <Card title="Fraud watch (24 h / 7 d)">
            {data && <div className="space-y-2 text-sm">
              <div className="text-xs font-semibold uppercase text-ink-500">Buyers with several cards today</div>
              {data.velocity.length ? data.velocity.map((v) => <div key={v.userId} className="flex justify-between"><span>{v.email}</span><span>{v.n} · {money(v.cents)}</span></div>) : <p className="text-xs text-ink-500">None.</p>}
              <div className="pt-2 text-xs font-semibold uppercase text-ink-500">Blocked attempts</div>
              {data.blocked.length ? data.blocked.slice(0, 10).map((b, i) => <div key={i} className="flex justify-between text-xs"><span>{b.action === 'giftcard.velocity_block' ? 'Purchase limit hit' : 'Wrong-code lockout'}</span><span>{when(b.created_at)}</span></div>) : <p className="text-xs text-ink-500">None.</p>}
              <p className="pt-2 text-xs text-ink-500">Limits: {money(data.limits.minCardCents)}–{money(data.limits.maxCardCents)} per card, {data.limits.maxPurchasesPerDay} cards or {money(data.limits.maxCentsPerDay)} per buyer per day, review above {money(data.limits.reviewAboveCents)}, {data.limits.maxFailedRedeemsPerHour} wrong codes per hour. Setting <code>giftcards.limits</code>.</p>
            </div>}
          </Card>
        </div>
      </div>
      <Escheat />
      {open && <CardDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CardDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useApi<{ code: string; kind: string; status: string; balanceCents: number; initialCents: number; reason: string | null; message: string | null; txns: { id: string; kind: string; cents: number; orderId: string | null; note: string | null; createdAt: string }[] }>(`/admin/gift-cards/${id}`);
  return (
    <Modal open onClose={onClose} title={data ? `Gift card ${data.code}` : 'Gift card'}>
      {data && <div className="space-y-2 text-sm">
        <p>{money(data.balanceCents)} left of {money(data.initialCents)} · {data.kind.toLowerCase()} · {data.status.toLowerCase()}{data.reason ? ` · ${data.reason}` : ''}</p>
        <Table rows={data.txns} cols={[{ key: 'k', label: 'Activity', render: (t) => t.kind.toLowerCase() }, { key: 'c', label: 'Amount', render: (t) => <span className={t.cents < 0 ? 'text-red-600' : 'text-emerald-700'}>{money(t.cents)}</span> }, { key: 'o', label: 'Order', render: (t) => (t.orderId ? <a className="underline" href={`/admin/orders/${t.orderId}`}>open</a> : '—') }, { key: 'n', label: 'Note', render: (t) => t.note || '' }, { key: 'd', label: 'When', render: (t) => when(t.createdAt) }]} />
      </div>}
    </Modal>
  );
}

/** 25.9-E balances that must be reported to the state as unclaimed property. */
function Escheat() {
  const [asOf, setAsOf] = useState('');
  const { data } = useApi<{ totalCents: number; byState: { state: string; cards: number; cents: number }[]; comingDue12Months: { cards: number; cents: number }; rules: { defaultDormancyYears: number; byState: Record<string, number> } }>(`/admin/gift-cards/escheat${asOf ? `?asOf=${new Date(asOf).toISOString()}` : ''}`, { deps: [asOf] });
  return (
    <Card title="Unclaimed property (escheat)" action={<div className="flex items-end gap-2"><Input type="date" label="As of" value={asOf} onChange={(e) => setAsOf(e.target.value)} /><Button size="sm" variant="secondary" onClick={() => downloadFile(`/admin/gift-cards/escheat.csv${asOf ? `?asOf=${new Date(asOf).toISOString()}` : ''}`, 'gift-card-escheat.csv')}>CSV</Button></div>}>
      {data && <div className="space-y-2 text-sm">
        <p>Reportable now: <b>{money(data.totalCents)}</b>. Coming due in the next 12 months: {data.comingDue12Months.cards} cards, {money(data.comingDue12Months.cents)}.</p>
        <Table rows={data.byState} empty="Nothing is reportable." cols={[{ key: 's', label: 'State', render: (r) => r.state }, { key: 'c', label: 'Cards', render: (r) => r.cards }, { key: 'v', label: 'Balance', render: (r) => money(r.cents) }, { key: 'y', label: 'Dormancy', render: (r) => `${data.rules.byState[r.state] ?? data.rules.defaultDormancyYears} years` }]} />
        <p className="text-xs text-ink-500">Purchased cards with a balance and no activity for the dormancy period of the buyer’s state (setting <code>giftcards.escheat</code>). Promotional cards are not reportable. Confirm periods with counsel before filing.</p>
      </div>}
    </Card>
  );
}
