import { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { COURIER_DOC_KINDS, COURIER_DOC_LABELS, type CourierDocKind } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';
import { mimeFor, pickFileOnWeb, uploadMultipart, type PickedFile } from '@/upload';
import { ResponsibilityDisputes } from '@/responsibility';

interface Addr { line1: string; city: string; lat?: number; lng?: number; instructions?: string }
interface Job { id: string; status: string; pickupAddress: Addr; dropoffAddress: Addr; tipCents: number; providerCostCents: number; batchId: string | null; arrivedPickupAt: string | null; arrivedDropoffAt: string | null; requirements: string[]; exception: { kind: string; attempts: unknown[]; waitUntil: string; resolution?: string } | null }
interface Standing { status: string; suspendedReason: string | null; appealStatus: string; appealDecisionNote: string | null; missingDocs: string[]; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }

/** Courier mode: onboarding documents, shifts, availability, offers (incl. batches), arrival, handoff with proof, problem deliveries, standing & appeal, earnings. */
export default function Driver() {
  const { user } = useSession();
  const [tab, setTab] = useState<'work' | 'docs' | 'shifts'>('work');
  const { data: me, error: meErr, reload } = useApi<{ id: string; status: string; isAvailable: boolean }>(user ? '/driver/me' : null, { deps: [user?.id] });
  const { data: standing, reload: reloadStanding } = useApi<Standing>(me ? '/driver/standing' : null, { deps: [me?.id, me?.status] });
  const { data: offers, reload: reloadOffers } = useApi<{ id: string; payCents: number; pickupAddress: { line1: string }; dropoffAddress: { line1: string }; expiresAt: string; batchWith: string | null; requirements: string[] }[]>(me?.status === 'APPROVED' ? '/driver/offers' : null, { poll: 5000, deps: [me?.id] });
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>(me?.status === 'APPROVED' ? '/driver/jobs' : null, { poll: 5000, deps: [me?.id] });
  const { data: earnings } = useApi<{ payableCents: number }>(me ? '/driver/earnings' : null, { deps: [me?.id, jobs?.length] });
  const { run, error } = useAction();
  const [vehicle, setVehicle] = useState('Bike');
  const [appeal, setAppeal] = useState('');
  const pos = async () => { const { status } = await Location.requestForegroundPermissionsAsync(); if (status !== 'granted') return { lat: 0, lng: 0 }; const p = await Location.getCurrentPositionAsync({}); return { lat: p.coords.latitude, lng: p.coords.longitude }; };
  useEffect(() => {
    if (!me?.isAvailable) return;
    const t = setInterval(async () => { const l = await pos(); if (l.lat) await api.post('/driver/location', l).catch(() => undefined); }, 20_000);
    return () => clearInterval(t);
  }, [me?.isAvailable]);
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to drive with Gutad.</Muted></View>;
  if (meErr && !me) return <ScrollView style={s.screen} contentContainerStyle={s.pad}><Card title="Apply to drive"><Input label="Vehicle" value={vehicle} onChangeText={setVehicle} /><Button title="Apply" onPress={() => run(async () => { await api.post('/driver/apply', { vehicle }); reload(); })} /><Muted>Upload your licence, insurance and background check next; staff review them before you can go online.</Muted></Card></ScrollView>;
  if (!me) return <Loading />;
  const nav = (a: Addr) => Linking.openURL(a.lat ? `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.line1}, ${a.city}`)}`);
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); await reloadJobs(); await reloadOffers(); await reload(); });
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Status">
        <View style={s.row}><Badge text={me.status} tone={tone(me.status)} /><Text>Payable {money(earnings?.payableCents || 0)}</Text></View>
        {standing?.metrics && <Muted>30 days: accept {standing.metrics.acceptanceRate ?? '—'}% · complete {standing.metrics.completionRate ?? '—'}% · on time {standing.metrics.onTimeRate ?? '—'}% · {standing.metrics.delivered} delivered</Muted>}
        <Button title={me.isAvailable ? 'Go offline' : 'Go online'} variant={me.isAvailable ? 'secondary' : 'primary'} disabled={me.status !== 'APPROVED'} onPress={() => act(async () => { const l = await pos(); await api.post('/driver/availability', { isAvailable: !me.isAvailable, ...(l.lat ? l : {}) }); })} />
        <ErrorText msg={error} />
      </Card>
      {standing?.status === 'SUSPENDED' && <Card title="Account suspended"><Muted>{standing.suspendedReason}</Muted>{standing.appealStatus === 'PENDING' ? <Muted>Your appeal is being reviewed by someone who wasn’t involved in the suspension.</Muted> : <>{standing.appealDecisionNote && <Muted>Decision: {standing.appealDecisionNote}</Muted>}<Input label="Appeal" multiline value={appeal} onChangeText={setAppeal} /><Button title="Send appeal" disabled={appeal.length < 10} onPress={() => run(async () => { await api.post('/driver/appeal', { note: appeal }); setAppeal(''); await reloadStanding(); })} /></>}</Card>}
      {!!standing?.missingDocs.length && <Card><Text style={{ color: C.warn }}>Needed: {standing.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind]).join(', ')}</Text></Card>}
      <Pills value={tab} onChange={setTab} options={[{ id: 'work', label: 'Deliveries' }, { id: 'docs', label: 'Documents' }, { id: 'shifts', label: 'Shifts' }]} />
      {tab === 'work' && (
        <>
          <Card title="Offers">{offers?.length ? offers.map((o) => <View key={o.id} style={{ marginBottom: 8 }}><Text style={{ fontWeight: '700' }}>{money(o.payCents)} · {o.pickupAddress.line1} → {o.dropoffAddress.line1}</Text>{o.batchWith && <Text style={{ color: C.info }}>Adds to your current trip (same pickup)</Text>}{o.requirements.includes('ALCOHOL') && <Text style={{ color: C.warn }}>Contains alcohol: check ID at handoff</Text>}<Muted>Expires {when(o.expiresAt)}</Muted><View style={{ flexDirection: 'row', gap: 6 }}><Button title="Accept" onPress={() => act(() => api.post(`/driver/offers/${o.id}`, { accept: true }))} /><Button title="Decline" variant="ghost" onPress={() => act(() => api.post(`/driver/offers/${o.id}`, { accept: false }))} /></View></View>) : <Muted>No offers right now{me.isAvailable ? '' : ' — go online to receive offers'}.</Muted>}</Card>
          <Card title="Active deliveries">{jobs?.length ? jobs.map((j) => <JobCard key={j.id} j={j} nav={nav} pos={pos} act={act} />) : <Muted>No active deliveries.</Muted>}</Card>
          <ResponsibilityDisputes role="DRIVER" />
        </>
      )}
      {tab === 'docs' && <Docs />}
      {tab === 'shifts' && <Shifts />}
    </ScrollView>
  );
}

function JobCard({ j, nav, pos, act }: { j: Job; nav: (a: Addr) => void; pos: () => Promise<{ lat: number; lng: number }>; act: (fn: () => Promise<unknown>) => void }) {
  const ex = j.exception && !j.exception.resolution ? j.exception : null;
  const waiting = ex ? new Date(ex.waitUntil) > new Date() : false;
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={s.row}><Text style={{ fontWeight: '700', flex: 1 }}>{j.status === 'ASSIGNED' ? 'Pick up at' : 'Deliver to'}: {j.status === 'ASSIGNED' ? j.pickupAddress.line1 : j.dropoffAddress.line1}</Text><Badge text={j.batchId ? `${j.status} · batch` : j.status} tone={tone(j.status)} /></View>
      <Muted>Pay {money(j.providerCostCents)} + tip {money(j.tipCents)}{j.dropoffAddress.instructions ? ` · ${j.dropoffAddress.instructions}` : ''}</Muted>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Button title="Navigate" variant="secondary" onPress={() => nav(j.status === 'ASSIGNED' ? j.pickupAddress : j.dropoffAddress)} />
        {j.status === 'ASSIGNED' && !j.arrivedPickupAt && <Button title="Arrived" variant="secondary" onPress={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'PICKUP', ...(await pos()) }))} />}
        {j.status === 'ASSIGNED' && <Button title="Picked up" onPress={() => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', ...(await pos()) }))} />}
        {j.status === 'PICKED_UP' && !j.arrivedDropoffAt && <Button title="Arrived" variant="secondary" onPress={() => act(async () => api.post(`/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF', ...(await pos()) }))} />}
        {j.status === 'PICKED_UP' && !ex && <Button title="Delivered (photo)" onPress={() => act(async () => api.post(`/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: 'https://placehold.co/600x400?text=Handoff', ...(await pos()) }))} />}
      </View>
      {j.status === 'PICKED_UP' && !ex && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{[['CUSTOMER_UNREACHABLE', 'Can’t reach customer'], ['WRONG_ADDRESS', 'Wrong address'], ['ACCESS_PROBLEM', 'Can’t get in']].map(([k, l]) => <Button key={k} title={l} variant="ghost" onPress={() => act(() => api.post(`/driver/jobs/${j.id}/exception`, { kind: k, method: 'CALL' }))} />)}</View>}
      {ex && (
        <View style={{ backgroundColor: '#fffbeb', padding: 8, borderRadius: 10, marginTop: 6 }}>
          <Text style={{ fontWeight: '600' }}>{ex.kind.toLowerCase().replace(/_/g, ' ')} · {ex.attempts.length} attempt(s)</Text>
          <Muted>{waiting ? `Keep trying until ${new Date(ex.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Wait time is over'}</Muted>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['CALL', 'SMS', 'DOOR'].map((m) => <Button key={m} title={`Log ${m.toLowerCase()}`} variant="secondary" onPress={() => act(() => api.post(`/driver/jobs/${j.id}/exception`, { kind: ex.kind, method: m }))} />)}</View>
          {!waiting && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}><Button title="Leave safely (photo)" onPress={() => act(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'SAFE_PLACE', proofPhotoUrl: 'https://placehold.co/600x400?text=Left+safely' }))} /><Button title="Return" variant="secondary" onPress={() => act(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'RETURN' }))} /><Button title="Dispose" variant="ghost" onPress={() => act(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'DISPOSE' }))} /></View>}
        </View>
      )}
    </View>
  );
}

function Docs() {
  const { data, reload } = useApi<{ id: string; kind: string; status: string; expiresAt: string | null; reviewNote: string | null; fileId: string | null }[]>('/driver/documents');
  const { run, error } = useAction();
  const [kind, setKind] = useState<string>('LICENSE');
  const [url, setUrl] = useState('');
  const [exp, setExp] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileUri, setFileUri] = useState('');
  const expiresAt = exp ? new Date(`${exp}T23:59:00Z`).toISOString() : undefined;
  // 16.2-U a scan or photo goes straight to storage; a link still works
  const picked: PickedFile | null = file || (fileUri.length > 7 ? { uri: fileUri, name: fileUri.split('/').pop() || 'document.jpg', type: mimeFor(fileUri) } : null);
  return (
    <Card title="Documents">
      {data?.map((d) => <View key={d.id} style={s.row}><Text>{COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind}{d.fileId ? ' · file' : ''}</Text><Text style={{ color: d.status === 'APPROVED' ? C.good : d.status === 'PENDING' ? C.warn : C.bad }}>{d.status.toLowerCase()}{d.expiresAt ? ` · ${new Date(d.expiresAt).toLocaleDateString()}` : ''}</Text></View>)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6 }}>{COURIER_DOC_KINDS.map((k) => <Button key={k} title={COURIER_DOC_LABELS[k]} variant={kind === k ? 'primary' : 'secondary'} onPress={() => setKind(k)} />)}</View>
      {Platform.OS === 'web' ? <Button title={file ? `File: ${file.name}` : 'Choose a file (PDF or photo)'} variant="secondary" onPress={() => run(async () => setFile(await pickFileOnWeb()))} /> : <Input label="File on this phone (file:// or content:// from Files / Share)" autoCapitalize="none" value={fileUri} onChangeText={setFileUri} />}
      {!picked && <Input label="…or a link to the scanned file" autoCapitalize="none" value={url} onChangeText={setUrl} />}
      <Input label="Expiry (YYYY-MM-DD)" value={exp} onChangeText={setExp} />
      <ErrorText msg={error} />
      <Button title="Upload" disabled={!picked && url.length < 4} onPress={() => run(async () => { if (picked) await uploadMultipart('/driver/documents/upload', picked, { kind, expiresAt }); else await api.post('/driver/documents', { kind, fileUrl: url, expiresAt }); setUrl(''); setExp(''); setFile(null); setFileUri(''); await reload(); })} />
      <Muted>Files are stored privately; only you and Gutad’s courier team can open them.</Muted>
    </Card>
  );
}

function Shifts() {
  const { data, reload } = useApi<{ id: string; startsAt: string; endsAt: string }[]>('/driver/shifts');
  const { run, error } = useAction();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState('17:00');
  const [to, setTo] = useState('21:00');
  return (
    <Card title="Shifts">
      {data?.map((x) => <View key={x.id} style={s.row}><Text>{when(x.startsAt)} – {new Date(x.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text><Button title="Cancel" variant="ghost" onPress={() => run(async () => { await api.delete(`/driver/shifts/${x.id}`); await reload(); })} /></View>)}
      {!data?.length && <Muted>No shifts booked.</Muted>}
      <Input label="Day (YYYY-MM-DD)" value={day} onChangeText={setDay} />
      <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="From" value={from} onChangeText={setFrom} /></View><View style={{ flex: 1 }}><Input label="To" value={to} onChangeText={setTo} /></View></View>
      <ErrorText msg={error} />
      <Button title="Add shift" onPress={() => run(async () => { await api.post('/driver/shifts', { startsAt: new Date(`${day}T${from}`).toISOString(), endsAt: new Date(`${day}T${to}`).toISOString() }); await reload(); })} />
    </Card>
  );
}
