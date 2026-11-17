import { useMemo, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CHEF_FULFILLMENT_FORMATS, chefNoticeText, modifierLabel, type ChefAvailability, type PublicChefDish } from '@gutad/shared';
import { money } from '@/api';
import { useCart } from '@/cart';
import { useApi } from '@/hooks';
import { Badge, Button, C, Card, Loading, Muted, s } from '@/ui';
import { Customizer, Summary, useCustomization } from '@/customize';
import { DateSlotPicker, ymdLabel } from '@/date-slot-picker';

type Dish = PublicChefDish & { acceptingOrders: boolean };

export default function ChefDishScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: d, error } = useApi<Dish>(`/public/chef-dishes/${id}`);
  if (error) return <View style={[s.screen, s.pad]}><Muted>This dish isn’t available right now.</Muted></View>;
  if (!d) return <Loading />;
  return <DishView d={d} />;
}

/** The dish first; "Customize" reveals the options. The bottom action always shows the confirmed price. */
function DishView({ d }: { d: Dish }) {
  const router = useRouter();
  const { add } = useCart();
  const groups = useMemo(() => d.groups || [], [d.groups]);
  const base = useMemo(() => ({ allergens: d.allergens, dietaryTags: d.dietaryTags }), [d.allergens, d.dietaryTags]);
  const { picks, setPicks, ev } = useCustomization(d.dishName, groups, base);
  const customizable = groups.some((g) => g.selectionType !== 'INCLUDED');
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(1);
  const { data: avail, loading: availLoading } = useApi<ChefAvailability>(`/public/chef-dishes/${d.id}/availability?quantity=${qty}`);
  const [showCal, setShowCal] = useState(false);
  const [peek, setPeek] = useState<{ date: string; time: string } | null>(null);
  const noDates = !!avail && !avail.earliestDate;
  const can = d.acceptingOrders && !d.soldOut && !noDates;
  const unit = d.priceCents + ev.modifiersCents;
  const addToCart = () => {
    const names = ev.chosen.filter((c) => c.priceCents > 0 || !groups.find((g) => g.id === c.groupId)?.options.find((o) => o.id === c.id)?.isDefault).map(modifierLabel);
    add({ id: d.location.id, slug: d.location.slug, name: `${d.chef.displayName} (Gutad Chef Network)` }, { menuItemId: d.menuItemId, name: d.title, quantity: qty, unitPriceCents: d.priceCents, modifierOptionIds: ev.optionIds, modifierNames: names, modifiersCents: ev.modifiersCents }, { park: true });
    router.push('/checkout');
  };
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
        {d.photos[0] && !open && <Image source={{ uri: d.photos[0] }} style={{ width: '100%', aspectRatio: 4 / 3 }} />}
        <View style={s.pad}>
          <Text style={{ fontSize: 22, fontWeight: '700' }}>{d.title}</Text>
          <Muted>Prepared by {d.chef.displayName} at an approved partner kitchen</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 8 }}><Badge text={CHEF_FULFILLMENT_FORMATS[d.fulfillmentFormat]} /><Badge text={customizable ? 'Customizable' : 'Fixed recipe'} tone={customizable ? 'info' : 'neutral'} />{ev.dietaryTags.map((t) => <Badge key={t} text={t.replace('_', ' ')} tone="good" />)}</View>
          {open && customizable ? (
            <Card title="Customize">
              <Customizer groups={groups} picks={picks} setPicks={setPicks} ev={ev} chefName={d.chef.displayName} acceptsRequests={d.acceptsSpecialRequests} />
              <Summary base={d.priceCents} ev={ev} qty={qty} baseAllergens={d.allergens} />
            </Card>
          ) : (
            <>
              {d.description && <Text style={{ color: C.ink7, marginBottom: 8 }}>{d.description}</Text>}
              <Card>
                <Text style={s.label}>Portion</Text><Text style={{ marginBottom: 6 }}>{d.portionDesc}</Text>
                <Text style={s.label}>Ingredients</Text><Text style={{ marginBottom: 6 }}>{d.ingredients.join(', ')}</Text>
                <Text style={s.label}>Allergens</Text><Text style={{ color: ev.allergens.length ? C.bad : C.ink, fontWeight: ev.allergens.length ? '600' : '400' }}>{ev.allergens.length ? ev.allergens.map((a) => a.replace('_', ' ')).join(', ') : 'None of the major allergens declared'}</Text>
                <Muted>Removing an ingredient doesn’t make a dish allergen-free.</Muted>
                <Text style={[s.label, { marginTop: 6 }]}>Ordering</Text><Text>{avail ? chefNoticeText(avail.rules.minLeadDays, avail.rules.cutoffHour) : chefNoticeText(d.minLeadDays, d.cutoffHour)}, up to {avail?.rules.maxAdvanceDays ?? d.maxAdvanceDays} days ahead</Text>
                {avail && <Text style={{ marginTop: 4, fontWeight: '600', color: avail.earliestDate ? C.good : C.warn }}>{avail.earliestDate ? `Next available: ${ymdLabel(avail.earliestDate)}` : 'No dates open right now'}</Text>}
                {avail && <Button variant="ghost" title={showCal ? 'Hide available dates' : 'See available dates'} onPress={() => setShowCal(!showCal)} />}
                {showCal && <DateSlotPicker availability={avail} loading={availLoading} value={peek || (avail?.earliestDate ? { date: avail.earliestDate, time: '' } : null)} onChange={(v) => setPeek({ date: v.date, time: '' })} hideTimes />}
                {showCal && <Muted>You’ll pick the exact day and time at checkout.</Muted>}
              </Card>
            </>
          )}
        </View>
      </ScrollView>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.white, borderTopWidth: 1, borderColor: C.ink1, padding: 12, gap: 8 }}>
        {(open || !customizable) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Button title="−" variant="secondary" disabled={qty <= 1} onPress={() => setQty(qty - 1)} />
            <Text accessibilityLabel={`Quantity ${qty}`} style={{ minWidth: 24, textAlign: 'center', fontWeight: '700' }}>{qty}</Text>
            <Button title="+" variant="secondary" disabled={qty >= 20} onPress={() => setQty(qty + 1)} />
            {open && <Button variant="ghost" title="Back to dish" onPress={() => setOpen(false)} />}
          </View>
        )}
        {!can ? <Button disabled title={d.soldOut ? 'Sold out' : noDates ? 'No dates open right now' : 'Not taking orders'} onPress={() => undefined} />
          : customizable && !open ? <Button title={`Customize & order — from ${money(d.priceCents)}`} onPress={() => setOpen(true)} />
          : <Button disabled={!ev.ok} title={ev.ok ? `Add to cart — ${money(unit * qty)}` : 'Finish required choices'} onPress={addToCart} />}
      </View>
    </View>
  );
}
