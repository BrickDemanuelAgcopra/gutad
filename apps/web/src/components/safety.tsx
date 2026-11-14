'use client';
import { useState } from 'react';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone, Table, Tabs } from '@/components/ui';
import { SensorsCard } from '@/components/followups-c';

interface Template { id: string; organizationId: string | null; name: string; kind: string; frequency: string; items: { key: string; label: string; requiresValue?: boolean }[] }
interface Action { id: string; source: string; title: string; status: string; dueAt: string | null; overdue: boolean; evidenceNote: string | null; evidenceUrl: string | null; completedById: string | null }

/** Phase I food-safety workspace for a kitchen (merchant Food safety page; admin Food safety per kitchen). */
export function SafetyWorkspace({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const [tab, setTab] = useState('temps');
  return (
    <div className="space-y-4">
      <Tabs tabs={[{ id: 'temps', label: 'Temperatures' }, { id: 'checklists', label: 'Checklists' }, { id: 'actions', label: 'Corrective actions' }, { id: 'inspections', label: 'Inspections' }, { id: 'allergens', label: 'Allergen reviews' }]} active={tab} onChange={setTab} />
      {tab === 'temps' && <Temperatures kitchenId={kitchenId} />}
      {tab === 'checklists' && <Checklists kitchenId={kitchenId} organizationId={organizationId} />}
      {tab === 'actions' && <Actions kitchenId={kitchenId} />}
      {tab === 'inspections' && <Inspections kitchenId={kitchenId} />}
      {tab === 'allergens' && <AllergenReviews organizationId={organizationId} />}
    </div>
  );
}

function Temperatures({ kitchenId }: { kitchenId: string }) {
  const { data, reload } = useApi<{ id: string; kind: string; tempC: number; minC: number | null; maxC: number | null; inRange: boolean; storageArea: string | null; note: string | null; createdAt: string }[]>(`/kitchens/${kitchenId}/temperatures`, { deps: [kitchenId] });
  const { data: areas } = useApi<{ id: string; name: string; kind: string }[]>(`/kitchens/${kitchenId}/storage-areas`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ kind: 'STORAGE', areaId: '', temp: '', note: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}{msg && <Alert tone="info">{msg}</Alert>}
      <Card title="Log a temperature">
        <div className="grid gap-2 sm:grid-cols-5"><Select label="Check" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="STORAGE">Storage</option><option value="RECEIVING">Receiving</option><option value="HOT_HOLD">Hot holding</option><option value="COOLING">Cooling</option></Select><Select label="Where" value={f.areaId} onChange={(e) => setF({ ...f, areaId: e.target.value })}><option value="">—</option>{areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><Input label="°C" value={f.temp} onChange={(e) => setF({ ...f, temp: e.target.value })} /><Input label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /><Button className="self-end" disabled={f.temp === ''} onClick={() => run(async () => { const r = await api.post<{ inRange: boolean; minC: number | null; maxC: number | null; quarantined: boolean }>(`/kitchens/${kitchenId}/temperatures`, { kind: f.kind, tempC: Number(f.temp), storageAreaId: f.areaId || undefined, note: f.note || undefined }); setMsg(r.inRange ? 'In range.' : `Out of range (${r.minC ?? '—'}…${r.maxC ?? '—'} °C): an alert and a corrective action were raised${r.quarantined ? '; the delivery is quarantined' : ''}.`); setF({ ...f, temp: '', note: '' }); await reload(); })}>Log</Button></div>
      </Card>
      <SensorsCard kitchenId={kitchenId} />
      <Table rows={data || []} empty="No readings this week." cols={[{ key: 'd', label: 'When', render: (t) => <span className="text-xs">{when(t.createdAt)}</span> }, { key: 'k', label: 'Check', render: (t) => `${t.kind.toLowerCase().replace('_', ' ')}${t.storageArea ? ` · ${t.storageArea}` : ''}` }, { key: 't', label: '°C', render: (t) => <span className={t.inRange ? '' : 'font-semibold text-red-700'}>{t.tempC}</span> }, { key: 'r', label: 'Safe range', render: (t) => `${t.minC ?? '—'} … ${t.maxC ?? '—'}` }, { key: 'n', label: 'Note', render: (t) => <span className="text-xs">{t.note}</span> }]} />
    </div>
  );
}

function Checklists({ kitchenId, organizationId }: { kitchenId: string; organizationId: string }) {
  const { user } = useSession();
  const { data: tpls } = useApi<Template[]>(`/organizations/${organizationId}/checklists`, { deps: [organizationId] });
  const { data: runs, reload } = useApi<{ id: string; template: string; missedItems: number; signedName: string; completedAt: string }[]>(`/checklist-runs?kitchenId=${kitchenId}&days=14`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [sel, setSel] = useState<Template | null>(null);
  const [ans, setAns] = useState<Record<string, { done: boolean; value: string }>>({});
  const [sig, setSig] = useState(user?.name || '');
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">{tpls?.map((t) => <Button key={t.id} size="sm" variant={sel?.id === t.id ? 'primary' : 'secondary'} onClick={() => { setSel(t); setAns({}); }}>{t.name} <span className="text-xs opacity-70">({t.frequency.toLowerCase()})</span></Button>)}</div>
      {sel && <Card title={sel.name}>
        {sel.items.map((i) => <div key={i.key} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={!!ans[i.key]?.done} onChange={(e) => setAns({ ...ans, [i.key]: { done: e.target.checked, value: ans[i.key]?.value || '' } })} />{i.label}{i.requiresValue && <Input className="w-28" placeholder="value" value={ans[i.key]?.value || ''} onChange={(e) => setAns({ ...ans, [i.key]: { done: ans[i.key]?.done ?? false, value: e.target.value } })} />}</div>)}
        <div className="mt-2 flex items-end gap-2"><Input label="Signed by" value={sig} onChange={(e) => setSig(e.target.value)} /><Button disabled={sig.length < 2} onClick={() => run(async () => { await api.post(`/checklists/${sel.id}/runs`, { kitchenId, signedName: sig, answers: sel.items.map((i) => ({ key: i.key, done: !!ans[i.key]?.done, value: ans[i.key]?.value || undefined })) }); setSel(null); await reload(); })}>Sign & submit</Button></div>
        <p className="mt-1 text-xs text-ink-500">Unticked steps create a corrective action.</p>
      </Card>}
      <Table rows={runs || []} empty="No checklists completed in the last 2 weeks." cols={[{ key: 'd', label: 'When', render: (r) => <span className="text-xs">{when(r.completedAt)}</span> }, { key: 't', label: 'Checklist', render: (r) => r.template }, { key: 's', label: 'Signed by', render: (r) => r.signedName }, { key: 'm', label: 'Missed', render: (r) => (r.missedItems ? <Badge tone="bad">{r.missedItems}</Badge> : <Badge tone="good">complete</Badge>) }]} />
    </div>
  );
}

export function Actions({ kitchenId }: { kitchenId?: string }) {
  const { data, reload } = useApi<Action[]>(`/corrective-actions${kitchenId ? `?kitchenId=${kitchenId}` : ''}`, { deps: [kitchenId] });
  const { user } = useSession();
  const { run, error } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No corrective actions." cols={[
        { key: 's', label: 'From', render: (a) => a.source.toLowerCase() }, { key: 't', label: 'Action', render: (a) => <span>{a.title}{a.evidenceNote && <span className="block text-xs text-ink-500">Evidence: {a.evidenceNote}{a.evidenceUrl && <> · <a className="underline" href={a.evidenceUrl} target="_blank" rel="noreferrer">file</a></>}</span>}</span> },
        { key: 'd', label: 'Due', render: (a) => <span className={a.overdue ? 'font-semibold text-red-700' : 'text-xs'}>{when(a.dueAt)}</span> },
        { key: 'st', label: 'Status', render: (a) => <Badge tone={a.status === 'VERIFIED' ? 'good' : a.status === 'DONE' ? 'info' : a.overdue ? 'bad' : 'warn'}>{a.status}</Badge> },
        { key: 'x', label: '', render: (a) => a.status === 'OPEN' ? <Button size="sm" onClick={() => { const note = window.prompt('What was done? (evidence)'); const url = note ? window.prompt('Link to a photo or document (optional)') : null; if (note) run(async () => { await api.post(`/corrective-actions/${a.id}/complete`, { evidenceNote: note, evidenceUrl: url || undefined }); await reload(); }); }}>Complete</Button> : a.status === 'DONE' && a.completedById !== user?.id ? <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.post(`/corrective-actions/${a.id}/verify`, {}); await reload(); })}>Verify</Button> : null },
      ]} />
      <p className="text-xs text-ink-500">Someone other than the person who completed an action verifies it.</p>
    </div>
  );
}

function Inspections({ kitchenId }: { kitchenId: string }) {
  const { data, reload } = useApi<{ id: string; kind: string; inspector: string; score: number | null; result: string; findings: { finding: string; severity: string }[]; inspectedAt: string }[]>(`/inspections?kitchenId=${kitchenId}`, { deps: [kitchenId] });
  const { run, error } = useAction();
  const [f, setF] = useState({ kind: 'INTERNAL', inspector: '', score: '', result: 'PASS', findings: '' });
  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Card title="Record an inspection">
        <div className="grid gap-2 sm:grid-cols-4"><Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="INTERNAL">Internal</option><option value="HEALTH_DEPT">Health department</option><option value="THIRD_PARTY">Third party</option></Select><Input label="Inspector" value={f.inspector} onChange={(e) => setF({ ...f, inspector: e.target.value })} /><Input label="Score" value={f.score} onChange={(e) => setF({ ...f, score: e.target.value })} /><Select label="Result" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option>PASS</option><option>CONDITIONAL</option><option>FAIL</option></Select></div>
        <Input className="mt-2" label="Findings (one per line, start with ! for serious)" value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} />
        <Button className="mt-2" disabled={f.inspector.length < 2} onClick={() => run(async () => { await api.post('/inspections', { kitchenId, kind: f.kind, inspector: f.inspector, score: f.score ? Number(f.score) : undefined, result: f.result, findings: f.findings.split(/[\n;]/).map((x) => x.trim()).filter(Boolean).map((x) => ({ finding: x.replace(/^!/, '').trim(), severity: x.startsWith('!') ? 'HIGH' : 'MEDIUM' })) }); setF({ kind: 'INTERNAL', inspector: '', score: '', result: 'PASS', findings: '' }); await reload(); })}>Save</Button>
        <p className="mt-1 text-xs text-ink-500">Each finding becomes a corrective action with a due date.</p>
      </Card>
      <Table rows={data || []} empty="No inspections." cols={[{ key: 'd', label: 'When', render: (i) => when(i.inspectedAt) }, { key: 'k', label: 'Type', render: (i) => `${i.kind.toLowerCase().replace('_', ' ')} · ${i.inspector}` }, { key: 'r', label: 'Result', render: (i) => <Badge tone={i.result === 'PASS' ? 'good' : i.result === 'FAIL' ? 'bad' : 'warn'}>{i.result}{i.score != null ? ` ${i.score}` : ''}</Badge> }, { key: 'f', label: 'Findings', render: (i) => <span className="text-xs">{i.findings.map((x) => x.finding).join('; ')}</span> }]} />
    </div>
  );
}

export function AllergenReviews({ organizationId }: { organizationId?: string }) {
  const { data, reload } = useApi<{ id: string; name: string; allergens: string[]; location: string }[]>(`/safety/allergen-reviews${organizationId ? `?organizationId=${organizationId}` : ''}`, { deps: [organizationId] });
  const { run, error } = useAction();
  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <Table rows={data || []} empty="No dishes waiting for an allergen review." cols={[{ key: 'n', label: 'Dish', render: (i) => <span>{i.name}<span className="block text-xs text-ink-500">{i.location}</span></span> }, { key: 'a', label: 'Listed allergens', render: (i) => i.allergens.join(', ') || 'none' }, { key: 'x', label: '', render: (i) => <Button size="sm" onClick={() => { const list = window.prompt('Confirm the allergens for this dish (comma separated)', i.allergens.join(', ')); const note = list !== null ? window.prompt('Review note (recipe change checked, labels updated)') : null; if (list !== null && note) run(async () => { await api.post(`/safety/allergen-reviews/${i.id}`, { allergens: list.split(',').map((x) => x.trim()).filter(Boolean), note }); await reload(); }); }}>Review & sign off</Button> }]} />
      <p className="text-xs text-ink-500">A recipe change that adds an allergen flags every dish using it until someone signs off the allergen list.</p>
    </div>
  );
}

export { statusTone };
