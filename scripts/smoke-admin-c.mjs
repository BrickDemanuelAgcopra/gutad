// Admin platform, phase C checks: locations, onboarding pipeline & lifecycle, merchant administration, brands.
export async function adminPhaseC({ call, check, A, O, C, locId, demoOrgId }) {
  console.log('\n── Admin platform C: locations, merchants, brands');
  const stamp = Date.now();
  const iso = (min) => new Date(Date.now() + min * 60_000).toISOString();
  const lemonadeOf = async (lid, channel = 'DIRECT') => (await call('GET', `/public/locations/${lid}/menus?channel=${channel}`)).json.flatMap((m) => m.categories.flatMap((x) => x.items));

  // 3.1 / 3.3 / 3.7 location details, channels, pickup & courier info
  const upd = await call('PATCH', `/locations/${locId}`, { contacts: [{ name: 'Ana Ruiz', role: 'GM', phone: '+15550111' }], pickupInstructions: 'Pickup shelf left of the bar', parkingInfo: '15-minute spots on Bleecker St', courierInstructions: 'Courier door on Jones St', acceptsKiosk: true, acceptTimeoutMinutes: 6 }, O);
  const det = (await call('GET', `/admin/locations/${locId}`, undefined, A)).json;
  const pub = (await call('GET', `/public/locations/${locId}`)).json;
  check('location contacts, kiosk flag, pickup, parking and courier info', upd.status === 200 && det.location?.contacts?.[0]?.name === 'Ana Ruiz' && det.location.acceptsKiosk && pub.pickupInstructions === 'Pickup shelf left of the bar' && pub.parkingInfo, [upd.status, pub.pickupInstructions]);
  check('admin location view lists menus, brands, stations and the launch checklist', Array.isArray(det.menus) && det.menus.length >= 1 && Array.isArray(det.brands) && det.checklist?.items?.length >= 10, det.checklist?.total);

  // 3.2 closures stop ordering and show publicly
  const items = await lemonadeOf(locId);
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const closure = (await call('POST', `/locations/${locId}/closures`, { kind: 'CLOSED', startsAt: iso(-1), endsAt: iso(120), service: 'ORDERING', reason: 'Burst pipe' }, O)).json;
  const qClosed = await call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }] }, C);
  const pubClosures = (await call('GET', `/public/locations/${locId}/closures`)).json;
  check('temporary closure with a reopening time blocks ordering and is shown publicly', closure.id && qClosed.status === 400 && pubClosures.some((x) => x.reason === 'Burst pipe'), qClosed.json?.message);
  await call('DELETE', `/closures/${closure.id}`, undefined, O);
  const qOpen = await call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }] }, C);
  check('removing the closure reopens ordering', qOpen.status === 201 || qOpen.status === 200, qOpen.json?.message);
  const badClosure = await call('POST', `/locations/${locId}/closures`, { kind: 'SPECIAL_HOURS', startsAt: iso(60), endsAt: iso(30) }, O);
  check('closure dates are validated', badClosure.status === 400, badClosure.status);

  // 3.5 stations
  const hallSlug = 'demo-kitchen-collective';
  const hall = (await call('GET', `/public/locations/${hallSlug}`)).json;
  const hallDet = (await call('GET', `/admin/locations/${hall.id}`, undefined, A)).json;
  const st = (await call('POST', `/kitchens/${hallDet.location.kitchenId}/stations`, { code: 'FRY', name: 'Fryer', maxConcurrent: 4, equipment: ['fryer-1'], isAvailable: true }, O)).json;
  check('stations carry capacity and equipment', st.maxConcurrent === 4 && st.equipment.includes('fryer-1'), st);

  // 3.6 launch checklist & readiness
  const train = (await call('POST', `/locations/${locId}/launch-items/TRAINING`, { done: true, note: 'Trained 6 staff' }, O)).json;
  const ownerEquip = await call('POST', `/locations/${locId}/launch-items/EQUIPMENT`, { done: true }, O);
  const adminEquip = (await call('POST', `/locations/${locId}/launch-items/EQUIPMENT`, { done: true, note: 'Tablet + printer online' }, A)).json;
  check('merchant signs off training; Gutad signs off equipment', train.items?.find((i) => i.key === 'TRAINING')?.done && ownerEquip.status === 403 && adminEquip.items.find((i) => i.key === 'EQUIPMENT').done, ownerEquip.status);
  const ready = await call('POST', `/admin/locations/${locId}/readiness`, { approve: true, note: 'Launch review done' }, A);
  check('readiness approval needs every required item', ready.status === 201 ? adminEquip.requiredOpen.length === 0 : ready.json.code === 'CHECKLIST_OPEN', { status: ready.status, open: adminEquip.requiredOpen });
  const newLoc = (await call('POST', `/organizations/${demoOrgId}/locations`, { name: `Smoke Launch ${stamp}`, addressLine1: '1 Test St', city: 'New York', region: 'NY', postalCode: `1${String(stamp).slice(-4)}` }, A)).json;
  await call('POST', `/locations/${newLoc.id}/verify`, { verified: true }, A);
  const goLive = await call('POST', `/locations/${newLoc.id}/status`, { status: 'LIVE' }, A);
  check('a new location cannot go live before readiness is approved', goLive.status === 400 && goLive.json.code === 'READINESS_REQUIRED', goLive.json);

  // 3.8 emergency pause and controlled restart
  const noReason = await call('POST', '/admin/locations/emergency-pause', { locationIds: [hall.id] }, A);
  const ep = (await call('POST', '/admin/locations/emergency-pause', { locationIds: [hall.id], reason: 'Gas leak reported in the food hall' }, A)).json;
  const alertsNow = (await call('GET', '/admin/alerts', undefined, A)).json;
  check('emergency pause needs a reason, pauses the location and raises a critical alert', noReason.status >= 400 && ep.paused === 1 && alertsNow.some((a) => a.severity === 'CRITICAL' && a.title.startsWith('Emergency pause')), ep);
  const ownerRestart = await call('POST', `/locations/${hall.id}/restart`, { reason: 'We think it is fine' }, O);
  const restart = (await call('POST', `/locations/${hall.id}/restart`, { reason: 'Fire department cleared the building', rampThrottlePer15m: 3, rampMinutes: 30 }, A)).json;
  check('only Gutad restarts after an emergency; restart ramps capacity up gradually', ownerRestart.status === 403 && !restart.isPaused && restart.rampThrottlePer15m === 3 && restart.rampUntil, [ownerRestart.status, restart.rampThrottlePer15m]);

  // 4.1 applications pipeline
  const appEmail = `chef-${stamp}@example.com`;
  const app = (await call('POST', '/public/merchant-applications', { businessName: `Smoke Noodles ${stamp}`, contactName: 'Mei Chen', email: appEmail, city: 'New York', cuisine: 'noodles', locationsCount: 2, interest: ['ORDERING'] })).json;
  const dupApp = (await call('POST', '/public/merchant-applications', { businessName: `Smoke Noodles ${stamp}`, contactName: 'Mei Chen', email: appEmail })).json;
  const pipe = (await call('GET', '/admin/pipeline?stage=APPLIED', undefined, A)).json;
  check('public application lands in the pipeline once', app.id && dupApp.duplicate && pipe.items.some((x) => x.id === app.id) && typeof pipe.counts.APPLIED === 'number', pipe.counts);
  const lostNoReason = await call('PATCH', `/admin/pipeline/${app.id}`, { stage: 'LOST' }, A);
  const contacted = (await call('PATCH', `/admin/pipeline/${app.id}`, { stage: 'CONTACTED', note: 'Called, sending terms' }, A)).json;
  check('pipeline stages keep history; losing a deal needs a reason', lostNoReason.status === 400 && contacted.stage === 'CONTACTED' && contacted.history.length >= 2, contacted.history?.length);
  const org = (await call('POST', `/admin/pipeline/${app.id}/convert`, {}, A)).json;
  const board = (await call('GET', '/admin/merchants/onboarding', undefined, A)).json;
  check('approving an application provisions the merchant with an account manager', org.id && board.some((b) => b.id === org.id && b.accountManager), board.find((b) => b.id === org.id));

  // 4.2 profile & 4.7 lifecycle
  const tooMuch = await call('PATCH', `/organizations/${org.id}/profile`, { owners: [{ name: 'A', ownershipPct: 70 }, { name: 'B', ownershipPct: 40 }] }, A);
  const prof = (await call('PATCH', `/organizations/${org.id}/profile`, { owners: [{ name: 'Mei Chen', title: 'CEO', ownershipPct: 100 }], website: 'https://noodles.example' }, A)).json;
  check('beneficial owners recorded and validated', tooMuch.status === 400 && prof.owners?.[0]?.name === 'Mei Chen', tooMuch.status);
  const susp = (await call('POST', `/admin/organizations/${org.id}/lifecycle`, { action: 'SUSPEND', reason: 'Health permit lapsed' }, A)).json;
  const rein = (await call('POST', `/admin/organizations/${org.id}/lifecycle`, { action: 'REINSTATE', reason: 'New permit uploaded and verified' }, A)).json;
  const mdet = (await call('GET', `/admin/merchants/${org.id}`, undefined, A)).json;
  check('suspend and reinstate with reasons and history', susp.organization?.status === 'SUSPENDED' && rein.organization?.status !== 'SUSPENDED' && mdet.lifecycle.filter((h) => h.action.startsWith('org.lifecycle')).length >= 2, [susp.organization?.status, rein.organization?.status]);
  const custLife = await call('POST', `/admin/organizations/${org.id}/lifecycle`, { action: 'SUSPEND', reason: 'I do not like them' }, C);
  check('only merchant managers at Gutad change lifecycle', custLife.status === 403, custLife.status);

  // 5.2 change requests
  await call('POST', '/admin/settings', { key: 'merchants.review_changes', value: { menu: true, business: false }, reason: 'Smoke: turn on menu review' }, A);
  const chg = (await call('PATCH', `/items/${lemonade.id}`, { description: 'Fresh-squeezed, now with mint' }, O)).json;
  const itemsMid = await lemonadeOf(locId);
  check('merchant menu edit waits for review when review is on', chg.changeRequest?.status === 'PENDING' && itemsMid.find((i) => i.id === lemonade.id).description !== 'Fresh-squeezed, now with mint', chg.changeRequest);
  const ownerApprove = await call('POST', `/admin/change-requests/${chg.changeRequest.id}/approve`, {}, O);
  const appr = (await call('POST', `/admin/change-requests/${chg.changeRequest.id}/approve`, { note: 'Looks good' }, A)).json;
  const itemsAfter = await lemonadeOf(locId);
  check('Gutad approves the change and it goes live', ownerApprove.status === 403 && appr.status === 'APPROVED' && itemsAfter.find((i) => i.id === lemonade.id).description === 'Fresh-squeezed, now with mint', appr.status);
  await call('POST', '/admin/settings', { key: 'merchants.review_changes', value: { menu: false, business: false }, reason: 'Smoke: turn off menu review' }, A);

  // 5.4 availability, 5.5 statement lines, 5.7 performance
  await call('POST', `/items/${lemonade.id}/sold-out`, { soldOut: true, untilMinutes: 30 }, O);
  const av = (await call('GET', '/admin/availability', undefined, A)).json;
  check('admin sees sold-out items and paused locations across merchants', av.soldOut.some((s) => s.itemId === lemonade.id) && Array.isArray(av.pausedLocations), av.soldOut.length);
  await call('POST', `/items/${lemonade.id}/sold-out`, { soldOut: false }, O);
  const sl = (await call('GET', `/organizations/${demoOrgId}/statement-lines`, undefined, O)).json;
  check('per-order statement lines: sales, tax, tips, commission, processing, refunds, net', sl.lines?.length >= 1 && ['salesCents', 'commissionCents', 'processingCents', 'netPayableCents'].every((k) => typeof sl.lines[0][k] === 'number') && sl.totals.orders === sl.lines.length, sl.totals);
  const csvRes = await fetch(`${process.env.API_URL || 'http://localhost:4000'}/organizations/${demoOrgId}/statement-lines.csv`, { headers: { Authorization: `Bearer ${O}` } });
  check('statement lines export as CSV', csvRes.status === 200 && (await csvRes.text()).startsWith('number,createdAt'), csvRes.status);
  const perf = (await call('GET', '/admin/merchants/performance', undefined, A)).json;
  const bistro = perf.find((p) => p.locationId === locId);
  check('merchant performance: acceptance, cancellation, prep time, errors', bistro && bistro.orders > 0 && typeof bistro.acceptanceRate === 'number' && 'avgPrepMinutes' in bistro && 'errorRate' in bistro, bistro);

  // 5.6 merchant support cases
  const cs = (await call('POST', `/organizations/${demoOrgId}/cases`, { category: 'PAYOUT', description: 'Last week payout looks $40 short' }, O)).json;
  const reply = (await call('POST', `/incidents/${cs.id}/messages`, { body: 'Looking into it — the difference is a refund on order 123.' }, A)).json;
  await call('POST', `/incidents/${cs.id}/messages`, { body: 'Check refund funder on that order', visibility: 'INTERNAL' }, A);
  const ownerMsgs = (await call('GET', `/incidents/${cs.id}/messages`, undefined, O)).json;
  const custMsgs = await call('GET', `/incidents/${cs.id}/messages`, undefined, C);
  const orgCases = (await call('GET', `/organizations/${demoOrgId}/cases`, undefined, O)).json;
  check('merchant cases: thread with Gutad, internal notes hidden, private to the merchant', reply.id && ownerMsgs.length === 2 && ownerMsgs.every((m) => m.visibility !== 'INTERNAL') && ownerMsgs.some((m) => m.authorEmail === 'Gutad support') && custMsgs.status === 403 && orgCases.some((c) => c.id === cs.id), { n: ownerMsgs.length, cust: custMsgs.status });
  check('complaints about the merchant appear in their cases', orgCases.some((c) => c.aboutMerchant), orgCases.length);

  // 6 brands
  const brands = (await call('GET', '/admin/brands', undefined, A)).json;
  const bowl = brands.find((b) => b.name === 'Bowl Theory');
  const ownerRights = await call('PATCH', `/brands/${bowl.id}`, { authorizedChannels: ['DIRECT'] }, O);
  const ownerStd = (await call('PATCH', `/brands/${bowl.id}`, { presentationStandards: 'Bowls photographed top-down on white' }, O)).json;
  check('brand owner edits presentation standards but not rights', ownerRights.status === 403 && ownerStd.presentationStandards?.startsWith('Bowls'), ownerRights.status);
  await call('PATCH', `/brands/${bowl.id}`, { ownershipType: 'CREATOR', ownerName: 'Chef Ada', authorizedChannels: ['DIRECT'] }, A);
  const mkt = (await call('GET', `/public/locations/${hall.id}/menus?channel=MARKETPLACE`)).json;
  const dir = (await call('GET', `/public/locations/${hall.id}/menus?channel=DIRECT`)).json;
  check('brand sells only through authorized channels', !mkt.some((m) => m.brand?.id === bowl.id || m.brandId === bowl.id) && dir.some((m) => m.brand?.id === bowl.id || m.brandId === bowl.id), { mkt: mkt.length, dir: dir.length });
  await call('PATCH', `/brands/${bowl.id}`, { authorizedChannels: [], contractEnd: new Date(Date.now() - 86400_000).toISOString() }, A);
  const expired = (await call('GET', `/public/locations/${hall.id}/menus?channel=DIRECT`)).json;
  check('sales stop when the contract has ended', !expired.some((m) => m.brand?.id === bowl.id || m.brandId === bowl.id), expired.length);
  const noNote = await call('PATCH', `/brands/${bowl.id}`, { rightsStatus: 'SUSPENDED' }, A);
  await call('PATCH', `/brands/${bowl.id}`, { contractEnd: null, rightsStatus: 'ACTIVE', royaltyRules: [{ type: 'TIERED', tiers: [{ uptoCents: 100000, bps: 800 }, { uptoCents: null, bps: 500 }], minGuaranteeCents: 100 }] }, A);
  const back = (await call('GET', `/public/locations/${hall.id}/menus?channel=MARKETPLACE`)).json;
  check('suspending needs a note; restoring rights resumes sales', noNote.status === 400 && back.some((m) => m.brand?.id === bowl.id || m.brandId === bowl.id), noNote.status);
  const rv = await call('POST', `/brands/${bowl.id}/reviews`, { kind: 'QUALITY_REVIEW', score: 4, result: 'PASS', notes: 'Portion on spec' }, A);
  const ownerRv = await call('POST', `/brands/${bowl.id}/reviews`, { kind: 'QUALITY_REVIEW', score: 5, result: 'PASS' }, O);
  check('culinary quality reviews by Gutad staff only', rv.status === 201 && ownerRv.status === 403, [rv.status, ownerRv.status]);
  const stmt = (await call('GET', `/brands/${bowl.id}/statement?from=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`, undefined, O)).json;
  check('partner statement: sales, items, royalty by rule, quality', typeof stmt.salesCents === 'number' && stmt.royalty?.lines?.length >= 1 && stmt.quality?.reviews >= 1, { sales: stmt.salesCents, roy: stmt.royalty });
}
