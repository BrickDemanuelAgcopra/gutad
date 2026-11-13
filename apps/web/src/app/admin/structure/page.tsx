'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, Stat, statusTone } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Loc { id: string; name: string; city: string; organizationId: string; regionId: string | null; status: string; platformOperated: boolean; kitchenId: string | null }
interface Node { region: { id: string; code: string; name: string; timezone: string } | null; foodHalls: (Loc & { kitchen: { name: string; isShared: boolean } | null; brands: { id: string; name: string }[] })[]; merchants: { org: { id: string; name: string; status: string } | undefined; locations: Loc[] }[] }
interface Structure { companies: { id: string; name: string; children: { id: string; name: string }[] }[]; legalEntities: { id: string; legalName: string; organizationName?: string; country: string }[]; regions: Node[]; brands: { id: string; name: string; organizationName?: string }[]; counts: Record<string, number> }

/** Company → legal entities → regions → food halls & merchants → locations & brands. */
export default function AdminStructure() {
  const { can } = useSession();
  const { data: s, reload } = useApi<Structure>('/admin/structure');
  const { run, error } = useAction();
  const [r, setR] = useState({ code: '', name: '', timezone: 'America/New_York' });
  const regions = (s?.regions || []).map((n) => n.region).filter(Boolean) as NonNullable<Node['region']>[];
  const move = (locId: string, regionId: string) => run(async () => { await api.post(`/admin/locations/${locId}/region`, { regionId: regionId || null }); await reload(); });
  const LocRow = ({ l }: { l: Loc }) => (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
      <span>{l.name} <span className="text-xs text-ink-500">{l.city}</span> <Badge tone={statusTone(l.status)}>{l.status}</Badge></span>
      {can('merchants.manage') && <select className="rounded border border-ink-100 px-1 py-0.5 text-xs" value={l.regionId || ''} onChange={(e) => move(l.id, e.target.value)}><option value="">No region</option>{regions.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
    </div>
  );
  return (
    <div className="space-y-4">
      <SectionTitle title="Organization structure" hint="Company, legal entities, regions, food halls, merchants and brands." />
      {error && <Alert>{error}</Alert>}
      {s && <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">{Object.entries(s.counts).map(([k, v]) => <Stat key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase()} value={v} />)}</div>}
      {can('merchants.manage') && <Card title="Add region"><div className="grid gap-2 sm:grid-cols-[120px_1fr_200px_auto]"><Input placeholder="Code (NYC)" value={r.code} onChange={(e) => setR({ ...r, code: e.target.value })} /><Input placeholder="Name (New York Metro)" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /><Select value={r.timezone} onChange={(e) => setR({ ...r, timezone: e.target.value })}>{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'].map((t) => <option key={t}>{t}</option>)}</Select><Button onClick={() => run(async () => { await api.post('/admin/regions', r); setR({ code: '', name: '', timezone: 'America/New_York' }); await reload(); })}>Add</Button></div></Card>}
      {s?.companies.length ? <Card title="Companies">{s.companies.map((c) => <div key={c.id} className="text-sm"><b>{c.name}</b> → {c.children.map((x) => x.name).join(', ')}</div>)}</Card> : null}
      <Card title="Legal entities (who earns and is paid)"><div className="grid gap-1 sm:grid-cols-2">{s?.legalEntities.map((l) => <div key={l.id} className="text-sm">{l.legalName} <span className="text-xs text-ink-500">{l.organizationName} · {l.country}</span></div>)}</div></Card>
      {s?.regions.map((n) => (
        <Card key={n.region?.id || 'none'} title={n.region ? `${n.region.name} (${n.region.code})` : 'Not assigned to a region'}>
          {n.foodHalls.length > 0 && <div className="mb-3"><div className="text-xs font-semibold uppercase text-ink-500">Food halls (Made at Gutad)</div>{n.foodHalls.map((h) => <div key={h.id} className="border-b border-ink-50 py-1"><LocRow l={h} /><div className="text-xs text-ink-500">Kitchen: {h.kitchen?.name || '—'} · Brands: {h.brands.map((b) => b.name).join(', ') || '—'}</div></div>)}</div>}
          {n.merchants.length > 0 && <div><div className="text-xs font-semibold uppercase text-ink-500">Independent merchants</div>{n.merchants.map((m) => <div key={m.org?.id} className="border-b border-ink-50 py-1"><div className="text-sm font-medium">{m.org?.name}</div>{m.locations.map((l) => <LocRow key={l.id} l={l} />)}</div>)}</div>}
          {!n.foodHalls.length && !n.merchants.length && <p className="text-sm text-ink-500">No locations yet.</p>}
        </Card>
      ))}
    </div>
  );
}
