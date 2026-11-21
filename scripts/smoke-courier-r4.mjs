// Courier Release 4: specialised categories — certifications, alcohol age check and delivery hours, refused handoffs
// with kitchen receipt, sensitive (signature, named recipient, seal, no safe place), high value (tenure, PIN),
// temperature-controlled (readings, breach), catering (vehicle, checklist, setup), premiums, batching, customer view.
export async function courierR4({ call, check, A, O, C }) {
  console.log('\n── Courier R4: specialised categories');
  const stamp = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke courier R4' }, A);
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const API = process.env.API_URL || 'http://localhost:4000';
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const menus = (await call('GET', `/public/locations/${hall.id}/menus`)).json;
  const bowl = menus.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.name === 'Harvest bowl');
  // the public menu doesn't carry these; the seed sets STANDARD and admin phase F sets COLD handling
  const bowlOrig = { taxCategory: bowl.taxCategory ?? 'STANDARD', handling: bowl.handling ?? ['COLD'] };
  const near = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048 };
  const here = { lat: hall.lat ?? 40.7418, lng: hall.lng ?? -74.0067 };
  const me = (await call('GET', '/auth/me', undefined, C)).json;
  const allSettings = (await call('GET', '/admin/settings', undefined, A)).json.settings ?? {};
  const prevDispatch = allSettings['delivery.dispatch'] ?? { offerSeconds: 90, offersPerRound: 3, maxOfferRounds: 3, radiusKm: 12, waitMinutes: 5, proofRetentionDays: 90, docExpiryWarnDays: 30, travelMinutesPerKm: 3 };
  // every nearby courier gets the offer, so ours are never crowded out by couriers from earlier phases
  await set('delivery.dispatch', { ...prevDispatch, offersPerRound: 60 });
  const allDay = { alcohol: { deliveryHours: { start: '00:00', end: '00:00' } } };
  const SP = (over = {}) => set('delivery.special', { ...allDay, ...over, alcohol: { ...allDay.alcohol, ...(over.alcohol ?? {}) } });
  await SP();
  const item = (patch) => call('PATCH', `/items/${bowl.id}`, patch, O);
  // this phase places a dozen bowls: top the kitchen's stock up so the bowl doesn't sell out part-way
  const restock = async () => {
    const meO = (await call('GET', '/auth/me', undefined, O)).json;
    const orgId = meO.merchantIds?.[0] ?? meO.memberships?.[0]?.organizationId;
    const kitchenId = hall.kitchenId ?? (await call('GET', `/organizations/${orgId}`, undefined, O)).json.locations?.find((l) => l.id === hall.id || l.kitchenId)?.kitchenId;
    if (!kitchenId) return;
    const inv = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json;
    if (Array.isArray(inv) && inv.length) await call('POST', `/kitchens/${kitchenId}/counts`, { counts: inv.map((i) => ({ ingredientId: i.id, counted: Math.max(Number(i.onHand) || 0, 100000) })), note: 'Smoke courier R4 restock' }, O);
    await call('POST', `/items/${bowl.id}/sold-out`, { soldOut: false }, O);
  };
  await restock();

  const courier = async (name, vehicleType, capabilities) => {
    const email = `courier-r4-${name.toLowerCase().replace(/\W/g, '')}-${stamp}@example.com`;
    await call('POST', '/auth/register', { email, password: 'courier12345', name });
    const T = (await login(email, 'courier12345')).accessToken;
    const drv = (await call('POST', '/driver/apply', { vehicle: vehicleType === 'BIKE' ? 'Bike' : 'Car' }, T)).json;
    const exp = new Date(Date.now() + 200 * 86400_000).toISOString();
    for (const kind of ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK']) await call('POST', '/driver/documents', { kind, fileUrl: `https://files.example/r4-${kind}.pdf`, expiresAt: kind === 'BACKGROUND_CHECK' ? undefined : exp }, T);
    for (const d of (await call('GET', '/admin/couriers/documents', undefined, A)).json.pending.filter((d) => d.driverId === drv.id)) await call('POST', `/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked' }, A);
    await call('POST', `/drivers/${drv.id}/approve`, { approved: true }, A);
    await call('PATCH', `/admin/couriers/${drv.id}`, { vehicleType, capabilities }, A);
    await call('POST', '/driver/availability', { isAvailable: true, ...here }, T);
    return { T, id: drv.id };
  };
  const upload = async (T, purpose) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF r4 ${purpose} ${Math.random()}`), Buffer.from([0xff, 0xd9])]);
    const fd = new FormData();
    fd.append('purpose', purpose);
    fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `${purpose.toLowerCase()}.jpg`);
    return (await (await fetch(`${API}/driver/photos`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd })).json()).url;
  };
  const X = await courier('Cass Certified', 'CAR', ['HOT_BAG', 'COLD_BAG']);
  const B = await courier('Bo Bicycle', 'BIKE', ['HOT_BAG']);

  // ── 1. certifications
  const c0 = (await call('GET', '/driver/certifications', undefined, X.T)).json;
  const wrong = await call('POST', '/driver/certifications/CATERING/training', { answers: [0, 0] }, X.T);
  const cat = (await call('POST', '/driver/certifications/CATERING/training', { answers: [1, 1] }, X.T)).json;
  const alc1 = (await call('POST', '/driver/certifications/ALCOHOL/training', { answers: [1, 1, 0] }, X.T)).json;
  const cert = await upload(X.T, 'CERTIFICATE');
  const alc2 = (await call('POST', '/driver/certifications/ALCOHOL/certificate', { fileUrl: cert }, X.T)).json;
  const sens = (await call('POST', '/driver/certifications/SENSITIVE/training', { answers: [1, 1] }, X.T)).json;
  const temp = (await call('POST', '/driver/certifications/TEMP_CONTROLLED/training', { answers: [1, 1] }, X.T)).json;
  const custQueue = await call('GET', '/admin/courier-certifications', undefined, C);
  const queue = (await call('GET', '/admin/courier-certifications', undefined, A)).json.filter((q) => q.driverId === X.id);
  for (const q of queue) await call('POST', `/admin/courier-certifications/${q.id}/decide`, { decision: 'APPROVE', reason: 'Certificate and screening checked' }, A);
  const xc = (await call('GET', `/admin/couriers/${X.id}/certifications`, undefined, A)).json;
  const bcat = (await call('POST', '/driver/certifications/CATERING/training', { answers: [1, 1] }, B.T)).json;
  const st = (v, c) => v.certifications?.find((x) => x.category === c);
  check('certifications: wrong answers say which; catering/temperature go active on training; alcohol needs a certificate and sensitive a review; staff approve; a bike courier is told catering needs a vehicle',
    c0.certifications?.length === 4 && st(c0, 'ALCOHOL')?.needs.includes('CERTIFICATE') && st(c0, 'ALCOHOL')?.training?.questions?.[0]?.answer === undefined && wrong.status === 409 && wrong.json.code === 'TRAINING_FAILED' && wrong.json.wrong?.length === 2 &&
    st(cat, 'CATERING')?.status === 'ACTIVE' && st(alc1, 'ALCOHOL')?.status === 'TRAINING' && st(alc2, 'ALCOHOL')?.status === 'PENDING' && st(sens, 'SENSITIVE')?.status === 'PENDING' && st(temp, 'TEMP_CONTROLLED')?.status === 'ACTIVE' &&
    custQueue.status === 403 && queue.length === 2 && queue.some((q) => q.certificateUrl) && ['ALCOHOL', 'SENSITIVE', 'CATERING', 'TEMP_CONTROLLED'].every((c) => st(xc, c)?.status === 'ACTIVE') && st(bcat, 'CATERING')?.status === 'ACTIVE' && st(bcat, 'CATERING')?.needs.includes('VEHICLE') && xc.highValue?.eligible === false,
    { c0: c0.certifications?.map((x) => [x.category, x.status, x.needs]), wrong: wrong.json, cat: st(cat, 'CATERING'), alc1: st(alc1, 'ALCOHOL')?.status, alc2: st(alc2, 'ALCOHOL')?.status, sens: st(sens, 'SENSITIVE')?.status, queue, xc: xc.certifications?.map((x) => [x.category, x.status]), b: st(bcat, 'CATERING'), hv: xc.highValue });

  // ── helpers for trips
  const place = async () => {
    const q = (await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: bowl.id, quantity: 1 }], deliveryAddress: near }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
    await call('POST', `/orders/${o.id}/accept`, { prepMinutes: 10 }, O);
    return (await call('GET', `/orders/${o.id}`, undefined, C)).json;
  };
  const offerFor = async (T, o) => (await call('GET', '/driver/offers', undefined, T)).json.find((x) => x.deliveryJobId === o.delivery?.id);
  const take = async (o) => {
    const off = await offerFor(X.T, o);
    await call('POST', `/driver/offers/${off?.id}`, { accept: true }, X.T);
    const j = (await call('GET', '/driver/jobs', undefined, X.T)).json.find((x) => x.id === o.delivery.id);
    return { off, j };
  };
  const pickup = async (j) => {
    await call('POST', `/driver/jobs/${j.id}/arrived`, { at: 'PICKUP', ...here }, X.T);
    const r = await call('POST', `/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j.orderCode, bagCount: 1, sealIntact: true } }, X.T);
    await call('POST', `/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF', ...near }, X.T);
    return r;
  };
  const handoff = (j, body) => call('POST', `/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', ...near, ...body }, X.T);
  const cancel = (o) => call('POST', `/delivery-jobs/${o.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);
  const photo = await upload(X.T, 'HANDOFF');
  const nyNow = new Intl.DateTimeFormat('en-CA', { timeZone: hall.timezone || 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const awayH = String((Number(nyNow.slice(0, 2)) + 12) % 24).padStart(2, '0');
  const dobYearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() + 2); return d.toISOString().slice(0, 10); };

  // ── 2. alcohol: certified courier only, premium, age check, hours, no DOB stored
  await item({ taxCategory: 'ALCOHOL' });
  const oa = await place();
  const offB = await offerFor(B.T, oa);
  const { off: offA, j: ja } = await take(oa);
  await item({ taxCategory: bowlOrig.taxCategory });
  await pickup(ja);
  const noId = await handoff(ja, { proofPhotoUrl: photo });
  const young = await handoff(ja, { proofPhotoUrl: photo, ageCheck: { dob: dobYearsAgo(21), idType: 'PASSPORT' } });
  const badType = await handoff(ja, { proofPhotoUrl: photo, ageCheck: { dob: '1990-04-02', idType: 'LIBRARY_CARD' } });
  await SP({ alcohol: { deliveryHours: { start: `${awayH}:00`, end: `${awayH}:01` } } });
  const late = await handoff(ja, { proofPhotoUrl: photo, ageCheck: { dob: '1990-04-02', idType: 'PASSPORT' } });
  await SP();
  const okA = await handoff(ja, { proofPhotoUrl: photo, ageCheck: { dob: '1990-04-02', idType: 'DRIVERS_LICENSE', idLast4: '1234' } });
  const spA = (await call('GET', `/admin/delivery/jobs/${ja.id}/special`, undefined, A)).json;
  const earnA = (await call('GET', '/driver/earnings', undefined, X.T)).json.entries.filter((e) => e.deliveryJobId === ja.id);
  check('alcohol: only the certified courier is offered it, with the premium and the ID check spelled out; no ID / under 21 / bad ID type / outside hours refused; a valid check delivers, pays the premium and keeps no date of birth',
    !offB && offA?.categories?.includes('ALCOHOL') && offA.pay?.specialCents === 100 && offA.payCents === offA.pay.totalCents + offA.pay.incentiveCents + 100 && offA.handoff?.ageCheck?.minAge === 21 && ja.handoff?.noSafePlace === true &&
    noId.json.code === 'ID_CHECK_REQUIRED' && young.json.code === 'UNDERAGE' && badType.json.code === 'ID_TYPE_INVALID' && late.status === 409 && late.json.code === 'ALCOHOL_HOURS' && okA.json?.status === 'DELIVERED' &&
    spA.special?.ageCheck?.age >= 30 && spA.special.ageCheck.idType === 'DRIVERS_LICENSE' && spA.special.ageCheck.idLast4 === '1234' && !JSON.stringify(spA).includes('1990-04-02') && earnA.some((e) => e.kind === 'SPECIAL' && e.totalCents === 100),
    { offB: !!offB, offA: offA && { cats: offA.categories, pay: offA.pay, payCents: offA.payCents }, codes: [noId.json.code, young.json.code, badType.json.code, late.json.code, okA.json?.status ?? okA.json], spA: spA.special, earnA: earnA.map((e) => [e.kind, e.totalCents]) });

  // ── 3. refused handoffs: custody stays with the courier until the kitchen confirms receipt; overdue returns alert
  await item({ taxCategory: 'ALCOHOL' });
  const or1 = await place();
  const or2 = await place();
  await item({ taxCategory: bowlOrig.taxCategory });
  const { j: jr1 } = await take(or1);
  await pickup(jr1);
  const ref = (await call('POST', `/driver/jobs/${jr1.id}/refuse-handoff`, { reason: 'INTOXICATED', note: 'Could barely stand' }, X.T)).json;
  const { j: jr2 } = await take(or2);
  await pickup(jr2);
  const viaIssue = (await call('POST', `/driver/jobs/${jr2.id}/issue`, { kind: 'ID_CHECK_FAILED', note: 'No ID' }, X.T)).json;
  const kitchenList = (await call('GET', `/locations/${hall.id}/delivery-returns`, undefined, O)).json;
  const custRecv = await call('POST', `/delivery-jobs/${jr1.id}/return-received`, { sealIntact: true }, C);
  const recv = (await call('POST', `/delivery-jobs/${jr1.id}/return-received`, { sealIntact: true, note: 'Back on the shelf' }, O)).json;
  const recvTwice = await call('POST', `/delivery-jobs/${jr1.id}/return-received`, { sealIntact: true }, O);
  await SP({ returnReceiveHours: 0 });
  const sweep = (await call('POST', '/admin/delivery/special/sweep', {}, A)).json;
  await SP();
  const sp2 = (await call('GET', `/admin/delivery/jobs/${jr2.id}/special`, undefined, A)).json;
  const earnR = (await call('GET', '/driver/earnings', undefined, X.T)).json.entries.filter((e) => e.deliveryJobId === jr1.id);
  check('refused handoff: RETURNED with the courier still holding it and a case opened; the R1 ID-check issue uses the same path; the kitchen sees and confirms the return; an unconfirmed return raises an alert; return pay but no premium',
    ref.job?.status === 'RETURNED' && ref.job.custody === 'COURIER' && ref.job.special?.refusal?.reason === 'INTOXICATED' && ref.job.special.refusal.incidentId && viaIssue.job?.status === 'RETURNED' && viaIssue.job.custody === 'COURIER' && viaIssue.incidentId &&
    kitchenList.some((r) => r.jobId === jr1.id && r.refusal?.reason === 'INTOXICATED') && kitchenList.some((r) => r.jobId === jr2.id) && [403, 404].includes(custRecv.status) && recv.custody === 'RETURNED' && recv.special?.returnReceived?.sealIntact === true && recvTwice.json.code === 'NOT_RETURNING' &&
    sweep.alerts >= 1 && sp2.custody === 'COURIER' && sp2.special?.refusal?.reason === 'NO_ID' && earnR.some((e) => e.kind === 'DELIVERY' && e.returnCents > 0) && !earnR.some((e) => e.kind === 'SPECIAL'),
    { ref: ref.job && { s: ref.job.status, c: ref.job.custody, r: ref.job.special?.refusal }, viaIssue: viaIssue.job && { s: viaIssue.job.status, c: viaIssue.job.custody, i: viaIssue.incidentId }, kitchenList, custRecv: custRecv.status, recv: recv.custody ?? recv, twice: recvTwice.json, sweep, sp2: sp2.custody, earnR });
  await call('POST', `/delivery-jobs/${jr2.id}/return-received`, { sealIntact: true }, O);

  // ── 4. sensitive: signature, the named recipient, the seal; never left in a safe place
  await item({ handling: [...bowlOrig.handling, 'SENSITIVE'] });
  const os = await place();
  await item({ handling: bowlOrig.handling });
  const { off: offS, j: js } = await take(os);
  await pickup(js);
  const sPhoto = await handoff(js, { proofPhotoUrl: photo });
  const sWrong = await handoff(js, { proofSignature: 'data:sig', recipientName: 'Someone Else', sealIntact: true });
  const sSeal = await handoff(js, { proofSignature: 'data:sig', recipientName: me.name });
  await call('POST', `/admin/delivery-jobs/${js.id}/exception`, { kind: 'CUSTOMER_UNREACHABLE', method: 'CALL', note: 'No answer' }, A);
  const sSafe = await call('POST', `/admin/delivery-jobs/${js.id}/exception/resolve`, { resolution: 'SAFE_PLACE', proofPhotoUrl: photo }, A);
  const sOk = await handoff(js, { proofSignature: 'data:sig', recipientName: me.name.toUpperCase(), sealIntact: true });
  check('sensitive: the offer names the recipient; photo-only, the wrong person or an unconfirmed seal are refused; no safe-place drop; the named recipient signs and it is delivered',
    offS?.categories?.includes('SENSITIVE') && offS.handoff?.signature && offS.handoff.recipientName === me.name && sPhoto.json.code === 'SIGNATURE_REQUIRED' && sWrong.json.code === 'RECIPIENT_MISMATCH' && sSeal.json.code === 'SEAL_CHECK_REQUIRED' && sSafe.status === 403 && sSafe.json.code === 'SAFE_PLACE_NOT_ALLOWED' && sOk.json?.status === 'DELIVERED' && sOk.json.handoffMethod === 'SIGNATURE',
    { offS: offS?.handoff, codes: [sPhoto.json.code, sWrong.json.code, sSeal.json.code, sSafe.json.code, sOk.json?.status ?? sOk.json] });

  // ── 5. high value: tenure rule, PIN required; the customer sees what to have ready
  await SP({ highValue: { thresholdCents: 1 } });
  const oh1 = await place();
  const offH1 = await offerFor(X.T, oh1);
  const hv = (await call('GET', '/driver/certifications', undefined, X.T)).json.highValue;
  await cancel(oh1);
  await SP({ highValue: { thresholdCents: 1, minDeliveries: 0, minAccountDays: 0 } });
  const oh = await place();
  const custView = (await call('GET', `/orders/${oh.id}`, undefined, C)).json;
  const { off: offH, j: jh } = await take(oh);
  await SP();
  await pickup(jh);
  const hNoPin = await handoff(jh, { proofPhotoUrl: photo });
  const hOk = await handoff(jh, { handoffPin: custView.delivery?.handoffPin });
  check('high value: a courier without the tenure gets no offer and is told why; once eligible the offer asks for the PIN; the customer is told to have it ready; no PIN is refused',
    !offH1 && hv?.eligible === false && /deliveries/.test(hv.reason ?? '') && offH?.categories?.includes('HIGH_VALUE') && offH.handoff?.pin === true && custView.delivery?.handoffRequirements?.pin === true && custView.delivery.handoffRequirements.noSafePlace === true && hNoPin.json.code === 'PIN_REQUIRED' && hOk.json?.status === 'DELIVERED' && hOk.json.handoffMethod === 'PIN',
    { offH1: !!offH1, hv, offH: offH?.handoff, cust: custView.delivery?.handoffRequirements, codes: [hNoPin.json.code, hOk.json?.status ?? hOk.json] });

  // ── 6. temperature-controlled: readings, a warm drop-off reading opens a case, the handoff still goes through
  await item({ handling: [...bowlOrig.handling, 'TEMP_CONTROLLED'] });
  const ot = await place();
  await item({ handling: bowlOrig.handling });
  const offTB = await offerFor(B.T, ot);
  const { off: offT, j: jt } = await take(ot);
  const t1 = (await call('POST', `/driver/jobs/${jt.id}/temperature`, { stage: 'PICKUP', tempC: 3 }, X.T)).json;
  await pickup(jt);
  const t2 = (await call('POST', `/driver/jobs/${jt.id}/temperature`, { stage: 'DROPOFF', tempC: 9.4 }, X.T)).json;
  const tOk = await handoff(jt, { proofPhotoUrl: photo });
  const spT = (await call('GET', `/admin/delivery/jobs/${jt.id}/special`, undefined, A)).json;
  check('temperature-controlled: only a cold-bag courier is offered it; a cold pickup reading is fine; a warm drop-off reading records a breach with a support case; the handoff is not blocked',
    !offTB && offT?.handoff?.tempControl?.coldMaxC === 5 && t1.breach === null && t2.breach?.kind === 'TEMPERATURE' && t2.breach.incidentId && t2.temps?.length === 2 && tOk.json?.status === 'DELIVERED' && spT.special?.breach?.kind === 'TEMPERATURE',
    { offTB: !!offTB, offT: offT?.handoff?.tempControl, t1, t2, tOk: tOk.json?.status ?? tOk.json, spT: spT.special?.breach });

  // ── 7. catering: vehicle rule, checklist, setup timer, setup pay inside the premium
  await SP({ catering: { minSubtotalCents: 1, setupRequired: true } });
  const oc = await place();
  const offCB = await offerFor(B.T, oc);
  const { off: offC, j: jc } = await take(oc);
  await SP();
  await pickup(jc);
  const cNoSig = await handoff(jc, { proofPhotoUrl: photo });
  const cNoList = await handoff(jc, { proofSignature: 'data:sig' });
  await call('POST', `/driver/jobs/${jc.id}/catering`, { checklist: { itemsCounted: true, utensils: true } }, X.T);
  const cNoSetup = await handoff(jc, { proofSignature: 'data:sig' });
  const finishEarly = await call('POST', `/driver/jobs/${jc.id}/catering`, { finishSetup: true }, X.T);
  await call('POST', `/driver/jobs/${jc.id}/catering`, { startSetup: true }, X.T);
  await sleep(1500);
  const setup = (await call('POST', `/driver/jobs/${jc.id}/catering`, { finishSetup: true, checklist: { labelsShown: true } }, X.T)).json;
  const cOk = await handoff(jc, { proofSignature: 'data:sig' });
  const earnC = (await call('GET', '/driver/earnings', undefined, X.T)).json.entries.find((e) => e.deliveryJobId === jc.id && e.kind === 'SPECIAL');
  check('catering: a bike courier is skipped; the offer pays the catering premium and says setup is needed; signature, item count and finished setup are required; setup is timed and paid inside the premium',
    !offCB && offC?.categories?.includes('CATERING') && offC.pay?.special?.some((p) => p.category === 'CATERING' && p.cents === 500) && offC.handoff?.catering?.setupRequired === true && cNoSig.json.code === 'SIGNATURE_REQUIRED' && cNoList.json.code === 'CATERING_CHECKLIST' && cNoSetup.json.code === 'CATERING_SETUP' && finishEarly.json.code === 'CATERING_SETUP' &&
    setup.catering?.checklist?.setupDone === true && setup.catering.setupStartedAt && setup.catering.setupDoneAt && setup.catering.setupMinutes >= 0 && cOk.json?.status === 'DELIVERED' && earnC && earnC.totalCents === 500 + Math.floor(setup.catering.setupMinutes) * 20 && earnC.detail?.setupMinutes === Math.floor(setup.catering.setupMinutes),
    { offCB: !!offCB, offC: offC && { cats: offC.categories, special: offC.pay?.special, cat: offC.handoff?.catering }, codes: [cNoSig.json.code, cNoList.json.code, cNoSetup.json.code, finishEarly.json.code, cOk.json?.status ?? cOk.json], setup: setup.catering, earnC });

  // ── 8. batching: sensitive orders ride alone; temperature-controlled ones may still pair
  await item({ handling: [...bowlOrig.handling, 'SENSITIVE'] });
  const ob1 = await place();
  await item({ handling: [...bowlOrig.handling, 'TEMP_CONTROLLED'] });
  const ob2 = await place();
  const ob3 = await place();
  await item({ handling: bowlOrig.handling });
  const pSens = (await call('POST', '/admin/delivery/batching/preview', { jobId: ob1.delivery.id, withJobId: ob2.delivery.id }, A)).json;
  const pTemp = (await call('POST', '/admin/delivery/batching/preview', { jobId: ob2.delivery.id, withJobId: ob3.delivery.id }, A)).json;
  for (const o of [ob1, ob2, ob3]) await cancel(o);
  check('batching: a sensitive order is never paired; two temperature-controlled orders are not excluded for their category',
    pSens.reasons?.some((r) => /SENSITIVE orders are not batched/.test(r)) && !pTemp.reasons?.some((r) => /TEMP_CONTROLLED/.test(r)), { pSens: pSens.reasons, pTemp: pTemp.reasons });

  // ── 9. expiry, revocation, report
  const exp = new Date(Date.now() + 2500).toISOString();
  await call('POST', `/admin/couriers/${B.id}/certifications`, { category: 'TEMP_CONTROLLED', reason: 'Migrated from paper records', expiresAt: exp }, A);
  const revoke = (await call('GET', `/admin/couriers/${X.id}/certifications`, undefined, A)).json.certifications.find((c) => c.category === 'CATERING');
  const rv = (await call('POST', `/admin/courier-certifications/${revoke.id}/decide`, { decision: 'REVOKE', reason: 'Left trays unattended' }, A)).json;
  const retrain = await call('POST', '/driver/certifications/CATERING/training', { answers: [1, 1] }, X.T);
  await sleep(3500);
  const sw = (await call('POST', '/admin/delivery/special/sweep', {}, A)).json;
  const bAfter = (await call('GET', `/admin/couriers/${B.id}/certifications`, undefined, A)).json;
  const report = (await call('GET', '/admin/delivery/special/report', undefined, A)).json;
  const rc = (c) => report.categories?.find((x) => x.category === c);
  check('certifications expire on the hourly sweep and revoked ones cannot be retrained by the courier; the compliance report counts ID checks, refusals, breaches and premiums',
    sw.expired >= 1 && st(bAfter, 'TEMP_CONTROLLED')?.status === 'EXPIRED' && st(rv, 'CATERING')?.status === 'REVOKED' && retrain.status === 409 && retrain.json.code === 'CERT_REVOKED' &&
    rc('ALCOHOL')?.idChecks >= 1 && rc('ALCOHOL').refused?.INTOXICATED >= 1 && rc('ALCOHOL').refused?.NO_ID >= 1 && rc('TEMP_CONTROLLED')?.breaches >= 1 && rc('CATERING')?.premiumCents >= 500 && rc('SENSITIVE')?.delivered >= 1,
    { sw, b: st(bAfter, 'TEMP_CONTROLLED')?.status, rv: st(rv, 'CATERING')?.status, retrain: retrain.json, report: report.categories });

  // ── tidy up for later phases
  await item(bowlOrig);
  await set('delivery.special', {});
  await set('delivery.dispatch', prevDispatch);
  for (const t of [X.T, B.T]) await call('POST', '/driver/availability', { isAvailable: false }, t);
}
