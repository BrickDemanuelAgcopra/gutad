import { useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { APPLICATION_STATUS_LABELS, COURIER_DOC_LABELS, ELIGIBILITY_CHECKS, ELIGIBILITY_LABELS, EQUIPMENT_LABELS, LIFECYCLE_LABELS, type ApplicationStatus, type CheckStatus, type CourierDocKind, type EligibilityCheck, type EquipmentItem, type LifecycleStatus } from '@gutad/shared';
import { api, money, when } from '@/api';
import { useAction, useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s, tone } from '@/ui';
import { Pills } from '@/ops';
import { StoredPhoto } from '@/courier/photo';
import type { Onboarding } from '@/courier/common';

interface Row { id: string; name: string | null; email: string; status: string; operational: string; vehicleType: string; missingDocs: string[]; appealStatus: string; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; delivered: number } }
interface Prof { courier: { id: string; name: string | null; email: string; status: string; vehicleType: string; capabilities: string[]; suspendedReason: string | null; appealStatus: string; appealNote: string | null }; documents: { id: string; kind: string; status: string; expiresAt: string | null; fileUrl: string }[]; records: { id: string; kind: string; title: string; createdAt: string }[]; payableCents: number; metrics?: { acceptanceRate: number | null; completionRate: number | null; onTimeRate: number | null; cancellationRate: number | null }; onboarding?: Onboarding; time?: Record<string, number> | null; feedback?: { avg: number | null; count: number } | null }
const pct = (x: number | null | undefined) => (x == null ? '—' : `${x}%`);

/** Couriers on the phone: directory, document review, suspensions and appeals, pay adjustments. */
export default function OpsCouriers() {
  const [tab, setTab] = useState<'apps' | 'all' | 'docs' | 'appeals'>('all');
  const [sel, setSel] = useState<string | null>(null);
  const { data } = useApi<Row[]>('/admin/couriers', { poll: 30000 });
  const { data: docs, reload: reloadDocs } = useApi<{ pending: { id: string; driverId: string; kind: string; fileUrl: string; fileId: string | null; expiresAt: string | null; courierName: string | null }[] }>(tab === 'docs' ? '/admin/couriers/documents' : null, { deps: [tab] });
  const { run, error } = useAction();
  if (sel) return <Profile id={sel} onBack={() => setSel(null)} />;
  if (!data) return <Loading />;
  const list = tab === 'appeals' ? data.filter((c) => c.appealStatus === 'PENDING') : data;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Pills value={tab} onChange={setTab} options={[{ id: 'all', label: 'Couriers' }, { id: 'apps', label: 'Applications' }, { id: 'docs', label: 'Documents' }, { id: 'appeals', label: 'Appeals' }]} />
      <ErrorText msg={error} />
      {tab === 'apps' ? <Applications onOpen={setSel} /> : tab === 'docs' ? (
        <>{!docs?.pending.length && <Card><Muted>Nothing to review.</Muted></Card>}{docs?.pending.map((d) => <Card key={d.id}><Text style={{ fontWeight: '600' }}>{d.courierName} · {COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind}</Text><Muted>{d.expiresAt ? `Expires ${when(d.expiresAt)}` : 'No expiry given'}</Muted><View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}><Button title="Open file" variant="ghost" onPress={() => run(async () => { await Linking.openURL(d.fileId ? (await api.get<{ url: string }>(`/files/${d.fileId}/link`)).url : d.fileUrl); })} /><Button title="Approve" disabled={!d.expiresAt && d.kind !== 'BACKGROUND_CHECK'} onPress={() => run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked on mobile' }); await reloadDocs(); })} /><Button title="Reject" variant="secondary" onPress={() => run(async () => { await api.post(`/admin/courier-documents/${d.id}/review`, { approve: false, note: 'Unreadable or not valid; please upload again' }); await reloadDocs(); })} /></View>{!d.expiresAt && d.kind !== 'BACKGROUND_CHECK' && <Muted>Set the expiry date on the web console to approve.</Muted>}</Card>)}</>
      ) : list.map((c) => (
        <Pressable key={c.id} onPress={() => setSel(c.id)}>
          <Card>
            <View style={s.row}><Text style={{ fontWeight: '700', color: C.ink, flex: 1 }}>{c.name || c.email}</Text><Badge text={c.operational.replace('_', ' ')} tone={c.operational === 'ONLINE' ? 'good' : c.operational === 'ON_DELIVERY' ? 'warn' : c.status === 'SUSPENDED' ? 'bad' : 'neutral'} /></View>
            <Muted>{c.vehicleType.toLowerCase()} · accept {pct(c.metrics?.acceptanceRate)} · complete {pct(c.metrics?.completionRate)} · on time {pct(c.metrics?.onTimeRate)}</Muted>
            {c.missingDocs.length > 0 && <Text style={{ color: C.bad, fontSize: 12 }}>Missing: {c.missingDocs.map((d) => COURIER_DOC_LABELS[d as CourierDocKind]).join(', ')}</Text>}
            {c.appealStatus === 'PENDING' && <Text style={{ color: C.warn, fontSize: 12 }}>Appeal waiting</Text>}
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Profile({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useSession();
  const { data: p, reload } = useApi<Prof>(`/admin/couriers/${id}`);
  const { run, error } = useAction();
  const [note, setNote] = useState('');
  const [amt, setAmt] = useState('');
  if (!p) return <Loading />;
  const c = p.courier;
  const manage = can('delivery.manage');
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Button title="← Couriers" variant="ghost" onPress={onBack} />
      <Card title={c.name || c.email}>
        <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={c.status} tone={tone(c.status)} /><Badge text={c.vehicleType} /></View>
        <Muted>Accept {pct(p.metrics?.acceptanceRate)} · complete {pct(p.metrics?.completionRate)} · cancel {pct(p.metrics?.cancellationRate)} · on time {pct(p.metrics?.onTimeRate)}</Muted>
        <Text style={{ marginTop: 4 }}>Payable {money(p.payableCents)}</Text>
      </Card>
      <ErrorText msg={error} />
      {p.onboarding?.driver && <AccountStatus id={id} ob={p.onboarding} manage={manage} onDone={reload} />}
      {p.onboarding && <Details ob={p.onboarding} />}
      {c.status === 'SUSPENDED' && <Card title="Suspended"><Muted>{c.suspendedReason}</Muted>{c.appealStatus === 'PENDING' && <><Text style={{ marginTop: 4 }}>Appeal: “{c.appealNote}”</Text>{manage && <><Input label="Decision note" value={note} onChangeText={setNote} /><View style={{ flexDirection: 'row', gap: 6 }}><Button title="Reinstate" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: true, note }); setNote(''); await reload(); })} /><Button title="Uphold" variant="secondary" disabled={note.length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/appeal-decision`, { reinstate: false, note }); setNote(''); await reload(); })} /></View><Muted>Must be someone other than the person who suspended them.</Muted></>}</>}</Card>}
      <Card title="Documents">{p.documents.map((d) => <View key={d.id} style={s.row}><Text>{COURIER_DOC_LABELS[d.kind as CourierDocKind] || d.kind}</Text><Text style={{ color: d.status === 'APPROVED' ? C.good : d.status === 'PENDING' ? C.warn : C.bad }}>{d.status.toLowerCase()}{d.expiresAt ? ` · ${new Date(d.expiresAt).toLocaleDateString()}` : ''}</Text></View>)}{!p.documents.length && <Muted>None uploaded.</Muted>}</Card>
      <Card title="Records">{p.records.slice(0, 10).map((r) => <Muted key={r.id}>{r.kind.toLowerCase().replace('_', ' ')} · {r.title} · {when(r.createdAt)}</Muted>)}{!p.records.length && <Muted>None.</Muted>}</Card>
      {manage && <Card title="Actions">
        <Input label="Reason / amount note" value={note} onChangeText={setNote} />
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Input label="Adjustment $ (− for deduction)" keyboardType="numbers-and-punctuation" value={amt} onChangeText={setAmt} /></View><Button title="Post" disabled={!amt || note.length < 5} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/adjustments`, { cents: Math.round(Number(amt) * 100), reason: note }); setAmt(''); setNote(''); await reload(); })} /></View>
        {c.status !== 'SUSPENDED' && <Button title="Suspend courier" variant="danger" disabled={note.length < 5} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/suspend`, { reason: note }); setNote(''); await reload(); })} />}
      </Card>}
    </ScrollView>
  );
}

interface Pipeline {
  counts: Partial<Record<ApplicationStatus, number>>;
  funnel: { started: number; submitted: number; approved: number; firstDelivery: number };
  applicants: { id: string; name: string | null; email: string; city: string | null; transport: string; applicationStatus: ApplicationStatus; submittedAt: string | null; updatedAt: string; stalled: boolean; stepsDone: number; stepsTotal: number; checks: Partial<Record<EligibilityCheck, CheckStatus>>; pendingDocs: number }[];
}
const checkTone = (st?: string) => (st === 'PASSED' ? 'good' : st === 'PENDING' ? 'warn' : st && ['FAILED', 'EXPIRED', 'NEEDS_ACTION'].includes(st) ? 'bad' : 'neutral');
const DECISIONS = [['APPROVE', 'Approve', 'primary'], ['NEEDS_ACTION', 'Needs action', 'secondary'], ['WAITLIST', 'Waitlist', 'secondary'], ['REJECT', 'Reject', 'danger'], ['REOPEN', 'Reopen', 'ghost']] as const;

/** Onboarding pipeline: funnel, applicants waiting for a decision, per-check quick actions and the decision itself (note required). */
function Applications({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useSession();
  const [filter, setFilter] = useState<'review' | 'all'>('review');
  const { data, reload } = useApi<Pipeline>('/admin/couriers/pipeline', { poll: 60000 });
  const { run, error, busy } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!data) return <Loading />;
  const manage = can('delivery.manage');
  const review: ApplicationStatus[] = ['SUBMITTED', 'VERIFICATION_PENDING', 'NEEDS_ACTION'];
  const list = filter === 'review' ? data.applicants.filter((a) => review.includes(a.applicationStatus)) : data.applicants;
  const f = data.funnel;
  return (
    <>
      <Card title="Funnel">
        <Text style={{ color: C.ink }}>{f.started} started → {f.submitted} submitted → {f.approved} approved → {f.firstDelivery} first delivery</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>{(Object.keys(APPLICATION_STATUS_LABELS) as ApplicationStatus[]).filter((k) => data.counts[k]).map((k) => <Badge key={k} text={`${APPLICATION_STATUS_LABELS[k]} · ${data.counts[k]}`} tone={tone(k)} />)}</View>
      </Card>
      <Pills value={filter} onChange={setFilter} options={[{ id: 'review', label: 'To review' }, { id: 'all', label: 'All applicants' }]} />
      <ErrorText msg={error} />
      {!list.length && <Card><Muted>No applications here.</Muted></Card>}
      {list.map((a) => (
        <Card key={a.id}>
          <Pressable onPress={() => { setOpen(open === a.id ? null : a.id); setNote(''); }}>
            <View style={s.row}><Text style={{ fontWeight: '700', color: C.ink, flex: 1 }}>{a.name || a.email}</Text><Badge text={APPLICATION_STATUS_LABELS[a.applicationStatus] || a.applicationStatus} tone={tone(a.applicationStatus)} /></View>
            <Muted>{a.city || '—'} · {a.transport.toLowerCase()} · {a.stepsDone}/{a.stepsTotal} steps{a.submittedAt ? ` · submitted ${when(a.submittedAt)}` : ''}</Muted>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {a.stalled && <Badge text="Stalled" tone="warn" />}
              {a.pendingDocs > 0 && <Badge text={`${a.pendingDocs} doc${a.pendingDocs === 1 ? '' : 's'} to review`} tone="warn" />}
              {ELIGIBILITY_CHECKS.map((c) => <Badge key={c} text={`${ELIGIBILITY_LABELS[c]}: ${(a.checks[c] || 'NOT_STARTED').toLowerCase().replace(/_/g, ' ')}`} tone={checkTone(a.checks[c])} />)}
            </View>
          </Pressable>
          {open === a.id && (
            <View style={{ marginTop: 8 }}>
              <Button title="Open courier profile" variant="ghost" onPress={() => onOpen(a.id)} />
              {manage ? (
                <>
                  <Input label="Note (required, shown to the courier on decisions)" value={note} onChangeText={setNote} />
                  <Muted>Checks</Muted>
                  {ELIGIBILITY_CHECKS.map((c) => (
                    <View key={c} style={[s.row, { marginVertical: 2 }]}>
                      <Text style={{ flex: 1, color: C.ink }}>{ELIGIBILITY_LABELS[c]}</Text>
                      <View style={{ flexDirection: 'row', gap: 4 }}>
                        {a.checks[c] !== 'PASSED' && <Button title="Pass" variant="secondary" disabled={busy} onPress={() => run(async () => { await api.post(`/admin/couriers/${a.id}/checks/${c}`, { status: 'PASSED', note: note.trim() || undefined }); await reload(); })} />}
                        {a.checks[c] !== 'NEEDS_ACTION' && <Button title="Needs action" variant="ghost" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${a.id}/checks/${c}`, { status: 'NEEDS_ACTION', note: note.trim() }); await reload(); })} />}
                        {a.checks[c] !== 'FAILED' && <Button title="Fail" variant="danger" disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${a.id}/checks/${c}`, { status: 'FAILED', note: note.trim() }); await reload(); })} />}
                      </View>
                    </View>
                  ))}
                  <Muted>Decision</Muted>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {DECISIONS.map(([d, l, v]) => <Button key={d} title={l} variant={v} disabled={busy || note.trim().length < 3} onPress={() => run(async () => { await api.post(`/admin/couriers/${a.id}/decision`, { decision: d, note: note.trim() }); setNote(''); setOpen(null); await reload(); })} />)}
                  </View>
                  <Muted>Needs action and Fail need a note. Approval needs every check passed and the documents for the courier’s vehicle.</Muted>
                </>
              ) : <Muted>You can view applications. Deciding needs delivery management access.</Muted>}
            </View>
          )}
        </Card>
      ))}
    </>
  );
}

const LIFECYCLE_ACTIONS: { status: LifecycleStatus; label: string; variant: 'primary' | 'secondary' | 'danger' | 'ghost'; help: string }[] = [
  { status: 'ACTIVE', label: 'Make active', variant: 'primary', help: 'Gets every kind of offer.' },
  { status: 'RESTRICTED', label: 'Restrict', variant: 'secondary', help: 'No batched orders or deliveries that need special handling.' },
  { status: 'SUSPENDED', label: 'Suspend', variant: 'danger', help: 'No offers; the courier can appeal.' },
  { status: 'DEACTIVATED', label: 'Deactivate', variant: 'danger', help: 'Account closed; can ask for reactivation.' },
];

/** Application and account status (approved couriers only), with the controls from the web console. */
function AccountStatus({ id, ob, manage, onDone }: { id: string; ob: Onboarding; manage: boolean; onDone: () => Promise<void> }) {
  const d = ob.driver!;
  const { run, error, busy } = useAction();
  const [reason, setReason] = useState('');
  const life = d.lifecycleStatus as LifecycleStatus | null;
  const approved = d.applicationStatus === 'APPROVED';
  return (
    <Card title="Account status">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Badge text={`Application: ${APPLICATION_STATUS_LABELS[d.applicationStatus as ApplicationStatus] || d.applicationStatus}`} tone={tone(d.applicationStatus)} />
        {life && <Badge text={`Account: ${LIFECYCLE_LABELS[life] || life}`} tone={life === 'ACTIVE' ? 'good' : life === 'RESTRICTED' ? 'warn' : 'bad'} />}
      </View>
      {d.decisionNote ? <Muted>Last decision: {d.decisionNote}</Muted> : null}
      {!approved ? <Muted>Account status applies once the application is approved. Decide on it in Applications.</Muted> : manage ? (
        <>
          <Input label="Reason (required, at least 5 characters)" value={reason} onChangeText={setReason} />
          {LIFECYCLE_ACTIONS.filter((a) => a.status !== life).map((a) => (
            <View key={a.status} style={[s.row, { marginVertical: 2 }]}>
              <View style={{ flex: 1 }}><Muted>{a.help}</Muted></View>
              <Button title={a.label} variant={a.variant} disabled={busy || reason.trim().length < 5} onPress={() => run(async () => { await api.post(`/admin/couriers/${id}/lifecycle`, { status: a.status, reason: reason.trim() }); setReason(''); await onDone(); })} />
            </View>
          ))}
          {life === 'SUSPENDED' && <Muted>Lifting a suspension must be done by someone other than the person who suspended the courier.</Muted>}
        </>
      ) : <Muted>Changing the account status needs delivery management access.</Muted>}
      <ErrorText msg={error} />
    </Card>
  );
}

/** What the courier entered during sign-up, with their photos. */
function Details({ ob }: { ob: Onboarding }) {
  const x = ob.data;
  return (
    <Card title="Application details">
      {x.location && <Muted>{x.location.city || '—'}, {x.location.country || '—'} · {(x.location.transport || '').toLowerCase()}{x.location.zoneIds?.length ? ` · ${x.location.zoneIds.length} delivery area(s)` : ' · whole city'}</Muted>}
      {x.profile && <><Text style={{ color: C.ink, marginTop: 4 }}>{x.profile.legalName} · {x.profile.phone}</Text><Muted>{x.profile.addressLine1}, {x.profile.city} {x.profile.postalCode}</Muted>{x.profile.photoUrl ? <StoredPhoto url={x.profile.photoUrl} /> : null}</>}
      {x.equipment && <><Text style={{ color: C.ink, marginTop: 4 }}>Equipment: {x.equipment.items.map((i: EquipmentItem) => EQUIPMENT_LABELS[i] || i).join(', ') || '—'}</Text>{x.equipment.photoUrl ? <StoredPhoto url={x.equipment.photoUrl} /> : null}</>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>{ob.checks.map((c) => <Badge key={c.check} text={`${ELIGIBILITY_LABELS[c.check]}: ${c.status.toLowerCase().replace(/_/g, ' ')}`} tone={checkTone(c.status)} />)}</View>
    </Card>
  );
}
