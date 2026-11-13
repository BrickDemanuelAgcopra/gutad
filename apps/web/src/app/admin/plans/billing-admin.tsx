'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Table } from '@/components/ui';

interface AddOn { id: string; code: string; name: string; description: string | null; productLine: string; priceCents: number; interval: string; perLocation: boolean; features: Record<string, boolean | number>; isPublic: boolean; isActive: boolean; sortOrder: number; activeCount: number }
interface Feature { key: string; name: string; kind: 'BOOLEAN' | 'LIMIT'; isActive: boolean }

/** Admin → Plans & pricing → Add-ons: what merchants can buy on top of a plan. */
export function AddOnsTab({ features }: { features: Feature[] }) {
  const { data, reload } = useApi<AddOn[]>('/admin/add-ons');
  const blank = { id: '', code: '', name: '', description: '', productLine: 'ALL', price: '0', interval: 'MONTH', perLocation: false, features: {} as Record<string, boolean | number>, isPublic: true, isActive: true, sortOrder: 0 };
  const [f, setF] = useState(blank);
  const { run, error } = useAction();
  const edit = (a: AddOn) => setF({ id: a.id, code: a.code, name: a.name, description: a.description || '', productLine: a.productLine, price: (a.priceCents / 100).toFixed(2), interval: a.interval, perLocation: a.perLocation, features: a.features, isPublic: a.isPublic, isActive: a.isActive, sortOrder: a.sortOrder });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card title="Add-ons">
        <Table rows={data || []} empty="No add-ons yet." cols={[
          { key: 'n', label: 'Add-on', render: (a) => <span className={a.isActive ? '' : 'opacity-50'}><b>{a.name}</b> <span className="text-xs text-ink-500">{a.code}{!a.isPublic && ' · hidden'}</span><span className="block text-xs text-ink-500">{Object.entries(a.features).map(([k, v]) => (typeof v === 'number' ? `+${v} ${k}` : k)).join(', ')}</span></span> },
          { key: 'p', label: 'Price', render: (a) => a.priceCents ? `${money(a.priceCents)}/${a.interval === 'YEAR' ? 'yr' : 'mo'}${a.perLocation ? ' per location' : ''}` : 'Free' },
          { key: 'c', label: 'Active', render: (a) => a.activeCount },
          { key: 'e', label: '', render: (a) => <Button size="sm" variant="ghost" onClick={() => edit(a)}>Edit</Button> },
        ]} />
      </Card>
      <Card title={f.id ? `Edit ${f.code}` : 'New add-on'}>
        <div className="space-y-2">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Code (permanent)" value={f.code} disabled={!!f.id} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <Input label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Input label="Price (USD)" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            <Select label="Billed" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="MONTH">Monthly</option><option value="YEAR">Yearly</option></Select>
          </div>
          <Select label="Product line" value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })}><option value="ALL">All</option><option value="ORDERING">Ordering</option><option value="RESERVATIONS">Reservations</option></Select>
          <div className="text-sm font-medium">Unlocks</div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-ink-100 p-2 text-sm">
            {features.filter((x) => x.isActive).map((x) => (
              <label key={x.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">{x.kind === 'BOOLEAN' && <input type="checkbox" checked={!!f.features[x.key]} onChange={(e) => { const n = { ...f.features }; if (e.target.checked) n[x.key] = true; else delete n[x.key]; setF({ ...f, features: n }); }} />}{x.name}</span>
                {x.kind === 'LIMIT' && <input type="number" min={0} className="w-16 rounded border border-ink-100 px-1 text-right" placeholder="+0" value={typeof f.features[x.key] === 'number' ? (f.features[x.key] as number) : ''} onChange={(e) => { const n = { ...f.features }; if (e.target.value === '' || Number(e.target.value) === 0) delete n[x.key]; else n[x.key] = Number(e.target.value); setF({ ...f, features: n }); }} />}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.perLocation} onChange={(e) => setF({ ...f, perLocation: e.target.checked })} /> Per location</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Merchants can buy</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
          </div>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button size="sm" disabled={f.name.length < 2 || f.code.length < 2} onClick={() => run(async () => { await api.post('/admin/add-ons', { id: f.id || undefined, code: f.code, name: f.name, description: f.description || null, productLine: f.productLine, priceCents: Math.round(Number(f.price || 0) * 100), interval: f.interval, perLocation: f.perLocation, features: f.features, isPublic: f.isPublic, isActive: f.isActive, sortOrder: f.sortOrder }); setF(blank); reload(); })}>Save add-on</Button>
            <Button size="sm" variant="ghost" onClick={() => setF(blank)}>Clear</Button>
          </div>
          <p className="text-xs text-ink-500">Price changes apply to new purchases; merchants who already bought keep their price.</p>
        </div>
      </Card>
    </div>
  );
}

interface Sub { id: string; organizationId: string; orgName: string; planName: string; planCode: string; status: string; currentPeriodEnd: string; trialEndsAt: string | null; pausedReason: string | null; locationCount: number; mrrCents: number; scheduled: { name: string; effectiveFrom: string } | null }

/** Admin → Plans & pricing → Subscriptions: every merchant subscription, MRR, pause/resume. */
export function SubscriptionsTab() {
  const { data, reload } = useApi<Sub[]>('/admin/subscriptions');
  const { run, error } = useAction();
  const [filter, setFilter] = useState('OPEN');
  const rows = (data || []).filter((s) => filter === 'ALL' || (filter === 'OPEN' ? s.status !== 'CANCELED' : s.status === filter));
  const mrr = (data || []).reduce((a, s) => a + s.mrrCents, 0);
  return (
    <Card title="Subscriptions" action={<span className="text-sm">MRR <b>{money(mrr)}</b></span>}>
      <div className="mb-3 flex flex-wrap gap-2">{['OPEN', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED', 'ALL'].map((k) => <button key={k} onClick={() => setFilter(k)} className={`rounded-full px-3 py-1 text-xs ${filter === k ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-700'}`}>{k.replace('_', ' ').toLowerCase()}</button>)}</div>
      {error && <Alert>{error}</Alert>}
      <Table rows={rows} empty="No subscriptions." cols={[
        { key: 'o', label: 'Merchant', render: (s) => s.orgName },
        { key: 'p', label: 'Plan', render: (s) => <span>{s.planName}{s.scheduled && <span className="block text-xs text-amber-700">→ {s.scheduled.name} on {when(s.scheduled.effectiveFrom)}</span>}</span> },
        { key: 's', label: 'Status', render: (s) => <Badge tone={s.status === 'ACTIVE' ? 'good' : s.status === 'TRIAL' ? 'info' : s.status === 'CANCELED' ? 'neutral' : 'warn'}>{s.status.toLowerCase()}</Badge> },
        { key: 'r', label: 'Renews / ends', render: (s) => when(s.status === 'TRIAL' ? s.trialEndsAt : s.currentPeriodEnd) },
        { key: 'm', label: 'MRR', render: (s) => money(s.mrrCents) },
        { key: 'a', label: '', render: (s) => s.status === 'PAUSED' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/admin/subscriptions/${s.id}/resume`, {}); reload(); })}>Resume</Button> : s.status !== 'CANCELED' ? <Button size="sm" variant="ghost" onClick={() => { const reason = prompt('Why pause billing? (shown in the audit log)'); if (reason !== null) run(async () => { await api.post(`/admin/subscriptions/${s.id}/pause`, { reason }); reload(); }); }}>Pause</Button> : null },
      ]} />
      <p className="mt-2 text-xs text-ink-500">Pausing stops billing and renewals; resuming extends the period by the paused time. Plan changes for a merchant: issue a new Order Form from Tenants, or the merchant switches from Plan & billing.</p>
    </Card>
  );
}

/** On a published version: move merchants on older versions of this plan onto it from a date. */
export function MoveSubscribers({ versionId, version }: { versionId: string; version: number }) {
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ date: in30, includeLegacy: false, includeOverridden: false });
  const [result, setResult] = useState<{ dryRun: boolean; moved: { organizationId: string; from: number | string }[]; skipped: { organizationId: string; reason: string }[]; effectiveFrom: string } | null>(null);
  const { run, error } = useAction();
  const go = (dryRun: boolean) => run(async () => setResult(await api.post(`/admin/plan-versions/${versionId}/migrate`, { effectiveFrom: new Date(f.date + 'T00:00:00').toISOString(), includeLegacy: f.includeLegacy, includeOverridden: f.includeOverridden, dryRun })));
  return (
    <Card title={`Move existing merchants to v${version}`}>
      <p className="mb-2 text-xs text-ink-500">The Merchant Agreement promises 30 days&apos; notice of material changes, so the date defaults to 30 days out. Each merchant gets a new unsigned Order Form that takes effect on that date.</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <Input label="Effective date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <label className="flex items-center gap-1 pb-2"><input type="checkbox" checked={f.includeLegacy} onChange={(e) => setF({ ...f, includeLegacy: e.target.checked })} /> Include original (pre-catalog) contracts</label>
        <label className="flex items-center gap-1 pb-2"><input type="checkbox" checked={f.includeOverridden} onChange={(e) => setF({ ...f, includeOverridden: e.target.checked })} /> Include negotiated fees</label>
        <Button size="sm" variant="secondary" onClick={() => go(true)}>Preview</Button>
        <Button size="sm" onClick={() => go(false)}>Move merchants</Button>
      </div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      {result && <p className="mt-2 text-sm">{result.dryRun ? 'Would move' : 'Moved'} <b>{result.moved.length}</b> merchant{result.moved.length === 1 ? '' : 's'} effective {when(result.effectiveFrom)}; skipped {result.skipped.length}{result.skipped.length ? ` (${[...new Set(result.skipped.map((s) => s.reason))].join('; ')})` : ''}.</p>}
    </Card>
  );
}

interface Promo { id: string; code: string; name: string; kind: 'PERCENT_OFF' | 'FREE_PERIODS' | 'COMMISSION_HOLIDAY'; percentOff: number; periods: number; days: number; planCodes: string[]; maxRedemptions: number | null; newMerchantsOnly: boolean; startsAt: string | null; expiresAt: string | null; isActive: boolean; redemptions: number }

const describePromo = (p: Pick<Promo, 'kind' | 'percentOff' | 'periods' | 'days'>) => p.kind === 'PERCENT_OFF' ? `${p.percentOff}% off the plan for ${p.periods} renewal${p.periods === 1 ? '' : 's'}` : p.kind === 'FREE_PERIODS' ? `Plan free for ${p.periods} renewal${p.periods === 1 ? '' : 's'}` : `No marketplace commission for ${p.days} days`;

/** Admin → Plans & pricing → Promotions: codes merchants redeem from Plan & billing. */
export function PromotionsTab({ planCodes }: { planCodes: { code: string; name: string }[] }) {
  const { data, reload } = useApi<Promo[]>('/admin/promotions');
  const blank = { id: '', code: '', name: '', kind: 'FREE_PERIODS' as Promo['kind'], percentOff: 20, periods: 1, days: 30, planCodes: [] as string[], maxRedemptions: '', newMerchantsOnly: true, expiresAt: '', isActive: true };
  const [f, setF] = useState(blank);
  const { run, error } = useAction();
  const edit = (p: Promo) => setF({ id: p.id, code: p.code, name: p.name, kind: p.kind, percentOff: p.percentOff, periods: p.periods, days: p.days, planCodes: p.planCodes, maxRedemptions: p.maxRedemptions == null ? '' : String(p.maxRedemptions), newMerchantsOnly: p.newMerchantsOnly, expiresAt: p.expiresAt ? p.expiresAt.slice(0, 10) : '', isActive: p.isActive });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card title="Promotions">
        <Table rows={data || []} empty="No promotions yet." cols={[
          { key: 'c', label: 'Code', render: (p) => <span className={p.isActive ? '' : 'opacity-50'}><b>{p.code}</b><span className="block text-xs text-ink-500">{p.name}</span></span> },
          { key: 'k', label: 'Gives', render: (p) => <span>{describePromo(p)}<span className="block text-xs text-ink-500">{p.planCodes.length ? p.planCodes.join(', ') : 'any plan'}{p.newMerchantsOnly ? ' · new merchants' : ''}</span></span> },
          { key: 'r', label: 'Used', render: (p) => `${p.redemptions}${p.maxRedemptions ? ` / ${p.maxRedemptions}` : ''}` },
          { key: 'x', label: 'Expires', render: (p) => (p.expiresAt ? when(p.expiresAt) : '—') },
          { key: 'e', label: '', render: (p) => <Button size="sm" variant="ghost" onClick={() => edit(p)}>Edit</Button> },
        ]} />
      </Card>
      <Card title={f.id ? `Edit ${f.code}` : 'New promotion'}>
        <div className="space-y-2">
          <Input label="Code merchants enter" value={f.code} disabled={!!f.id} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select label="Gives" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Promo['kind'] })}><option value="FREE_PERIODS">Free subscription for N renewals</option><option value="PERCENT_OFF">Percent off subscription for N renewals</option><option value="COMMISSION_HOLIDAY">No marketplace commission for N days</option></Select>
          <div className="grid grid-cols-2 gap-2">
            {f.kind === 'PERCENT_OFF' && <Input label="Percent off" type="number" value={f.percentOff} onChange={(e) => setF({ ...f, percentOff: Number(e.target.value) })} />}
            {f.kind !== 'COMMISSION_HOLIDAY' ? <Input label="Renewals" type="number" value={f.periods} onChange={(e) => setF({ ...f, periods: Number(e.target.value) })} /> : <Input label="Days" type="number" value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} />}
            <Input label="Max redemptions" placeholder="unlimited" value={f.maxRedemptions} onChange={(e) => setF({ ...f, maxRedemptions: e.target.value })} />
            <Input label="Expires" type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} />
          </div>
          <div className="text-sm font-medium">Limit to plans (none = any)</div>
          <div className="flex flex-wrap gap-2 text-xs">{planCodes.map((p) => <label key={p.code} className="flex items-center gap-1"><input type="checkbox" checked={f.planCodes.includes(p.code)} onChange={(e) => setF({ ...f, planCodes: e.target.checked ? [...f.planCodes, p.code] : f.planCodes.filter((x) => x !== p.code) })} />{p.name}</label>)}</div>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.newMerchantsOnly} onChange={(e) => setF({ ...f, newMerchantsOnly: e.target.checked })} /> New merchants only (no paid invoices yet)</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label>
          </div>
          <p className="text-xs text-ink-500">{describePromo(f)}</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button size="sm" disabled={f.code.length < 3 || f.name.length < 2} onClick={() => run(async () => { await api.post('/admin/promotions', { id: f.id || undefined, code: f.code, name: f.name, kind: f.kind, percentOff: f.kind === 'PERCENT_OFF' ? f.percentOff : 0, periods: f.periods, days: f.kind === 'COMMISSION_HOLIDAY' ? f.days : 0, planCodes: f.planCodes, maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null, newMerchantsOnly: f.newMerchantsOnly, expiresAt: f.expiresAt ? new Date(f.expiresAt + 'T23:59:59').toISOString() : null, isActive: f.isActive }); setF(blank); reload(); })}>Save promotion</Button>
            <Button size="sm" variant="ghost" onClick={() => setF(blank)}>Clear</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

interface Revenue { mrrCents: number; planMrrCents: number; addOnMrrCents: number; byPlan: { plan: string; subscribers: number; mrrCents: number }[]; statusCounts: Record<string, number>; trials: { started: number; ended: number; converted: number; conversionRate: number | null }; changes90d: Record<string, number>; revenueByMonth: { month: string; account: string; cents: number }[] }

const ACCOUNTS: Record<string, string> = { PLATFORM_REVENUE_SUBSCRIPTION: 'Subscriptions', PLATFORM_REVENUE_COMMISSION: 'Commission', PLATFORM_REVENUE_COVER_FEE: 'Cover fees', PLATFORM_REVENUE_SERVICE_FEE: 'Service fees', PLATFORM_REVENUE_ADS: 'Ads' };

/** Admin → Plans & pricing → Revenue: MRR by plan, trials, plan changes, revenue by month from the ledger. */
export function RevenueTab() {
  const { data: r } = useApi<Revenue>('/admin/reports/plans');
  if (!r) return null;
  const months = [...new Set(r.revenueByMonth.map((x) => x.month))];
  const cell = (m: string, a: string) => r.revenueByMonth.find((x) => x.month === m && x.account === a)?.cents ?? 0;
  const stat = (label: string, value: string, hint?: string) => <div className="rounded-2xl border border-ink-100 bg-white p-4 shadow-card"><div className="text-xs text-ink-500">{label}</div><div className="text-2xl font-bold">{value}</div>{hint && <div className="text-xs text-ink-500">{hint}</div>}</div>;
  const ch = (k: string) => r.changes90d[k] ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stat('MRR', money(r.mrrCents), `plans ${money(r.planMrrCents)} · add-ons ${money(r.addOnMrrCents)}`)}
        {stat('Paying subscriptions', String((r.statusCounts.ACTIVE ?? 0) + (r.statusCounts.PAST_DUE ?? 0)), `${r.statusCounts.TRIAL ?? 0} trialing · ${r.statusCounts.PAST_DUE ?? 0} overdue · ${r.statusCounts.PAUSED ?? 0} paused`)}
        {stat('Trial conversion', r.trials.conversionRate == null ? '—' : `${Math.round(r.trials.conversionRate * 100)}%`, `${r.trials.converted} of ${r.trials.ended} ended trials · ${r.trials.started} started`)}
        {stat('Plan changes (90 days)', `${ch('plan.upgrade')} ↑ · ${ch('plan.downgrade')} ↓`, `${ch('plan.change.cancel')} undone · ${ch('addon.buy')} add-ons bought · ${ch('promotion.redeem')} promo codes`)}
      </div>
      <Card title="MRR by plan">
        <Table rows={r.byPlan} empty="No paying subscriptions." cols={[{ key: 'p', label: 'Plan', render: (x) => x.plan }, { key: 's', label: 'Subscribers', render: (x) => x.subscribers }, { key: 'm', label: 'MRR', render: (x) => money(x.mrrCents) }, { key: 'w', label: '', render: (x) => <div className="h-2 rounded bg-brand-400" style={{ width: `${r.planMrrCents ? Math.max(4, (x.mrrCents / r.planMrrCents) * 160) : 4}px` }} /> }]} />
      </Card>
      <Card title="Revenue by month (ledger)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead><tr className="border-b border-ink-100 text-left"><th className="p-2">Month</th>{Object.values(ACCOUNTS).map((a) => <th key={a} className="p-2">{a}</th>)}<th className="p-2">Total</th></tr></thead>
            <tbody>{months.map((m) => <tr key={m} className="border-b border-ink-50"><td className="p-2">{m}</td>{Object.keys(ACCOUNTS).map((a) => <td key={a} className="p-2">{money(cell(m, a))}</td>)}<td className="p-2 font-semibold">{money(Object.keys(ACCOUNTS).reduce((t, a) => t + cell(m, a), 0))}</td></tr>)}{!months.length && <tr><td className="p-2 text-ink-500" colSpan={7}>No revenue recorded yet.</td></tr>}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
