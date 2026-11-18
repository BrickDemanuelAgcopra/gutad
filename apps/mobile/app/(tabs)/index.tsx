import { useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import type { LocationSummary, Paginated } from '@gutad/shared';
import { api } from '@/api';
import { Badge, Button, C, Input, Loading, Muted, s } from '@/ui';
import { GBadge } from '@/made-at-gutad';

export default function Discover() {
  const [q, setQ] = useState('');
  const [city, setCity] = useState('New York');
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [service, setService] = useState<string>('');
  const [data, setData] = useState<Paginated<LocationSummary> | null>(null);
  useEffect(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (city && !near) p.set('city', city);
    if (service) p.set('service', service);
    if (near) { p.set('lat', String(near.lat)); p.set('lng', String(near.lng)); p.set('radiusKm', '15'); }
    const t = setTimeout(() => api.get<Paginated<LocationSummary>>(`/public/search?${p}`).then(setData).catch(() => setData({ items: [], total: 0, page: 1, pageSize: 20 })), 300);
    return () => clearTimeout(t);
  }, [q, city, near, service]);
  const locate = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const pos = await Location.getCurrentPositionAsync({});
    setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude });
  };
  return (
    <View style={s.screen}>
      <View style={[s.pad, { paddingBottom: 0 }]}>
        <Link href="/chefs" asChild><Pressable accessibilityRole="link" style={{ backgroundColor: '#fff4ec', borderRadius: 14, padding: 12, marginBottom: 10 }}><Text style={{ fontWeight: '700', color: C.ink }}>👩‍🍳 Gutad Bestie Network</Text><Text style={{ color: C.ink5, fontSize: 12 }}>Dishes by independent chefs · order ahead for holidays</Text></Pressable></Link>
        <Input placeholder="Search cuisine, dish or restaurant" value={q} onChangeText={setQ} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Input placeholder="City" value={city} onChangeText={(v) => { setCity(v); setNear(null); }} /></View>
          <Button title={near ? 'Near me ✓' : 'Near me'} variant="secondary" onPress={locate} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {[['', 'All'], ['pickup', 'Pickup'], ['delivery', 'Delivery'], ['reservations', 'Tables'], ['events', 'Experiences']].map(([v, l]) => <Pressable key={v} onPress={() => setService(v)} style={{ backgroundColor: service === v ? C.brand : C.white, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: C.ink1 }}><Text style={{ color: service === v ? C.white : C.ink7, fontSize: 12, fontWeight: '600' }}>{l}</Text></Pressable>)}
        </View>
      </View>
      {!data ? <Loading /> : (
        <FlatList data={data.items} keyExtractor={(i) => `${i.id}:${i.brand?.id ?? ''}`} contentContainerStyle={s.pad} ListEmptyComponent={<Muted>No restaurants match. Try another city.</Muted>} renderItem={({ item: l }) => (
          <Link href={{ pathname: '/r/[slug]', params: l.brand ? { slug: l.slug, brand: l.brand.slug } : { slug: l.slug } }} asChild>
            <Pressable style={[s.card, { padding: 0, overflow: 'hidden' }]}>
              {l.heroImageUrl ? <Image source={{ uri: l.heroImageUrl }} style={{ height: 140, width: '100%' }} /> : <View style={{ height: 80, backgroundColor: C.ink1 }} />}
              <View style={{ padding: 12 }}>
                <View style={s.row}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>{l.platformOperated && <GBadge />}<Text style={{ fontWeight: '700', fontSize: 16 }}>{l.name}</Text></View><Badge text={l.isOpenNow ? 'OPEN' : 'CLOSED'} tone={l.isOpenNow ? 'good' : 'bad'} /></View>
                <Muted>{l.brand ? `Made at Gutad · ${l.foodHallName}` : `${l.platformOperated ? 'Made at Gutad · ' : ''}${l.cuisine.join(' · ')}`} · {l.city}{typeof l.distanceKm === 'number' ? ` · ${l.distanceKm.toFixed(1)} km` : ''}{l.rating ? ` · ★ ${l.rating.toFixed(1)}` : ''}</Muted>
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>{l.acceptsPickup && <Badge text="Pickup" />}{l.acceptsDelivery && <Badge text="Delivery" />}{l.acceptsReservations && <Badge text="Tables" />}{l.acceptsEvents && <Badge text="Events" />}{l.sponsored && <Badge text="Sponsored" tone="info" />}</View>
              </View>
            </Pressable>
          </Link>
        )} />
      )}
    </View>
  );
}
