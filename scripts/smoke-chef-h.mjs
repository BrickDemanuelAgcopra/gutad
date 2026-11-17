// Chef Network Phase 8 checks (imported by smoke.mjs): reorder revalidation into the cart (unavailable, sold-out,
// special-request and changed-price lines) and changing a paid chef order before its cutoff (new charge, full refund
// of the original, the original's portions don't count against the change, guards and idempotency).

export async function chefPhaseH({ call, check, C }) {
  console.log('\n── Chef Network H: reorder and order changes');
  const K = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  const other = (await call('POST', '/auth/register', { email: `amend-${Date.now()}@smoke.gutad.io`, password: 'customer12345', name: 'Other Customer' })).json.accessToken;
  const dishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const by = (n) => dishes.find((d) => d.dishName === n);
  const lasagna = by('Beef lasagna'), spaghetti = by('Spaghetti'), pie = by('Pumpkin pie');
  const loc = lasagna.location.id;
  const iso = async (date, time) => (await call('GET', `/public/locations/${loc}/local-time?date=${date}&time=${time}`)).json.iso;
  const openDay = async (dish, qty = 1, nth = 0) => { const a = (await call('GET', `/public/chef-dishes/${dish.id}/availability?quantity=${qty}`)).json; const ds = a.days.filter((d) => d.status === 'AVAILABLE'); return ds[Math.min(nth, ds.length - 1)]; };
  const quote = (lines, at, token = C, extra = {}) => call('POST', '/quotes', { locationId: loc, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: at, tipCents: 0, holdKey: globalThis.crypto.randomUUID(), lines, ...extra }, token);
  const place = (quoteId, token = C, key = globalThis.crypto.randomUUID()) => call('POST', '/orders', { quoteId }, token, { 'Idempotency-Key': key });

  // ── a special-request order (also checks the line title's characters survive end to end)
  const d1 = await openDay(spaghetti, 1, 1);
  const r = (await call('POST', '/chef-requests', { dishId: spaghetti.id, requestType: 'ADD', ingredient: 'chili', details: 'Add chili flakes, please', servings: 1, requestedDate: d1.date, reason: 'PREFERENCE' }, C)).json;
  const v = (await call('POST', `/chef/requests/${r.id}/quote`, { kind: 'QUOTE', changes: 'Finish with Calabrian chili flakes', unitPriceCents: 1700, allergens: ['wheat', 'milk'], dietaryTags: ['vegetarian'], serviceDate: d1.date }, K)).json;
  const acc = (await call('POST', `/chef-requests/${r.id}/accept`, { quoteId: v.latestQuote.id }, C)).json;
  const at1 = await iso(d1.date, d1.slots[0]);
  const sq = (await quote([{ menuItemId: acc.cartLine.menuItemId, quantity: 1, modifierOptionIds: acc.cartLine.modifierOptionIds, chefRequestQuoteId: acc.cartLine.chefRequestQuoteId }, { menuItemId: lasagna.menuItemId, quantity: 1 }], at1)).json;
  check('a special-request line keeps its title intact (“· special request”)', sq.lines?.[0]?.name?.endsWith(' · special request') && !sq.lines[0].name.includes('�'), sq.lines?.[0]?.name);
  const so = (await place(sq.id)).json;

  // ── reorder into the cart
  const rc = (await call('POST', `/orders/${so.id}/reorder`, { mode: 'cart' }, C)).json;
  check('reorder rebuilds the cart: the special request is left out with a reason, the rest kept', rc.lines?.length === 1 && rc.lines[0].menuItemId === lasagna.menuItemId && rc.removed?.[0]?.code === 'SPECIAL_REQUEST' && rc.location?.chefKitchen === true && !!rc.earliestDate, { lines: rc.lines?.length, removed: rc.removed });
  await call('PATCH', `/chef/dishes/${lasagna.id}`, { priceCents: 2600 }, K);
  await call('POST', `/chef/dishes/${spaghetti.id}/sold-out`, { soldOut: true }, K);
  const sp = (await quote([{ menuItemId: spaghetti.menuItemId, quantity: 2 }, { menuItemId: lasagna.menuItemId, quantity: 1 }], at1)).json;
  // (the spaghetti is sold out now, so this quote fails; reorder the special-request order instead and compare)
  const rc2 = (await call('POST', `/orders/${so.id}/reorder`, { mode: 'cart' }, C)).json;
  check('reorder uses today’s price and says what changed', rc2.lines?.[0]?.unitPriceCents === 2600 && rc2.warnings?.some((w) => /now \$26\.00 \(was \$24\.00\)/.test(w)), rc2.warnings);
  const tmp = (await call('POST', `/orders/${so.id}/reorder`, { mode: 'cart' }, other));
  check('only the customer can reorder their order', tmp.status === 404, tmp.status);
  check('a sold-out dish can’t be quoted', sp.code === 'ITEM_UNAVAILABLE' || /sold out/i.test(sp.message || ''), sp.message);
  await call('POST', `/chef/dishes/${spaghetti.id}/sold-out`, { soldOut: false }, K);
  await call('PATCH', `/chef/dishes/${lasagna.id}`, { priceCents: 2400 }, K);

  // ── changing a paid order
  const no = (await call('GET', `/orders/${so.id}/amendment`, undefined, C)).json;
  check('an order with a special request can’t be changed (cancel and ask again)', no.allowed === false && no.code === 'HAS_SPECIAL_REQUEST', no);
  await call('POST', `/orders/${so.id}/cancel`, { reason: 'smoke cleanup' }, C);

  const pd = await openDay(pie, 8, 1); // pumpkin pie: 8 a day
  const atP = await iso(pd.date, pd.slots[0]);
  const q8 = (await quote([{ menuItemId: pie.menuItemId, quantity: 8 }], atP)).json;
  const o8 = (await place(q8.id)).json;
  check('the order shows it can still be changed', o8.amendable === true && o8.status === 'SUBMITTED', { amendable: o8.amendable, status: o8.status });
  const pre = (await call('GET', `/orders/${o8.id}/amendment`, undefined, C)).json;
  check('the change window is the order cutoff', pre.allowed === true && pre.until === o8.chefNetwork.freeCancelUntil, pre);
  const full = await quote([{ menuItemId: pie.menuItemId, quantity: 1 }], atP);
  check('the day is now sold out for everyone else', full.status === 400 && /sold out|DISH_CAPACITY|left/i.test(`${full.json.code} ${full.json.message}`), full.json);
  const availOwn = (await call('POST', `/public/chef-kitchens/${loc}/availability`, { lines: [{ menuItemId: pie.menuItemId, quantity: 8 }], from: pd.date, to: pd.date, replacesOrderId: o8.id }, C)).json;
  const availOther = (await call('POST', `/public/chef-kitchens/${loc}/availability`, { lines: [{ menuItemId: pie.menuItemId, quantity: 8 }], from: pd.date, to: pd.date, replacesOrderId: o8.id }, other)).json;
  check('while changing, the customer’s own portions don’t count (for them only)', availOwn.days?.[0]?.status === 'AVAILABLE' && availOther.days?.[0]?.status === 'SOLD_OUT', { own: availOwn.days?.[0]?.status, other: availOther.days?.[0]?.status });
  const steal = await quote([{ menuItemId: pie.menuItemId, quantity: 8 }], atP, other, { replacesOrderId: o8.id });
  check('another customer can’t price a change to the order', steal.status === 400 && steal.json.code === 'NOT_AMENDABLE', steal.json);
  const plain = (await quote([{ menuItemId: lasagna.menuItemId, quantity: 1 }], await iso(d1.date, d1.slots[0]))).json;
  const wrong = await call('POST', `/orders/${o8.id}/amend`, { quoteId: plain.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() });
  check('a change needs a quote priced for that order', wrong.status === 400 && wrong.json.code === 'QUOTE_NOT_FOR_ORDER', wrong.json);
  const at2 = await iso(pd.date, pd.slots[pd.slots.length > 1 ? 1 : 0]);
  const cq = await quote([{ menuItemId: pie.menuItemId, quantity: 7 }, { menuItemId: lasagna.menuItemId, quantity: 1 }], at2, C, { replacesOrderId: o8.id });
  check('the change is priced on the full day (the order’s own pies don’t count)', cq.status === 201 && cq.json.subtotalCents === 7 * 3200 + 2400, cq.json.message || cq.json.subtotalCents);
  const key = globalThis.crypto.randomUUID();
  const n = (await call('POST', `/orders/${o8.id}/amend`, { quoteId: cq.json.id }, C, { 'Idempotency-Key': key })).json;
  const old = (await call('GET', `/orders/${o8.id}`, undefined, C)).json;
  check('the changed order is charged in full as a new order', n.amendedFromOrderId === o8.id && n.prepaid && n.payment?.status === 'CAPTURED' && n.payment.capturedCents === cq.json.totalCents && n.status === 'SUBMITTED' && !!n.acceptBy, { status: n.status, pay: n.payment, from: n.amendedFromOrderId });
  check('…and the original is cancelled and refunded in full', old.status === 'CANCELED' && old.payment?.refundedCents === o8.totalCents && /replaced by/.test(old.cancelReason || ''), { status: old.status, pay: old.payment, reason: old.cancelReason });
  const again = (await call('POST', `/orders/${o8.id}/amend`, { quoteId: cq.json.id }, C, { 'Idempotency-Key': key })).json;
  check('retrying the same change returns the same order', again.id === n.id, again.id);
  const twice = (await call('GET', `/orders/${o8.id}/amendment`, undefined, C)).json;
  check('a replaced order can’t be changed again', twice.allowed === false, twice);
  const tl = (await call('GET', `/orders/${o8.id}/timeline`, undefined, C)).json;
  const tlEvents = Array.isArray(tl) ? tl : tl.events || [];
  check('the original order’s timeline records what replaced it', tlEvents.some((e) => e.type === 'AMENDED' && (e.data?.replacedBy === n.id || e.data?.number === n.number)), tlEvents.map((e) => e.type));
  const dec = (await call('POST', `/orders/${n.id}/reject`, { reason: 'Can’t do 7 pies that day' }, K)).json;
  check('if the chef declines the changed order, it is refunded in full', dec.status === 'REJECTED' && dec.payment?.refundedCents === n.totalCents, dec.payment);
}
