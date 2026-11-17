'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CHEF_APPLICATION_STATUS_LABELS, CHEF_APPLICATION_STEPS, CHEF_KITCHEN_TYPES, WEEKDAYS, type ChefApplicationData, type ChefApplicationStatus } from '@gutad/shared';
import { api, API_URL, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Table, Tabs, Textarea } from '@/components/ui';
import { KeyValue, SectionTitle } from '@/components/admin-ui';
import { ChipGroup, ProgressBar } from '@/components/form-kit';

interface Row { id: string; status: ChefApplicationStatus; displayName: string | null; applicantName: string | null; email: string; region: string | null; city: string | null; kitchenType: string | null; percentComplete: number; flags: string[]; reviewer: { email: string; name: string | null } | null; submittedAt: string | null; waitingHours: number | null }
interface Doc { id: string; requirementKey: string; status: string; expiresAt: string | null; note: string | null; fileId: string; createdAt: string }
interface Detail {
  id: string; status: ChefApplicationStatus; data: ChefApplicationData; reviewerId: string | null; reviewNote: string | null; decisionReason: string | null; appealNote: string | null; correctionSteps: string[]; autoCheck: { flags?: string[]; waitlist?: boolean } | null;
  history: { at: string; action: string; note?: string }[]; applicant: { email: string; name: string | null; phone: string | null; emailVerifiedAt: string | null; createdAt: string };
  progress: { percent: number; steps: { key: string; label: string; complete: boolean; missing: string[] }[] };
  requirements: { key: string; label: string; required: boolean; needsExpiry: boolean }[]; documents: Doc[]; organizationId: string | null;
}
interface ChefRow { id: string; slug: string; displayName: string; status: string; statusReason: string | null; acceptingOrders: boolean; serviceCity: string | null; serviceRegion: string | null; kitchenType: string | null; cuisines: string[]; createdAt: string }

const QUEUES: { id: string; label: string; status: string }[] = [
  { id: 'review', label: 'To review', status: 'SUBMITTED,IN_REVIEW,APPEALED' },
  { id: 'changes', label: 'Waiting on chef', status: 'CHANGES_REQUESTED' },
  { id: 'waitlist', label: 'Waitlist', status: 'WAITLISTED' },
  { id: 'approved', label: 'Approved', status: 'APPROVED' },
  { id: 'rejected', label: 'Declined', status: 'REJECTED' },
  { id: 'drafts', label: 'In progress', status: 'DRAFT' },
];
const tone = (s: string) => (s === 'APPROVED' ? 'good' : s === 'REJECTED' ? 'bad' : s === 'CHANGES_REQUESTED' || s === 'WAITLISTED' ? 'warn' : 'info');

export default function AdminChefs() {
  const [tab, setTab] = useState('applications');
  return (
    <div className="space-y-4">
      <SectionTitle title="Chef Network" hint="Independent chefs: applications, kitchens and documents, approvals and chef accounts." action={<Link href="/admin/chefs/requirements" className="text-sm underline">Document rules →</Link>} />
      <Tabs tabs={[{ id: 'applications', label: 'Applications' }, { id: 'dishes', label: 'Dish review' }, { id: 'chefs', label: 'Chefs' }]} active={tab} onChange={setTab} />
      {tab === 'applications' ? <Applications /> : tab === 'dishes' ? <DishReview /> : <Chefs />}
    </div>
  );
}

function Applications() {
  const [q, setQ] = useState('review');
  const [mine, setMine] = useState(false);
  const status = QUEUES.find((x) => x.id === q)!.status;
  const { data, reload } = useApi<{ counts: Record<string, number>; items: Row[] }>(`/admin/chef-applications?status=${status}${mine ? '&mine=true' : ''}`, { deps: [q, mine] });
  const [sel, setSel] = useState<string | null>(null);
  const count = (s: string) => s.split(',').reduce((a, k) => a + (data?.counts[k] || 0), 0);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {QUEUES.map((x) => <button key={x.id} onClick={() => setQ(x.id)} className={`rounded-full border px-3 py-1 text-xs ${q === x.id ? 'border-brand-500 bg-brand-50 font-semibold' : 'border-ink-100 bg-white'}`}>{x.label} · {count(x.status)}</button>)}
        <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me</label>
      </div>
      <Table rows={data?.items || []} empty="No applications in this queue." cols={[
        { key: 'n', label: 'Chef', render: (r) => <button className="text-left underline" onClick={() => setSel(r.id)}>{r.displayName || '(no name yet)'}<span className="block text-xs text-ink-500 no-underline">{r.applicantName} · {r.email}</span></button> },
        { key: 'k', label: 'Kitchen', render: (r) => <span className="text-xs">{r.kitchenType ? CHEF_KITCHEN_TYPES[r.kitchenType as keyof typeof CHEF_KITCHEN_TYPES]?.split(' (')[0] : '—'}<span className="block text-ink-500">{[r.city, r.region].filter(Boolean).join(', ') || '—'}</span></span> },
        { key: 's', label: 'Status', render: (r) => <div className="space-y-1"><Badge tone={tone(r.status)}>{CHEF_APPLICATION_STATUS_LABELS[r.status]}</Badge>{r.flags.length > 0 && <div className="text-xs text-amber-700">⚠ {r.flags.join('; ')}</div>}</div> },
        { key: 'p', label: 'Complete', render: (r) => <div className="w-24"><ProgressBar percent={r.percentComplete} /></div> },
        { key: 'r', label: 'Reviewer', render: (r) => <span className="text-xs">{r.reviewer?.name || r.reviewer?.email || '—'}</span> },
        { key: 'w', label: 'Waiting', render: (r) => <span className={`text-xs ${r.waitingHours !== null && r.waitingHours > 72 ? 'font-semibold text-red-600' : ''}`}>{r.waitingHours !== null ? `${r.waitingHours}h` : r.submittedAt ? when(r.submittedAt) : '—'}</span> },
      ]} />
      {sel && <ApplicationModal id={sel} onClose={() => setSel(null)} onChanged={reload} />}
    </>
  );
}

function ApplicationModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const manage = can('chefs.manage');
  const { data: d, reload } = useApi<Detail>(`/admin/chef-applications/${id}`, { deps: [id] });
  const { run, error, busy } = useAction();
  const [reason, setReason] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [docNote, setDocNote] = useState<Record<string, string>>({});
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); onChanged(); });
  if (!d) return <Modal open title="Application" onClose={onClose}><p className="text-sm">Loading…</p></Modal>;
  const x = d.data;
  const decidable = ['SUBMITTED', 'IN_REVIEW', 'APPEALED', 'WAITLISTED'].includes(d.status);
  return (
    <Modal open title={x.identity?.displayName || 'Chef application'} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(d.status)}>{CHEF_APPLICATION_STATUS_LABELS[d.status]}</Badge>{d.organizationId && <Badge tone="good">Provisioned</Badge>}</div>
        {!!d.autoCheck?.flags?.length && <Alert tone="info">Automated checks: {d.autoCheck.flags.join('; ')}</Alert>}
        {d.appealNote && <Alert tone="info">Appeal: {d.appealNote}</Alert>}
        {error && <Alert>{error}</Alert>}
        <ProgressBar percent={d.progress.percent} label="Application completeness" />
        <div className="flex flex-wrap gap-1">{d.progress.steps.map((s) => <span key={s.key} title={s.missing.join(', ')} className={`rounded-full px-2 py-0.5 text-xs ${s.complete ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{s.complete ? '✓' : '•'} {s.label}</span>)}</div>

        <Section title="Applicant">
          <KeyValue rows={[['Legal name', x.identity?.legalName || '—'], ['Selling as', x.identity?.businessType === 'BUSINESS' ? `Business: ${x.identity.businessName}` : 'Individual'], ['Email', `${d.applicant.email}${d.applicant.emailVerifiedAt ? ' ✓' : ' (unverified)'}`], ['Phone', x.account?.phone || '—'], ['Agreement', x.account?.agreedAt ? `v${x.account.agreementVersion} on ${when(x.account.agreedAt)}` : '—']]} />
        </Section>
        <Section title="Profile">
          <div className="flex gap-3">{x.profile?.portraitFileId && <img src={`${API_URL}/public/chef-photos/${x.profile.portraitFileId}`} alt="" className="h-16 w-16 rounded-full object-cover" />}<p className="text-ink-700">{x.profile?.bio}</p></div>
          <KeyValue rows={[['Cuisines', (x.profile?.cuisines || []).join(', ') || '—'], ['Experience', x.profile?.experienceYears !== undefined ? `${x.profile.experienceYears} years` : '—'], ['Service area', `${x.profile?.serviceCity || '—'}, ${x.profile?.serviceRegion || ''} · ${x.profile?.serviceRadiusKm ?? '—'} km`]]} />
        </Section>
        <Section title="Kitchen">
          <KeyValue rows={[['Type', x.kitchen?.kitchenType ? CHEF_KITCHEN_TYPES[x.kitchen.kitchenType] : '—'], ['Operator', x.kitchen?.operatorName || '—'], ['Address', [x.kitchen?.addressLine1, x.kitchen?.city, x.kitchen?.region, x.kitchen?.postalCode].filter(Boolean).join(', ')], ['Pickup access', x.kitchen?.pickupAccess || '—'], ['Capacity', `${x.kitchen?.dailyCapacity ?? '—'} portions/day`], ['Equipment', (x.kitchen?.equipment || []).join(', ') || '—']]} />
        </Section>
        <Section title="Documents">
          <div className="space-y-2">
            {d.requirements.map((r) => {
              const doc = d.documents.find((z) => z.requirementKey === r.key);
              return (
                <div key={r.key} className="rounded-lg border border-ink-100 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{r.label}{r.required ? '' : ' (optional)'}</span>{doc ? <Badge tone={doc.status === 'APPROVED' ? 'good' : doc.status === 'REJECTED' ? 'bad' : 'info'}>{doc.status.toLowerCase()}</Badge> : <Badge tone={r.required ? 'bad' : 'neutral'}>missing</Badge>}</div>
                  {doc && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <button className="underline" onClick={() => downloadFile(`/chef/files/${doc.fileId}`, `${r.key}.pdf`)}>Open file</button>
                      <span className="text-ink-500">Uploaded {when(doc.createdAt)}{doc.expiresAt ? ` · expires ${new Date(doc.expiresAt).toLocaleDateString()}` : ''}</span>
                      {manage && doc.status !== 'APPROVED' && <Button size="sm" disabled={busy} onClick={() => act(() => api.post(`/admin/chef-documents/${doc.id}/review`, { status: 'APPROVED' }))}>Approve</Button>}
                      {manage && doc.status !== 'REJECTED' && (
                        <>
                          <input className="rounded border border-ink-100 px-2 py-1" placeholder="Why not accepted" value={docNote[doc.id] || ''} onChange={(e) => setDocNote({ ...docNote, [doc.id]: e.target.value })} />
                          <Button size="sm" variant="danger" disabled={busy || !(docNote[doc.id] || '').trim()} onClick={() => act(() => api.post(`/admin/chef-documents/${doc.id}/review`, { status: 'REJECTED', note: docNote[doc.id] }))}>Reject</Button>
                        </>
                      )}
                      {doc.note && <span className="text-red-600">{doc.note}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
        <Section title="Operating preferences">
          <KeyValue rows={[['Cooking days', (x.operating?.cookingDays || []).map((n) => WEEKDAYS[n]).join(', ') || '—'], ['Cutoff', x.operating?.cutoffHour !== undefined ? `${x.operating.cutoffHour}:00 day before` : '—'], ['Notice', `${x.operating?.minLeadDays ?? '—'} day(s), up to ${x.operating?.maxAdvanceDays ?? '—'} days ahead`], ['Capacity', `${x.operating?.dailyCapacity ?? '—'} orders/day`], ['Formats', [x.operating?.scheduledOrders && 'scheduled', x.operating?.instantOrders && 'same-day', x.operating?.pickup && 'pickup', x.operating?.delivery && 'delivery'].filter(Boolean).join(', ')]]} />
        </Section>
        <Section title="First menu">
          {(x.menu?.dishes || []).map((m, i) => <div key={i} className="flex justify-between border-b border-ink-100 py-1 last:border-0"><span><strong>Gutad’s {m.name}</strong> — {m.portion} · {m.mode === 'CUSTOMIZABLE' ? 'customizable' : 'fixed'}<span className="block text-xs text-ink-500">Allergens: {m.allergens?.length ? m.allergens.join(', ') : 'none declared'}</span></span><span>{money(m.priceCents || 0)}</span></div>)}
        </Section>
        <Section title="History">
          <ul className="space-y-1 text-xs">{d.history.slice().reverse().map((h, i) => <li key={i}><span className="text-ink-500">{when(h.at)}</span> · <strong>{h.action.toLowerCase().replace(/_/g, ' ')}</strong>{h.note ? ` — ${h.note}` : ''}</li>)}</ul>
        </Section>

        {manage && (
          <div className="space-y-3 rounded-xl bg-ink-50 p-3">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => api.post(`/admin/chef-applications/${id}/assign`, {}))}>Assign to me</Button>
            </div>
            {decidable && (
              <>
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-500">Request corrections on</span>
                  <ChipGroup name="Steps" values={steps} onChange={setSteps} options={CHEF_APPLICATION_STEPS.map((s) => ({ value: s.key, label: s.label }))} />
                  <Textarea className="mt-2" label="Note to the chef" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button size="sm" className="mt-2" variant="secondary" disabled={busy || !steps.length || note.trim().length < 5} onClick={() => act(() => api.post(`/admin/chef-applications/${id}/changes`, { steps, note }))}>Request changes</Button>
                </div>
                <Input label="Decision reason (recorded and shared with the chef)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || reason.trim().length < 5} onClick={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'APPROVE', reason }))}>Approve chef & kitchen</Button>
                  <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 5} onClick={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'WAITLIST', reason }))}>Waitlist</Button>
                  <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 5} onClick={() => act(() => api.post(`/admin/chef-applications/${id}/decide`, { decision: 'REJECT', reason }))}>Decline</Button>
                </div>
                <p className="text-xs text-ink-500">Approval needs every required document for this kitchen type and state approved and current. It creates the chef account, kitchen location (paused) and payout entity.</p>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2"><h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h4>{children}</section>;
}

function Chefs() {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const { data, reload } = useApi<ChefRow[]>(`/admin/chefs${status ? `?status=${status}` : ''}`, { deps: [status] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<ChefRow | null>(null);
  const [next, setNext] = useState('PAUSED');
  const [reason, setReason] = useState('');
  return (
    <>
      <div className="flex gap-2"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All chefs</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="SUSPENDED">Suspended</option></Select></div>
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No chefs yet." cols={[
        { key: 'n', label: 'Chef', render: (c) => <Link className="underline" href={`/chefs/${c.slug}`}>{c.displayName}</Link> },
        { key: 'a', label: 'Area', render: (c) => <span className="text-xs">{c.serviceCity}, {c.serviceRegion}</span> },
        { key: 'c', label: 'Cuisines', render: (c) => <span className="text-xs">{c.cuisines.join(', ')}</span> },
        { key: 's', label: 'Status', render: (c) => <div><Badge tone={c.status === 'ACTIVE' ? 'good' : c.status === 'SUSPENDED' ? 'bad' : 'warn'}>{c.status.toLowerCase()}</Badge>{c.status === 'ACTIVE' && <span className="ml-1 text-xs text-ink-500">{c.acceptingOrders ? 'accepting' : 'not accepting'}</span>}{c.statusReason && <div className="text-xs text-ink-500">{c.statusReason}</div>}</div> },
        { key: 'x', label: '', render: (c) => (can('chefs.manage') ? <Button size="sm" variant="secondary" onClick={() => { setSel(c); setNext(c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'); setReason(''); }}>Change status</Button> : null) },
      ]} />
      {sel && (
        <Modal open title={`Status of ${sel.displayName}`} onClose={() => setSel(null)}>
          <div className="space-y-3">
            <Select label="New status" value={next} onChange={(e) => setNext(e.target.value)}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="SUSPENDED">Suspended (listings hidden)</option></Select>
            <Textarea label="Reason (audited, shown to the chef)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button disabled={reason.trim().length < 5} onClick={() => run(async () => { await api.post(`/admin/chefs/${sel.id}/status`, { status: next, reason }); setSel(null); await reload(); })}>Save</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface ReviewDish { id: string; title: string; chefName: string; chefSlug: string; kind: 'NEW_LISTING' | 'CHANGE'; reviewStatus: string; priceCents: number; portionDesc: string; ingredients: string[]; allergens: string[]; dietaryTags: string[]; allergensConfirmed: boolean; photos: string[]; mode: string; acceptsSpecialRequests: boolean; fulfillmentFormat: string; description: string | null; pendingChanges: Record<string, unknown> | null; missing: string[]; submittedAt: string | null }

/** New listings and material changes to live dishes: ingredients, allergens, portion, photos, price, recipe mode. */
function DishReview() {
  const { can } = useSession();
  const { data, reload } = useApi<ReviewDish[]>('/admin/chef-dishes/review', { poll: 30000 });
  const { run, error, busy } = useAction();
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = (id: string, decision: string) => run(async () => { await api.post(`/admin/chef-dishes/${id}/review`, { decision, note: note[id] }); await reload(); });
  if (!data) return <p className="text-sm text-ink-500">Loading…</p>;
  if (!data.length) return <Card><p className="text-sm text-ink-500">No dishes waiting for review.</p></Card>;
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(', ') || '—' : v === null || v === undefined ? '—' : String(v));
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {data.map((d) => (
        <Card key={d.id}>
          <div className="flex flex-col gap-4 sm:flex-row">
            {d.photos[0] && <img src={d.photos[0]} alt="" className="h-32 w-full rounded-xl object-cover sm:w-44" />}
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-base">{d.title}</strong><Badge tone={d.kind === 'NEW_LISTING' ? 'info' : 'warn'}>{d.kind === 'NEW_LISTING' ? 'New listing' : 'Change to a live dish'}</Badge><Link href={`/chefs/${d.chefSlug}`} className="text-xs underline">{d.chefName}</Link></div>
              <KeyValue rows={[
                ['Price', money(d.priceCents)],
                ['Portion', d.portionDesc || '—'],
                ['Format', d.fulfillmentFormat.toLowerCase().replace('_', ' ')],
                ['Recipe mode', `${d.mode.toLowerCase()}${d.acceptsSpecialRequests ? ' · accepts special requests' : ''}`],
                ['Ingredients', d.ingredients.join(', ') || '—'],
                ['Allergens', `${d.allergens.join(', ') || 'none'}${d.allergensConfirmed ? ' (confirmed by chef)' : ' — NOT confirmed'}`],
                ['Dietary labels', d.dietaryTags.join(', ') || '—'],
              ]} />
              {d.description && <p className="text-ink-700">{d.description}</p>}
              {d.pendingChanges && (
                <div className="rounded-lg bg-amber-50 p-2 text-xs">
                  <strong>Proposed changes</strong>
                  <ul className="mt-1 space-y-0.5">{Object.entries(d.pendingChanges).map(([k, v]) => <li key={k}><span className="text-ink-500">{k}:</span> {fmt((d as unknown as Record<string, unknown>)[k])} → <strong>{fmt(v)}</strong></li>)}</ul>
                  {Array.isArray(d.pendingChanges.ingredients) && !d.pendingChanges.allergens && <p className="mt-1 text-amber-800">⚠ Ingredients changed without an allergen update; check the allergen list.</p>}
                </div>
              )}
              {!!d.missing.length && <p className="text-xs text-red-600">Missing: {d.missing.join(', ')}</p>}
              {can('chefs.manage') && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <input className="min-w-[220px] flex-1 rounded-lg border border-ink-100 px-2 py-1.5 text-sm" placeholder="Note to the chef (needed to send back)" value={note[d.id] || ''} onChange={(e) => setNote({ ...note, [d.id]: e.target.value })} />
                  <Button size="sm" disabled={busy} onClick={() => decide(d.id, 'APPROVE')}>{d.kind === 'NEW_LISTING' ? 'Approve & publish' : 'Approve changes'}</Button>
                  <Button size="sm" variant="secondary" disabled={busy || (note[d.id] || '').trim().length < 5} onClick={() => decide(d.id, 'CHANGES')}>{d.kind === 'NEW_LISTING' ? 'Send back' : 'Decline changes'}</Button>
                </div>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
