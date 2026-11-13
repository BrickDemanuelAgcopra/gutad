import { ScrollView, Text, View } from 'react-native';
import { useApi } from '@/hooks';
import { Badge, C, Card, Loading, Muted, s, tone } from '@/ui';
import { StatTile } from '@/ops';

interface Loc { id: string; name: string; city: string; status: string }
interface Node { region: { id: string; code: string; name: string } | null; foodHalls: (Loc & { kitchen: { name: string } | null; brands: { id: string; name: string }[] })[]; merchants: { org: { id: string; name: string } | undefined; locations: Loc[] }[] }

/** Read-only organization tree: regions → food halls (with kitchen & brands) and independent merchants. */
export default function OpsStructure() {
  const { data } = useApi<{ regions: Node[]; legalEntities: { id: string; legalName: string; organizationName?: string }[]; counts: Record<string, number> }>('/admin/structure');
  if (!data) return <Loading />;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <StatTile label="Regions" value={data.counts.regions} />
        <StatTile label="Locations" value={data.counts.locations} hint={`${data.counts.foodHalls} food halls`} />
        <StatTile label="Organizations" value={data.counts.organizations} />
        <StatTile label="Brands" value={data.counts.brands} hint={`${data.counts.legalEntities} legal entities`} />
      </View>
      {data.regions.map((n) => (
        <Card key={n.region?.id || 'none'} title={n.region ? `${n.region.name} (${n.region.code})` : 'Not assigned to a region'}>
          {n.foodHalls.map((h) => (
            <View key={h.id} style={{ marginBottom: 8 }}>
              <View style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>🍽 {h.name}</Text><Badge text={h.status} tone={tone(h.status)} /></View>
              <Muted>Made at Gutad · kitchen {h.kitchen?.name || '—'} · {h.brands.map((b) => b.name).join(', ')}</Muted>
            </View>
          ))}
          {n.merchants.map((m) => (
            <View key={m.org?.id} style={{ marginBottom: 8 }}>
              <Text style={{ fontWeight: '600', color: C.ink }}>{m.org?.name}</Text>
              {m.locations.map((l) => <Muted key={l.id}>• {l.name}, {l.city} ({l.status.toLowerCase()})</Muted>)}
            </View>
          ))}
        </Card>
      ))}
      <Card title="Legal entities">{data.legalEntities.map((l) => <Muted key={l.id}>{l.legalName} · {l.organizationName}</Muted>)}</Card>
      <Muted>Assign regions and add new ones on the web console.</Muted>
    </ScrollView>
  );
}
