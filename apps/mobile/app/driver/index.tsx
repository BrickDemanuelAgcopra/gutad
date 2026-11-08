import { useEffect, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';

interface Job { id: string; status: string; pickupAddress: { line1: string; city: string; lat?: number; lng?: number }; dropoffAddress: { line1: string; city: string; lat?: number; lng?: number; instructions?: string }; tipCents: number; providerCostCents: number }

/** Driver mode: onboarding, availability, offers, navigation, pickup, handoff with proof, earnings. */
export default function Driver() {
  const { user } = useSession();
  const { data: me, error: meErr, reload } = useApi<{ id: string; status: string; isAvailable: boolean }>(user ? '/driver/me' : null, { deps: [user?.id] });
  const { data: offers, reload: reloadOffers } = useApi<{ id: string; payCents: number; pickupAddress: { line1: string }; dropoffAddress: { line1: string }; expiresAt: string }[]>(me?.status === 'APPROVED' ? '/driver/offers' : null, { poll: 5000, deps: [me?.id] });
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>(me?.status === 'APPROVED' ? '/driver/jobs' : null, { poll: 5000, deps: [me?.id] });
  const { data: earnings } = useApi<{ payableCents: number }>(me ? '/driver/earnings' : null, { deps: [me?.id, jobs?.length] });
  const { run, error } = useAction();
  const [vehicle, setVehicle] = useState('Bike');
  const pos = async () => { const { status } = await Location.requestForegroundPermissionsAsync(); if (status !== 'granted') return { lat: 0, lng: 0 }; const p = await Location.getCurrentPositionAsync({}); return { lat: p.coords.latitude, lng: p.coords.longitude }; };
  useEffect(() => {
    if (!me?.isAvailable) return;
    const t = setInterval(async () => { const l = await pos(); if (l.lat) await api.post('/driver/location', l).catch(() => undefined); }, 20_000);
    return () => clearInterval(t);
  }, [me?.isAvailable]);
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to drive with Gutad.</Muted></View>;
  if (meErr && !me) return <ScrollView style={s.screen} contentContainerStyle={s.pad}><Card title="Apply to drive"><Input label="Vehicle" value={vehicle} onChangeText={setVehicle} /><Button title="Apply" onPress={() => run(async () => { await api.post('/driver/apply', { vehicle }); reload(); })} /><Muted>Platform staff verify your license before you can go online.</Muted></Card></ScrollView>;
  if (!me) return <Loading />;
  const nav = (a: { lat?: number; lng?: number; line1: string; city: string }) => Linking.openURL(a.lat ? `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.line1}, ${a.city}`)}`);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Status"><View style={s.row}><Badge text={me.status} tone={tone(me.status)} /><Text>Payable {money(earnings?.payableCents || 0)}</Text></View><Button title={me.isAvailable ? 'Go offline' : 'Go online'} variant={me.isAvailable ? 'secondary' : 'primary'} disabled={me.status !== 'APPROVED'} onPress={() => run(async () => { const l = await pos(); await api.post('/driver/availability', { isAvailable: !me.isAvailable, ...(l.lat ? l : {}) }); reload(); })} /><ErrorText msg={error} /></Card>
      <Card title="Offers">{offers?.length ? offers.map((o) => <View key={o.id} style={{ marginBottom: 8 }}><Text style={{ fontWeight: '700' }}>{money(o.payCents)} · {o.pickupAddress.line1} → {o.dropoffAddress.line1}</Text><Muted>Expires {when(o.expiresAt)}</Muted><View style={{ flexDirection: 'row', gap: 6 }}><Button title="Accept" onPress={() => run(async () => { await api.post(`/driver/offers/${o.id}`, { accept: true }); reloadOffers(); reloadJobs(); })} /><Button title="Decline" variant="ghost" onPress={() => run(async () => { await api.post(`/driver/offers/${o.id}`, { accept: false }); reloadOffers(); })} /></View></View>) : <Muted>No offers right now{me.isAvailable ? '' : ' — go online to receive offers'}.</Muted>}</Card>
      <Card title="Active deliveries">{jobs?.length ? jobs.map((j) => <View key={j.id} style={{ marginBottom: 10 }}><View style={s.row}><Text style={{ fontWeight: '700' }}>{j.status === 'ASSIGNED' ? 'Pick up at' : 'Deliver to'}: {j.status === 'ASSIGNED' ? j.pickupAddress.line1 : j.dropoffAddress.line1}</Text><Badge text={j.status} tone={tone(j.status)} /></View><Muted>Pay {money(j.providerCostCents)} + tip {money(j.tipCents)}{j.dropoffAddress.instructions ? ` · ${j.dropoffAddress.instructions}` : ''}</Muted><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Button title="Navigate" variant="secondary" onPress={() => nav(j.status === 'ASSIGNED' ? j.pickupAddress : j.dropoffAddress)} />{j.status === 'ASSIGNED' && <Button title="Picked up" onPress={() => run(async () => { const l = await pos(); await api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', ...l }); reloadJobs(); })} />}{j.status === 'PICKED_UP' && <Button title="Delivered (photo proof)" onPress={() => run(async () => { const l = await pos(); await api.post(`/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: 'https://placehold.co/600x400?text=Handoff', ...l }); reloadJobs(); })} />}<Button title="Can’t deliver" variant="ghost" onPress={() => run(async () => { await api.post(`/driver/jobs/${j.id}/transition`, { status: 'FAILED', reason: 'Customer unreachable' }); reloadJobs(); })} /></View></View>) : <Muted>No active deliveries.</Muted>}</Card>
    </ScrollView>
  );
}
