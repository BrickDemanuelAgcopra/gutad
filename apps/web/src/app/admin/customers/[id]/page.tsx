'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Select, statusTone, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';

interface P {
  customer: { id: string; name: string | null; email: string; phone: string | null; status: string; statusReason: string | null; isGuest: boolean; createdAt: string; marketingConsent: boolean; smsConsent: boolean; notificationPrefs: Record<string, Record<string, boolean>>; paymentCustomerRef: string | null; mfaEnabled: boolean; dietaryNotes: string | null };
  piiVisible: boolean;
  addresses: { id: string; label?: string | null; line1?: string; city: string; region: string; isDefault: boolean }[];
  orders: { id: string; number: string; status: string; totalCents: number; createdAt: string }[];
  stats: { orders: number; spendCents: number };
  incidents: { id: string; category: string; status: string; remedy: string | null; remedyCents: number; createdAt: string }[];
  refunds: { id: string; amountCents: number; reason: string | null; funder: string; createdAt: string }[];
  credits: { balanceCents: number; entries: { id: string; cents: number; redeemedCents: number; reason: string | null; expiresAt: string | null }[] };
  loyaltyPoints: number;
  memberships: { id: string; planName: string; status: string; currentPeriodEnd: string }[];
  reservations: { id: string; status: string; startAt: string; partySize: number }[];
  paymentMethods: { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean }[];
  restrictions: { id: string; kind: string; reason: string; expiresAt: string | null; liftedAt: string | null; appealStatus: string; appealNote: string | null; createdAt: string }[];
  privacyRequests: { id: string; kind: string; status: string; scheduledFor: string | null; createdAt: string }[];
  goodwill: { count90d: number; cents90d: number; maxCount90d: number; maxCents90d: number; overCount: boolean; overCents: boolean };
  duplicates: { id: string; email: string; name: string | null; why: string[]; createdAt: string }[];
}

/** Customer 360: profile and preferences, orders, complaints, refunds, credits, memberships, cards, restrictions, privacy, duplicates. */
export default function Customer() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: p, reload } = useApi<P>(`/admin/customers/${id}`);
  const { run, error } = useAction();
  const [kind, setKind] = useState('ORDERING_BLOCKED');
  const [ok, setOk] = useState<string | null>(null);
  if (!p) return null;
  const c = p.customer;
  return (
    <div className="space-y-4">
      <div><Link href="/admin/customers" className="text-xs text-ink-500 underline">← Customers</Link><h1 className="text-2xl font-bold">{c.name || c.email}</h1><p className="text-sm text-ink-500">{c.email}{c.phone ? ` · ${c.phone}` : ''} · since {when(c.createdAt)} {!p.piiVisible && <i>(contact details hidden for your role)</i>}</p><div className="mt-1 flex flex-wrap gap-1"><Badge tone={statusTone(c.status)}>{c.status}</Badge>{c.isGuest && <Badge>guest</Badge>}{c.mfaEnabled && <Badge tone="good">2FA</Badge>}{c.statusReason && <span className="text-xs text-ink-500">{c.statusReason}</span>}</div></div>
      {error && <Alert>{error}</Alert>}{ok && <Alert tone="good">{ok}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[['Orders', p.stats.orders], ['Spend', money(p.stats.spendCents)], ['Credit balance', money(p.credits.balanceCents)], ['Loyalty points', p.loyaltyPoints], ['Goodwill (90 days)', `${p.goodwill.count90d} · ${money(p.goodwill.cents90d)}`]].map(([l, v]) => <div key={l as string} className={`rounded-xl border p-3 ${l === 'Goodwill (90 days)' && (p.goodwill.overCount || p.goodwill.overCents) ? 'border-amber-300 bg-amber-50' : 'border-ink-100 bg-white'}`}><div className="text-xs text-ink-500">{l}</div><div className="text-lg font-bold">{v}</div></div>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orders">
          <Table rows={p.orders.slice(0, 15)} empty="No orders." cols={[{ key: 'n', label: 'Order', render: (o) => <Link className="underline" href={`/admin/orders/${o.id}`}>{o.number}</Link> }, { key: 's', label: 'Status', render: (o) => <Badge tone={statusTone(o.status)}>{o.status}</Badge> }, { key: 't', label: 'Total', render: (o) => money(o.totalCents) }, { key: 'd', label: 'Placed', render: (o) => <span className="text-xs">{when(o.createdAt)}</span> }]} />
        </Card>
        <Card title="Complaints, refunds & credits">
          {p.incidents.slice(0, 8).map((i) => <div key={i.id} className="flex justify-between border-b border-ink-50 py-1 text-sm"><span>{i.category.toLowerCase().replace(/_/g, ' ')} <span className="text-xs text-ink-500">{when(i.createdAt)}</span></span><span><Badge tone={statusTone(i.status)}>{i.status}</Badge>{i.remedyCents ? ` ${i.remedy?.toLowerCase()} ${money(i.remedyCents)}` : ''}</span></div>)}
          {p.refunds.slice(0, 5).map((r) => <div key={r.id} className="text-xs text-ink-500">Refund {money(r.amountCents)} · {r.funder.toLowerCase()} · {r.reason} · {when(r.createdAt)}</div>)}
          {p.credits.entries.slice(0, 5).map((e) => <div key={e.id} className="text-xs text-ink-500">Credit {money(e.cents)} ({money(e.redeemedCents)} used) · {e.reason}{e.expiresAt ? ` · expires ${when(e.expiresAt)}` : ''}</div>)}
          {!p.incidents.length && !p.refunds.length && <p className="text-sm text-ink-500">None.</p>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Contact & preferences">
          <div className="text-sm">Marketing email {c.marketingConsent ? 'on' : 'off'} · SMS {c.smsConsent ? 'on' : 'off'}</div>
          {Object.entries(c.notificationPrefs || {}).map(([t, v]) => <div key={t} className="text-xs text-ink-500">{t}: {Object.entries(v).filter(([, on]) => on === false).map(([ch]) => `no ${ch}`).join(', ') || 'all channels'}</div>)}
          <div className="mt-2 text-xs font-semibold text-ink-500">Addresses</div>{p.addresses.map((a) => <div key={a.id} className="text-sm">{a.line1 ? `${a.line1}, ` : ''}{a.city} {a.region}{a.isDefault && <Badge>default</Badge>}</div>)}
          {c.dietaryNotes && <div className="mt-2 text-xs">Dietary notes: {c.dietaryNotes}</div>}
        </Card>
        <Card title="Payment & memberships">
          <div className="text-xs text-ink-500">Processor customer: {c.paymentCustomerRef || '—'}</div>
          {p.paymentMethods.map((m) => <div key={m.id} className="text-sm">{m.brand} •••• {m.last4}{m.expMonth ? ` · ${m.expMonth}/${m.expYear}` : ''}{m.isDefault && <Badge>default</Badge>}</div>)}
          {!p.paymentMethods.length && <p className="text-sm text-ink-500">No saved cards.</p>}
          <p className="mt-1 text-xs text-ink-500">Only processor tokens and the last 4 digits are stored; full card numbers never reach Gutad.</p>
          {p.memberships.map((m) => <div key={m.id} className="mt-1 text-sm">{m.planName} · {m.status.toLowerCase()} · renews {when(m.currentPeriodEnd)}</div>)}
        </Card>
        <Card title="Restrictions">
          {p.restrictions.map((r) => <div key={r.id} className="border-b border-ink-50 py-1 text-sm"><div className="flex justify-between"><span>{r.kind.toLowerCase().replace(/_/g, ' ')}</span>{r.liftedAt ? <span className="text-xs text-emerald-700">lifted</span> : can('support.manage') && <button className="text-xs underline" onClick={() => { const note = window.prompt('Why lift it?'); if (note) run(async () => { await api.post(`/admin/restrictions/${r.id}/lift`, { note }); reload(); }); }}>Lift</button>}</div><div className="text-xs text-ink-500">{r.reason}{r.appealStatus !== 'NONE' ? ` · appeal ${r.appealStatus.toLowerCase()}: ${r.appealNote}` : ''}</div></div>)}
          {can('support.manage') && <div className="mt-2 flex gap-2"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="ORDERING_BLOCKED">Block ordering</option><option value="PROMOTIONS_BLOCKED">Block promotions</option><option value="REFUND_REVIEW">Review refunds</option></Select><Button size="sm" variant="secondary" onClick={() => { const reason = askReason('restricting this account'); if (reason) run(async () => { await api.post(`/admin/customers/${id}/restrictions`, { kind, reason }); reload(); }); }}>Add</Button></div>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account recovery & duplicates">
          {can('customers.pii') && <Button size="sm" variant="secondary" onClick={() => { const reason = askReason('sending a password reset'); if (reason) run(async () => { await api.post(`/admin/customers/${id}/send-recovery`, { reason }); setOk('Recovery link sent to the customer’s email.'); }); }}>Send recovery link</Button>}
          <div className="mt-2 text-xs font-semibold text-ink-500">Possible duplicates</div>
          {p.duplicates.map((d) => <div key={d.id} className="flex items-center justify-between py-1 text-sm"><span><Link className="underline" href={`/admin/customers/${d.id}`}>{d.email}</Link> <span className="text-xs text-ink-500">{d.why.join(', ')}</span></span>{can('customers.pii') && can('support.manage') && <Button size="sm" variant="ghost" onClick={() => { const reason = askReason(`merging ${d.email} into this account`); if (reason) run(async () => { await api.post(`/admin/customers/${d.id}/merge`, { intoUserId: id, reason }); setOk('Merged.'); reload(); }); }}>Merge into this</Button>}</div>)}
          {!p.duplicates.length && <p className="text-sm text-ink-500">None found (same email, phone or address).</p>}
        </Card>
        <Card title="Privacy">
          {p.privacyRequests.map((r) => <div key={r.id} className="text-sm">{r.kind.toLowerCase()} · {r.status.toLowerCase()} · {when(r.createdAt)}{r.scheduledFor ? ` · runs ${when(r.scheduledFor)}` : ''}</div>)}
          {!p.privacyRequests.length && <p className="text-sm text-ink-500">No requests.</p>}
          <p className="mt-1 text-xs text-ink-500">Requests are handled under Customers → Privacy requests.</p>
        </Card>
      </div>
      {p.reservations.length > 0 && <Card title="Reservations">{p.reservations.map((r) => <div key={r.id} className="text-sm">{when(r.startAt)} · {r.partySize} guests · {r.status.toLowerCase()}</div>)}</Card>}
    </div>
  );
}
