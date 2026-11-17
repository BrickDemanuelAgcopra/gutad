import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ALLERGENS, CHEF_APPLICATION_STATUS_LABELS, WEEKDAYS, type ChefApplicationData, type ChefApplicationStatus, type ChefDocRequirement, type ChefStarterDish, type ChefStepKey } from '@gutad/shared';
import { api, API_URL, when } from '@/api';
import { useApi, useSession } from '@/hooks';
import { Badge, Button, C, Card, ErrorText, Input, Loading, Muted, s } from '@/ui';
import { Chips, Choice, pickImage, Progress, Toggle, useAutosave } from '@/chef-ui';
import { pickFileOnWeb, uploadMultipart, type PickedFile } from '@/upload';

interface Cfg { agreementVersion: string; steps: { key: ChefStepKey; label: string; description: string }[]; kitchenTypes: Record<string, string>; businessTypes: Record<string, string>; cuisines: string[] }
interface Doc { id: string; requirementKey: string; status: string; expiresAt: string | null; note: string | null; createdAt: string }
interface App { id: string; status: ChefApplicationStatus; editable: boolean; data: ChefApplicationData; progress: { percent: number; ready: boolean; steps: { key: ChefStepKey; label: string; complete: boolean; missing: string[] }[] }; requirements: ChefDocRequirement[]; documents: Doc[]; correctionSteps: string[]; reviewNote: string | null; decisionReason: string | null }
const photo = (id?: string) => (id ? `${API_URL}/public/chef-photos/${id}` : undefined);

/** Chef application on the phone: same steps and autosave as the web, with camera uploads. */
export default function ChefApply() {
  const { user, ready } = useSession();
  const router = useRouter();
  const { data: cfg } = useApi<Cfg>('/public/chef-network/config');
  const { data: app, setData, reload, loading } = useApi<App | null>(user ? '/chef/application' : null, { deps: [user?.id] });
  const [step, setStep] = useState<ChefStepKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!ready) return <Loading />;
  if (!user) return <View style={[s.screen, s.pad]}><Card title="Cook with Gutad"><Muted>Sell your dishes as “Gutad’s &lt;dish&gt; — by &lt;you&gt;”. Gutad handles customers, payments, delivery and support.</Muted><Button title="Sign in or create an account" onPress={() => router.push('/login')} /></Card></View>;
  if (!cfg || (loading && !app)) return <Loading />;
  if (!app) return <View style={[s.screen, s.pad]}><Card title="Start your chef application"><Muted>Nine short steps; progress saves as you go. You’ll need your kitchen details, food handler certificate, permits and a portrait.</Muted><Button title="Start application" onPress={async () => setData(await api.post<App>('/chef/application', {}))} /></Card></View>;
  const merge = (n: App) => setData((c) => (c ? { ...c, progress: n.progress, requirements: n.requirements, documents: n.documents, status: n.status } : n));
  if (step) {
    const idx = cfg.steps.findIndex((x) => x.key === step);
    const p = app.progress.steps.find((x) => x.key === step);
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => setStep(null)}><Text style={{ color: C.brand, marginBottom: 8 }}>‹ All steps</Text></Pressable>
        <Card title={`${idx + 1}. ${cfg.steps[idx].label}`}>
          <Muted>{cfg.steps[idx].description}</Muted>
          {app.correctionSteps.includes(step) && app.reviewNote && <Text style={{ color: C.warn, marginTop: 6 }}>Reviewer: {app.reviewNote}</Text>}
          <View style={{ marginTop: 10 }} pointerEvents={app.editable ? 'auto' : 'none'}>
            {step === 'documents' ? <Docs app={app} reload={reload} /> : <StepFields key={step} step={step} app={app} cfg={cfg} onSaved={merge} />}
          </View>
          {!!p?.missing.length && <Text style={{ color: C.warn, fontSize: 12, marginTop: 8 }}>Still needed: {p.missing.join(' · ')}</Text>}
        </Card>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {idx > 0 && <Button style={{ flex: 1 }} variant="secondary" title="Back" onPress={() => setStep(cfg.steps[idx - 1].key)} />}
          {idx < cfg.steps.length - 1 ? <Button style={{ flex: 1 }} title="Continue" onPress={() => setStep(cfg.steps[idx + 1].key)} /> : <Button style={{ flex: 1 }} title="Review & submit" onPress={() => setStep(null)} />}
        </View>
      </ScrollView>
    );
  }
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Card title="Your chef application">
        <View style={s.row}><Badge text={CHEF_APPLICATION_STATUS_LABELS[app.status]} tone={app.status === 'APPROVED' ? 'good' : app.status === 'REJECTED' ? 'bad' : 'info'} /><Text style={{ fontWeight: '700' }}>{app.progress.percent}%</Text></View>
        <Progress percent={app.progress.percent} />
        {app.status === 'APPROVED' && <Button title="Open chef dashboard" onPress={() => router.push('/chef')} />}
        {app.status === 'REJECTED' && <Muted>Reason: {app.decisionReason}. Appeal from the web at gutad.io/chefs/apply.</Muted>}
        {(app.status === 'SUBMITTED' || app.status === 'IN_REVIEW') && <Muted>Our team is reviewing your application. We’ll email you.</Muted>}
        {app.status === 'CHANGES_REQUESTED' && <Text style={{ color: C.warn }}>A reviewer asked for changes on the steps marked !</Text>}
      </Card>
      {cfg.steps.map((st, i) => {
        const p = app.progress.steps.find((x) => x.key === st.key);
        const flagged = app.correctionSteps.includes(st.key);
        return (
          <Pressable key={st.key} onPress={() => setStep(st.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.white, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: C.ink1 }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: flagged ? '#fef3c7' : p?.complete ? C.good : C.ink1 }}><Text style={{ color: p?.complete && !flagged ? C.white : C.ink7, fontWeight: '700', fontSize: 12 }}>{flagged ? '!' : p?.complete ? '✓' : i + 1}</Text></View>
            <View style={{ flex: 1 }}><Text style={{ fontWeight: '600', color: C.ink }}>{st.label}</Text><Text style={{ color: C.ink5, fontSize: 12 }} numberOfLines={1}>{p?.complete ? 'Complete' : p?.missing.join(', ')}</Text></View>
            <Text style={{ color: C.ink3 }}>›</Text>
          </Pressable>
        );
      })}
      <ErrorText msg={err} />
      {app.editable && <Button title={app.status === 'CHANGES_REQUESTED' ? 'Resubmit application' : 'Submit application'} disabled={!app.progress.ready} onPress={async () => { setErr(null); try { setData(await api.post<App>('/chef/application/submit', {})); } catch (e) { setErr((e as Error).message); } }} />}
    </ScrollView>
  );
}

function StepFields({ step, app, cfg, onSaved }: { step: ChefStepKey; app: App; cfg: Cfg; onSaved: (a: App) => void }) {
  const initial = ((app.data as Record<string, unknown>)[step] || {}) as Record<string, unknown>;
  const [v, setV] = useState<Record<string, unknown>>(initial);
  const save = useAutosave<Record<string, unknown>>(async (patch) => onSaved(await api.put<App>(`/chef/application/steps/${step}`, patch)));
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Record<string, unknown>) => { setV((c) => ({ ...c, ...patch })); save.queue({ ...v, ...patch }); };
  const str = (k: string) => (v[k] as string) ?? '';
  const num = (k: string) => (v[k] === undefined || v[k] === null ? '' : String(v[k]));
  const status = <Text style={{ color: save.state === 'error' ? C.bad : C.ink5, fontSize: 11, textAlign: 'right' }}>{save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? '✓ Saved' : save.state === 'error' ? `Not saved: ${save.error}` : ''}</Text>;
  const uploadPhoto = async (src: 'camera' | 'library', key: string) => {
    setErr(null);
    try { const f = await pickImage(src); if (!f) return; const r = await uploadMultipart<{ id: string }>('/chef/photos', f, {}); set({ [key]: r.id }); } catch (e) { setErr((e as Error).message); }
  };
  switch (step) {
    case 'account':
      return <View>{status}<Input label="Mobile phone" keyboardType="phone-pad" value={str('phone')} onChangeText={(t) => set({ phone: t })} /><Muted>Chef Partner Agreement v{cfg.agreementVersion}: Gutad sells your dishes as “Gutad’s &lt;dish&gt; — by &lt;you&gt;”; you cook only in your approved kitchen; unlisted changes need your quote and the customer’s acceptance; weekly payouts after completed orders.</Muted>{initial.agreedAt ? <Text style={{ color: C.good, marginTop: 6 }}>✓ Accepted {when(initial.agreedAt as string)}</Text> : <Toggle on={!!v.agreed} onChange={(x) => set({ agreed: x })} title="I accept the Chef Partner Agreement and Terms" />}</View>;
    case 'identity':
      return <View>{status}<Input label="Legal name" value={str('legalName')} onChangeText={(t) => set({ legalName: t })} /><Input label="Public chef name" placeholder="Chef Carlos" value={str('displayName')} onChangeText={(t) => set({ displayName: t })} />{!!str('displayName') && <Muted>Shown as “Gutad’s Spaghetti — by {str('displayName')}”</Muted>}<Choice value={str('businessType') as 'INDIVIDUAL'} onChange={(x) => set({ businessType: x })} options={Object.entries(cfg.businessTypes).map(([value, label]) => ({ value: value as 'INDIVIDUAL', label }))} />{str('businessType') === 'BUSINESS' && <Input label="Registered business name" value={str('businessName')} onChangeText={(t) => set({ businessName: t })} />}</View>;
    case 'profile':
      return (
        <View>
          {status}
          {!!photo(str('portraitFileId')) && <Image source={{ uri: photo(str('portraitFileId')) }} style={{ width: 80, height: 80, borderRadius: 40, marginBottom: 6 }} />}
          <View style={{ flexDirection: 'row', gap: 6 }}>{Platform.OS !== 'web' && <Button style={{ flex: 1 }} variant="secondary" title="Take portrait" onPress={() => uploadPhoto('camera', 'portraitFileId')} />}<Button style={{ flex: 1 }} variant="secondary" title="Choose portrait" onPress={() => uploadPhoto('library', 'portraitFileId')} /></View>
          <ErrorText msg={err} />
          <Input label="Biography (40+ characters)" multiline value={str('bio')} onChangeText={(t) => set({ bio: t })} style={[s.input, { minHeight: 90 }]} />
          <Text style={s.label}>Cuisines (up to 5)</Text>
          <Chips max={5} values={(v.cuisines as string[]) || []} onChange={(x) => set({ cuisines: x })} options={cfg.cuisines.map((c) => ({ value: c, label: c }))} />
          <Input label="Years of experience" keyboardType="number-pad" value={num('experienceYears')} onChangeText={(t) => set({ experienceYears: t ? Number(t) : undefined })} />
          <Input label="Service city" value={str('serviceCity')} onChangeText={(t) => set({ serviceCity: t })} />
          <Input label="State (2 letters)" autoCapitalize="characters" maxLength={2} value={str('serviceRegion')} onChangeText={(t) => set({ serviceRegion: t.toUpperCase() })} />
        </View>
      );
    case 'kitchen':
      return <View>{status}<Choice value={str('kitchenType')} onChange={(x) => set({ kitchenType: x })} options={Object.entries(cfg.kitchenTypes).map(([value, label]) => ({ value, label }))} /><Input label="Kitchen operator (permit holder)" value={str('operatorName')} onChangeText={(t) => set({ operatorName: t })} /><Input label="Street address" value={str('addressLine1')} onChangeText={(t) => set({ addressLine1: t })} /><Input label="City" value={str('city')} onChangeText={(t) => set({ city: t })} /><Input label="State" autoCapitalize="characters" maxLength={2} value={str('region')} onChangeText={(t) => set({ region: t.toUpperCase() })} /><Input label="ZIP" keyboardType="number-pad" value={str('postalCode')} onChangeText={(t) => set({ postalCode: t })} /><Input label="Pickup access" value={str('pickupAccess')} onChangeText={(t) => set({ pickupAccess: t })} /><Input label="Max portions per day" keyboardType="number-pad" value={num('dailyCapacity')} onChangeText={(t) => set({ dailyCapacity: Number(t) || undefined })} /></View>;
    case 'operating':
      return <View>{status}<Text style={s.label}>Cooking days</Text><Chips values={(v.cookingDays as number[]) || []} onChange={(x) => set({ cookingDays: [...x].sort() })} options={WEEKDAYS.map((d, i) => ({ value: i, label: d }))} /><Input label="Order cutoff hour, day before (0–23)" keyboardType="number-pad" value={num('cutoffHour')} onChangeText={(t) => set({ cutoffHour: t === '' ? undefined : Math.min(23, Number(t)) })} /><Input label="Minimum notice (days)" keyboardType="number-pad" value={num('minLeadDays')} onChangeText={(t) => set({ minLeadDays: t === '' ? undefined : Number(t) })} /><Input label="Orders per cooking day" keyboardType="number-pad" value={num('dailyCapacity')} onChangeText={(t) => set({ dailyCapacity: Number(t) || undefined })} /><Input label="Order up to (days ahead)" keyboardType="number-pad" value={num('maxAdvanceDays') || '30'} onChangeText={(t) => set({ maxAdvanceDays: Number(t) || 30 })} /><Toggle on={!!v.scheduledOrders} onChange={(x) => set({ scheduledOrders: x })} title="Scheduled orders" text="Customers pick a future date and slot" /><Toggle on={!!v.instantOrders} onChange={(x) => set({ instantOrders: x })} title="Same-day orders" /><Toggle on={!!v.pickup} onChange={(x) => set({ pickup: x })} title="Customer pickup" /><Toggle on={!!v.delivery} onChange={(x) => set({ delivery: x })} title="Gutad delivery" /></View>;
    case 'payments':
      return <View>{status}<Muted>Customers pay Gutad; you receive your dish price less the agreed commission on weekly statements. After approval you connect payouts through our payment provider’s secure onboarding — Gutad never stores bank or tax details.</Muted><Toggle on={!!v.earningsAgreementAccepted} onChange={(x) => set({ earningsAgreementAccepted: x, country: 'US' })} title="I accept the earnings agreement" /></View>;
    case 'menu': {
      const dishes = (v.dishes as ChefStarterDish[]) || [];
      const upd = (i: number, patch: Partial<ChefStarterDish>) => set({ dishes: dishes.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
      return (
        <View>
          {status}
          {dishes.map((d, i) => (
            <View key={i} style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 12, padding: 10, marginBottom: 8 }}>
              <Input label="Dish name" value={d.name} onChangeText={(t) => upd(i, { name: t })} />
              <Input label="Price (USD)" keyboardType="decimal-pad" value={d.priceCents ? String(d.priceCents / 100) : ''} onChangeText={(t) => upd(i, { priceCents: Math.round(Number(t) * 100) || undefined })} />
              <Input label="Portion" placeholder="1 bowl (450 g)" value={d.portion || ''} onChangeText={(t) => upd(i, { portion: t })} />
              <Text style={s.label}>Allergens</Text>
              <Chips values={d.allergens || []} onChange={(x) => upd(i, { allergens: x })} options={ALLERGENS.map((a) => ({ value: a, label: a.replace('_', ' ') }))} />
              {!Array.isArray(d.allergens) ? <Button variant="ghost" title="Contains none of these" onPress={() => upd(i, { allergens: [] })} /> : !d.allergens.length ? <Muted>✓ No listed allergens</Muted> : null}
              <Choice value={d.mode || 'FIXED'} onChange={(x) => upd(i, { mode: x })} options={[{ value: 'FIXED', label: 'Fixed dish', description: 'Quantity and time only' }, { value: 'CUSTOMIZABLE', label: 'Customizable', description: 'Customers adjust options you enable' }]} />
              <Button variant="ghost" title="Remove dish" onPress={() => set({ dishes: dishes.filter((_, j) => j !== i) })} />
            </View>
          ))}
          {dishes.length < 3 && <Button variant="secondary" title="+ Add a dish" onPress={() => set({ dishes: [...dishes, { name: '', mode: 'FIXED' }] })} />}
        </View>
      );
    }
    case 'readiness':
      return <View>{status}<Toggle on={!!v.packagingAck} onChange={(x) => set({ packagingAck: x })} title="Packaging standards" text="Sealed, labeled with Gutad, your name, order, ingredients and allergens" /><Toggle on={!!v.handlingTrainingAck} onChange={(x) => set({ handlingTrainingAck: x })} title="Order-handling training" text="Cook exactly the ticket; never substitute without approval" /><Toggle on={!!v.allergenTrainingAck} onChange={(x) => set({ allergenTrainingAck: x })} title="Allergen training" text="Removing an ingredient does not make a dish allergen-free" /><Toggle on={!!v.sampleReviewOk} onChange={(x) => set({ sampleReviewOk: x })} title="Sample review if requested" /></View>;
    default:
      return null;
  }
}

function Docs({ app, reload }: { app: App; reload: () => Promise<void> }) {
  if (!app.data.kitchen?.kitchenType) return <Muted>Choose your kitchen type in the Kitchen step first.</Muted>;
  return <View>{app.requirements.map((r) => <DocItem key={r.key} req={r} doc={app.documents.find((d) => d.requirementKey === r.key)} reload={reload} />)}</View>;
}

function DocItem({ req, doc, reload }: { req: ChefDocRequirement; doc?: Doc; reload: () => Promise<void> }) {
  const [exp, setExp] = useState(doc?.expiresAt?.slice(0, 10) || '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (doc?.expiresAt) setExp(doc.expiresAt.slice(0, 10)); }, [doc?.expiresAt]);
  const send = async (f: PickedFile | null) => {
    if (!f) return;
    if (req.needsExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) { setErr('Enter the expiry date as YYYY-MM-DD first'); return; }
    setBusy(true); setErr(null);
    try { await uploadMultipart('/chef/application/documents', f, { requirementKey: req.key, expiresAt: exp || undefined }); await reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <View style={{ borderWidth: 1, borderColor: C.ink1, borderRadius: 12, padding: 10, marginBottom: 8 }}>
      <View style={s.row}><Text style={{ fontWeight: '600', flex: 1 }}>{req.label}</Text><Badge text={doc ? doc.status.toLowerCase() : req.required ? 'required' : 'optional'} tone={doc?.status === 'APPROVED' ? 'good' : doc?.status === 'REJECTED' ? 'bad' : doc ? 'info' : req.required ? 'warn' : 'neutral'} /></View>
      {doc?.note && <Text style={{ color: C.bad, fontSize: 12 }}>Reviewer: {doc.note}</Text>}
      {req.needsExpiry && <Input label="Expiry date (YYYY-MM-DD)" value={exp} onChangeText={setExp} placeholder="2027-06-30" />}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {Platform.OS !== 'web' && <Button style={{ flex: 1 }} variant="secondary" disabled={busy} title="Take photo" onPress={async () => { try { await send(await pickImage('camera')); } catch (e) { setErr((e as Error).message); } }} />}
        <Button style={{ flex: 1 }} variant="secondary" disabled={busy} title={busy ? 'Uploading…' : Platform.OS === 'web' ? 'Choose file' : 'From photos'} onPress={async () => { try { await send(Platform.OS === 'web' ? await pickFileOnWeb() : await pickImage('library')); } catch (e) { setErr((e as Error).message); } }} />
      </View>
      <ErrorText msg={err} />
    </View>
  );
}
