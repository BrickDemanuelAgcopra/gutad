'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CHEF_DOC_STATE_LABELS, CHEF_QUALITY_ACTIONS, CHEF_QUALITY_EVENT_LABELS, type ChefDocState, type ChefQualityAction } from '@gutad/shared';
import { api, money, uploadFile, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, Input, Modal, Select, Spinner, Stat, Table, Textarea } from '@/components/ui';

// ───── shared shapes (API: chef-ops.service.ts) ─────

export interface DocStatus { key: string; label: string; needsExpiry: boolean; state: ChefDocState; expiresAt: string | null; docId: string | null; pendingDocId: string | null; pendingFileId: string | null; note: string | null }
export interface ChefMetrics { chefId: string; displayName: string; slug: string; organizationId: string; status: string; statusCause: string | null; acceptingOrders: boolean; orders: number; completed: number; declined: number; unconfirmed: number; canceled: number; gmvCents: number; avgAcceptMinutes: number | null; incidents: number; foodSafety: number; incidentRatePct: number | null; declineRatePct: number | null; rating: number | null; ratings: number; requests: number; avgRequestResponseMinutes: number | null; flags: string[] }
interface QualityEvent { id: string; kind: string; label: string; source: string; note: string; createdAt: string; chefName?: string; chefProfileId?: string }
export interface Earnings { chefId: string; organizationId: string; displayName: string; payableCents: number; heldCents: number; heldOrders: number; last30: { orders: number; foodCents: number; commissionCents: number; netCents: number }; orders: { id: string; number: string; status: string; createdAt: string; scheduledFor: string | null; foodCents: number; taxCents: number; commissionCents: number; netCents: number; state: 'HELD' | 'EARNED' | 'NONE' }[]; adjustments: { id: string; createdAt: string; memo: string; cents: number }[] }

const DOC_TONE: Record<ChefDocState, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { VALID: 'good', EXPIRING: 'warn', EXPIRED: 'bad', MISSING: 'neutral', IN_REVIEW: 'info', REJECTED: 'bad' };
const FLAG_LABEL: Record<string, string> = { FOOD_SAFETY: 'Food-safety report', INCIDENT_RATE: 'High incident rate', DECLINE_RATE: 'High decline rate' };
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export function DocBadge({ state }: { state: ChefDocState }) {
  return <Badge tone={DOC_TONE[state]}>{CHEF_DOC_STATE_LABELS[state]}</Badge>;
}

// ───── Admin: Kitchens tab ─────

interface KitchenRow { chefId: string; displayName: string; slug: string; status: string; statusCause: string | null; statusReason: string | null; acceptingOrders: boolean; kitchenType: string | null; region: string | null; kitchen: { name: string; addressLine1: string; city: string; region: string } | null; documents: DocStatus[]; worst: ChefDocState; nextExpiry: string | null; pendingReviews: number }

/** Every chef kitchen with its required documents (worst first); approve or reject renewals in place. */
export function KitchensTab() {
  const { can } = useSession();
  const { data, error, reload } = useApi<{ kitchens: KitchenRow[]; counts: { expired: number; expiring: number; inReview: number } }>('/admin/chef-kitchens');
  const act = useAction();
  const [reject, setReject] = useState<{ docId: string; label: string } | null>(null);
  const [note, setNote] = useState('');
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const review = (docId: string, status: 'APPROVED' | 'REJECTED', n?: string) => act.run(async () => { await api.post(`/admin/chef-documents/${docId}/review`, { status, note: n }); setReject(null); setNote(''); await reload(); });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Kitchens with an expired document" value={data.counts.expired} />
        <Stat label="Documents expiring in 30 days" value={data.counts.expiring} />
        <Stat label="Renewals waiting for review" value={data.counts.inReview} />
      </div>
      <p className="text-xs text-ink-500">A required document that expires pauses the chef automatically (setting in Fees & policy). Approving the renewal reopens them within the hour; the chef then switches availability back on.</p>
      {act.error && <Alert>{act.error}</Alert>}
      {!data.kitchens.length ? <Empty>No chef kitchens yet.</Empty> : (
        <div className="space-y-3">
          {data.kitchens.map((k) => (
            <div key={k.chefId} className="rounded-xl border border-ink-100 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/chefs/${k.slug}`} className="font-semibold underline">{k.displayName}</Link>
                <Badge tone={k.status === 'ACTIVE' ? 'good' : k.status === 'SUSPENDED' ? 'bad' : 'warn'}>{k.status.toLowerCase()}{k.statusCause ? ` · ${k.statusCause.toLowerCase()}` : ''}</Badge>
                <span className="text-xs text-ink-500">{k.kitchen ? `${k.kitchen.name} · ${k.kitchen.addressLine1}, ${k.kitchen.city} ${k.kitchen.region}` : 'No kitchen'}{k.kitchenType ? ` · ${k.kitchenType.replace(/_/g, ' ').toLowerCase()}` : ''}</span>
                {k.nextExpiry && <span className="ml-auto text-xs text-ink-500">Next expiry {day(k.nextExpiry)}</span>}
              </div>
              {k.statusReason && k.status !== 'ACTIVE' && <p className="mt-1 text-xs text-ink-600">{k.statusReason}</p>}
              <ul className="mt-3 divide-y divide-ink-100 text-sm">
                {k.documents.map((d) => (
                  <li key={d.key} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1">{d.label}</span>
                    <DocBadge state={d.state} />
                    <span className="w-28 text-right text-xs text-ink-500">{d.expiresAt ? `exp. ${day(d.expiresAt)}` : ''}</span>
                    {d.pendingDocId && (
                      <span className="flex gap-1">
                        {d.pendingFileId && <Button size="sm" variant="ghost" onClick={() => void api.get<{ url: string }>(`/chef/files/${d.pendingFileId}/link`).then((r) => window.open(r.url, '_blank'))}>View renewal</Button>}
                        {can('chefs.manage') && <><Button size="sm" disabled={act.busy} onClick={() => void review(d.pendingDocId!, 'APPROVED')}>Approve</Button><Button size="sm" variant="secondary" onClick={() => setReject({ docId: d.pendingDocId!, label: d.label })}>Reject</Button></>}
                      </span>
                    )}
                  </li>
                ))}
                {!k.documents.length && <li className="py-1.5 text-xs text-ink-500">No required documents for this region and kitchen type.</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
      <Modal open={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.label || 'renewal'}`}>
        <div className="space-y-3">
          <Textarea label="Tell the chef what to fix" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          <Button variant="danger" disabled={note.trim().length < 3 || act.busy} onClick={() => reject && void review(reject.docId, 'REJECTED', note)}>Reject renewal</Button>
        </div>
      </Modal>
    </div>
  );
}

// ───── Admin: Quality tab and chef record ─────

export function QualityTab() {
  const [days, setDays] = useState('30');
  const { data, error } = useApi<{ windowDays: number; policy: { minOrders: number; maxIncidentRatePct: number; maxDeclineRatePct: number }; chefs: ChefMetrics[]; events: QualityEvent[]; openFoodSafety: { id: string; status: string; description: string; created_at: string; number: string; chef: string; item: string | null }[] }>(`/admin/chef-quality?days=${days}`);
  const [open, setOpen] = useState<ChefMetrics | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40"><Select label="Window" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select></div>
        <p className="text-xs text-ink-500">Rates are judged from {data.policy.minOrders} orders. Limits: incidents {data.policy.maxIncidentRatePct}%, declined or unconfirmed {data.policy.maxDeclineRatePct}%. Food-safety reports act automatically.</p>
      </div>
      {data.openFoodSafety.length > 0 && (
        <Card title={`Open food-safety reports (${data.openFoodSafety.length})`}>
          <ul className="space-y-1 text-sm">{data.openFoodSafety.map((i) => <li key={i.id}><Link href={`/admin/support?incident=${i.id}`} className="underline">{i.chef} · order {i.number}{i.item ? ` · ${i.item}` : ''}</Link> <span className="text-xs text-ink-500">— {i.description.slice(0, 120)} · {when(i.created_at)}</span></li>)}</ul>
        </Card>
      )}
      <Table rows={data.chefs} empty="No chefs yet." cols={[
        { key: 'c', label: 'Chef', render: (m) => <button className="text-left font-medium underline" onClick={() => setOpen(m)}>{m.displayName}</button> },
        { key: 's', label: 'Status', render: (m) => <Badge tone={m.status === 'ACTIVE' ? 'good' : m.status === 'SUSPENDED' ? 'bad' : 'warn'}>{m.status.toLowerCase()}</Badge> },
        { key: 'o', label: 'Orders', render: (m) => m.orders, className: 'text-right' },
        { key: 'i', label: 'Incidents', render: (m) => `${m.incidents} · ${pct(m.incidentRatePct)}`, className: 'text-right' },
        { key: 'd', label: 'Declined / unconfirmed', render: (m) => `${m.declined} · ${pct(m.declineRatePct)}`, className: 'text-right' },
        { key: 'a', label: 'Avg confirm', render: (m) => mins(m.avgAcceptMinutes), className: 'text-right' },
        { key: 'r', label: 'Rating', render: (m) => (m.rating === null ? '—' : `${m.rating.toFixed(1)} (${m.ratings})`), className: 'text-right' },
        { key: 'f', label: 'Flags', render: (m) => <div className="flex flex-wrap gap-1">{m.flags.map((f) => <Badge key={f} tone="bad">{FLAG_LABEL[f] || f}</Badge>)}</div> },
      ]} />
      <Card title="Recent quality actions">
        {!data.events.length ? <p className="text-sm text-ink-500">None yet.</p> : <ul className="space-y-1.5 text-sm">{data.events.map((e) => <li key={e.id}><strong>{e.chefName}</strong> · <Badge tone={e.source === 'AUTO' ? 'info' : 'neutral'}>{e.label}</Badge> {e.note} <span className="text-xs text-ink-500">· {e.source === 'AUTO' ? 'automatic' : 'staff'} · {when(e.createdAt)}</span></li>)}</ul>}
      </Card>
      {open && <ChefRecordModal chefId={open.chefId} name={open.displayName} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One chef's quality record, actions, and earnings (with adjustments). */
export function ChefRecordModal({ chefId, name, onClose }: { chefId: string; name: string; onClose: () => void }) {
  const { can } = useSession();
  const { data, reload } = useApi<{ metrics: ChefMetrics; events: QualityEvent[]; dishes: { id: string; dishName: string; reviewStatus: string }[] }>(`/admin/chefs/${chefId}/quality`);
  const { data: earn, reload: reloadEarn } = useApi<Earnings>(`/admin/chefs/${chefId}/earnings`);
  const act = useAction();
  const [action, setAction] = useState<ChefQualityAction>('WARNING');
  const [dishId, setDishId] = useState('');
  const [note, setNote] = useState('');
  const [adj, setAdj] = useState({ amount: '', kind: 'Goodwill', note: '' });
  const dishAction = action === 'DISH_SUSPENDED' || action === 'DISH_REINSTATED';
  const m = data?.metrics;
  return (
    <Modal open onClose={onClose} title={`${name}: quality & earnings`}>
      {!data || !m ? <Spinner /> : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div><div className="text-xs text-ink-500">Orders ({m.completed} completed)</div><div className="font-semibold">{m.orders}</div></div>
            <div><div className="text-xs text-ink-500">Incidents</div><div className="font-semibold">{m.incidents} · {pct(m.incidentRatePct)}{m.foodSafety ? ` · ${m.foodSafety} food safety` : ''}</div></div>
            <div><div className="text-xs text-ink-500">Declined / unconfirmed</div><div className="font-semibold">{m.declined} ({m.unconfirmed} unconfirmed) · {pct(m.declineRatePct)}</div></div>
            <div><div className="text-xs text-ink-500">Request response</div><div className="font-semibold">{mins(m.avgRequestResponseMinutes)} · {m.requests} requests</div></div>
          </div>
          {m.flags.length > 0 && <div className="flex flex-wrap gap-1">{m.flags.map((f) => <Badge key={f} tone="bad">{FLAG_LABEL[f] || f}</Badge>)}</div>}
          {can('chefs.manage') && (
            <form className="space-y-2 rounded-xl border border-ink-100 p-3" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api.post(`/admin/chefs/${chefId}/quality`, { action, note, dishId: dishAction ? dishId : undefined }); setNote(''); await reload(); }); }}>
              <div className="font-medium">Record an action</div>
              <Select label="Action" value={action} onChange={(e) => setAction(e.target.value as ChefQualityAction)}>{CHEF_QUALITY_ACTIONS.map((a) => <option key={a} value={a}>{CHEF_QUALITY_EVENT_LABELS[a]}</option>)}</Select>
              {dishAction && <Select label="Dish" value={dishId} onChange={(e) => setDishId(e.target.value)} required><option value="">Choose a dish</option>{data.dishes.filter((d) => (action === 'DISH_SUSPENDED' ? d.reviewStatus === 'PUBLISHED' : d.reviewStatus === 'SUSPENDED')).map((d) => <option key={d.id} value={d.id}>{d.dishName}</option>)}</Select>}
              <Textarea label={action === 'NOTE' ? 'Internal note (the chef doesn’t see it)' : 'Note (sent to the chef)'} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              {act.error && <Alert>{act.error}</Alert>}
              <Button type="submit" size="sm" disabled={act.busy || note.trim().length < 5 || (dishAction && !dishId)}>Record</Button>
            </form>
          )}
          <div>
            <div className="mb-1 font-medium">Record</div>
            {!data.events.length ? <p className="text-ink-500">Nothing recorded.</p> : <ul className="max-h-48 space-y-1 overflow-y-auto">{data.events.map((e) => <li key={e.id}><Badge tone={e.source === 'AUTO' ? 'info' : 'neutral'}>{e.label}</Badge> {e.note} <span className="text-xs text-ink-500">· {when(e.createdAt)}</span></li>)}</ul>}
          </div>
          {earn && (
            <div className="space-y-2 border-t border-ink-100 pt-3">
              <div className="font-medium">Earnings</div>
              <div className="grid grid-cols-3 gap-2"><div><div className="text-xs text-ink-500">Payable</div><div className="font-semibold">{money(earn.payableCents)}</div></div><div><div className="text-xs text-ink-500">Held ({earn.heldOrders})</div><div className="font-semibold">{money(earn.heldCents)}</div></div><div><div className="text-xs text-ink-500">Net, 30 days</div><div className="font-semibold">{money(earn.last30.netCents)}</div></div></div>
              {earn.adjustments.length > 0 && <ul className="text-xs">{earn.adjustments.slice(0, 5).map((a) => <li key={a.id}>{when(a.createdAt)} · {a.cents > 0 ? '+' : ''}{money(a.cents)} · {a.memo}</li>)}</ul>}
              {can('finance.manage') ? (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { const cents = Math.round(Number(adj.amount) * 100); await api.post('/finance/adjustments', { organizationId: earn.organizationId, cents, reason: `${adj.kind}: ${adj.note}` }); setAdj({ amount: '', kind: adj.kind, note: '' }); await reloadEarn(); }); }}>
                  <div className="w-28"><Input label="Amount ($, − to charge)" type="number" step="0.01" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></div>
                  <div className="w-36"><Select label="Type" value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}><option>Goodwill</option><option>Correction</option><option>Incident chargeback</option><option>Dispute resolution</option></Select></div>
                  <div className="min-w-0 flex-1"><Input label="Reason" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></div>
                  <Button type="submit" size="sm" variant="secondary" disabled={act.busy || !Number(adj.amount) || adj.note.trim().length < 3}>Post adjustment</Button>
                </form>
              ) : <p className="text-xs text-ink-500">Adjustments need the finance permission. Statement disputes: <Link className="underline" href="/admin/finance">Finance</Link>.</p>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ───── Chef: earnings and compliance ─────

export function EarningsView({ e }: { e: Earnings }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Payable" value={money(e.payableCents)} hint="Paid out weekly" />
        <Stat label="Held until completion" value={money(e.heldCents)} hint={`${e.heldOrders} upcoming order${e.heldOrders === 1 ? '' : 's'}`} />
        <Stat label="Earned, last 30 days" value={money(e.last30.netCents)} hint={`${e.last30.orders} orders · commission ${money(e.last30.commissionCents)}`} />
      </div>
      <p className="text-xs text-ink-500">Customers pay Gutad at checkout. Each order’s food + tax − commission is credited to you when the order is completed, then paid in the weekly payout. Declined or cancelled orders earn nothing (a late cancellation keeps your late-refund share).</p>
      <Card title="Orders">
        <Table rows={e.orders} empty="No orders yet." cols={[
          { key: 'n', label: 'Order', render: (o) => <span>{o.number}<span className="block text-xs text-ink-500">{o.scheduledFor ? `for ${day(o.scheduledFor)}` : day(o.createdAt)}</span></span> },
          { key: 's', label: 'Status', render: (o) => <Badge tone={o.state === 'EARNED' ? 'good' : o.state === 'HELD' ? 'info' : 'neutral'}>{o.state === 'EARNED' ? 'earned' : o.state === 'HELD' ? 'held' : o.status.toLowerCase()}</Badge> },
          { key: 'f', label: 'Food', render: (o) => money(o.foodCents), className: 'text-right' },
          { key: 't', label: 'Tax', render: (o) => money(o.taxCents), className: 'text-right' },
          { key: 'c', label: 'Commission', render: (o) => (o.state === 'NONE' ? '—' : `−${money(o.commissionCents)}`), className: 'text-right' },
          { key: 'v', label: 'You get', render: (o) => <b>{money(o.netCents)}</b>, className: 'text-right' },
        ]} />
      </Card>
      <Card title="Adjustments">
        {!e.adjustments.length ? <p className="text-sm text-ink-500">None.</p> : <ul className="space-y-1 text-sm">{e.adjustments.map((a) => <li key={a.id} className="flex justify-between gap-2"><span>{a.memo} <span className="text-xs text-ink-500">· {when(a.createdAt)}</span></span><span className={a.cents < 0 ? 'text-red-700' : 'text-emerald-700'}>{a.cents > 0 ? '+' : ''}{money(a.cents)}</span></li>)}</ul>}
      </Card>
    </div>
  );
}

interface Compliance { status: string; statusCause: string | null; statusReason: string | null; documents: DocStatus[]; metrics: { orders: number; completed: number; declineRatePct: number | null; incidentRatePct: number | null; avgAcceptMinutes: number | null; rating: number | null; ratings: number; avgRequestResponseMinutes: number | null } | null; thresholds: { windowDays: number; minOrders: number; maxIncidentRatePct: number; maxDeclineRatePct: number }; events: { id: string; kind: string; label: string; note: string; createdAt: string }[] }

/** The chef's documents (renewals) and quality record. */
export function ComplianceView() {
  const { data, error, reload } = useApi<Compliance>('/chef/compliance');
  const act = useAction();
  const [renew, setRenew] = useState<DocStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [expires, setExpires] = useState('');
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const m = data.metrics;
  const t = data.thresholds;
  const upload = () => act.run(async () => {
    const fd = new FormData();
    fd.append('file', file!);
    fd.append('requirementKey', renew!.key);
    if (expires) fd.append('expiresAt', expires);
    await uploadFile('/chef/application/documents', fd);
    setRenew(null); setFile(null); setExpires('');
    await reload();
  });
  return (
    <div className="space-y-4">
      {data.status !== 'ACTIVE' && <Alert>{data.statusCause === 'DOCUMENTS' ? 'Your listings are paused because a required document expired. Upload the renewal below; we reopen your account as soon as it’s approved.' : `Your chef account is ${data.status.toLowerCase()}${data.statusReason ? `: ${data.statusReason}` : ''}.`}</Alert>}
      <Card title="Required documents">
        <ul className="divide-y divide-ink-100 text-sm">
          {data.documents.map((d) => (
            <li key={d.key} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 font-medium">{d.label}{d.note && d.state === 'REJECTED' && <span className="block text-xs font-normal text-red-700">{d.note}</span>}</span>
              <DocBadge state={d.state} />
              <span className="w-32 text-right text-xs text-ink-500">{d.expiresAt ? `${d.state === 'EXPIRED' ? 'expired' : 'expires'} ${day(d.expiresAt)}` : ''}</span>
              {d.state !== 'VALID' && d.state !== 'IN_REVIEW' && <Button size="sm" variant={d.state === 'EXPIRED' ? 'primary' : 'secondary'} onClick={() => setRenew(d)}>{d.state === 'MISSING' ? 'Upload' : 'Upload renewal'}</Button>}
            </li>
          ))}
          {!data.documents.length && <li className="py-2 text-ink-500">No documents are required for your kitchen.</li>}
        </ul>
        <p className="mt-2 text-xs text-ink-500">We remind you before documents expire. If a required document expires, your dishes pause until the renewal is approved.</p>
      </Card>
      {m && (
        <Card title={`Your last ${t.windowDays} days`}>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Orders" value={m.orders} hint={`${m.completed} completed`} />
            <Stat label="Declined or unconfirmed" value={pct(m.declineRatePct)} hint={`Gutad limit ${t.maxDeclineRatePct}%`} />
            <Stat label="Customer problems" value={pct(m.incidentRatePct)} hint={`Gutad limit ${t.maxIncidentRatePct}%`} />
            <Stat label="Rating" value={m.rating === null ? '—' : m.rating.toFixed(1)} hint={`${m.ratings} ratings`} />
          </div>
          <p className="mt-2 text-xs text-ink-500">Rates count once you have {t.minOrders} orders in the window. Average confirmation {mins(m.avgAcceptMinutes)}; special-request replies {mins(m.avgRequestResponseMinutes)}.</p>
        </Card>
      )}
      <Card title="Quality record">
        {!data.events.length ? <p className="text-sm text-ink-500">Nothing on your record. Keep it up!</p> : <ul className="space-y-1.5 text-sm">{data.events.map((e) => <li key={e.id}><Badge tone={['DISH_REINSTATED', 'CHEF_REINSTATED'].includes(e.kind) ? 'good' : 'warn'}>{e.label}</Badge> {e.note} <span className="text-xs text-ink-500">· {when(e.createdAt)}</span></li>)}</ul>}
      </Card>
      <Modal open={!!renew} onClose={() => setRenew(null)} title={`Upload ${renew?.label || ''}`}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void upload(); }}>
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="block w-full text-sm" />
          {renew?.needsExpiry && <Input label="Expiry date on the document" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required />}
          {act.error && <Alert>{act.error}</Alert>}
          <Button type="submit" disabled={act.busy || !file || (!!renew?.needsExpiry && !expires)}>{act.busy ? 'Uploading…' : 'Send for review'}</Button>
        </form>
      </Modal>
    </div>
  );
}
