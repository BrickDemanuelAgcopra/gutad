import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import {
  APPLICATION_STATUS_LABELS, COURIER_AGREEMENT_SUMMARY, COURIER_AGREEMENT_VERSION, COURIER_DOC_LABELS, ELIGIBILITY_LABELS, EQUIPMENT_ITEMS, EQUIPMENT_LABELS, MOTOR_VEHICLES,
  ONBOARDING_STEPS, REQUIRED_EQUIPMENT, SCREENING_CONSENT_VERSION, TRAINING_MODULES, VEHICLE_TYPES,
  type ApplicationStatus, type CourierDocKind, type EquipmentItem, type OnboardingStepKey,
} from '@gutad/shared';
import { api, when } from '../api';
import { useAction } from '../hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s } from '../ui';
import { Chips, Choice, pickImage, Toggle } from '../chef-ui';
import { mimeFor, pickFileOnWeb, uploadMultipart, type PickedFile } from '../upload';
import { checkTone, errBody, errCode, label, type Onboarding } from './common';

const docLabel = (k: string) => COURIER_DOC_LABELS[k as CourierDocKind] || label(k);
const TRANSPORT: Record<string, string> = { BIKE: 'Bike', EBIKE: 'E-bike', SCOOTER: 'Scooter / moped', CAR: 'Car', VAN: 'Van', WALK: 'On foot' };

/** The 10-step courier application, then its status while Gutad verifies it. */
export function CourierOnboarding({ ob, onChange }: { ob: Onboarding; onChange: (o?: Onboarding) => void }) {
  const [open, setOpen] = useState<OnboardingStepKey | null>(null);
  const { run, error, busy } = useAction();
  const [missing, setMissing] = useState<string[] | null>(null);
  const st = (ob.driver?.applicationStatus || 'DRAFT') as ApplicationStatus;
  const editable = st === 'DRAFT' || st === 'NEEDS_ACTION';
  const stepsNeedingAction = ob.steps.filter((x) => x.needsAction);
  const showSteps = editable || stepsNeedingAction.length > 0;
  const done = ob.steps.filter((x) => x.done).length;
  const submit = () => run(async () => {
    setMissing(null);
    try { onChange(await api.post<Onboarding>('/driver/onboarding/submit', {})); }
    catch (e) { if (errCode(e) === 'ONBOARDING_INCOMPLETE') { setMissing(errBody<{ missing?: string[] }>(e)?.missing || ob.missing); return; } throw e; }
  });
  return (
    <>
      {ob.driver && st !== 'DRAFT' && <ApplicationStatusCard ob={ob} />}
      {showSteps && (
        <Card title={ob.driver ? 'Your application' : 'Deliver with Gutad'}>
          <Muted>{done} of {ob.steps.length} steps done. Tap a step to fill it in.</Muted>
          {ob.availability && <Text style={{ color: ob.availability.serviceable && !ob.availability.waitlist ? C.good : C.warn, marginTop: 4 }}>{ob.availability.message}</Text>}
          <View style={{ marginTop: 8 }}>
            {ONBOARDING_STEPS.map((def, i) => {
              const step = ob.steps.find((x) => x.key === def.key);
              const locked = !ob.driver && def.key !== 'location';
              return (
                <View key={def.key} style={{ borderTopWidth: i ? 1 : 0, borderColor: C.ink1 }}>
                  <Pressable disabled={locked} onPress={() => setOpen(open === def.key ? null : def.key)} style={{ paddingVertical: 10, opacity: locked ? 0.5 : 1 }}>
                    <View style={s.row}>
                      <Text style={{ fontWeight: '600', color: C.ink, flex: 1 }}>{i + 1}. {step?.label || def.label}</Text>
                      {step?.needsAction ? <Badge text="Needs action" tone="bad" /> : step?.done ? <Badge text="Done" tone="good" /> : <Badge text="To do" />}
                    </View>
                    <Muted>{step?.note || def.help}</Muted>
                  </Pressable>
                  {open === def.key && <View style={{ paddingBottom: 10 }}><StepForm step={def.key} ob={ob} onSaved={(o) => { onChange(o); }} /></View>}
                </View>
              );
            })}
          </View>
        </Card>
      )}
      {editable && ob.driver && (
        <Card title="Submit your application">
          {ob.canSubmit ? <Muted>Everything is in. We’ll verify your details and let you know.</Muted> : <><Muted>Still needed:</Muted>{ob.missing.map((m) => <Text key={m} style={{ color: C.warn }}>• {m}</Text>)}</>}
          {missing && missing.length > 0 && <><Text style={{ color: C.bad, marginTop: 4 }}>We couldn’t submit yet:</Text>{missing.map((m) => <Text key={m} style={{ color: C.bad }}>• {m}</Text>)}</>}
          <ErrorText msg={error} />
          <Button title={busy ? 'Submitting…' : 'Submit application'} disabled={!ob.canSubmit || busy} onPress={submit} />
        </Card>
      )}
    </>
  );
}

function ApplicationStatusCard({ ob }: { ob: Onboarding }) {
  const d = ob.driver!;
  const st = d.applicationStatus as ApplicationStatus;
  const t = st === 'APPROVED' ? 'good' : st === 'REJECTED' ? 'bad' : st === 'NEEDS_ACTION' ? 'bad' : 'warn';
  return (
    <Card title="Application status">
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={APPLICATION_STATUS_LABELS[st] || st} tone={t} />{d.submittedAt && <Muted>Submitted {when(d.submittedAt)}</Muted>}</View>
      {d.decisionNote && <Text style={{ marginTop: 6, color: C.ink7 }}>{d.decisionNote}</Text>}
      {st === 'WAITLISTED' && <Muted>We’re not taking new couriers in your area right now. We’ll let you know when a spot opens.</Muted>}
      {(st === 'SUBMITTED' || st === 'VERIFICATION_PENDING') && <Muted>We’re checking your details. This usually takes a few days.</Muted>}
      <View style={{ marginTop: 8, gap: 4 }}>
        {ob.checks.map((c) => (
          <View key={c.check} style={s.row}>
            <Text style={{ color: C.ink, flex: 1 }}>{ELIGIBILITY_LABELS[c.check] || c.check}</Text>
            <Badge text={label(c.status)} tone={checkTone(c.status)} />
          </View>
        ))}
        {ob.checks.filter((c) => c.note).map((c) => <Muted key={`n${c.check}`}>{ELIGIBILITY_LABELS[c.check]}: {c.note}</Muted>)}
      </View>
    </Card>
  );
}

function StepForm({ step, ob, onSaved }: { step: OnboardingStepKey; ob: Onboarding; onSaved: (o: Onboarding) => void }) {
  const { run, error, busy } = useAction();
  const post = (path: string, body: unknown) => run(async () => onSaved(await api.post<Onboarding>(`/driver/onboarding/${path}`, body)));
  switch (step) {
    case 'location': return <LocationStep ob={ob} post={post} error={error} busy={busy} />;
    case 'account': return <AccountStep ob={ob} onSaved={onSaved} />;
    case 'profile': return <ProfileStep ob={ob} post={post} error={error} busy={busy} />;
    case 'identity': return <View><Muted>Upload a clear photo or scan of your passport, national ID card or driving licence.</Muted><DocUpload kind="ID" ob={ob} onDone={onSaved} /></View>;
    case 'vehicle': return <VehicleStep ob={ob} post={post} error={error} busy={busy} onSaved={onSaved} />;
    case 'screening': return <ScreeningStep ob={ob} post={post} error={error} busy={busy} />;
    case 'payout': return <PayoutStep ob={ob} post={post} error={error} busy={busy} />;
    case 'agreement': return <AgreementStep ob={ob} post={post} error={error} busy={busy} />;
    case 'training': return <TrainingStep ob={ob} onSaved={onSaved} />;
    case 'equipment': return <EquipmentStep ob={ob} post={post} error={error} busy={busy} />;
    default: return null;
  }
}

type StepProps = { ob: Onboarding; post: (path: string, body: unknown) => Promise<unknown>; error: string | null; busy: boolean };

function LocationStep({ ob, post, error, busy }: StepProps) {
  const l = ob.data.location || {};
  const [country, setCountry] = useState(l.country || 'US');
  const [city, setCity] = useState(l.city || '');
  const [transport, setTransport] = useState<string>(l.transport || ob.driver?.vehicleType || 'BIKE');
  return (
    <View>
      <Input label="Country" value={country} onChangeText={setCountry} autoCapitalize="characters" />
      <Input label="City" value={city} onChangeText={setCity} />
      <Text style={s.label}>How you’ll get around</Text>
      <Choice value={transport} onChange={setTransport} options={VEHICLE_TYPES.map((v) => ({ value: v, label: TRANSPORT[v] || label(v), description: MOTOR_VEHICLES.includes(v) ? 'Needs a licence, insurance and registration' : undefined }))} />
      {ob.availability && <Text style={{ color: ob.availability.serviceable && !ob.availability.waitlist ? C.good : C.warn, marginBottom: 4 }}>{ob.availability.message}</Text>}
      <ErrorText msg={error} />
      <Button title={busy ? 'Saving…' : 'Save'} disabled={busy || country.trim().length < 2 || city.trim().length < 2} onPress={() => post('location', { country: country.trim(), city: city.trim(), transport })} />
    </View>
  );
}

function AccountStep({ ob, onSaved }: { ob: Onboarding; onSaved: (o: Onboarding) => void }) {
  const step = ob.steps.find((x) => x.key === 'account');
  const { run, error, busy } = useAction();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  if (step?.done) return <Text style={{ color: C.good }}>Your email is verified.</Text>;
  return (
    <View>
      <Muted>We’ll email you a 6-digit code.</Muted>
      <Button title={sent ? 'Send a new code' : 'Send code'} variant="secondary" disabled={busy} onPress={() => run(async () => { await api.post('/auth/verify-email/send', {}); setSent(true); })} />
      {sent && <Muted>We sent a code. Check your inbox.</Muted>}
      <Input label="Code" keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
      <ErrorText msg={error} />
      <Button title="Verify" disabled={busy || !/^\d{6}$/.test(code)} onPress={() => run(async () => { await api.post('/auth/verify-email', { code }); onSaved(await api.get<Onboarding>('/driver/onboarding')); })} />
    </View>
  );
}

function ProfileStep({ ob, post, error, busy }: StepProps) {
  const p = ob.data.profile || {};
  const [f, setF] = useState({ legalName: p.legalName || '', addressLine1: p.addressLine1 || '', city: p.city || ob.data.location?.city || '', postalCode: p.postalCode || '', phone: p.phone || '', languages: (p.languages || ['English']).join(', '), photoUrl: p.photoUrl || '' });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const ok = f.legalName.trim().length > 2 && f.addressLine1.trim().length > 2 && f.city.trim() && f.postalCode.trim() && f.phone.trim().length > 5 && f.languages.trim();
  return (
    <View>
      <Input label="Legal name (as on your ID)" value={f.legalName} onChangeText={set('legalName')} />
      <Input label="Address" value={f.addressLine1} onChangeText={set('addressLine1')} />
      <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="City" value={f.city} onChangeText={set('city')} /></View><View style={{ flex: 1 }}><Input label="Postal code" value={f.postalCode} onChangeText={set('postalCode')} /></View></View>
      <Input label="Phone" keyboardType="phone-pad" value={f.phone} onChangeText={set('phone')} />
      <Input label="Languages you speak (comma separated)" value={f.languages} onChangeText={set('languages')} />
      <Input label="Profile photo link (optional)" autoCapitalize="none" value={f.photoUrl} onChangeText={set('photoUrl')} />
      <ErrorText msg={error} />
      <Button title={busy ? 'Saving…' : 'Save'} disabled={busy || !ok} onPress={() => post('profile', { legalName: f.legalName.trim(), addressLine1: f.addressLine1.trim(), city: f.city.trim(), postalCode: f.postalCode.trim(), phone: f.phone.trim(), languages: f.languages.split(',').map((x) => x.trim()).filter(Boolean), photoUrl: f.photoUrl.trim() || undefined })} />
    </View>
  );
}

function VehicleStep({ ob, post, error, busy, onSaved }: StepProps & { onSaved: (o: Onboarding) => void }) {
  const v = ob.data.vehicle || {};
  const transport = ob.data.location?.transport || ob.driver?.vehicleType || 'BIKE';
  const motor = MOTOR_VEHICLES.includes(transport);
  const [f, setF] = useState({ make: v.make || '', model: v.model || '', plate: v.plate || '', color: v.color || '', year: v.year ? String(v.year) : '' });
  const set = (k: keyof typeof f) => (x: string) => setF({ ...f, [k]: x });
  const ok = !motor || (f.make.trim() && f.model.trim() && f.plate.trim());
  const docs = ob.requiredDocs.filter((k) => k !== 'ID');
  return (
    <View>
      <Muted>{TRANSPORT[transport] || label(transport)}{motor ? ': make, model and plate are required.' : ': details are optional.'}</Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="Make" value={f.make} onChangeText={set('make')} /></View><View style={{ flex: 1 }}><Input label="Model" value={f.model} onChangeText={set('model')} /></View></View>
      <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="Plate" autoCapitalize="characters" value={f.plate} onChangeText={set('plate')} /></View><View style={{ flex: 1 }}><Input label="Colour" value={f.color} onChangeText={set('color')} /></View><View style={{ flex: 1 }}><Input label="Year" keyboardType="number-pad" value={f.year} onChangeText={set('year')} /></View></View>
      <ErrorText msg={error} />
      <Button title={busy ? 'Saving…' : 'Save vehicle'} disabled={busy || !ok} onPress={() => post('vehicle', { make: f.make.trim() || undefined, model: f.model.trim() || undefined, plate: f.plate.trim() || undefined, color: f.color.trim() || undefined, year: f.year ? Number(f.year) : undefined })} />
      {docs.length > 0 && <Text style={[s.label, { marginTop: 10 }]}>Documents for your vehicle</Text>}
      {docs.map((k) => <View key={k} style={{ marginTop: 6 }}><Text style={{ fontWeight: '600', color: C.ink }}>{docLabel(k)}</Text><DocUpload kind={k} ob={ob} onDone={onSaved} expiry /></View>)}
    </View>
  );
}

/** Upload one courier document (camera, photo library, web file chooser, or a link) and show its review status. */
function DocUpload({ kind, ob, onDone, expiry }: { kind: string; ob: Onboarding; onDone: (o: Onboarding) => void; expiry?: boolean }) {
  const { run, error, busy } = useAction();
  const [url, setUrl] = useState('');
  const [exp, setExp] = useState('');
  const latest = ob.documents.filter((d) => d.kind === kind)[0];
  const expiresAt = exp && /^\d{4}-\d{2}-\d{2}$/.test(exp) ? new Date(`${exp}T23:59:00Z`).toISOString() : undefined;
  const upload = async (file: PickedFile | null) => {
    if (!file) return;
    await uploadMultipart('/driver/documents/upload', file, { kind, expiresAt });
    setExp('');
    onDone(await api.get<Onboarding>('/driver/onboarding'));
  };
  return (
    <View>
      {latest && <View style={[s.row, { marginVertical: 4 }]}><Muted>Uploaded{latest.expiresAt ? ` · expires ${new Date(latest.expiresAt).toLocaleDateString()}` : ''}</Muted><Badge text={label(latest.status)} tone={latest.status === 'APPROVED' ? 'good' : latest.status === 'PENDING' ? 'warn' : 'bad'} /></View>}
      {latest?.reviewNote && <Text style={{ color: C.bad, fontSize: 13 }}>{latest.reviewNote}</Text>}
      {expiry && <Input label="Expiry date (YYYY-MM-DD)" value={exp} onChangeText={setExp} />}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {Platform.OS !== 'web' && <Button title="Take photo" variant="secondary" disabled={busy} onPress={() => run(async () => upload(await pickImage('camera')))} />}
        <Button title={busy ? 'Uploading…' : Platform.OS === 'web' ? 'Choose file' : 'From photos'} variant="secondary" disabled={busy} onPress={() => run(async () => upload(Platform.OS === 'web' ? await pickFileOnWeb() : await pickImage('library')))} />
      </View>
      <Input label="…or a link to the file" autoCapitalize="none" value={url} onChangeText={setUrl} />
      {url.length > 7 && <Button title="Send link" disabled={busy} onPress={() => run(async () => { if (url.startsWith('file:') || url.startsWith('content:')) await upload({ uri: url, name: url.split('/').pop() || 'document.jpg', type: mimeFor(url) }); else { await api.post('/driver/documents', { kind, fileUrl: url, expiresAt }); onDone(await api.get<Onboarding>('/driver/onboarding')); } setUrl(''); })} />}
      <ErrorText msg={error} />
    </View>
  );
}

function ScreeningStep({ ob, post, error, busy }: StepProps) {
  const [on, setOn] = useState(!!ob.data.screening);
  if (ob.data.screening) return <Text style={{ color: C.good }}>You consented on {when(ob.data.screening.consentedAt)}.</Text>;
  return (
    <View>
      <Muted>A screening partner checks your identity and relevant records. You’ll get a copy of the report and can dispute anything wrong.</Muted>
      <Toggle on={on} onChange={setOn} title="I consent to a background check" text={`Consent version ${SCREENING_CONSENT_VERSION}`} />
      <ErrorText msg={error} />
      <Button title="Save" disabled={busy || !on} onPress={() => post('screening', { consent: true, consentVersion: SCREENING_CONSENT_VERSION })} />
    </View>
  );
}

function PayoutStep({ ob, post, error, busy }: StepProps) {
  const cur = ob.data.payout;
  const [holder, setHolder] = useState('');
  const [last4, setLast4] = useState('');
  const [tax, setTax] = useState(!!cur?.taxFormAcceptedAt);
  const [password, setPassword] = useState('');
  return (
    <View>
      {cur && <Text style={{ color: C.good, marginBottom: 6 }}>Payouts go to the account ending {cur.accountLast4}. To change it, enter the new details and your password.</Text>}
      <Input label="Account holder name" value={holder} onChangeText={setHolder} />
      <Input label="Last 4 digits of the account" keyboardType="number-pad" maxLength={4} value={last4} onChangeText={setLast4} />
      <Toggle on={tax} onChange={setTax} title="My tax details are correct" text="I confirm the tax form for independent couriers." />
      {cur && <Input label="Your password" secureTextEntry value={password} onChangeText={setPassword} />}
      <ErrorText msg={error} />
      <Button title={busy ? 'Saving…' : cur ? 'Change payout account' : 'Save'} disabled={busy || holder.trim().length < 2 || !/^\d{4}$/.test(last4) || !tax || (!!cur && !password)} onPress={() => post('payout', { accountHolder: holder.trim(), accountLast4: last4, taxFormAccepted: true, password: cur ? password : undefined })} />
    </View>
  );
}

function AgreementStep({ ob, post, error, busy }: StepProps) {
  const [on, setOn] = useState(false);
  const accepted = ob.data.agreement?.version === COURIER_AGREEMENT_VERSION;
  return (
    <View>
      {COURIER_AGREEMENT_SUMMARY.map((l) => <Text key={l} style={{ color: C.ink7, marginBottom: 4 }}>• {l}</Text>)}
      {accepted ? <Text style={{ color: C.good, marginTop: 4 }}>You accepted this on {when(ob.data.agreement!.acceptedAt)}.</Text> : (
        <>
          <Toggle on={on} onChange={setOn} title="I accept the Gutad courier agreement" text="Including the Terms and Privacy Policy." />
          <ErrorText msg={error} />
          <Button title="Accept" disabled={busy || !on} onPress={() => post('agreement', { version: COURIER_AGREEMENT_VERSION, accept: true })} />
        </>
      )}
    </View>
  );
}

function TrainingStep({ ob, onSaved }: { ob: Onboarding; onSaved: (o: Onboarding) => void }) {
  const done = ob.data.training || {};
  const [open, setOpen] = useState<string | null>(TRAINING_MODULES.find((m) => !done[m.key])?.key || null);
  const [answer, setAnswer] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const { run, busy, error } = useAction();
  return (
    <View>
      {TRAINING_MODULES.map((m) => (
        <View key={m.key} style={{ marginBottom: 6 }}>
          <Pressable onPress={() => setOpen(open === m.key ? null : m.key)} style={s.row}><Text style={{ fontWeight: '600', color: C.ink, flex: 1, paddingVertical: 6 }}>{m.title}</Text>{done[m.key] ? <Badge text="Done" tone="good" /> : <Badge text="To do" />}</Pressable>
          {open === m.key && (
            <View>
              <Text style={{ color: C.ink7, marginBottom: 6 }}>{m.body}</Text>
              <Text style={{ fontWeight: '600', color: C.ink, marginBottom: 4 }}>{m.question}</Text>
              <Choice value={answer[m.key] === undefined ? undefined : String(answer[m.key])} onChange={(v) => { setAnswer({ ...answer, [m.key]: Number(v) }); setMsg({ ...msg, [m.key]: '' }); }} options={m.options.map((o, i) => ({ value: String(i), label: o }))} />
              {!!msg[m.key] && <Text style={{ color: C.bad, marginBottom: 4 }}>{msg[m.key]}</Text>}
              {!done[m.key] && <Button title="Check answer" disabled={busy || answer[m.key] === undefined} onPress={() => run(async () => {
                try {
                  const o = await api.post<Onboarding>('/driver/onboarding/training', { module: m.key, answer: answer[m.key] });
                  onSaved(o);
                  setOpen(TRAINING_MODULES.find((x) => !(o.data.training || {})[x.key])?.key || null);
                } catch (e) { if (errCode(e) === 'WRONG_ANSWER') { setMsg({ ...msg, [m.key]: 'Not quite. Read it again and try another answer.' }); return; } throw e; }
              })} />}
            </View>
          )}
        </View>
      ))}
      <ErrorText msg={error} />
    </View>
  );
}

function EquipmentStep({ ob, post, error, busy }: StepProps) {
  const [items, setItems] = useState<EquipmentItem[]>(ob.data.equipment?.items || []);
  const [photoUrl, setPhotoUrl] = useState(ob.data.equipment?.photoUrl || '');
  const missingReq = REQUIRED_EQUIPMENT.filter((r) => !items.includes(r));
  return (
    <View>
      <Muted>Tick what you have. {REQUIRED_EQUIPMENT.map((r) => EQUIPMENT_LABELS[r]).join(', ')} is required.</Muted>
      <Chips values={items} onChange={setItems} options={EQUIPMENT_ITEMS.map((k) => ({ value: k, label: EQUIPMENT_LABELS[k] }))} />
      <Input label="Photo of your bag (link, optional)" autoCapitalize="none" value={photoUrl} onChangeText={setPhotoUrl} />
      {missingReq.length > 0 && <Text style={{ color: C.warn }}>You need an {EQUIPMENT_LABELS[missingReq[0]].toLowerCase()} to deliver food.</Text>}
      <ErrorText msg={error} />
      <Button title="Save" disabled={busy || missingReq.length > 0} onPress={() => post('equipment', { items, photoUrl: photoUrl.trim() || undefined })} />
    </View>
  );
}
