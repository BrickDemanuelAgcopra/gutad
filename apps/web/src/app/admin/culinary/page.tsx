'use client';
import { api, when } from '@/lib/api';
import { useAction, useApi, useSession } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Table } from '@/components/ui';
import { SectionTitle } from '@/components/admin-ui';

interface Rv { id: string; menuId: string; menuName: string; version: number; note: string | null; authorEmail: string | null; submittedAt: string }
interface Q { recipes: { id: string; name: string; version: number; status: string; authorEmail: string | null; trials: number; changeSummary: string | null; createdAt: string }[]; allergenFlags: { id: string; name: string; allergens: string[]; menu: string }[] }

/** Gutad catalog & culinary reviewers: menu versions in review, recipe releases and allergen flags across merchants. */
export default function Culinary() {
  const { can } = useSession();
  const { data: menus, reload } = useApi<Rv[]>('/admin/menu-reviews', { poll: 30000 });
  const { data: q, reload: reloadQ } = useApi<Q>('/admin/culinary-queue', { poll: 30000 });
  const { run, error } = useAction();
  return (
    <div className="space-y-4">
      <SectionTitle title="Menus & recipes review" hint="Menu versions merchants submitted for review, recipes waiting for release approval, and menu items whose recipe now contains unlisted allergens." />
      {error && <Alert>{error}</Alert>}
      <Card title={`Menu versions in review (${menus?.length ?? 0})`}>
        <Table rows={menus || []} empty="Nothing waiting." cols={[{ key: 'm', label: 'Menu', render: (r) => `${r.menuName} v${r.version}` }, { key: 'a', label: 'Author', render: (r) => <span className="text-xs">{r.authorEmail} · {when(r.submittedAt)}</span> }, { key: 'n', label: 'Note', render: (r) => <span className="text-xs">{r.note}</span> }, { key: 'x', label: '', render: (r) => can('catalog.manage') ? <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => run(async () => { const d = await api.get<{ added: unknown[]; removed: unknown[]; changed: unknown[] }>(`/menu-versions/${r.id}/diff`); window.alert(`Added ${d.added.length}, removed ${d.removed.length}, changed ${d.changed.length}\n\n${JSON.stringify(d.changed, null, 1).slice(0, 1500)}`); })}>Diff</Button><Button size="sm" onClick={() => run(async () => { await api.post(`/menu-versions/${r.id}/publish`, { note: 'Approved by Gutad catalog' }); reload(); })}>Approve & publish</Button><Button size="sm" variant="danger" onClick={() => { const note = window.prompt('What needs to change?'); if (note) run(async () => { await api.post(`/menu-versions/${r.id}/reject`, { note }); reload(); }); }}>Send back</Button></div> : null }]} />
      </Card>
      <Card title={`Recipes waiting for release (${q?.recipes.length ?? 0})`}>
        <Table rows={q?.recipes || []} empty="Nothing waiting." cols={[{ key: 'n', label: 'Recipe', render: (r) => `${r.name} v${r.version}` }, { key: 's', label: 'Status', render: (r) => <Badge tone="warn">{r.status}</Badge> }, { key: 't', label: 'Trials', render: (r) => r.trials }, { key: 'c', label: 'Change', render: (r) => <span className="text-xs">{r.changeSummary || '—'}</span> }, { key: 'a', label: 'Author', render: (r) => <span className="text-xs">{r.authorEmail}</span> }, { key: 'x', label: '', render: (r) => can('culinary.manage') ? <Button size="sm" onClick={() => { const note = window.prompt('Release note'); if (note) run(async () => { await api.post(`/recipes/${r.id}/approve`, { note }); reloadQ(); }); }}>Approve release</Button> : null }]} />
      </Card>
      <Card title={`Allergen review (${q?.allergenFlags.length ?? 0})`}>
        <Table rows={q?.allergenFlags || []} empty="No items flagged." cols={[{ key: 'n', label: 'Item', render: (r) => r.name }, { key: 'm', label: 'Menu', render: (r) => r.menu }, { key: 'a', label: 'Listed allergens', render: (r) => r.allergens.join(', ') || '—' }]} />
      </Card>
    </div>
  );
}
