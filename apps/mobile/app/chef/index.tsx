import { Image, Linking, ScrollView, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { chefDishTitle, chefNoticeText, WEEKDAYS } from '@gutad/shared';
import { api } from '@/api';
import { useAction, useApi } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Loading, Muted, s } from '@/ui';

interface ChefMe {
  profile: { displayName: string; portraitUrl: string | null; acceptingOrders: boolean; status: string; statusReason: string | null; operating: { cookingDays?: number[]; cutoffHour?: number; minLeadDays?: number; dailyCapacity?: number } };
  location: { name: string; addressLine1: string; city: string; isPaused: boolean } | null;
  payouts: { state: string; bankLast4: string | null } | null;
  checklist: { key: string; label: string; done: boolean }[];
}

/** Chef dashboard: checklist, payouts, availability switch. Orders and tickets use the merchant tablet screens. */
export default function ChefHome() {
  const { data, setData, loading, error } = useApi<ChefMe>('/chef/me');
  const { data: inbox } = useApi<{ counts: { needsReply: number; waiting: number } }>(data ? '/chef/requests?status=needsReply' : null, { deps: [!!data], poll: 60000 });
  const { data: comp } = useApi<{ documents: { state: string }[] }>(data ? '/chef/compliance' : null, { deps: [!!data] });
  const { run, busy, error: actErr } = useAction();
  if (loading) return <Loading />;
  if (error || !data) return <View style={[s.screen, s.pad]}><Card title="Not a Gutad Bestie yet"><Muted>Finish your application to unlock the chef dashboard.</Muted><Link href="/chefs/apply" asChild><Button title="Open application" onPress={() => undefined} /></Link></Card></View>;
  const p = data.profile;
  const docIssues = comp ? comp.documents.filter((d) => d.state !== 'VALID' && d.state !== 'IN_REVIEW').length : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {p.portraitUrl ? <Image source={{ uri: p.portraitUrl }} style={{ width: 56, height: 56, borderRadius: 28 }} /> : <Text style={{ fontSize: 36 }}>👩‍🍳</Text>}
          <View style={{ flex: 1 }}><Text style={{ fontSize: 20, fontWeight: '700' }}>{p.displayName}</Text><Muted>{chefDishTitle('Spaghetti', p.displayName)}</Muted></View>
        </View>
        <View style={{ marginTop: 8 }}><Badge text={p.status !== 'ACTIVE' ? p.status : p.acceptingOrders ? 'Accepting orders' : 'Not accepting orders'} tone={p.status !== 'ACTIVE' ? 'bad' : p.acceptingOrders ? 'good' : 'warn'} /></View>
        {p.statusReason && p.status !== 'ACTIVE' && <Text style={{ color: C.bad, marginTop: 6 }}>{p.statusReason}</Text>}
      </Card>
      {p.status === 'PAUSED' && (
        <View style={{ backgroundColor: '#fee2e2', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <Text style={{ color: '#991b1b', fontWeight: '700' }}>Your listings are paused</Text>
          <Text style={{ color: '#991b1b', marginTop: 4 }}>{p.statusReason || 'Customers can’t order from you right now.'}</Text>
          <Link href="/chef/compliance" asChild><Button variant="danger" title="See what to fix" onPress={() => undefined} /></Link>
        </View>
      )}
      <ErrorText msg={actErr} />
      <Card title="Getting started">{data.checklist.map((c) => <Text key={c.key} style={{ marginBottom: 4, color: c.done ? C.good : C.ink7 }}>{c.done ? '✓' : '○'} {c.label}</Text>)}</Card>
      <Card title="Availability">
        <Muted>Cooks {(p.operating.cookingDays || []).map((d) => WEEKDAYS[d]).join(', ') || '—'} · {chefNoticeText(p.operating.minLeadDays ?? 1, p.operating.cutoffHour ?? 12)} · {p.operating.dailyCapacity ?? '—'} portions/day</Muted>
        <Link href="/chef/calendar" asChild><Button title="Cooking calendar" onPress={() => undefined} /></Link>
        {p.acceptingOrders ? <Button variant="secondary" disabled={busy} title="Pause availability" onPress={() => run(async () => setData(await api.post<ChefMe>('/chef/me/availability', { accepting: false })))} /> : <Button disabled={busy || p.status !== 'ACTIVE'} title="Open availability" onPress={() => run(async () => setData(await api.post<ChefMe>('/chef/me/availability', { accepting: true })))} />}
      </Card>
      <Card title="Payouts">
        {data.payouts?.state === 'COMPLETE' ? <Text style={{ color: C.good }}>✓ Payouts connected{data.payouts.bankLast4 ? ` · ••${data.payouts.bankLast4}` : ''}</Text> : <><Muted>Connect payouts through our payment provider’s secure onboarding.</Muted><Button disabled={busy} title="Connect payouts" onPress={() => run(async () => { const r = await api.post<{ onboardingUrl?: string | null }>('/chef/me/payouts', {}); if (r.onboardingUrl) await Linking.openURL(r.onboardingUrl); else setData(await api.get<ChefMe>('/chef/me')); })} /></>}
      </Card>
      <Card title="Special requests">
        <Muted>{inbox ? (inbox.counts.needsReply ? `${inbox.counts.needsReply} waiting for your reply` : 'Nothing waiting for your reply') : 'Customers asking for changes your options don’t cover'}{inbox?.counts.waiting ? ` · ${inbox.counts.waiting} waiting on customers` : ''}</Muted>
        <Link href="/chef/requests" asChild><Button title={inbox?.counts.needsReply ? `Reply to requests (${inbox.counts.needsReply})` : 'Open requests'} variant={inbox?.counts.needsReply ? 'primary' : 'secondary'} onPress={() => undefined} /></Link>
      </Card>
      <Card title="Documents & quality">
        <Muted>{comp ? (docIssues ? `${docIssues} ${docIssues === 1 ? 'document needs' : 'documents need'} attention` : 'Documents up to date') : 'Permits, certificates and your quality record'}</Muted>
        <Link href="/chef/compliance" asChild><Button title="Documents & quality" variant={docIssues ? 'primary' : 'secondary'} onPress={() => undefined} /></Link>
      </Card>
      <Card title="Earnings">
        <Muted>Payable balance, money held until orders complete, and adjustments.</Muted>
        <Link href="/chef/earnings" asChild><Button variant="secondary" title="Open earnings" onPress={() => undefined} /></Link>
      </Card>
      <Card title="Dishes">
        <Muted>Build dishes, set fixed or customizable, reorder your menu.</Muted>
        <Link href="/chef/dishes" asChild><Button title="Manage dishes" onPress={() => undefined} /></Link>
      </Card>
      <Card title="Orders & tickets">
        <Muted>{data.location ? `${data.location.name} · ${data.location.addressLine1}, ${data.location.city}` : 'No kitchen on file'}</Muted>
        <Link href="/merchant" asChild><Button title="Open order tablet" onPress={() => undefined} /></Link>
        <Link href="/merchant/kitchen" asChild><Button variant="secondary" title="Kitchen tickets" onPress={() => undefined} /></Link>
      </Card>
    </ScrollView>
  );
}
