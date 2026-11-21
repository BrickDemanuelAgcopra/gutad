'use client';
import { useMemo, useState } from 'react';
import { CAMPAIGN_KIND_LABELS, CAMPAIGN_KINDS, VEHICLE_TYPES, type CampaignKind, type CampaignRules } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select, Stat, statusTone, Table, Textarea } from '@/components/ui';
import { askReason, KeyValue } from '@/components/admin-ui';

// Courier Release 3 admin: demand forecast and campaigns.

interface Cell { zoneId: string; zoneName: string; hourStart: string; expectedJobs: number; supplyCouriers: number; neededCouriers: number; gap: number; actualJobs: number | null }
interface Forecast { cells: Cell[]; accuracy: { mape: number | null; hours: number; days: number }; config: { lookbackWeeks: number; horizonDays: number; jobsPerCourierHour: number; gapAlertCouriers: number }; generatedAt: string | null }

const hourLabel = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric' });
const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** Zone × hour grid for the coming days: expected deliveries, couriers needed vs expected, gaps highlighted. */
export function ForecastTab() {
  const { can } = useSession();
  const { run, error, busy } = useAction();
  const { data: net } = useApi<{ zones: { id: string; name: string; kind: string }[] }>('/admin/delivery/network');
  const [zoneId, setZoneId] = useState('');
  const [day, setDay] = useState(0);
  const from = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + day); return d; }, [day]);
  const to = new Date(from.getTime() + 86_400_000);
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...(zoneId ? { zoneId } : {}) });
  const { data, reload } = useApi<Forecast>(`/admin/delivery/forecast?${qs.toString()}`, { deps: [zoneId, day] });
  const zones = Array.from(new Map((data?.cells ?? []).map((c) => [c.zoneId, c.zoneName])).entries());
  const hours = Array.from({ length: 24 }, (_, i) => new Date(from.getTime() + i * 3600_000));
  const cell = (z: string, h: Date) => data?.cells.find((c) => c.zoneId === z && new Date(c.hourStart).getTime() === h.getTime());
  const alertAt = data?.config.gapAlertCouriers ?? 2;
  const shortHours = (data?.cells ?? []).filter((c) => c.gap >= alertAt);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-ink-500">Expected deliveries per zone and hour, from the same weekday and hour over the last {data?.config.lookbackWeeks ?? 8} weeks (recent weeks count more), adjusted for the recent trend. Supply is booked shifts plus the couriers who usually work that hour. Hours short by {alertAt}+ couriers show to couriers as busy times.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}><option value="">All zones</option>{net?.zones.filter((z) => z.kind === 'SERVICE').map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</Select>
        <Select label="Day" value={String(day)} onChange={(e) => setDay(Number(e.target.value))}>{Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return <option key={i} value={i}>{i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(d)}</option>; })}</Select>
        {can('delivery.manage') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api.post('/admin/delivery/forecast/rebuild', {}); await reload(); })}>Rebuild now</Button>}
      </div>
      {data && <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Expected deliveries" value={Math.round(data.cells.reduce((t, c) => t + c.expectedJobs, 0))} hint={dayLabel(from)} />
          <Stat label="Short hours" value={shortHours.length} hint={`gap ≥ ${alertAt} couriers`} />
          <Stat label="Accuracy (7 days)" value={data.accuracy.mape === null ? '—' : `${Math.max(0, 100 - data.accuracy.mape).toFixed(0)}%`} hint={data.accuracy.mape === null ? 'no finished hours yet' : `MAPE ${data.accuracy.mape}% over ${data.accuracy.hours} h`} />
          <Stat label="Built" value={data.generatedAt ? when(data.generatedAt) : 'not yet'} hint="nightly" />
        </div>
        {zones.length === 0 ? <p className="text-sm text-ink-500">No forecast for this day yet. It is built nightly from delivery history; use “Rebuild now” after changing settings.</p> : (
          <div className="overflow-x-auto rounded border border-ink-100">
            <table className="text-xs">
              <thead><tr><th className="sticky left-0 bg-white px-2 py-1 text-left">Zone</th>{hours.map((h) => <th key={h.getTime()} className="px-1 py-1 font-normal text-ink-500">{hourLabel(h)}</th>)}</tr></thead>
              <tbody>
                {zones.map(([z, name]) => (
                  <tr key={z} className="border-t border-ink-100">
                    <td className="sticky left-0 bg-white px-2 py-1 font-medium">{name}</td>
                    {hours.map((h) => {
                      const c = cell(z, h);
                      const tone = !c || c.expectedJobs < 0.05 ? 'bg-ink-50 text-ink-400' : c.gap >= alertAt ? 'bg-red-100 text-red-800' : c.gap > 0 ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800';
                      return <td key={h.getTime()} className={`px-1 py-1 text-center ${tone}`} title={c ? `${dayLabel(h)} ${hourLabel(h)} · expected ${c.expectedJobs} deliveries · need ${c.neededCouriers}, expect ${c.supplyCouriers} couriers${c.actualJobs !== null ? ` · actual ${c.actualJobs}` : ''}` : 'no data'}>
                        {c && c.expectedJobs >= 0.05 ? <><div>{c.expectedJobs.toFixed(c.expectedJobs < 10 ? 1 : 0)}</div><div className="opacity-70">{c.gap > 0 ? `−${Math.ceil(c.gap)}` : '✓'}</div></> : '·'}
                      </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-2 py-1 text-xs text-ink-500">Each cell: expected deliveries, then couriers short (−n) or covered (✓). <span className="rounded bg-red-100 px-1">red</span> = busy time shown to couriers, <span className="rounded bg-amber-50 px-1">amber</span> = slightly short.</p>
          </div>
        )}
      </>}
    </div>
  );
}

interface Campaign { id: string; kind: CampaignKind; name: string; description: string | null; status: string; marketIds: string[]; zoneIds: string[]; windowStart: string; windowEnd: string; rules: CampaignRules; eligibility: { minRating?: number | null; vehicleTypes?: string[]; minDeliveries?: number | null }; enrolment: 'AUTO' | 'OPT_IN'; budgetCents: number; spentCents: number; version: number; terms: string; settledAt: string | null }
interface CampaignDetail extends Campaign { markets: { id: string; name: string }[]; zones: { id: string; name: string }[]; enrolled: number; participants: { driverId: string; name: string; payments: number; earnedCents: number }[] }

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const cents = (s: string) => Math.round(Number(s || 0) * 100);

/** Boosts, quests and hourly guarantees: create, schedule, follow spend, cancel. */
export function CampaignsTab() {
  const { can } = useSession();
  const { run, error } = useAction();
  const [status, setStatus] = useState('');
  const { data, reload } = useApi<Campaign[]>(`/admin/courier-campaigns${status ? `?status=${status}` : ''}`, { deps: [status], poll: 60000 });
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const act = (c: Campaign, what: 'activate' | 'cancel') => { const reason = askReason(what === 'activate' ? `starting “${c.name}”` : `canceling “${c.name}”`); if (reason) run(async () => { await api.post(`/admin/courier-campaigns/${c.id}/${what}`, { reason }); await reload(); }); };
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-ink-500">Courier incentives. A <b>boost</b> adds pay to every delivery in its window and shows on the offer. A <b>quest</b> pays a bonus for reaching a number of deliveries. A <b>guarantee</b> tops earnings up to a minimum per online hour. Quests and guarantees pay once, when the window ends. Every campaign stops at its budget.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>
        {can('delivery.manage') && <Button size="sm" onClick={() => setEditing('new')}>New campaign</Button>}
      </div>
      <Table rows={data ?? []} empty="No campaigns yet." cols={[
        { key: 'n', label: 'Campaign', render: (c) => <button className="text-left" onClick={() => setOpen(c.id)}><span className="font-medium underline-offset-2 hover:underline">{c.name}</span><div className="text-xs text-ink-500">{CAMPAIGN_KIND_LABELS[c.kind]} · {c.terms}</div></button> },
        { key: 'w', label: 'Window', render: (c) => <span className="text-xs">{when(c.windowStart)} → {when(c.windowEnd)}</span> },
        { key: 'e', label: 'Who', render: (c) => <span className="text-xs">{c.enrolment === 'OPT_IN' ? 'Couriers who join' : 'Everyone eligible'}{c.zoneIds.length ? ` · ${c.zoneIds.length} zone(s)` : c.marketIds.length ? ` · ${c.marketIds.length} market(s)` : ' · everywhere'}</span> },
        { key: 'b', label: 'Spent / budget', render: (c) => <span className="text-xs">{money(c.spentCents)} / {money(c.budgetCents)}<div className="mt-1 h-1 w-24 rounded bg-ink-100"><div className="h-1 rounded bg-brand-500" style={{ width: `${Math.min(100, (c.spentCents / Math.max(1, c.budgetCents)) * 100)}%` }} /></div></span> },
        { key: 's', label: 'Status', render: (c) => <Badge tone={statusTone(c.status)}>{c.status.toLowerCase()}</Badge> },
        { key: 'a', label: '', render: (c) => can('delivery.manage') && <span className="flex flex-wrap gap-1">
          {['DRAFT', 'SCHEDULED', 'ACTIVE'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>}
          {c.status === 'DRAFT' && <Button size="sm" variant="secondary" onClick={() => act(c, 'activate')}>Start</Button>}
          {['DRAFT', 'SCHEDULED', 'ACTIVE'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => act(c, 'cancel')}>Cancel</Button>}
        </span> },
      ]} />
      {editing && <CampaignEditor campaign={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {open && <CampaignView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CampaignEditor({ campaign, onClose, onSaved }: { campaign: Campaign | null; onClose: () => void; onSaved: () => void }) {
  const { run, error, busy } = useAction();
  const { data: net } = useApi<{ zones: { id: string; name: string; kind: string }[] }>('/admin/delivery/network');
  const { data: regions } = useApi<{ id: string; name: string }[]>('/admin/regions');
  const live = campaign?.status === 'ACTIVE';
  const now = new Date();
  const r = campaign?.rules ?? {};
  const [f, setF] = useState({
    kind: (campaign?.kind ?? 'BOOST') as CampaignKind,
    name: campaign?.name ?? '',
    description: campaign?.description ?? '',
    windowStart: toLocalInput(campaign ? new Date(campaign.windowStart) : new Date(now.getTime() + 3600_000)),
    windowEnd: toLocalInput(campaign ? new Date(campaign.windowEnd) : new Date(now.getTime() + 4 * 3600_000)),
    boost: r.boostCents ? String(r.boostCents / 100) : '', boostPercent: r.boostPercent ? String(r.boostPercent) : '',
    tiers: (r.tiers ?? [{ deliveries: 5, bonusCents: 1000 }]).map((t) => ({ deliveries: String(t.deliveries), bonus: String(t.bonusCents / 100) })),
    minPerHour: r.minPerHourCents ? String(r.minPerHourCents / 100) : '', minOnline: String(r.minOnlineMinutes ?? 60),
    zoneIds: campaign?.zoneIds ?? [], marketIds: campaign?.marketIds ?? [],
    enrolment: campaign?.enrolment ?? 'AUTO',
    minRating: campaign?.eligibility.minRating ? String(campaign.eligibility.minRating) : '', vehicleTypes: campaign?.eligibility.vehicleTypes ?? [],
    budget: campaign ? String(campaign.budgetCents / 100) : '500',
    reason: '',
  });
  const rules = (): CampaignRules => f.kind === 'BOOST' ? { ...(f.boost ? { boostCents: cents(f.boost) } : {}), ...(f.boostPercent ? { boostPercent: Number(f.boostPercent) } : {}) }
    : f.kind === 'QUEST' ? { tiers: f.tiers.filter((t) => t.deliveries && t.bonus).map((t) => ({ deliveries: Number(t.deliveries), bonusCents: cents(t.bonus) })) }
    : { minPerHourCents: cents(f.minPerHour), minOnlineMinutes: Number(f.minOnline || 0) };
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const save = () => run(async () => {
    const body = live
      ? { name: f.name, description: f.description || null, windowEnd: new Date(f.windowEnd).toISOString(), budgetCents: cents(f.budget), reason: f.reason }
      : { kind: f.kind, name: f.name, description: f.description || null, windowStart: new Date(f.windowStart).toISOString(), windowEnd: new Date(f.windowEnd).toISOString(), rules: rules(), zoneIds: f.zoneIds, marketIds: f.marketIds, enrolment: f.enrolment, eligibility: { minRating: f.minRating ? Number(f.minRating) : null, vehicleTypes: f.vehicleTypes }, budgetCents: cents(f.budget), reason: f.reason || undefined };
    if (campaign) await api.put(`/admin/courier-campaigns/${campaign.id}`, body); else await api.post('/admin/courier-campaigns', body);
    onSaved();
  });
  return (
    <Modal open onClose={onClose} title={campaign ? `Edit ${campaign.name}` : 'New campaign'}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {live && <Alert tone="info">This campaign is live. Couriers are already working to its terms, so only the name, description, budget and end time can change.</Alert>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Select label="Type" value={f.kind} disabled={live} onChange={(e) => setF({ ...f, kind: e.target.value as CampaignKind })}>{CAMPAIGN_KINDS.map((k) => <option key={k} value={k}>{CAMPAIGN_KIND_LABELS[k]}</option>)}</Select>
          <Input label="Name couriers see" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <Textarea label="Description (optional)" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input type="datetime-local" label="Starts" disabled={live} value={f.windowStart} onChange={(e) => setF({ ...f, windowStart: e.target.value })} />
          <Input type="datetime-local" label="Ends" value={f.windowEnd} onChange={(e) => setF({ ...f, windowEnd: e.target.value })} />
        </div>
        {!live && <Card title="Terms">
          {f.kind === 'BOOST' && <div className="grid gap-2 sm:grid-cols-2"><Input label="Extra per delivery ($)" inputMode="decimal" value={f.boost} onChange={(e) => setF({ ...f, boost: e.target.value })} /><Input label="And/or extra %" inputMode="decimal" value={f.boostPercent} onChange={(e) => setF({ ...f, boostPercent: e.target.value })} /></div>}
          {f.kind === 'QUEST' && <div className="space-y-2">{f.tiers.map((t, i) => <div key={i} className="flex items-end gap-2"><Input label="Deliveries" inputMode="numeric" value={t.deliveries} onChange={(e) => setF({ ...f, tiers: f.tiers.map((x, j) => (j === i ? { ...x, deliveries: e.target.value } : x)) })} /><Input label="Bonus ($)" inputMode="decimal" value={t.bonus} onChange={(e) => setF({ ...f, tiers: f.tiers.map((x, j) => (j === i ? { ...x, bonus: e.target.value } : x)) })} />{f.tiers.length > 1 && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, tiers: f.tiers.filter((_, j) => j !== i) })}>Remove</Button>}</div>)}{f.tiers.length < 5 && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, tiers: [...f.tiers, { deliveries: '', bonus: '' }] })}>Add tier</Button>}<p className="text-xs text-ink-500">Couriers get the highest tier they reach.</p></div>}
          {f.kind === 'GUARANTEE' && <div className="grid gap-2 sm:grid-cols-2"><Input label="Minimum per online hour ($)" inputMode="decimal" value={f.minPerHour} onChange={(e) => setF({ ...f, minPerHour: e.target.value })} /><Input label="Must be online at least (min)" inputMode="numeric" value={f.minOnline} onChange={(e) => setF({ ...f, minOnline: e.target.value })} /><p className="text-xs text-ink-500 sm:col-span-2">Tips don&apos;t count toward the minimum. Breaks don&apos;t count as online time.</p></div>}
        </Card>}
        {!live && <Card title="Where and who">
          <p className="mb-1 text-xs text-ink-500">Zones (none = every zone in the chosen markets, or everywhere)</p>
          <div className="mb-2 flex flex-wrap gap-1">{net?.zones.filter((z) => z.kind === 'SERVICE').map((z) => <button key={z.id} onClick={() => setF({ ...f, zoneIds: toggle(f.zoneIds, z.id) })} className={`rounded border px-2 py-0.5 text-xs ${f.zoneIds.includes(z.id) ? 'border-brand-500 bg-brand-50' : 'border-ink-200'}`}>{z.name}</button>)}</div>
          <p className="mb-1 text-xs text-ink-500">Markets</p>
          <div className="mb-2 flex flex-wrap gap-1">{regions?.map((m) => <button key={m.id} onClick={() => setF({ ...f, marketIds: toggle(f.marketIds, m.id) })} className={`rounded border px-2 py-0.5 text-xs ${f.marketIds.includes(m.id) ? 'border-brand-500 bg-brand-50' : 'border-ink-200'}`}>{m.name}</button>)}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select label="Enrolment" value={f.enrolment} onChange={(e) => setF({ ...f, enrolment: e.target.value as 'AUTO' | 'OPT_IN' })}><option value="AUTO">Every eligible courier</option><option value="OPT_IN">Couriers who join</option></Select>
            <Input label="Minimum rating (optional)" inputMode="decimal" value={f.minRating} onChange={(e) => setF({ ...f, minRating: e.target.value })} />
          </div>
          <p className="mb-1 mt-2 text-xs text-ink-500">Vehicles (none = all)</p>
          <div className="flex flex-wrap gap-1">{VEHICLE_TYPES.map((v) => <button key={v} onClick={() => setF({ ...f, vehicleTypes: toggle(f.vehicleTypes, v) })} className={`rounded border px-2 py-0.5 text-xs ${f.vehicleTypes.includes(v) ? 'border-brand-500 bg-brand-50' : 'border-ink-200'}`}>{v.toLowerCase()}</button>)}</div>
        </Card>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label="Budget ($)" inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
          <Input label={campaign ? 'Reason for the change' : 'Reason (optional)'} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button><Button disabled={busy || f.name.trim().length < 3 || (!!campaign && f.reason.trim().length < 3)} onClick={save}>{campaign ? 'Save changes' : 'Save as draft'}</Button></div>
        {!campaign && <p className="text-xs text-ink-500">Drafts don&apos;t reach couriers until you press Start.</p>}
      </div>
    </Modal>
  );
}

function CampaignView({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: c } = useApi<CampaignDetail>(`/admin/courier-campaigns/${id}`);
  return (
    <Modal open onClose={onClose} title={c?.name ?? 'Campaign'}>
      {c && <div className="space-y-3">
        <KeyValue rows={[
          ['Type', CAMPAIGN_KIND_LABELS[c.kind]], ['Terms', c.terms], ['Status', <Badge key="s" tone={statusTone(c.status)}>{c.status.toLowerCase()}</Badge>],
          ['Window', `${when(c.windowStart)} → ${when(c.windowEnd)}`],
          ['Where', c.zones.length ? c.zones.map((z) => z.name).join(', ') : c.markets.length ? c.markets.map((m) => m.name).join(', ') : 'Everywhere'],
          ['Who', `${c.enrolment === 'OPT_IN' ? `Couriers who join (${c.enrolled} joined)` : 'Every eligible courier'}${c.eligibility.vehicleTypes?.length ? ` · ${c.eligibility.vehicleTypes.join(', ').toLowerCase()}` : ''}${c.eligibility.minRating ? ` · rating ${c.eligibility.minRating}+` : ''}`],
          ['Spent', `${money(c.spentCents)} of ${money(c.budgetCents)}`], ['Version', String(c.version)], ...(c.settledAt ? [['Settled', when(c.settledAt)] as [string, React.ReactNode]] : []),
        ]} />
        {c.description && <p className="text-sm">{c.description}</p>}
        <Table rows={c.participants} empty="No courier has earned from this campaign yet." cols={[
          { key: 'n', label: 'Courier', render: (p) => <a className="underline" href={`/admin/couriers/${p.driverId}`}>{p.name}</a> },
          { key: 'p', label: 'Payments', render: (p) => p.payments },
          { key: 'e', label: 'Earned', render: (p) => money(p.earnedCents) },
        ]} />
      </div>}
    </Modal>
  );
}
