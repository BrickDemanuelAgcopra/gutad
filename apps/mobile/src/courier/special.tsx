import { useState } from 'react';
import { Text, View } from 'react-native';
import { CERTIFICATION_STATUS_LABELS, ID_TYPE_LABELS, REFUSAL_LABELS, REFUSAL_REASONS, SPECIAL_CATEGORY_LABELS, ageOn, type CertificationStatus, type CertifiableCategory, type RefusalReason, type SpecialCategory } from '@gutad/shared';
import { api, money } from '../api';
import { useAction, useApi } from '../hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted } from '../ui';
import { Choice, Toggle } from '../chef-ui';
import { errBody, errCode, type Job } from './common';
import { PhotoCapture, type UploadedPhoto } from './photo';

// Courier Release 4 (mobile): certifications, category badges, and the special handoff pieces (age check, temperature, catering, refusal).

interface Cert {
  id: string | null; category: CertifiableCategory; label: string; status: CertificationStatus; expiresAt: string | null; note: string | null;
  trainingPassedAt: string | null; certificateUploaded: boolean; premiumCents: number; needs: string[];
  training: { title: string; body: string; questions: { q: string; options: string[] }[] };
}
interface Certs { certifications: Cert[]; highValue: { eligible: boolean; reason: string | null; deliveries: number; minDeliveries: number; thresholdCents: number } }

const NEEDS_TEXT: Record<string, string> = {
  TRAINING: 'Read the guide and pass the quiz',
  CERTIFICATE: 'Upload your responsible-service certificate',
  SCREENING: 'Your background check must pass',
  VEHICLE: 'A car or van is needed',
  COLD_BAG: 'Add a cold bag to your equipment',
};
const certTone = (st: CertificationStatus): 'good' | 'warn' | 'bad' | 'neutral' | 'info' => (st === 'ACTIVE' ? 'good' : st === 'PENDING' ? 'warn' : st === 'TRAINING' ? 'info' : ['REJECTED', 'EXPIRED', 'REVOKED'].includes(st) ? 'bad' : 'neutral');
const catTone = (c: string): 'warn' | 'info' | 'bad' => (c === 'ALCOHOL' || c === 'HIGH_VALUE' ? 'warn' : c === 'SENSITIVE' ? 'bad' : 'info');
const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Category chips for offers and jobs. */
export function CategoryBadges({ categories }: { categories?: string[] | null }) {
  if (!categories?.length) return null;
  return <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{categories.map((c) => <Badge key={c} text={SPECIAL_CATEGORY_LABELS[c as SpecialCategory] || c} tone={catTone(c)} />)}</View>;
}

/** Certifications tab: status, expiry and premium per category; training guide + quiz; the alcohol certificate; high-value eligibility. */
export function Certifications() {
  const { data, reload, error: loadErr } = useApi<Certs>('/driver/certifications');
  const [open, setOpen] = useState<CertifiableCategory | null>(null);
  if (!data) return <Card title="Certifications">{loadErr ? <ErrorText msg={loadErr} /> : <Muted>Loading…</Muted>}</Card>;
  const hv = data.highValue;
  return (
    <>
      <Card title="Certifications">
        <Muted>Certified couriers get offers for special orders and earn a premium on each one.</Muted>
        {data.certifications.map((c) => (
          <View key={c.category} style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: C.ink1 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <Text style={{ fontWeight: '700', color: C.ink }}>{c.label}</Text>
              <Badge text={CERTIFICATION_STATUS_LABELS[c.status] || c.status} tone={certTone(c.status)} />
              {c.premiumCents > 0 && <Badge text={`+${money(c.premiumCents)} per order`} tone="good" />}
            </View>
            {c.expiresAt && <Muted>{c.status === 'EXPIRED' ? 'Expired' : 'Valid until'} {day(c.expiresAt)}</Muted>}
            {c.note && <Muted>Note: {c.note}</Muted>}
            {c.status !== 'ACTIVE' && c.needs.length > 0 && <View style={{ marginTop: 2 }}>{c.needs.map((n) => <Text key={n} style={{ color: C.warn, fontSize: 13 }}>• {NEEDS_TEXT[n] || n}</Text>)}</View>}
            {c.status !== 'REVOKED' && <Button title={open === c.category ? 'Close' : c.needs.includes('TRAINING') ? 'Start training' : c.needs.includes('CERTIFICATE') ? 'Upload certificate' : 'View guide'} variant={open === c.category ? 'ghost' : 'secondary'} onPress={() => setOpen(open === c.category ? null : c.category)} />}
            {c.status === 'REVOKED' && <Muted>Contact courier support about this certification.</Muted>}
            {open === c.category && <CertDetail c={c} onDone={() => void reload()} />}
          </View>
        ))}
      </Card>
      <Card title="High-value orders">
        <Text style={{ color: hv.eligible ? C.good : C.ink7 }}>{hv.eligible ? `You can take orders over ${money(hv.thresholdCents)}.` : `Orders over ${money(hv.thresholdCents)} open up after ${hv.minDeliveries} deliveries with a good record.`}</Text>
        <Muted>{hv.deliveries} of {hv.minDeliveries} deliveries{hv.reason && !hv.eligible ? ` · ${hv.reason}` : ''}</Muted>
      </Card>
    </>
  );
}

function CertDetail({ c, onDone }: { c: Cert; onDone: () => void }) {
  const { run, error, busy } = useAction();
  const qs = c.training.questions;
  const [answers, setAnswers] = useState<(number | undefined)[]>(() => qs.map(() => undefined));
  const [wrong, setWrong] = useState<number[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const needsTraining = c.needs.includes('TRAINING');
  const needsCert = c.category === 'ALCOHOL' && c.needs.includes('CERTIFICATE');
  const submit = () => run(async () => {
    setMsg(null); setWrong([]);
    try {
      await api.post(`/driver/certifications/${c.category}/training`, { answers: answers.map((a) => a ?? -1) });
      setMsg(c.category === 'ALCOHOL' ? 'Passed! Now upload your certificate.' : c.category === 'SENSITIVE' ? 'Passed! We’ll review it once your background check has passed.' : 'Passed! You can now get these orders.');
      onDone();
    } catch (e) {
      const code = errCode(e);
      if (code === 'TRAINING_FAILED') { setWrong(errBody<{ wrong?: number[] }>(e)?.wrong || []); setMsg(SPECIAL_FRIENDLY.TRAINING_FAILED); return; }
      if (code && SPECIAL_FRIENDLY[code]) { setMsg(SPECIAL_FRIENDLY[code]); return; }
      throw e;
    }
  });
  return (
    <View style={{ marginTop: 6, padding: 10, backgroundColor: C.bg, borderRadius: 10 }}>
      <Text style={{ fontWeight: '700', color: C.ink, marginBottom: 4 }}>{c.training.title}</Text>
      <Text style={{ color: C.ink7, marginBottom: 8 }}>{c.training.body}</Text>
      {needsTraining && (
        <>
          {qs.map((q, i) => (
            <View key={i} style={{ marginBottom: 6 }}>
              <Text style={{ fontWeight: '600', color: wrong.includes(i) ? C.bad : C.ink, marginBottom: 4 }}>{i + 1}. {q.q}{wrong.includes(i) ? '  (not right yet)' : ''}</Text>
              <Choice value={answers[i] === undefined ? undefined : String(answers[i])} onChange={(v) => { setAnswers(answers.map((a, k) => (k === i ? Number(v) : a))); setWrong(wrong.filter((w) => w !== i)); }} options={q.options.map((o, k) => ({ value: String(k), label: o }))} />
            </View>
          ))}
          <Button title="Submit answers" disabled={busy || answers.some((a) => a === undefined)} onPress={() => void submit()} />
        </>
      )}
      {needsCert && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontWeight: '600', color: C.ink }}>Responsible-service certificate</Text>
          {c.certificateUploaded && <Muted>A certificate is on file. Upload a new one if it was rejected or has expired.</Muted>}
          {needsTraining && <Muted>Pass the quiz first, then upload a clear photo of the certificate.</Muted>}
          <PhotoCapture purpose="CERTIFICATE" label="Photo of certificate" value={photo} onChange={setPhoto} />
          <Button title="Send for review" disabled={busy || !photo || needsTraining} onPress={() => run(async () => {
            setMsg(null);
            try { await api.post(`/driver/certifications/ALCOHOL/certificate`, { fileUrl: photo!.url }); setPhoto(null); setMsg('Sent. We’ll review it shortly.'); onDone(); }
            catch (e) { const code = errCode(e); if (code && SPECIAL_FRIENDLY[code]) { setMsg(SPECIAL_FRIENDLY[code]); return; } throw e; }
          })} />
        </View>
      )}
      {msg && <Text style={{ color: wrong.length ? C.bad : C.info, marginTop: 4 }}>{msg}</Text>}
      <ErrorText msg={error} />
    </View>
  );
}

/** Friendly messages for the R4 handoff and certification errors. */
export const SPECIAL_FRIENDLY: Record<string, string> = {
  UNDERAGE: 'The customer is under age. Don’t hand over the order: tap “Can’t hand over” and choose “Customer is under age”.',
  ID_TYPE_INVALID: 'That type of ID isn’t accepted. Ask for another photo ID, or tap “Can’t hand over”.',
  ALCOHOL_HOURS: 'Alcohol can’t be handed over at this time of day. Tap “Can’t hand over” and return it to the kitchen.',
  SIGNATURE_REQUIRED: 'This order needs the recipient’s signature.',
  RECIPIENT_MISMATCH: 'Only the person named on the order can receive it. If they aren’t here, tap “Can’t hand over”.',
  SEAL_CHECK_REQUIRED: 'Check the seal and confirm it’s intact. If it’s broken, tap “Can’t hand over”.',
  PIN_REQUIRED: 'This order needs the customer’s delivery PIN.',
  CATERING_CHECKLIST: 'Count the items with the customer and tick the checklist first.',
  CATERING_SETUP: 'Finish the setup (tap “Setup done”) before completing the delivery.',
  TEMP_READING_REQUIRED: 'Log the temperature at the drop-off first.',
  SAFE_PLACE_NOT_ALLOWED: 'This order can’t be left unattended. Return it to the kitchen instead.',
  TRAINING_FAILED: 'Some answers aren’t right yet. Read the guide again and retry the highlighted questions.',
  CERT_REVOKED: 'This certification was revoked. Contact courier support.',
};

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export interface AgeCheckValue { dob: string; idType: string; idLast4: string }
/** True when the DOB is a real YYYY-MM-DD date. */
const validDob = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());

/** Date of birth + ID type + optional last 4, with the age worked out live. */
export function AgeCheckForm({ req, value, onChange }: { req: { minAge: number; idTypes: string[] }; value: AgeCheckValue; onChange: (v: AgeCheckValue) => void }) {
  const age = validDob(value.dob) ? ageOn(value.dob, todayLocal()) : null;
  return (
    <View style={{ marginTop: 6, padding: 8, borderRadius: 10, borderWidth: 1, borderColor: C.ink1 }}>
      <Text style={{ fontWeight: '700', color: C.ink }}>ID check ({req.minAge}+)</Text>
      <Muted>Check a valid photo ID in person. The date of birth isn’t stored, only the age.</Muted>
      <Input label="Date of birth on the ID (YYYY-MM-DD)" keyboardType="numbers-and-punctuation" maxLength={10} value={value.dob} onChangeText={(dob) => onChange({ ...value, dob })} />
      {age !== null && (age < 0 || age > 120 ? <Text style={{ color: C.bad }}>Check the date of birth</Text> : <Text style={{ color: age < req.minAge ? C.bad : C.good, fontWeight: '700' }}>Age {age}{age < req.minAge ? ` — under ${req.minAge}. Don’t hand over; tap “Can’t hand over”.` : ''}</Text>)}
      <Choice value={value.idType || undefined} onChange={(idType) => onChange({ ...value, idType })} options={req.idTypes.map((t) => ({ value: t, label: ID_TYPE_LABELS[t] || t }))} />
      <Input label="Last 4 of the ID number (optional)" autoCapitalize="characters" maxLength={4} value={value.idLast4} onChangeText={(idLast4) => onChange({ ...value, idLast4 })} />
    </View>
  );
}
export const ageCheckOk = (v: AgeCheckValue, minAge: number) => validDob(v.dob) && !!v.idType && ageOn(v.dob, todayLocal()) >= minAge && ageOn(v.dob, todayLocal()) <= 120;

/** Temperature reading for a temperature-controlled job. */
export function TemperaturePanel({ j }: { j: Job }) {
  const t = j.handoff?.tempControl;
  const { run, error, busy } = useAction();
  const [stage, setStage] = useState<'PICKUP' | 'DROPOFF'>(j.status === 'ASSIGNED' ? 'PICKUP' : 'DROPOFF');
  const [temp, setTemp] = useState('');
  const [temps, setTemps] = useState(j.special?.temps ?? []);
  const [breach, setBreach] = useState<{ kind: string; detail: string } | null>(j.special?.breach ?? null);
  const [note, setNote] = useState<string | null>(null);
  if (!t) return null;
  const n = Number(temp.replace(',', '.'));
  const ok = temp.trim() !== '' && Number.isFinite(n) && n >= -40 && n <= 100;
  return (
    <View style={{ marginTop: 8, padding: 10, backgroundColor: '#eff6ff', borderRadius: 10 }}>
      <Text style={{ fontWeight: '700', color: C.ink }}>Temperature</Text>
      <Muted>Keep it in a cold bag (max {t.coldMaxC} °C) and go straight there (max {t.maxTransitMinutes} min).{t.requireReadings ? ' A drop-off reading is required.' : ''}</Muted>
      {temps.map((x, i) => <Muted key={i}>{x.stage === 'PICKUP' ? 'Pickup' : 'Drop-off'}: {x.tempC} °C</Muted>)}
      <Choice value={stage} onChange={setStage} options={[{ value: 'PICKUP', label: 'At pickup' }, { value: 'DROPOFF', label: 'At drop-off' }]} />
      <Input label="Reading (°C)" keyboardType="numbers-and-punctuation" value={temp} onChangeText={setTemp} />
      <Button title="Log temperature" variant="secondary" disabled={busy || !ok} onPress={() => run(async () => {
        const r = await api.post<{ temps: { stage: 'PICKUP' | 'DROPOFF'; tempC: number; at: string }[]; breach: { kind: string; detail: string } | null; note?: string | null }>(`/driver/jobs/${j.id}/temperature`, { stage, tempC: n });
        setTemps(r.temps); setBreach(r.breach); setNote(r.note ?? null); setTemp('');
      })} />
      {breach && <Text style={{ color: C.warn, marginTop: 4 }}>{breach.detail}</Text>}
      {note && <Text style={{ color: C.info, marginTop: 2 }}>{note}</Text>}
      <ErrorText msg={error} />
    </View>
  );
}

type Checklist = { itemsCounted?: boolean; utensils?: boolean; labelsShown?: boolean; setupDone?: boolean };
interface CateringState { setupStartedAt?: string | null; setupDoneAt?: string | null; setupMinutes?: number; checklist?: Checklist; headcount?: number | null }

/** Catering checklist and setup timer (after pickup). Reports `itemsCounted` / `setupDone` up for the handoff button. */
export function CateringPanel({ j, onState }: { j: Job; onState: (c: CateringState) => void }) {
  const cat = j.handoff?.catering;
  const { run, error, busy } = useAction();
  const [c, setC] = useState<CateringState>((j.special?.catering as CateringState | null) ?? {});
  const [setupPay, setSetupPay] = useState<number | null>(null);
  if (!cat) return null;
  const cl = c.checklist ?? {};
  const save = (body: Record<string, unknown>) => run(async () => {
    const r = await api.post<{ catering: CateringState; setupPayCents: number }>(`/driver/jobs/${j.id}/catering`, body);
    setC(r.catering); setSetupPay(r.setupPayCents); onState(r.catering);
  });
  const tick = (k: 'itemsCounted' | 'utensils' | 'labelsShown', v: boolean) => save({ checklist: { [k]: v } });
  return (
    <View style={{ marginTop: 8, padding: 10, backgroundColor: '#f0fdf4', borderRadius: 10 }}>
      <Text style={{ fontWeight: '700', color: C.ink }}>Catering checklist{cat.headcount ? ` · ${cat.headcount} people` : ''}</Text>
      <Toggle on={!!cl.itemsCounted} onChange={(v) => void tick('itemsCounted', v)} title="Items counted with the customer" />
      <Toggle on={!!cl.utensils} onChange={(v) => void tick('utensils', v)} title="Utensils and serving tools handed over" />
      <Toggle on={!!cl.labelsShown} onChange={(v) => void tick('labelsShown', v)} title="Labels shown (allergens, dishes)" />
      {cat.setupRequired && (
        <View style={{ marginTop: 4 }}>
          <Text style={{ fontWeight: '600', color: C.ink }}>Setup requested</Text>
          {cl.setupDone ? <Text style={{ color: C.good }}>Setup done{c.setupMinutes != null ? ` · ${c.setupMinutes} min` : ''}{setupPay != null ? ` · setup pay ${money(setupPay)}` : ''}</Text>
            : c.setupStartedAt ? <><Muted>Setup started {new Date(c.setupStartedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You’re paid per minute of setup.</Muted><Button title="Setup done" disabled={busy} onPress={() => void save({ finishSetup: true })} /></>
            : <><Muted>Lay out the food, utensils and labels. You’re paid per minute of setup.</Muted><Button title="Start setup" variant="secondary" disabled={busy} onPress={() => void save({ startSetup: true })} /></>}
        </View>
      )}
      <ErrorText msg={error} />
    </View>
  );
}

/** “Can’t hand over”: pick a refusal reason; the order goes back to the kitchen. */
export function RefusePanel({ j, onDone }: { j: Job; onDone: (outcome: string) => void }) {
  const { run, error, busy } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RefusalReason | undefined>(undefined);
  const [note, setNote] = useState('');
  if (!open) return <Button title="Can’t hand over" variant="danger" onPress={() => setOpen(true)} />;
  return (
    <View style={{ marginTop: 6, padding: 10, backgroundColor: '#fef2f2', borderRadius: 10 }}>
      <Text style={{ fontWeight: '700', color: C.ink, marginBottom: 4 }}>Why can’t you hand it over?</Text>
      <Choice value={reason} onChange={setReason} options={REFUSAL_REASONS.map((r) => ({ value: r, label: REFUSAL_LABELS[r] }))} />
      <Input label="Note (optional)" multiline value={note} onChangeText={setNote} />
      <ErrorText msg={error} />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Button title="Confirm: return to kitchen" variant="danger" disabled={busy || !reason} onPress={() => run(async () => {
          const r = await api.post<{ outcome: string }>(`/driver/jobs/${j.id}/refuse-handoff`, { reason, note: note.trim() || undefined });
          // the job leaves the active list once refused, so the parent keeps the outcome on screen
          onDone(r.outcome || 'Don’t hand over the order. Take it back to the kitchen.');
        })} />
        <Button title="Cancel" variant="ghost" onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}
