// Chef Network follow-ups (imported by smoke.mjs): CN.1 adding dishes while changing a paid order, CN.2 Gutad staff
// suggesting another chef's dish on a special request, CN.3 free text → option selections (keyword provider), and
// CN.4 optional automatic pause when a chef stays over the quality limits.

export async function chefPhaseI({ call, check, A, C }) {
  console.log('\n── Chef Network I: follow-ups (add dishes, staff alternatives, describe it, auto-pause)');
  const DAY = 86_400_000;
  const K = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  const dishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const by = (n) => dishes.find((d) => d.dishName === n);
  const lasagna = by('Beef lasagna'), spaghetti = by('Spaghetti'), pie = by('Pumpkin pie');
  const loc = lasagna.location.id;
  const iso = async (date, time) => (await call('GET', `/public/locations/${loc}/local-time?date=${date}&time=${time}`)).json.iso;
  const openDay = async (dish, qty = 1, nth = 0) => { const a = (await call('GET', `/public/chef-dishes/${dish.id}/availability?quantity=${qty}`)).json; const ds = a.days.filter((d) => d.status === 'AVAILABLE'); return ds[Math.min(nth, ds.length - 1)]; };
  const quote = (lines, at, extra = {}) => call('POST', '/quotes', { locationId: loc, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: at, tipCents: 0, holdKey: globalThis.crypto.randomUUID(), lines, ...extra }, C);
  const sp = (await call('GET', `/public/chef-dishes/${spaghetti.id}`)).json;
  const opt = (gn, on) => sp.groups.find((g) => g.name === gn)?.options.find((o) => o.name === on);

  // ── CN.3 describe it (AI_PROVIDER=rules in smoke: keyword matching)
  const anon = await call('POST', `/chef-dishes/${spaghetti.id}/interpret`, { text: 'large please' });
  check('describing a dish needs a signed-in customer', anon.status === 401, anon.status);
  const it = (await call('POST', `/chef-dishes/${spaghetti.id}/interpret`, { text: 'Large, extra sauce, no cheese, add shrimp, double mushrooms and no onions please' }, C)).json;
  const has = (o, n = 1) => !!o && it.optionIds?.filter((x) => x === o.id).length === n;
  check('free text fills in the matching options (size, levels, protein, portions)', has(opt('Pasta portion', 'Large')) && has(opt('Sauce', 'Extra')) && has(opt('Cheese', 'None')) && has(opt('Add a protein', 'Shrimp')) && has(opt('Extra toppings', 'Mushrooms'), 2), { ids: it.optionIds?.length, chosen: it.chosen?.map((c) => `${c.name}×${c.qty}`) });
  check('…a generic word only counts with its group (“extra sauce” isn’t extra cheese)', !it.optionIds?.includes(opt('Cheese', 'Extra').id) && !it.optionIds?.includes(opt('Sauce', 'None')?.id), it.chosen);
  check('…what no option covers is listed for a special request', it.unmatched?.some((u) => /onion/.test(u)) && it.acceptsSpecialRequests === true && it.source === 'rules', it.unmatched);
  const priced = (await call('POST', `/public/chef-dishes/${spaghetti.id}/price`, { optionIds: it.optionIds })).json;
  check('…and the selection prices like the customizer', it.ok === true && priced.unitPriceCents === it.unitPriceCents, { it: it.unitPriceCents, priced: priced.unitPriceCents, errors: it.errors });
  const none = (await call('POST', `/chef-dishes/${spaghetti.id}/interpret`, { text: 'make it taste like grandma used to' }, C)).json;
  check('a request no option matches fills nothing in', none.optionIds?.length === 0 && typeof none.note === 'string', none);

  // ── CN.1 add a dish while changing a paid order
  const pd = await openDay(pie, 2, 2);
  const at = await iso(pd.date, pd.slots[0]);
  const o = (await call('POST', '/orders', { quoteId: (await quote([{ menuItemId: pie.menuItemId, quantity: 2 }], at)).json.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  check('a chef order tells the app which chef’s menu to add from', o.chefNetwork?.chefSlug === 'chef-carlos', o.chefNetwork);
  const am = (await call('GET', `/orders/${o.id}/amendment`, undefined, C)).json;
  check('the change screen says dishes can be added', am.allowed && /add dishes/i.test(am.reason), am.reason);
  const addIds = [opt('Pasta portion', 'Large').id, opt('Extra toppings', 'Mushrooms').id];
  const cq = await quote([{ menuItemId: pie.menuItemId, quantity: 2 }, { menuItemId: spaghetti.menuItemId, quantity: 1, modifierOptionIds: addIds }], at, { replacesOrderId: o.id });
  const spLine = cq.json.lines?.find((l) => l.menuItemId === spaghetti.menuItemId);
  check('a dish added while changing is priced with its options', cq.status === 201 && spLine?.modifiersCents === 500 + 150, cq.json.message || spLine);
  const n = (await call('POST', `/orders/${o.id}/amend`, { quoteId: cq.json.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  check('…and the changed order keeps the added dish and its options', n.amendedFromOrderId === o.id && n.lines?.some((l) => l.menuItemId === spaghetti.menuItemId && l.modifiers?.length >= 2), { from: n.amendedFromOrderId, lines: n.lines?.map((l) => l.name) });

  // ── CN.2 staff suggest another chef's dish
  const amaraDishes = (await call('GET', '/public/chefs/chef-amara/dishes')).json;
  const jollof = amaraDishes.find((d) => d.dishName === 'Party jollof rice');
  const rd = await openDay(spaghetti, 1, 1);
  const req = (await call('POST', '/chef-requests', { dishId: spaghetti.id, requestType: 'REMOVE', ingredient: 'wheat', details: 'Can it be made without wheat pasta? Something else hearty is fine.', servings: 1, requestedDate: rd.date, reason: 'DIETARY', alternativesOk: true }, C)).json;
  const custAlt = await call('GET', `/admin/chef-requests/${req.id}/alternatives`, undefined, C);
  check('only Gutad staff see other chefs’ dishes for a request', custAlt.status === 403, custAlt.status);
  const alts = (await call('GET', `/admin/chef-requests/${req.id}/alternatives`, undefined, A)).json;
  const ja = alts.dishes?.find((x) => x.id === jollof?.id);
  check('staff see live dishes from other chefs, with the requested day’s status', !!ja && !alts.dishes.some((x) => x.chef.slug === 'chef-carlos') && !!ja.requestedDay && Array.isArray(ja.mentionedAllergens), { n: alts.dishes?.length, ja });
  const jd = (await openDay(jollof, 1, 0));
  const body = { kind: 'ALTERNATIVE', altDishId: jollof.id, changes: 'Chef Amara’s party jollof rice instead of the spaghetti.', unitPriceCents: jollof.priceCents - 100, quantity: 1, allergens: jollof.allergens, dietaryTags: jollof.dietaryTags, serviceDate: jd.date };
  const cheap = await call('POST', `/admin/chef-requests/${req.id}/quote`, body, A);
  check('staff can’t set another chef’s price', cheap.status === 400 && cheap.json.code === 'ALTERNATIVE_PRICE', cheap.json);
  const chefTry = await call('POST', `/chef/requests/${req.id}/quote`, { ...body, unitPriceCents: jollof.priceCents }, K);
  check('the requested chef can’t offer another chef’s dish', chefTry.status === 403, chefTry.status);
  const sent = (await call('POST', `/admin/chef-requests/${req.id}/quote`, { ...body, unitPriceCents: jollof.priceCents }, A)).json;
  check('staff send the other chef’s dish as an alternative at its listed price', sent.status === 'QUOTED' && sent.latestQuote?.kind === 'ALTERNATIVE' && sent.latestQuote?.dish?.id === jollof.id, { status: sent.status, q: sent.latestQuote?.kind, dish: sent.latestQuote?.dish?.id });
  const acc = (await call('POST', `/chef-requests/${req.id}/accept`, { quoteId: sent.latestQuote.id }, C)).json;
  check('the customer pays for it from the other chef’s kitchen', acc.cartLine?.location?.id === jollof.location.id && acc.cartLine.unitPriceCents === jollof.priceCents, acc.cartLine?.location);

  // ── CN.4 optional automatic pause
  await call('POST', '/admin/settings', { key: 'chefs.quality', value: { minOrders: 1, maxDeclineRatePct: 1, autoActionAfterWeeks: 2, autoAction: 'PAUSE_CHEF' }, reason: 'Smoke auto-pause' }, A);
  const sweep = (days) => call('POST', '/admin/jobs/chef-operations', { at: new Date(Date.now() + days * DAY).toISOString() }, A);
  const s0 = (await sweep(0)).json;
  const st0 = (await call('GET', `/admin/chefs/${lasagna.chef.id}/quality`, undefined, A)).json;
  check('one week over the limit only flags the chef', (s0.quality?.autoActions ?? 0) === 0 && st0.metrics?.status === 'ACTIVE', { s0: s0.quality, status: st0.metrics?.status });
  const s8 = (await sweep(8)).json;
  const st8 = (await call('GET', `/admin/chefs/${lasagna.chef.id}/quality`, undefined, A)).json;
  const ev = st8.events?.find((e) => e.kind === 'CHEF_PAUSED' && e.source === 'AUTO');
  check('flagged two weeks in a row: paused automatically (cause QUALITY, recorded)', s8.quality?.autoActions >= 1 && st8.metrics?.status === 'PAUSED' && st8.metrics?.statusCause === 'QUALITY' && !!ev, { s8: s8.quality, status: st8.metrics?.status, cause: st8.metrics?.statusCause });
  const pub = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  check('…and the chef’s dishes leave the storefront', Array.isArray(pub) && pub.length === 0, pub.length);
  const s9 = (await sweep(9)).json;
  check('…once (no repeat while paused)', (s9.quality?.autoActions ?? 0) === 0, s9.quality);
  await call('POST', `/admin/chefs/${lasagna.chef.id}/quality`, { action: 'CHEF_REINSTATED', note: 'Reviewed with the chef after the automatic pause' }, A);
  const s16 = (await sweep(16)).json;
  check('after reinstatement the count starts over', (s16.quality?.autoActions ?? 0) === 0, s16.quality);
  await call('POST', '/admin/settings', { key: 'chefs.quality', value: {}, reason: 'Smoke reset' }, A);
  // other chefs the time-travel sweeps paused automatically go back to normal too
  const q = (await call('GET', '/admin/chef-quality', undefined, A)).json;
  for (const c of q.chefs || []) if (c.chefId !== lasagna.chef.id && c.status !== 'ACTIVE' && c.statusCause === 'QUALITY') await call('POST', `/admin/chefs/${c.chefId}/quality`, { action: 'CHEF_REINSTATED', note: 'Smoke cleanup after automatic pause' }, A);
  await call('POST', '/chef/me/availability', { accepting: true }, K);
}
