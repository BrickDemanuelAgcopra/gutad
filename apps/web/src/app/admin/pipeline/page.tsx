'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Table, Tabs, Textarea } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

const STAGES = ['LEAD', 'CONTACTED', 'APPLIED', 'APPROVED', 'ONBOARDING', 'LIVE', 'LOST'];
interface App { id: string; businessName: string; contactName: string; email: string; phone: string | null; city: string | null; cuisine: string | null; locationsCount: number; stage: string; source: string; ownerEmail: string | null; organizationId: string | null; estMonthlyOrders: number | null; lostReason: string | null; history: { at: string; action: string; note: string | null; email?: string }[]; createdAt: string; updatedAt: string }
interface Board { id: string; name: string; status: string; accountManager: string | null; locations: number; progressPct: number; outstanding: string[]; createdAt: string }

export default function Pipeline() {
  const { can, user } = useSession();
  const [tab, setTab] = useState('pipeline');
  const [stage, setStage] = useState('');
  const { data, reload } = useApi<{ counts: Record<string, number>; items: App[] }>(`/admin/pipeline${stage ? `?stage=${stage}` : ''}`, { deps: [stage] });
  const { data: board } = useApi<Board[]>(tab === 'onboarding' ? '/admin/merchants/onboarding' : null, { deps: [tab] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<App | null>(null);
  const [note, setNote] = useState('');
  const [lead, setLead] = useState<{ businessName: string; contactName: string; email: string; city: string } | null>(null);
  const manage = can('merchants.manage');
  return (
    <div className="space-y-4">
      <SectionTitle title="Pipeline & onboarding" hint="Restaurant applications from first contact to live, and onboarding progress for new merchants." action={manage ? <Button onClick={() => setLead({ businessName: '', contactName: '', email: '', city: '' })}>Add lead</Button> : undefined} />
      {error && <Alert>{error}</Alert>}
      <Tabs tabs={[{ id: 'pipeline', label: 'Sales pipeline' }, { id: 'onboarding', label: 'Onboarding progress' }]} active={tab} onChange={setTab} />
      {tab === 'pipeline' && (
        <>
          <div className="flex flex-wrap gap-2">{[''].concat(STAGES).map((s) => <button key={s} onClick={() => setStage(s)} className={`rounded-full border px-3 py-1 text-xs ${stage === s ? 'border-brand-500 bg-brand-50 font-semibold' : 'border-ink-100 bg-white'}`}>{s ? `${s.toLowerCase()} · ${data?.counts[s] ?? 0}` : 'All'}</button>)}</div>
          <Table rows={data?.items || []} empty="No applications." cols={[
            { key: 'b', label: 'Business', render: (a) => <button className="text-left underline" onClick={() => { setSel(a); setNote(''); }}>{a.businessName}<span className="block text-xs text-ink-500 no-underline">{a.contactName} · {a.email}</span></button> },
            { key: 'c', label: 'City / cuisine', render: (a) => <span className="text-xs">{a.city || '—'} · {a.cuisine || '—'} · {a.locationsCount} loc.</span> },
            { key: 's', label: 'Stage', render: (a) => <Badge tone={a.stage === 'LIVE' ? 'good' : a.stage === 'LOST' ? 'bad' : 'info'}>{a.stage}</Badge> },
            { key: 'o', label: 'Owner', render: (a) => <span className="text-xs">{a.ownerEmail || '—'}</span> },
            { key: 'src', label: 'Source', render: (a) => <span className="text-xs">{a.source.toLowerCase()}</span> },
            { key: 'u', label: 'Updated', render: (a) => <span className="text-xs">{when(a.updatedAt)}</span> },
          ]} />
        </>
      )}
      {tab === 'onboarding' && (
        <Table rows={board || []} empty="Nobody is onboarding right now." cols={[
          { key: 'n', label: 'Merchant', render: (b) => <Link className="underline" href={`/admin/merchants/${b.id}`}>{b.name}</Link> },
          { key: 's', label: 'Status', render: (b) => <Badge>{b.status}</Badge> },
          { key: 'p', label: 'Progress', render: (b) => <div className="w-32"><div className="h-2 rounded-full bg-ink-50"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${b.progressPct}%` }} /></div><span className="text-xs text-ink-500">{b.progressPct}% · {b.locations} loc.</span></div> },
          { key: 'o', label: 'Outstanding', render: (b) => <span className="text-xs">{b.outstanding.slice(0, 3).join('; ') || '—'}{b.outstanding.length > 3 ? ` +${b.outstanding.length - 3}` : ''}</span> },
          { key: 'a', label: 'Account manager', render: (b) => <span className="text-xs">{b.accountManager || 'unassigned'}</span> },
        ]} />
      )}
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.businessName || ''}>
        {sel && (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-ink-500">{sel.contactName} · {sel.email} {sel.phone && `· ${sel.phone}`} · {sel.city} · est. {sel.estMonthlyOrders ?? '—'} orders/month</div>
            <ol className="max-h-40 space-y-1 overflow-auto text-xs">{sel.history.map((h, i) => <li key={i}><span className="text-ink-500">{when(h.at)}</span> {h.action}{h.email ? ` · ${h.email}` : ''}{h.note ? ` — ${h.note}` : ''}</li>)}</ol>
            {manage && !sel.organizationId && (
              <>
                <Textarea label="Note (or reason when lost)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <Select value={sel.stage} onChange={(e) => run(async () => { const r = await api.patch<App>(`/admin/pipeline/${sel.id}`, { stage: e.target.value, note: note || undefined, lostReason: e.target.value === 'LOST' ? note : undefined }); setSel(r); reload(); })}>{STAGES.map((s) => <option key={s}>{s}</option>)}</Select>
                  <Button size="sm" variant="secondary" disabled={!note} onClick={() => run(async () => { setSel(await api.patch<App>(`/admin/pipeline/${sel.id}`, { note })); setNote(''); reload(); })}>Add note</Button>
                  <Button size="sm" variant="ghost" onClick={() => run(async () => { setSel(await api.patch<App>(`/admin/pipeline/${sel.id}`, { ownerId: user?.id })); reload(); })}>Assign to me</Button>
                  <Button size="sm" onClick={() => run(async () => { const org = await api.post<{ id: string }>(`/admin/pipeline/${sel.id}/convert`, {}); window.location.href = `/admin/merchants/${org.id}`; })}>Approve & create merchant</Button>
                </div>
              </>
            )}
            {sel.organizationId && <Link className="underline" href={`/admin/merchants/${sel.organizationId}`}>Open merchant</Link>}
          </div>
        )}
      </Modal>
      <Modal open={!!lead} onClose={() => setLead(null)} title="Add lead">
        {lead && <div className="space-y-2"><Input label="Business" value={lead.businessName} onChange={(e) => setLead({ ...lead, businessName: e.target.value })} /><Input label="Contact name" value={lead.contactName} onChange={(e) => setLead({ ...lead, contactName: e.target.value })} /><Input label="Email" value={lead.email} onChange={(e) => setLead({ ...lead, email: e.target.value })} /><Input label="City" value={lead.city} onChange={(e) => setLead({ ...lead, city: e.target.value })} /><Button onClick={() => run(async () => { await api.post('/admin/pipeline', lead); setLead(null); reload(); })}>Add</Button></div>}
      </Modal>
    </div>
  );
}
