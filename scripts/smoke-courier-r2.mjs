// Courier Release 2: kitchen-ready sync (held offers, estimates, READY release), multi-brand manifests and the
// per-brand pickup check, market pay policies, batching rules and preview, partner reconciliation and provider test.
export async function courierR2({ call, check, A, O, C }) {
  console.log('\n── Courier R2: kitchen-ready sync, manifests, market policies, batching, reconciliation');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const set = (key, value) => call('POST', '/admin/settings', { key, value, reason: 'Smoke courier R2' }, A);
  const login = async (email, pw) => (await call('POST', '/auth/login', { email, password: pw })).json;
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const menus = (await call('GET', `/public/locations/${hall.id}/menus`)).json;
  const items = menus.flatMap((m) => m.categories.flatMap((c) => c.items));
  const smash = items.find((i) => i.name === 'Double smash');
  const bowl = items.find((i) => i.name === 'Harvest bowl');
  const near = { line1: '75 9th Ave', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7425, lng: -74.0048 };
  const midtown = { line1: '450 W 33rd St', city: 'New York', region: 'NY', postalCode: '10001', lat: 40.7527, lng: -73.9989 };
  const here = { lat: hall.lat ?? 40.7418, lng: hall.lng ?? -74.0067 };
  const place = async (lines, addr, prepMinutes) => {
    const q = (await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines, deliveryAddress: addr }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json;
    await call('POST', `/orders/${o.id}/accept`, { prepMinutes }, O);
    return (await call('GET', `/orders/${o.id}`, undefined, C)).json;
  };
  const arrivals = async () => (await call('GET', `/locations/${hall.id}/courier-arrivals`, undefined, O)).json;

  // ── a market for the food hall, with its own waiting pay and batching rules
  const orgId = (await login('owner@demo.gutad.io', 'merchant12345')).user.merchantIds[0];
  const ov = (await call('GET', `/organizations/${orgId}`, undefined, O)).json;
  const kitchenId = ov.locations.find((l) => l.kitchenId)?.kitchenId;
  const locBefore = ov.locations.find((l) => l.id === hall.id) ?? {};
  const region = (await call('POST', '/admin/regions', { code: `R2M${String(stamp).slice(-5)}`, name: 'Smoke R2 market' }, A)).json;
  await call('POST', `/admin/locations/${hall.id}/region`, { regionId: region.id }, A);
  const badKey = await call('PUT', `/admin/delivery/policies/markets/${region.id}`, { pay: { waitingPerMinute: 40 }, reason: 'Typo test' }, A);
  const m1 = (await call('PUT', `/admin/delivery/policies/markets/${region.id}`, { pay: { waitingPerMinuteCents: 40, waitingGraceMinutes: 2 }, batching: { maxDropoffSpreadKm: 0.5 }, reason: 'Higher waiting pay downtown' }, A)).json;
  const m2 = (await call('PUT', `/admin/delivery/policies/markets/${region.id}`, { pay: { waitingPerMinuteCents: 40, waitingGraceMinutes: 2, waitingCapMinutes: 20 }, batching: { maxDropoffSpreadKm: 0.5 }, reason: 'Cap waiting at 20 minutes' }, A)).json;
  const eff = (await call('GET', `/admin/delivery/policies/effective?locationId=${hall.id}`, undefined, A)).json;
  const pols = (await call('GET', '/admin/delivery/policies', undefined, A)).json;
  const custPol = await call('GET', '/admin/delivery/policies', undefined, C);
  check('market policies: unknown keys refused, each change versioned, effective policy merges the market over global, staff only', badKey.status === 400 && m1.version === 1 && m2.version === 2 && eff.market?.id === region.id && eff.pay.waitingPerMinuteCents === 40 && eff.pay.waitingCapMinutes === 20 && eff.pay.baseCents === pols.global.pay.baseCents && eff.batching.maxDropoffSpreadKm === 0.5 && pols.markets.some((m) => m.regionId === region.id && m.regionName === 'Smoke R2 market') && custPol.status === 403, { badKey: badKey.json, m1: m1.version, m2: m2.version, eff, cust: custPol.status });

  // ── a fresh approved courier, online at the hall
  const email = `courier-r2-${stamp}@example.com`;
  await call('POST', '/auth/register', { email, password: 'courier12345', name: 'Remy Runner' });
  const X = (await login(email, 'courier12345')).accessToken;
  const drv = (await call('POST', '/driver/apply', { vehicle: 'Car' }, X)).json;
  const exp = new Date(Date.now() + 200 * 86400_000).toISOString();
  for (const kind of ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK']) await call('POST', '/driver/documents', { kind, fileUrl: `https://files.example/r2-${kind}.pdf`, expiresAt: kind === 'BACKGROUND_CHECK' ? undefined : exp }, X);
  for (const d of (await call('GET', '/admin/couriers/documents', undefined, A)).json.pending.filter((d) => d.driverId === drv.id)) await call('POST', `/admin/courier-documents/${d.id}/review`, { approve: true, note: 'Checked' }, A);
  await call('POST', `/drivers/${drv.id}/approve`, { approved: true }, A);
  await call('PATCH', `/admin/couriers/${drv.id}`, { vehicleType: 'CAR', capabilities: ['HOT_BAG'] }, A);
  await call('POST', '/driver/availability', { isAvailable: true, ...here }, X);

  // ── kitchen-ready sync: the offer waits for the food
  await set('delivery.readySync', { enabled: true, offerLeadMinutes: 5, pickupTravelMinutes: 8, resyncMinutes: 3, defaultPrepMinutes: 15 });
  const o1 = await place([{ menuItemId: smash.id, quantity: 1 }, { menuItemId: bowl.id, quantity: 2 }], near, 45);
  const a1 = (await arrivals()).find((r) => r.orderId === o1.id);
  const early = (await call('GET', '/driver/offers', undefined, X)).json.some((x) => x.deliveryJobId === o1.delivery.id);
  check('a delivery accepted 45 min out is held: no offer yet, the kitchen sees the hold, ready estimate and a two-brand manifest', a1 && a1.status === 'REQUESTED' && a1.holdUntil && new Date(a1.holdUntil) > new Date() && a1.estReadyAt && !a1.readyAt && !early && a1.manifest?.brands.length === 2 && a1.manifest.totals.items === 3 && a1.manifest.brands.every((b) => b.items.length && b.bagCount >= 1), { a1, early });

  const later = (await call('POST', `/orders/${o1.id}/ready-estimate`, { minutes: 50 }, O)).json;
  const custEst = await call('POST', `/orders/${o1.id}/ready-estimate`, { minutes: 5 }, C);
  const a1b = (await arrivals()).find((r) => r.orderId === o1.id);
  const gap = (new Date(a1b.estReadyAt) - new Date(a1b.holdUntil)) / 60_000;
  check('the kitchen can push a new ready estimate; the hold moves with it (travel + lead before ready); customers cannot', Math.abs(new Date(later.estReadyAt) - (Date.now() + 50 * 60_000)) < 90_000 && Math.round(gap) === 13 && custEst.status === 403, { later, gap, cust: custEst.status });

  // kitchen finishes: tickets done, bag packed → READY releases the offer at once
  const q1 = (await call('GET', `/kitchens/${kitchenId}/stations/queue`, undefined, O)).json.filter((t) => t.orderId === o1.id);
  for (const t of q1) { await call('POST', `/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }, O); await call('POST', `/tickets/${t.id}/transition`, { status: 'DONE' }, O); }
  const pack = (await call('GET', `/kitchens/${kitchenId}/packing`, undefined, O)).json.find((p) => p.orderId === o1.id);
  if (pack) {
    await call('POST', `/packing/${pack.id}/bags`, { count: 3 }, O);
    for (const l of pack.lines) await call('POST', `/packing/${pack.id}/verify`, { lineId: l.id }, O);
    for (const c of pack.checklist) await call('POST', `/packing/${pack.id}/checklist`, { key: c.key, done: true }, O);
    await call('POST', `/packing/${pack.id}/release`, {}, O);
  }
  const ready = (await call('GET', `/orders/${o1.id}`, undefined, C)).json;
  const off = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o1.delivery.id);
  check('READY releases the held offer: it shows the food is ready, the two-brand manifest with packed bags, the market and its policy', ready.status === 'READY' && off && off.readiness?.status === 'READY' && off.readiness.readyAt && off.manifest?.brands.length === 2 && off.manifest.totals.bags === 3 && off.market?.id === region.id && off.market.name === 'Smoke R2 market' && off.policy?.waitingPerMinuteCents === 40 && off.policy.waitingCapMinutes === 20 && off.policy.dropoffGraceMinutes === 5, { status: ready.status, off });

  // ── multi-brand pickup check
  await call('POST', `/driver/offers/${off.id}`, { accept: true }, X);
  const j1 = (await call('GET', '/driver/jobs', undefined, X)).json.find((j) => j.id === o1.delivery.id);
  await call('POST', `/driver/jobs/${j1.id}/arrived`, { at: 'PICKUP', ...here }, X);
  const [b1, b2] = j1.manifest.brands;
  const noBrands = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j1.orderCode, bagCount: 3, sealIntact: true } }, X);
  const oneBrand = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j1.orderCode, bagCount: 3, sealIntact: true, brands: [{ brandKey: b1.brandKey, bagCount: b1.bagCount, sealIntact: true }] } }, X);
  const torn = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j1.orderCode, bagCount: 3, sealIntact: true, brands: [{ brandKey: b1.brandKey, bagCount: b1.bagCount, sealIntact: true }, { brandKey: b2.brandKey, bagCount: b2.bagCount, sealIntact: false }] } }, X);
  const picked = await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'PICKED_UP', pickupCheck: { orderCode: j1.orderCode, bagCount: 3, sealIntact: true, brands: [{ brandKey: b1.brandKey, bagCount: b1.bagCount, sealIntact: true }, { brandKey: b2.brandKey, bagCount: b2.bagCount, sealIntact: true }] } }, X);
  check('a two-brand order needs every brand’s bags confirmed with intact seals; the job carries readiness and the shelf slot', j1.readiness?.status === 'READY' && 'shelfSlot' in j1 && noBrands.status === 409 && noBrands.json.code === 'MANIFEST_INCOMPLETE' && noBrands.json.missing?.length === 2 && oneBrand.status === 409 && oneBrand.json.missing?.length === 1 && oneBrand.json.missing[0] === b2.brandKey && torn.status === 409 && torn.json.code === 'SEAL_BROKEN' && picked.json?.status === 'PICKED_UP' && picked.json.kitchenDelayMinutes === 0, { j1: { readiness: j1.readiness, shelf: j1.shelfSlot }, noBrands: noBrands.json, oneBrand: oneBrand.json, torn: torn.json, picked: picked.json?.status, delay: picked.json?.kitchenDelayMinutes });

  const pin = (await call('GET', `/orders/${o1.id}`, undefined, C)).json.delivery.handoffPin;
  await call('POST', `/driver/jobs/${j1.id}/arrived`, { at: 'DROPOFF', ...near }, X);
  await call('POST', `/driver/jobs/${j1.id}/transition`, { status: 'DELIVERED', handoffPin: pin }, X);
  const e1 = (await call('GET', '/driver/earnings', undefined, X)).json.entries.find((e) => e.deliveryJobId === j1.id);
  check('earnings record the market and its policy version with the waiting breakdown (no waiting before the food was due)', e1 && e1.kind === 'DELIVERY' && e1.detail?.marketId === region.id && e1.detail.marketVersion === 2 && e1.detail.pickupWaitMinutes === 0 && e1.detail.dropoffWaitMinutes === 0 && e1.detail.kitchenDelayMinutes === 0 && e1.waitingCents === 0, e1);

  // ── batching rules and the preview (market: drop-offs at most 0.5 km apart)
  const o2 = await place([{ menuItemId: bowl.id, quantity: 1 }], near, 15);
  const o3 = await place([{ menuItemId: bowl.id, quantity: 1 }], midtown, 15);
  const same = (await call('POST', '/admin/delivery/batching/preview', { jobId: o2.delivery.id, withJobId: j1.id }, A)).json;
  const apart = (await call('POST', '/admin/delivery/batching/preview', { jobId: o2.delivery.id, withJobId: o3.delivery.id }, A)).json;
  check('batching preview: same kitchen and address batches; drop-offs beyond the market limit do not, with the reason', same.batchable === true && same.reasons.length === 0 && apart.batchable === false && apart.reasons.some((r) => /Drop-offs .* km apart \(max 0.5 km\)/.test(r)) && apart.market?.id === region.id, { same, apart });

  // an order due now is offered at once (no hold); a second offer while carrying a non-batchable order → AT_CAPACITY
  const off2 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o2.delivery.id);
  const off3 = (await call('GET', '/driver/offers', undefined, X)).json.find((x) => x.deliveryJobId === o3.delivery.id);
  const acc2 = await call('POST', `/driver/offers/${off2?.id}`, { accept: true }, X);
  const acc3 = off3 ? await call('POST', `/driver/offers/${off3.id}`, { accept: true }, X) : { status: 0, json: {} };
  check('an order due now is offered without a hold; accepting a second, non-batchable offer is refused (AT_CAPACITY)', off2 && off2.readiness?.status === 'PREPARING' && acc2.status < 300 && acc3.status === 409 && acc3.json.code === 'AT_CAPACITY', { off2: !!off2, off3: !!off3, acc2: acc2.status, acc3: acc3.json });

  // the kitchen finishing an order whose courier is already assigned
  const q2 = (await call('GET', `/kitchens/${kitchenId}/stations/queue`, undefined, O)).json.filter((t) => t.orderId === o2.id);
  for (const t of q2) { await call('POST', `/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }, O); await call('POST', `/tickets/${t.id}/transition`, { status: 'DONE' }, O); }
  const p2 = (await call('GET', `/kitchens/${kitchenId}/packing`, undefined, O)).json.find((p) => p.orderId === o2.id);
  if (p2) { for (const l of p2.lines) await call('POST', `/packing/${p2.id}/verify`, { lineId: l.id }, O); for (const c of p2.checklist) await call('POST', `/packing/${p2.id}/checklist`, { key: c.key, done: true }, O); await call('POST', `/packing/${p2.id}/release`, {}, O); }
  const j2r = (await call('GET', '/driver/jobs', undefined, X)).json.find((j) => j.id === o2.delivery.id);
  const kev = (await call('GET', `/orders/${o2.id}/timeline`, undefined, C)).json;
  check('READY reaches the courier already on the way: the job turns ready with a shelf slot', j2r?.readiness?.status === 'READY' && kev.delivery?.events?.some((e) => e.type === 'KITCHEN_READY'), { j2r: j2r?.readiness, shelf: j2r?.shelfSlot, events: kev.delivery?.events?.map((e) => e.type) });

  // ── partner reconciliation and connectivity test
  const rec = (await call('GET', '/admin/delivery/reconciliation', undefined, A)).json;
  const recCust = await call('GET', '/admin/delivery/reconciliation', undefined, C);
  const t = (await call('POST', '/admin/delivery/providers/mock/test', {}, A)).json;
  const tMissing = await call('POST', '/admin/delivery/providers/nope/test', {}, A);
  check('reconciliation lists partner jobs with quoted vs reported fees; the connectivity test quotes without creating a delivery', Array.isArray(rec.rows) && rec.totals && typeof rec.totals.quotedCents === 'number' && rec.rows.every((r) => typeof r.quotedCents === 'number' && 'actualCents' in r && 'varianceCents' in r) && recCust.status === 403 && t.ok === true && t.quote?.feeCents > 0 && tMissing.status === 404, { rows: rec.rows?.length, totals: rec.totals, t, missing: tMissing.status });

  // ── cleanup: close the open trips, take the courier offline, remove the market, restore the region and settings
  await call('POST', `/delivery-jobs/${o2.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);
  await call('POST', `/delivery-jobs/${o3.delivery.id}/cancel`, { reason: 'Smoke cleanup', costOwner: 'PLATFORM' }, O);
  await call('POST', '/driver/availability', { isAvailable: false }, X);
  const del = (await call('DELETE', `/admin/delivery/policies/markets/${region.id}`, { reason: 'Smoke cleanup' }, A)).json;
  const effAfter = (await call('GET', `/admin/delivery/policies/effective?locationId=${hall.id}`, undefined, A)).json;
  await call('POST', `/admin/locations/${hall.id}/region`, { regionId: locBefore.regionId ?? null }, A);
  await set('delivery.readySync', { enabled: false });
  check('removing a market falls back to the global policy', del.ok === true && effAfter.market === null && effAfter.pay.waitingPerMinuteCents === pols.global.pay.waitingPerMinuteCents, effAfter);
}
