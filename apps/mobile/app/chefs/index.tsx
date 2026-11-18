import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useApi } from '@/hooks';
import { Button, C, Card, Input, Loading, Muted, s } from '@/ui';

interface Chef { id: string; slug: string; displayName: string; bio: string | null; portraitUrl: string | null; cuisines: string[]; serviceCity: string | null }

/** Gutad Chef Network directory. */
export default function Chefs() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const { data } = useApi<Chef[]>(`/public/chefs${q.trim().length >= 2 ? `?q=${encodeURIComponent(q.trim())}` : ''}`, { deps: [q] });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={{ fontSize: 22, fontWeight: '700' }}>Dishes by independent chefs</Text>
      <Muted>Every chef is reviewed and cooks in an approved kitchen. Order ahead for holidays and celebrations.</Muted>
      <View style={{ marginTop: 10 }}><Input placeholder="Search chefs or dishes" value={q} onChangeText={setQ} /></View>
      {!data ? <Loading /> : data.map((c) => (
        <Pressable key={c.id} onPress={() => router.push({ pathname: '/chefs/[slug]', params: { slug: c.slug } })}>
          <Card>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              {c.portraitUrl ? <Image source={{ uri: c.portraitUrl }} style={{ width: 56, height: 56, borderRadius: 28 }} /> : <Text style={{ fontSize: 34 }}>👩‍🍳</Text>}
              <View style={{ flex: 1 }}><Text style={{ fontWeight: '700', fontSize: 16 }}>{c.displayName}</Text><Muted>{c.cuisines.join(' · ')} · {c.serviceCity}</Muted>{c.bio && <Text style={{ color: C.ink7, fontSize: 12 }} numberOfLines={2}>{c.bio}</Text>}</View>
            </View>
          </Card>
        </Pressable>
      ))}
      <Link href="/chefs/apply" asChild><Button title="Become a Gutad Bestie" variant="secondary" onPress={() => undefined} /></Link>
    </ScrollView>
  );
}
