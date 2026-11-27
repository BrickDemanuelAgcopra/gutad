// Packaged goods: GTIN rules, product creation and review (merchant and Gutad first-party), dated batches,
// sell-by cutoff, first-expiry-first reservation at checkout, release on reject (trigger), sale on handoff (trigger),
// stock held against waste, kitchen PICK ticket, expiry sweep, recalls (store batch, Gutad-wide GTIN), kill switch,
// label change back to review, admin overview.
export async function packagedPhase({ call, check, A, O, C, locId }) {
  console.log('\n── Packaged goods');
  const stamp = Date.now().toString(36);
  const reason = 'Smoke packaged goods';
  const shared = await import('../packages/shared/dist/index.js');
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // ── pure rules
  check('GTIN: UPC-A normalised to 14 digits', shared.normalizeGtin('0 36000 29145 2') === '00036000291452');
  check('GTIN: wrong check digit refused', shared.normalizeGtin('036000291453') === null && shared.normalizeGtin('12345') === null);
  const pm = shared.packagedPolicy({ categories: { ALCOHOL: { allowed: true } }, minRemainingDays: { CHILLED: 4 } });
  check('policy merges per category and storage over defaults', pm.categories.ALCOHOL.allowed && pm.categories.ALCOHOL.taxCategory === 'ALCOHOL' && pm.minRemainingDays.CHILLED === 4 && pm.minRemainingDays.AMBIENT === 30);
  check('review rule: first-party exempt only when configured', shared.needsReview(pm, 'SAUCES', true) && !shared.needsReview({ ...pm, reviewFirstParty: false }, 'SAUCES', true));

  // ── policy known state
  const pol0 = (await call('GET', '/admin/packaged/policy', undefined, A)).json;
  check('staff read the policy', pol0.policy?.enabled !== undefined, pol0);
  check('customers cannot read packaged admin', (await call('GET', '/admin/packaged', undefined, C)).status === 403);
  const base = { ...shared.DEFAULT_PACKAGED_POLICY };
  const saved = await call('PUT', '/admin/packaged/policy', { policy: base, reason }, A);
  check('policy saved (audited)', saved.status < 300 && saved.json.requireReview === true, saved.json);
  check('merchants cannot change the policy', (await call('PUT', '/admin/packaged/policy', { policy: base, reason }, O)).status === 403);

  // ── merchant (third party) creates a product: validation and review
  const mMenu = (await call('POST', `/locations/${locId}/menus`, { name: `Pantry ${stamp}` }, O)).json;
  const mCat = (await call('POST', `/menus/${mMenu.id}/categories`, { name: 'Jars' }, O)).json;
  const prod = (over = {}) => ({ name: `Chili crisp ${stamp}`, priceCents: 1200, category: 'SAUCES', storage: 'AMBIENT', dateType: 'BEST_BEFORE', brandName: 'Smoke Foods', size: 200, sizeUom: 'g', gtin: '036000291452', ingredientsText: 'Soybean oil, chili, garlic, salt', allergens: ['soy'], ...over });
  const badGtin = await call('POST', `/categories/${mCat.id}/packaged`, prod({ gtin: '036000291453' }), O);
  check('invalid barcode refused', badGtin.status === 400 && badGtin.json.code === 'GTIN_INVALID', badGtin.json);
  const alcohol = await call('POST', `/categories/${mCat.id}/packaged`, prod({ category: 'ALCOHOL' }), O);
  check('blocked category refused (alcohol off by default)', alcohol.status === 400 && alcohol.json.code === 'PACKAGED_CATEGORY_BLOCKED', alcohol.json);
  const m1 = await call('POST', `/categories/${mCat.id}/packaged`, prod(), O);
  check('merchant product created, waiting for review, grocery tax', m1.status < 300 && m1.json.product.reviewStatus === 'PENDING' && m1.json.item.kind === 'PACKAGED' && m1.json.item.taxCategory === 'GROCERY' && m1.json.product.gtin === '00036000291452', m1.json);
  const mView = (await call('GET', `/locations/${locId}/packaged`, undefined, O)).json;
  check('store sees the product with no stock', mView.products?.some((p) => p.itemId === m1.json.item.id && p.available === 0 && p.gate), mView.products?.map((p) => [p.name, p.available, p.gate]));
  const queue = (await call('GET', '/admin/packaged/products?status=PENDING', undefined, A)).json;
  check('review queue lists it with the seller', queue.some((r) => r.menuItemId === m1.json.item.id && r.organizationName && !r.firstParty), queue.length);
  check('reject needs the right state and a note', (await call('POST', `/admin/packaged/products/${m1.json.item.id}/review`, { decision: 'REJECT', note: '' }, A)).status === 400);
  const rej = await call('POST', `/admin/packaged/products/${m1.json.item.id}/review`, { decision: 'REJECT', note: 'Add the full ingredient list' }, A);
  check('staff reject with a note', rej.status < 300 && rej.json.reviewStatus === 'REJECTED', rej.json);
  check('store resubmits a rejected product', (await call('POST', `/packaged/${m1.json.item.id}/submit`, {}, O)).json.reviewStatus === 'PENDING');
  check('merchants cannot approve their own product', (await call('POST', `/admin/packaged/products/${m1.json.item.id}/review`, { decision: 'APPROVE', note: 'self' }, O)).status === 403);

  // ── a Gutad (first-party) store to order from
  const fpOv = (await call('GET', '/admin/first-party', undefined, A)).json;
  if (!fpOv.org) await call('POST', '/admin/first-party/setup', { name: 'Gutad' }, A);
  const loc = (await call('POST', '/admin/first-party/locations', { name: `Gutad Pantry ${stamp}`, cuisine: ['grocery'], addressLine1: '410 W 14th St', city: 'New York', region: 'NY', postalCode: '10014', lat: 40.7417, lng: -74.0063, acceptsPickup: true, acceptsDelivery: false }, A)).json;
  await call('PATCH', `/locations/${loc.id}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opens: '00:00', closes: '23:59' })) }, A);
  const menu = (await call('POST', `/locations/${loc.id}/menus`, { name: 'Pantry' }, A)).json;
  const cat = (await call('POST', `/menus/${menu.id}/categories`, { name: 'Sauces' }, A)).json;
  await call('POST', `/locations/${loc.id}/verify`, { verified: true }, A);
  const settings = (await call('GET', '/admin/settings', undefined, A)).json.settings ?? {};
  const prevReadiness = settings['launch.require_readiness'];
  await call('POST', '/admin/settings', { key: 'launch.require_readiness', value: false, reason }, A);
  const live = (await call('POST', `/locations/${loc.id}/status`, { status: 'LIVE' }, A)).json;
  await call('POST', '/admin/settings', { key: 'launch.require_readiness', value: prevReadiness ?? true, reason }, A);
  check('Gutad pantry store live', live.status === 'LIVE', live);
  const g = (await call('POST', `/categories/${cat.id}/packaged`, prod({ name: `Gutad chili oil ${stamp}`, sku: 'G-CO-1' }), A)).json;
  check('Gutad’s own product goes through the same review', g.product?.reviewStatus === 'PENDING', g);
  check('a merchant cannot touch Gutad’s product', (await call('PATCH', `/packaged/${g.item.id}`, { brandName: 'x' }, O)).status === 403);
  const pubItem = async () => (await call('GET', `/public/locations/${loc.id}/menus?channel=MARKETPLACE`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === g.item.id);
  check('unapproved product shows sold out', (await pubItem())?.soldOut === true);
  const q0 = await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: g.item.id, quantity: 1 }] }, C);
  check('quote refuses an unapproved product', q0.status === 400 && q0.json.code === 'OUT_OF_STOCK', q0.json);
  check('staff approve', (await call('POST', `/admin/packaged/products/${g.item.id}/review`, { decision: 'APPROVE', note: 'Label checked' }, A)).json.reviewStatus === 'APPROVED');

  // ── batches and the sell-by cutoff (AMBIENT: 30 days)
  const rcv = (body) => call('POST', `/packaged/${g.item.id}/lots`, { locationId: loc.id, ...body }, A);
  check('receiving needs the date on the pack', (await rcv({ quantity: 5 })).json.code === 'EXPIRY_REQUIRED');
  check('expired stock cannot be received', (await rcv({ quantity: 5, expiresOn: day(-2) })).json.code === 'EXPIRY_PAST');
  const lotShort = (await rcv({ quantity: 3, expiresOn: day(10), lotCode: `SHORT-${stamp}` })).json;
  const lotLate = (await rcv({ quantity: 5, expiresOn: day(200), lotCode: `LATE-${stamp}`, unitCostCents: 300 })).json;
  const lotEarly = (await rcv({ quantity: 4, expiresOn: day(100), lotCode: `EARLY-${stamp}`, unitCostCents: 250 })).json;
  check('three batches received', lotShort.id && lotLate.id && lotEarly.id, { lotShort, lotLate, lotEarly });
  const it1 = await pubItem();
  check('only batches with 30+ days left count: 9 for sale', it1 && !it1.soldOut && it1.packaged?.storage === 'AMBIENT' && it1.packaged.size === '200 g' && it1.packaged.minShelfLifeDays === 30 && it1.packaged.onlyLeft === null, it1);
  const sweep = (await call('POST', '/admin/packaged/sweep', {}, A)).json;
  const view = async () => (await call('GET', `/locations/${loc.id}/packaged`, undefined, A)).json;
  const lotOf = (v, id) => v.products.find((p) => p.itemId === g.item.id)?.lots.find((l) => l.id === id);
  const v1 = await view();
  check('expiry sweep: the short-dated batch stops selling and is listed to remove', sweep.expired >= 1 && lotOf(v1, lotShort.id)?.status === 'EXPIRED' && v1.toRemove.some((r) => r.lotId === lotShort.id) && v1.products.find((p) => p.itemId === g.item.id)?.available === 9, { sweep, toRemove: v1.toRemove });

  // ── checkout reserves first expiry first; reject releases (trigger)
  const tooMany = await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: g.item.id, quantity: 10 }] }, C);
  check('quote over stock refused with what is left', tooMany.status === 400 && tooMany.json.code === 'OUT_OF_STOCK' && tooMany.json.available === 9, tooMany.json);
  const order = async (qty) => {
    const q = (await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: g.item.id, quantity: qty }] }, C)).json;
    return (await call('POST', '/orders', { quoteId: q.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  };
  const o1 = await order(6);
  const v2 = await view();
  check('order holds 6: 4 from the earliest batch, 2 from the next', o1.id && lotOf(v2, lotEarly.id)?.reserved === 4 && lotOf(v2, lotLate.id)?.reserved === 2, { o1: o1.id || o1, early: lotOf(v2, lotEarly.id), late: lotOf(v2, lotLate.id) });
  check('"Only 3 left" shown to customers', (await pubItem())?.packaged?.onlyLeft === 3);
  const waste = await call('POST', `/packaged-lots/${lotEarly.id}/adjust`, { kind: 'WASTE', quantity: 1, reason: 'Dropped jar' }, A);
  check('held units cannot be wasted away', waste.status === 409 && waste.json.code === 'STOCK_HELD', waste.json);
  await call('POST', `/orders/${o1.id}/reject`, { reason: 'Smoke: reject releases stock' }, A);
  const v3 = await view();
  check('rejecting the order releases the units (database trigger)', lotOf(v3, lotEarly.id)?.reserved === 0 && lotOf(v3, lotLate.id)?.reserved === 0 && v3.products.find((p) => p.itemId === g.item.id)?.available === 9, { early: lotOf(v3, lotEarly.id), late: lotOf(v3, lotLate.id) });

  // ── a sale: pick ticket, handoff takes units off the shelf
  const o2 = await order(2);
  const acc = (await call('POST', `/orders/${o2.id}/accept`, { prepMinutes: 5 }, A)).json;
  check('second order accepted', acc.status === 'ACCEPTED' || acc.status === 'PREPARING', acc.status);
  const tl = (await call('GET', `/orders/${o2.id}/timeline`, undefined, A)).json;
  check('packaged lines go to a PICK ticket', (tl.tickets || []).some((x) => x.stationCode === 'PICK'), (tl.tickets || []).map((x) => x.stationCode));
  await call('POST', `/orders/${o2.id}/ready`, {}, A);
  const ho = await call('POST', `/orders/${o2.id}/handoff`, { pickupCode: o2.pickupCode }, A);
  check('handoff completes the order', ho.status < 300, ho.json);
  const v4 = await view();
  check('handoff sells the units: earliest batch 4 → 2 on shelf, none held', lotOf(v4, lotEarly.id)?.onHand === 2 && lotOf(v4, lotEarly.id)?.reserved === 0, lotOf(v4, lotEarly.id));
  const moves = (await call('GET', `/packaged/${g.item.id}/movements?locationId=${loc.id}`, undefined, A)).json;
  check('stock history: receipt, reserve, release, sale', ['RECEIPT', 'RESERVE', 'RELEASE', 'SALE', 'EXPIRED'].every((k) => moves.some((m) => m.kind === k)), moves.map((m) => m.kind));
  const led = (await call('GET', `/finance/ledger?orderId=${o2.id}`, undefined, A)).json;
  check('Gutad sale: cost of goods from the batch cost (2 × $2.50)', (led.entries || []).filter((e) => e.account === 'PLATFORM_EXPENSE_COGS').reduce((s, e) => s + e.debitCents, 0) === 500, (led.entries || []).map((e) => [e.account, e.debitCents - e.creditCents]));

  // ── recalls
  const rc1 = await call('POST', `/locations/${loc.id}/packaged/recalls`, { scope: 'LOT', lotIds: [lotEarly.id], reason: 'Seal may be faulty on this batch', severity: 'HIGH' }, A);
  check('store recall of one batch: customer of the sold order notified', rc1.status < 300 && rc1.json.lotsAffected === 1 && rc1.json.customersNotified === 1, rc1.json);
  const v5 = await view();
  check('recalled batch stops selling', lotOf(v5, lotEarly.id)?.status === 'RECALLED' && v5.products.find((p) => p.itemId === g.item.id)?.available === 5, v5.products.find((p) => p.itemId === g.item.id)?.available);
  check('a recalled batch cannot be returned to stock', (await call('POST', `/packaged-lots/${lotEarly.id}/adjust`, { kind: 'RETURN', quantity: 1, reason: 'test' }, A)).json.code === 'LOT_RECALLED');
  const o3 = await order(1);
  check('an order holding the last good batch', !!o3.id, o3);
  const rc2 = await call('POST', '/admin/packaged/recalls', { scope: 'GTIN', gtin: '036000291452', reason: 'Manufacturer recall: undeclared peanut', severity: 'CRITICAL' }, A);
  check('Gutad-wide barcode recall pulls every seller’s batches', rc2.status < 300 && rc2.json.organizationId === null && rc2.json.lotsAffected >= 2, rc2.json);
  const o3l = (await call('GET', `/orders/${o3.id}`, undefined, C)).json;
  check('open order holding a recalled batch: line marked unavailable', (o3l.lines || []).some((l) => l.status === 'UNAVAILABLE'), o3l.lines);
  check('product sold out after the recall', (await pubItem())?.soldOut === true);
  check('merchants cannot start a Gutad-wide recall', (await call('POST', '/admin/packaged/recalls', { scope: 'GTIN', gtin: '036000291452', reason: 'nope nope' }, O)).status === 403);
  const recs = (await call('GET', '/admin/packaged/recalls', undefined, A)).json;
  check('recall list shows both', recs.some((r) => r.id === rc1.json.id) && recs.some((r) => r.id === rc2.json.id));
  check('close a recall with a note', (await call('POST', `/packaged-recalls/${rc2.json.id}/close`, { note: 'All stock destroyed' }, A)).json.status === 'CLOSED');

  // ── label change back to review; kill switch
  await rcv({ quantity: 6, expiresOn: day(150), lotCode: `NEW-${stamp}` });
  check('fresh stock sells again', (await pubItem())?.soldOut === false);
  const upd = (await call('PATCH', `/packaged/${g.item.id}`, { ingredientsText: 'Soybean oil, chili, garlic, salt, peanuts', allergens: ['soy', 'peanuts'] }, A)).json;
  check('label change sends the product back to review', upd.product?.reviewStatus === 'PENDING', upd.product);
  check('…and it stops selling until approved', (await pubItem())?.soldOut === true);
  await call('POST', `/admin/packaged/products/${g.item.id}/review`, { decision: 'APPROVE', note: 'New label checked' }, A);
  const off = await call('PUT', '/admin/packaged/policy', { policy: { enabled: false }, reason }, A);
  check('kill switch off', off.status < 300 && off.json.enabled === false);
  const q4 = await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: g.item.id, quantity: 1 }] }, C);
  check('kill switch: checkout refuses packaged goods', q4.status === 400 && q4.json.code === 'OUT_OF_STOCK', q4.json);
  await call('PUT', '/admin/packaged/policy', { policy: { enabled: true }, reason }, A);
  check('kill switch back on', (await pubItem())?.soldOut === false);

  // ── overview
  const ov = (await call('GET', '/admin/packaged', undefined, A)).json;
  check('overview: sales by category, recalls, review counts', ov.sales30d?.some((s) => s.category === 'SAUCES' && s.units >= 2 && s.first_party_units >= 2) && typeof ov.review.PENDING === 'number', { sales: ov.sales30d, review: ov.review });
  await call('PUT', '/admin/packaged/policy', { policy: pol0.policy, reason: 'Smoke packaged: restore previous policy' }, A);
}
