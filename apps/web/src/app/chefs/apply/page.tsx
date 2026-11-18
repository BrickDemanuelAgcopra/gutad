'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ALLERGENS, CHEF_APPLICATION_STATUS_LABELS, WEEKDAYS, type ChefApplicationData, type ChefApplicationStatus, type ChefDocRequirement, type ChefStarterDish, type ChefStepKey } from '@gutad/shared';
import { api, API_URL, money, uploadFile, when } from '@/lib/api';
import { useApi, useSession } from '@/lib/hooks';
import { AuthForm } from '@/components/auth-form';
import { Alert, Badge, Button, Card, Input, Select, Spinner, Textarea } from '@/components/ui';
import { ChipGroup, FileDrop, ProgressBar, RadioCards, SaveBadge, Segmented, StepNav, useAutosave } from '@/components/form-kit';

interface Cfg { agreementVersion: string; steps: { key: ChefStepKey; label: string; description: string }[]; kitchenTypes: Record<string, string>; businessTypes: Record<string, string>; cuisines: string[]; maxFileBytes: number }
interface Doc { id: string; requirementKey: string; status: string; expiresAt: string | null; note: string | null; fileId: string; createdAt: string }
interface Application {
  id: string; status: ChefApplicationStatus; editable: boolean; data: ChefApplicationData; agreementVersion: string;
  progress: { percent: number; ready: boolean; steps: { key: ChefStepKey; label: string; complete: boolean; missing: string[] }[] };
  requirements: ChefDocRequirement[]; documents: Doc[]; correctionSteps: string[]; reviewNote: string | null; decisionReason: string | null; history: { at: string; action: string; note?: string }[]; submittedAt: string | null;
}

const photoUrl = (id?: string | null) => (id ? `${API_URL}/public/chef-photos/${id}` : null);
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

export default function ChefApplyPage() {
  const { user, ready } = useSession();
  const { data: cfg } = useApi<Cfg>('/public/chef-network/config');
  if (!ready) return <Spinner />;
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-ink-900 to-ink-700 p-6 text-white sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-300">Gutad Besties</p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Cook what you love. We handle the rest.</h1>
        <p className="mt-3 max-w-2xl text-sm text-ink-100 sm:text-base">Sell your dishes as <strong>Gutad’s &lt;your dish&gt; — by &lt;you&gt;</strong>. Gutad brings customers, payments, delivery, support and packaging standards; you set your menu, customizations, cooking days and capacity.</p>
        <ul className="mt-4 grid gap-2 text-sm text-ink-100 sm:grid-cols-3">
          <li>✓ Apply in about 20 minutes — progress saves as you go</li>
          <li>✓ Approved kitchens only: commercial, commissary or permitted home kitchens</li>
          <li>✓ Weekly payouts through secure hosted onboarding</li>
        </ul>
      </section>
      {!user ? (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title="Before you start">
            <ul className="space-y-2 text-sm text-ink-700">
              <li>• A mobile phone and a verified email</li>
              <li>• Your kitchen address, type and operator</li>
              <li>• Food handler certificate, kitchen permit and insurance (we tell you exactly which for your state and kitchen)</li>
              <li>• A portrait photo and your first dish with allergens</li>
            </ul>
            <p className="mt-3 text-xs text-ink-500">Bank and tax details are collected later by our payment provider, not stored by Gutad.</p>
          </Card>
          <AuthForm initialMode="register" title="Create your account to apply" />
        </div>
      ) : cfg ? (
        <Wizard cfg={cfg} />
      ) : (
        <Spinner />
      )}
    </div>
  );
}

function Wizard({ cfg }: { cfg: Cfg }) {
  const { data: app, setData, reload, loading } = useApi<Application | null>('/chef/application');
  const [step, setStep] = useState<ChefStepKey>('account');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (app?.correctionSteps?.length) setStep(app.correctionSteps[0] as ChefStepKey);
  }, [app?.id, app?.correctionSteps?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !app) return <Spinner />;
  if (!app)
    return (
      <Card>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Start your chef application</h2>
            <p className="text-sm text-ink-500">Nine short steps. You can leave and come back anytime.</p>
          </div>
          <Button size="lg" onClick={async () => setData(await api.post<Application>('/chef/application', {}))}>Start application</Button>
        </div>
      </Card>
    );

  const idx = cfg.steps.findIndex((s) => s.key === step);
  const progressOf = (k: string) => app.progress.steps.find((s) => s.key === k);
  const submit = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      setData(await api.post<Application>('/chef/application/submit', {}));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const merge = (next: Application) => setData((cur) => (cur ? { ...cur, progress: next.progress, requirements: next.requirements, documents: next.documents, status: next.status } : next));

  return (
    <div className="space-y-4">
      <StatusBanner app={app} onAppeal={(a) => setData(a)} />
      <Card>
        <ProgressBar percent={app.progress.percent} label={`${app.progress.steps.filter((s) => s.complete).length} of ${app.progress.steps.length} steps complete`} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <StepNav
            active={step}
            onSelect={(k) => setStep(k as ChefStepKey)}
            steps={cfg.steps.map((s) => ({ key: s.key, label: s.label, complete: progressOf(s.key)?.complete, flagged: app.correctionSteps.includes(s.key) }))}
          />
        </div>
        <Card title={cfg.steps[idx]?.label} action={<span className="text-xs text-ink-500">Step {idx + 1} of {cfg.steps.length}</span>}>
          <p className="-mt-1 mb-4 text-sm text-ink-500">{cfg.steps[idx]?.description}</p>
          {app.correctionSteps.includes(step) && app.reviewNote && <div className="mb-4"><Alert tone="info">Our reviewer asked: {app.reviewNote}</Alert></div>}
          <fieldset disabled={!app.editable} className="space-y-4 disabled:opacity-70">
            <StepForm key={step} step={step} app={app} cfg={cfg} onSaved={merge} reload={reload} />
          </fieldset>
          {!!progressOf(step)?.missing.length && app.editable && (
            <p className="mt-4 text-xs text-amber-700">Still needed: {progressOf(step)!.missing.join(' · ')}</p>
          )}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-4">
            <Button variant="secondary" disabled={idx === 0} onClick={() => setStep(cfg.steps[idx - 1].key)}>Back</Button>
            {idx < cfg.steps.length - 1 ? (
              <Button onClick={() => setStep(cfg.steps[idx + 1].key)}>Continue</Button>
            ) : app.editable ? (
              <Button disabled={!app.progress.ready || submitting} onClick={submit}>{submitting ? 'Submitting…' : app.status === 'CHANGES_REQUESTED' ? 'Resubmit application' : 'Submit application'}</Button>
            ) : null}
          </div>
          {err && <div className="mt-3"><Alert>{err}</Alert></div>}
          {idx === cfg.steps.length - 1 && app.editable && !app.progress.ready && <p className="mt-2 text-right text-xs text-ink-500">Finish the steps without a ✓ to submit.</p>}
        </Card>
      </div>
    </div>
  );
}

function StatusBanner({ app, onAppeal }: { app: Application; onAppeal: (a: Application) => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const label = CHEF_APPLICATION_STATUS_LABELS[app.status];
  if (app.status === 'DRAFT') return null;
  if (app.status === 'APPROVED')
    return (
      <Alert tone="good">
        <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>You’re approved!</strong> Connect payouts, add dishes and open your availability.</span><Link href="/chef" className="font-semibold underline">Open Bestie dashboard →</Link></div>
      </Alert>
    );
  return (
    <Alert tone={app.status === 'REJECTED' ? 'bad' : 'info'}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={app.status === 'REJECTED' ? 'bad' : app.status === 'CHANGES_REQUESTED' ? 'warn' : 'info'}>{label}</Badge>{app.submittedAt && <span className="text-xs">Submitted {when(app.submittedAt)}</span>}</div>
        {app.status === 'SUBMITTED' || app.status === 'IN_REVIEW' ? <p className="text-sm">Our team is reviewing your kitchen, documents and menu. We’ll email you; this usually takes about 3 business days.</p> : null}
        {app.status === 'CHANGES_REQUESTED' && <p className="text-sm">A reviewer asked for changes on the highlighted steps (!). Update them and resubmit.</p>}
        {app.status === 'WAITLISTED' && <p className="text-sm">We’re not onboarding chefs in your area yet{app.decisionReason ? ` (${app.decisionReason})` : ''}. Your application is saved.</p>}
        {app.status === 'APPEALED' && <p className="text-sm">Your appeal is with our team.</p>}
        {app.status === 'REJECTED' && (
          <div className="space-y-2">
            <p className="text-sm">Reason: {app.decisionReason}</p>
            <Textarea label="Appeal (what changed, or why we should reconsider)" value={note} onChange={(e) => setNote(e.target.value)} />
            {err && <p className="text-xs text-red-600">{err}</p>}
            <Button size="sm" disabled={note.trim().length < 10} onClick={async () => { try { onAppeal(await api.post<Application>('/chef/application/appeal', { note })); } catch (e) { setErr((e as Error).message); } }}>Send appeal</Button>
          </div>
        )}
      </div>
    </Alert>
  );
}

type StepProps = { step: ChefStepKey; app: Application; cfg: Cfg; onSaved: (a: Application) => void; reload: () => Promise<void> };

function StepForm(p: StepProps) {
  if (p.step === 'documents') return <DocumentsStep {...p} />;
  return <DataStep {...p} />;
}

/** Every data step edits one object; edits autosave after a short pause. */
function DataStep({ step, app, cfg, onSaved }: StepProps) {
  const initial = ((app.data as Record<string, unknown>)[step] || {}) as Record<string, unknown>;
  const [v, setV] = useState<Record<string, unknown>>(initial);
  const save = useAutosave<Record<string, unknown>>(async (patch) => onSaved(await api.put<Application>(`/chef/application/steps/${step}`, patch)));
  const set = (patch: Record<string, unknown>) => {
    setV((cur) => ({ ...cur, ...patch }));
    save.queue({ ...v, ...patch });
  };
  const s = (k: string) => (v[k] as string) ?? '';
  const n = (k: string) => (v[k] as number | undefined);
  const badge = <div className="flex justify-end"><SaveBadge state={save.state} error={save.error} /></div>;

  if (step === 'account')
    return (
      <div className="space-y-4">
        {badge}
        <Input label="Mobile phone" type="tel" autoComplete="tel" value={s('phone')} onChange={(e) => set({ phone: e.target.value })} placeholder="+1 555 123 4567" />
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm text-ink-700">
          <p className="font-semibold text-ink-900">Gutad Bestie Partner Agreement (v{cfg.agreementVersion})</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            <li>Gutad sells your dishes to customers as “Gutad’s &lt;dish&gt; — by &lt;you&gt;”; you remain the preparer and keep ownership of your recipes.</li>
            <li>You only cook in your approved kitchen and keep permits, certificates and insurance current.</li>
            <li>Published customizations can be ordered instantly; anything else needs your quote and the customer’s acceptance.</li>
            <li>Gutad is the single support contact; refunds are allocated by documented cause.</li>
            <li>Earnings are paid weekly after completed orders, less the agreed commission.</li>
          </ul>
        </div>
        {initial.agreedAt ? (
          <p className="text-sm text-emerald-700">✓ Accepted {when(initial.agreedAt as string)}</p>
        ) : (
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!v.agreed} onChange={(e) => set({ agreed: e.target.checked })} /> I have read and accept the Bestie Partner Agreement and the <Link href="/terms" className="underline">Terms</Link>.</label>
        )}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!v.smsConsent} onChange={(e) => set({ smsConsent: e.target.checked })} /> Text me order and request alerts (message rates may apply; reply STOP to opt out).</label>
      </div>
    );

  if (step === 'identity')
    return (
      <div className="space-y-4">
        {badge}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Legal name (as on your ID)" value={s('legalName')} onChange={(e) => set({ legalName: e.target.value })} />
          <Input label="Public Bestie name" value={s('displayName')} onChange={(e) => set({ displayName: e.target.value })} placeholder="Bestie Carlos" />
        </div>
        {s('displayName') && <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">Your dishes will show as <strong>Gutad’s Spaghetti — by {s('displayName')}</strong></p>}
        <RadioCards name="Selling as" value={s('businessType') as 'INDIVIDUAL' | 'BUSINESS'} onChange={(x) => set({ businessType: x })} options={Object.entries(cfg.businessTypes).map(([value, label]) => ({ value: value as 'INDIVIDUAL' | 'BUSINESS', label }))} />
        {s('businessType') === 'BUSINESS' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Registered business name" value={s('businessName')} onChange={(e) => set({ businessName: e.target.value })} />
            <Input label="Registration / file number (optional)" value={s('businessRegistration')} onChange={(e) => set({ businessRegistration: e.target.value })} />
          </div>
        )}
        <p className="text-xs text-ink-500">Identity is verified with your government ID (Documents step) and by our payment provider when you connect payouts.</p>
      </div>
    );

  if (step === 'profile')
    return (
      <div className="space-y-4">
        {badge}
        <PhotoField label="Portrait photo" hint="A clear, friendly photo of you (JPG, PNG or WEBP)" fileId={s('portraitFileId')} onUploaded={(id) => set({ portraitFileId: id })} />
        <Textarea label="Biography" rows={4} value={s('bio')} onChange={(e) => set({ bio: e.target.value })} placeholder="Where you trained, what you cook and why customers love it" />
        <p className="-mt-3 text-right text-xs text-ink-500">{s('bio').length}/40+ characters</p>
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-500">Cuisines (up to 5)</span>
          <ChipGroup name="Cuisines" max={5} values={(v.cuisines as string[]) || []} onChange={(x) => set({ cuisines: x })} options={cfg.cuisines.map((c) => ({ value: c, label: c }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Years of experience" type="number" min={0} value={n('experienceYears') ?? ''} onChange={(e) => set({ experienceYears: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <Input label="Languages (comma separated)" value={((v.languages as string[]) || []).join(', ')} onChange={(e) => set({ languages: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          <Input label="Instagram (optional)" value={s('instagram')} onChange={(e) => set({ instagram: e.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Service city" value={s('serviceCity')} onChange={(e) => set({ serviceCity: e.target.value })} />
          <Select label="State" value={s('serviceRegion')} onChange={(e) => set({ serviceRegion: e.target.value })}><option value="">Choose</option>{US_STATES.map((x) => <option key={x}>{x}</option>)}</Select>
          <Input label="Service radius (km)" type="number" min={1} value={n('serviceRadiusKm') ?? 10} onChange={(e) => set({ serviceRadiusKm: Number(e.target.value) })} />
        </div>
        <Portfolio ids={(v.portfolioFileIds as string[]) || []} onChange={(ids) => set({ portfolioFileIds: ids })} />
      </div>
    );

  if (step === 'kitchen')
    return (
      <div className="space-y-4">
        {badge}
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-500">Kitchen type</span>
          <RadioCards name="Kitchen type" value={s('kitchenType')} onChange={(x) => set({ kitchenType: x })} options={Object.entries(cfg.kitchenTypes).map(([value, label]) => ({ value, label, description: value === 'COTTAGE_HOME' ? 'Only where your state or county permits selling from a home kitchen. A home address alone is not enough.' : undefined }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Kitchen name" value={s('name')} onChange={(e) => set({ name: e.target.value })} placeholder="Brooklyn Commissary, Kitchen 4" />
          <Input label="Kitchen operator (permit holder)" value={s('operatorName')} onChange={(e) => set({ operatorName: e.target.value })} />
        </div>
        <Input label="Street address" autoComplete="address-line1" value={s('addressLine1')} onChange={(e) => set({ addressLine1: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-4">
          <Input label="Unit (optional)" value={s('addressLine2')} onChange={(e) => set({ addressLine2: e.target.value })} />
          <Input label="City" value={s('city')} onChange={(e) => set({ city: e.target.value })} />
          <Select label="State" value={s('region')} onChange={(e) => set({ region: e.target.value })}><option value="">Choose</option>{US_STATES.map((x) => <option key={x}>{x}</option>)}</Select>
          <Input label="ZIP" inputMode="numeric" value={s('postalCode')} onChange={(e) => set({ postalCode: e.target.value })} />
        </div>
        <Textarea label="Pickup access for couriers and customers" value={s('pickupAccess')} onChange={(e) => set({ pickupAccess: e.target.value })} placeholder="Gate B, ring Kitchen 4; loading zone on Flushing Ave" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Equipment (comma separated)" value={((v.equipment as string[]) || []).join(', ')} onChange={(e) => set({ equipment: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="range, convection oven, mixer" />
          <Input label="Storage (comma separated)" value={((v.storage as string[]) || []).join(', ')} onChange={(e) => set({ storage: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="walk-in cooler, freezer" />
          <Input label="Max portions per day" type="number" min={1} value={n('dailyCapacity') ?? ''} onChange={(e) => set({ dailyCapacity: Number(e.target.value) })} />
        </div>
      </div>
    );

  if (step === 'operating') {
    const days = (v.cookingDays as number[]) || [];
    return (
      <div className="space-y-4">
        {badge}
        <div>
          <span className="mb-1 block text-xs font-medium text-ink-500">Cooking days</span>
          <ChipGroup name="Cooking days" values={days} onChange={(x) => set({ cookingDays: [...x].sort() })} options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Order cutoff (day before cooking)" value={n('cutoffHour') ?? ''} onChange={(e) => set({ cutoffHour: Number(e.target.value) })}>
            <option value="">Choose</option>
            {[8, 10, 12, 14, 16, 18, 20].map((h) => <option key={h} value={h}>{h <= 12 ? `${h === 12 ? 12 : h}:00 ${h < 12 ? 'AM' : 'PM'}` : `${h - 12}:00 PM`}</option>)}
          </Select>
          <Select label="Minimum notice" value={n('minLeadDays') ?? ''} onChange={(e) => set({ minLeadDays: Number(e.target.value) })}>
            <option value="">Choose</option>
            {[0, 1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d === 0 ? 'Same day' : `${d} day${d > 1 ? 's' : ''}`}</option>)}
          </Select>
          <Select label="Order up to (advance)" value={n('maxAdvanceDays') ?? 30} onChange={(e) => set({ maxAdvanceDays: Number(e.target.value) })}>
            {[7, 14, 30, 45, 60].map((d) => <option key={d} value={d}>{d} days ahead</option>)}
          </Select>
        </div>
        <Input label="Orders you can take per cooking day" type="number" min={1} value={n('dailyCapacity') ?? ''} onChange={(e) => set({ dailyCapacity: Number(e.target.value) })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleCard on={!!v.scheduledOrders} onChange={(x) => set({ scheduledOrders: x })} title="Scheduled orders" text="Customers pick a future date and time slot (e.g. a Thanksgiving cake two weeks ahead)." />
          <ToggleCard on={!!v.instantOrders} onChange={(x) => set({ instantOrders: x })} title="Same-day orders" text="Accept orders for today while you are cooking and have capacity." />
          <ToggleCard on={!!v.pickup} onChange={(x) => set({ pickup: x })} title="Customer pickup" text="Customers collect from your kitchen’s pickup point." />
          <ToggleCard on={!!v.delivery} onChange={(x) => set({ delivery: x })} title="Gutad delivery" text="Gutad couriers collect from your kitchen and deliver." />
        </div>
      </div>
    );
  }

  if (step === 'payments')
    return (
      <div className="space-y-4">
        {badge}
        <Select label="Payout country" value={s('country') || 'US'} onChange={(e) => set({ country: e.target.value })}><option value="US">United States</option></Select>
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm text-ink-700">
          <p className="font-semibold text-ink-900">How you get paid</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            <li>Customers pay Gutad. Your earnings are your dish price less the agreed commission, itemized on weekly statements.</li>
            <li>Tips go to their named recipients in full.</li>
            <li>After approval you connect payouts through our payment provider’s secure hosted onboarding. They verify your identity and collect bank and tax details; Gutad never stores them.</li>
          </ul>
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!v.earningsAgreementAccepted} onChange={(e) => set({ earningsAgreementAccepted: e.target.checked })} /> I accept the earnings agreement and weekly payout schedule.</label>
      </div>
    );

  if (step === 'menu') return <MenuStep v={v} set={set} badge={badge} />;

  if (step === 'readiness')
    return (
      <div className="space-y-3">
        {badge}
        <ToggleCard on={!!v.packagingAck} onChange={(x) => set({ packagingAck: x })} title="Packaging standards" text="Sealed, tamper-evident containers labeled with Gutad, your chef name, the order number, ingredients and allergens. Hot and chilled items packed separately." />
        <ToggleCard on={!!v.handlingTrainingAck} onChange={(x) => set({ handlingTrainingAck: x })} title="Order-handling training" text="Accept or decline before the deadline, cook exactly what the ticket says, mark ready on time, and never substitute without the customer’s approval." />
        <ToggleCard on={!!v.allergenTrainingAck} onChange={(x) => set({ allergenTrainingAck: x })} title="Allergen training" text="Removing a visible ingredient does not make a dish allergen-free. Declare every allergen in your recipes and your kitchen." />
        <ToggleCard on={!!v.sampleReviewOk} onChange={(x) => set({ sampleReviewOk: x })} title="Sample review (if requested)" text="I agree to prepare a test order or sample for Gutad’s quality team if asked." />
      </div>
    );
  return null;
}

function ToggleCard({ on, onChange, title, text }: { on: boolean; onChange: (v: boolean) => void; title: string; text: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${on ? 'border-brand-500 bg-brand-50' : 'border-ink-100 bg-white hover:border-ink-300'}`}>
      <span className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${on ? 'bg-brand-500' : 'bg-ink-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow transition ${on ? 'translate-x-4' : ''}`} /></span>
      <span><span className="block text-sm font-medium text-ink-900">{title}</span><span className="block text-xs text-ink-500">{text}</span></span>
    </button>
  );
}

function PhotoField({ label, hint, fileId, onUploaded }: { label: string; hint: string; fileId?: string; onUploaded: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <FileDrop accept="image/jpeg,image/png,image/webp" label={label} hint={hint} busy={busy} previewUrl={photoUrl(fileId)} onFile={async (f) => {
        setBusy(true); setErr(null);
        try { const fd = new FormData(); fd.append('file', f); onUploaded((await uploadFile<{ id: string }>('/chef/photos', fd)).id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}

function Portfolio({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-ink-500">Portfolio (optional, up to 8 photos of your food)</span>
      <div className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <div key={id} className="relative">
            <img src={photoUrl(id)!} alt="" className="h-20 w-20 rounded-lg object-cover" />
            <button type="button" aria-label="Remove photo" onClick={() => onChange(ids.filter((x) => x !== id))} className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-xs text-white">×</button>
          </div>
        ))}
      </div>
      {ids.length < 8 && <div className="mt-2"><PhotoField label="Add a food photo" hint="Drag a photo here or choose one" onUploaded={(id) => onChange([...ids, id])} /></div>}
    </div>
  );
}

function MenuStep({ v, set, badge }: { v: Record<string, unknown>; set: (p: Record<string, unknown>) => void; badge: React.ReactNode }) {
  const dishes = (v.dishes as ChefStarterDish[]) || [];
  const upd = (i: number, patch: Partial<ChefStarterDish>) => set({ dishes: dishes.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  return (
    <div className="space-y-4">
      {badge}
      <p className="text-sm text-ink-500">Add one to three dishes to start. After approval you’ll finish each one in the dish builder (photos, options, availability) before it goes live.</p>
      {dishes.map((d, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-ink-100 p-4">
          <div className="flex items-center justify-between"><strong className="text-sm">Dish {i + 1}</strong><button type="button" className="text-xs text-red-600 underline" onClick={() => set({ dishes: dishes.filter((_, j) => j !== i) })}>Remove</button></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Dish name" value={d.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="Spaghetti" />
            <Input label="Price (USD)" type="number" min={0} step="0.5" value={d.priceCents ? d.priceCents / 100 : ''} onChange={(e) => upd(i, { priceCents: Math.round(Number(e.target.value) * 100) })} />
            <Input label="Portion" value={d.portion || ''} onChange={(e) => upd(i, { portion: e.target.value })} placeholder="1 bowl (450 g)" />
          </div>
          {d.name && <p className="text-xs text-ink-500">Listed as <strong className="text-ink-900">Gutad’s {d.name}</strong>{d.priceCents ? ` · ${money(d.priceCents)}` : ''}</p>}
          <Textarea label="Description (optional)" value={d.description || ''} onChange={(e) => upd(i, { description: e.target.value })} />
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-500">Allergens</span>
            <ChipGroup name="Allergens" values={d.allergens || []} onChange={(x) => upd(i, { allergens: x })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} />
            {!Array.isArray(d.allergens) ? (
              <button type="button" className="mt-2 text-xs underline" onClick={() => upd(i, { allergens: [] })}>This dish contains none of these</button>
            ) : !d.allergens.length ? <p className="mt-2 text-xs text-emerald-700">✓ Confirmed: none of the listed allergens</p> : null}
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-500">Listing type</span>
            <Segmented name="Listing type" value={d.mode || 'FIXED'} onChange={(x) => upd(i, { mode: x })} options={[{ value: 'FIXED', label: 'Fixed dish' }, { value: 'CUSTOMIZABLE', label: 'Customizable' }]} />
            <p className="mt-1 text-xs text-ink-500">{(d.mode || 'FIXED') === 'FIXED' ? 'Customers choose quantity and time; recipe changes are not offered.' : 'Customers adjust only the ingredients, quantities and substitutions you enable.'}</p>
          </div>
        </div>
      ))}
      {dishes.length < 3 && <Button variant="secondary" onClick={() => set({ dishes: [...dishes, { name: '', mode: 'FIXED' }] })}>+ Add a dish</Button>}
    </div>
  );
}

function DocumentsStep({ app, reload }: StepProps) {
  const reqs = app.requirements;
  if (!app.data.kitchen?.kitchenType) return <Alert tone="info">Choose your kitchen type in the Kitchen step first; we’ll then list exactly which documents your kitchen needs.</Alert>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">Based on a <strong>{app.data.kitchen.kitchenType.replace(/_/g, ' ').toLowerCase()}</strong> kitchen in <strong>{app.data.kitchen.region || 'your state'}</strong>. PDF or photo, up to 10 MB. Documents are only visible to Gutad reviewers.</p>
      {reqs.map((r) => <DocRow key={r.key} req={r} doc={app.documents.find((d) => d.requirementKey === r.key)} onUploaded={reload} />)}
    </div>
  );
}

function DocRow({ req, doc, onUploaded }: { req: ChefDocRequirement; doc?: Doc; onUploaded: () => Promise<void> }) {
  const [exp, setExp] = useState(doc?.expiresAt ? doc.expiresAt.slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tone = !doc ? 'neutral' : doc.status === 'APPROVED' ? 'good' : doc.status === 'REJECTED' ? 'bad' : 'info';
  const upload = async (f: File) => {
    if (req.needsExpiry && !exp) { setErr('Enter the expiry date first'); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append('requirementKey', req.key); if (exp) fd.append('expiresAt', exp); fd.append('file', f);
      await uploadFile('/chef/application/documents', fd);
      await onUploaded();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const status = useMemo(() => (doc ? { SUBMITTED: 'Uploaded — in review', APPROVED: 'Approved', REJECTED: 'Not accepted', EXPIRED: 'Expired' }[doc.status] || doc.status : req.required ? 'Required' : 'Optional'), [doc, req.required]);
  return (
    <div className="space-y-2 rounded-xl border border-ink-100 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><div className="text-sm font-medium">{req.label}</div>{req.description && <div className="text-xs text-ink-500">{req.description}</div>}</div>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {doc?.status === 'REJECTED' && doc.note && <p className="text-xs text-red-600">Reviewer: {doc.note}</p>}
      <div className="grid gap-2 sm:grid-cols-[180px_1fr] sm:items-center">
        {req.needsExpiry ? <Input label="Expiry date" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /> : <span />}
        <FileDrop accept="application/pdf,image/*" label={doc ? 'Replace document' : 'Upload document'} hint={doc ? `Uploaded ${when(doc.createdAt)}` : 'Drag a PDF or photo here, or take a photo'} busy={busy} onFile={upload} />
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}
