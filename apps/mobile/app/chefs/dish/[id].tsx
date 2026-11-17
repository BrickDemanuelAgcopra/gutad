import { useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CHEF_FULFILLMENT_FORMATS, type PublicChefDish } from '@gutad/shared';
import { money } from '@/api';
import { useCart } from '@/cart';
import { useApi } from '@/hooks';
import { Badge, Button, C, Card, Loading, Muted, s } from '@/ui';

/** Dish screen with a persistent bottom action; fixed dishes choose quantity, then a date and time at checkout. */
export default function ChefDish() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: d, error } = useApi<PublicChefDish & { acceptingOrders: boolean }>(`/public/chef-dishes/${id}`);
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  if (error) return <View style={[s.screen, s.pad]}><Muted>This dish isn’t available right now.</Muted></View>;
  if (!d) return <Loading />;
  const can = d.acceptingOrders && !d.soldOut;
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {d.photos[0] && <Image source={{ uri: d.photos[0] }} style={{ width: '100%', aspectRatio: 4 / 3 }} />}
        <View style={s.pad}>
          <Text style={{ fontSize: 22, fontWeight: '700' }}>{d.title}</Text>
          <Muted>Prepared by {d.chef.displayName} at an approved partner kitchen</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 8 }}><Badge text={CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat]} /><Badge text={d.mode === 'CUSTOMIZABLE' ? 'Customizable' : 'Fixed recipe'} tone={d.mode === 'CUSTOMIZABLE' ? 'info' : 'neutral'} />{d.dietaryTags.map((t) => <Badge key={t} text={t.replace('_', ' ')} tone="good" />)}</View>
          {d.description && <Text style={{ color: C.ink7, marginBottom: 8 }}>{d.description}</Text>}
          <Card>
            <Text style={s.label}>Portion</Text><Text style={{ marginBottom: 6 }}>{d.portionDesc}</Text>
            <Text style={s.label}>Ingredients</Text><Text style={{ marginBottom: 6 }}>{d.ingredients.join(', ')}</Text>
            <Text style={s.label}>Allergens</Text><Text style={{ color: d.allergens.length ? C.bad : C.ink, fontWeight: d.allergens.length ? '600' : '400' }}>{d.allergens.length ? d.allergens.map((a) => a.replace('_', ' ')).join(', ') : 'None of the major allergens declared'}</Text>
            <Muted>Prepared in a kitchen that may handle other allergens.</Muted>
            <Text style={[s.label, { marginTop: 6 }]}>Ordering</Text><Text>{d.minLeadDays ? `At least ${d.minLeadDays} day(s) ahead` : 'Same day available'}, up to {d.maxAdvanceDays} days ahead</Text>
          </Card>
        </View>
      </ScrollView>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.white, borderTopWidth: 1, borderColor: C.ink1, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Button title="−" variant="secondary" disabled={qty <= 1} onPress={() => setQty(qty - 1)} />
          <Text accessibilityLabel={`Quantity ${qty}`} style={{ minWidth: 24, textAlign: 'center', fontWeight: '700' }}>{qty}</Text>
          <Button title="+" variant="secondary" disabled={qty >= 20} onPress={() => setQty(qty + 1)} />
        </View>
        <Button style={{ flex: 1 }} disabled={!can} title={!can ? (d.soldOut ? 'Sold out' : 'Not taking orders') : `Add to cart — ${money(d.priceCents * qty)}`} onPress={() => { add({ id: d.location.id, slug: d.location.slug, name: `${d.chef.displayName} (Gutad Chef Network)` }, { menuItemId: d.menuItemId, name: d.title, quantity: qty, unitPriceCents: d.priceCents, modifierOptionIds: [], modifierNames: [], modifiersCents: 0 }, { park: true }); router.push('/checkout'); }} />
      </View>
    </View>
  );
}
