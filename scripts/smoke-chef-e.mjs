// Chef Network Phase 5 checks (imported by smoke.mjs): chef orders are charged in full at checkout (no
// authorization), the Chef Network fee scope and commission, the chef's acceptance with automatic refunds on a
// decline, cancellation by cutoff (full refund before, the chef's late-refund percentage after), money held until
// completion and then credited to the chef, and one checkout across two chefs (two orders, one charge, refunds per
// order).

export async function chefPhaseE({ call, check, A, C }) {
  console.log('\n── Chef Network E: checkout, payments and multi-chef');
  const K = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  const M = (await call('POST', '/auth/login', { email: 'amara@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  check('second demo chef (Bestie Amara) signs in', !!M, null);
  const carlosOrg = (await call('GET', '/chef/me', undefined, K)).json.organization.id;
  const balance = async () => (await call('GET', `/organizations/${carlosOrg}/balance`, undefined, K)).json.payableCents;
  const carlos = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const amara = (await call('GET', '/public/chefs/chef-amara/dishes')).json;
  const lasagna = carlos.find((d) => d.dishName === 'Beef lasagna');
  const jollof = amara.find((d) => d.dishName === 'Party jollof rice');
  check('both chefs have live dishes', !!lasagna && !!jollof, { carlos: carlos.length, amara: amara.length });
  const slot = async (dish, nth = 0) => {
    const av = (await call('GET', `/public/chef-dishes/${dish.id}/availability`)).json;
    const days = av.days.filter((d) => d.status === 'AVAILABLE');
    const d = days[Math.min(nth, days.length - 1)];
    return { date: d.date, iso: (await call('GET', `/public/locations/${dish.location.id}/local-time?date=${d.date}&time=${d.slots[0]}`)).json.iso, orderBy: d.orderBy };
  };
  const quote = (dish, at, qty = 1, token = C, holdKey) => call('POST', '/quotes', { locationId: dish.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: at, tipCents: 0, lines: [{ menuItemId: dish.menuItemId, quantity: qty }], ...(holdKey ? { holdKey } : {}) }, token);
  const place = (quoteId, token = C) => call('POST', '/orders', { quoteId }, token, { 'Idempotency-Key': globalThis.crypto.randomUUID() });

  // fee scope and terms
  const s1 = await slot(lasagna, 2);
  const q1 = (await quote(lasagna, s1.iso, 1)).json;
  check('chef orders use the Chef Network service fee (8%, at least $1.99) on pickup too', q1.serviceFeeCents === Math.max(199, Math.round(2400 * 0.08)), q1);
  check('the quote states the terms: charged now, full refund until the date’s cutoff', q1.chefTerms?.chargedNow === true && q1.chefTerms.freeCancelUntil === s1.orderBy && q1.chefTerms.lateRefundPct === 0, q1.chefTerms);

  // single chef: charged now, then the chef declines → full automatic refund
  const bal0 = await balance();
  const o1 = (await place(q1.id)).json;
  check('a chef order is charged in full at checkout (no authorization hold)', o1.prepaid === true && o1.payment?.status === 'CAPTURED' && o1.payment.capturedCents === o1.totalCents, o1.payment);
  check('the order carries the chef, the acceptance deadline and the cancellation terms', o1.chefNetwork?.chefName === 'Bestie Carlos' && !!o1.acceptBy && new Date(o1.acceptBy) < new Date(s1.iso) && o1.chefNetwork.freeCancelUntil === s1.orderBy, o1.chefNetwork);
  check('commission is the Chef Network rate (15% of food)', o1.commissionBps === 1500 && o1.commissionCents === Math.round(2400 * 0.15), { bps: o1.commissionBps, c: o1.commissionCents });
  check('the chef isn’t credited at checkout (money is held until completion)', (await balance()) === bal0, { bal0 });
  const dec = (await call('POST', `/orders/${o1.id}/reject`, { reason: 'Out of beef this week' }, K)).json;
  check('a chef decline refunds the full charge automatically', dec.status === 'REJECTED' && dec.payment?.refundedCents === o1.totalCents && dec.payment.status === 'REFUNDED', dec.payment);
  check('a declined order leaves the chef’s balance untouched', (await balance()) === bal0, null);

  // accept → complete → the chef is credited food + tax − commission
  const q2 = (await quote(lasagna, s1.iso, 2)).json;
  const o2 = (await place(q2.id)).json;
  const acc = (await call('POST', `/orders/${o2.id}/accept`, {}, K)).json;
  check('the chef accepts (nothing is captured again)', acc.status === 'ACCEPTED' && acc.payment?.capturedCents === o2.totalCents && acc.payment.refundedCents === 0, acc.payment);
  const prev = await call('GET', `/orders/${o2.id}/cancellation`, undefined, C);
  check('before the cutoff an accepted order can still be cancelled for a full refund (preview)', prev.json.allowed && prev.json.full && prev.json.refundCents === o2.totalCents, prev.json);
  await call('POST', `/orders/${o2.id}/ready`, {}, K);
  const done = (await call('POST', `/orders/${o2.id}/handoff`, { pickupCode: acc.pickupCode }, K)).json;
  const credited = (await balance()) - bal0;
  check('completion credits the chef: food + tax − commission', done.status === 'COMPLETED' && credited === 4800 + o2.taxCents - Math.round(4800 * 0.15), { status: done.status, credited, tax: o2.taxCents });

  // customer cancellation before the cutoff: full refund
  const q3 = (await quote(lasagna, s1.iso, 1)).json;
  const o3 = (await place(q3.id)).json;
  const c3 = (await call('POST', `/orders/${o3.id}/cancel`, { reason: 'Plans changed' }, C)).json;
  check('cancelling before the cutoff refunds in full', c3.status === 'CANCELED' && c3.payment?.refundedCents === o3.totalCents, c3.payment);

  // chef late-refund setting within Gutad's range
  const bad = await call('PUT', '/chef/calendar/settings', { lateRefundPct: 150 }, K);
  check('late-refund percentage is validated', bad.status === 400, bad.status);
  const cal = (await call('PUT', '/chef/calendar/settings', { lateRefundPct: 50 }, K)).json;
  check('chef chooses a 50% refund for late cancellations', cal.settings?.lateRefundPct === 50 && cal.policy?.lateRefundMaxPct === 100, cal.settings);
  const q4 = (await quote(lasagna, s1.iso, 1)).json;
  check('new quotes carry the chef’s late-refund terms', q4.chefTerms?.lateRefundPct === 50, q4.chefTerms);
  await call('PUT', '/chef/calendar/settings', { lateRefundPct: 0 }, K);

  // multi-chef: two kitchens, one charge, two orders
  const sc = await slot(lasagna, 3);
  const sa = await slot(jollof, 3);
  const hk1 = globalThis.crypto.randomUUID(), hk2 = globalThis.crypto.randomUUID();
  const qa = (await quote(lasagna, sc.iso, 1, C, hk1)).json;
  const qb = (await quote(jollof, sa.iso, 2, C, hk2)).json;
  check('each chef gets its own quote, day and time', !!qa.id && !!qb.id && qa.locationId !== qb.locationId, { qa: qa.id, qb: qb.message || qb.id });
  const qa2 = qa;
  const idem = globalThis.crypto.randomUUID();
  const g = await call('POST', '/checkout-groups', { quoteIds: [qa2.id, qb.id] }, C, { 'Idempotency-Key': idem });
  const grp = g.json;
  check('a two-chef checkout makes two orders', grp.deliveries === 2 && grp.orders?.length === 2 && new Set(grp.orders.map((o) => o.locationId)).size === 2, grp);
  check('…paid with one charge for the total', grp.totalCents === qa2.totalCents + qb.totalCents && grp.orders.every((o) => o.payment?.sharedWithOrders && o.payment.status === 'CAPTURED' && o.checkoutGroupId === grp.id), grp.orders?.map((o) => o.payment));
  const again = (await call('POST', '/checkout-groups', { quoteIds: [qa2.id, qb.id] }, C, { 'Idempotency-Key': idem })).json;
  check('retrying the same checkout returns the same orders (idempotent)', again.id === grp.id, again.id);
  const amaraOrder = grp.orders.find((o) => o.locationId === jollof.location.id);
  const carlosOrder = grp.orders.find((o) => o.locationId === lasagna.location.id);
  const decA = (await call('POST', `/orders/${amaraOrder.id}/reject`, { reason: 'Family emergency' }, M)).json;
  check('one chef declining refunds only that chef’s share', decA.payment?.refundedCents === amaraOrder.totalCents, decA.payment);
  const carlosNow = (await call('GET', `/orders/${carlosOrder.id}`, undefined, C)).json;
  check('the other chef’s order is untouched', carlosNow.status === 'SUBMITTED' && carlosNow.payment.refundedCents === 0, carlosNow.payment);
  const otherChef = await call('POST', `/orders/${carlosOrder.id}/reject`, { reason: 'not mine' }, M);
  check('a chef can’t act on another chef’s order', otherChef.status === 403 || otherChef.status === 404, otherChef.status);
  const groupView = (await call('GET', `/checkout-groups/${grp.id}`, undefined, C)).json;
  check('the customer sees the checkout with both deliveries', groupView.orders?.length === 2, groupView);
  const custGroup = await call('GET', `/checkout-groups/${grp.id}`, undefined, A);
  check('staff can open a customer’s checkout', custGroup.status === 200, custGroup.status);
  await call('POST', `/orders/${carlosOrder.id}/cancel`, { reason: 'smoke cleanup' }, C);

  const mixed = await call('POST', '/checkout-groups', { quoteIds: [qa2.id] }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() });
  check('a used quote can’t be checked out twice', mixed.status === 409, mixed.json);
}
