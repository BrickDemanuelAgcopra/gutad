// Admin platform, phase D checks: menu catalog & versions, recipes, pricing, fees & tax.
export async function adminPhaseD({ call, check, A, O, C, locId, demoOrgId }) {
  console.log('\n── Admin platform D: menus, recipes, pricing');
  const stamp = Date.now();
  const menusOf = async (lid, ch = 'DIRECT') => (await call('GET', `/public/locations/${lid}/menus?channel=${ch}`)).json;
  const itemsOf = async (lid, ch) => (await menusOf(lid, ch)).flatMap((m) => m.categories.flatMap((c) => c.items));
  const quote = (lid, lines, extra = {}, ch = 'DIRECT') => call('POST', '/quotes', { locationId: lid, channel: ch, fulfillmentType: 'PICKUP', lines, ...extra }, C);
  const bistroMenu = (await menusOf(locId))[0];
  const lemonade = bistroMenu.categories.flatMap((c) => c.items).find((i) => i.name === 'House lemonade');
  const burger = bistroMenu.categories.flatMap((c) => c.items).find((i) => i.name === 'Bistro burger');
  const done = burger.modifierGroups.find((g) => g.name === 'Doneness').options[0].id;

  // 7.1 / 7.3 / 7.6 item details & 11.2 quantity limit
  await call('PATCH', `/items/${lemonade.id}`, { servingSize: '16 oz', nutrition: { calories: 140, sugarG: 32 }, kind: 'BEVERAGE', maxPerOrder: 3 }, O);
  const pub = (await itemsOf(locId)).find((i) => i.id === lemonade.id);
  check('items carry serving size, nutrition and kind', pub.servingSize === '16 oz' && pub.nutrition?.calories === 140 && pub.kind === 'BEVERAGE', pub);
  const tooMany = await quote(locId, [{ menuItemId: lemonade.id, quantity: 4 }]);
  check('per-item quantity limit at checkout', tooMany.status === 400 && tooMany.json.code === 'QUANTITY_LIMIT', tooMany.json);
  await call('PATCH', `/items/${lemonade.id}`, { maxPerOrder: null }, O);

  // 7.5 daypart enforced at checkout
  await call('PATCH', `/menus/${bistroMenu.id}`, { availableFrom: '00:00', availableUntil: '00:01' }, O);
  const offHours = await quote(locId, [{ menuItemId: lemonade.id, quantity: 1 }]);
  await call('PATCH', `/menus/${bistroMenu.id}`, { availableFrom: null, availableUntil: null }, O);
  check('menu daypart applies at checkout, not just on the public menu', offHours.status === 400, offHours.json?.message);

  // 7.7 draft → publish → rollback
  const draft = (await call('POST', `/menus/${bistroMenu.id}/drafts`, { note: 'Spring prices' }, O)).json;
  const doc = draft.document;
  const cat = doc.categories.find((c) => c.items.some((i) => i.id === lemonade.id));
  cat.items = cat.items.map((i) => (i.id === lemonade.id ? { ...i, priceCents: i.priceCents + 100 } : i));
  cat.items.push({ name: `Smoke soda ${stamp}`, priceCents: 350, kind: 'BEVERAGE' });
  const saved = await call('PUT', `/menu-versions/${draft.id}`, { document: doc }, O);
  const bad = await call('PUT', `/menu-versions/${draft.id}`, { document: { categories: [{ name: '', items: [{ name: '', priceCents: -1 }] }] } }, O);
  const diff = (await call('GET', `/menu-versions/${draft.id}/diff`, undefined, O)).json;
  check('drafts are validated and diffed against the live menu', saved.status === 200 && bad.status === 400 && diff.added?.some((a) => a.name.startsWith('Smoke soda')) && diff.changed?.some((c) => c.fields.some((f) => f.field === 'priceCents')), { added: diff.added?.length, changed: diff.changed?.length });
  const pub1 = await call('POST', `/menu-versions/${draft.id}/publish`, { note: 'Spring update' }, O);
  const live1 = await itemsOf(locId);
  check('publishing a version updates the live menu', pub1.json.status === 'PUBLISHED' && live1.find((i) => i.id === lemonade.id).priceCents === lemonade.priceCents + 100 && live1.some((i) => i.name.startsWith('Smoke soda')), pub1.json.status);
  const vers = (await call('GET', `/menus/${bistroMenu.id}/versions`, undefined, O)).json;
  const baseline = vers.versions.find((v) => v.status === 'SUPERSEDED');
  check('version history keeps the previous live menu', vers.versions.length >= 2 && baseline, vers.versions.map((v) => `${v.version}:${v.status}`));
  const rb = (await call('POST', `/menu-versions/${baseline.id}/rollback`, { reason: 'Prices went live too early' }, O)).json;
  const live2 = await itemsOf(locId);
  check('rollback restores the earlier menu', rb.status === 'PUBLISHED' && live2.find((i) => i.id === lemonade.id).priceCents === lemonade.priceCents && !live2.some((i) => i.name.startsWith('Smoke soda')), rb.status);
  await call('POST', '/admin/settings', { key: 'menus.require_review', value: true, reason: 'Smoke: require menu review' }, A);
  const d2 = (await call('POST', `/menus/${bistroMenu.id}/drafts`, {}, O)).json;
  const selfPub = await call('POST', `/menu-versions/${d2.id}/publish`, {}, O);
  await call('POST', `/menu-versions/${d2.id}/submit`, {}, O);
  const revPub = await call('POST', `/menu-versions/${d2.id}/publish`, { note: 'Reviewed by Gutad catalog' }, A);
  await call('POST', '/admin/settings', { key: 'menus.require_review', value: false, reason: 'Smoke: menu review off' }, A);
  check('with review on, someone other than the author publishes', selfPub.status === 403 && selfPub.json.code === 'REVIEW_REQUIRED' && revPub.json.status === 'PUBLISHED', [selfPub.status, revPub.json.status]);

  // 7.8 export & import validation
  const csvRes = await fetch(`${process.env.API_URL || 'http://localhost:4000'}/menus/${bistroMenu.id}/export?format=csv`, { headers: { Authorization: `Bearer ${O}` } });
  const val = (await call('POST', `/locations/${locId}/menus/validate-import`, { categories: [{ name: 'Drinks', items: [{ name: 'House lemonade', priceCents: 500 }, { name: 'Iced tea', priceCents: 400 }, { name: 'Iced tea', priceCents: 400 }, { name: 'Free water', priceCents: -5 }] }] }, O)).json;
  check('menu export and import validation (errors, duplicates, already on menu)', csvRes.status === 200 && (await csvRes.text()).startsWith('category,id,name') && !val.ok && val.duplicates.includes('iced tea') && val.alreadyOnMenu.includes('House lemonade'), { ok: val.ok, dup: val.duplicates, on: val.alreadyOnMenu });

  // 7.2 shared modifier groups
  const groups = (await call('GET', `/menus/${bistroMenu.id}/modifier-groups`, undefined, O)).json;
  const extras = groups.find((g) => g.name === 'Extras');
  await call('POST', `/items/${lemonade.id}/modifier-groups/${extras.id}`, {}, O);
  const withGroup = (await itemsOf(locId)).find((i) => i.id === lemonade.id);
  await call('DELETE', `/items/${lemonade.id}/modifier-groups/${extras.id}`, undefined, O);
  check('a modifier group is reused across items', withGroup.modifierGroups.some((g) => g.id === extras.id) && extras.usedBy >= 1, withGroup.modifierGroups.map((g) => g.name));

  // 7.4 shared menu across locations with a per-location price
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  await call('PUT', `/menus/${bistroMenu.id}/sharing`, { locationIds: [hall.id] }, O);
  await call('PUT', `/items/${lemonade.id}/locations/${hall.id}`, { priceCents: 777 }, O);
  const hallLemon = (await itemsOf(hall.id)).find((i) => i.id === lemonade.id);
  const hallQuote = (await quote(hall.id, [{ menuItemId: lemonade.id, quantity: 1 }])).json;
  check('menu shared to another location with a location price', hallLemon?.priceCents === 777 && hallQuote.subtotalCents === 777, { menu: hallLemon?.priceCents, quote: hallQuote.subtotalCents });
  await call('PUT', `/menus/${bistroMenu.id}/sharing`, { locationIds: [] }, O);
  const unshared = (await itemsOf(hall.id)).find((i) => i.id === lemonade.id);
  check('unsharing removes it from that location', !unshared, !!unshared);

  // 8 recipes: org ingredients with allergens, versions, trials, release approval, traceability, acknowledgments
  const globalIng = await call('POST', '/ingredients', { name: `Smoke global ${stamp}`, unit: 'g' }, O);
  const lemons = (await call('POST', '/ingredients', { organizationId: demoOrgId, name: `Lemons ${stamp}`, unit: 'each', costCentsPerUnit: 40 }, O)).json;
  const honey = (await call('POST', '/ingredients', { organizationId: demoOrgId, name: `Milk foam ${stamp}`, unit: 'ml', costCentsPerUnit: 1, allergens: ['milk'] }, O)).json;
  check('merchants keep their own ingredients; the shared catalog is Gutad-only', globalIng.status === 403 && lemons.id && honey.allergens.includes('milk'), globalIng.status);
  const r1 = (await call('POST', `/organizations/${demoOrgId}/recipes`, { name: `Lemonade ${stamp}`, yieldPortions: 4, laborMinutes: 8, portionSize: '16 oz', lines: [{ ingredientId: lemons.id, quantity: 6 }], steps: [{ n: 1, text: 'Juice lemons', stationCode: 'BAR', minutes: 5 }], equipment: ['citrus press'] }, O)).json;
  const selfApprove = await call('POST', `/recipes/${r1.id}/approve`, { note: 'mine' }, O);
  await call('POST', `/recipes/${r1.id}/trials`, { notes: 'Too sour, add 10% sugar', score: 3 }, O);
  const a1 = (await call('POST', `/recipes/${r1.id}/approve`, { note: 'Approved after trial' }, A)).json;
  check('recipes need a test trial record and release approval by someone else', r1.status === 'DRAFT' && selfApprove.status === 403 && a1.recipe?.status === 'APPROVED', [r1.status, selfApprove.status, a1.recipe?.status]);
  await call('PATCH', `/items/${lemonade.id}`, { recipeId: r1.id }, O);
  const editApproved = await call('PATCH', `/recipes/${r1.id}`, { laborMinutes: 1 }, O);
  const r2 = (await call('POST', `/organizations/${demoOrgId}/recipes`, { previousRecipeId: r1.id, name: `Lemonade ${stamp}`, changeSummary: 'Add milk foam topping', lines: [{ ingredientId: lemons.id, quantity: 6 }, { ingredientId: honey.id, quantity: 40 }] }, O)).json;
  const a2 = (await call('POST', `/recipes/${r2.id}/approve`, { note: 'Foam approved' }, A)).json;
  const review = (await call('GET', `/organizations/${demoOrgId}/allergen-review`, undefined, O)).json;
  const al = (await call('GET', `/items/${lemonade.id}/allergens`, undefined, O)).json;
  check('approved recipes change by new version; the new version replaces the old on menu items', editApproved.status === 409 && r2.version === 2 && a2.recipe.status === 'APPROVED', [editApproved.status, r2.version]);
  check('recipe change adding an allergen flags the menu item for review', a2.allergenReview?.some((f) => f.id === lemonade.id && f.missing.includes('milk')) && review.some((i) => i.id === lemonade.id) && al.missing.includes('milk'), { flagged: a2.allergenReview, al });
  await call('PATCH', `/items/${lemonade.id}`, { allergens: ['milk'], allergenReviewNeeded: false }, O);
  const det = (await call('GET', `/recipes/${r2.id}`, undefined, O)).json;
  check('recipe detail: plate cost, dish margin, steps, history', det.costing.plateCostCents > 0 && det.costing.items.some((i) => i.id === lemonade.id && typeof i.marginPct === 'number') && det.history.some((h) => h.id === r1.id), det.costing);
  const ack = await call('POST', `/recipes/${r2.id}/acknowledge`, {}, O);
  const det2 = (await call('GET', `/recipes/${r2.id}`, undefined, O)).json;
  check('kitchen staff acknowledge recipe changes', ack.status === 201 && det2.acknowledgments.length >= 1, det2.acknowledgments.length);
  await call('PATCH', `/items/${lemonade.id}`, { allergens: [] }, O);

  // 9.5 tax categories
  await call('POST', '/admin/tax-rates', { locationId: locId, category: 'BEVERAGE', rateBps: 0, label: 'Smoke: beverages exempt' }, A);
  await call('PATCH', `/items/${lemonade.id}`, { taxCategory: 'BEVERAGE' }, O);
  const qMix = (await quote(locId, [{ menuItemId: lemonade.id, quantity: 1 }, { menuItemId: burger.id, quantity: 1, modifierOptionIds: [done] }])).json;
  const qLem = (await quote(locId, [{ menuItemId: lemonade.id, quantity: 1 }])).json;
  const eff = (await call('GET', `/tax-rates?locationId=${locId}`, undefined, O)).json;
  check('tax by item category: exempt beverage, taxed food', qLem.taxCents === 0 && qMix.taxCents > 0 && eff.effective.find((e) => e.category === 'BEVERAGE').source === 'location', { lem: qLem.taxCents, mix: qMix.taxCents });
  await call('PATCH', `/items/${lemonade.id}`, { taxCategory: 'STANDARD' }, O);

  // 9.2 packaging fee to the merchant
  await call('PATCH', `/locations/${locId}`, { packagingFeeCents: 50 }, O);
  const qPack = (await quote(locId, [{ menuItemId: lemonade.id, quantity: 1 }])).json;
  const ord = (await call('POST', '/orders', { quoteId: qPack.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  const acc = await call('POST', `/orders/${ord.id}/accept`, {}, O);
  await call('PATCH', `/locations/${locId}`, { packagingFeeCents: null }, O);
  check('packaging fee is quoted, charged and posted to the ledger on capture', qPack.packagingFeeCents === 50 && qPack.totalCents === qPack.subtotalCents + qPack.taxCents + 50 && acc.status === 201, { pack: qPack.packagingFeeCents, accept: acc.status });

  // 9.6 split-funded promotion
  const coupon = (await call('POST', `/organizations/${demoOrgId}/coupons`, { code: `SPLIT${String(stamp).slice(-5)}`, kind: 'PERCENT', value: 20, funder: 'PLATFORM', platformSharePct: 25 }, A)).json;
  const ownerSplit = await call('POST', `/organizations/${demoOrgId}/coupons`, { kind: 'PERCENT', value: 10, platformSharePct: 50 }, O);
  const simPromo = (await call('POST', '/pricing/simulate', { cart: { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: burger.id, quantity: 2, modifierOptionIds: [done] }], promoCode: coupon.code }, draft: {} }, A)).json;
  check('promotion funding can be split between platform and merchant', ownerSplit.status === 403 && simPromo.current.promotionFunder === 'SPLIT' && simPromo.current.promotionPlatformShareCents === Math.round(simPromo.current.discountCents * 0.25), simPromo.current && { f: simPromo.current.promotionFunder, share: simPromo.current.promotionPlatformShareCents, d: simPromo.current.discountCents });

  // 9.8 simulator & 9.2 fee rule change through approval
  const fees = (await call('GET', '/admin/pricing/fees', undefined, A)).json;
  const draftRules = { ...fees.rules, smallOrder: { thresholdCents: 1500, feeCents: 200, channels: [], fulfillments: [] } };
  const sim = (await call('POST', '/pricing/simulate', { cart: { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }] }, draft: { feeRules: draftRules, priceOverrides: { [lemonade.id]: 600 }, taxRates: { STANDARD: 1000 } } }, O)).json;
  check('checkout-price simulation compares current and draft rules', sim.proposed.smallOrderFeeCents === 200 && sim.proposed.subtotalCents === 600 && sim.delta.totalCents > 0 && sim.current.smallOrderFeeCents === 0, sim.delta);
  const req = (await call('POST', '/admin/pricing/fees', { rules: draftRules, reason: 'Smoke: small-order fee pilot' }, A)).json;
  check('customer fee rule changes need a second approver', req.status === 'PENDING_APPROVAL', req.status);
  await call('POST', `/approvals/${req.approval.id}/cancel`, {}, A);

  // 9.7 effective-dated price changes & history
  const now = (await call('POST', `/items/${burger.id}/price-changes`, { newPriceCents: burger.priceCents + 50, reason: 'Beef cost up' }, O)).json;
  const later = (await call('POST', `/items/${burger.id}/price-changes`, { newPriceCents: burger.priceCents + 200, effectiveAt: new Date(Date.now() + 7 * 86400_000).toISOString(), reason: 'Summer price' }, O)).json;
  const hist = (await call('GET', `/items/${burger.id}/price-history`, undefined, O)).json;
  await call('DELETE', `/price-changes/${later.id}`, undefined, O);
  await call('POST', `/items/${burger.id}/price-changes`, { newPriceCents: burger.priceCents, reason: 'Smoke: restore' }, O);
  check('price changes take effect now or on a date, with history', now.status === 'APPLIED' && later.status === 'SCHEDULED' && hist.history.some((h) => h.action === 'menu_item.price') && hist.scheduled.length >= 2, [now.status, later.status, hist.history.length]);

  // 9.3 membership benefits, 9.4 overview
  const mp = (await call('GET', '/admin/membership-plans', undefined, A)).json;
  const upd = (await call('PATCH', `/admin/membership-plans/${mp[0].id}`, { benefits: { creditCentsPerMonth: 300 } }, A)).json;
  const ov = (await call('GET', '/admin/pricing/overview', undefined, A)).json;
  check('membership benefits editable; commission, royalty and fee schedules in one view', upd.benefits?.creditCentsPerMonth === 300 && ov.commission.length > 0 && ov.royalties.length > 0 && ov.customerFees.service, { c: ov.commission?.length, r: ov.royalties?.length });
}
