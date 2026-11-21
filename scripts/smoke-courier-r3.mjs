// Courier Release 3: demand forecast and busy times, incentive campaigns (boost, quest, guarantee), fraud signals and
// review with payout holds, instant cash-out, partner fee variance postings and invoice tolerance, ledger integrity.
export async function courierR3({ call, check, A, O, C }) {
  console.log('\n── Courier R3: forecast, incentives, fraud review, instant payouts, reconciliation');
  const stamp = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke courier R3' }, A);
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const API = process.env.API_URL || 'http://localhost:4000';
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const menus = (await call('GET', `/public/locations/${hall.id}/menus`)).json;
  const bowl = menus.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.name === 'Harvest bowl');
  const near = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048 };
  const far = { lat: 40.7527, lng: -73.9989 }; // ~1.2 km from the drop-off
  const here = { lat: hall.lat ?? 40.7418, lng: hall.lng ?? -74.0067 };
  const phaseStart = new Date();

  // ── two approved couriers with payout accounts (same holder and last 4 → linked accounts later)
  const courier = async (name, holder, last4) => {
    const email = `courier-r3-${name.toLowerCase().replace(/\W/g, '')}-${stamp}@example.com`;
    await call('POST', '/auth/register', { email, password: 'courier12345', name });
    const T = (await login(email, 'courier12345')).accessToken;
    const drv = (await call('POST', '/driver/apply', { vehicle: 'Car' }, T)).json;
    const exp = new Date(Date.now() + 200 * 86400_000).toISOString();
    for (const kind of ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK']) await call('POST', '/driver/documents', { kind, fileUrl: `https://files.example/r3-${kind}.pdf`, expiresAt: kind === 'BACKGROUND_CHECK' ? undefined : exp }, T);
    for (const d of (await call('GET', '/admin/couriers/documents', undefined, A)).json.pending.filter((d) => d.driverId === drv.id)) await call('POST', `/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked' }, A);
    await call('POST', `/drivers/${drv.id}/approve`, { approved: true }, A);
    await call('PATCH', `/admin/couriers/${drv.id}`, { vehicleType: 'CAR', capabilities: ['HOT_BAG'] }, A);
    if (holder) await call('POST', '/driver/onboarding/payout', { accountHolder: holder, accountLast4: last4, taxFormAccepted: true }, T);
    return { T, id: drv.id };
  };
  const X = await courier('Rhea Rapid', 'Smoke Shared Holder', '4242');
  await call('POST', '/driver/availability', { isAvailable: true, ...here }, X.T);

  // ── campaigns: a boost everywhere (budget for two), an opt-in quest, an opt-in bike-only quest
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const badBoost = await call('POST', '/admin/courier-campaigns', { kind: 'BOOST', name: 'Empty boost', windowStart: iso(now - 60_000), windowEnd: iso(now + 3600_000), rules: {}, budgetCents: 1000 }, A);
  const boost = (await call('POST', '/admin/courier-campaigns', { kind: 'BOOST', name: `Smoke lunch boost ${stamp}`, windowStart: iso(now - 60_000), windowEnd: iso(now + 3600_000), rules: { boostCents: 300 }, budgetCents: 700 }, A)).json;
  const custCreate = await call('POST', '/admin/courier-campaigns', { kind: 'BOOST', name: 'Nope', windowStart: iso(now), windowEnd: iso(now + 60_000), rules: { boostCents: 1 }, budgetCents: 100 }, C);
  const actBoost = (await call('POST', `/admin/courier-campaigns/${boost.id}/activate`, { reason: 'Lunch rush' }, A)).json;
  const quest = (await call('POST', '/admin/courier-campaigns', { kind: 'QUEST', name: `Smoke quest ${stamp}`, windowStart: iso(now - 3600_000), windowEnd: iso(now + 600_000), rules: { tiers: [{ deliveries: 2, bonusCents: 500 }, { deliveries: 5, bonusCents: 1500 }] }, enrolment: 'OPT_IN', budgetCents: 5000 }, A)).json;
  await call('POST', `/admin/courier-campaigns/${quest.id}/activate`, { reason: 'Smoke' }, A);
  const bikes = (await call('POST', '/admin/courier-campaigns', { kind: 'QUEST', name: `Bike quest ${stamp}`, windowStart: iso(now), windowEnd: iso(now + 3600_000), rules: { tiers: [{ deliveries: 3, bonusCents: 900 }] }, eligibility: { vehicleTypes: ['BIKE', 'EBIKE'] }, enrolment: 'OPT_IN', budgetCents: 5000 }, A)).json;
  await call('POST', `/admin/courier-campaigns/${bikes.id}/activate`, { reason: 'Smoke' }, A);
  const liveEdit = await call('PUT', `/admin/courier-campaigns/${boost.id}`, { rules: { boostCents: 900 }, reason: 'Try to change live terms' }, A);
  const join = await call('POST', `/driver/campaigns/${quest.id}/join`, {}, X.T);
  const joinBike = await call('POST', `/driver/campaigns/${bikes.id}/join`, {}, X.T);
  const mine = (await call('GET', '/driver/campaigns', undefined, X.T)).json;
  const mq = mine.find((c) => c.id === quest.id), mb = mine.find((c) => c.id === bikes.id), mbo = mine.find((c) => c.id === boost.id);
  check('campaigns: rules validated, staff only, live terms locked; couriers see terms and progress, join opt-in ones, ineligible ones say why', badBoost.status === 400 && custCreate.status === 403 && actBoost.status === 'ACTIVE' && liveEdit.status === 409 && liveEdit.json.code === 'CAMPAIGN_LIVE' && join.status < 300 && joinBike.status === 409 && joinBike.json.code === 'NOT_ELIGIBLE' && mq?.enrolled && mq.progress?.targetDeliveries === 2 && mb?.eligible === false && /bike/i.test(mb.ineligibleReason ?? '') && mbo?.enrolled && /\+\$3\.00/.test(mbo.terms), { badBoost: badBoost.status, cust: custCreate.status, act: actBoost.status, liveEdit: liveEdit.json, join: join.status, joinBike: joinBike.json, mq, mb, mbo });

  // ── deliveries: the boost shows on the offer and is paid with the delivery
  const place = async () => {
    const q = (await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: bowl.id, quantity: 1 }], deliveryAddress: near }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
    await call('POST', `/orders/${o.id}/accept`, { prepMinutes: 10 }, O);
    return (await call('GET', `/orders/${o.id}`, undefined, C)).json;
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF r3 ${stamp}`), Buffer.from([0xff, 0xd9])]);
  const fd = new FormData();
  fd.append('purpose', 'HANDOFF');
  fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'door.jpg');
  const photo = await (await fetch(`${API}/driver/photos`, { method: 'POST', headers: { Authorization: `Bearer ${X.T}` }, body: fd })).json();
  const deliver = async (o, pos) => {
    const off = (await call('GET', '/driver/offers', undefined, X.T)).json.find((x) => x.deliveryJobId === o.delivery.id);
    await call('POST', `/driver/offers/${off.id}`, { accept: true }, X.T);
    const j = (await call('GET', '/driver/jobs', undefined, X.T)).json.find((x) => x.id === o.delivery.id);
    await call('POST', `/driver/jobs/${j.id}/arrived`, { at: 'PICKUP', ...here }, X.T);
    await call('POST', `/driver/jobs/${j.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j.orderCode, bagCount: 1, sealIntact: true } }, X.T);
    await call('POST', `/driver/jobs/${j.id}/arrived`, { at: 'DROPOFF', ...near }, X.T);
    const done = await call('POST', `/driver/jobs/${j.id}/transition`, { status: 'DELIVERED', proofPhotoUrl: photo.url, ...pos }, X.T);
    return { off, j, done };
  };
  const o1 = await place();
  const d1 = await deliver(o1, far);
  const o2 = await place();
  const d2 = await deliver(o2, near);
  const earn = (await call('GET', '/driver/earnings', undefined, X.T)).json;
  const inc = earn.entries.filter((e) => e.kind === 'INCENTIVE' && e.detail?.campaignId === boost.id);
  const boostAfter = (await call('GET', `/admin/courier-campaigns/${boost.id}`, undefined, A)).json;
  check('a boost shows on the offer (pay.incentiveCents, campaign name) and is paid once per delivery as an INCENTIVE earning within budget', d1.off.pay?.incentiveCents === 300 && d1.off.pay.incentives?.[0]?.name === boost.name && d1.off.payCents === d1.off.pay.totalCents + 300 && d1.done.json?.status === 'DELIVERED' && d2.done.json?.status === 'DELIVERED' && inc.length === 2 && inc.every((e) => e.totalCents === 300) && boostAfter.spentCents === 600 && boostAfter.participants?.[0]?.earnedCents === 600, { off: d1.off.pay, payCents: d1.off.payCents, inc, spent: boostAfter.spentCents, d1: d1.done.json?.code ?? d1.done.status, d2: d2.done.json?.code ?? d2.done.status });

  const o3 = await place();
  const off3 = (await call('GET', '/driver/offers', undefined, X.T)).json.find((x) => x.deliveryJobId === o3.delivery.id);
  check('once the budget cannot cover another boost, offers carry none', off3 && off3.pay.incentiveCents === 0 && off3.pay.incentives.length === 0, off3?.pay);
  await call('POST', `/delivery-jobs/${o3.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);

  // ── quest settles once when the window ends; a guarantee tops up an opt-in courier with no deliveries
  const Y = await courier('Yuri Yield', null, null);
  await call('POST', '/driver/availability', { isAvailable: true, ...here }, Y.T);
  const guar = (await call('POST', '/admin/courier-campaigns', { kind: 'GUARANTEE', name: `Smoke guarantee ${stamp}`, windowStart: iso(Date.now() - 3600_000), windowEnd: iso(Date.now() + 8000), rules: { minPerHourCents: 20000, minOnlineMinutes: 0 }, enrolment: 'OPT_IN', budgetCents: 5000 }, A)).json;
  await call('POST', `/admin/courier-campaigns/${guar.id}/activate`, { reason: 'Smoke' }, A);
  await call('POST', `/driver/campaigns/${guar.id}/join`, {}, Y.T);
  await call('PUT', `/admin/courier-campaigns/${quest.id}`, { windowEnd: iso(Date.now() + 2000), reason: 'End the smoke quest now' }, A);
  await sleep(9000);
  const sw1 = (await call('POST', '/admin/courier-campaigns/sweep', {}, A)).json;
  const sw2 = (await call('POST', '/admin/courier-campaigns/sweep', {}, A)).json;
  const qx = (await call('GET', '/driver/earnings', undefined, X.T)).json.entries.filter((e) => e.kind === 'INCENTIVE' && e.detail?.campaignId === quest.id);
  const gy = (await call('GET', '/driver/earnings', undefined, Y.T)).json.entries.filter((e) => e.kind === 'INCENTIVE' && e.detail?.campaignId === guar.id);
  const gExpected = gy[0] ? Math.max(0, Math.round((20000 * gy[0].detail.onlineMinutes) / 60) - gy[0].detail.earnedCents) : -1;
  const questAfter = (await call('GET', `/admin/courier-campaigns/${quest.id}`, undefined, A)).json;
  check('ended quest pays the tier reached once (a second sweep pays nothing); a guarantee tops up online time with no deliveries', sw1.settled >= 2 && sw2.paidCents === 0 && qx.length === 1 && qx[0].totalCents === 500 && qx[0].detail.deliveries === 2 && questAfter.status === 'ENDED' && questAfter.settledAt && gy.length === 1 && gy[0].totalCents > 0 && gy[0].totalCents === gExpected && gy[0].detail.earnedCents === 0, { sw1, sw2, qx, gy, gExpected, quest: questAfter.status });

  // ── fraud: far handoff + reused proof photo → case opens (no hold yet)
  const sigCase = async (id) => (await call('GET', '/admin/courier-fraud/cases?status=OPEN', undefined, A)).json.find((c) => c.driverId === id);
  const cx = await sigCase(X.id);
  const riskX = (await call('GET', `/admin/couriers/${X.id}/risk`, undefined, A)).json;
  check('fraud: delivering 1.2 km from the drop-off and reusing a proof photo raise signals; past the review threshold a case opens without a hold', cx && cx.score === 60 && cx.holdActive === false && cx.topSignals.some((s) => s.type === 'PROOF_REUSED') && cx.topSignals.some((s) => s.type === 'DROPOFF_FAR') && riskX.score === 60 && riskX.openCaseId === cx.id, { cx, riskX });

  // ── instant cash-out (account age waived for the smoke, one per day)
  await set('payouts.instant', { enabled: true, feeCents: 50, minCents: 500, dailyCount: 1, dailyMaxCents: 50000, minAccountAgeDays: 0 });
  const st0 = (await call('GET', '/driver/payouts/instant', undefined, X.T)).json;
  const cash = await call('POST', '/driver/payouts/instant', { amountCents: 600 }, X.T);
  const again = await call('POST', '/driver/payouts/instant', {}, X.T);
  const st1 = (await call('GET', '/driver/payouts/instant', undefined, X.T)).json;
  const noAcct = await call('POST', '/driver/payouts/instant', {}, Y.T);
  check('instant cash-out: available = released earnings (incentives here), fee taken, paid at once; daily limit and missing account refused', st0.availableCents >= 1100 && !st0.blockedReason && cash.json.status === 'PAID' && cash.json.amountCents === 550 && cash.json.feeCents === 50 && again.status === 409 && again.json.code === 'INSTANT_UNAVAILABLE' && /times a day/.test(again.json.reason) && st1.availableCents === st0.availableCents - 600 && st1.recent?.[0]?.id === cash.json.id && noAcct.status === 409 && /payout account/i.test(noAcct.json.reason), { st0, cash: cash.json, again: again.json, st1: { a: st1.availableCents, r: st1.recent?.length }, noAcct: noAcct.json });

  // ── linked payout account + impossible GPS jump → hold
  await call('POST', '/driver/location', here, Y.T);
  await call('POST', '/driver/location', { lat: 34.05, lng: -118.24 }, Y.T);
  await call('POST', '/driver/onboarding/payout', { accountHolder: 'Smoke  shared holder', accountLast4: '4242', taxFormAccepted: true }, Y.T);
  const cx2 = await sigCase(X.id);
  const cy = await sigCase(Y.id);
  const held = (await call('GET', '/driver/payouts/instant', undefined, X.T)).json;
  const heldEarn = (await call('GET', '/driver/earnings', undefined, X.T)).json;
  const det = (await call('GET', `/admin/courier-fraud/cases/${cx2?.id}`, undefined, A)).json;
  const custCases = await call('GET', '/admin/courier-fraud/cases', undefined, C);
  check('a payout account shared by two couriers flags both; past the hold threshold payouts pause (cash-out refused, earnings say so); GPS jump flagged', cx2?.holdActive === true && cx2.score === 110 && cy && cy.score === 65 && cy.holdActive === false && cy.topSignals.some((s) => s.type === 'GPS_JUMP') && /review/i.test(held.blockedReason ?? '') && heldEarn.hold?.active === true && det.signals?.length === 3 && det.linkedCouriers?.some((l) => l.id === Y.id) && det.jobs?.length >= 2 && custCases.status === 403, { cx2, cy, held: held.blockedReason, hold: heldEarn.hold, sig: det.signals?.map((s) => s.type), linked: det.linkedCouriers, cust: custCases.status });

  // ── decisions
  const noIds = await call('POST', `/admin/courier-fraud/cases/${cy.id}/decide`, { decision: 'CLAWBACK', reason: 'Testing', noticeToCourier: 'We reviewed your account activity.' }, A);
  const warnY = (await call('POST', `/admin/courier-fraud/cases/${cy.id}/decide`, { decision: 'WARN', reason: 'Shared account explained by family member', noticeToCourier: 'Please keep your payout account to yourself.' }, A)).json;
  const clearX = (await call('POST', `/admin/courier-fraud/cases/${cx2.id}/decide`, { decision: 'CLEAR', reason: 'Proof photo reuse was an app retry', noticeToCourier: 'We reviewed recent activity on your account and found nothing wrong.' }, A)).json;
  const twice = await call('POST', `/admin/courier-fraud/cases/${cx2.id}/decide`, { decision: 'WARN', reason: 'again', noticeToCourier: 'Second decision attempt.' }, A);
  const nX = (await call('GET', '/driver/notices', undefined, X.T)).json;
  const after = (await call('GET', '/driver/payouts/instant', undefined, X.T)).json;
  const riskAfter = (await call('GET', `/admin/couriers/${X.id}/risk`, undefined, A)).json;
  check('decisions need a reason (clawback needs earnings), are final, lift the hold and reach the courier as a plain notice', noIds.status === 400 && warnY.decision === 'WARN' && clearX.decision === 'CLEAR' && clearX.holdActive === false && twice.status === 409 && nX.hold === false && nX.notices?.[0]?.notice?.includes('found nothing wrong') && !/review/i.test(after.blockedReason ?? '') && riskAfter.score === 0 && riskAfter.openCaseId === null, { noIds: noIds.status, warnY: warnY.decision, clearX, twice: twice.status, nX, after: after.blockedReason, riskAfter });

  // ── forecast: the deliveries above become last week's history for a forecast built a week ahead
  await set('delivery.forecast', { lookbackWeeks: 8, horizonDays: 2, jobsPerCourierHour: 0.1, gapAlertCouriers: 1 });
  const created = new Date(d1.j.createdAt).getTime();
  const hour = Math.floor(created / 3600_000) * 3600_000;
  const rb = (await call('POST', '/admin/delivery/forecast/rebuild', { at: iso(hour + 7 * 86400_000 - 3600_000 + 60_000) }, A)).json;
  // every delivery this hour (all zones) is history for the same hour next week
  const fc = (await call('GET', `/admin/delivery/forecast?from=${iso(hour + 7 * 86400_000)}&to=${iso(hour + 7 * 86400_000 + 3600_000)}`, undefined, A)).json;
  const cell = fc.cells?.find((c) => c.expectedJobs > 0);
  const zoneId = cell?.zoneId;
  const busy = (await call('GET', '/driver/busy-times?days=7', undefined, X.T)).json;
  check('forecast: same hour last week (recent weeks weigh more, trend capped) → expected jobs, needed vs supply, busy time for couriers', zoneId && rb.cells > 0 && cell && cell.expectedJobs > 0 && cell.neededCouriers >= 1 && cell.gap >= 1 && Array.isArray(busy) && busy.some((b) => b.zoneId === zoneId && new Date(b.hourStart).getTime() === hour + 7 * 86400_000) && fc.accuracy && 'mape' in fc.accuracy, { zoneId, rb, cell, busy: busy.slice?.(0, 3) });

  // ── reconciliation: a partner job's actual fee arrives → variance posted once; an invoice within tolerance matches
  // a partner (mock) delivery from the bistro, completed by the partner's webhook
  const bistro = (await call('GET', '/public/locations/demo-bistro-new-york')).json;
  const ext = (await call('POST', `/locations/${bistro.id}/delivery-jobs/external`, { externalOrderId: `POS-R3-${stamp}`, dropoff: { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975 }, orderValueCents: 3000, tipCents: 200 }, O)).json;
  if (ext.providerJobId) await call('POST', '/webhooks/delivery', { id: `evt_r3_done_${stamp}`, providerJobId: ext.providerJobId, status: 'DELIVERED' });
  const rec0 = (await call('GET', '/admin/delivery/reconciliation', undefined, A)).json;
  const pj = rec0.rows.find((r) => r.jobId === ext.id && r.status === 'DELIVERED' && r.providerJobId && !r.reconciledAt);
  let recOk = false, recInfo = { found: !!pj, ext: { id: ext.id, status: ext.status, providerJobId: ext.providerJobId, fleet: ext.fleet } };
  if (pj) {
    await call('POST', '/webhooks/delivery', { id: `evt_r3_${stamp}`, providerJobId: pj.providerJobId, status: 'DELIVERED', feeCents: pj.quotedCents + 120 });
    const run1 = (await call('POST', '/admin/delivery/reconciliation/run', {}, A)).json;
    const run2 = (await call('POST', '/admin/delivery/reconciliation/run', {}, A)).json;
    const row = (await call('GET', '/admin/delivery/reconciliation', undefined, A)).json.rows.find((r) => r.jobId === pj.jobId);
    const inv = (await call('POST', '/finance/provider-invoices', { provider: 'mock', externalId: `inv-r3-${stamp}`, periodStart: iso(Date.now() - 86400_000), periodEnd: iso(Date.now()), lines: [{ providerJobId: pj.providerJobId, cents: pj.quotedCents + 120 + pj.tipCents + 30 }] }, A)).json;
    const custRun = await call('POST', '/admin/delivery/reconciliation/run', {}, C);
    recOk = run1.posted >= 1 && run2.posted === 0 && row.postedCents === 120 && row.reconciledAt && row.actualCents === pj.quotedCents + 120 && inv.status === 'MATCHED' && custRun.status === 403;
    recInfo = { run1, run2, row, inv: { status: inv.status, matched: inv.matchedCents }, cust: custRun.status };
  }
  const rec1 = (await call('GET', '/admin/delivery/reconciliation', undefined, A)).json;
  const ours = (rec1.exceptions ?? []).filter((e) => e.driverId === X.id || e.driverId === Y.id);
  check('partner fee variance is posted once per job; an invoice line within tolerance matches; courier ledgers (earnings − payouts = balance) agree', recOk && Array.isArray(rec1.exceptions) && ours.length === 0, { ...recInfo, ours });

  // ── cleanup
  await call('POST', `/admin/courier-campaigns/${boost.id}/cancel`, { reason: 'Smoke cleanup' }, A);
  await call('POST', `/admin/courier-campaigns/${bikes.id}/cancel`, { reason: 'Smoke cleanup' }, A);
  await call('POST', '/driver/availability', { isAvailable: false }, X.T);
  await call('POST', '/driver/availability', { isAvailable: false }, Y.T);
  await set('payouts.instant', { enabled: true, feeCents: 50, minCents: 500, dailyCount: 3, dailyMaxCents: 50000, minAccountAgeDays: 7 });
  await set('delivery.forecast', { lookbackWeeks: 8, horizonDays: 7, jobsPerCourierHour: 2.2, gapAlertCouriers: 2 });
  void phaseStart;
}
