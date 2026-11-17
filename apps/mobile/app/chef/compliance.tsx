import { useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useApi } from '@/hooks';
import { when } from '@/api';
import { Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { pickImage } from '@/chef-ui';
import { pickFileOnWeb, uploadMultipart, type PickedFile } from '@/upload';
import { day, DocBadge, mins, NEEDS_RENEWAL, pct, type DocStatus } from '@/chef-ops';

interface Compliance {
  status: string;
  statusCause: string | null;
  statusReason: string | null;
  documents: DocStatus[];
  metrics: { orders: number; completed: number; declineRatePct: number | null; incidentRatePct: number | null; avgAcceptMinutes: number | null; rating: number | null; ratings: number; avgRequestResponseMinutes: number | null } | null;
  thresholds: { windowDays: number; minOrders: number; maxIncidentRatePct: number; maxDeclineRatePct: number };
  events: { id: string; kind: string; label: string; note: string; createdAt: string }[];
}

/** Chef: required documents with renewals, quality metrics against the limits, and the quality record. */
export default function ChefCompliance() {
  const { data, error, reload } = useApi<Compliance>('/chef/compliance');
  if (!data) return <View style={[s.screen, s.pad]}>{error ? <ErrorText msg={error} /> : <Loading />}</View>;
  const m = data.metrics;
  const t = data.thresholds;
  const judged = !!m && m.orders >= t.minOrders;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {data.status !== 'ACTIVE' && (
        <View style={{ backgroundColor: '#fee2e2', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <Text style={{ color: '#991b1b', fontWeight: '700' }}>Your listings are {data.status.toLowerCase()}</Text>
          {data.statusReason ? <Text style={{ color: '#991b1b', marginTop: 4 }}>{data.statusReason}</Text> : null}
          {data.statusCause === 'DOCUMENTS' && <Text style={{ color: '#991b1b', marginTop: 4 }}>They reopen once Gutad approves the renewal.</Text>}
        </View>
      )}
      <ErrorText msg={error} />
      <Card title="Required documents">
        {!data.documents.length ? <Muted>No documents required.</Muted> : data.documents.map((d) => <DocCard key={d.key} d={d} reload={reload} />)}
      </Card>
      <Card title={`Quality, last ${t.windowDays} days`}>
        {!m ? <Muted>No data yet.</Muted> : (
          <>
            <Metric label="Orders" value={`${m.orders} (${m.completed} completed)`} />
            <Metric label="Declined or unconfirmed" value={pct(m.declineRatePct)} limit={`limit ${t.maxDeclineRatePct}%`} over={judged && m.declineRatePct !== null && m.declineRatePct > t.maxDeclineRatePct} />
            <Metric label="Customer problems" value={pct(m.incidentRatePct)} limit={`limit ${t.maxIncidentRatePct}%`} over={judged && m.incidentRatePct !== null && m.incidentRatePct > t.maxIncidentRatePct} />
            <Metric label="Time to accept" value={mins(m.avgAcceptMinutes)} />
            <Metric label="Request reply time" value={mins(m.avgRequestResponseMinutes)} />
            <Metric label="Rating" value={m.rating === null ? '—' : `${m.rating} ★ (${m.ratings})`} />
            <Muted>Rates count once you have {t.minOrders} orders in the window.</Muted>
          </>
        )}
      </Card>
      <Card title="Quality record">
        {!data.events.length ? <Muted>Nothing on your record.</Muted> : data.events.map((e) => (
          <View key={e.id} style={{ borderTopWidth: 1, borderTopColor: C.ink1, paddingVertical: 8 }}>
            <Text style={{ fontWeight: '600', color: C.ink }}>{e.label}</Text>
            <Text style={{ color: C.ink7 }}>{e.note}</Text>
            <Muted>{when(e.createdAt)}</Muted>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

function Metric({ label, value, limit, over }: { label: string; value: string; limit?: string; over?: boolean }) {
  return (
    <View style={[s.row, { marginBottom: 6 }]}>
      <Text style={{ color: C.ink7, flex: 1 }}>{label}</Text>
      <Text style={{ fontWeight: '700', color: over ? C.bad : C.ink }}>{value}{limit ? <Text style={{ fontWeight: '400', color: C.ink5, fontSize: 12 }}> · {limit}</Text> : null}</Text>
    </View>
  );
}

/** One required document; renewal upload when it is expiring, expired, rejected or missing. */
function DocCard({ d, reload }: { d: DocStatus; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [exp, setExp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canRenew = NEEDS_RENEWAL.includes(d.state) && !d.pendingDocId;
  const send = async (f: PickedFile | null) => {
    if (!f) return;
    if (d.needsExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) { setErr('Enter the new expiry date as YYYY-MM-DD first'); return; }
    setBusy(true); setErr(null);
    try { await uploadMultipart('/chef/application/documents', f, { requirementKey: d.key, expiresAt: exp || undefined }); setOpen(false); setExp(''); await reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const pick = (fn: () => Promise<PickedFile | null>) => async () => { try { await send(await fn()); } catch (e) { setErr((e as Error).message); } };
  return (
    <View style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 12, padding: 10, marginBottom: 8 }}>
      <View style={[s.row, { gap: 6 }]}><Text style={{ fontWeight: '600', flex: 1, color: C.ink }}>{d.label}</Text><DocBadge state={d.state} /></View>
      {d.expiresAt ? <Muted>{d.state === 'EXPIRED' ? 'Expired' : d.state === 'IN_REVIEW' ? 'New expiry' : 'Expires'} {day(d.expiresAt)}</Muted> : null}
      {d.pendingDocId && d.state !== 'IN_REVIEW' ? <Muted>Renewal sent. Gutad is reviewing it.</Muted> : null}
      {d.note ? <Text style={{ color: C.bad, fontSize: 12 }}>Reviewer: {d.note}</Text> : null}
      {canRenew && !open && <Button variant={d.state === 'EXPIRING' ? 'secondary' : 'primary'} title={d.state === 'MISSING' ? 'Upload document' : 'Upload renewal'} onPress={() => setOpen(true)} />}
      {canRenew && open && (
        <View style={{ marginTop: 6 }}>
          {d.needsExpiry && <Input label="New expiry date (YYYY-MM-DD)" value={exp} onChangeText={setExp} placeholder="2027-06-30" autoCapitalize="none" />}
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {Platform.OS !== 'web' && <Button style={{ flex: 1 }} variant="secondary" disabled={busy} title="Take photo" onPress={pick(() => pickImage('camera'))} />}
            <Button style={{ flex: 1 }} variant="secondary" disabled={busy} title={busy ? 'Uploading…' : Platform.OS === 'web' ? 'Choose file' : 'From photos'} onPress={pick(() => (Platform.OS === 'web' ? pickFileOnWeb() : pickImage('library')))} />
          </View>
          <Button variant="ghost" title="Cancel" disabled={busy} onPress={() => { setOpen(false); setErr(null); }} />
        </View>
      )}
      <ErrorText msg={err} />
    </View>
  );
}
