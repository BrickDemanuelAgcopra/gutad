'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { Alert, Button, Card, Input } from '@/components/ui';
import { ChecklistCard, ClosuresCard, OperationsCard, type Checklist, type Closure, type LocFields } from '@/components/location-admin';
import { useMerchant } from '../context';

interface Detail { location: LocFields & { name: string; rampUntil: string | null; pausedReason: string | null }; closures: Closure[]; checklist: Checklist }
interface Owner { name: string; title?: string; ownershipPct?: number; email?: string }

/** Merchant: operations settings, closures and special hours, launch checklist, business owners. */
export default function MerchantLocation() {
  const { org, loc, reload: reloadCtx } = useMerchant();
  const { data: d, reload } = useApi<Detail>(loc ? `/admin/locations/${loc.id}` : null, { deps: [loc?.id] });
  const { data: orgFull, reload: reloadOrg } = useApi<{ owners: Owner[]; website: string | null }>(org ? `/organizations/${org.id}` : null, { deps: [org?.id] });
  const { run, error } = useAction();
  const [owners, setOwners] = useState<Owner[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (orgFull) setOwners(orgFull.owners || []); }, [orgFull]);
  if (!loc || !org) return null;
  if (!d) return null;
  const l = d.location;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Location & launch · {l.name}</h1>
      {error && <Alert>{error}</Alert>}
      {l.isPaused && <Card title="Paused"><p className="text-sm">{l.pausedReason}</p>{l.pausedReason?.startsWith('Emergency:') ? <p className="text-xs text-ink-500">Gutad operations will reopen the location once it is safe.</p> : <Button className="mt-2" size="sm" onClick={() => { const reason = window.prompt('Reason for reopening'); if (reason && reason.length >= 5) run(async () => { await api.post(`/locations/${loc.id}/restart`, { reason }); reload(); reloadCtx(); }); }}>Reopen gradually</Button>}</Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <OperationsCard key={l.id + JSON.stringify(l.contacts)} loc={l} onChange={reload} />
        <ClosuresCard locationId={loc.id} closures={d.closures} onChange={reload} />
      </div>
      <ChecklistCard locationId={loc.id} checklist={d.checklist} onChange={reload} staff={false} />
      <Card title="Business owners">
        <p className="text-xs text-ink-500">Everyone owning 25% or more of the business. Gutad uses this for identity checks before payouts.</p>
        {owners.map((o, i) => <div key={i} className="mt-2 grid grid-cols-[1fr_1fr_90px_1fr_auto] gap-2"><Input placeholder="Name" value={o.name} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><Input placeholder="Title" value={o.title || ''} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /><Input placeholder="%" type="number" value={o.ownershipPct ?? ''} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, ownershipPct: Number(e.target.value) } : x)))} /><Input placeholder="Email" value={o.email || ''} onChange={(e) => setOwners(owners.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} /><button className="text-xs text-red-600" onClick={() => setOwners(owners.filter((_, j) => j !== i))}>×</button></div>)}
        <div className="mt-2 flex items-center gap-3"><button className="text-xs underline" onClick={() => setOwners([...owners, { name: '' }])}>+ Add owner</button><Button size="sm" onClick={() => run(async () => { await api.patch(`/organizations/${org.id}/profile`, { owners: owners.filter((o) => o.name) }); setSaved(true); reloadOrg(); })}>Save owners</Button>{saved && <span className="text-xs text-emerald-700">Saved</span>}</div>
      </Card>
    </div>
  );
}
