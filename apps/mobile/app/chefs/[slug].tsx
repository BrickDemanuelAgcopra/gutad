import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CHEF_FULFILLMENT_FORMATS, type PublicChefDish } from '@gutad/shared';
import { money } from '@/api';
import { useApi } from '@/hooks';
import { Badge, C, Card, Loading, Muted, s } from '@/ui';

interface Chef { displayName: string; bio: string | null; portraitUrl: string | null; cuisines: string[]; acceptingOrders: boolean; verifiedCredentials: string[] }

/** Chef storefront: profile, then dishes by section. */
export default function ChefStore() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data: c } = useApi<Chef>(`/public/chefs/${slug}`);
  const { data: dishes } = useApi<PublicChefDish[]>(`/public/chefs/${slug}/dishes`);
  if (!c) return <Loading />;
  const sections = Array.from(new Set((dishes || []).map((d) => d.section || 'Dishes')));
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {c.portraitUrl ? <Image source={{ uri: c.portraitUrl }} style={{ width: 72, height: 72, borderRadius: 36 }} /> : <Text style={{ fontSize: 40 }}>👩‍🍳</Text>}
          <View style={{ flex: 1 }}><Text style={{ fontSize: 20, fontWeight: '700' }}>{c.displayName}</Text><Muted>{c.cuisines.join(' · ')}</Muted>{!c.acceptingOrders && <Badge text="Not taking orders right now" tone="warn" />}</View>
        </View>
        {c.bio && <Text style={{ marginTop: 8, color: C.ink7 }}>{c.bio}</Text>}
        <Muted>Sold by Gutad · prepared in an approved partner kitchen</Muted>
      </Card>
      {sections.map((sec) => (
        <View key={sec}>
          <Text style={{ fontSize: 18, fontWeight: '700', marginVertical: 8 }}>{sec}</Text>
          {(dishes || []).filter((d) => (d.section || 'Dishes') === sec).map((d) => (
            <Pressable key={d.id} onPress={() => router.push({ pathname: '/chefs/dish/[id]', params: { id: d.id } })}>
              <Card style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700' }}>{d.title}</Text>
                  <Muted>{CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat].split(' —')[0]}{d.mode === 'CUSTOMIZABLE' ? ' · customizable' : ''}{d.minLeadDays ? ` · ${d.minLeadDays}+ days ahead` : ''}</Muted>
                  <Text style={{ fontWeight: '600', marginTop: 4 }}>{money(d.priceCents)} <Text style={{ color: C.ink5, fontWeight: '400' }}>· {d.portionDesc}</Text></Text>
                  {d.soldOut && <Badge text="Sold out" tone="warn" />}
                </View>
                {d.photos[0] && <Image source={{ uri: d.photos[0] }} style={{ width: 88, height: 88, borderRadius: 10 }} />}
              </Card>
            </Pressable>
          ))}
        </View>
      ))}
      {dishes && !dishes.length && <Muted>No dishes published yet.</Muted>}
    </ScrollView>
  );
}
