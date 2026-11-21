// Courier Release 1: onboarding & eligibility, lifecycle, starting work, offers, pickup check, PIN handoff,
// trip problems, itemized earnings, delivery reviews and moderation.
export async function courierR1({ call, check, A, O, C }) {
  console.log('\n── Courier R1: onboarding, dispatch, handoff, earnings, reviews');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const shared = await import('../packages/shared/dist/index.js');
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke courier R1' }, A);
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const items = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const bowl = items.find((i) => i.name === 'Harvest bowl');
  const addr = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048 };
  const place = async () => {
    const q = (await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: bowl.id, quantity: 1 }], deliveryAddress: addr }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
    await call('POST', `/orders/${o.id}/accept`, {}, O);
    return (await call('GET', `/orders/${o.id}`, undefined, C)).json;
  };
  const here = { lat: hall.lat ?? 40.7406, lng: hall.lng ?? -74.0055 };

  // ── onboarding wizard
  const email = `courier-r1-${stamp}@example.com`;
  await call('POST', '/auth/register', { email, password: 'courier12345', name: 'Rae Rider' });
  const X = (await login(email, 'courier12345')).accessToken;
  const empty = (await call('GET', '/driver/onboarding', undefined, X)).json;
  const noApp = await call('POST', '/driver/onboarding/profile', { legalName: 'Rae Rider', addressLine1: '1 Main St', city: 'New York', postalCode: '10001', phone: '+12125550100', languages: ['en'] }, X);
  const loc = (await call('POST', '/driver/onboarding/location', { country: 'US', city: 'New York', transport: 'CAR' }, X)).json;
  check('onboarding starts with where you deliver and reports service availability', empty.driver === null && empty.steps.length === shared.ONBOARDING_STEPS.length && noApp.status === 400 && noApp.json.code === 'NO_APPLICATION' && loc.driver?.applicationStatus === 'DRAFT' && loc.availability?.serviceable === true && loc.requiredDocs.includes('VEHICLE_REGISTRATION'), { noApp: noApp.json, loc: loc.availability, docs: loc.requiredDocs });
  const driverId = loc.driver.id;

  await call('POST', '/driver/onboarding/profile', { legalName: 'Rae Rider', addressLine1: '1 Main St', city: 'New York', postalCode: '10001', phone: '+12125550100', languages: ['en', 'es'] }, X);
  const noPlate = await call('POST', '/driver/onboarding/vehicle', { make: 'Honda' }, X);
  await call('POST', '/driver/onboarding/vehicle', { make: 'Honda', model: 'Fit', plate: 'GTD123', color: 'Blue', year: 2020 }, X);
  const badConsent = await call('POST', '/driver/onboarding/screening', { consent: true, consentVersion: 'old' }, X);
  await call('POST', '/driver/onboarding/screening', { consent: true, consentVersion: shared.SCREENING_CONSENT_VERSION }, X);
  await call('POST', '/driver/onboarding/payout', { accountHolder: 'Rae Rider', accountLast4: '6789', taxFormAccepted: true }, X);
  const oldAgreement = await call('POST', '/driver/onboarding/agreement', { version: 'v0', accept: true }, X);
  await call('POST', '/driver/onboarding/agreement', { version: shared.COURIER_AGREEMENT_VERSION, accept: true }, X);
  const wrong = await call('POST', '/driver/onboarding/training', { module: 'PICKUP', answer: 0 }, X);
  for (const m of shared.TRAINING_MODULES) await call('POST', '/driver/onboarding/training', { module: m.key, answer: m.answer }, X);
  const noBag = await call('POST', '/driver/onboarding/equipment', { items: ['DRINK_CARRIER'] }, X);
  await call('POST', '/driver/onboarding/equipment', { items: ['INSULATED_BAG', 'COLD_BAG'] }, X);
  check('steps validate: vehicle details by type, current consent and agreement versions, training answers, required bag', noPlate.status === 400 && noPlate.json.code === 'VEHICLE_DETAILS' && badConsent.status === 400 && oldAgreement.status === 400 && wrong.status === 400 && wrong.json.code === 'WRONG_ANSWER' && noBag.status === 400 && noBag.json.code === 'EQUIPMENT_REQUIRED', [noPlate.status, badConsent.status, oldAgreement.status, wrong.json?.code, noBag.json?.code]);

  const exp = new Date(Date.now() + 300 * 86400_000).toISOString();
  for (const kind of ['ID', 'LICENSE', 'INSURANCE', 'VEHICLE_REGISTRATION']) await call('POST', '/driver/documents', { kind, fileUrl: `https://files.example/r1-${kind}.pdf`, expiresAt: exp }, X);
  const early = await call('POST', '/driver/onboarding/submit', {}, X);
  await set('delivery.recruitment', { requireVerifiedContact: false });
  const sub = (await call('POST', '/driver/onboarding/submit', {}, X)).json;
  check('submitting needs every step (verified contact unless turned off); then verification is pending', early.status === 400 && early.json.code === 'ONBOARDING_INCOMPLETE' && early.json.missing?.length === 1 && sub.driver?.applicationStatus === 'VERIFICATION_PENDING' && sub.checks.find((c) => c.check === 'SCREENING').status === 'PENDING' && sub.checks.find((c) => c.check === 'AGREEMENT').status === 'PASSED' && sub.checks.find((c) => c.check === 'PAYOUT').status === 'PASSED' && sub.checks.find((c) => c.check === 'TRAINING').status === 'PASSED', { early: early.json, sub: sub.driver, checks: sub.checks });

  // ── review: independent checks, rejection → needs action, approval only when everything passed
  const tooSoon = await call('POST', `/admin/couriers/${driverId}/decision`, { decision: 'APPROVE', note: 'Looks fine' }, A);
  const docsQ = (await call('GET', '/admin/couriers/documents', undefined, A)).json.pending.filter((d) => d.driverId === driverId);
  const idDoc = docsQ.find((d) => d.kind === 'ID');
  await call('POST', `/admin/courier-documents/${idDoc.id}/review`, { approve: false, note: 'Photo is blurry' }, A);
  const afterReject = (await call('GET', '/driver/onboarding', undefined, X)).json;
  await call('POST', '/driver/documents', { kind: 'ID', fileUrl: 'https://files.example/r1-ID-2.pdf', expiresAt: exp }, X);
  const pend = (await call('GET', '/admin/couriers/documents', undefined, A)).json.pending.filter((d) => d.driverId === driverId);
  for (const d of pend) await call('POST', `/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked', expiresAt: exp }, A);
  const failNoNote = await call('POST', `/admin/couriers/${driverId}/checks/SCREENING`, { status: 'FAILED' }, A);
  await call('POST', `/admin/couriers/${driverId}/checks/SCREENING`, { status: 'PASSED', note: 'Clear', expiresAt: exp }, A);
  const eq = (await call('POST', `/admin/couriers/${driverId}/checks/EQUIPMENT`, { status: 'PASSED', note: 'Bag seen on video call' }, A)).json;
  const pipe = (await call('GET', '/admin/couriers/pipeline', undefined, A)).json;
  const row = pipe.applicants.find((a) => a.id === driverId);
  check('checks are independent: a rejected ID needs action; approval waits for every check', tooSoon.status === 400 && tooSoon.json.code === 'CHECKS_INCOMPLETE' && afterReject.steps.find((s) => s.key === 'identity').needsAction && afterReject.checks.find((c) => c.check === 'IDENTITY').status === 'NEEDS_ACTION' && failNoNote.status === 400 && eq.checks.every((c) => c.status === 'PASSED') && row?.checks.IDENTITY === 'PASSED' && row.stepsDone === row.stepsTotal && pipe.counts.VERIFICATION_PENDING >= 1 && pipe.funnel.started >= 1, { tooSoon: tooSoon.json, checks: eq.checks, row });
  const offlineEarly = await call('POST', '/driver/availability', { isAvailable: true, ...here }, X);
  const ok = (await call('POST', `/admin/couriers/${driverId}/decision`, { decision: 'APPROVE', note: 'All checks passed' }, A)).json;
  const prof = (await call('GET', `/admin/couriers/${driverId}`, undefined, A)).json;
  check('approval activates the account; staff profile shows onboarding, time and feedback', offlineEarly.status === 403 && ok.driver.applicationStatus === 'APPROVED' && ok.driver.lifecycleStatus === 'ACTIVE' && ok.driver.status === 'APPROVED' && prof.onboarding?.driver?.applicationStatus === 'APPROVED' && typeof prof.time?.onlineMinutes === 'number' && prof.feedback && prof.courier.capabilities.includes('COLD_BAG'), { early: offlineEarly.json, ok: ok.driver });

  // ── waitlist by recruitment capacity
  const wEmail = `courier-wl-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: wEmail, password: 'courier12345', name: 'Wes Waitlist' });
  const W = (await login(wEmail, 'courier12345')).accessToken;
  await set('delivery.recruitment', { requireVerifiedContact: false, cities: { 'new york': { maxActive: 1 } } });
  const wl = (await call('POST', '/driver/onboarding/location', { country: 'US', city: 'New York', transport: 'BIKE' }, W)).json;
  await set('delivery.recruitment', { requireVerifiedContact: false });
  check('a full city puts new couriers on the waitlist; a bike needs only a photo ID', wl.availability?.waitlist === true && wl.requiredDocs.length === 1 && wl.requiredDocs[0] === 'ID', wl.availability);

  // ── starting work: dispatchability, break
  const st0 = (await call('GET', '/driver/status', undefined, X)).json;
  await call('POST', '/driver/availability', { isAvailable: true, ...here }, X);
  await call('POST', '/driver/break', { on: true }, X);
  const stBreak = (await call('GET', '/driver/status', undefined, X)).json;
  const oBreak = await place();
  const breakOffers = (await call('GET', '/driver/offers', undefined, X)).json;
  await call('POST', `/delivery-jobs/${oBreak.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);
  await call('POST', '/driver/break', { on: false }, X);
  const st1 = (await call('GET', '/driver/status', undefined, X)).json;
  check('status explains why no offers come (offline, on a break); a courier on a break gets none', st0.dispatchable === false && st0.reasons.includes('OFFLINE') && stBreak.reasons.includes('ON_BREAK') && !breakOffers.some((x) => x.deliveryJobId === oBreak.delivery.id) && st1.dispatchable === true && st1.onlineSince, { st0: st0.reasons, br: stBreak.reasons, st1 });

  // ── offer: guaranteed pay, tip apart, drop-off area only
  const o1 = await place();
  const offers = (await call('GET', '/driver/offers', undefined, X)).json;
  const off = offers.find((x) => x.deliveryJobId === o1.delivery.id);
  check('offer shows guaranteed pay breakdown, tip apart, stops, distance, time, policy and drop-off area only', off && off.pay.totalCents === off.pay.baseCents + off.pay.distanceCents + off.pay.timeCents && off.payCents === off.pay.totalCents && off.stops === 2 && off.estMinutes > 0 && off.dropoffArea.postalCode === '10011' && !JSON.stringify(off).includes('75 9th Ave') && off.policy?.waitingPerMinuteCents >= 0 && off.equipment.includes('INSULATED_BAG') && 'tipCents' in off, off);
  const acc = await call('POST', `/driver/offers/${off.id}`, { accept: true }, X);
  const again = await call('POST', `/driver/offers/${off.id}`, { accept: true }, X);
  const custOrder = (await call('GET', `/orders/${o1.id}`, undefined, C)).json;
  check('accepting awards the job once; the customer sees the handoff PIN and the courier’s first name', acc.status === 201 && again.status === 409 && /^\d{4}$/.test(custOrder.delivery?.handoffPin || '') && custOrder.delivery.courierFirstName === 'Rae', { again: again.status, d: custOrder.delivery });

  // ── pickup check
  const jobs = (await call('GET', '/driver/jobs', undefined, X)).json;
  const j1 = jobs.find((j) => j.id === o1.delivery.id);
  await call('POST', `/driver/jobs/${j1.id}/arrived`, { at: 'PICKUP', ...here }, X);
  const notReady = (await call('POST', `/driver/jobs/${j1.id}/issue`, { kind: 'ORDER_NOT_READY' }, X)).json;
  const noCheck = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP' }, X);
  const seal = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { bagCount: 1, sealIntact: false } }, X);
  const badCode = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: 'ZZZZ', bagCount: 1, sealIntact: true } }, X);
  const picked = (await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j1.orderCode, bagCount: 1, drinkCount: 0, sealIntact: true } }, X)).json;
  check('pickup needs a check: bag count, intact seal, matching order code; the PIN never reaches the courier', !('handoffPin' in j1 && j1.handoffPin) && j1.pinAvailable === true && /outcome|kitchen/i.test(JSON.stringify(notReady)) && noCheck.status === 400 && noCheck.json.code === 'PICKUP_CHECK_REQUIRED' && seal.status === 409 && seal.json.code === 'SEAL_BROKEN' && badCode.status === 400 && badCode.json.code === 'ORDER_CODE_MISMATCH' && picked.status === 'PICKED_UP' && picked.custody === 'COURIER', { noCheck: noCheck.json, seal: seal.json, badCode: badCode.json, picked: picked.status });

  // ── handoff by PIN; replay is harmless
  const badPin = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'DELIVERED', handoffPin: '0000' === custOrder.delivery.handoffPin ? '1111' : '0000' }, X);
  const noProof = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'DELIVERED' }, X);
  const done = (await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'DELIVERED', handoffPin: custOrder.delivery.handoffPin }, X)).json;
  const replay = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'DELIVERED', handoffPin: custOrder.delivery.handoffPin }, X);
  const after = (await call('GET', `/orders/${o1.id}`, undefined, C)).json;
  check('handoff needs proof; a wrong PIN is refused; the PIN completes it; a replayed update is harmless; the PIN disappears afterwards', badPin.status === 400 && badPin.json.code === 'PIN_MISMATCH' && noProof.status === 400 && noProof.json.code === 'PROOF_REQUIRED' && done.status === 'DELIVERED' && done.handoffMethod === 'PIN' && done.custody === 'CUSTOMER' && [200, 201].includes(replay.status) && !after.delivery.handoffPin, { badPin: badPin.json, noProof: noProof.json, done: done.status, replay: replay.status });

  // ── itemized earnings, pending vs available, first delivery
  const earn = (await call('GET', '/driver/earnings', undefined, X)).json;
  const e1 = earn.entries.filter((e) => e.deliveryJobId === j1.id);
  const st2 = (await call('GET', '/driver/status', undefined, X)).json;
  check('earnings are itemized once per delivery, held as pending first; the first delivery is recorded', e1.length === 1 && e1[0].kind === 'DELIVERY' && e1[0].baseCents === off.pay.baseCents && e1[0].distanceCents === off.pay.distanceCents && e1[0].totalCents >= off.pay.totalCents && earn.pendingCents >= e1[0].totalCents && earn.payableCents >= earn.pendingCents && earn.days.length >= 1 && earn.payoutAccount?.accountLast4 === '6789' && st2.firstDeliveryAt && st2.today.deliveries >= 1, { e1, pending: earn.pendingCents, payable: earn.payableCents });

  // ── delivery review: only the customer, masked comment, issues → support case, moderation, dispute
  const notMine = await call('GET', `/orders/${o1.id}/delivery-review`, undefined, X);
  const rs = (await call('GET', `/orders/${o1.id}/delivery-review`, undefined, C)).json;
  const rv = (await call('POST', `/orders/${o1.id}/delivery-review`, { rating: 5, tags: ['GREAT_COMMUNICATION', 'NOT_A_TAG'], comment: 'Lovely! call me at 212 555 0199', foodRating: 4, packagingRating: 5 }, C)).json;
  const fb1 = (await call('GET', '/driver/feedback', undefined, X)).json;
  check('only the customer reviews; contact details are masked; tags are filtered; the courier sees an anonymous average', notMine.status === 404 && rs.eligible === true && rs.courierFirstName === 'Rae' && rv.tags.length === 1 && rv.comment.includes('[number removed]') && fb1.ratingAvg === 5 && fb1.ratingCount === 1 && !JSON.stringify(fb1).includes('customerId'), { rv, fb1 });
  const edit = (await call('POST', `/orders/${o1.id}/delivery-review`, { rating: 1, tags: ['UNPROFESSIONAL'], comment: 'what a shit courier', issues: ['NOT_RECEIVED'] }, C)).json;
  const held = (await call('GET', '/driver/feedback', undefined, X)).json;
  const queue = (await call('GET', '/admin/delivery-reviews?status=PENDING_MODERATION', undefined, A)).json;
  const qr = queue.find((r) => r.id === rv.id);
  check('an edit keeps history; abusive text waits for moderation; a non-delivery opens a support case', edit.rating === 1 && qr && qr.history.length >= 2 && qr.issues.includes('NOT_RECEIVED') && held.recent.find((r) => r.id === rv.id).comment === null, { qr, recent: held.recent[0] });
  const ap = (await call('POST', `/admin/delivery-reviews/${rv.id}/moderate`, { action: 'HIDE', note: 'Abusive language' }, A)).json;
  const dsp = (await call('POST', `/driver/feedback/${rv.id}/dispute`, { note: 'The customer took the bag from me at the door' }, X)).json;
  const disputes = (await call('GET', '/admin/delivery-reviews?status=DISPUTED', undefined, A)).json;
  await call('POST', `/admin/delivery-reviews/${rv.id}/moderate`, { action: 'UPHOLD_DISPUTE', note: 'PIN handoff recorded at the door' }, A);
  const fb2 = (await call('GET', '/driver/feedback', undefined, X)).json;
  check('moderation hides the comment; an upheld dispute takes the review out of the average', ap.status === 'HIDDEN' && dsp.disputeStatus === 'PENDING' && disputes.some((r) => r.id === rv.id) && fb2.ratingCount === 0 && fb2.ratingAvg === null, { ap: ap.status, fb2 });

  // ── release before pickup: history kept, offered again, not to the same courier
  const o2 = await place();
  const off2 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o2.delivery.id);
  await call('POST', `/driver/offers/${off2.id}`, { accept: true }, X);
  const rel = (await call('POST', `/driver/jobs/${o2.delivery.id}/release`, { reason: 'Flat tyre on the way' }, X)).json;
  const offAgain = (await call('GET', '/driver/offers', undefined, X)).json.some((x) => x.deliveryJobId === o2.delivery.id);
  const tl2 = (await call('GET', `/orders/${o2.id}/timeline`, undefined, C)).json;
  check('releasing before pickup puts the job back to dispatch with history kept', rel.ok && ['REQUESTED', 'ASSIGNED', 'QUOTED', 'UNASSIGNED'].includes(rel.jobStatus) && !offAgain && tl2.delivery.events.some((e) => e.type === 'DRIVER_RELEASED'), { rel, events: tl2.delivery?.events?.map((e) => e.type) });
  await call('POST', `/delivery-jobs/${o2.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);

  // ── after pickup the courier can't continue: escalated, never silently reassigned; staff return → return pay
  const o3 = await place();
  const off3 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o3.delivery.id);
  await call('POST', `/driver/offers/${off3.id}`, { accept: true }, X);
  const j3 = (await call('GET', '/driver/jobs', undefined, X)).json.find((j) => j.id === o3.delivery.id);
  await call('POST', `/driver/jobs/${j3.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j3.orderCode, bagCount: 1, sealIntact: true } }, X);
  const cant = (await call('POST', `/driver/jobs/${j3.id}/issue`, { kind: 'VEHICLE_BREAKDOWN', note: 'Engine died' }, X)).json;
  const ret = (await call('POST', `/admin/delivery-jobs/${j3.id}/exception/resolve`, { resolution: 'RETURN', note: 'Courier walked it back' }, A)).json;
  const e3 = (await call('GET', '/driver/earnings', undefined, X)).json.entries.find((e) => e.deliveryJobId === j3.id);
  check('a breakdown after pickup is escalated with the food still in the courier’s custody; a return earns return pay', cant.incidentId && cant.job.status === 'PICKED_UP' && cant.job.driverId === driverId && cant.job.exception?.kind === 'VEHICLE_BREAKDOWN' && ret.status === 'RETURNED' && ret.custody === 'RETURNED' && e3?.returnCents > 0, { cant: cant.job?.status, ret: ret.status, e3 });

  // ── restaurant closed: canceled after arrival → cancellation pay
  const o4 = await place();
  const off4 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o4.delivery.id);
  await call('POST', `/driver/offers/${off4.id}`, { accept: true }, X);
  const closed = (await call('POST', `/driver/jobs/${o4.delivery.id}/issue`, { kind: 'RESTAURANT_CLOSED', note: 'Shutters down' }, X)).json;
  const e4 = (await call('GET', '/driver/earnings', undefined, X)).json.entries.find((e) => e.deliveryJobId === o4.delivery.id);
  check('a closed restaurant cancels the trip with an incident and cancellation pay', closed.job.status === 'CANCELED' && closed.incidentId && e4?.kind === 'CANCEL_COMP' && e4.totalCents > 0, { closed: closed.job?.status, e4 });

  // ── handoff by photo: a real upload (images only, private), proof must be the courier's own photo, staff see a signed link
  const API = process.env.API_URL || 'http://localhost:4000';
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF smoke photo'), Buffer.from([0xff, 0xd9])]);
  const upPhoto = async (body, type, purpose = 'HANDOFF', name = 'door.jpg') => {
    const fd = new FormData();
    fd.append('purpose', purpose);
    fd.append('file', new Blob([body], { type }), name);
    const res = await fetch(`${API}/driver/photos`, { method: 'POST', headers: { Authorization: `Bearer ${X}` }, body: fd });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const pdfPhoto = await upPhoto(Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf', 'HANDOFF', 'x.pdf');
  const fakeJpeg = await upPhoto(Buffer.from('not an image at all'), 'image/jpeg');
  const badPurpose = await upPhoto(jpeg, 'image/jpeg', 'SELFIE');
  const ph = await upPhoto(jpeg, 'image/jpeg');
  const o5 = await place();
  const off5 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o5.delivery.id);
  await call('POST', `/driver/offers/${off5.id}`, { accept: true }, X);
  const j5 = (await call('GET', '/driver/jobs', undefined, X)).json.find((j) => j.id === o5.delivery.id);
  await call('POST', `/driver/jobs/${j5.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j5.orderCode, bagCount: 1, sealIntact: true } }, X);
  const foreign = await call('POST', `/driver/jobs/${j5.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: `/files/${globalThis.crypto.randomUUID()}` }, X);
  const byPhoto = (await call('POST', `/driver/jobs/${j5.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: ph.json.url }, X)).json;
  const proof = (await call('GET', `/delivery-jobs/${j5.id}/proof`, undefined, O)).json;
  const signedRes = proof.proofPhotoUrl ? await fetch(proof.proofPhotoUrl.replace(/^https?:\/\/[^/]+/, API)) : { status: 0 };
  const custFile = await fetch(`${API}/files/${ph.json.id}`, { headers: { Authorization: `Bearer ${C}` } });
  check('handoff photos are real private uploads: images only, the proof must be the courier’s own photo, staff and the merchant get a signed link', pdfPhoto.status === 400 && fakeJpeg.status === 400 && badPurpose.status === 400 && ph.status === 201 && /^\/files\/[0-9a-f-]{36}$/.test(ph.json.url) && /\/signed\?exp=/.test(ph.json.previewUrl || '') && foreign.status === 400 && foreign.json.code === 'PHOTO_INVALID' && byPhoto.status === 'DELIVERED' && byPhoto.handoffMethod === 'PHOTO' && byPhoto.proofPhotoUrl === ph.json.url && /\/files\/[0-9a-f-]{36}\/signed\?exp=\d+&sig=/.test(proof.proofPhotoUrl || '') && signedRes.status === 200 && custFile.status === 403, { pdf: pdfPhoto.status, fake: fakeJpeg.status, bp: badPurpose.status, ph: ph.json, foreign: foreign.json, by: byPhoto.handoffMethod, proof: proof.proofPhotoUrl, signed: signedRes.status, cust: custFile.status });

  // ── delivery areas for sign-up: active service zones of locations in the city
  const zonesNY = (await call('GET', '/driver/onboarding/zones?city=new%20york', undefined, X)).json;
  const zonesNone = (await call('GET', '/driver/onboarding/zones?city=Atlantis', undefined, X)).json;
  check('sign-up lists the delivery areas in the courier’s city (case-insensitive) and nothing for a city without service', Array.isArray(zonesNY) && zonesNY.length >= 1 && zonesNY.every((z) => z.id && z.name && z.location) && Array.isArray(zonesNone) && zonesNone.length === 0, { zonesNY, zonesNone });

  // ── earnings dispute, payout account change, finish after current, reserved check-in
  const dis = (await call('POST', '/driver/earnings/dispute', { deliveryJobId: j1.id, note: 'Waiting time at the kitchen was not paid' }, X)).json;
  const noPw = await call('POST', '/driver/onboarding/payout', { accountHolder: 'Rae Rider', accountLast4: '1111', taxFormAccepted: true }, X);
  const pw = await call('POST', '/driver/onboarding/payout', { accountHolder: 'Rae Rider', accountLast4: '1111', taxFormAccepted: true, password: 'courier12345' }, X);
  const fin = (await call('POST', '/driver/finish-after-current', { on: true }, X)).json;
  check('earnings disputes open a case; changing the payout account needs the password; finishing with no active trip goes offline', dis.incidentId && noPw.status === 403 && noPw.json.code === 'PASSWORD_REQUIRED' && pw.status === 201 && fin.isAvailable === false && fin.reasons.includes('OFFLINE'), { noPw: noPw.json, fin });
  const sh = (await call('POST', '/driver/shifts', { startsAt: new Date(Date.now() + 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 65 * 60_000).toISOString() }, X)).json;
  const ci = await call('POST', `/driver/shifts/${sh.id}/check-in`, here, X);
  const st3 = (await call('GET', '/driver/status', undefined, X)).json;
  check('a reserved shift can be checked in just before it starts; the courier is online in reserved mode', ci.json?.status === 'CHECKED_IN' && st3.isAvailable && st3.mode === 'RESERVED', { ci: ci.json, mode: st3.mode });

  // ── lifecycle
  const deact = await call('POST', `/admin/couriers/${driverId}/lifecycle`, { status: 'DEACTIVATED', reason: 'Left the programme' }, A);
  const cannot = await call('POST', '/driver/availability', { isAvailable: true, ...here }, X);
  const react = (await call('POST', '/driver/reactivation', { note: 'I am back in the city and ready to deliver' }, X)).json;
  const back = (await call('POST', `/admin/couriers/${driverId}/lifecycle`, { status: 'ACTIVE', reason: 'Reactivation approved' }, A)).json;
  const restr = (await call('POST', `/admin/couriers/${driverId}/lifecycle`, { status: 'RESTRICTED', reason: 'Two late deliveries this week' }, A)).json;
  check('lifecycle: deactivated couriers cannot go online and can ask to come back; restriction is separate', deact.status === 201 && cannot.status === 403 && react.lifecycleStatus === 'REACTIVATION_PENDING' && back.lifecycleStatus === 'ACTIVE' && back.status === 'APPROVED' && restr.lifecycleStatus === 'RESTRICTED' && restr.status === 'APPROVED', { deact: deact.status, cannot: cannot.json, back: back.lifecycleStatus });
  await call('POST', `/admin/couriers/${driverId}/lifecycle`, { status: 'ACTIVE', reason: 'Smoke cleanup' }, A);
  await call('POST', '/driver/availability', { isAvailable: false }, X);
  await set('delivery.recruitment', {});
}
