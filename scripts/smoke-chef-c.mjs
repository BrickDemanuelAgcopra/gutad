// Chef Network Phase 3 checks (imported by smoke.mjs): option builder configuration and validation, review and
// materialization into modifier groups, live pricing, defaults, quantities, conditional groups, per-context
// limits, allergen and dietary-label effects, locked components, option sold out, live-dish option changes
// waiting for review, the extras catalog (review, per-dish allowance, synonyms), and customized quotes.

export async function chefPhaseC({ call, check, A, C, chefToken: T, chefProfile }) {
  console.log('\n── Chef Network C: customization engine');
  const price = (id, optionIds) => call('POST', `/public/chef-dishes/${id}/price`, { optionIds });
  const dishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const sp = dishes.find((d) => d.dishName === 'Spaghetti');
  const lasagna = dishes.find((d) => d.dishName === 'Beef lasagna');
  const page = (await call('GET', `/public/chef-dishes/${sp.id}`)).json;
  const g = (name) => page.groups?.find((x) => x.name === name);
  const opt = (gn, on) => g(gn)?.options.find((o) => o.name === on);
  check('customizable dish exposes its option groups in order (portion, sauce, cheese, protein, conditional, toppings, included, extras)', page.groups?.length === 8 && g('Pasta portion')?.selectionType === 'SINGLE' && g('Sauce')?.selectionType === 'LEVEL' && g('Extra toppings')?.selectionType === 'QUANTITY' && g('Included')?.options[0].locked && g('Add extras')?.isExtras, page.groups?.map((x) => x.name));
  check('a fixed dish has no customer options', ((await call('GET', `/public/chef-dishes/${lasagna.id}`)).json.groups || []).length === 0, null);

  const p0 = (await price(sp.id, [])).json;
  check('defaults apply when nothing is chosen (Regular, Standard sauce and cheese) at the base price', p0.ok && p0.unitPriceCents === 1600 && p0.optionIds.length === 3, p0);
  const large = opt('Pasta portion', 'Large').id, mush = opt('Extra toppings', 'Mushrooms').id;
  const p1 = (await price(sp.id, [mush, mush, mush])).json;
  check('quantity limits per option (Regular: at most 2 mushroom portions)', !p1.ok && p1.errors.some((e) => /Mushrooms: at most 2/.test(e)), p1.errors);
  const p2 = (await price(sp.id, [large, mush, mush, mush])).json;
  check('a size choice changes permitted quantities and the price updates immediately (Large + 3 mushrooms)', p2.ok && p2.unitPriceCents === 1600 + 500 + 450, p2);
  const shrimp = opt('Add a protein', 'Shrimp').id, garlic = opt('Shrimp style', 'Garlic butter').id;
  const orphan = (await price(sp.id, [garlic])).json;
  check('a conditional group only applies after its parent choice', !orphan.ok && orphan.errors.some((e) => /only available with Shrimp/.test(e)), orphan.errors);
  const p3 = (await price(sp.id, [shrimp])).json;
  check('choosing shrimp reveals the shrimp-style group with its default, adds shellfish and milk, removes “vegetarian”', p3.ok && p3.activeGroupIds.includes(g('Shrimp style').id) && p3.allergens.includes('shellfish') && p3.allergens.includes('milk') && !p3.dietaryTags.includes('vegetarian') && p3.removedDietaryTags.includes('vegetarian'), { a: p3.allergens, t: p3.dietaryTags });
  const two = (await price(sp.id, [large, opt('Pasta portion', 'Regular').id])).json;
  check('single-choice groups accept one option', !two.ok, two.errors);
  const locked = (await price(sp.id, [g('Included').options[0].id])).json;
  check('locked components cannot be removed or charged', locked.ok && locked.unitPriceCents === 1600, locked);
  const burrata = g('Add extras').options.find((o) => o.name === 'Burrata');
  check('approved extras are offered with search synonyms (burrata ← “mozzarella”)', burrata && burrata.searchTerms.includes('mozzarella') && burrata.addsAllergens.includes('milk'), burrata);

  const q = (await call('POST', '/quotes', { locationId: sp.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: await slotIso(call, sp.location.id), lines: [{ menuItemId: sp.menuItemId, quantity: 2, modifierOptionIds: [large, mush, mush, mush, shrimp, burrata.id] }] }, C)).json;
  const line = q.lines?.[0];
  check('quote validates and prices the configured dish (per unit × quantity)', q.id && line?.modifiersCents === 500 + 450 + 500 + 600 && line.lineTotalCents === 2 * (1600 + 2050), line || q);
  const bad = await call('POST', '/quotes', { locationId: sp.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: await slotIso(call, sp.location.id), lines: [{ menuItemId: sp.menuItemId, quantity: 1, modifierOptionIds: [garlic] }] }, C);
  check('the quote refuses an unpublished combination', bad.status === 400 && bad.json.code === 'CUSTOMIZATION_INVALID', bad.json);
  if (q.id) {
    const order = (await call('POST', '/orders', { quoteId: q.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
    const ol = (order.lines || [])[0];
    check('the order keeps the exact configuration and its effective allergens (purchase snapshot)', ol && (ol.modifiers || []).some((m) => m.name === 'Mushrooms ×3') && (ol.allergens || []).includes('shellfish'), ol);
  }

  // chef builder: a new customizable dish through review
  const nd = (await call('POST', '/chef/dishes', { dishName: 'Suya rice bowl', priceCents: 1800, mode: 'CUSTOMIZABLE' }, T)).json;
  const fd = new FormData();
  fd.append('file', new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' }), 'x.png');
  const API = process.env.API_URL || 'http://localhost:4000';
  const ph = await (await fetch(`${API}/chef/photos`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd })).json();
  const base = { photos: [ph.id], portionDesc: '1 bowl', ingredients: ['rice', 'beef suya', 'onion'], allergens: ['peanuts'], allergensConfirmed: true, fulfillmentFormat: 'HOT' };
  await call('PATCH', `/chef/dishes/${nd.id}`, base, T);
  const empty = await call('POST', `/chef/dishes/${nd.id}/submit`, undefined, T);
  check('a customizable dish needs at least one customer option', empty.status === 400 && empty.json.missing.some((m) => /customer option/.test(m)), empty.json.missing);
  const cfg = [
    { name: 'Protein', selectionType: 'SINGLE', required: true, minSelect: 1, maxSelect: 1, options: [{ id: 'tmp-beef', name: 'Beef suya', priceCents: 0, isDefault: true }, { id: 'tmp-chk', name: 'Chicken suya', priceCents: 0 }] },
    { name: 'Heat', selectionType: 'LEVEL', required: true, minSelect: 1, maxSelect: 1, parentOptionId: 'tmp-chk', options: [{ name: 'Mild', priceCents: 0, isDefault: true }, { name: 'Hot', priceCents: 0 }] },
  ];
  const saved = (await call('PATCH', `/chef/dishes/${nd.id}`, { optionsConfig: cfg }, T)).json;
  const ids = saved.optionsConfig.map((x) => x.id);
  check('the builder assigns stable ids and keeps “only when” links to the chosen option', ids.every((x) => /^[0-9a-f-]{36}$/.test(x)) && saved.optionsConfig[1].parentOptionId === saved.optionsConfig[0].options[1].id && saved.missing.length === 0, saved.optionsConfig?.[1]);
  const badCfg = (await call('PATCH', `/chef/dishes/${nd.id}`, { optionsConfig: [{ name: 'Size', selectionType: 'SINGLE', required: true, minSelect: 2, maxSelect: 1, options: [] }] }, T)).json;
  check('invalid option setups are reported in the builder', badCfg.missing.some((m) => /add at least one option/.test(m)) && badCfg.missing.some((m) => /minimum is above maximum/.test(m)), badCfg.missing);
  await call('PATCH', `/chef/dishes/${nd.id}`, { optionsConfig: saved.optionsConfig }, T);
  await call('POST', `/chef/dishes/${nd.id}/submit`, undefined, T);
  await call('POST', `/admin/chef-dishes/${nd.id}/review`, { decision: 'APPROVE' }, A);
  let pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('approval turns the configuration into live customer options with the same ids', pub.groups?.length === 2 && pub.groups[0].options[0].id === saved.optionsConfig[0].options[0].id && pub.groups[1].parentOptionId === saved.optionsConfig[0].options[1].id, pub.groups);

  // live option change waits for review
  const add = saved.optionsConfig.map((x, i) => (i === 0 ? { ...x, options: [...x.options, { name: 'Shrimp suya', priceCents: 400, addsAllergens: ['shellfish'] }] } : x));
  const ch = (await call('PATCH', `/chef/dishes/${nd.id}`, { optionsConfig: add }, T)).json;
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('option changes on a live dish wait for Gutad review (customers keep the approved options)', ch.needsReview === true && pub.groups[0].options.length === 2, { needs: ch.needsReview, n: pub.groups[0].options.length });
  const invalidLive = await call('PATCH', `/chef/dishes/${nd.id}`, { optionsConfig: [{ name: '', selectionType: 'MULTI', required: false, minSelect: 0, maxSelect: 1, options: [] }] }, T);
  check('an invalid option setup is refused on a live dish', invalidLive.status === 400 && invalidLive.json.code === 'OPTIONS_INVALID', invalidLive.json);
  await call('POST', `/admin/chef-dishes/${nd.id}/review`, { decision: 'APPROVE' }, A);
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('approved option changes go live; unchanged options keep their ids', pub.groups[0].options.length === 3 && pub.groups[0].options[0].id === saved.optionsConfig[0].options[0].id, pub.groups[0].options.map((o) => o.name));

  const chk = pub.groups[0].options.find((o) => o.name === 'Chicken suya');
  await call('POST', `/chef/dishes/${nd.id}/options/${chk.id}/sold-out`, { soldOut: true }, T);
  const so = (await price(nd.id, [chk.id])).json;
  check('chef marks an option sold out instantly (no review)', !so.ok && so.errors.some((e) => /sold out/.test(e)), so.errors);
  const foreign = await call('POST', `/chef/dishes/${sp.id}/options/${mush}/sold-out`, { soldOut: true }, T);
  check('a chef cannot change another chef’s options', foreign.status === 403, foreign.status);

  // extras catalog
  const ex = (await call('POST', '/chef/extras', { name: 'Fried plantain', synonyms: ['dodo'], priceCents: 300, maxQty: 2, allergens: [], dishIds: [nd.id] }, T)).json;
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('a new extra waits for Gutad review before customers see it', ex.status === 'PENDING' && !pub.groups.some((x) => x.isExtras), ex.status);
  const eq = (await call('GET', '/admin/chef-extras/review', undefined, A)).json;
  check('extras appear in the Gutad review queue', eq.some((e) => e.id === ex.id && e.chefName === chefProfile.displayName), eq.length);
  await call('POST', `/admin/chef-extras/${ex.id}/review`, { approve: true }, A);
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  const xo = pub.groups.find((x) => x.isExtras)?.options.find((o) => o.name === 'Fried plantain');
  check('approved extras appear on the dishes the chef allowed, searchable by synonym', xo && xo.searchTerms.includes('dodo') && xo.maxQty === 2, xo);
  await call('PATCH', `/chef/extras/${ex.id}`, { priceCents: 350 }, T);
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('extra price changes apply immediately', pub.groups.find((x) => x.isExtras)?.options[0].priceCents === 350, null);
  const ex2 = (await call('PATCH', `/chef/extras/${ex.id}`, { allergens: ['sesame'] }, T)).json;
  pub = (await call('GET', `/public/chef-dishes/${nd.id}`)).json;
  check('changing an extra’s allergens sends it back to review and removes it from sale', ex2.status === 'PENDING' && !pub.groups.some((x) => x.isExtras), ex2.status);
  const custEx = await call('GET', '/admin/chef-extras/review', undefined, C);
  check('extras review is staff-only', custEx.status === 403, custEx.status);
}

async function slotIso(call, locId) {
  const page = (await call('GET', `/public/locations/${locId}`)).json;
  const day = (page.pickupTimes || []).find((d) => d.slots.length);
  return (await call('GET', `/public/locations/${locId}/local-time?date=${day.date}&time=${day.slots[Math.floor(day.slots.length / 2)]}`)).json.iso;
}
