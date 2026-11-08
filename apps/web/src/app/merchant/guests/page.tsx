'use client';
import { useState } from 'react';
import { api, money, when } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Table, Textarea } from '@/components/ui';
import { useMerchant } from '../context';

interface Guest { id: string; name: string; email: string | null; phone: string | null; notes: string | null; tags: string[]; visitCount: number; orderCount: number; lifetimeSpendCents: number; lastVisitAt: string | null }

export default function GuestsPage() {
  const { org, loc } = useMerchant();
  const [q, setQ] = useState('');
  const { data, reload } = useApi<Guest[]>(org ? `/organizations/${org.id}/guests?q=${encodeURIComponent(q)}` : null, { deps: [org?.id, q] });
  const { data: reviews, reload: reloadReviews } = useApi<{ id: string; rating: number; body: string | null; verified: boolean; merchantReply: string | null; author: string | null }[]>(loc ? `/public/locations/${loc.id}/reviews` : null, { deps: [loc?.id] });
  const { data: segs, reload: reloadSegs } = useApi<{ id: string; name: string; rules: Record<string, number> }[]>(org ? `/organizations/${org.id}/segments` : null, { deps: [org?.id] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<Guest | null>(null);
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const [seg, setSeg] = useState({ name: '', minVisits: '', minSpend: '', lastDays: '' });
  if (!org) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Guests & CRM</h1>
      {error && <Alert>{error}</Alert>}
      <Input placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <Table rows={data || []} cols={[{ key: 'n', label: 'Guest', render: (g) => <button className="font-medium underline" onClick={() => { setSel(g); setNotes(g.notes || ''); setTags(g.tags.join(', ')); }}>{g.name}</button> }, { key: 'c', label: 'Contact', render: (g) => <span className="text-xs">{g.email}<br />{g.phone}</span> }, { key: 'v', label: 'Visits / orders', render: (g) => `${g.visitCount} / ${g.orderCount}` }, { key: 's', label: 'Lifetime spend', render: (g) => money(g.lifetimeSpendCents) }, { key: 'l', label: 'Last visit', render: (g) => when(g.lastVisitAt) }, { key: 't', label: 'Tags', render: (g) => g.tags.map((t) => <Badge key={t}>{t}</Badge>) }]} />
      {sel && <Card title={`Guest notes — ${sel.name}`} action={<Button size="sm" variant="ghost" onClick={() => setSel(null)}>Close</Button>}><Textarea label="Private notes (never shown to the guest)" value={notes} onChange={(e) => setNotes(e.target.value)} /><Input className="mt-2" label="Tags (comma separated)" value={tags} onChange={(e) => setTags(e.target.value)} /><Button className="mt-2" onClick={() => run(async () => { await api.patch(`/guests/${sel.id}`, { notes, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }); reload(); })}>Save</Button></Card>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Segments">
          <ul className="text-sm">{segs?.map((s) => <li key={s.id}>{s.name} <span className="text-xs text-ink-500">{JSON.stringify(s.rules)}</span></li>)}</ul>
          <div className="mt-2 grid grid-cols-2 gap-2"><Input placeholder="Segment name" value={seg.name} onChange={(e) => setSeg({ ...seg, name: e.target.value })} /><Input placeholder="Min visits" value={seg.minVisits} onChange={(e) => setSeg({ ...seg, minVisits: e.target.value })} /><Input placeholder="Min spend (USD)" value={seg.minSpend} onChange={(e) => setSeg({ ...seg, minSpend: e.target.value })} /><Input placeholder="Visited within days" value={seg.lastDays} onChange={(e) => setSeg({ ...seg, lastDays: e.target.value })} /></div>
          <Button className="mt-2" variant="secondary" disabled={!seg.name} onClick={() => run(async () => { await api.post(`/organizations/${org.id}/segments`, { name: seg.name, rules: { ...(seg.minVisits ? { minVisits: Number(seg.minVisits) } : {}), ...(seg.minSpend ? { minSpendCents: Math.round(Number(seg.minSpend) * 100) } : {}), ...(seg.lastDays ? { lastVisitWithinDays: Number(seg.lastDays) } : {}) } }); setSeg({ name: '', minVisits: '', minSpend: '', lastDays: '' }); reloadSegs(); })}>Create segment</Button>
        </Card>
        <Card title="Reviews">
          {reviews?.map((r) => <div key={r.id} className="border-b border-ink-100 py-2 text-sm"><div>{'★'.repeat(r.rating)} {r.author} {r.verified && <Badge tone="good">verified</Badge>}</div><p className="text-ink-700">{r.body}</p>{r.merchantReply ? <p className="text-xs text-ink-500">Your reply: {r.merchantReply}</p> : <Button size="sm" variant="ghost" onClick={() => { const t = prompt('Reply'); if (t) run(async () => { await api.patch(`/reviews/${r.id}`, { merchantReply: t }); reloadReviews(); }); }}>Reply</Button>}</div>)}
          {!reviews?.length && <p className="text-sm text-ink-500">No published reviews.</p>}
        </Card>
      </div>
    </div>
  );
}
