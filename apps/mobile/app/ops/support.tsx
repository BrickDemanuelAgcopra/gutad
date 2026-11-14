import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SUPPORT_CATEGORIES } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';
import { CaseThread } from '@/case-thread';

interface Incident { id: string; category: string; description: string; status: string; priority: string; queue: string | null; owner: string | null; remedy: string | null; remedyCents: number; orderId: string | null; assigneeId: string | null; firstResponseDueAt: string | null; resolveDueAt: string | null; firstRespondedAt: string | null; slaBreachedAt: string | null; reporterType?: string; createdAt: string; responsibilityDispute: { role?: string; reason?: string; status?: string } | null }
interface Preview { refundableCents: number; needsApproval: boolean; reasons: string[]; willIssue: string; goodwill: { count90d: number; cents90d: number } | null }

const label = (k: string) => (SUPPORT_CATEGORIES as Record<string, { label: string }>)[k]?.label || k;
const prio = (p: string) => (p === 'URGENT' ? 'bad' : p === 'HIGH' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';
const due = (at: string | null) => { if (!at) return ''; const m = Math.round((new Date(at).getTime() - Date.now()) / 60000); return m < 0 ? `${-m}m late` : m < 120 ? `in ${m}m` : `in ${Math.round(m / 60)}h`; };

/** Support queue on the phone: SLA-ordered tickets, take ownership, reply, resolve with remedy preview, responsibility disputes. */
export default function OpsSupport() {
  const { user } = useSession();
  const [tab, setTab] = useState<'OPEN' | 'MINE' | 'BREACHED' | 'DISPUTES'>('OPEN');
  const path = tab === 'MINE' ? '/incidents?mine=true' : tab === 'BREACHED' ? '/incidents?breached=true&status=OPEN' : tab === 'DISPUTES' ? '/incidents?status=RESOLVED' : '/incidents?status=OPEN';
  const { data, reload } = useApi<Incident[]>(path, { poll: 15000, deps: [tab] });
  const [open, setOpen] = useState<string | null>(null);
  const rows = tab === 'DISPUTES' ? data?.filter((i) => i.responsibilityDispute?.status === 'OPEN') : data;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={(t) => { setTab(t); setOpen(null); }} options={[{ id: 'OPEN', label: 'Open' }, { id: 'MINE', label: 'Mine' }, { id: 'BREACHED', label: 'Late' }, { id: 'DISPUTES', label: 'Disputes' }]} />
      {!rows && <Loading />}
      {rows?.length === 0 && <Card><Muted>Nothing here.</Muted></Card>}
      {rows?.map((i) => (
        <Card key={i.id}>
          <Pressable onPress={() => setOpen(open === i.id ? null : i.id)}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={i.priority} tone={prio(i.priority)} />{i.slaBreachedAt && <Badge text="SLA" tone="bad" />}<Badge text={i.status} tone={tone(i.status)} />{i.assigneeId === user?.id && <Badge text="mine" tone="info" />}</View>
            <Text style={{ fontWeight: '600', color: C.ink, marginTop: 4 }}>{label(i.category)}{i.reporterType && i.reporterType !== 'CUSTOMER' ? ` · from ${i.reporterType.toLowerCase()}` : ''}</Text>
            <Muted>{i.description}</Muted>
            <Muted>{i.queue} · opened {when(i.createdAt)}{!i.firstRespondedAt && i.firstResponseDueAt ? ` · reply ${due(i.firstResponseDueAt)}` : ''}{i.resolveDueAt && i.status === 'OPEN' ? ` · resolve ${due(i.resolveDueAt)}` : ''}</Muted>
          </Pressable>
          {open === i.id && <Detail i={i} onChange={reload} />}
        </Card>
      ))}
    </ScrollView>
  );
}

function Detail({ i, onChange }: { i: Incident; onChange: () => void }) {
  const router = useRouter();
  const { user } = useSession();
  const { run, error } = useAction();
  const [r, setR] = useState({ owner: 'MERCHANT', remedy: 'REFUND', amount: '', note: '' });
  const [pv, setPv] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cents = Math.round(Number(r.amount || 0) * 100);
  const active = ['OPEN', 'INVESTIGATING', 'APPEALED'].includes(i.status);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => { api.get<Preview>(`/incidents/${i.id}/remedy-preview?remedy=${r.remedy}&cents=${cents}`).then(setPv).catch(() => setPv(null)); }, 300);
    return () => clearTimeout(t);
  }, [i.id, r.remedy, cents, active]);
  return (
    <View style={{ marginTop: 8 }}>
      <ErrorText msg={error} />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {active && i.assigneeId !== user?.id && <Button title="Assign to me" variant="secondary" onPress={() => run(async () => { await api.post(`/incidents/${i.id}/assign`, { assigneeId: user?.id }); onChange(); })} />}
        {i.orderId && <Button title="Open order" variant="ghost" onPress={() => router.push(`/ops/order/${i.orderId}` as never)} />}
      </View>
      <CaseThread incidentId={i.id} staff />
      {active && (
        <View style={{ marginTop: 8 }}>
          <Muted>Cost owner</Muted>
          <Pills value={r.owner} onChange={(v) => setR({ ...r, owner: v })} options={['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER'].map((x) => ({ id: x, label: x.toLowerCase() }))} />
          <Muted>Remedy</Muted>
          <Pills value={r.remedy} onChange={(v) => setR({ ...r, remedy: v })} options={['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY', 'NONE'].map((x) => ({ id: x, label: x.toLowerCase() }))} />
          <Input label="Amount (USD)" keyboardType="decimal-pad" value={r.amount} onChangeText={(v) => setR({ ...r, amount: v })} />
          {pv && <Muted>Refundable left {money(pv.refundableCents)} · will issue {pv.willIssue.toLowerCase()}{pv.goodwill ? ` · goodwill 90d ${pv.goodwill.count90d}× ${money(pv.goodwill.cents90d)}` : ''}</Muted>}
          {pv?.needsApproval && <Text style={{ color: C.warn }}>Needs a second approver: {pv.reasons.join('; ')}</Text>}
          <Input label="Note / evidence" value={r.note} onChangeText={(v) => setR({ ...r, note: v })} />
          <Button title={pv?.needsApproval ? 'Request approval' : 'Resolve'} onPress={() => run(async () => { const res = await api.post<{ status?: string }>(`/incidents/${i.id}/resolve`, { owner: r.owner, remedy: r.remedy, remedyCents: cents, note: r.note }); setMsg(res?.status === 'PENDING_APPROVAL' ? 'Sent for approval.' : 'Resolved.'); onChange(); })} />
        </View>
      )}
      {i.responsibilityDispute?.status === 'OPEN' && (
        <View style={{ marginTop: 8, backgroundColor: '#fffbeb', padding: 8, borderRadius: 10 }}>
          <Text>The {i.responsibilityDispute.role?.toLowerCase()} disputes responsibility: “{i.responsibilityDispute.reason}”</Text>
          <Input label="Decision note" value={r.note} onChangeText={(v) => setR({ ...r, note: v })} />
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Button title="Reverse — Gutad absorbs" disabled={r.note.length < 3} onPress={() => run(async () => { await api.post(`/incidents/${i.id}/responsibility-decision`, { reverse: true, note: r.note }); onChange(); })} />
            <Button title="Uphold" variant="secondary" disabled={r.note.length < 3} onPress={() => run(async () => { await api.post(`/incidents/${i.id}/responsibility-decision`, { reverse: false, note: r.note }); onChange(); })} />
          </View>
        </View>
      )}
      {msg && <Text style={{ color: C.good }}>{msg}</Text>}
    </View>
  );
}
