import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import type { MenuDto, MenuItemDto } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { useCart } from '@/cart';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';

interface Loc { id: string; slug: string; name: string; description: string | null; heroImageUrl: string | null; cuisine: string[]; isOpenNow: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean; acceptsEvents: boolean; addressLine1: string; city: string; rating: number | null; experiences: { id: string; name: string; priceCents: number; pricingMode: string }[]; currency: string }

export default function Restaurant() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data: loc } = useApi<Loc>(`/public/locations/${slug}`);
  const { data: menus } = useApi<(MenuDto & { brand?: { name: string } | null })[]>(loc ? `/public/locations/${loc.id}/menus?channel=MARKETPLACE` : null, { deps: [loc?.id] });
  const { cart, add, count, subtotal } = useCart();
  const [picked, setPicked] = useState<MenuItemDto | null>(null);
  const [tab, setTab] = useState<'order' | 'experiences'>('order');
  if (!loc) return <Loading />;
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
        {loc.heroImageUrl && <Image source={{ uri: loc.heroImageUrl }} style={{ height: 180, width: '100%' }} />}
        <View style={s.pad}>
          <View style={s.row}><Text style={{ fontSize: 22, fontWeight: '700', flex: 1 }}>{loc.name}</Text><Badge text={loc.isOpenNow ? 'OPEN' : 'CLOSED'} tone={loc.isOpenNow ? 'good' : 'bad'} /></View>
          <Muted>{loc.cuisine.join(' · ')} · {loc.addressLine1}, {loc.city}{loc.rating ? ` · ★ ${loc.rating.toFixed(1)}` : ''}</Muted>
          {loc.description && <Text style={{ marginTop: 6, color: C.ink7 }}>{loc.description}</Text>}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            {loc.acceptsReservations && <Link href={{ pathname: '/reserve/[slug]', params: { slug: loc.slug } }} asChild><Button title="Reserve a table" variant="secondary" onPress={() => undefined} /></Link>}
            {loc.experiences.length > 0 && <Button title="Experiences" variant={tab === 'experiences' ? 'primary' : 'secondary'} onPress={() => setTab(tab === 'experiences' ? 'order' : 'experiences')} />}
          </View>
          {tab === 'experiences' ? <Experiences locId={loc.id} /> : !menus ? <Loading /> : menus.map((m) => (
            <View key={m.id} style={{ marginTop: 12 }}>
              {menus.length > 1 && <Text style={{ fontSize: 18, fontWeight: '700' }}>{m.brand?.name || m.name}</Text>}
              {m.categories.map((c) => (
                <View key={c.id} style={{ marginTop: 8 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, marginBottom: 4 }}>{c.name}</Text>
                  {c.items.map((it) => (
                    <Pressable key={it.id} disabled={it.soldOut} onPress={() => setPicked(it)} style={[s.card, { flexDirection: 'row', opacity: it.soldOut ? 0.5 : 1, marginBottom: 8 }]}>
                      <View style={{ flex: 1 }}><Text style={{ fontWeight: '600' }}>{it.name} {it.soldOut ? '(sold out)' : ''}</Text>{it.description ? <Muted>{it.description}</Muted> : null}<Text style={{ marginTop: 4, fontWeight: '700' }}>{money(it.priceCents)}</Text></View>
                      {it.imageUrl && <Image source={{ uri: it.imageUrl }} style={{ width: 64, height: 64, borderRadius: 8, marginLeft: 8 }} />}
                    </Pressable>
                  ))}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {cart.locationId === loc.id && count > 0 && (
        <View style={{ position: 'absolute', bottom: 16, left: 16, right: 16 }}><Button title={`View cart · ${count} items · ${money(subtotal)}`} onPress={() => router.push('/checkout')} /></View>
      )}
      <Modal visible={!!picked} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPicked(null)}>
        {picked && <ItemSheet item={picked} onClose={() => setPicked(null)} onAdd={(l) => { add({ id: loc.id, name: loc.name, slug: loc.slug }, l); setPicked(null); }} />}
      </Modal>
    </View>
  );
}

function ItemSheet({ item, onClose, onAdd }: { item: MenuItemDto; onClose: () => void; onAdd: (l: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string }) => void }) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const toggle = (gid: string, max: number, oid: string) => setSel((st) => { const cur = st[gid] || []; if (max === 1) return { ...st, [gid]: cur.includes(oid) ? [] : [oid] }; if (cur.includes(oid)) return { ...st, [gid]: cur.filter((x) => x !== oid) }; return cur.length >= max ? st : { ...st, [gid]: [...cur, oid] }; });
  const chosen = item.modifierGroups.flatMap((g) => g.options.filter((o) => (sel[g.id] || []).includes(o.id)));
  const modCents = chosen.reduce((a, o) => a + o.priceCents, 0);
  const invalid = item.modifierGroups.find((g) => (sel[g.id] || []).length < (g.required ? Math.max(1, g.minSelect) : g.minSelect));
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <View style={s.row}><Text style={{ fontSize: 20, fontWeight: '700' }}>{item.name}</Text><Pressable onPress={onClose}><Text style={{ color: C.ink5, fontSize: 18 }}>✕</Text></Pressable></View>
      {item.description && <Muted>{item.description}</Muted>}
      {item.modifierGroups.map((g) => (
        <View key={g.id} style={{ marginTop: 12 }}>
          <Text style={{ fontWeight: '700' }}>{g.name} <Text style={{ color: C.ink5, fontWeight: '400' }}>{g.required ? '(required)' : g.maxSelect > 1 ? `(up to ${g.maxSelect})` : ''}</Text></Text>
          {g.options.map((o) => <Pressable key={o.id} disabled={o.soldOut} onPress={() => toggle(g.id, g.maxSelect, o.id)} style={[s.row, { padding: 10, borderWidth: 1, borderColor: (sel[g.id] || []).includes(o.id) ? C.brand : C.ink1, borderRadius: 10, marginTop: 6, backgroundColor: C.white, opacity: o.soldOut ? 0.4 : 1 }]}><Text>{(sel[g.id] || []).includes(o.id) ? '● ' : '○ '}{o.name}</Text>{o.priceCents > 0 && <Text>+{money(o.priceCents)}</Text>}</Pressable>)}
        </View>
      ))}
      <Input label="Special instructions" value={note} onChangeText={setNote} />
      <View style={[s.row, { marginTop: 8 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Button title="−" variant="secondary" onPress={() => setQty(Math.max(1, qty - 1))} /><Text style={{ fontSize: 18 }}>{qty}</Text><Button title="+" variant="secondary" onPress={() => setQty(qty + 1)} /></View>
        <Button title={`Add ${money((item.priceCents + modCents) * qty)}`} disabled={!!invalid} onPress={() => onAdd({ menuItemId: item.id, name: item.name, quantity: qty, unitPriceCents: item.priceCents, modifierOptionIds: chosen.map((o) => o.id), modifierNames: chosen.map((o) => o.name), modifiersCents: modCents, specialInstructions: note || undefined })} />
      </View>
      {invalid && <ErrorText msg={`Choose ${invalid.name} to continue`} />}
    </ScrollView>
  );
}

function Experiences({ locId }: { locId: string }) {
  const { user } = useSession();
  const { data } = useApi<{ id: string; name: string; description: string | null; pricingMode: string; priceCents: number; sessions: { id: string; startAt: string; remaining: number }[] }[]>(`/public/locations/${locId}/experiences`);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading />;
  return (
    <View style={{ marginTop: 12 }}>
      {data.map((e) => (
        <Card key={e.id} title={e.name}>
          {e.description && <Muted>{e.description}</Muted>}
          <Text style={{ fontWeight: '700', marginTop: 4 }}>{e.pricingMode === 'FREE' ? 'Free' : e.pricingMode === 'PAY_AT_VENUE' ? 'Pay at venue' : `${money(e.priceCents)} ${e.pricingMode === 'PREPAID_PER_PERSON' ? '/ person' : '/ party'}`}</Text>
          {e.sessions.map((ss) => <Button key={ss.id} title={`${when(ss.startAt)} · ${ss.remaining} left · Book 2`} variant="secondary" disabled={ss.remaining < 2} onPress={async () => { try { const t = await api.post<{ confirmationCode: string }>('/tickets', { sessionId: ss.id, spots: 2, guestName: user?.name || 'Guest', guestEmail: user?.email, paymentMethodId: 'mock_pm_4242' }); setMsg(`Confirmed! Code ${t.confirmationCode}`); } catch (err) { setMsg((err as Error).message); } }} />)}
        </Card>
      ))}
      {msg && <Text style={{ color: C.good }}>{msg}</Text>}
    </View>
  );
}
