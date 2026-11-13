'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PRODUCT_LINES, type FeeRuleDto, type PublicPlanDto } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Spinner, statusTone, Table } from '@/components/ui';
import { FeeList, planPrice } from '@/components/plan-ui';
import { MerchantAgreementText } from '@/components/merchant-agreement';
import { useMerchant } from '../context';

interface Billing {
  current: { contractId: string; planCode: string; name: string; version: number | null; legacy: boolean; subscriptionCents: number; interval: string; signedAt: string | null; effectiveFrom: string; fees: FeeRuleDto[] } | null;
  defaultPlanCode: string;
  subscription: { id: string; status: string; currentPeriodStart: string; currentPeriodEnd: string; trialEndsAt: string | null; pausedAt: string | null; locationCount: number } | null;
  scheduledChange: { planCode: string; name: string; effectiveFrom: string; subscriptionCents: number; interval: string } | null;
  usage: { since: string; orders: { channel: string; fulfillment: string; orders: number; salesCents: number; commissionCents: number }[]; covers: number; coverFeeCents: number };
  nextInvoice: { date: string; lines: { description: string; cents: number }[]; totalCents: number } | null;
  addOns: { id: string; addOnId: string; code: string; name: string; priceCents: number; interval: string; quantity: number; cancelAt: string | null }[];
  availableAddOns: { id: string; code: string; name: string; description: string | null; priceCents: number; interval: string; perLocation: boolean }[];
  invoices: { id: string; number: string; kind: string; status: string; totalCents: number; dueAt: string; createdAt: string }[];
  promotions: { code: string; name: string; kind: string; percentOff: number; periods: number; periodsUsed: number; endsAt: string | null; active: boolean }[];
}
interface Preview { plan: { code: string; name: string; subscriptionCents: number; interval: string; perLocation: boolean; trialDays: number; fees: FeeRuleDto[] }; current: { name: string } | null; direction: 'UPGRADE' | 'DOWNGRADE' | 'SAME'; effectiveFrom: string; usedChargeCents: number; gained: string[]; lost: string[]; limits: { name: string; from: number | null; to: number | null }[]; warnings: string[]; agreementVersion: string }

const STATUS: Record<string, string> = { TRIAL: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment overdue', PAUSED: 'Paused by Gutad', CANCELED: 'Ended' };
const chan: Record<string, string> = { MARKETPLACE: 'Gutad marketplace', DIRECT: 'Your link', WIDGET: 'Widget', QR: 'QR', PARTNER: 'Partners' };

/** Plan & billing: current plan, usage this month, next invoice, switch plans (re-signing the Order Form), add-ons. */
export default function BillingPage() {
  const { org, reload: reloadOrg } = useMerchant();
  const { user } = useSession();
  const { data: b, reload } = useApi<Billing>(org ? `/organizations/${org.id}/billing` : null, { deps: [org?.id] });
  const { data: plans } = useApi<PublicPlanDto[]>('/public/plans');
  const [line, setLine] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [promo, setPromo] = useState('');
  const [promoMsg, setPromoMsg] = useState<string | null>(null);
  const { run, error, busy } = useAction();
  if (!org) return null;
  if (!b) return <Spinner />;
  const isOwner = !!user && (user.roles.includes('PLATFORM_ADMIN') || (org.members || []).some((m) => m.email === user.email && m.role === 'MERCHANT_OWNER'));
  const activeLine = line || plans?.find((p) => p.code === b.current?.planCode)?.productLine || 'ORDERING';
  const sub = b.subscription;
  const done = async () => { setPreview(null); await reload(); reloadOrg(); };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Plan & billing</h1>
      {error && <Alert>{error}</Alert>}
      {sub?.status === 'PAST_DUE' && <Alert>Your latest invoice is overdue. Pay it below to keep your plan in good standing.</Alert>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Current plan" className="lg:col-span-2">
          {b.current ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2"><span className="text-xl font-bold">{b.current.name}</span>{b.current.version && <span className="text-xs text-ink-500">v{b.current.version}</span>}{sub && <Badge tone={sub.status === 'ACTIVE' || sub.status === 'TRIAL' ? 'good' : sub.status === 'CANCELED' ? 'neutral' : 'warn'}>{STATUS[sub.status] || sub.status}</Badge>}{b.current.legacy && <Badge tone="info">Original terms · all features</Badge>}</div>
              <p className="text-sm text-ink-700">{b.current.subscriptionCents ? `${money(b.current.subscriptionCents)}/${b.current.interval === 'YEAR' ? 'year' : 'month'}` : 'No subscription'}{sub && sub.status !== 'CANCELED' && <> · {sub.status === 'TRIAL' ? `trial ends ${when(sub.trialEndsAt)}` : `renews ${when(sub.currentPeriodEnd)}`}</>}</p>
              <FeeList fees={b.current.fees} />
              {b.scheduledChange && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                  Switching to <b>{b.scheduledChange.name}</b> on {when(b.scheduledChange.effectiveFrom)}.
                  {isOwner && <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.delete(`/organizations/${org.id}/plan-change`); await done(); })}>Keep current plan</Button>}
                </div>
              )}
            </div>
          ) : <p className="text-sm text-ink-500">No plan yet. Choose one below; Gutad also sends your Order Form during onboarding.</p>}
        </Card>
        <Card title="Next invoice">
          {b.nextInvoice ? (
            <div className="text-sm">
              <div className="text-xs text-ink-500">{when(b.nextInvoice.date)}</div>
              <ul className="mt-1 space-y-0.5">{b.nextInvoice.lines.map((l, i) => <li key={i} className="flex justify-between gap-2"><span>{l.description}</span><span>{money(l.cents)}</span></li>)}</ul>
              <div className="mt-1 flex justify-between border-t border-ink-100 pt-1 font-semibold"><span>Subscription total</span><span>{money(b.nextInvoice.totalCents)}</span></div>
              <p className="mt-1 text-xs text-ink-500">Commissions and cover fees come out of your weekly payout, not this invoice.</p>
            </div>
          ) : <p className="text-sm text-ink-500">{sub?.status === 'TRIAL' ? 'Nothing during your trial.' : 'No recurring charges.'}</p>}
        </Card>
      </div>

      <Card title={`Usage since ${when(b.usage.since)}`}>
        <Table rows={b.usage.orders} empty="No orders yet this month." cols={[
          { key: 'c', label: 'Channel', render: (r) => chan[r.channel] || r.channel },
          { key: 'f', label: 'Type', render: (r) => r.fulfillment.toLowerCase().replace('_', '-') },
          { key: 'o', label: 'Orders', render: (r) => r.orders },
          { key: 's', label: 'Sales', render: (r) => money(r.salesCents) },
          { key: 'm', label: 'Commission', render: (r) => money(r.commissionCents) },
        ]} />
        <p className="mt-2 text-sm text-ink-700">Seated covers billed: <b>{b.usage.covers}</b> · cover fees {money(b.usage.coverFeeCents)}</p>
      </Card>

      <Card title="Change plan">
        {!isOwner && <p className="mb-2 text-sm text-ink-500">Only the account owner can change the plan.</p>}
        <div className="mb-3 flex flex-wrap gap-2">{PRODUCT_LINES.map((l) => <button key={l.key} onClick={() => setLine(l.key)} className={`rounded-full px-3 py-1 text-sm ${activeLine === l.key ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-700'}`}>{l.label}</button>)}</div>
        <div className="grid gap-3 md:grid-cols-3">
          {plans?.filter((p) => p.productLine === activeLine).map((p) => {
            const isCurrent = b.current?.planCode === p.code && !b.current.legacy && b.current.version === p.version;
            return (
              <div key={p.code} className={`rounded-xl border p-4 text-sm ${isCurrent ? 'border-emerald-300 bg-emerald-50' : 'border-ink-100 bg-white'}`}>
                <div className="flex justify-between gap-2 font-semibold"><span>{p.name}</span><span>{planPrice(p)}</span></div>
                <FeeList fees={p.fees} className="mt-1 text-xs" />
                <div className="mt-3">{isCurrent ? <Badge tone="good">Your plan</Badge> : <Button size="sm" disabled={!isOwner || busy} onClick={() => run(async () => setPreview(await api.get<Preview>(`/organizations/${org.id}/plan-change/preview?plan=${p.code}`)))}>Review switch</Button>}</div>
              </div>
            );
          })}
        </div>
        {isOwner && b.current && b.current.subscriptionCents > 0 && b.current.planCode !== b.defaultPlanCode && !b.scheduledChange && (
          <button className="mt-3 text-xs text-ink-500 underline" onClick={() => run(async () => setPreview(await api.get<Preview>(`/organizations/${org.id}/plan-change/preview?plan=${b.defaultPlanCode}`)))}>Cancel subscription (move to the free plan at renewal)</button>
        )}
        <p className="mt-2 text-xs text-ink-500">Upgrades start today: your current plan is billed for the days used and a new billing period begins. Downgrades and cancellations take effect at your next renewal. <Link className="underline" href="/pricing" target="_blank">Compare all features</Link></p>
      </Card>

      <Card title="Add-ons">
        {b.addOns.length > 0 && (
          <ul className="mb-3 divide-y divide-ink-100 text-sm">{b.addOns.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><span><b>{a.name}</b> · {a.priceCents ? `${money(a.priceCents)}/${a.interval === 'YEAR' ? 'yr' : 'mo'}` : 'included'}{a.quantity > 1 ? ` × ${a.quantity}` : ''}{a.cancelAt && <span className="text-xs text-amber-700"> · ends {when(a.cancelAt)}</span>}</span>{a.cancelAt ? <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.post(`/organizations/${org.id}/add-ons`, { addOnId: a.addOnId }); await done(); })}>Keep</Button> : <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.delete(`/organizations/${org.id}/add-ons/${a.id}`); await done(); })}>Cancel</Button>}</li>)}</ul>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          {b.availableAddOns.map((a) => (
            <div key={a.id} className="rounded-xl border border-ink-100 p-4 text-sm">
              <div className="flex justify-between gap-2 font-semibold"><span>{a.name}</span><span>{a.priceCents ? `${money(a.priceCents)}/${a.interval === 'YEAR' ? 'yr' : 'mo'}${a.perLocation ? ' per location' : ''}` : 'Free'}</span></div>
              {a.description && <p className="mt-1 text-xs text-ink-500">{a.description}</p>}
              <Button className="mt-3" size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/organizations/${org.id}/add-ons`, { addOnId: a.id }); await done(); })}>Add</Button>
            </div>
          ))}
          {!b.availableAddOns.length && <p className="text-sm text-ink-500">No other add-ons available.</p>}
        </div>
        <p className="mt-2 text-xs text-ink-500">Adding mid-period charges the rest of the current period now. Canceling keeps the add-on until your renewal date.</p>
      </Card>

      <Card title="Promotion code">
        <div className="flex flex-wrap items-end gap-2">
          <Input label="Code" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="e.g. WELCOME3" />
          <Button variant="secondary" disabled={promo.trim().length < 2 || busy} onClick={() => run(async () => { const r = await api.post<{ name: string; kind: string; endsAt: string | null }>(`/organizations/${org.id}/promotions`, { code: promo }); setPromoMsg(`${r.name} applied${r.endsAt ? ` until ${when(r.endsAt)}` : ' to your next renewal invoices'}.`); setPromo(''); await done(); })}>Apply</Button>
        </div>
        {promoMsg && <p className="mt-2 text-sm text-emerald-700">{promoMsg}</p>}
        {b.promotions.length > 0 && <ul className="mt-3 space-y-1 text-sm">{b.promotions.map((p) => <li key={p.code} className="flex flex-wrap items-center gap-2"><Badge tone={p.active ? 'good' : 'neutral'}>{p.active ? 'active' : 'used'}</Badge><b>{p.code}</b> {p.name} · {p.kind === 'COMMISSION_HOLIDAY' ? `no marketplace commission until ${when(p.endsAt)}` : p.kind === 'FREE_PERIODS' ? `free subscription, ${p.periods - p.periodsUsed} of ${p.periods} renewals left` : `${p.percentOff}% off, ${p.periods - p.periodsUsed} of ${p.periods} renewals left`}</li>)}</ul>}
      </Card>

      <Card title="Invoices">
        <Table rows={b.invoices} empty="No invoices yet." cols={[
          { key: 'n', label: 'Number', render: (r) => r.number },
          { key: 'd', label: 'Date', render: (r) => when(r.createdAt) },
          { key: 'k', label: 'Kind', render: (r) => r.kind.toLowerCase() },
          { key: 't', label: 'Total', render: (r) => money(r.totalCents) },
          { key: 's', label: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
          { key: 'a', label: '', render: (r) => r.status === 'OPEN' || r.status === 'PAST_DUE' ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/invoices/${r.id}/pay`, {}); await done(); })}>Pay</Button> : null },
        ]} />
      </Card>

      {preview && <SwitchModal orgId={org.id} p={preview} onClose={() => setPreview(null)} onDone={done} />}
    </div>
  );
}

function SwitchModal({ orgId, p, onClose, onDone }: { orgId: string; p: Preview; onClose: () => void; onDone: () => void }) {
  const [sig, setSig] = useState({ name: '', title: '', agree: false });
  const { run, error, busy } = useAction();
  const now = p.direction === 'UPGRADE' || new Date(p.effectiveFrom).getTime() - Date.now() < 60_000;
  return (
    <Modal open onClose={onClose} title={`Switch to ${p.plan.name}`}>
      <div className="space-y-3 text-sm">
        <p><b>{p.direction === 'UPGRADE' ? 'Upgrade' : 'Change'}</b> from {p.current?.name || 'no plan'} to <b>{p.plan.name}</b> ({planPrice({ subscriptionCents: p.plan.subscriptionCents, interval: p.plan.interval as 'MONTH' | 'YEAR', perLocation: p.plan.perLocation })}), {now ? <b>starting today</b> : <>on <b>{when(p.effectiveFrom)}</b> (your renewal date)</>}.</p>
        {p.usedChargeCents > 0 && <p>You&apos;ll be invoiced <b>{money(p.usedChargeCents)}</b> for the days used on your current plan, and the new plan&apos;s billing period starts today.</p>}
        {p.plan.trialDays > 0 && <p className="text-emerald-700">Includes a {p.plan.trialDays}-day free trial.</p>}
        <FeeList fees={p.plan.fees} />
        {p.gained.length > 0 && <p className="text-emerald-700">You gain: {p.gained.join(', ')}</p>}
        {p.limits.length > 0 && <p>Limits: {p.limits.map((l) => `${l.name} ${l.from ?? '∞'} → ${l.to ?? '∞'}`).join(' · ')}</p>}
        {p.warnings.map((w) => <Alert key={w} tone="info">{w}</Alert>)}
        <details className="rounded-lg border border-ink-100 p-2"><summary className="cursor-pointer text-xs font-medium">Merchant Agreement (applies to this Order Form)</summary><div className="mt-2 max-h-48 overflow-y-auto"><MerchantAgreementText /></div></details>
        <div className="grid gap-2 sm:grid-cols-2"><Input label="Full legal name (signature)" value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} /><Input label="Title" value={sig.title} onChange={(e) => setSig({ ...sig, title: e.target.value })} /></div>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={sig.agree} onChange={(e) => setSig({ ...sig, agree: e.target.checked })} /> I&apos;m authorized to sign and accept the new Order Form and the Merchant Agreement.</label>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Not now</Button><Button disabled={!sig.agree || sig.name.trim().length < 2 || busy} onClick={() => run(async () => { await api.post(`/organizations/${orgId}/plan-change`, { planCode: p.plan.code, signatureName: sig.name, signatureTitle: sig.title || undefined, agreementVersion: p.agreementVersion }); onDone(); })}>Sign and switch</Button></div>
      </div>
    </Modal>
  );
}
