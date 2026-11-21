import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { COURIER_DOC_KINDS, COURIER_DOC_LABELS, DEFAULT_AVAILABILITY, type CourierDocKind } from '@gutad/shared';
import { api, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Pills } from '@/ops';
import { mimeFor, pickFileOnWeb, uploadMultipart, type PickedFile } from '@/upload';
import { ResponsibilityDisputes } from '@/responsibility';
import { currentPos, type DriverStatus, type Job, type Offer, type Onboarding } from '@/courier/common';
import { CourierOnboarding } from '@/courier/onboarding';
import { FirstDeliveryGuide, JobCard, LifecycleNotice, OfferCard, StatusPanel } from '@/courier/work';
import { CourierEarnings, CourierFeedback } from '@/courier/earnings';
import { BusyTimes, Incentives, ReviewNotices } from '@/courier/incentives';
import { useQueue } from '@/courier/queue';

interface Standing { status: string; suspendedReason: string | null; appealStatus: string; appealDecisionNote: string | null; missingDocs: string[]; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }

/** Courier mode: the application wizard until approved; then status, offers, active deliveries, earnings, feedback, documents and shifts. */
export default function Driver() {
  const { user } = useSession();
  const { data: ob, error: obErr, reload: reloadOb, setData: setOb } = useApi<Onboarding>(user ? '/driver/onboarding' : null, { deps: [user?.id] });
  if (!user) return <View style={[s.screen, s.pad]}><Muted>Sign in to deliver with Gutad.</Muted></View>;
  if (!ob) return obErr ? <View style={[s.screen, s.pad]}><ErrorText msg={obErr} /><Button title="Try again" variant="secondary" onPress={() => void reloadOb()} /></View> : <Loading />;
  if (!ob.driver || ob.driver.applicationStatus !== 'APPROVED') {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.pad}>
        <CourierOnboarding ob={ob} onChange={(o) => (o ? setOb(o) : void reloadOb())} />
      </ScrollView>
    );
  }
  return <Work onboarding={ob} />;
}

function Work({ onboarding }: { onboarding: Onboarding }) {
  const [tab, setTab] = useState<'work' | 'incentives' | 'earnings' | 'feedback' | 'docs' | 'shifts'>('work');
  const { data: st, reload: reloadSt } = useApi<DriverStatus>('/driver/status', { poll: 15000 });
  const { data: standing, reload: reloadStanding } = useApi<Standing>('/driver/standing', { deps: [st?.lifecycleStatus] });
  const { data: offers, reload: reloadOffers } = useApi<Offer[]>('/driver/offers', { poll: 5000 });
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>('/driver/jobs', { poll: 5000 });
  const { run, error } = useAction();
  const [appeal, setAppeal] = useState('');
  const refresh = () => { void reloadJobs(); void reloadOffers(); void reloadSt(); };
  const queue = useQueue(refresh);
  // retry queued trip actions alongside the job poll
  useEffect(() => { if (queue.count) void queue.flush(); }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!st?.isAvailable) return;
    const t = setInterval(async () => { const l = await currentPos(); if (l) await api.post('/driver/location', l).catch(() => undefined); }, 20_000);
    return () => clearInterval(t);
  }, [st?.isAvailable]);
  const firstDeliveryAt = st ? st.firstDeliveryAt : onboarding.driver?.firstDeliveryAt;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {queue.count > 0 && <Card style={{ backgroundColor: '#fffbeb' }}><Text style={{ color: C.warn, fontWeight: '600' }}>{queue.count} action{queue.count === 1 ? '' : 's'} waiting to send</Text><Muted>We’ll send {queue.count === 1 ? 'it' : 'them'} as soon as you’re back online.</Muted><Button title="Try now" variant="secondary" onPress={() => void queue.flush()} /></Card>}
      {queue.refused.length > 0 && <Card><Text style={{ color: C.bad, fontWeight: '600' }}>Some offline actions weren’t accepted</Text>{queue.refused.map((r, i) => <Muted key={i}>{r}</Muted>)}<Button title="OK" variant="ghost" onPress={queue.clearRefused} /></Card>}
      {st ? <StatusPanel st={st} onChange={refresh} /> : <Loading />}
      {st && <LifecycleNotice st={st} onChange={() => void reloadSt()} />}
      <ReviewNotices />
      {standing?.status === 'SUSPENDED' && <Card title="Appeal">{standing.suspendedReason && <Muted>{standing.suspendedReason}</Muted>}{standing.appealStatus === 'PENDING' ? <Muted>Your appeal is being reviewed by someone who wasn’t involved in the suspension.</Muted> : <>{standing.appealDecisionNote && <Muted>Decision: {standing.appealDecisionNote}</Muted>}<Input label="Appeal" multiline value={appeal} onChangeText={setAppeal} /><ErrorText msg={error} /><Button title="Send appeal" disabled={appeal.length < 10} onPress={() => run(async () => { await api.post('/driver/appeal', { note: appeal }); setAppeal(''); await reloadStanding(); })} /></>}</Card>}
      {!!standing?.missingDocs.length && <Card><Text style={{ color: C.warn }}>Needed: {standing.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind] || d).join(', ')}</Text></Card>}
      {standing?.metrics && <Muted>30 days: accept {standing.metrics.acceptanceRate ?? '—'}% · complete {standing.metrics.completionRate ?? '—'}% · on time {standing.metrics.onTimeRate ?? '—'}% · {standing.metrics.delivered} delivered</Muted>}
      <Pills value={tab} onChange={setTab} options={[{ id: 'work', label: 'Deliveries' }, { id: 'incentives', label: 'Incentives' }, { id: 'earnings', label: 'Earnings' }, { id: 'feedback', label: 'Feedback' }, { id: 'docs', label: 'Documents' }, { id: 'shifts', label: 'Shifts' }]} />
      {tab === 'work' && (
        <>
          {!firstDeliveryAt && <FirstDeliveryGuide />}
          <Card title="Offers">{offers?.length ? offers.map((o) => <OfferCard key={o.id} o={o} onDone={refresh} />) : <Muted>No offers right now{st?.isAvailable ? '' : '. Go online to receive offers'}.</Muted>}</Card>
          <Card title="Active deliveries">{jobs?.length ? jobs.map((j) => <JobCard key={j.id} j={j} onChange={refresh} />) : <Muted>No active deliveries.</Muted>}</Card>
          <ResponsibilityDisputes role="DRIVER" />
        </>
      )}
      {tab === 'incentives' && <><Incentives /><BusyTimes /></>}
      {tab === 'earnings' && <CourierEarnings refreshKey={jobs?.length} />}
      {tab === 'feedback' && <CourierFeedback />}
      {tab === 'docs' && <Docs />}
      {tab === 'shifts' && <><BusyTimes /><Shifts onChange={() => void reloadSt()} /></>}
    </ScrollView>
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

function Shifts({ onChange }: { onChange: () => void }) {
  const { data, reload } = useApi<{ id: string; startsAt: string; endsAt: string; status?: string; checkedInAt?: string | null }[]>('/driver/shifts');
  const { run, error } = useAction();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState('17:00');
  const [to, setTo] = useState('21:00');
  return (
    <Card title="Shifts">
      {data?.map((x) => {
        const now = Date.now();
        const checkedIn = x.status === 'CHECKED_IN' || !!x.checkedInAt;
        const canCheckIn = !checkedIn && now >= new Date(x.startsAt).getTime() - DEFAULT_AVAILABILITY.checkInEarlyMinutes * 60_000 && now < new Date(x.endsAt).getTime();
        return (
          <View key={x.id} style={s.row}>
            <Text style={{ flex: 1 }}>{when(x.startsAt)} – {new Date(x.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
            {checkedIn ? <Badge text="Checked in" tone="good" /> : canCheckIn ? <Button title="Check in" onPress={() => run(async () => { const p = await currentPos(); if (!p) throw new Error('Allow location access to check in'); await api.post(`/driver/shifts/${x.id}/check-in`, p); await reload(); onChange(); })} /> : <Button title="Cancel" variant="ghost" onPress={() => run(async () => { await api.delete(`/driver/shifts/${x.id}`); await reload(); })} />}
          </View>
        );
      })}
      {!data?.length && <Muted>No shifts booked.</Muted>}
      <Input label="Day (YYYY-MM-DD)" value={day} onChangeText={setDay} />
      <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="From" value={from} onChangeText={setFrom} /></View><View style={{ flex: 1 }}><Input label="To" value={to} onChangeText={setTo} /></View></View>
      <ErrorText msg={error} />
      <Button title="Add shift" onPress={() => run(async () => { await api.post('/driver/shifts', { startsAt: new Date(`${day}T${from}`).toISOString(), endsAt: new Date(`${day}T${to}`).toISOString() }); await reload(); })} />
    </Card>
  );
}
