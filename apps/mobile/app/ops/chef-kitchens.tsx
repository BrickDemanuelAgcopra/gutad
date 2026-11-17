import { useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { CHEF_DOC_STATE_LABELS, type ChefDocState } from '@gutad/shared';
import { api } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { StatTile } from '@/ops';
import { day, DocBadge, DocLine, type DocStatus } from '@/chef-ops';

interface Kitchen {
  chefId: string;
  displayName: string;
  status: string;
  statusCause: string | null;
  statusReason: string | null;
  acceptingOrders: boolean;
  kitchenType: string | null;
  region: string | null;
  kitchen: { id: string; name: string; addressLine1: string; city: string; region: string; postalCode: string; isPaused: boolean } | null;
  documents: DocStatus[];
  worst: ChefDocState;
  nextExpiry: string | null;
  pendingReviews: number;
}

/** Gutad staff: chef kitchens with required documents, worst first; approve or reject renewals inline. */
export default function OpsChefKitchens() {
  const { isStaff, ready, can } = useSession();
  const { data, error, reload } = useApi<{ kitchens: Kitchen[]; counts: { expired: number; expiring: number; inReview: number } }>(isStaff ? '/admin/chef-kitchens' : null, { deps: [isStaff], poll: 60000 });
  if (!ready) return null;
  if (!isStaff) return <View style={[s.screen, s.pad]}><Card title="Chef kitchens"><Muted>For Gutad staff only.</Muted></Card></View>;
  const manage = can('chefs.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {data && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <StatTile label="Expired" value={data.counts.expired} hint="kitchens" />
          <StatTile label="Expiring soon" value={data.counts.expiring} hint="within 30 days" />
          <StatTile label="Renewals in review" value={data.counts.inReview} />
        </View>
      )}
      <ErrorText msg={error} />
      {!data ? (error ? null : <Loading />) : !data.kitchens.length ? <Card><Muted>No chef kitchens yet.</Muted></Card> : data.kitchens.map((k) => <KitchenCard key={k.chefId} k={k} manage={manage} reload={reload} />)}
    </ScrollView>
  );
}

function KitchenCard({ k, manage, reload }: { k: Kitchen; manage: boolean; reload: () => Promise<void> }) {
  return (
    <Card>
      <View style={[s.row, { gap: 6 }]}>
        <Text style={{ fontWeight: '700', flex: 1, color: C.ink }}>{k.displayName}</Text>
        {k.status !== 'ACTIVE' && <Badge text={k.status} tone="bad" />}
        <Badge text={CHEF_DOC_STATE_LABELS[k.worst]} tone={k.worst === 'VALID' ? 'good' : k.worst === 'EXPIRING' || k.worst === 'IN_REVIEW' ? 'warn' : 'bad'} />
      </View>
      <Muted>{k.kitchen ? `${k.kitchen.addressLine1}, ${k.kitchen.city}, ${k.kitchen.region}` : 'No kitchen on file'}{k.nextExpiry ? ` · next expiry ${day(k.nextExpiry)}` : ''}</Muted>
      {k.statusReason && k.status !== 'ACTIVE' ? <Text style={{ color: C.bad, fontSize: 12, marginTop: 2 }}>{k.statusReason}</Text> : null}
      <View style={{ marginTop: 8 }}>
        {k.documents.map((d) => (d.pendingDocId ? <Renewal key={d.key} d={d} manage={manage} reload={reload} /> : <DocLine key={d.key} d={d} />))}
      </View>
    </Card>
  );
}

/** A renewal in review: open the file, approve, or reject with a note. */
function Renewal({ d, manage, reload }: { d: DocStatus; manage: boolean; reload: () => Promise<void> }) {
  const { run, busy, error } = useAction();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const review = (status: 'APPROVED' | 'REJECTED') => run(async () => { await api.post(`/admin/chef-documents/${d.pendingDocId}/review`, status === 'REJECTED' ? { status, note: note.trim() } : { status }); await reload(); });
  return (
    <View style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 12, padding: 8, marginBottom: 6 }}>
      <View style={[s.row, { gap: 6 }]}><Text style={{ flex: 1, color: C.ink, fontSize: 13, fontWeight: '600' }}>{d.label}</Text><DocBadge state="IN_REVIEW" /></View>
      <Muted>Current copy: {CHEF_DOC_STATE_LABELS[d.state].toLowerCase()}{d.expiresAt ? ` · ${day(d.expiresAt)}` : ''}</Muted>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {d.pendingFileId && <Button variant="ghost" title="Open file" onPress={() => run(async () => { await Linking.openURL((await api.get<{ url: string }>(`/chef/files/${d.pendingFileId}/link`)).url); })} />}
        {manage && !rejecting && <Button title="Approve" disabled={busy} onPress={() => review('APPROVED')} />}
        {manage && !rejecting && <Button variant="secondary" title="Reject" disabled={busy} onPress={() => setRejecting(true)} />}
      </View>
      {rejecting && (
        <View>
          <Input label="Why it was rejected (sent to the chef)" value={note} onChangeText={setNote} placeholder="Unreadable, or not the right document" />
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Button style={{ flex: 1 }} variant="danger" title="Reject renewal" disabled={busy || !note.trim()} onPress={() => review('REJECTED')} />
            <Button style={{ flex: 1 }} variant="ghost" title="Cancel" onPress={() => setRejecting(false)} />
          </View>
        </View>
      )}
      <ErrorText msg={error} />
    </View>
  );
}
