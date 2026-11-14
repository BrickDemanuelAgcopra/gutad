import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '@/ui';
import { Pills } from '@/ops';

interface Rv { id: string; menuName: string; version: number; note: string | null; authorEmail: string | null; submittedAt: string }
interface Q { recipes: { id: string; name: string; version: number; status: string; trials: number; changeSummary: string | null; authorEmail: string | null }[]; allergenFlags: { id: string; name: string; allergens: string[]; menu: string }[] }
interface Diff { added: { name: string }[]; removed: { name: string }[]; changed: { name: string; fields: { field: string; from: unknown; to: unknown }[] }[] }

/** Menus & recipes review on the phone: publish or send back menu versions, release recipes, see allergen flags. */
export default function OpsCulinary() {
  const { can } = useSession();
  const [tab, setTab] = useState<'menus' | 'recipes' | 'allergens'>('menus');
  const { data: menus, reload } = useApi<Rv[]>('/admin/menu-reviews', { poll: 30000 });
  const { data: q, reload: reloadQ } = useApi<Q>('/admin/culinary-queue', { poll: 30000 });
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const [diff, setDiff] = useState<Record<string, Diff>>({});
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'menus', label: `Menus (${menus?.length ?? 0})` }, { id: 'recipes', label: `Recipes (${q?.recipes.length ?? 0})` }, { id: 'allergens', label: `Allergens (${q?.allergenFlags.length ?? 0})` }]} />
      <ErrorText msg={error} />
      {tab === 'menus' && menus?.map((m) => (
        <Card key={m.id} title={`${m.menuName} v${m.version}`}>
          <Muted>{m.authorEmail} · {when(m.submittedAt)}{m.note ? ` · ${m.note}` : ''}</Muted>
          {diff[m.id] ? <View style={{ marginTop: 6 }}><Muted>Added: {diff[m.id].added.map((a) => a.name).join(', ') || '—'}</Muted><Muted>Removed: {diff[m.id].removed.map((a) => a.name).join(', ') || '—'}</Muted>{diff[m.id].changed.map((c) => <Muted key={c.name}>{c.name}: {c.fields.map((f) => `${f.field} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`).join(', ')}</Muted>)}</View> : <Button title="Show changes" variant="ghost" onPress={() => run(async () => { const d = await api.get<Diff>(`/menu-versions/${m.id}/diff`); setDiff({ ...diff, [m.id]: d }); })} />}
          {can('catalog.manage') && <><Input label="Note (required to send back)" value={note} onChangeText={setNote} /><Button title="Approve & publish" onPress={() => run(async () => { await api.post(`/menu-versions/${m.id}/publish`, { note: note || 'Approved by Gutad catalog' }); setNote(''); reload(); })} /><Button title="Send back" variant="danger" disabled={note.trim().length < 3} onPress={() => run(async () => { await api.post(`/menu-versions/${m.id}/reject`, { note }); setNote(''); reload(); })} /></>}
        </Card>
      ))}
      {tab === 'recipes' && q?.recipes.map((r) => (
        <Card key={r.id} title={`${r.name} v${r.version}`}>
          <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={r.status} tone="warn" /><Muted>{r.trials} trial(s) · {r.authorEmail}</Muted></View>
          {r.changeSummary && <Text style={{ color: C.ink7, marginTop: 4 }}>{r.changeSummary}</Text>}
          {can('culinary.manage') && <><Input label="Release note" value={note} onChangeText={setNote} /><Button title="Approve release" disabled={note.trim().length < 3} onPress={() => run(async () => { await api.post(`/recipes/${r.id}/approve`, { note }); setNote(''); reloadQ(); })} /></>}
        </Card>
      ))}
      {tab === 'allergens' && q?.allergenFlags.map((a) => <Card key={a.id} title={a.name}><Muted>{a.menu} · listed: {a.allergens.join(', ') || 'none'}</Muted><Muted>The recipe changed; the merchant updates the item&apos;s allergens.</Muted></Card>)}
    </ScrollView>
  );
}
