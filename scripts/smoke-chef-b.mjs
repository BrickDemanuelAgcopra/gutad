// Chef Network Phase 2 checks (imported by smoke.mjs): starter dishes become drafts, the dish builder and its
// completeness gate, Gutad dish review, branded titles on the storefront and on order lines, live-dish material
// changes waiting for review while price changes apply at once, menu sections and ordering, sold out,
// suspension, archive, access control, and a scheduled order of a fixed dish.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export async function chefPhaseB({ call, check, A, C, O, API, chefToken: T, chefProfile }) {
  console.log('\n── Chef Network B: dishes, review & storefront');
  const name = chefProfile.displayName;
  await call('POST', '/chef/me/availability', { accepting: true }, T); // phase A left the chef reinstated but paused
  const menu = (await call('GET', '/chef/menu', undefined, T)).json;
  const all = menu.sections?.flatMap((s) => s.dishes) || [];
  check('starter dishes from the application arrive as drafts in the builder', all.length === 2 && all.every((d) => d.reviewStatus === 'DRAFT' && d.live === false), all.map((d) => [d.dishName, d.reviewStatus]));
  const jollof = all.find((d) => d.dishName === 'Jollof rice');
  check('branded title is generated from separate fields', jollof?.title === `Gutad’s Jollof rice — by ${name}`, jollof?.title);
  const early = await call('POST', `/chef/dishes/${jollof.id}/submit`, undefined, T);
  check('an incomplete dish cannot be submitted (photo, ingredients…)', early.status === 400 && early.json.code === 'DISH_INCOMPLETE' && early.json.missing.some((m) => /photo/i.test(m)), early.json);

  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'jollof.png');
  const ph = await (await fetch(`${API}/chef/photos`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: fd })).json();
  const foreign = await call('PATCH', `/chef/dishes/${jollof.id}`, { photos: [globalThis.crypto.randomUUID()] }, T);
  check('dish photos must be the chef’s own uploads', foreign.status === 400, foreign.json);
  const ed = (await call('PATCH', `/chef/dishes/${jollof.id}`, { photos: [ph.id], ingredients: ['rice', 'tomato', 'scotch bonnet', 'onion', 'thyme'], fulfillmentFormat: 'HOT', allergensConfirmed: true, prepMinutes: 40, dietaryTags: ['vegan'], description: 'Smoky party jollof.' }, T)).json;
  check('builder saves a complete draft (photo stored as a public URL)', ed.missing?.length === 0 && ed.photos[0].includes('/public/chef-photos/') && ed.reviewStatus === 'DRAFT', ed.missing);
  const fixedSr = (await call('PATCH', `/chef/dishes/${jollof.id}`, { mode: 'FIXED', acceptsSpecialRequests: true }, T)).json;
  check('a fixed dish cannot take special requests (switch lives under customizable)', fixedSr.acceptsSpecialRequests === false, fixedSr.acceptsSpecialRequests);
  const sub = (await call('POST', `/chef/dishes/${jollof.id}/submit`, undefined, T)).json;
  check('chef submits the dish for Gutad review', sub.reviewStatus === 'IN_REVIEW', sub.reviewStatus);
  const editInReview = await call('PATCH', `/chef/dishes/${jollof.id}`, { priceCents: 1500 }, T);
  check('a dish under review is locked', editInReview.status === 409 && editInReview.json.code === 'DISH_IN_REVIEW', editInReview.json);
  let store = (await call('GET', `/public/chefs/${chefProfile.slug}/dishes`)).json;
  check('unreviewed dishes are not on the storefront', Array.isArray(store) && !store.some((d) => d.id === jollof.id), store.length);

  const custQ = await call('GET', '/admin/chef-dishes/review', undefined, C);
  check('dish review is staff-only', custQ.status === 403, custQ.status);
  const q = (await call('GET', '/admin/chef-dishes/review', undefined, A)).json;
  check('the dish waits in the review queue as a new listing', q.some((d) => d.id === jollof.id && d.kind === 'NEW_LISTING' && d.chefName === name), q.length);
  const noNote = await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'CHANGES' }, A);
  check('sending a dish back needs a note', noNote.status === 400, noNote.status);
  const back = (await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'CHANGES', note: 'Add the portion weight in grams.' }, A)).json;
  check('reviewer requests changes', back.reviewStatus === 'CHANGES_REQUESTED' && back.reviewNote, back.reviewStatus);
  await call('PATCH', `/chef/dishes/${jollof.id}`, { portionDesc: '1 tray (600 g)' }, T);
  await call('POST', `/chef/dishes/${jollof.id}/submit`, undefined, T);
  const pub = (await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'APPROVE' }, A)).json;
  check('approval publishes the dish', pub.reviewStatus === 'PUBLISHED' && pub.live === true && pub.publishedAt, pub.reviewStatus);
  store = (await call('GET', `/public/chefs/${chefProfile.slug}/dishes`)).json;
  const card = store.find((d) => d.id === jollof.id);
  check('storefront shows “Gutad’s <dish> — by <chef>” with format, portion and allergens', card?.title === `Gutad’s Jollof rice — by ${name}` && card.fulfillmentFormat === 'HOT' && card.portionDesc === '1 tray (600 g)' && Array.isArray(card.allergens) && card.location?.id, card);
  const detail = (await call('GET', `/public/chef-dishes/${jollof.id}`)).json;
  check('public dish page data includes chef attribution', detail.chef?.slug === chefProfile.slug && detail.acceptingOrders === true && detail.mode === 'FIXED', detail.chef);

  const price = (await call('PATCH', `/chef/dishes/${jollof.id}`, { priceCents: 1550 }, T)).json;
  store = (await call('GET', `/public/chefs/${chefProfile.slug}/dishes`)).json;
  check('price changes on a live dish apply immediately', price.needsReview === false && store.find((d) => d.id === jollof.id).priceCents === 1550, price.needsReview);
  const mat = (await call('PATCH', `/chef/dishes/${jollof.id}`, { ingredients: ['rice', 'tomato', 'scotch bonnet', 'onion', 'thyme', 'shrimp'], allergens: ['shellfish'], dietaryTags: [] }, T)).json;
  store = (await call('GET', `/public/chefs/${chefProfile.slug}/dishes`)).json;
  const stillOld = store.find((d) => d.id === jollof.id);
  check('ingredient/allergen changes on a live dish wait for review (customers still see the approved version)', mat.needsReview === true && mat.pendingChanges?.ingredients?.includes('shrimp') && !stillOld.ingredients.includes('shrimp') && stillOld.dietaryTags.includes('vegan'), { pending: mat.pendingChanges, live: stillOld.ingredients });
  const q2 = (await call('GET', '/admin/chef-dishes/review', undefined, A)).json;
  check('the change appears in the review queue', q2.some((d) => d.id === jollof.id && d.kind === 'CHANGE'), q2.map((d) => d.kind));
  await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'APPROVE' }, A);
  const after = (await call('GET', `/public/chef-dishes/${jollof.id}`)).json;
  check('approved change updates ingredients, allergens and dietary labels (no longer vegan)', after.ingredients.includes('shrimp') && after.allergens.includes('shellfish') && !after.dietaryTags.includes('vegan'), { a: after.allergens, t: after.dietaryTags });

  // sections & order
  const soups = (await call('POST', '/chef/menu/sections', { name: 'Soups' }, T)).json;
  const m1 = (await call('GET', '/chef/menu', undefined, T)).json;
  const soup = m1.sections.flatMap((s) => s.dishes).find((d) => d.dishName === 'Groundnut soup');
  const first = m1.sections[0];
  const reordered = (await call('PUT', '/chef/menu/order', { sections: [{ id: soups.id, dishIds: [soup.id] }, { id: first.id, dishIds: first.dishes.filter((d) => d.id !== soup.id).map((d) => d.id) }] }, T)).json;
  check('menu sections and dishes reorder (drag-and-drop or move buttons send the full order)', reordered.sections[0].id === soups.id && reordered.sections[0].dishes[0]?.id === soup.id, reordered.sections.map((s) => s.name));
  const otherDish = (await call('GET', '/public/chefs/chef-carlos/dishes')).json[0];
  const steal = await call('PUT', '/chef/menu/order', { sections: [{ id: soups.id, dishIds: [otherDish.id] }] }, T);
  check('a chef cannot reorder another chef’s dishes', steal.status === 400, steal.status);
  const notEmpty = await call('DELETE', `/chef/menu/sections/${soups.id}`, undefined, T);
  check('a section with dishes cannot be deleted', notEmpty.status === 409, notEmpty.status);
  const otherChef = await call('PATCH', `/chef/dishes/${otherDish.id}`, { priceCents: 1 }, T);
  check('a chef cannot edit another chef’s dish', otherChef.status === 403, otherChef.status);

  // fixed dish order, scheduled at the chef kitchen
  const carlosDishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const pie = carlosDishes.find((d) => d.dishName === 'Pumpkin pie');
  check('demo Chef Carlos has live dishes including a Thanksgiving pie', pie && pie.title === 'Gutad’s Pumpkin pie — by Chef Carlos' && pie.fulfillmentFormat === 'ROOM_TEMP', carlosDishes.map((d) => d.title));
  const page = (await call('GET', `/public/locations/${pie.location.id}`)).json;
  const day = (page.pickupTimes || []).find((d, i) => i >= 2 && d.slots.length);
  if (day) {
    const iso = (await call('GET', `/public/locations/${pie.location.id}/local-time?date=${day.date}&time=${day.slots[Math.floor(day.slots.length / 2)]}`)).json.iso;
    const quote = (await call('POST', '/quotes', { locationId: pie.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: iso, lines: [{ menuItemId: pie.menuItemId, quantity: 1 }] }, C)).json;
    check('a fixed chef dish quotes for a scheduled pickup with the branded line title', quote.id && quote.lines?.[0]?.name === 'Gutad’s Pumpkin pie — by Chef Carlos' && quote.subtotalCents === pie.priceCents, quote.lines || quote);
    const order = (await call('POST', '/orders', { quoteId: quote.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
    check('the chef order is placed with the branded title on its lines', order.id && (order.lines || []).some((l) => l.name === 'Gutad’s Pumpkin pie — by Chef Carlos'), order.lines || order);
    const asap = await call('POST', '/quotes', { locationId: pie.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: pie.menuItemId, quantity: 1 }] }, C);
    check('a chef dish cannot be ordered for right now when the chef needs notice', asap.status === 400, asap.json);
  } else check('Chef Carlos has scheduled pickup times', false, page.pickupTimes);

  // sold out, suspend, archive
  await call('POST', `/chef/dishes/${jollof.id}/sold-out`, { soldOut: true }, T);
  check('sold-out shows on the storefront', (await call('GET', `/public/chef-dishes/${jollof.id}`)).json.soldOut === true, null);
  await call('POST', `/chef/dishes/${jollof.id}/sold-out`, { soldOut: false }, T);
  await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'SUSPEND', note: 'Allergen complaint under investigation' }, A);
  const gone = await call('GET', `/public/chef-dishes/${jollof.id}`);
  check('a suspended dish is removed from sale', gone.status === 404, gone.status);
  const re = (await call('POST', `/admin/chef-dishes/${jollof.id}/review`, { decision: 'REINSTATE', note: 'Investigation closed' }, A)).json;
  check('a suspended dish can be reinstated', re.reviewStatus === 'PUBLISHED' && re.live, re.reviewStatus);
  const nd = (await call('POST', '/chef/dishes', { dishName: 'Test stew', priceCents: 1200 }, T)).json;
  const arch = await call('POST', `/chef/dishes/${nd.id}/archive`, undefined, T);
  const m2 = (await call('GET', '/chef/menu', undefined, T)).json;
  check('chef creates and archives a dish', nd.reviewStatus === 'DRAFT' && arch.status === 201 && !m2.sections.flatMap((s) => s.dishes).some((d) => d.id === nd.id), arch.status);
  const ownerMenu = await call('GET', '/chef/menu', undefined, O);
  check('non-chefs have no chef menu', ownerMenu.status === 404, ownerMenu.status);
}
