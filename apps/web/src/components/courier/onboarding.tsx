'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  APPLICATION_STATUS_LABELS, COURIER_AGREEMENT_SUMMARY, COURIER_AGREEMENT_VERSION, COURIER_DOC_LABELS, ELIGIBILITY_LABELS, EQUIPMENT_ITEMS, EQUIPMENT_LABELS,
  MOTOR_VEHICLES, ONBOARDING_STEPS, REQUIRED_EQUIPMENT, SCREENING_CONSENT_VERSION, TRAINING_MODULES, VEHICLE_TYPES,
  type CourierDocKind, type EquipmentItem, type OnboardingStepKey,
} from '@gutad/shared';
import { api, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select, statusTone } from '@/components/ui';
import { CourierDocUpload } from '@/components/courier-docs';
import { applicationTone, checkTone, humanize, PhotoCapture, StoredPhoto, useCourierAction, type Onboarding, type UploadedPhoto } from './common';

const docLabel = (k: string) => COURIER_DOC_LABELS[k as CourierDocKind] || humanize(k);
const EDITABLE = ['DRAFT', 'NEEDS_ACTION'];

/** Courier sign-up: ten steps, then submit for verification. */
export function OnboardingWizard({ ob, reload }: { ob: Onboarding; reload: () => Promise<void> }) {
  const status = ob.driver?.applicationStatus || 'DRAFT';
  const editable = !ob.driver || EDITABLE.includes(status);
  const firstOpen = ob.steps.find((s) => s.needsAction) || ob.steps.find((s) => !s.done);
  const [active, setActive] = useState<OnboardingStepKey>(firstOpen?.key || 'location');
  const { run, error, busy } = useCourierAction();
  const [missing, setMissing] = useState<string[] | null>(null);
  const doneCount = ob.steps.filter((s) => s.done).length;
  const stepOf = (k: OnboardingStepKey) => ob.steps.find((s) => s.key === k);
  /** After a save: refresh, then move to the next unfinished step. */
  const saved = async () => {
    await reload();
    const idx = ONBOARDING_STEPS.findIndex((s) => s.key === active);
    const next = ONBOARDING_STEPS.slice(idx + 1).find((s) => !stepOf(s.key)?.done);
    if (next) setActive(next.key);
  };
  const submit = () => run(async () => {
    setMissing(null);
    try {
      await api.post('/driver/onboarding/submit', {});
    } catch (e) {
      const body = (e as { body?: { missing?: string[] } }).body;
      if (body?.missing) setMissing(body.missing);
      throw e;
    }
    await reload();
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Deliver with Gutad</h1>
        <p className="text-sm text-ink-500">Finish each step, then submit your application. You can come back any time; your progress is saved.</p>
      </div>
      {ob.driver && status !== 'DRAFT' && <ApplicationStatusCard ob={ob} />}
      {ob.availability && <Alert tone={ob.availability.serviceable && !ob.availability.waitlist ? 'info' : 'bad'}>{ob.availability.message}</Alert>}
      <div>
        <div className="mb-1 flex justify-between text-xs text-ink-500"><span>{doneCount} of {ONBOARDING_STEPS.length} steps done</span>{editable && <span>Step {ONBOARDING_STEPS.findIndex((s) => s.key === active) + 1}</span>}</div>
        <div className="h-2 overflow-hidden rounded-full bg-ink-100"><div className="h-full bg-brand-500 transition-all" style={{ width: `${(doneCount / ONBOARDING_STEPS.length) * 100}%` }} /></div>
      </div>
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <ol className="space-y-1">
          {ONBOARDING_STEPS.map((s, i) => {
            const st = stepOf(s.key);
            return (
              <li key={s.key}>
                <button disabled={!editable} onClick={() => setActive(s.key)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${active === s.key && editable ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-ink-50'} disabled:cursor-default`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${st?.needsAction ? 'bg-amber-100 text-amber-800' : st?.done ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-100 text-ink-500'}`}>{st?.needsAction ? '!' : st?.done ? '✓' : i + 1}</span>
                  <span className="min-w-0"><span className="block">{s.label}</span>{st?.needsAction && st.note && <span className="block text-xs font-normal text-amber-700">{st.note}</span>}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {editable ? (
          <Card title={ONBOARDING_STEPS.find((s) => s.key === active)?.label} action={stepOf(active)?.needsAction ? <Badge tone="warn">needs action</Badge> : stepOf(active)?.done ? <Badge tone="good">done</Badge> : null}>
            <p className="mb-3 text-sm text-ink-500">{ONBOARDING_STEPS.find((s) => s.key === active)?.help}</p>
            {stepOf(active)?.needsAction && stepOf(active)?.note && <div className="mb-3"><Alert tone="info">{stepOf(active)?.note}</Alert></div>}
            <StepForm step={active} ob={ob} onSaved={saved} />
          </Card>
        ) : (
          <Card title="Your application">
            <p className="text-sm text-ink-500">{status === 'REJECTED' ? 'Your application was not approved. The note above explains why.' : status === 'WAITLISTED' ? 'Your details are saved. We’ll reopen your application when there’s room in your city.' : 'We’re reviewing what you sent. If we need anything else, the step will be marked here and you can change it.'}</p>
          </Card>
        )}
      </div>
      {editable && (
        <Card title={status === 'NEEDS_ACTION' ? 'Send your changes' : 'Submit your application'}>
          {error && <div className="mb-2"><Alert>{error}</Alert></div>}
          {!ob.canSubmit && (ob.missing.length > 0 || missing?.length) ? (
            <div className="mb-2 text-sm"><p className="text-ink-500">Still to do:</p><ul className="list-disc pl-5">{(missing?.length ? missing : ob.missing).map((m) => <li key={m}>{ONBOARDING_STEPS.find((s) => s.key === m)?.label || docLabel(m)}</li>)}</ul></div>
          ) : <p className="mb-2 text-sm text-ink-500">Everything is filled in. We’ll verify your details and let you know.</p>}
          <Button disabled={!ob.canSubmit || busy} onClick={submit}>{busy ? 'Submitting…' : status === 'NEEDS_ACTION' ? 'Resubmit' : 'Submit application'}</Button>
        </Card>
      )}
    </div>
  );
}

/** After submitting: where the application stands and what (if anything) needs fixing. */
export function ApplicationStatusCard({ ob }: { ob: Onboarding }) {
  const d = ob.driver!;
  const fix = ob.steps.filter((s) => s.needsAction);
  return (
    <Card title="Application status" action={<Badge tone={applicationTone(d.applicationStatus)}>{APPLICATION_STATUS_LABELS[d.applicationStatus] || d.applicationStatus}</Badge>}>
      {d.submittedAt && <p className="text-xs text-ink-500">Submitted {when(d.submittedAt)}</p>}
      {d.decisionNote && <p className="mt-1 text-sm">{d.decisionNote}</p>}
      {d.applicationStatus === 'WAITLISTED' && <p className="mt-1 text-sm text-ink-700">Your city has enough couriers right now. We’ll let you know when a place opens.</p>}
      {ob.checks.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {ob.checks.map((c) => <li key={c.check} className="flex items-center justify-between gap-2"><span>{ELIGIBILITY_LABELS[c.check] || c.check}{c.note ? <span className="block text-xs text-ink-500">{c.note}</span> : null}</span><Badge tone={checkTone(c.status)}>{humanize(c.status)}</Badge></li>)}
        </ul>
      )}
      {d.applicationStatus === 'NEEDS_ACTION' && fix.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
          <p className="font-medium">To fix</p>
          <ul className="list-disc pl-5">{fix.map((s) => <li key={s.key}>{s.label}{s.note ? `: ${s.note}` : ''}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}

function StepForm({ step, ob, onSaved }: { step: OnboardingStepKey; ob: Onboarding; onSaved: () => Promise<void> }) {
  switch (step) {
    case 'location': return <LocationStep key={step} ob={ob} onSaved={onSaved} />;
    case 'account': return <AccountStep key={step} ob={ob} onSaved={onSaved} />;
    case 'profile': return <ProfileStep key={step} ob={ob} onSaved={onSaved} />;
    case 'identity': return <DocsStep key={step} ob={ob} kinds={['ID']} onSaved={onSaved} />;
    case 'vehicle': return <VehicleStep key={step} ob={ob} onSaved={onSaved} />;
    case 'screening': return <ScreeningStep key={step} ob={ob} onSaved={onSaved} />;
    case 'payout': return <PayoutStep key={step} ob={ob} onSaved={onSaved} />;
    case 'agreement': return <AgreementStep key={step} ob={ob} onSaved={onSaved} />;
    case 'training': return <TrainingStep key={step} ob={ob} onSaved={onSaved} />;
    case 'equipment': return <EquipmentStep key={step} ob={ob} onSaved={onSaved} />;
    default: return null;
  }
}

type StepProps = { ob: Onboarding; onSaved: () => Promise<void> };

function Saver({ label = 'Save and continue', disabled, busy, error, onClick }: { label?: string; disabled?: boolean; busy: boolean; error: string | null; onClick: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      {error && <Alert>{error}</Alert>}
      <Button disabled={disabled || busy} onClick={onClick}>{busy ? 'Saving…' : label}</Button>
    </div>
  );
}

function LocationStep({ ob, onSaved }: StepProps) {
  const l = ob.data.location || {};
  const [f, setF] = useState({ country: l.country || 'US', city: l.city || '', transport: l.transport || ob.driver?.vehicleType || 'BIKE' });
  const [zoneIds, setZoneIds] = useState<string[]>(l.zoneIds || []);
  const [cityQ, setCityQ] = useState(f.city);
  useEffect(() => { const t = setTimeout(() => setCityQ(f.city.trim()), 400); return () => clearTimeout(t); }, [f.city]);
  const zones = useApi<{ id: string; name: string; location: string }[]>(cityQ.length >= 2 ? `/driver/onboarding/zones?city=${encodeURIComponent(cityQ)}` : null);
  const offered = zones.data || [];
  const chosen = zoneIds.filter((z) => offered.some((o) => o.id === z));
  const { run, busy, error } = useCourierAction();
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <Input label="Country" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
        <Input label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <Select label="How you get around" value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value })}>{VEHICLE_TYPES.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}</Select>
      </div>
      {cityQ.length >= 2 && <div><p className="text-sm font-medium">Where you’d like to deliver</p>{offered.length ? <><p className="text-xs text-ink-500">Pick the areas you know. Leave all unticked to get offers anywhere in {cityQ}.</p><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{offered.map((z) => <label key={z.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={chosen.includes(z.id)} onChange={(e) => setZoneIds(e.target.checked ? [...chosen, z.id] : chosen.filter((x) => x !== z.id))} /> {z.name} <span className="text-xs text-ink-500">({z.location})</span></label>)}</div></> : <p className="text-xs text-ink-500">{zones.loading ? 'Looking up delivery areas…' : `No delivery areas are set up in ${cityQ} yet; you’ll get offers anywhere in the city.`}</p>}</div>}
      {MOTOR_VEHICLES.includes(f.transport) && <p className="text-xs text-ink-500">With a {humanize(f.transport)} you’ll also need a driving licence, insurance and vehicle registration.</p>}
      {ob.availability && <p className="text-sm text-ink-700">{ob.availability.message}</p>}
      <Saver busy={busy} error={error} disabled={f.country.length < 2 || f.city.length < 2 || zones.loading} onClick={() => run(async () => { await api.post('/driver/onboarding/location', { ...f, zoneIds: chosen }); await onSaved(); })} />
    </div>
  );
}

function AccountStep({ ob, onSaved }: StepProps) {
  const { data, reload } = useApi<{ email: string; emailVerifiedAt: string | null; emailCodeSent?: boolean }>('/auth/me');
  const [code, setCode] = useState('');
  const { run, busy, error } = useCourierAction();
  const [msg, setMsg] = useState<string | null>(null);
  const done = ob.steps.find((s) => s.key === 'account')?.done;
  if (!data) return null;
  if (data.emailVerifiedAt) return <div className="space-y-2"><Alert tone="good">{data.email} is confirmed.</Alert>{!done && <Button variant="secondary" onClick={() => void onSaved()}>Continue</Button>}</div>;
  return (
    <div className="space-y-2 text-sm">
      <p>Confirm <b>{data.email}</b>. We’ll email you a 6-digit code. You can also do this on your <Link className="underline" href="/account">account page</Link>.</p>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="info">{msg}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        {data.emailCodeSent && <><Input label="Code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /><Button size="sm" disabled={busy || code.length !== 6} onClick={() => run(async () => { await api.post('/auth/verify-email', { code }); await reload(); await onSaved(); })}>Confirm</Button></>}
        <Button size="sm" variant={data.emailCodeSent ? 'ghost' : 'primary'} disabled={busy} onClick={() => run(async () => { await api.post('/auth/verify-email/send', {}); setMsg(`Code sent to ${data.email}. Check spam too.`); await reload(); })}>{data.emailCodeSent ? 'Send a new code' : 'Email me a code'}</Button>
      </div>
    </div>
  );
}

function ProfileStep({ ob, onSaved }: StepProps) {
  const p = ob.data.profile || {};
  const [f, setF] = useState({ legalName: p.legalName || '', addressLine1: p.addressLine1 || '', city: p.city || ob.data.location?.city || '', postalCode: p.postalCode || '', phone: p.phone || '', languages: (p.languages || ['English']).join(', '), photoUrl: p.photoUrl || '' });
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const { run, busy, error } = useCourierAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const languages = f.languages.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Legal name (as on your ID)" value={f.legalName} onChange={set('legalName')} />
        <Input label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
        <Input label="Address" value={f.addressLine1} onChange={set('addressLine1')} />
        <Input label="City" value={f.city} onChange={set('city')} />
        <Input label="Postal code" value={f.postalCode} onChange={set('postalCode')} />
        <Input label="Languages you speak (comma separated)" value={f.languages} onChange={set('languages')} />
        <div className="sm:col-span-2"><p className="mb-1 text-sm font-medium">Profile photo (optional)</p>{f.photoUrl && !photo && <StoredPhoto url={f.photoUrl} alt="Current profile photo" />}<PhotoCapture purpose="PROFILE" label="Take or choose a photo" value={photo} onChange={(p) => { setPhoto(p); setF({ ...f, photoUrl: p?.url || '' }); }} /></div>
      </div>
      <Saver busy={busy} error={error} disabled={f.legalName.length < 2 || f.addressLine1.length < 3 || f.city.length < 2 || f.postalCode.length < 3 || f.phone.length < 6 || !languages.length}
        onClick={() => run(async () => { await api.post('/driver/onboarding/profile', { legalName: f.legalName, addressLine1: f.addressLine1, city: f.city, postalCode: f.postalCode, phone: f.phone, languages, photoUrl: f.photoUrl || undefined }); await onSaved(); })} />
    </div>
  );
}

/** Upload the documents in `kinds` that are not on file yet (rejected and expired ones can be replaced). */
function DocsStep({ ob, kinds, onSaved }: StepProps & { kinds: string[] }) {
  const latest = (k: string) => ob.documents.filter((d) => d.kind === k)[0];
  const outstanding = kinds.filter((k) => { const d = latest(k); return !d || ['REJECTED', 'EXPIRED'].includes(d.status); });
  return (
    <div className="space-y-2">
      <ul className="space-y-1 text-sm">
        {kinds.map((k) => { const d = latest(k); return <li key={k} className="flex items-center justify-between gap-2"><span>{docLabel(k)}{d?.reviewNote && d.status === 'REJECTED' ? <span className="block text-xs text-red-700">{d.reviewNote}</span> : null}{d?.expiresAt ? <span className="block text-xs text-ink-500">expires {when(d.expiresAt)}</span> : null}</span>{d ? <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge> : <Badge>needed</Badge>}</li>; })}
      </ul>
      {outstanding.length > 0 ? <CourierDocUpload kinds={outstanding} onDone={() => void onSaved()} /> : <p className="text-xs text-ink-500">All uploaded. We’ll review them after you submit.</p>}
    </div>
  );
}

function VehicleStep({ ob, onSaved }: StepProps) {
  const v = ob.data.vehicle || {};
  const transport = ob.data.location?.transport || ob.driver?.vehicleType || 'BIKE';
  const motor = MOTOR_VEHICLES.includes(transport);
  const [f, setF] = useState({ make: v.make || '', model: v.model || '', plate: v.plate || '', color: v.color || '', year: v.year ? String(v.year) : '' });
  const { run, busy, error } = useCourierAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const docs = ob.requiredDocs.filter((k) => k !== 'ID');
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm">You deliver by <b>{humanize(transport)}</b>{motor ? '. Make, model and plate are required.' : '. Vehicle details are optional.'}</p>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input label="Make" value={f.make} onChange={set('make')} />
          <Input label="Model" value={f.model} onChange={set('model')} />
          <Input label="Plate" value={f.plate} onChange={set('plate')} />
          <Input label="Color" value={f.color} onChange={set('color')} />
          <Input label="Year" inputMode="numeric" value={f.year} onChange={set('year')} />
        </div>
        <Saver label="Save vehicle" busy={busy} error={error} disabled={motor && (!f.make || !f.model || !f.plate)}
          onClick={() => run(async () => { await api.post('/driver/onboarding/vehicle', { make: f.make || undefined, model: f.model || undefined, plate: f.plate || undefined, color: f.color || undefined, year: f.year ? Number(f.year) : undefined }); await onSaved(); })} />
      </div>
      {docs.length > 0 && <div><h4 className="mb-1 text-sm font-semibold">Documents for your vehicle</h4><DocsStep ob={ob} kinds={docs} onSaved={onSaved} /></div>}
    </div>
  );
}

function ScreeningStep({ ob, onSaved }: StepProps) {
  const s = ob.data.screening;
  const [ok, setOk] = useState(false);
  const { run, busy, error } = useCourierAction();
  if (s && s.consentVersion === SCREENING_CONSENT_VERSION) return <Alert tone="good">You consented on {when(s.consentedAt)}. The check runs after you submit.</Alert>;
  return (
    <div className="space-y-2 text-sm">
      <p>We run a background check through a screening partner before you can deliver. It covers identity and relevant records where the law allows. You’ll be told the result and can dispute it.</p>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I consent to a background check for delivering with Gutad.</label>
      <Saver label="Give consent" busy={busy} error={error} disabled={!ok} onClick={() => run(async () => { await api.post('/driver/onboarding/screening', { consent: true, consentVersion: SCREENING_CONSENT_VERSION }); await onSaved(); })} />
    </div>
  );
}

function PayoutStep({ ob, onSaved }: StepProps) {
  const cur = ob.data.payout;
  const [f, setF] = useState({ accountHolder: '', accountLast4: '', taxFormAccepted: false, password: '' });
  const [changing, setChanging] = useState(!cur);
  const { run, busy, error } = useCourierAction();
  if (!changing && cur) return (
    <div className="space-y-2 text-sm">
      <p>Payouts go to the account ending <b>{cur.accountLast4}</b> ({humanize(cur.method)}).{cur.taxFormAcceptedAt ? ` Tax details confirmed ${when(cur.taxFormAcceptedAt)}.` : ''}</p>
      <Button size="sm" variant="secondary" onClick={() => setChanging(true)}>Change payout account</Button>
    </div>
  );
  return (
    <div className="space-y-2 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input label="Account holder" value={f.accountHolder} onChange={(e) => setF({ ...f, accountHolder: e.target.value })} />
        <Input label="Last 4 digits of the account" inputMode="numeric" maxLength={4} value={f.accountLast4} onChange={(e) => setF({ ...f, accountLast4: e.target.value.replace(/\D/g, '') })} />
        {cur && <Input label="Your Gutad password (to change the account)" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}
      </div>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.taxFormAccepted} onChange={(e) => setF({ ...f, taxFormAccepted: e.target.checked })} /> My tax details are correct and I’m responsible for taxes on my earnings as an independent contractor.</label>
      <div className="flex gap-2">
        <Saver busy={busy} error={error} disabled={f.accountHolder.length < 2 || f.accountLast4.length !== 4 || !f.taxFormAccepted || (!!cur && !f.password)}
          onClick={() => run(async () => { await api.post('/driver/onboarding/payout', { accountHolder: f.accountHolder, accountLast4: f.accountLast4, taxFormAccepted: true, password: cur ? f.password : undefined }); setChanging(false); await onSaved(); })} />
        {cur && <Button className="mt-3" variant="ghost" onClick={() => setChanging(false)}>Cancel</Button>}
      </div>
    </div>
  );
}

function AgreementStep({ ob, onSaved }: StepProps) {
  const a = ob.data.agreement;
  const [ok, setOk] = useState(false);
  const { run, busy, error } = useCourierAction();
  return (
    <div className="space-y-2 text-sm">
      <ul className="list-disc space-y-1 pl-5">{COURIER_AGREEMENT_SUMMARY.map((x) => <li key={x}>{x}</li>)}</ul>
      <p className="text-xs text-ink-500">Agreement version {COURIER_AGREEMENT_VERSION}. See also the <Link className="underline" href="/privacy">Privacy Policy</Link>.</p>
      {a && a.version === COURIER_AGREEMENT_VERSION ? <Alert tone="good">You accepted this agreement on {when(a.acceptedAt)}.</Alert> : (
        <>
          {a && <Alert tone="info">The agreement has changed since you accepted it. Please read and accept the new version.</Alert>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I have read and accept the Gutad courier agreement and policies.</label>
          <Saver label="Accept" busy={busy} error={error} disabled={!ok} onClick={() => run(async () => { await api.post('/driver/onboarding/agreement', { version: COURIER_AGREEMENT_VERSION, accept: true }); await onSaved(); })} />
        </>
      )}
    </div>
  );
}

function TrainingStep({ ob, onSaved }: StepProps) {
  const done = ob.data.training || {};
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">{TRAINING_MODULES.filter((m) => done[m.key]).length} of {TRAINING_MODULES.length} modules complete</p>
      {TRAINING_MODULES.map((m) => <TrainingModule key={m.key} module={m} completedAt={done[m.key]} onSaved={onSaved} />)}
    </div>
  );
}

function TrainingModule({ module: m, completedAt, onSaved }: { module: (typeof TRAINING_MODULES)[number]; completedAt?: string; onSaved: () => Promise<void> }) {
  const [answer, setAnswer] = useState<number | null>(null);
  const { run, busy, error } = useCourierAction();
  return (
    <div className="rounded-xl border border-ink-100 p-3 text-sm">
      <div className="flex items-center justify-between"><h4 className="font-semibold">{m.title}</h4>{completedAt && <Badge tone="good">done</Badge>}</div>
      <p className="mt-1 text-ink-700">{m.body}</p>
      {!completedAt && (
        <fieldset className="mt-2 space-y-1">
          <legend className="font-medium">{m.question}</legend>
          {m.options.map((o, i) => <label key={o} className="flex items-center gap-2"><input type="radio" name={`q-${m.key}`} checked={answer === i} onChange={() => setAnswer(i)} /> {o}</label>)}
          {error && <Alert>{error}</Alert>}
          <Button size="sm" disabled={answer === null || busy} onClick={() => run(async () => { await api.post('/driver/onboarding/training', { module: m.key, answer }); await onSaved(); })}>Check answer</Button>
        </fieldset>
      )}
    </div>
  );
}

function EquipmentStep({ ob, onSaved }: StepProps) {
  const e0 = ob.data.equipment;
  const [items, setItems] = useState<EquipmentItem[]>(e0?.items || []);
  const [photoUrl, setPhotoUrl] = useState(e0?.photoUrl || '');
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const { run, busy, error } = useCourierAction();
  const missingRequired = REQUIRED_EQUIPMENT.filter((r) => !items.includes(r));
  return (
    <div className="space-y-2 text-sm">
      <p>Tick what you have:</p>
      {EQUIPMENT_ITEMS.map((k) => <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={items.includes(k)} onChange={(e) => setItems(e.target.checked ? [...items, k] : items.filter((x) => x !== k))} /> {EQUIPMENT_LABELS[k]}{REQUIRED_EQUIPMENT.includes(k) && <Badge tone="warn">required</Badge>}</label>)}
      <div><p className="mb-1 text-sm font-medium">Photo of your gear (optional)</p>{photoUrl && !photo && <StoredPhoto url={photoUrl} alt="Your gear" />}<PhotoCapture purpose="EQUIPMENT" label="Take or choose a photo" value={photo} onChange={(p) => { setPhoto(p); setPhotoUrl(p?.url || ''); }} /></div>
      {missingRequired.length > 0 && <p className="text-xs text-amber-700">You need: {missingRequired.map((r) => EQUIPMENT_LABELS[r]).join(', ')}.</p>}
      <Saver label="Save equipment" busy={busy} error={error} disabled={missingRequired.length > 0} onClick={() => run(async () => { await api.post('/driver/onboarding/equipment', { items, photoUrl: photoUrl || undefined }); await onSaved(); })} />
    </div>
  );
}
