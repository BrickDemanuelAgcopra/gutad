'use client';
import { useState } from 'react';
import { ageOn, CERTIFICATION_STATUS_LABELS, ID_TYPE_LABELS, REFUSAL_LABELS, REFUSAL_REASONS, SPECIAL_CATEGORY_LABELS, type CertificationStatus, type HandoffRequirements, type RefusalReason, type SpecialCategory } from '@gutad/shared';
import { api, money, when } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';
import { errCode, PhotoCapture, useCourierAction, type UploadedPhoto } from './common';

// Courier Release 4 (courier side): category certifications, category badges and premium, and the extra handoff
// steps — age check, named recipient and seal, temperature readings, catering checklist and setup, refusing a handoff.

export interface SpecialPremium { category: SpecialCategory; label: string; cents: number }
export interface JobSpecial { temps: { stage: string; tempC: number; at: string }[]; breach: { kind: string; detail: string } | null; catering: { setupStartedAt?: string | null; setupDoneAt?: string | null; setupMinutes?: number; checklist?: { itemsCounted?: boolean; utensils?: boolean; labelsShown?: boolean; setupDone?: boolean } } | null; refusal: { reason: string } | null }

interface Cert {
  id: string | null; category: SpecialCategory; label: string; status: CertificationStatus; expiresAt: string | null; note: string | null; trainingPassedAt: string | null; certificateUploaded: boolean; premiumCents: number;
  needs: string[]; training: { title: string; body: string; questions: { q: string; options: string[] }[] };
}
interface CertView { certifications: Cert[]; highValue: { eligible: boolean; reason: string | null; deliveries: number; minDeliveries: number; thresholdCents: number } }

const NEED_TEXT: Record<string, string> = {
  TRAINING: 'Complete the short training below',
  CERTIFICATE: 'Upload your responsible-service certificate',
  SCREENING: 'Your background check must pass first',
  VEHICLE: 'Catering needs a car or van on your profile',
  COLD_BAG: 'Add a cold bag to your equipment',
};
const statusTone = (s: CertificationStatus) => (s === 'ACTIVE' ? 'good' : s === 'PENDING' || s === 'TRAINING' ? 'info' : s === 'NONE' ? 'neutral' : 'bad') as 'good' | 'info' | 'neutral' | 'bad';

export function CategoryBadges({ categories }: { categories?: SpecialCategory[] }) {
  if (!categories?.length) return null;
  return <>{categories.map((c) => <Badge key={c} tone="warn">{SPECIAL_CATEGORY_LABELS[c] ?? c}</Badge>)}</>;
}

export function PremiumLine({ special }: { special?: SpecialPremium[] }) {
  if (!special?.length) return null;
  return <div className="text-xs font-semibold text-amber-700">+ {money(special.reduce((t, p) => t + p.cents, 0))} {special.map((p) => p.label).join(', ')}</div>;
}

function Training({ c, onDone }: { c: Cert; onDone: (v: CertView) => void }) {
  const [answers, setAnswers] = useState<(number | null)[]>(c.training.questions.map(() => null));
  const [wrong, setWrong] = useState<number[]>([]);
  const { run, error, busy } = useCourierAction();
  const submit = () => run(async () => {
    setWrong([]);
    try {
      onDone(await api.post<CertView>(`/driver/certifications/${c.category}/training`, { answers }));
    } catch (e) {
      if (errCode(e) === 'TRAINING_FAILED') setWrong(((e as { body?: { wrong?: number[] } }).body?.wrong) ?? []);
      throw e;
    }
  });
  return (
    <div className="mt-2 rounded-lg bg-ink-50 p-3">
      <p className="font-medium">{c.training.title}</p>
      <p className="mt-1 text-xs text-ink-600">{c.training.body}</p>
      <div className="mt-2 space-y-2">{c.training.questions.map((q, i) => (
        <fieldset key={i} className={`rounded-lg border bg-white p-2 ${wrong.includes(i) ? 'border-red-300' : 'border-ink-100'}`}>
          <legend className="px-1 text-xs font-medium">{q.q}</legend>
          {q.options.map((o, k) => <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name={`${c.category}-${i}`} checked={answers[i] === k} onChange={() => setAnswers(answers.map((a, j) => (j === i ? k : a)))} /> {o}</label>)}
          {wrong.includes(i) && <p className="text-xs text-red-700">Not quite — read the guide again.</p>}
        </fieldset>
      ))}</div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <Button className="mt-2" size="sm" disabled={busy || answers.some((a) => a === null)} onClick={() => void submit()}>Submit answers</Button>
    </div>
  );
}

function Certificate({ c, onDone }: { c: Cert; onDone: (v: CertView) => void }) {
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const [exp, setExp] = useState('');
  const { run, error, busy } = useCourierAction();
  return (
    <div className="mt-2 rounded-lg bg-ink-50 p-3">
      <p className="text-xs text-ink-600">Upload a photo of your responsible-service (alcohol) certificate. Our team checks it.</p>
      <div className="mt-1 flex flex-wrap items-end gap-2"><PhotoCapture purpose="CERTIFICATE" label="Photo of certificate" value={photo} onChange={setPhoto} /><Input label="Expires (optional)" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <Button className="mt-2" size="sm" disabled={busy || !photo} onClick={() => run(async () => onDone(await api.post<CertView>(`/driver/certifications/${c.category}/certificate`, { fileUrl: photo!.url, expiresAt: exp ? new Date(`${exp}T23:59:00`).toISOString() : undefined })))}>Send certificate</Button>
    </div>
  );
}

/** Courier: which special deliveries they can take, and how to qualify. */
export function CertificationsCard() {
  const { data, reload } = useApi<CertView>('/driver/certifications');
  const [view, setView] = useState<CertView | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const v = view ?? data;
  const done = (n: CertView) => { setView(n); setOpen(null); void reload(); };
  return (
    <Card title="Special deliveries">
      <p className="mb-2 text-xs text-ink-500">Get certified to receive alcohol, catering, pharmacy and temperature-controlled orders. Each pays a little extra.</p>
      <div className="space-y-2">{v?.certifications.map((c) => {
        const canTrain = c.needs.includes('TRAINING') && c.status !== 'REVOKED';
        return (
          <div key={c.category} className="rounded-xl border border-ink-100 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><b>{c.label}</b><Badge tone={statusTone(c.status)}>{CERTIFICATION_STATUS_LABELS[c.status]}</Badge><span className="text-xs text-ink-500">+{money(c.premiumCents)} per delivery</span>{c.expiresAt && c.status === 'ACTIVE' && <span className="text-xs text-ink-500">until {new Date(c.expiresAt).toLocaleDateString()}</span>}</div>
            {c.note && c.status !== 'ACTIVE' && <p className="mt-1 text-xs text-ink-600">“{c.note}”</p>}
            {!!c.needs.length && c.status !== 'REVOKED' && <ul className="mt-1 list-disc pl-5 text-xs text-ink-600">{c.needs.map((n) => <li key={n}>{NEED_TEXT[n] ?? n}</li>)}</ul>}
            {c.status === 'PENDING' && <p className="mt-1 text-xs text-ink-500">We’re reviewing this. You’ll start getting these orders once approved.</p>}
            {c.status === 'REVOKED' && <p className="mt-1 text-xs text-ink-500">Contact courier support to discuss this certification.</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {canTrain && <Button size="sm" variant="secondary" onClick={() => setOpen(open === `t${c.category}` ? null : `t${c.category}`)}>{open === `t${c.category}` ? 'Close training' : 'Start training'}</Button>}
              {c.needs.includes('CERTIFICATE') && c.status !== 'REVOKED' && <Button size="sm" variant="secondary" onClick={() => setOpen(open === `c${c.category}` ? null : `c${c.category}`)}>Upload certificate</Button>}
            </div>
            {open === `t${c.category}` && <Training c={c} onDone={done} />}
            {open === `c${c.category}` && <Certificate c={c} onDone={done} />}
          </div>
        );
      })}</div>
      {v && (
        <div className="mt-3 rounded-xl border border-ink-100 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><b>High-value orders</b><Badge tone={v.highValue.eligible ? 'good' : 'neutral'}>{v.highValue.eligible ? 'Eligible' : 'Not yet'}</Badge></div>
          <p className="mt-1 text-xs text-ink-600">Orders over {money(v.highValue.thresholdCents)} go to experienced couriers and are handed over with the customer’s PIN.{v.highValue.reason ? ` ${v.highValue.reason}.` : ''}</p>
        </div>
      )}
    </Card>
  );
}

// ───── trip tools ─────

/** Extra fields for DELIVERED: age check, named recipient + seal. Returns null until complete. */
export function useSpecialHandoff(h: HandoffRequirements | undefined) {
  const [dob, setDob] = useState('');
  const [idType, setIdType] = useState(h?.ageCheck?.idTypes[0] ?? '');
  const [idLast4, setIdLast4] = useState('');
  const [recipient, setRecipient] = useState('');
  const [seal, setSeal] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const age = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? ageOn(dob, today) : null;
  const under = !!h?.ageCheck && age !== null && age < h.ageCheck.minAge;
  const complete = (!h?.ageCheck || (age !== null && !under && !!idType)) && (!h?.recipientName || recipient.trim().length >= 2) && (!h?.sealCheck || seal);
  const body = () => ({
    ...(h?.ageCheck ? { ageCheck: { dob, idType, ...(idLast4 ? { idLast4 } : {}) } } : {}),
    ...(h?.recipientName ? { recipientName: recipient.trim() } : {}),
    ...(h?.sealCheck ? { sealIntact: seal } : {}),
  });
  const fields = !h || (!h.ageCheck && !h.recipientName && !h.sealCheck) ? null : (
    <div className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
      {h.ageCheck && (
        <div>
          <p className="text-xs font-medium">Check a photo ID ({h.ageCheck.minAge}+). Enter the date of birth from the ID.</p>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            <Input label="Date of birth" type="date" max={today} value={dob} onChange={(e) => setDob(e.target.value)} />
            <Select label="ID type" value={idType} onChange={(e) => setIdType(e.target.value)}>{h.ageCheck.idTypes.map((t) => <option key={t} value={t}>{ID_TYPE_LABELS[t] ?? t}</option>)}</Select>
            <Input label="Last 4 of ID (optional)" maxLength={4} value={idLast4} onChange={(e) => setIdLast4(e.target.value.replace(/[^0-9A-Za-z]/g, ''))} />
          </div>
          {age !== null && <p className={`mt-1 text-xs font-medium ${under ? 'text-red-700' : 'text-emerald-700'}`}>Age {age}{under ? ` — under ${h.ageCheck.minAge}. Don’t hand it over: use “Can’t hand over”.` : ' — OK'}</p>}
        </div>
      )}
      {h.recipientName && (
        <div>
          <p className="text-xs font-medium">Only <b>{h.recipientName}</b> can receive this order. Ask for their name.</p>
          <Input className="mt-1" label="Recipient’s name" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
        </div>
      )}
      {h.sealCheck && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} /> The seal is intact</label>}
    </div>
  );
  return { fields, complete, body };
}

export function TemperatureBox({ jobId, h, special, picked, onDone }: { jobId: string; h: HandoffRequirements; special?: JobSpecial; picked: boolean; onDone: () => Promise<void> }) {
  const [t, setT] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const { run, error, busy } = useCourierAction();
  if (!h.tempControl) return null;
  const stage = picked ? 'DROPOFF' : 'PICKUP';
  return (
    <div className="rounded-lg bg-sky-50 p-2 text-sm">
      <p className="text-xs font-medium">Temperature-controlled: keep it in the cold bag (max {h.tempControl.coldMaxC} °C, {h.tempControl.maxTransitMinutes} min in transit){h.tempControl.requireReadings ? '. A drop-off reading is required.' : '.'}</p>
      {!!special?.temps?.length && <p className="text-xs text-ink-600">Readings: {special.temps.map((x) => `${x.stage.toLowerCase()} ${x.tempC} °C`).join(' · ')}</p>}
      {special?.breach && <p className="text-xs font-medium text-red-700">Flagged: {special.breach.detail}. Support will follow up — still complete the handoff.</p>}
      <div className="mt-1 flex flex-wrap items-end gap-2"><Input className="w-28" label={`${picked ? 'Drop-off' : 'Pickup'} °C`} type="number" step="0.1" value={t} onChange={(e) => setT(e.target.value)} /><Button size="sm" variant="secondary" disabled={busy || t === ''} onClick={() => run(async () => { const r = await api.post<{ note: string | null }>(`/driver/jobs/${jobId}/temperature`, { stage, tempC: Number(t) }); setT(''); setNote(r.note); await onDone(); })}>Log reading</Button></div>
      {note && <p className="mt-1 text-xs">{note}</p>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function CateringBox({ jobId, h, special, onDone }: { jobId: string; h: HandoffRequirements; special?: JobSpecial; onDone: () => Promise<void> }) {
  const { run, error, busy } = useCourierAction();
  if (!h.catering) return null;
  const c = special?.catering ?? {};
  const cl = c.checklist ?? {};
  const post = (b: Record<string, unknown>) => run(async () => { await api.post(`/driver/jobs/${jobId}/catering`, b); await onDone(); });
  const tick = (k: 'itemsCounted' | 'utensils' | 'labelsShown', label: string) => <label className="flex items-center gap-2"><input type="checkbox" checked={!!cl[k]} disabled={busy} onChange={(e) => void post({ checklist: { [k]: e.target.checked } })} /> {label}</label>;
  return (
    <div className="rounded-lg bg-violet-50 p-2 text-sm">
      <p className="text-xs font-medium">Catering{h.catering.headcount ? ` for ${h.catering.headcount}` : ''}: count the items with the customer and get a signature{h.catering.setupRequired ? '; setup is requested' : ''}.</p>
      <div className="mt-1 space-y-0.5">{tick('itemsCounted', 'Items counted with the customer')}{tick('utensils', 'Utensils and napkins handed over')}{tick('labelsShown', 'Labels and allergens shown')}</div>
      {h.catering.setupRequired && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {!c.setupStartedAt && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void post({ startSetup: true })}>Start setup</Button>}
          {c.setupStartedAt && !c.setupDoneAt && <><span className="text-xs">Setup started {when(c.setupStartedAt)}</span><Button size="sm" variant="secondary" disabled={busy} onClick={() => void post({ finishSetup: true })}>Setup done</Button></>}
          {c.setupDoneAt && <Badge tone="good">Setup done · {Math.floor(c.setupMinutes ?? 0)} min paid</Badge>}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function RefuseHandoff({ jobId, onDone }: { jobId: string; onDone: (outcome: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RefusalReason>('NO_ID');
  const [note, setNote] = useState('');
  const { run, error, busy } = useCourierAction();
  if (!open) return <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Can’t hand over</Button>;
  return (
    <div className="w-full rounded-lg border border-red-200 p-3">
      <p className="text-xs text-ink-600">Don’t hand over the order. It goes back to the kitchen, which confirms it got it back.</p>
      <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Select label="Why?" value={reason} onChange={(e) => setReason(e.target.value as RefusalReason)}>{REFUSAL_REASONS.map((r) => <option key={r} value={r}>{REFUSAL_LABELS[r]}</option>)}</Select>
        <Input label="Details (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-1"><Button size="sm" variant="danger" disabled={busy} onClick={() => run(async () => { const r = await api.post<{ outcome: string }>(`/driver/jobs/${jobId}/refuse-handoff`, { reason, note: note.trim() || undefined }); setOpen(false); await onDone(r.outcome); })}>Return order</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      </div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}
