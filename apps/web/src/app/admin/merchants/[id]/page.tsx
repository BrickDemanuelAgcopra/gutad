'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table } from '@/components/ui';
import { askReason } from '@/components/admin-ui';

interface Detail {
  organization: { id: string; name: string; status: string; statusReason: string | null; statusChangedAt: string | null; website: string | null; taxId: string | null; billingEmail: string | null; owners: { name: string; title?: string; ownershipPct?: number; email?: string }[]; contacts: { name: string; role?: string; email?: string; phone?: string }[]; createdAt: string };
  accountManager: { id: string; email: string; name: string | null } | null;
  progressPct: number;
  locations: { id: string; name: string; city: string; status: string; isPaused: boolean; pausedReason: string | null; verifiedAt: string | null; readinessApprovedAt: string | null; progressPct: number; requiredOpen: string[] }[];
  members: { id: string; role: string; email: string; name: string | null; locationIds: string[]; approvalLimitCents: number }[];
  contracts: { id: string; version: number; name: string; planCode: string | null; signedAt: string | null; effectiveFrom: string; effectiveTo: string | null; fees: unknown }[];
  acceptances: { id: string; agreementVersion: string; signatureName: string; signatureTitle: string | null; acceptedAt: string; ipAddress: string | null }[];
  documents: { id: string; docType: string; fileName: string; status: string; expiresAt: string | null; reviewNote: string | null; createdAt: string }[];
  lifecycle: { id: string; action: string; reason: string | null; actorEmail: string | null; createdAt: string; before: { status?: string } | null }[];
  cases: { id: string; category: string; status: string; description: string; reporterType: string; createdAt: string }[];
  changeRequests: { id: string; kind: string; summary: string; status: string; createdAt: string }[];
}

/** Merchant 360: profile and owners, lifecycle, account manager, contracts, documents, team, locations with launch progress, cases. */
export default function MerchantDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: d, reload } = useApi<Detail>(`/admin/merchants/${id}`);
  const { data: staff } = useApi<{ id: string; email: string; roles: string[] }[]>(can('security.read') ? '/admin/security/staff' : null);
  const { run, error } = useAction();
  const [inv, setInv] = useState<{ email: string; role: string; locationIds: string[]; limit: string }>({ email: '', role: 'MERCHANT_MANAGER', locationIds: [], limit: '' });
  if (!d) return null;
  const o = d.organization;
  const manage = can('merchants.manage');
  const life = (action: string) => { const reason = askReason(`${action.toLowerCase()} ${o.name}`); if (reason) run(async () => { await api.post(`/admin/organizations/${id}/lifecycle`, { action, reason }); reload(); }); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><Link href="/admin/merchants" className="text-xs text-ink-500 underline">← Merchants</Link><h1 className="text-2xl font-bold">{o.name}</h1><p className="text-sm text-ink-500">Since {when(o.createdAt)} · onboarding {d.progressPct}% · account manager {d.accountManager?.email || 'unassigned'}</p></div>
        <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(o.status)}>{o.status}</Badge>{o.statusReason && <span className="text-xs text-ink-500">“{o.statusReason}”</span>}<a className="rounded-lg border border-ink-100 px-2.5 py-1.5 text-xs" href={`/merchant?support=${id}`}>View as merchant</a></div>
      </div>
      {error && <Alert>{error}</Alert>}
      {manage && (
        <Card title="Lifecycle">
          <div className="flex flex-wrap gap-2">
            {['PROSPECT', 'CLAIMED'].includes(o.status) && <Button size="sm" onClick={() => life('APPROVE')}>Approve</Button>}
            {!['LIVE', 'SUSPENDED', 'OFFBOARDED'].includes(o.status) && <Button size="sm" variant="secondary" onClick={() => life('ACTIVATE')}>Activate</Button>}
            {o.status !== 'SUSPENDED' && o.status !== 'OFFBOARDED' && <Button size="sm" variant="danger" onClick={() => life('SUSPEND')}>Suspend</Button>}
            {o.status === 'SUSPENDED' && <Button size="sm" onClick={() => life('REINSTATE')}>Reinstate</Button>}
            {o.status !== 'OFFBOARDED' && <Button size="sm" variant="ghost" onClick={() => life('TERMINATE')}>Terminate</Button>}
            {staff && <Select value={d.accountManager?.id || ''} onChange={(e) => run(async () => { await api.post(`/admin/organizations/${id}/account-manager`, { userId: e.target.value || null }); reload(); })}><option value="">No account manager</option>{staff.filter((s) => s.roles.some((r) => ['OPERATIONS', 'PLATFORM_ADMIN', 'EXECUTIVE'].includes(r))).map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}</Select>}
          </div>
          <ol className="mt-3 space-y-1 text-xs">{d.lifecycle.map((h) => <li key={h.id}><span className="text-ink-500">{when(h.createdAt)}</span> {h.action.replace('org.', '').replace('lifecycle.', '')} {h.before?.status ? `(was ${h.before.status})` : ''} · {h.actorEmail}{h.reason && <i> — {h.reason}</i>}</li>)}</ol>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Business profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"><dt className="text-ink-500">Website</dt><dd>{o.website || '—'}</dd><dt className="text-ink-500">Tax id</dt><dd>{o.taxId || '—'}</dd><dt className="text-ink-500">Billing</dt><dd>{o.billingEmail || '—'}</dd></dl>
          <div className="mt-2 text-xs font-semibold text-ink-500">Owners</div>{o.owners.length ? o.owners.map((w, i) => <div key={i} className="text-sm">{w.name} {w.title && `· ${w.title}`} {w.ownershipPct !== undefined && `· ${w.ownershipPct}%`}</div>) : <p className="text-xs text-ink-500">Not provided yet.</p>}
          <div className="mt-2 text-xs font-semibold text-ink-500">Contacts</div>{o.contacts.map((c, i) => <div key={i} className="text-sm">{c.name} {c.role && `· ${c.role}`} {c.email && `· ${c.email}`} {c.phone && `· ${c.phone}`}</div>)}
        </Card>
        <Card title="Contracts & acceptance records">
          {d.contracts.map((c) => <div key={c.id} className="flex justify-between border-b border-ink-50 py-1 text-sm"><span>v{c.version} {c.name} <span className="text-xs text-ink-500">{c.planCode}</span></span><span className="text-xs">{c.signedAt ? `signed ${when(c.signedAt)}` : 'awaiting signature'} · from {when(c.effectiveFrom)}{c.effectiveTo ? ` to ${when(c.effectiveTo)}` : ''}</span></div>)}
          {d.acceptances.map((a) => <div key={a.id} className="text-xs text-ink-500">Agreement {a.agreementVersion} accepted by {a.signatureName}{a.signatureTitle ? `, ${a.signatureTitle}` : ''} on {when(a.acceptedAt)} {a.ipAddress && `from ${a.ipAddress}`}</div>)}
          {!d.contracts.length && !d.acceptances.length && <p className="text-sm text-ink-500">None yet.</p>}
        </Card>
      </div>
      <Card title="Documents">
        <Table rows={d.documents} empty="No documents uploaded." cols={[{ key: 't', label: 'Type', render: (x) => x.docType.replace(/_/g, ' ').toLowerCase() }, { key: 'f', label: 'File', render: (x) => <span className="text-xs">{x.fileName}</span> }, { key: 's', label: 'Status', render: (x) => <Badge tone={statusTone(x.status === 'APPROVED' ? 'ACTIVE' : x.status)}>{x.status}</Badge> }, { key: 'e', label: 'Expires', render: (x) => x.expiresAt ? <span className={new Date(x.expiresAt) < new Date(Date.now() + 30 * 86400_000) ? 'text-red-700' : ''}>{when(x.expiresAt)}</span> : '—' }, { key: 'n', label: 'Note', render: (x) => <span className="text-xs">{x.reviewNote}</span> }]} />
      </Card>
      <Card title="Locations & launch progress">
        <Table rows={d.locations} cols={[{ key: 'n', label: 'Location', render: (l) => <Link className="underline" href={`/admin/locations/${l.id}`}>{l.name}</Link> }, { key: 's', label: 'Status', render: (l) => <span><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.isPaused && <Badge tone="bad">paused</Badge>}</span> }, { key: 'p', label: 'Checklist', render: (l) => <span className="text-xs">{l.progressPct}%{l.readinessApprovedAt ? ' · ready ✓' : ''}</span> }, { key: 'o', label: 'Still open', render: (l) => <span className="text-xs">{l.requiredOpen.join('; ') || '—'}</span> }]} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Merchant admins & team">
          <ul className="text-sm">{d.members.map((m) => <li key={m.id} className="flex items-center justify-between py-1"><span>{m.email} <Badge>{m.role.replace('MERCHANT_', '').toLowerCase()}</Badge>{m.locationIds.length ? <span className="text-xs text-ink-500"> {m.locationIds.length} location(s)</span> : null}{m.approvalLimitCents ? <span className="text-xs text-ink-500"> · limit {money(m.approvalLimitCents)}</span> : null}</span>{manage && <button className="text-xs text-red-600" onClick={() => run(async () => { await api.delete(`/organizations/${id}/members/${m.id}`); reload(); })}>Remove</button>}</li>)}</ul>
          {manage && (
            <div className="mt-2 space-y-2 rounded-lg border border-ink-100 p-2">
              <div className="grid grid-cols-[1fr_150px] gap-2"><Input placeholder="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /><Select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'KITCHEN', 'PACKER', 'HOST', 'DISPATCHER'].map((r) => <option key={r} value={r}>{r.replace('MERCHANT_', '').toLowerCase()}</option>)}</Select></div>
              {inv.role !== 'MERCHANT_OWNER' && d.locations.length > 0 && <div><div className="text-xs text-ink-500">Locations (none selected = all locations)</div><div className="mt-1 flex flex-wrap gap-1">{d.locations.map((l) => <button key={l.id} type="button" onClick={() => setInv({ ...inv, locationIds: inv.locationIds.includes(l.id) ? inv.locationIds.filter((x) => x !== l.id) : [...inv.locationIds, l.id] })} className={`rounded-md px-2 py-1 text-xs ${inv.locationIds.includes(l.id) ? 'bg-brand-600 text-white' : 'bg-ink-100'}`}>{l.name} · {l.city}</button>)}</div></div>}
              {['MERCHANT_OWNER', 'MERCHANT_MANAGER'].includes(inv.role) && <Input label="Approval limit for refunds and credits (USD, blank = none)" value={inv.limit} onChange={(e) => setInv({ ...inv, limit: e.target.value })} />}
              <Button size="sm" disabled={!inv.email} onClick={() => run(async () => { await api.post(`/organizations/${id}/members`, { email: inv.email, role: inv.role, locationIds: inv.role === 'MERCHANT_OWNER' ? [] : inv.locationIds, approvalLimitCents: inv.limit ? Math.round(Number(inv.limit) * 100) : undefined }); setInv({ email: '', role: 'MERCHANT_MANAGER', locationIds: [], limit: '' }); reload(); })}>Invite</Button>
            </div>
          )}
        </Card>
        <Card title="Support cases & change requests">
          {d.cases.slice(0, 8).map((c) => <div key={c.id} className="flex justify-between border-b border-ink-50 py-1 text-sm"><span>{c.category.toLowerCase().replace(/_/g, ' ')} <span className="text-xs text-ink-500">by {c.reporterType.toLowerCase()} · {c.description.slice(0, 60)}</span></span><Badge tone={statusTone(c.status)}>{c.status}</Badge></div>)}
          {d.changeRequests.slice(0, 5).map((c) => <div key={c.id} className="text-xs">Change: {c.summary} · <b>{c.status}</b></div>)}
          {!d.cases.length && !d.changeRequests.length && <p className="text-sm text-ink-500">None.</p>}
        </Card>
      </div>
    </div>
  );
}
