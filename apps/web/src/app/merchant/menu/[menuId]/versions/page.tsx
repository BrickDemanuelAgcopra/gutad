'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MENU_ITEM_KINDS, TAX_CATEGORIES } from '@gutad/shared';
import { api, downloadFile, money, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Modal, Select } from '@/components/ui';

interface DocItem { id?: string; modifierGroupIds?: string[]; name: string; description?: string | null; priceCents: number; kind?: string; taxCategory?: string; isActive?: boolean; servingSize?: string | null }
interface DocOption { id?: string; name: string; priceCents: number; soldOut?: boolean }
interface DocGroup { id?: string; name: string; minSelect: number; maxSelect: number; required: boolean; options: DocOption[] }
interface Doc { categories: { id?: string; name: string; sortOrder?: number; items: DocItem[] }[]; modifierGroups?: DocGroup[] }
interface FieldChange { field: string; from: unknown; to: unknown }
interface ModifierDiff { added: { name: string; options: { name: string; priceCents: number }[] }[]; removed: { name: string }[]; changed: { name: string; fields: FieldChange[]; optionsAdded: { name: string; priceCents: number }[]; optionsRemoved: { name: string }[]; optionsChanged: { name: string; fields: FieldChange[] }[] }[] }
interface Version { id: string; version: number; status: string; note: string | null; authorEmail: string | null; reviewNote: string | null; publishedAt: string | null; createdAt: string; itemCount: number; document: Doc }
interface Diff { version: number; added: { name: string; category: string; priceCents: number }[]; removed: { name: string; category: string }[]; changed: { name: string; fields: FieldChange[] }[]; modifiers: ModifierDiff | null; validation: { ok: boolean; errors: string[]; warnings: string[] } }

/** Menu versions: edit a draft, see the diff, submit for review, publish, roll back; export. */
export default function MenuVersions() {
  const { menuId } = useParams<{ menuId: string }>();
  const { user } = useSession();
  const { data, reload } = useApi<{ menu: { id: string; name: string; version: number }; versions: Version[] }>(`/menus/${menuId}/versions`);
  const { run, error } = useAction();
  const draft = data?.versions.find((v) => v.status === 'DRAFT' || v.status === 'IN_REVIEW');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [view, setView] = useState<Version | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDoc(draft ? JSON.parse(JSON.stringify(draft.document)) : null); setSaved(false); }, [draft?.id, draft?.status]);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reload(); setDiff(null); });
  const setItem = (ci: number, ii: number, p: Partial<DocItem>) => { if (!doc) return; const d = { ...doc, categories: doc.categories.map((c, x) => (x !== ci ? c : { ...c, items: c.items.map((it, y) => (y === ii ? { ...it, ...p } : it)) })) }; setDoc(d); setSaved(false); };
  if (!data) return null;
  const editable = draft?.status === 'DRAFT';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><Link href="/merchant/menu" className="text-xs text-ink-500 underline">← Menus</Link><h1 className="text-2xl font-bold">{data.menu.name} · live v{data.menu.version}</h1></div>
        <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => run(() => downloadFile(`/menus/${menuId}/export?format=csv`, `${data.menu.name}.csv`))}>Export CSV</Button><Button size="sm" variant="secondary" onClick={() => run(() => downloadFile(`/menus/${menuId}/export?format=json`, `${data.menu.name}.json`))}>Export JSON</Button></div>
      </div>
      {error && <Alert>{error}</Alert>}
      {!draft ? (
        <Card title="Make changes"><p className="text-sm text-ink-500">Start a draft from the live menu. Customers keep seeing the live menu until you publish.</p><Button className="mt-2" onClick={() => act(() => api.post(`/menus/${menuId}/drafts`, {}))}>Start a draft</Button></Card>
      ) : doc && (
        <Card title={<span>Draft v{draft.version} <Badge tone={draft.status === 'IN_REVIEW' ? 'warn' : 'info'}>{draft.status.replace('_', ' ')}</Badge>{draft.reviewNote && <span className="ml-2 text-xs text-red-700">Review note: {draft.reviewNote}</span>}</span>}>
          {doc.categories.map((c, ci) => (
            <div key={ci} className="mb-3">
              <Input value={c.name} disabled={!editable} onChange={(e) => { setDoc({ ...doc, categories: doc.categories.map((x, i) => (i === ci ? { ...x, name: e.target.value } : x)) }); setSaved(false); }} />
              <table className="mt-1 w-full text-sm"><thead><tr className="text-left text-xs text-ink-500"><th>Item</th><th>Price</th><th>Kind</th><th>Tax</th><th>On</th></tr></thead><tbody>
                {c.items.map((it, ii) => (
                  <tr key={ii} className={`border-t border-ink-50 ${it.isActive === false ? 'opacity-50' : ''}`}>
                    <td className="py-1 pr-2"><input className="w-full rounded border border-ink-100 px-1" disabled={!editable} value={it.name} onChange={(e) => setItem(ci, ii, { name: e.target.value })} /></td>
                    <td className="w-24 pr-2"><input className="w-full rounded border border-ink-100 px-1" disabled={!editable} value={(it.priceCents / 100).toFixed(2)} onChange={(e) => setItem(ci, ii, { priceCents: Math.round(Number(e.target.value) * 100) || 0 })} /></td>
                    <td className="w-28 pr-2"><select className="w-full rounded border border-ink-100 text-xs" disabled={!editable} value={it.kind || 'ITEM'} onChange={(e) => setItem(ci, ii, { kind: e.target.value })}>{MENU_ITEM_KINDS.map((k) => <option key={k}>{k}</option>)}</select></td>
                    <td className="w-32 pr-2"><select className="w-full rounded border border-ink-100 text-xs" disabled={!editable} value={it.taxCategory || 'STANDARD'} onChange={(e) => setItem(ci, ii, { taxCategory: e.target.value })}>{TAX_CATEGORIES.map((k) => <option key={k.key} value={k.key}>{k.key.toLowerCase()}</option>)}</select></td>
                    <td className="w-10"><input type="checkbox" disabled={!editable} checked={it.isActive !== false} onChange={(e) => setItem(ci, ii, { isActive: e.target.checked })} /></td>
                  </tr>
                ))}
              </tbody></table>
              {editable && <button className="mt-1 text-xs underline" onClick={() => { setDoc({ ...doc, categories: doc.categories.map((x, i) => (i === ci ? { ...x, items: [...x.items, { name: 'New item', priceCents: 0 }] } : x)) }); setSaved(false); }}>+ Add item</button>}
            </div>
          ))}
          {editable && <button className="text-xs underline" onClick={() => { setDoc({ ...doc, categories: [...doc.categories, { name: 'New category', items: [] }] }); setSaved(false); }}>+ Add category</button>}
          {doc.modifierGroups && <ModifierGroupsEditor groups={doc.modifierGroups} editable={!!editable} onChange={(modifierGroups) => { setDoc({ ...doc, modifierGroups }); setSaved(false); }} />}
          <div className="mt-3 flex flex-wrap gap-2">
            {editable && <Button size="sm" variant="secondary" onClick={() => run(async () => { await api.put(`/menu-versions/${draft.id}`, { document: doc }); setSaved(true); await reload(); })}>{saved ? 'Saved ✓' : 'Save draft'}</Button>}
            <Button size="sm" variant="ghost" onClick={() => run(async () => setDiff(await api.get<Diff>(`/menu-versions/${draft.id}/diff`)))}>Compare with live</Button>
            {editable && <Button size="sm" variant="secondary" onClick={() => act(() => api.post(`/menu-versions/${draft.id}/submit`, {}))}>Submit for review</Button>}
            <Button size="sm" onClick={() => act(() => api.post(`/menu-versions/${draft.id}/publish`, { note: window.prompt('Publish note (optional)') || undefined }))}>Publish</Button>
            {draft.status === 'IN_REVIEW' && draft.authorEmail !== user?.email && <Button size="sm" variant="danger" onClick={() => { const note = window.prompt('What needs to change?'); if (note) act(() => api.post(`/menu-versions/${draft.id}/reject`, { note })); }}>Send back</Button>}
          </div>
          {diff && (
            <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
              {!diff.validation.ok && <Alert>{diff.validation.errors.join('; ')}</Alert>}
              {diff.validation.warnings.length > 0 && <p className="text-xs text-amber-700">{diff.validation.warnings.join('; ')}</p>}
              <div><b>Added</b> {diff.added.map((a) => `${a.name} (${money(a.priceCents)})`).join(', ') || '—'}</div>
              <div><b>Removed</b> {diff.removed.map((a) => a.name).join(', ') || '—'}</div>
              <div><b>Changed</b> {diff.changed.map((c) => `${c.name}: ${c.fields.map((f) => `${f.field} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`).join(', ')}`).join(' · ') || '—'}</div>
              {diff.modifiers && (
                <div className="mt-2 border-t border-ink-100 pt-2">
                  <div className="text-xs font-semibold uppercase text-ink-500">Modifier groups</div>
                  <div><b>Added</b> {diff.modifiers.added.map((g) => `${g.name} (${g.options.map((o) => `${o.name} ${money(o.priceCents)}`).join(', ') || 'no options'})`).join(' · ') || '—'}</div>
                  <div><b>Removed</b> {diff.modifiers.removed.map((g) => g.name).join(', ') || '—'}</div>
                  <div><b>Changed</b> {diff.modifiers.changed.map((g) => [
                    `${g.name}:`,
                    ...g.fields.map((f) => `${f.field} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`),
                    ...g.optionsAdded.map((o) => `+${o.name} (${money(o.priceCents)})`),
                    ...g.optionsRemoved.map((o) => `−${o.name}`),
                    ...g.optionsChanged.map((o) => `${o.name} ${o.fields.map((f) => `${f.field} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`).join(', ')}`),
                  ].join(' ')).join(' · ') || '—'}</div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
      <SharingCard menuId={menuId} />
      <Card title="History">
        <ul className="divide-y divide-ink-50 text-sm">{data.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>v{v.version} <Badge tone={v.status === 'PUBLISHED' ? 'good' : v.status === 'IN_REVIEW' ? 'warn' : 'neutral'}>{v.status}</Badge> <span className="text-xs text-ink-500">{v.itemCount} items · {v.authorEmail || '—'} · {when(v.publishedAt || v.createdAt)}{v.note ? ` · ${v.note}` : ''}</span></span>
            <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setView(v)}>View</Button>{v.status === 'SUPERSEDED' && <Button size="sm" variant="secondary" onClick={() => { const reason = window.prompt(`Why restore v${v.version}?`); if (reason) act(() => api.post(`/menu-versions/${v.id}/rollback`, { reason })); }}>Restore</Button>}</span>
          </li>
        ))}</ul>
      </Card>
      <Modal open={!!view} onClose={() => setView(null)} title={view ? `v${view.version}` : ''}>
        {view && view.document.categories.map((c, i) => <div key={i} className="mb-2"><div className="font-semibold">{c.name}</div>{c.items.map((it, j) => <div key={j} className={`flex justify-between text-sm ${it.isActive === false ? 'text-ink-300 line-through' : ''}`}><span>{it.name}</span><span>{money(it.priceCents)}</span></div>)}</div>)}
      </Modal>
    </div>
  );
}

/** 7.7-M modifier groups are part of the versioned document: edit groups and options here; publish or rollback applies them. */
function ModifierGroupsEditor({ groups, editable, onChange }: { groups: DocGroup[]; editable: boolean; onChange: (g: DocGroup[]) => void }) {
  const setGroup = (gi: number, p: Partial<DocGroup>) => onChange(groups.map((g, i) => (i === gi ? { ...g, ...p } : g)));
  const setOption = (gi: number, oi: number, p: Partial<DocOption>) => setGroup(gi, { options: groups[gi].options.map((o, i) => (i === oi ? { ...o, ...p } : o)) });
  return (
    <div className="mt-4 border-t border-ink-100 pt-3">
      <div className="text-sm font-semibold">Modifier groups</div>
      <p className="text-xs text-ink-500">Shared groups change for every item that uses them once this version is published.</p>
      {groups.length === 0 && <p className="text-xs text-ink-500">No modifier groups on this menu.</p>}
      {groups.map((g, gi) => (
        <div key={g.id || gi} className="mt-2 rounded border border-ink-100 p-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input className="flex-1 rounded border border-ink-100 px-1" disabled={!editable} value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} />
            <label className="text-xs">min <input type="number" className="w-12 rounded border border-ink-100 px-1" disabled={!editable} value={g.minSelect} onChange={(e) => setGroup(gi, { minSelect: Math.max(0, Number(e.target.value) || 0) })} /></label>
            <label className="text-xs">max <input type="number" className="w-12 rounded border border-ink-100 px-1" disabled={!editable} value={g.maxSelect} onChange={(e) => setGroup(gi, { maxSelect: Math.max(0, Number(e.target.value) || 0) })} /></label>
            <label className="text-xs"><input type="checkbox" disabled={!editable} checked={g.required} onChange={(e) => setGroup(gi, { required: e.target.checked })} /> required</label>
          </div>
          <table className="mt-1 w-full text-sm"><tbody>
            {g.options.map((o, oi) => (
              <tr key={o.id || oi} className="border-t border-ink-50">
                <td className="py-1 pr-2"><input className="w-full rounded border border-ink-100 px-1" disabled={!editable} value={o.name} onChange={(e) => setOption(gi, oi, { name: e.target.value })} /></td>
                <td className="w-24 pr-2"><input className="w-full rounded border border-ink-100 px-1" disabled={!editable} value={(o.priceCents / 100).toFixed(2)} onChange={(e) => setOption(gi, oi, { priceCents: Math.round(Number(e.target.value) * 100) || 0 })} /></td>
                <td className="w-24 text-xs"><label><input type="checkbox" disabled={!editable} checked={!!o.soldOut} onChange={(e) => setOption(gi, oi, { soldOut: e.target.checked })} /> sold out</label></td>
                <td className="w-8">{editable && <button className="text-xs text-red-700" onClick={() => setGroup(gi, { options: g.options.filter((_, i) => i !== oi) })}>✕</button>}</td>
              </tr>
            ))}
          </tbody></table>
          {editable && <button className="mt-1 text-xs underline" onClick={() => setGroup(gi, { options: [...g.options, { name: 'New option', priceCents: 0 }] })}>+ Add option</button>}
        </div>
      ))}
    </div>
  );
}

/** Offer this menu at other locations of the same merchant (assortment and prices can differ per location). */
function SharingCard({ menuId }: { menuId: string }) {
  const { data, reload } = useApi<{ ownerLocationId: string; locations: { id: string; name: string; owner: boolean; offered: boolean }[] }>(`/menus/${menuId}/sharing`);
  const { run, error } = useAction();
  if (!data || data.locations.length < 2) return null;
  const offered = data.locations.filter((l) => l.offered && !l.owner).map((l) => l.id);
  return (
    <Card title="Offered at">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-3 text-sm">{data.locations.map((l) => <label key={l.id} className="flex items-center gap-1"><input type="checkbox" disabled={l.owner} checked={l.offered} onChange={(e) => run(async () => { await api.put(`/menus/${menuId}/sharing`, { locationIds: e.target.checked ? [...offered, l.id] : offered.filter((x) => x !== l.id) }); reload(); })} />{l.name}{l.owner && <span className="text-xs text-ink-500"> (owner)</span>}</label>)}</div>
      <p className="mt-1 text-xs text-ink-500">Set a different price or hide an item at a location from the item&apos;s Details page.</p>
    </Card>
  );
}
