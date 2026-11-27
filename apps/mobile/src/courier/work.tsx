import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { EQUIPMENT_LABELS, LIFECYCLE_LABELS, NOT_DISPATCHABLE_LABELS, SPECIAL_CATEGORIES, TRIP_ISSUES, type EquipmentItem, type LifecycleStatus, type Manifest, type TripIssue } from '@gutad/shared';
import { api, money } from '../api';
import { useAction } from '../hooks';
import { Badge, Button, C, Card, ErrorText, Input, Muted, s, tone } from '../ui';
import { Choice, Toggle } from '../chef-ui';
import { currentPos, errBody, errCode, label, mins, readyText, useCountdown, type Addr, type DriverStatus, type Job, type Offer } from './common';
import { sendOrQueue } from './queue';
import { PhotoCapture, type UploadedPhoto } from './photo';
import { AgeCheckForm, CateringPanel, CategoryBadges, RefusePanel, SPECIAL_FRIENDLY, TemperaturePanel, ageCheckOk, type AgeCheckValue } from './special';

const isCategory = (r: string) => (SPECIAL_CATEGORIES as readonly string[]).includes(r);

/** Online / break / finish-after-current, why offers aren't coming, and today's time and earnings. */
export function StatusPanel({ st, onChange }: { st: DriverStatus; onChange: () => void }) {
  const { run, error, busy } = useAction();
  const act = (fn: () => Promise<unknown>) => run(async () => { await fn(); onChange(); });
  const reasons = st.reasons.filter((r) => r !== 'OFFLINE' || !st.isAvailable);
  const t = st.today;
  return (
    <Card title="Status">
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Badge text={!st.isAvailable ? 'Offline' : st.onBreak ? 'On a break' : st.activeJobs ? 'On a delivery' : 'Online'} tone={!st.isAvailable ? 'neutral' : st.onBreak ? 'warn' : 'good'} />
        {st.isAvailable && <Badge text={st.mode === 'RESERVED' ? 'Shift' : 'On demand'} tone="info" />}
        {st.finishAfterCurrent && <Badge text="Stopping after this trip" tone="warn" />}
        {st.dispatchable ? <Badge text="Receiving offers" tone="good" /> : null}
      </View>
      {!st.dispatchable && reasons.length > 0 && <View style={{ marginTop: 6 }}>{reasons.map((r) => <Text key={r} style={{ color: C.warn, fontSize: 13 }}>• {NOT_DISPATCHABLE_LABELS[r] || label(r)}</Text>)}</View>}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <Button title={st.isAvailable ? 'Go offline' : 'Go online'} variant={st.isAvailable ? 'secondary' : 'primary'} disabled={busy} onPress={() => act(async () => { const p = await currentPos(); await api.post('/driver/availability', { isAvailable: !st.isAvailable, ...(p || {}), ...(st.isAvailable ? {} : { mode: 'ON_DEMAND' }) }); })} />
        {st.isAvailable && <Button title={st.onBreak ? 'End break' : 'Take a break'} variant="secondary" disabled={busy} onPress={() => act(() => api.post('/driver/break', { on: !st.onBreak }))} />}
        {st.isAvailable && st.activeJobs > 0 && <Button title={st.finishAfterCurrent ? 'Keep receiving offers' : 'Stop after this trip'} variant="ghost" disabled={busy} onPress={() => act(() => api.post('/driver/finish-after-current', { on: !st.finishAfterCurrent }))} />}
      </View>
      <ErrorText msg={error} />
      <Text style={{ marginTop: 6, color: C.ink, fontWeight: '600' }}>Today: {money(t.earningsCents)} · {t.deliveries} deliver{t.deliveries === 1 ? 'y' : 'ies'}</Text>
      <Muted>Online {mins(t.onlineMinutes)} · active {mins(t.activeMinutes)} · waiting {mins(t.waitingMinutes)} · break {mins(t.breakMinutes)}</Muted>
    </Card>
  );
}

/** Restricted / suspended / deactivated notice, with a reactivation request when deactivated. */
export function LifecycleNotice({ st, onChange }: { st: DriverStatus; onChange: () => void }) {
  const { run, error, busy } = useAction();
  const [note, setNote] = useState('');
  const l = st.lifecycleStatus as LifecycleStatus;
  if (!l || l === 'ACTIVE') return null;
  return (
    <Card title={LIFECYCLE_LABELS[l] || label(l)}>
      {l === 'RESTRICTED' && <Muted>Some offers are paused for your account for now. Check your messages from Gutad for details.</Muted>}
      {l === 'SUSPENDED' && <Muted>You can’t go online while your account is suspended. You can appeal below.</Muted>}
      {l === 'REACTIVATION_PENDING' && <Muted>We’ve got your request to come back and will reply soon.</Muted>}
      {l === 'DEACTIVATED' && (
        <>
          <Muted>Your account is deactivated. If you’d like to deliver again, tell us what’s changed.</Muted>
          <Input label="Request reactivation" multiline value={note} onChangeText={setNote} />
          <ErrorText msg={error} />
          <Button title="Send request" disabled={busy || note.trim().length < 10} onPress={() => run(async () => { await api.post('/driver/reactivation', { note: note.trim() }); setNote(''); onChange(); })} />
        </>
      )}
    </Card>
  );
}

export function FirstDeliveryGuide() {
  const steps = ['Go online when you’re ready; offers show the guaranteed pay before you accept.', 'At the restaurant, tap Arrived, then check the order code, bags, drinks and seals.', 'Go straight to the customer. Keep the bag closed and upright.', 'At the door, tap Arrived and hand off with the proof the app asks for (photo, PIN, signature or ID).', 'Something wrong? Use Report a problem; we’ll tell you what to do.'];
  return (
    <Card title="Your first delivery">
      {steps.map((x, i) => <Text key={i} style={{ color: C.ink7, marginBottom: 4 }}>{i + 1}. {x}</Text>)}
    </Card>
  );
}

const itemCount = (m: Manifest['brands'][number]) => m.items.reduce((n, i) => n + i.quantity, 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Courier R2: what to collect, brand by brand, with item and bag counts. */
function ManifestList({ m }: { m: Manifest }) {
  return (
    <View style={{ marginTop: 4 }}>
      {m.brands.map((b) => <Muted key={b.brandKey}>• {b.brandName} #{b.orderNumber}: {plural(itemCount(b), 'item')} · {plural(b.bagCount, 'bag')}</Muted>)}
      <Text style={{ color: C.ink, fontWeight: '600' }}>Total: {plural(m.totals.bags, 'bag')}{m.brands.length > 1 ? ` from ${m.brands.length} brands` : ''}</Text>
    </View>
  );
}

function ReadyChip({ r }: { r: Offer['readiness'] }) {
  const x = readyText(r);
  return x ? <Badge text={x.text} tone={x.tone} /> : null;
}

export function OfferCard({ o, onDone }: { o: Offer; onDone: () => void }) {
  const left = useCountdown(o.expiresAt);
  const { run, error, busy } = useAction();
  const [full, setFull] = useState(false);
  if (left <= 0) return null;
  const reply = (accept: boolean) => run(async () => {
    setFull(false);
    try { await api.post(`/driver/offers/${o.id}`, { accept }); onDone(); } catch (e) { if (errCode(e) === 'AT_CAPACITY') { setFull(true); return; } throw e; }
  });
  const p = o.policy;
  return (
    <View style={{ marginBottom: 12, paddingBottom: 10, borderBottomWidth: 1, borderColor: C.ink1 }}>
      <View style={s.row}><Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>{money(o.pay?.totalCents ?? o.payCents)}</Text><Badge text={`${left}s`} tone={left < 20 ? 'bad' : 'warn'} /></View>
      <Muted>Guaranteed: base {money(o.pay?.baseCents || 0)} + distance {money(o.pay?.distanceCents || 0)}{o.pay?.timeCents ? ` + time ${money(o.pay.timeCents)}` : ''}</Muted>
      {(o.pay?.specialCents ?? 0) > 0 && <Text style={{ color: C.brand, fontWeight: '700' }}>+ {money(o.pay.specialCents!)} {o.pay.special?.length ? o.pay.special.map((x) => `${x.label} ${money(x.cents)}`).join(', ') : 'special order premium'}</Text>}
      {o.requirements.includes('PRIORITY') && <Text style={{ color: C.bad, fontWeight: '800' }}>⚡ Priority: go straight to the customer, no other orders{(o.pay?.priorityCents ?? 0) > 0 ? ` · +${money(o.pay.priorityCents!)} priority bonus` : ''}</Text>}
      {(o.pay?.incentiveCents ?? 0) > 0 && <Text style={{ color: C.brand, fontWeight: '700' }}>+ {money(o.pay.incentiveCents!)} {o.pay.incentives?.map((i) => i.name).join(', ') || 'boost'}</Text>}
      {o.tipCents > 0 && <Text style={{ color: C.good }}>+ estimated tip {money(o.tipCents)} (100% yours, may change)</Text>}
      <CategoryBadges categories={o.categories} />
      {(o.readiness || o.market) && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}><ReadyChip r={o.readiness} />{o.market && <Badge text={o.market.name} tone="info" />}</View>}
      <Text style={{ marginTop: 6, color: C.ink }}><Text style={{ fontWeight: '700' }}>Pick up:</Text> {o.pickup.name} · {o.pickup.line1}, {o.pickup.city}</Text>
      {o.manifest && o.manifest.brands.length > 0 && <ManifestList m={o.manifest} />}
      <Text style={{ color: C.ink }}><Text style={{ fontWeight: '700' }}>Drop off:</Text> {o.dropoffArea.city} {o.dropoffArea.postalCode} <Text style={{ color: C.ink5 }}>(exact address after you accept)</Text></Text>
      <Muted>{o.stops} stop{o.stops === 1 ? '' : 's'} · {o.distanceKm.toFixed(1)} km trip · {o.toPickupKm.toFixed(1)} km to pickup · about {o.estMinutes} min</Muted>
      {o.batchWith && <Text style={{ color: C.info }}>Adds to your current trip (same pickup)</Text>}
      {o.requirements.includes('ALCOHOL') && <Text style={{ color: C.warn }}>Contains alcohol: check ID at handoff</Text>}
      {o.requirements.filter((r) => !isCategory(r) && r !== 'PRIORITY').length > 0 && <Muted>Needs: {o.requirements.filter((r) => !isCategory(r) && r !== 'PRIORITY').map(label).join(', ')}</Muted>}
      {o.equipment.length > 0 && <Muted>Bring: {o.equipment.map((e) => EQUIPMENT_LABELS[e as EquipmentItem] || label(e)).join(', ')}</Muted>}
      {p && <Muted>Waiting paid after {p.waitingGraceMinutes} min at pickup{p.dropoffGraceMinutes != null ? ` and ${p.dropoffGraceMinutes} min at drop-off` : ''}, {money(p.waitingPerMinuteCents)}/min{p.waitingCapMinutes ? `, up to ${p.waitingCapMinutes} min` : ''} · return {money(p.returnCents)} · canceled after arrival {money(p.cancelAfterArrivalCents)}</Muted>}
      {full && <Text style={{ color: C.warn }}>You already have as many orders as you can carry.</Text>}
      <ErrorText msg={error} />
      <View style={{ flexDirection: 'row', gap: 6 }}><Button title="Accept" disabled={busy} onPress={() => reply(true)} /><Button title="Decline" variant="ghost" disabled={busy} onPress={() => reply(false)} /></View>
    </View>
  );
}

const nav = (a: Addr) => Linking.openURL(a.lat ? `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.line1}, ${a.city}`)}`);

const FRIENDLY: Record<string, string> = {
  PIN_MISMATCH: 'That PIN doesn’t match. Ask the customer to read it from their order screen.',
  ID_CHECK_REQUIRED: 'This order has restricted items. Check the customer’s ID: enter the date of birth and ID type.',
  SEAL_BROKEN: 'A broken seal can’t be picked up. Report damaged packaging so the kitchen can fix it.',
  ...SPECIAL_FRIENDLY,
};

/** One active delivery: arrival, pickup check, handoff with proof, problems, release, and the customer-unreachable wait flow. */
export function JobCard({ j, onChange, onQueued, onRefused }: { j: Job; onChange: () => void; onQueued?: () => void; onRefused?: (outcome: string) => void }) {
  const { run, error, busy } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'issue' | 'release'>('none');
  const [issue, setIssue] = useState<TripIssue | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // pickup check
  const [codeOk, setCodeOk] = useState(false);
  const [bags, setBags] = useState('1');
  const [drinks, setDrinks] = useState('0');
  const [seal, setSeal] = useState(true);
  const [pickNote, setPickNote] = useState('');
  // Courier R2: per-brand check when the order comes from several brands
  const multi = (j.manifest?.brands.length || 0) > 1 ? j.manifest! : null;
  const [brandBags, setBrandBags] = useState<Record<string, string>>(() => Object.fromEntries((j.manifest?.brands || []).map((b) => [b.brandKey, String(b.bagCount || 1)])));
  const [brandSeal, setBrandSeal] = useState<Record<string, boolean>>(() => Object.fromEntries((j.manifest?.brands || []).map((b) => [b.brandKey, true])));
  const [missing, setMissing] = useState<string[]>([]);
  // handoff (Courier R4: `j.handoff` adds the ID check, signature, named recipient, seal, PIN and catering rules)
  const h = j.handoff ?? null;
  const needPin = !!(j.pinRequired || h?.pin);
  const needSig = !!h?.signature;
  const forcedProof = needPin || needSig;
  const [method, setMethod] = useState<'PHOTO' | 'PIN' | 'SIGNATURE'>(needPin ? 'PIN' : needSig ? 'SIGNATURE' : 'PHOTO');
  const [age, setAge] = useState<AgeCheckValue>({ dob: '', idType: '', idLast4: '' });
  const [recipient, setRecipient] = useState('');
  const [sealOk, setSealOk] = useState(false);
  const [catering, setCatering] = useState(j.special?.catering ?? null);
  const [pin, setPin] = useState('');
  const [sig, setSig] = useState('');
  const [idOk, setIdOk] = useState(false);
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const [safePhoto, setSafePhoto] = useState<UploadedPhoto | null>(null);
  const [issuePhoto, setIssuePhoto] = useState<UploadedPhoto | null>(null);

  const ex = j.exception && !j.exception.resolution ? j.exception : null;
  const waiting = ex ? new Date(ex.waitUntil) > new Date() : false;
  const atPickup = j.status === 'ASSIGNED';
  /** Trip actions go through the offline queue. */
  const send = (path: string, body: Record<string, unknown>, what: string) => run(async () => {
    setMsg(null);
    try {
      const p = await currentPos();
      const r = await sendOrQueue<{ outcome?: string }>(path, { ...body, ...(p || {}) }, what);
      if (r.queued) { setMsg(`No connection: “${what}” will be sent when you’re back online.`); onQueued?.(); return r; }
      onChange();
      return r;
    } catch (e) {
      const c = errCode(e);
      if (c === 'MANIFEST_INCOMPLETE') { setMissing(errBody<{ missing?: string[] }>(e)?.missing || []); setMsg('Collect every brand’s bags before you leave.'); return undefined; }
      if (c && FRIENDLY[c]) {
        const broken = c === 'SEAL_BROKEN' ? (errBody<{ broken?: string[] }>(e)?.broken || multi?.brands.filter((x) => brandSeal[x.brandKey] === false).map((x) => x.brandKey) || []) : [];
        const names = broken.map((k) => j.manifest?.brands.find((b) => b.brandKey === k)?.brandName || k);
        setMsg(names.length ? `Broken seal: ${names.join(', ')}. ${FRIENDLY[c]}` : FRIENDLY[c]);
        if (c === 'SEAL_BROKEN') { setPanel('issue'); setIssue('DAMAGED_PACKAGING'); }
        return undefined;
      }
      throw e;
    }
  });
  const plain = (fn: () => Promise<unknown>) => run(async () => { await fn(); onChange(); });
  const issues = (Object.keys(TRIP_ISSUES) as TripIssue[]).filter((k) => TRIP_ISSUES[k].stage === 'ANY' || TRIP_ISSUES[k].stage === (atPickup ? 'PICKUP' : 'DROPOFF') || (j.requiresIdCheck && k === 'ID_CHECK_FAILED' && !atPickup));
  const pinOk = /^\d{4,6}$/.test(pin);
  const sigOk = sig.trim().length > 1;
  const proofOk = forcedProof ? (!needPin || pinOk) && (!needSig || sigOk) : (method === 'PHOTO' && !!photo) || (method === 'PIN' && pinOk) || (method === 'SIGNATURE' && sigOk);
  const idCheckOk = h?.ageCheck ? ageCheckOk(age, h.ageCheck.minAge) : !j.requiresIdCheck || idOk;
  const cateringOk = !h?.catering || (!!catering?.checklist?.itemsCounted && (!h.catering.setupRequired || !!catering.checklist?.setupDone));
  const handoffOk = proofOk && idCheckOk && (!h?.recipientName || recipient.trim().length > 1) && (!h?.sealCheck || sealOk) && cateringOk;
  const restricted = (j.categories?.length ?? 0) > 0;

  return (
    <View style={{ marginBottom: 14, paddingBottom: 10, borderBottomWidth: 1, borderColor: C.ink1 }}>
      <View style={s.row}><Text style={{ fontWeight: '700', flex: 1, color: C.ink }}>{atPickup ? 'Pick up at' : 'Deliver to'}: {atPickup ? j.pickupAddress.line1 : j.dropoffAddress.line1}</Text><Badge text={j.batchId ? `${label(j.status)} · batch` : label(j.status)} tone={tone(j.status)} /></View>
      <Muted>Pay {money(j.providerCostCents)} + tip {money(j.tipCents)}{!atPickup && j.dropoffAddress.instructions ? ` · ${j.dropoffAddress.instructions}` : ''}</Muted>
      <CategoryBadges categories={j.categories} />
      {j.requiresIdCheck && <Text style={{ color: C.warn }}>Restricted items: check the customer’s ID at handoff</Text>}
      {h?.recipientName && <Text style={{ color: C.warn }}>Only {h.recipientName} can receive this</Text>}
      {h?.noSafePlace && <Muted>Hand it over in person: it can’t be left at the door.</Muted>}
      {j.special?.breach && <Text style={{ color: C.warn }}>{j.special.breach.detail}</Text>}
      {atPickup && (j.readiness || j.shelfSlot) && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}><ReadyChip r={j.readiness} />{j.shelfSlot && <Badge text={`Shelf ${j.shelfSlot}`} tone="info" />}</View>}
      {atPickup && j.manifest && j.manifest.brands.length > 0 && <ManifestList m={j.manifest} />}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Button title="Navigate" variant="secondary" onPress={() => nav(atPickup ? j.pickupAddress : j.dropoffAddress)} />
        {atPickup && !j.arrivedPickupAt && <Button title="Arrived at pickup" variant="secondary" disabled={busy} onPress={() => send(`/driver/jobs/${j.id}/arrived`, { at: 'PICKUP' }, 'Arrived at pickup')} />}
        {j.status === 'PICKED_UP' && !j.arrivedDropoffAt && <Button title="Arrived at drop-off" variant="secondary" disabled={busy} onPress={() => send(`/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF' }, 'Arrived at drop-off')} />}
      </View>

      {atPickup && (
        <View style={{ marginTop: 8, padding: 10, backgroundColor: C.bg, borderRadius: 10 }}>
          <Text style={{ fontWeight: '700', color: C.ink, marginBottom: 4 }}>Pickup check</Text>
          {j.orderCode ? <Toggle on={codeOk} onChange={setCodeOk} title={`Order code ${j.orderCode} matches the bag`} /> : null}
          {multi ? (
            <>
              {multi.brands.map((b) => (
                <View key={b.brandKey} style={{ marginBottom: 6, paddingBottom: 4, borderBottomWidth: 1, borderColor: C.ink1 }}>
                  <Text style={{ fontWeight: '600', color: C.ink }}>{b.brandName} #{b.orderNumber}</Text>
                  {missing.includes(b.brandKey) && <Text style={{ color: C.bad }}>Collect this brand’s bags</Text>}
                  <Input label="Bags" keyboardType="number-pad" value={brandBags[b.brandKey] ?? ''} onChangeText={(v) => { setBrandBags({ ...brandBags, [b.brandKey]: v }); setMissing(missing.filter((k) => k !== b.brandKey)); }} />
                  <Toggle on={brandSeal[b.brandKey] !== false} onChange={(v) => setBrandSeal({ ...brandSeal, [b.brandKey]: v })} title="Seal intact" text={brandSeal[b.brandKey] === false ? 'Don’t take it; report damaged packaging.' : undefined} />
                </View>
              ))}
              <Input label="Drinks" keyboardType="number-pad" value={drinks} onChangeText={setDrinks} />
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><Input label="Bags" keyboardType="number-pad" value={bags} onChangeText={setBags} /></View><View style={{ flex: 1 }}><Input label="Drinks" keyboardType="number-pad" value={drinks} onChangeText={setDrinks} /></View></View>
              <Toggle on={seal} onChange={setSeal} title="All seals intact" text={seal ? undefined : 'Don’t take a bag with a broken seal; report it instead.'} />
            </>
          )}
          <Input label="Note (optional)" value={pickNote} onChangeText={setPickNote} />
          <Button title="Picked up" disabled={busy || (!!j.orderCode && !codeOk) || (multi ? multi.brands.some((b) => !(Number(brandBags[b.brandKey]) >= 1)) : !(Number(bags) >= 1))} onPress={() => {
            const brands = multi ? multi.brands.map((b) => ({ brandKey: b.brandKey, bagCount: Number(brandBags[b.brandKey]) || 0, sealIntact: brandSeal[b.brandKey] !== false })) : undefined;
            setMissing([]);
            void send(`/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', pickupCheck: {
              orderCode: j.orderCode && codeOk ? j.orderCode : undefined,
              bagCount: brands ? brands.reduce((n, b) => n + b.bagCount, 0) : Number(bags),
              drinkCount: Number(drinks) || 0,
              sealIntact: brands ? brands.every((b) => b.sealIntact) : seal,
              note: pickNote.trim() || undefined,
              ...(brands ? { brands } : {}),
            } }, 'Picked up');
          }} />
        </View>
      )}

      {h?.tempControl && ['ASSIGNED', 'PICKED_UP'].includes(j.status) && <TemperaturePanel j={j} />}
      {h?.catering && j.status === 'PICKED_UP' && !ex && <CateringPanel j={j} onState={setCatering} />}

      {j.status === 'PICKED_UP' && !ex && (
        <View style={{ marginTop: 8, padding: 10, backgroundColor: C.bg, borderRadius: 10 }}>
          <Text style={{ fontWeight: '700', color: C.ink, marginBottom: 4 }}>Hand off</Text>
          {forcedProof ? <Muted>This order needs {[needPin && 'the customer’s PIN', needSig && 'a signature'].filter(Boolean).join(' and ')}.</Muted> : <Choice value={method} onChange={setMethod} options={[{ value: 'PHOTO', label: 'Photo at the door' }, { value: 'PIN', label: 'Customer’s PIN' }, { value: 'SIGNATURE', label: 'Signature' }]} />}
          {(forcedProof ? needPin : method === 'PIN') && <Input label="PIN from the customer" keyboardType="number-pad" maxLength={6} value={pin} onChangeText={setPin} />}
          {(forcedProof ? needSig : method === 'SIGNATURE') && <Input label={h?.recipientName ? `${h.recipientName} signs by typing their name` : 'Customer signs by typing their name'} value={sig} onChangeText={setSig} />}
          {h?.recipientName && <Input label={`Recipient’s name (only ${h.recipientName} can receive this)`} value={recipient} onChangeText={setRecipient} />}
          {h?.sealCheck && <Toggle on={sealOk} onChange={setSealOk} title="Seal intact" text={sealOk ? undefined : 'If the seal is broken, don’t hand it over: tap “Can’t hand over”.'} />}
          {h?.ageCheck && <AgeCheckForm req={h.ageCheck} value={age} onChange={setAge} />}
          {!forcedProof && method === 'PHOTO' && <><Muted>Take a clear photo of the order at the door, with the door number in view if you can.</Muted><PhotoCapture purpose="HANDOFF" label="Take handoff photo" value={photo} onChange={setPhoto} library={false} /></>}
          {j.requiresIdCheck && !h?.ageCheck && <Toggle on={idOk} onChange={setIdOk} title="I checked the customer’s ID" text="They are of legal age and the ID matches. If not, don’t hand over; report the failed ID check." />}
          <Button title="Complete delivery" disabled={busy || !handoffOk} onPress={() => send(`/driver/jobs/${j.id}/transition`, {
            status: 'DELIVERED',
            ...(forcedProof ? { ...(needPin ? { handoffPin: pin } : {}), ...(needSig ? { proofSignature: sig.trim() } : {}) } : method === 'PHOTO' ? { proofPhotoUrl: photo!.url } : method === 'PIN' ? { handoffPin: pin } : { proofSignature: sig.trim() }),
            ...(h?.ageCheck ? { ageCheck: { dob: age.dob, idType: age.idType, ...(age.idLast4.trim() ? { idLast4: age.idLast4.trim() } : {}) } } : j.requiresIdCheck ? { idChecked: idOk } : {}),
            ...(h?.recipientName ? { recipientName: recipient.trim() } : {}),
            ...(h?.sealCheck ? { sealIntact: sealOk } : {}),
          }, 'Delivered')} />
        </View>
      )}
      {j.status === 'PICKED_UP' && restricted && <RefusePanel j={j} onDone={(o) => { onRefused?.(o); onChange(); }} />}

      {j.status === 'PICKED_UP' && !ex && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{[['CUSTOMER_UNREACHABLE', 'Can’t reach customer'], ['WRONG_ADDRESS', 'Wrong address'], ['ACCESS_PROBLEM', 'Can’t get in']].map(([k, l]) => <Button key={k} title={l} variant="ghost" onPress={() => plain(() => api.post(`/driver/jobs/${j.id}/exception`, { kind: k, method: 'CALL' }))} />)}</View>}
      {ex && (
        <View style={{ backgroundColor: '#fffbeb', padding: 8, borderRadius: 10, marginTop: 6 }}>
          <Text style={{ fontWeight: '600' }}>{label(ex.kind)} · {ex.attempts.length} attempt(s)</Text>
          <Muted>{waiting ? `Keep trying until ${new Date(ex.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Wait time is over'}</Muted>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['CALL', 'SMS', 'DOOR'].map((m) => <Button key={m} title={`Log ${m.toLowerCase()}`} variant="secondary" onPress={() => plain(() => api.post(`/driver/jobs/${j.id}/exception`, { kind: ex.kind, method: m }))} />)}</View>
          {!waiting && !h?.noSafePlace && <PhotoCapture purpose="SAFE_PLACE" label="Photo of where you left it" value={safePhoto} onChange={setSafePhoto} library={false} />}
          {!waiting && h?.noSafePlace && <Muted>This order can’t be left unattended. Return it to the kitchen.</Muted>}
          {!waiting && <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{!h?.noSafePlace && <Button title="Leave safely" disabled={!safePhoto} onPress={() => plain(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'SAFE_PLACE', proofPhotoUrl: safePhoto!.url }))} />}<Button title="Return" variant="secondary" onPress={() => plain(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'RETURN' }))} /><Button title="Dispose" variant="ghost" onPress={() => plain(() => api.post(`/driver/jobs/${j.id}/exception/resolve`, { resolution: 'DISPOSE' }))} /></View>}
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <Button title={panel === 'issue' ? 'Close' : 'Report a problem'} variant="ghost" onPress={() => { setPanel(panel === 'issue' ? 'none' : 'issue'); setOutcome(null); }} />
        {atPickup && <Button title={panel === 'release' ? 'Close' : 'Release this delivery'} variant="ghost" onPress={() => setPanel(panel === 'release' ? 'none' : 'release')} />}
      </View>
      {panel === 'issue' && (
        <View style={{ padding: 10, backgroundColor: '#fff4ec', borderRadius: 10 }}>
          <Choice value={issue || undefined} onChange={(v) => setIssue(v)} options={issues.map((k) => ({ value: k, label: TRIP_ISSUES[k].label }))} />
          <Input label="What happened? (optional)" multiline value={issueNote} onChangeText={setIssueNote} />
          <PhotoCapture purpose="ISSUE" label="Add a photo (optional)" value={issuePhoto} onChange={setIssuePhoto} />
          <Button title="Send report" disabled={busy || !issue} onPress={() => send(`/driver/jobs/${j.id}/issue`, { kind: issue, note: issueNote.trim() || undefined, photoUrl: issuePhoto?.url }, `Problem: ${issue ? TRIP_ISSUES[issue].label : ''}`).then((r) => { if (r && !r.queued) { setOutcome(r.result?.outcome || 'Reported. We’ll be in touch.'); setIssue(null); setIssueNote(''); setIssuePhoto(null); } })} />
        </View>
      )}
      {outcome && <Text style={{ color: C.info, marginTop: 4 }}>{outcome}</Text>}
      {panel === 'release' && (
        <View style={{ padding: 10, backgroundColor: '#fff4ec', borderRadius: 10 }}>
          <Muted>The order goes back to other couriers. Releasing often can affect your access.</Muted>
          <Input label="Reason" value={reason} onChangeText={setReason} />
          <Button title="Release" variant="danger" disabled={busy || reason.trim().length < 3} onPress={() => plain(async () => { await api.post(`/driver/jobs/${j.id}/release`, { reason: reason.trim() }); setReason(''); setPanel('none'); })} />
        </View>
      )}
      {msg && <Text style={{ color: C.warn, marginTop: 4 }}>{msg}</Text>}
      <ErrorText msg={error} />
    </View>
  );
}
