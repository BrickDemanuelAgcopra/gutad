import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CHEF_DISH_STATUS_LABELS, type ChefDishStatus } from '@gutad/shared';
import { api, money } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';

interface Dish { id: string; title: string; dishName: string; priceCents: number; reviewStatus: ChefDishStatus; pendingChanges: unknown; photos: string[]; soldOut: boolean; reviewNote: string | null }
interface Menu { sections: { id: string; name: string; dishes: Dish[] }[] }

/** Chef menu on the phone: sections and dishes reorder with ↑ ↓; tap a dish to edit. */
export default function ChefDishes() {
  const router = useRouter();
  const { data, setData } = useApi<Menu>('/chef/menu');
  const { run, error, busy } = useAction();
  const [section, setSection] = useState('');
  if (!data) return <Loading />;
  const save = (sections: Menu['sections']) => { setData({ sections }); return run(async () => setData(await api.put<Menu>('/chef/menu/order', { sections: sections.map((x) => ({ id: x.id, dishIds: x.dishes.map((d) => d.id) })) }))); };
  const swap = <T,>(a: T[], i: number, j: number) => { if (j < 0 || j >= a.length) return a; const n = [...a]; [n[i], n[j]] = [n[j], n[i]]; return n; };
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Button title="+ New dish" disabled={busy} onPress={() => run(async () => { const d = await api.post<{ id: string }>('/chef/dishes', { dishName: 'New dish' }); router.push({ pathname: '/chef/dish/[id]', params: { id: d.id } }); })} />
      <ErrorText msg={error} />
      {data.sections.map((sec, si) => (
        <Card key={sec.id}>
          <View style={s.row}>
            <Text style={{ fontWeight: '700', fontSize: 16, flex: 1 }}>{sec.name}</Text>
            <Pressable accessibilityLabel={`Move ${sec.name} up`} onPress={() => save(swap(data.sections, si, si - 1))} style={{ padding: 6 }}><Text>↑</Text></Pressable>
            <Pressable accessibilityLabel={`Move ${sec.name} down`} onPress={() => save(swap(data.sections, si, si + 1))} style={{ padding: 6 }}><Text>↓</Text></Pressable>
          </View>
          {!sec.dishes.length && <Muted>No dishes.</Muted>}
          {sec.dishes.map((d, di) => (
            <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderColor: C.ink1 }}>
              {d.photos[0] ? <Image source={{ uri: d.photos[0] }} style={{ width: 44, height: 44, borderRadius: 8 }} /> : <Text style={{ fontSize: 28 }}>🍽</Text>}
              <Pressable style={{ flex: 1 }} onPress={() => router.push({ pathname: '/chef/dish/[id]', params: { id: d.id } })}>
                <Text style={{ fontWeight: '600' }} numberOfLines={2}>{d.title}</Text>
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 2, flexWrap: 'wrap' }}><Badge text={CHEF_DISH_STATUS_LABELS[d.reviewStatus]} tone={d.reviewStatus === 'PUBLISHED' ? 'good' : d.reviewStatus === 'CHANGES_REQUESTED' ? 'warn' : 'info'} />{!!d.pendingChanges && <Badge text="Changes in review" tone="info" />}{d.soldOut && <Badge text="Sold out" tone="warn" />}<Muted>{money(d.priceCents)}</Muted></View>
              </Pressable>
              <View>
                <Pressable accessibilityLabel={`Move ${d.dishName} up`} onPress={() => save(data.sections.map((x) => (x.id === sec.id ? { ...x, dishes: swap(x.dishes, di, di - 1) } : x)))} style={{ padding: 4 }}><Text>↑</Text></Pressable>
                <Pressable accessibilityLabel={`Move ${d.dishName} down`} onPress={() => save(data.sections.map((x) => (x.id === sec.id ? { ...x, dishes: swap(x.dishes, di, di + 1) } : x)))} style={{ padding: 4 }}><Text>↓</Text></Pressable>
              </View>
            </View>
          ))}
        </Card>
      ))}
      <Card title="Add a section">
        <Input placeholder="e.g. Desserts" value={section} onChangeText={setSection} />
        <Button title="Add section" variant="secondary" disabled={!section.trim() || busy} onPress={() => run(async () => { await api.post('/chef/menu/sections', { name: section }); setSection(''); setData(await api.get<Menu>('/chef/menu')); })} />
      </Card>
    </ScrollView>
  );
}
