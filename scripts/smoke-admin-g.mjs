// Admin platform, phase G checks: delivery areas & restrictions, couriers, dispatch & last mile.
export async function adminPhaseG({ call, check, A, O, C }) {
  console.log('\n── Admin platform G: delivery, couriers, dispatch');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const items = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const bowl = items.find((i) => i.name === 'Harvest bowl');
  const addrA = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048 };
  const addrB = { line1: '111 8th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7431, lng: -74.0034 };
  const quote = (addr = addrA, extra = {}) => call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: bowl.id, quantity: 1 }], deliveryAddress: addr, ...extra }, C);
  const place = async (addr = addrA, extra = {}) => { const q = (await quote(addr, extra)).json; const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json; await call('POST', `/orders/${o.id}/accept`, {}, O); return o; };
  const jobOf = async (orderId) => (await call('GET', '/admin/delivery/live', undefined, A)).json.deliveries.find((d) => d.orderId === orderId);
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const D = (await login('driver@demo.gutad.io', 'driver12345')).accessToken;
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke G' }, A);
  const box = (lat, lng, d = 0.002) => ({ type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] });

  // the Phase C smoke left the hall on a gradual-reopening ramp; lift it for this run
  await call('POST', `/locations/${hall.id}/restart`, { reason: 'Smoke G: normal capacity', rampThrottlePer15m: 500, rampMinutes: 5 }, A);

  // 15.1 exclusion polygon
  const ex = (await call('POST', `/locations/${hall.id}/delivery-zones`, { name: 'Pier closed', kind: 'EXCLUSION', polygon: box(addrB.lat, addrB.lng, 0.0004), feeCents: 0 }, O)).json;
  const qx = await quote(addrB);
  const qa = await quote(addrA);
  await call('POST', `/locations/${hall.id}/delivery-zones`, { id: ex.id, name: 'Pier closed', kind: 'EXCLUSION', polygon: box(addrB.lat, addrB.lng, 0.0004), feeCents: 0, isActive: false }, O);
  check('exclusion polygon carves an address out of delivery', qx.status === 400 && qx.json.code === 'DELIVERY_UNAVAILABLE' && qa.status === 201, { qx: qx.json, qa: qa.status });

  // 15.3 zone hours
  const zh = (await call('POST', `/locations/${hall.id}/delivery-zones`, { name: 'Night only', polygon: box(addrA.lat, addrA.lng, 0.003), feeCents: 0, hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opens: '03:00', closes: '03:01' })), travelMinutesPerKm: 4 }, O)).json;
  const qClosed = await quote(addrA);
  await call('POST', `/locations/${hall.id}/delivery-zones`, { id: zh.id, name: 'Night only', polygon: box(addrA.lat, addrA.lng, 0.003), feeCents: 0, isActive: false }, O);
  check('zone opening hours close delivery outside them', qClosed.status === 400 && qClosed.json.code === 'ZONE_CLOSED', qClosed.json);

  // 15.5 restrictions: pause, add minutes; expiry
  const base = (await quote()).json;
  const pause = (await call('POST', '/admin/delivery/restrictions', { kind: 'PAUSE', reason: 'Storm', locationId: hall.id, endsAt: new Date(Date.now() + 3600_000).toISOString() }, A)).json;
  const paused = await quote();
  await call('POST', `/admin/delivery/restrictions/${pause.id}/lift`, {}, A);
  const slow = (await call('POST', '/admin/delivery/restrictions', { kind: 'ADD_MINUTES', value: 20, reason: 'Heavy rain', locationId: hall.id, endsAt: new Date(Date.now() + 3600_000).toISOString() }, A)).json;
  const slowQ = (await quote()).json;
  await call('POST', `/admin/delivery/restrictions/${slow.id}/lift`, {}, A);
  const tooLong = await call('POST', '/admin/delivery/restrictions', { kind: 'PAUSE', reason: 'Forever', endsAt: new Date(Date.now() + 30 * 86400_000).toISOString() }, A);
  check('disruption restrictions pause delivery or add minutes, with a maximum length', paused.status === 400 && paused.json.code === 'DELIVERY_PAUSED' && new Date(slowQ.promiseAt) - new Date(base.promiseAt) >= 15 * 60_000 && slowQ.warnings.some((w) => /extended/.test(w)) && tooLong.status === 400, { paused: paused.json, base: base.promiseAt, slow: slowQ.promiseAt });

  // 15.6 scheduled delivery windows
  const page = (await call('GET', `/public/locations/${hall.id}`)).json;
  const day = page.pickupTimes.find((d, i) => i > 0 && d.slots.length);
  const iso = (await call('GET', `/public/locations/${hall.id}/local-time?date=${day.date}&time=${day.slots[0]}`)).json.iso;
  await call('PATCH', `/locations/${hall.id}`, { deliveryWindowMinutes: 30, deliveryWindowCapacity: 1 }, O);
  const w1 = (await quote(addrA, { scheduledFor: iso })).json;
  await call('POST', '/orders', { quoteId: w1.id }, C, idem());
  const w2 = await quote(addrA, { scheduledFor: iso });
  const wins = (await call('GET', `/public/locations/${hall.id}/delivery-windows?date=${day.date}`)).json;
  await call('PATCH', `/locations/${hall.id}`, { deliveryWindowCapacity: null }, O);
  check('scheduled delivery windows have a capacity', w2.status === 400 && w2.json.code === 'WINDOW_FULL' && wins.used.some((u) => u.remaining === 0), { w2: w2.json });

  // 15.8 coverage simulation
  const cov = (await call('POST', '/admin/delivery/coverage', { lat: 40.735, lng: -73.99, radiusKm: 2 }, A)).json;
  check('coverage simulation reports deliverable share, overlap and ETA', cov.samples > 20 && cov.deliverablePct > 0 && cov.alreadyCoveredPct > 0 && cov.overlaps.length > 0 && cov.avgEtaMinutes > 0, { ...cov, points: undefined });

  // 16.2 onboarding documents gate approval
  const nEmail = `courier-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: nEmail, password: 'courier12345', name: 'Nia Courier' });
  const N = (await login(nEmail, 'courier12345')).accessToken;
  const nDriver = (await call('POST', '/driver/apply', { vehicle: 'Car' }, N)).json;
  const early = await call('POST', `/drivers/${nDriver.id}/approve`, { approved: true }, A);
  const exp = new Date(Date.now() + 200 * 86400_000).toISOString();
  for (const kind of ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK']) await call('POST', '/driver/documents', { kind, fileUrl: `https://files.example/${kind}.pdf`, expiresAt: kind === 'BACKGROUND_CHECK' ? undefined : exp }, N);
  const queue = (await call('GET', '/admin/couriers/documents', undefined, A)).json;
  const mine = queue.pending.filter((d) => d.driverId === nDriver.id);
  for (const d of mine) await call('POST', `/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked' }, A);
  const ok = (await call('POST', `/drivers/${nDriver.id}/approve`, { approved: true }, A)).json;
  await call('PATCH', `/admin/couriers/${nDriver.id}`, { vehicleType: 'CAR', capabilities: ['ALCOHOL', 'LARGE_ORDER'] }, A);
  check('courier approval needs approved licence, insurance and background check', early.status === 400 && early.json.code === 'DOCS_MISSING' && mine.length === 3 && ok.status === 'APPROVED', { early: early.json, n: mine.length, ok: ok.status });

  // 17.2 scoring + 17.4 batching
  await call('POST', '/driver/availability', { isAvailable: true, lat: 40.7406, lng: -74.0055 }, D);
  const oA = await place(addrA);
  const offA = (await call('GET', '/driver/offers', undefined, D)).json.find((x) => x.deliveryJobId === (oA.delivery?.id));
  const jA = (await call('POST', `/driver/offers/${offA?.id}`, { accept: true }, D)).json;
  const oB = await place(addrB);
  const offB = (await call('GET', '/driver/offers', undefined, D)).json.find((x) => x.deliveryJobId === oB.delivery?.id);
  check('assignment is scored (distance, readiness, load)', offA && typeof offA.score === 'number' && offA.scoreDetail?.km >= 0 && jA.id, offA);
  check('a compatible second order from the same pickup is offered as a batch', offB && offB.batchWith === jA.id, offB);
  await call('POST', `/driver/offers/${offB.id}`, { accept: true }, D);
  const jobsD = (await call('GET', '/driver/jobs', undefined, D)).json;
  check('batched jobs share a batch id', jobsD.filter((j) => [oA.delivery.id, oB.delivery.id].includes(j.id)).every((j, _, arr) => j.batchId && j.batchId === arr[0].batchId), jobsD.map((j) => j.batchId));

  // 17.6 arrival + 17.7 exception with wait timer + 17.8 proof
  await call('POST', `/driver/jobs/${jA.id}/arrived`, { at: 'PICKUP' }, D);
  await call('POST', `/driver/jobs/${jA.id}/transition`, { status: 'PICKED_UP', pickupCheck: { bagCount: 1, sealIntact: true }, lat: 40.742, lng: -74.006 }, D);
  await call('POST', '/driver/location', { lat: 40.7423, lng: -74.0052 }, D);
  await call('POST', `/driver/jobs/${jA.id}/arrived`, { at: 'DROPOFF' }, D);
  await call('POST', `/driver/jobs/${jA.id}/exception`, { kind: 'CUSTOMER_UNREACHABLE', method: 'CALL' }, D);
  await call('POST', `/driver/jobs/${jA.id}/exception`, { kind: 'CUSTOMER_UNREACHABLE', method: 'SMS' }, D);
  const tooSoon = await call('POST', `/driver/jobs/${jA.id}/exception/resolve`, { resolution: 'RETURN' }, D);
  const custView = (await call('GET', `/orders/${oA.id}`, undefined, C)).json;
  const safe = (await call('POST', `/admin/delivery-jobs/${jA.id}/exception/resolve`, { resolution: 'SAFE_PLACE', note: 'Left with doorman after 2 attempts', proofPhotoUrl: 'https://files.example/proof-a.jpg' }, A)).json;
  check('arrival times and contact attempts are recorded; the wait timer must run out', tooSoon.status === 409 && tooSoon.json.code === 'WAIT_TIMER' && custView.delivery?.exception?.kind === 'CUSTOMER_UNREACHABLE' && custView.delivery.arrivedAt && safe.status === 'DELIVERED', { tooSoon: tooSoon.json, ex: custView.delivery });
  const pub = (await call('GET', `/public/delivery/${jA.id}/track`)).json;
  const custAfter = (await call('GET', `/orders/${oA.id}`, undefined, C)).json;
  const custProof = await call('GET', `/delivery-jobs/${jA.id}/proof`, undefined, C);
  const staffProof = (await call('GET', `/delivery-jobs/${jA.id}/proof`, undefined, A)).json;
  check('proof of delivery is staff-only: not on public tracking or the customer order', !('proofPhotoUrl' in pub) && pub.hasProof === true && !JSON.stringify(custAfter).includes('proof-a.jpg') && custProof.status === 403 && staffProof.proofPhotoUrl?.includes('proof-a.jpg'), { pub, custProof: custProof.status });
  const purge = (await call('POST', '/admin/jobs/delivery-housekeeping', { at: new Date(Date.now() + 120 * 86400_000).toISOString() }, A)).json;
  const purged = (await call('GET', `/delivery-jobs/${jA.id}/proof`, undefined, A)).json;
  check('proof is removed after the retention period', purge.proofs.purged >= 1 && !purged.proofPhotoUrl && purged.purgedAt, purge);
  await call('POST', `/driver/jobs/${oB.delivery.id}/transition`, { status: 'PICKED_UP', pickupCheck: { bagCount: 1, sealIntact: true } }, D);
  await call('POST', `/driver/jobs/${oB.delivery.id}/transition`, { status: 'DELIVERED', proofSignature: 'B. Customer' }, D);

  // 17.3 manual assignment with reason
  const oC = await place(addrA);
  const noReason = await call('POST', `/admin/delivery-jobs/${oC.delivery.id}/assign`, { driverId: nDriver.id }, A);
  const assigned = (await call('POST', `/admin/delivery-jobs/${oC.delivery.id}/assign`, { driverId: nDriver.id, reason: 'Courier is already at the counter' }, A)).json;
  check('manual assignment needs a reason and assigns the chosen courier', noReason.status === 400 && assigned.status === 'ASSIGNED' && assigned.driverId === nDriver.id, assigned);
  await call('POST', `/delivery-jobs/${oC.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);

  // no courier online: since f10713a an empty search doesn't end dispatch. The job keeps looking with Gutad couriers
  // (retried every minute, failing over only 20 min after the food is due) and the customer can switch to pickup,
  // cancel for a full refund, or keep waiting (16b4702). Partner-to-partner failover is covered in Follow-ups B (17.9-M).
  await call('POST', '/driver/availability', { isAvailable: false }, D);
  const oF = await place(addrA);
  const vF = (await call('GET', `/orders/${oF.id}`, undefined, C)).json;
  const jF = vF.delivery;
  const live = await jobOf(oF.id);
  check('no courier online → the job keeps searching with Gutad couriers and the customer is offered choices', jF?.fleet === 'PLATFORM' && jF.status === 'REQUESTED' && live?.status === 'REQUESTED' && vF.courierDelay && vF.courierDelay.cancelRefundCents > 0 && vF.courierDelay.pickupRefundCents === Math.min(vF.courierDelay.cancelRefundCents, oF.deliveryFeeCents + oF.tipCents), { jF, courierDelay: vF.courierDelay });
  const cF = await call('POST', `/orders/${oF.id}/courier-delay`, { choice: 'CANCEL' }, C);
  const vF2 = (await call('GET', `/orders/${oF.id}`, undefined, C)).json;
  check('the customer cancels for a full refund; the courier search stops', cF.status < 300 && vF2.status === 'CANCELED' && vF2.delivery?.status === 'CANCELED', { cF: cF.json?.status ?? cF.json, order: vF2.status, delivery: vF2.delivery?.status });

  // 16.5 metrics, 16.7 adjustments, 16.8 suspension & appeal reviewed by another person
  const dList = (await call('GET', '/admin/couriers', undefined, A)).json;
  const dRow = dList.find((c) => c.email === 'driver@demo.gutad.io');
  const bonus = await call('POST', `/admin/couriers/${dRow.id}/adjustments`, { cents: 500, reason: 'Rain bonus' }, A);
  const prof = (await call('GET', `/admin/couriers/${dRow.id}`, undefined, A)).json;
  check('courier directory with reliability metrics; bonus posted to payable balance', dRow.metrics.acceptanceRate > 0 && dRow.metrics.delivered >= 2 && bonus.status === 201 && prof.earnings.some((e) => e.kind === 'BONUS' && e.reason === 'Rain bonus') && prof.payableCents >= 500, { m: dRow.metrics, pay: prof.payableCents });
  const sus = (await call('POST', `/admin/couriers/${nDriver.id}/suspend`, { reason: 'Repeated late deliveries' }, A)).json;
  const offline = await call('POST', '/driver/availability', { isAvailable: true }, N);
  const ap = (await call('POST', '/driver/appeal', { note: 'Traffic closures on my route that week' }, N)).json;
  const self = await call('POST', `/admin/couriers/${nDriver.id}/appeal-decision`, { reinstate: true, note: 'self review' }, A);
  const dispEmail = `dispatch-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: dispEmail, password: 'staffpass12345', name: 'dispatcher' });
  await call('POST', '/admin/security/staff/roles', { email: dispEmail, roles: ['DISPATCHER'], reason: 'Smoke G dispatcher' }, A);
  const DS = (await login(dispEmail, 'staffpass12345')).accessToken;
  const rev = (await call('POST', `/admin/couriers/${nDriver.id}/appeal-decision`, { reinstate: true, note: 'Closures confirmed' }, DS)).json;
  check('suspension blocks going online; the appeal is decided by someone else', sus.status === 'SUSPENDED' && offline.status === 403 && ap.appealStatus === 'PENDING' && self.status === 403 && rev.status === 'APPROVED' && rev.appealStatus === 'REINSTATED', { offline: offline.status, self: self.status, rev });

  // 17.1 live map + 17.10 analysis
  const lv = (await call('GET', '/admin/delivery/live', undefined, A)).json;
  const an = (await call('GET', '/admin/delivery/analysis?by=provider&days=1', undefined, A)).json;
  check('live dispatch map and delivery cost / waiting analysis', Array.isArray(lv.couriers) && lv.couriers.some((c) => c.lat) && an.rows.some((r) => r.key === 'platform' && r.delivered >= 2 && r.avgPickupWaitMinutes !== null), { an: an.rows });
}
