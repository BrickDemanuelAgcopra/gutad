#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API with the seed loaded.
 *   API_URL=http://localhost:4000 node scripts/smoke.mjs
 * Exercises: auth, discovery, menus, quotes, idempotent checkout, intake, kitchen tickets, pickup handoff,
 * delivery dispatch, reservations + host stand + cover fees, waitlist, tickets, private events, group orders,
 * meal kits, incidents/refunds, settlement close, ledger integrity.
 */
import { adminPhaseA } from './smoke-admin-a.mjs';
import { adminPhaseB } from './smoke-admin-b.mjs';
import { adminPhaseC } from './smoke-admin-c.mjs';
const API = process.env.API_URL || 'http://localhost:4000';
let failures = 0;
const results = [];

async function call(method, path, body, token, extra = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  if (!cond) { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
  else console.log(`  ✓ ${name}`);
}
const uuid = () => globalThis.crypto.randomUUID();
const futureIso = (days, hh = 19) => { const d = new Date(Date.now() + days * 86400000); return `${d.toISOString().slice(0, 10)}`; };

(async () => {
  console.log(`Smoke test → ${API}`);
  const health = await call('GET', '/health');
  check('health ok', health.json.ok, health.json);

  // ── auth
  const custEmail = `smoke-${Date.now()}@example.com`;
  const cust = (await call('POST', '/auth/register', { email: custEmail, password: 'customer12345', name: 'Smoke Customer', phone: '+15550101', marketingConsent: true })).json;
  const owner = (await call('POST', '/auth/login', { email: 'owner@demo.gutad.io', password: 'merchant12345' })).json;
  const admin = (await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL || 'admin@gutad.io', password: process.env.ADMIN_PASSWORD || 'admin12345' })).json;
  check('customer register', cust.accessToken, cust);
  const relogin = (await call('POST', '/auth/login', { email: custEmail, password: 'customer12345' })).json;
  check('customer login', relogin.accessToken, relogin);
  check('owner login', owner.accessToken, owner);
  check('admin login', admin.accessToken, admin);
  const C = cust.accessToken, O = owner.accessToken, A = admin.accessToken;
  const guest = (await call('POST', '/auth/guest', { email: `guest-${Date.now()}@example.com`, name: 'Guest One' })).json;
  check('guest checkout identity', guest.accessToken, guest);

  // ── discovery
  const search = (await call('GET', '/public/search?city=New%20York&service=pickup')).json;
  check('search returns demo bistro', search.items?.some((i) => i.slug === 'demo-bistro-new-york'), search);
  const hallSearch = (await call('GET', '/public/search?city=New%20York')).json;
  const hallBrands = hallSearch.items?.filter((i) => i.slug === 'demo-kitchen-collective') || [];
  check('Made at Gutad food hall listed once per brand', hallBrands.length === 2 && hallBrands.every((i) => i.platformOperated && i.brand && i.foodHallName === 'Demo Kitchen Collective'), hallBrands.map((i) => i.name));
  const bistroResult = hallSearch.items?.find((i) => i.slug === 'demo-bistro-new-york');
  check('independent restaurant is not Made at Gutad', bistroResult && !bistroResult.platformOperated && !bistroResult.brand, bistroResult);
  const bowlSearch = (await call('GET', '/public/search?q=bowl')).json;
  check('brand search finds the brand inside the food hall', bowlSearch.items?.some((i) => i.brand?.slug === 'bowl-theory') && !bowlSearch.items?.some((i) => i.brand?.slug === 'smash-society'), bowlSearch.items?.map((i) => i.name));
  const page = (await call('GET', '/public/locations/demo-bistro-new-york')).json;
  check('location page has hours & shifts', page.hours?.length && page.diningShifts?.length, page);
  const locId = page.id;
  const serv = (await call('GET', `/public/locations/${locId}/serviceability?lat=40.7346&lng=-73.9975`)).json;
  check('address serviceable (zone)', serv.deliverable && serv.zoneId, serv);

  // ── menus & quote
  const menus = (await call('GET', `/public/locations/${locId}/menus?channel=MARKETPLACE`)).json;
  const burger = menus[0].categories.flatMap((c) => c.items).find((i) => i.name === 'Bistro burger');
  const lemonade = menus[0].categories.flatMap((c) => c.items).find((i) => i.name === 'House lemonade');
  check('menu has items with channel price', burger && burger.priceCents === 2400, burger);
  const doneness = burger.modifierGroups.find((g) => g.name === 'Doneness').options[0].id;
  const bacon = burger.modifierGroups.find((g) => g.name === 'Extras').options[0].id;
  const badQuote = await call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: burger.id, quantity: 1 }] }, C);
  check('required modifier enforced', badQuote.status === 400, badQuote.json);
  const quote = (await call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: burger.id, quantity: 2, modifierOptionIds: [doneness, bacon] }, { menuItemId: lemonade.id, quantity: 1 }], tipCents: 300, promoCode: 'WELCOME10' }, C)).json;
  check('quote priced with promo + modifiers', quote.subtotalCents === 2 * (2400 + 300) + 500 && quote.discountCents === Math.round(quote.subtotalCents * 0.1) && quote.totalCents > 0, quote);

  // ── idempotent checkout
  const key = uuid();
  const o1 = (await call('POST', '/orders', { quoteId: quote.id }, C, { 'Idempotency-Key': key })).json;
  const o2 = (await call('POST', '/orders', { quoteId: quote.id }, C, { 'Idempotency-Key': key })).json;
  check('checkout creates order with payment authorized', o1.id && o1.payment?.status === 'AUTHORIZED' && o1.pickupCode, o1);
  check('duplicate submit returns the same order', o2.id === o1.id, { o1: o1.id, o2: o2.id });
  const replay = await call('POST', '/orders', { quoteId: quote.id }, C, { 'Idempotency-Key': key });
  check('idempotent replay header', replay.json.id === o1.id, replay.json);

  // ── merchant intake
  const inbox = (await call('GET', `/locations/${locId}/orders`, undefined, O)).json;
  check('order in merchant inbox', inbox.some((o) => o.id === o1.id), inbox.length);
  const accepted = (await call('POST', `/orders/${o1.id}/accept`, { prepMinutes: 15 }, O)).json;
  check('accept captures payment', accepted.status === 'ACCEPTED' && accepted.payment?.status === 'CAPTURED', accepted);
  const acceptedAgain = (await call('POST', `/orders/${o1.id}/accept`, {}, O)).json;
  check('accept is idempotent', acceptedAgain.status === 'ACCEPTED', acceptedAgain);
  const tl = (await call('GET', `/orders/${o1.id}/timeline`, undefined, O)).json;
  check('exactly one kitchen ticket per station group', tl.tickets?.length >= 1 && new Set(tl.tickets.map((t) => t.stationCode)).size === tl.tickets.length, tl.tickets);
  const ready = (await call('POST', `/orders/${o1.id}/ready`, {}, O)).json;
  check('mark ready', ready.status === 'READY', ready);
  const badHandoff = await call('POST', `/orders/${o1.id}/handoff`, { pickupCode: 'XXXX' }, O);
  check('wrong pickup code rejected', badHandoff.status === 400, badHandoff.json);
  const done = (await call('POST', `/orders/${o1.id}/handoff`, { pickupCode: o1.pickupCode }, O)).json;
  check('handoff completes pickup order', done.status === 'COMPLETED', done);

  // ── reject path releases authorization
  const q2 = (await call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }] }, C)).json;
  check('direct channel has no commission/service fee', q2.serviceFeeCents === 0, q2);
  const o3 = (await call('POST', '/orders', { quoteId: q2.id }, C, { 'Idempotency-Key': uuid() })).json;
  const rejected = (await call('POST', `/orders/${o3.id}/reject`, { reason: 'Out of lemons' }, O)).json;
  check('reject voids the hold', rejected.status === 'REJECTED' && rejected.payment?.status === 'VOIDED', rejected);

  // ── delivery
  const dq = (await call('POST', '/quotes', { locationId: locId, channel: 'MARKETPLACE', fulfillmentType: 'DELIVERY', lines: [{ menuItemId: burger.id, quantity: 1, modifierOptionIds: [doneness] }], tipCents: 500, deliveryAddress: { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975 } }, C)).json;
  check('delivery is free for the diner ($0 delivery fee)', dq.deliveryFeeCents === 0 && dq.promiseAt, dq);
  check('marketplace delivery carries the service fee', dq.serviceFeeCents > 0, dq);
  check('marketplace pickup has no service fee', quote.serviceFeeCents === 0, quote);
  const d1 = (await call('POST', '/orders', { quoteId: dq.id }, C, { 'Idempotency-Key': uuid() })).json;
  check('delivery order has QUOTED job', d1.delivery?.status === 'QUOTED', d1.delivery);
  const dAcc = (await call('POST', `/orders/${d1.id}/accept`, {}, O)).json;
  check('accept dispatches courier', dAcc.delivery?.status === 'REQUESTED', dAcc.delivery);
  const track = (await call('GET', `/public/delivery/${d1.id}/track`)).json;
  check('public tracking', track.status === 'REQUESTED', track);
  const dispatch = (await call('GET', `/locations/${locId}/dispatch`, undefined, O)).json;
  check('dispatcher queue shows job', dispatch.some((j) => j.orderId === d1.id), dispatch.length);
  const ext = (await call('POST', `/locations/${locId}/delivery-jobs/external`, { externalOrderId: 'POS-1001', dropoff: { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975 }, orderValueCents: 3000 }, O)).json;
  const ext2 = (await call('POST', `/locations/${locId}/delivery-jobs/external`, { externalOrderId: 'POS-1001', dropoff: { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011', lat: 40.7346, lng: -73.9975 }, orderValueCents: 3000 }, O)).json;
  check('delivery-only dispatch is idempotent by external id', ext.id && ext.id === ext2.id, { ext, ext2 });

  // ── shared kitchen multi-brand order
  const kpage = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const kmenus = (await call('GET', `/public/locations/${kpage.id}/menus`)).json;
  check('kitchen location exposes two brand menus', kmenus.length === 2 && kmenus.every((m) => m.brand), kmenus.map((m) => m.brand?.name));
  const smash = kmenus.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.name === 'Double smash');
  const bowl = kmenus.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.name === 'Harvest bowl');
  const kOverview = (await call('GET', `/organizations/${owner.user.merchantIds[0]}`, undefined, O)).json;
  const kitchenId = (await call('GET', `/kitchens/${kOverview.locations.find((l) => l.kitchenId)?.kitchenId}`, undefined, O)).json.id;
  const stockBefore = (await call('GET', `/kitchens/${kitchenId}/stock`, undefined, O)).json.find((s) => s.ingredient.name === 'Ground beef').onHand;
  const kq = (await call('POST', '/quotes', { locationId: kpage.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: smash.id, quantity: 1 }, { menuItemId: bowl.id, quantity: 1 }] }, C)).json;
  const ko = (await call('POST', '/orders', { quoteId: kq.id }, C, { 'Idempotency-Key': uuid() })).json;
  const kAcc = (await call('POST', `/orders/${ko.id}/accept`, {}, O)).json;
  check('multi-brand order accepted', kAcc.status === 'ACCEPTED', kAcc);
  const stationQ = (await call('GET', `/kitchens/${kitchenId}/stations/queue`, undefined, O)).json;
  check('station tickets fanned out across stations', stationQ.filter((t) => t.orderId === ko.id).length === 2, stationQ.map((t) => t.stationCode));
  for (const t of stationQ.filter((t) => t.orderId === ko.id)) { await call('POST', `/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }, O); await call('POST', `/tickets/${t.id}/transition`, { status: 'DONE' }, O); }
  const packQ = (await call('GET', `/kitchens/${kitchenId}/packing`, undefined, O)).json;
  const pack = packQ.find((p) => p.orderId === ko.id);
  check('packing task awaits verification', pack && pack.status === 'VERIFYING', pack);
  const blocked = await call('POST', `/packing/${pack.id}/release`, {}, O);
  check('bag cannot release before all lines verified', blocked.status === 409, blocked.json);
  for (const l of pack.lines) await call('POST', `/packing/${pack.id}/verify`, { lineId: l.id }, O);
  const released = (await call('POST', `/packing/${pack.id}/release`, {}, O)).json;
  check('bag released → order READY', released.status === 'RELEASED', released);
  const stock = (await call('GET', `/kitchens/${kitchenId}/stock`, undefined, O)).json;
  check('ingredient stock consumed by recipe', stock.find((s) => s.ingredient.name === 'Ground beef')?.onHand === stockBefore - 180, stock);

  // ── reservations
  const date = futureIso(2);
  const avail = (await call('GET', `/public/locations/${locId}/availability?date=${date}&partySize=2`)).json;
  check('availability lists dinner slots', avail.slots?.some((s) => s.time >= '17:00'), avail);
  const slot = avail.slots.find((s) => s.time === '19:00') || avail.slots[0];
  const r1 = (await call('POST', '/reservations', { locationId: locId, startAt: slot.iso, partySize: 2, guestName: 'Casey Customer', channel: 'MARKETPLACE' }, C)).json;
  check('reservation confirmed with table', r1.status === 'CONFIRMED' && r1.tableIds?.length === 1, r1);
  // overbook protection: fill all 2-tops at the same slot and expect a conflict
  const extra = [];
  for (let i = 0; i < 5; i++) extra.push(await call('POST', '/reservations', { locationId: locId, startAt: slot.iso, partySize: 2, guestName: `Guest ${i}` }, C));
  check('overlapping tables are never oversold', extra.filter((r) => r.status === 409 || r.json.status === 'CONFIRMED').length === 5 && extra.some((r) => r.status === 409), extra.map((r) => r.status));
  const bigParty = await call('POST', '/reservations', { locationId: locId, startAt: slot.iso, partySize: 7, guestName: 'Big Party' }, C);
  check('large party requires card (HELD)', bigParty.json.status === 'HELD' && bigParty.json.requiresPayment, bigParty.json);
  const confirmed = (await call('POST', `/reservations/${bigParty.json.id}/confirm`, { paymentMethodId: 'mock_pm_4242' })).json;
  check('hold confirmed with guarantee', confirmed.status === 'CONFIRMED' && confirmed.guaranteePaymentMethodId, confirmed);
  const board = (await call('GET', `/locations/${locId}/host?date=${date}`, undefined, O)).json;
  check('host board shows bookings & floor', board.reservations.length >= 2 && board.floor.tables.length === 6, { n: board.reservations.length });
  const seated = (await call('POST', `/reservations/${r1.id}/host`, { action: 'SEAT', actualPartySize: 2 }, O)).json;
  check('host seats party', seated.status === 'SEATED', seated);
  const completed = (await call('POST', `/reservations/${r1.id}/host`, { action: 'COMPLETE', posCheckId: 'CHK-1', checkTotalCents: 8800 }, O)).json;
  check('visit closed: billable covers & cover fee', completed.status === 'COMPLETED' && completed.billableCovers === 2 && completed.coverFeeCents === 200, completed);
  const noShow = (await call('POST', `/reservations/${confirmed.id}/host`, { action: 'NO_SHOW' }, O)).json;
  check('no-show charged via guarantee', noShow.status === 'NO_SHOW' && noShow.noShowChargedCents === 7 * 2500, noShow);
  // Seating a walk-in books "now", which must fall inside a dining shift. The demo shifts leave gaps
  // (15:00–17:00, after 22:30, before 11:30), so open a temporary all-day shift for this check and close it after.
  const walkInShift = (await call('POST', `/locations/${locId}/shifts`, { name: 'Smoke walk-ins', startTime: '00:00', endTime: '23:59', maxPartySize: 8 }, O)).json;
  const wl = (await call('POST', `/public/locations/${locId}/waitlist`, { guestName: 'Walk In', partySize: 2 }, C)).json;
  const wlSeat = (await call('POST', `/waitlist/${wl.id}/seat`, {}, O)).json;
  await call('POST', `/locations/${locId}/shifts`, { id: walkInShift.id, name: 'Smoke walk-ins', startTime: '00:00', endTime: '23:59', isActive: false }, O);
  check('waitlist → walk-in seated', walkInShift.id && wlSeat.status === 'SEATED' && wlSeat.channel === 'WALK_IN', wlSeat);

  // ── experiences & private events
  const exps = (await call('GET', `/public/locations/${locId}/experiences`)).json;
  const session = exps[0].sessions[0];
  const ticket = (await call('POST', '/tickets', { sessionId: session.id, spots: 2, guestName: 'Casey', paymentMethodId: 'mock_pm_4242' }, C)).json;
  check('prepaid ticket confirmed with service fee', ticket.status === 'CONFIRMED' && ticket.ticketCents === 13000 && ticket.serviceFeeCents === 260, ticket);
  const after = (await call('GET', `/public/experiences/${exps[0].id}`)).json;
  check('session inventory consumed', after.sessions.find((s) => s.id === session.id).remaining === session.remaining - 2, after.sessions[0]);
  const inquiry = (await call('POST', `/public/locations/${locId}/event-inquiries`, { contactName: 'Casey', contactEmail: 'customer@demo.gutad.io', eventDate: new Date(Date.now() + 30 * 86400000).toISOString(), partySize: 30, budgetCents: 300000 }, C)).json;
  const proposal = (await call('POST', `/event-inquiries/${inquiry.id}/propose`, { proposalCents: 320000, depositCents: 100000 }, O)).json;
  const acceptedEv = (await call('POST', `/event-inquiries/${inquiry.id}/accept`, { paymentMethodId: 'mock_pm_4242' }, C)).json;
  check('private event: inquiry → proposal → deposit → confirmed', proposal.status === 'PROPOSED' && acceptedEv.status === 'CONFIRMED' && acceptedEv.depositPaymentId, acceptedEv);
  await call('POST', `/event-inquiries/${inquiry.id}/headcount`, { finalHeadcount: 28 }, C);
  const settled = (await call('POST', `/event-inquiries/${inquiry.id}/settle`, { finalCents: 300000, paymentMethodId: 'mock_pm_4242' }, O)).json;
  check('event settled: balance charged, invoice issued', settled.inquiry.status === 'COMPLETED' && settled.invoice.totalCents === 200000, settled);

  // ── group order
  const g = (await call('POST', '/group-orders', { locationId: locId, mode: 'INDIVIDUAL', name: 'Team lunch', cutoffAt: new Date(Date.now() + 3600000).toISOString(), deliverAt: new Date(Date.now() + 7200000).toISOString(), fulfillmentType: 'PICKUP', payer: 'ORGANIZER' }, C)).json;
  await call('POST', `/public/group-orders/${g.joinCode}/choices`, { name: 'Alex', lines: [{ menuItemId: lemonade.id, quantity: 1 }] });
  await call('POST', `/public/group-orders/${g.joinCode}/choices`, { name: 'Sam', lines: [{ menuItemId: burger.id, quantity: 1, modifierOptionIds: [doneness] }] }, C);
  const gs = (await call('POST', `/group-orders/${g.joinCode}/submit`, {}, C)).json;
  check('group order consolidated into one labeled order', gs.order?.id && gs.order.lines.length === 2 && gs.order.channel === 'CORPORATE', gs.order);
  const receipts = (await call('GET', `/group-orders/${g.joinCode}/receipts`, undefined, C)).json;
  check('individual receipts', receipts.length === 2, receipts);

  // ── meal kit
  const kits = (await call('GET', '/public/meal-kits?region=NY')).json;
  const ship = (await call('POST', '/meal-kits/orders', { lines: [{ productId: kits[0].id, quantity: 1 }], deliveryDate: new Date(Date.now() + 5 * 86400000).toISOString(), address: { line1: '55 W 9th St', city: 'New York', region: 'NY', postalCode: '10011' }, paymentMethodId: 'mock_pm_4242' }, C, { 'Idempotency-Key': uuid() })).json;
  check('meal kit reserved + paid', ship.status === 'RESERVED' && ship.paymentId, ship);
  const njFail = await call('POST', '/meal-kits/orders', { lines: [{ productId: kits[0].id, quantity: 1 }], deliveryDate: new Date(Date.now() + 5 * 86400000).toISOString(), address: { line1: 'x', city: 'LA', region: 'CA', postalCode: '90001' } }, C);
  check('ship region enforced', njFail.status === 400, njFail.json);

  // ── loyalty & credits after completion
  const loyalty = (await call('GET', '/me/loyalty', undefined, C)).json;
  check('loyalty points earned on completed order', loyalty.points > 0, loyalty);

  // ── support: incident → partial refund (merchant funded) after payout window
  const inc = (await call('POST', '/incidents', { orderId: o1.id, category: 'MISSING_ITEM', description: 'Lemonade missing' }, C)).json;
  const resolved = (await call('POST', `/incidents/${inc.id}/resolve`, { owner: 'MERCHANT', remedy: 'REFUND', remedyCents: 500, note: 'Verified with kitchen' }, A)).json;
  check('incident resolved with refund', resolved.status === 'RESOLVED' && resolved.remedyCents === 500, resolved);
  const pay = (await call('GET', `/orders/${o1.id}/payment`, undefined, O)).json;
  check('payment partially refunded', pay.payment.status === 'PARTIALLY_REFUNDED' && pay.refunds.length === 1, pay);

  // ── settlement
  const bal = (await call('GET', `/organizations/${owner.user.merchantIds[0]}/balance`, undefined, O)).json;
  check('merchant payable balance positive', bal.payableCents > 0, bal);
  const close = (await call('POST', '/finance/close-period', { periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: new Date(Date.now() + 60000).toISOString(), organizationId: owner.user.merchantIds[0] }, A)).json;
  check('statement + payout created', close.length === 1 && close[0].payoutId, close);
  const submit = (await call('POST', '/finance/submit-payouts', {}, A)).json;
  check('payout submitted to processor', submit.submitted >= 1, submit);
  const stmt = (await call('GET', `/statements/${close[0].statementId}`, undefined, O)).json;
  check('statement detail with ledger entries', stmt.entries.length > 0 && stmt.payout?.status === 'PAID', { entries: stmt.entries.length, payout: stmt.payout?.status });
  const integ = (await call('GET', '/finance/integrity', undefined, A)).json;
  check('ledger: every batch balances', integ.unbalancedBatches.length === 0, integ);

  // ── reporting & admin
  const dash = (await call('GET', `/locations/${locId}/reports/dashboard`, undefined, O)).json;
  check('location dashboard', dash.sales.orders >= 3 && dash.reservations.bookings >= 2, { orders: dash.sales.orders, bookings: dash.reservations.bookings });
  const platform = (await call('GET', '/admin/reports/platform', undefined, A)).json;
  check('platform dashboard revenue > 0', platform.revenueCents > 0, platform);
  const shiftOpen = (await call('GET', `/locations/${locId}/shift/open`, undefined, O)).json;
  const shiftClose = (await call('POST', `/locations/${locId}/shift/close`, { cashCents: 0 }, O)).json;
  check('shift open/close', shiftOpen.checklist.length && shiftClose.signedAt, shiftClose);
  const csv = await call('GET', `/locations/${locId}/reports/orders.csv`, undefined, O);
  check('CSV export', typeof csv.json === 'string' && csv.json.startsWith('number,'), csv.json?.slice?.(0, 40));
  const forbidden = await call('GET', '/admin/tenants', undefined, C);
  check('customers cannot reach admin', forbidden.status === 403, forbidden.status);
  const tenants = (await call('GET', '/admin/tenants', undefined, A)).json;
  check('admin lists tenants', Array.isArray(tenants) && tenants.length >= 1, tenants.length);

  // ── customer tracking stages
  const { trackingStages } = await import('../packages/shared/dist/index.js');
  const onTheWay = trackingStages({ status: 'READY', fulfillmentType: 'DELIVERY', deliveryStatus: 'PICKED_UP' });
  check('tracking shows "Courier on the way" when the courier has the food', onTheWay.find((st) => st.current)?.label === 'Courier on the way' && onTheWay.length === 5, onTheWay);
  const delivered = trackingStages({ status: 'COMPLETED', fulfillmentType: 'DELIVERY', deliveryStatus: 'DELIVERED' });
  check('tracking completes at Delivered', delivered.every((st) => st.done), delivered);
  check('pickup tracking has no courier step', trackingStages({ status: 'PREPARING', fulfillmentType: 'PICKUP' }).every((st) => st.key !== 'on_the_way'));

  // ── delivery option is locked behind platform approval
  const fleetPatch = await call('PATCH', `/locations/${locId}`, { deliveryFleet: 'MERCHANT' }, O);
  check('merchant cannot switch who delivers directly', fleetPatch.status === 403, fleetPatch.json);
  const fleetReq = (await call('POST', `/locations/${locId}/delivery-fleet-request`, { fleet: 'MERCHANT', note: 'smoke' }, O)).json;
  check('merchant can request a delivery option change', fleetReq.deliveryFleetRequested === 'MERCHANT' && fleetReq.deliveryFleet === 'PARTNER', fleetReq);
  const ownerReview = await call('POST', `/locations/${locId}/delivery-fleet-request/review`, { approve: true }, O);
  check('merchant cannot approve its own request', ownerReview.status === 403, ownerReview.status);
  const queue = (await call('GET', '/admin/delivery-fleet-requests', undefined, A)).json;
  check('request appears in the admin queue', queue.some((r) => r.id === locId), queue);
  const approved = (await call('POST', `/locations/${locId}/delivery-fleet-request/review`, { approve: true }, A)).json;
  check('admin approval applies the change', approved.deliveryFleet === 'MERCHANT' && !approved.deliveryFleetRequested, approved);
  await call('POST', `/locations/${locId}/delivery-fleet-request`, { fleet: 'PARTNER' }, O);
  const restored = (await call('POST', `/locations/${locId}/delivery-fleet-request/review`, { approve: true }, A)).json;
  check('fleet restored after test', restored.deliveryFleet === 'PARTNER', restored);

  // ── onboarding: agreement + documents gate verification
  const nEmail = `smoke-owner-${Date.now()}@example.com`;
  const nOwner = (await call('POST', '/auth/register', { email: nEmail, password: 'merchant12345', name: 'New Owner' })).json;
  let N = nOwner.accessToken;
  const nOrg = (await call('POST', '/organizations', { name: `Smoke Diner ${Date.now()}` }, N)).json;
  N = (await call('POST', '/auth/refresh', { refreshToken: nOwner.refreshToken })).json.accessToken;
  const nLoc = (await call('POST', `/organizations/${nOrg.id}/locations`, { name: `Smoke Diner ${Date.now()}`, addressLine1: '1 Test St', city: 'New York', region: 'NY', postalCode: '10001', deliveryFleet: 'MERCHANT' }, N)).json;
  check('new location ignores a merchant-chosen fleet', nLoc.id && nLoc.deliveryFleet === 'PARTNER', nLoc);
  const early = await call('POST', `/locations/${nLoc.id}/verify`, { verified: true }, A);
  check('verification blocked until onboarding is complete', early.status === 400 && /Agreement/.test(early.json.message), early.json);
  const agreement = (await call('GET', '/public/merchant-agreement')).json;
  const agreed = (await call('POST', `/organizations/${nOrg.id}/onboarding/accept`, { agreementVersion: agreement.version, signatureName: 'New Owner', signatureTitle: 'Owner' }, N)).json;
  check('owner accepts the Merchant Agreement', agreed.id && agreed.agreementVersion === agreement.version, agreed);
  const upload = async (docType, mime = 'application/pdf', bytes = 1024) => {
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `${docType.toLowerCase()}.pdf`);
    const res = await fetch(`${API}/organizations/${nOrg.id}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${N}` }, body: form });
    return { status: res.status, json: await res.json() };
  };
  const badType = await upload('BUSINESS_LICENSE', 'text/html');
  check('upload rejects non-document file types', badType.status === 400, badType.json);
  const docs = [];
  for (const t of agreement.documentTypes.filter((d) => d.required)) docs.push((await upload(t.type)).json);
  check('required documents uploaded', docs.length === 4 && docs.every((d) => d.id && d.status === 'SUBMITTED' && !('content' in d)), docs);
  const otherCust = await fetch(`${API}/documents/${docs[0].id}/file`, { headers: { Authorization: `Bearer ${C}` } });
  check('other users cannot download merchant documents', otherCust.status === 403, otherCust.status);
  const dl = await fetch(`${API}/documents/${docs[0].id}/file`, { headers: { Authorization: `Bearer ${A}` } });
  check('admin can download a document', dl.status === 200 && (await dl.arrayBuffer()).byteLength === 1024, dl.status);
  for (const d of docs) await call('POST', `/documents/${d.id}/review`, { status: 'APPROVED' }, A);
  const noForm = await call('POST', `/locations/${nLoc.id}/verify`, { verified: true }, A);
  check('verification needs a signed Order Form', noForm.status === 400 && /Order Form/.test(noForm.json.message), noForm.json);
  const form = (await call('POST', `/organizations/${nOrg.id}/contracts`, { planCode: 'DIRECT_FREE', locationIds: [], sign: false }, A)).json;
  const ob1 = (await call('GET', `/organizations/${nOrg.id}/onboarding`, undefined, N)).json;
  check('merchant sees the unsigned Order Form', ob1.orderForm?.id === form.id && !ob1.orderForm.signedAt, ob1.orderForm);
  await call('POST', `/organizations/${nOrg.id}/onboarding/accept`, { agreementVersion: agreement.version, signatureName: 'New Owner', contractId: form.id }, N);
  const ob2 = (await call('GET', `/organizations/${nOrg.id}/onboarding`, undefined, N)).json;
  check('onboarding complete after signing the Order Form', ob2.orderForm.signedAt && ob2.blockers.length === 0, ob2.blockers);
  const verified = (await call('POST', `/locations/${nLoc.id}/verify`, { verified: true }, A)).json;
  check('admin verifies once onboarding is complete', verified.status === 'VERIFIED', verified);

  // ── plan catalog (Phase 1): configurable plans, fee rules by channel + fulfillment, versioning
  const shared = await import('../packages/shared/dist/index.js');
  const pub = (await call('GET', '/public/plans')).json;
  check('public plans come from the catalog, grouped by product line', Array.isArray(pub) && pub.length === 6 && ['ORDERING', 'RESERVATIONS', 'SUITE'].every((l) => pub.some((x) => x.productLine === l)), pub.map?.((x) => x.code));
  const resCore = pub.find((x) => x.code === 'RESERVATIONS_CORE');
  check('reservations plans carry no commission (no more NaN%)', resCore && !resCore.fees.some((f) => f.type === 'COMMISSION') && shared.resolveFee(resCore.fees, 'COVER_FEE', 'MARKETPLACE', 'DINE_IN')?.cents === 150, resCore?.fees);
  const free = pub.find((x) => x.code === 'DIRECT_FREE');
  check('ordering plan: 15% marketplace delivery, 6% pickup, 0% direct', shared.resolveFee(free.fees, 'COMMISSION', 'MARKETPLACE', 'DELIVERY').bps === 1500 && shared.resolveFee(free.fees, 'COMMISSION', 'MARKETPLACE', 'PICKUP').bps === 600 && shared.resolveFee(free.fees, 'COMMISSION', 'DIRECT', 'PICKUP').bps === 0, free.fees);
  check('plans list features with names', free.features.some((f) => f.key === 'ordering' && f.enabled) && free.features.some((f) => f.key === 'floor_plan' && !f.enabled));
  const legacyTerms = (await call('GET', `/locations/${locId}/terms`, undefined, O)).json;
  check('legacy contract terms unchanged (15% marketplace)', legacyTerms.commissionBps === 1500 && legacyTerms.planCode === 'FULL_SUITE', legacyTerms);
  const nContracts = (await call('GET', `/organizations/${nOrg.id}/contracts`, undefined, N)).json;
  check('new Order Form copies the published plan version fee rules', nContracts[0]?.planVersionId && shared.resolveFee(nContracts[0].fees, 'COMMISSION', 'MARKETPLACE', 'PICKUP')?.bps === 600, nContracts[0]);
  const custAdmin = await call('GET', '/admin/plans', undefined, C);
  check('customers cannot open the plan admin', custAdmin.status === 403, custAdmin.status);
  const cat = (await call('GET', '/admin/plans', undefined, A)).json;
  const freePlan = cat.plans.find((x) => x.code === 'DIRECT_FREE');
  const draftV = (await call('POST', `/admin/plans/${freePlan.id}/versions`, {}, A)).json;
  check('admin drafts a new version copied from the live one', draftV.version === 2 && draftV.status === 'DRAFT', draftV);
  const draftAgain = await call('POST', `/admin/plans/${freePlan.id}/versions`, {}, A);
  check('only one draft per plan', draftAgain.status === 400, draftAgain.json);
  const live = freePlan.versions.find((v) => v.status === 'PUBLISHED');
  const newFees = live.fees.map(({ id, ...f }) => (f.type === 'COMMISSION' && f.fulfillment === 'PICKUP' ? { ...f, bps: 500 } : f));
  const upd = (await call('PATCH', `/admin/plan-versions/${draftV.id}`, { subscriptionCents: 0, trialDays: 14, fees: newFees, features: live.features }, A)).json;
  check('admin edits draft price, trial and fees', upd.trialDays === 14, upd);
  const editLive = await call('PATCH', `/admin/plan-versions/${live.id}`, { trialDays: 1 }, A);
  check('published versions are read-only', editLive.status === 400, editLive.json);
  const published = (await call('POST', `/admin/plan-versions/${draftV.id}/publish`, {}, A)).json;
  check('admin publishes the draft', published.status === 'PUBLISHED', published);
  const pub2 = (await call('GET', '/public/plans')).json.find((x) => x.code === 'DIRECT_FREE');
  check('public pricing shows the new version', pub2.version === 2 && pub2.trialDays === 14 && shared.resolveFee(pub2.fees, 'COMMISSION', 'MARKETPLACE', 'PICKUP').bps === 500, pub2);
  const nContracts2 = (await call('GET', `/organizations/${nOrg.id}/contracts`, undefined, N)).json;
  check('signed merchants keep their version after a publish', shared.resolveFee(nContracts2[0].fees, 'COMMISSION', 'MARKETPLACE', 'PICKUP')?.bps === 600, nContracts2[0].fees);
  const cat2 = (await call('GET', '/admin/plans', undefined, A)).json;
  check('previous version retired', cat2.plans.find((x) => x.code === 'DIRECT_FREE').versions.find((v) => v.version === 1).status === 'RETIRED');
  const feat = (await call('POST', '/admin/features', { key: 'smoke_loyalty', name: 'Loyalty program', kind: 'BOOLEAN', productLine: 'ALL' }, A)).json;
  check('admin adds a feature to the catalog', feat.key === 'smoke_loyalty', feat);
  const newPlan = (await call('POST', '/admin/plans', { code: `SMOKE_${Date.now()}`, name: 'Smoke Enterprise', productLine: 'ORDERING', isPublic: false }, A)).json;
  check('admin creates a plan (hidden draft)', newPlan.id && newPlan.isPublic === false, newPlan);

  // ── Phase 2: plan features are enforced (new org is on Direct (free listing) v1: ordering only, 1 location, 3 team members)
  const ent = (await call('GET', `/locations/${nLoc.id}/entitlements`, undefined, N)).json;
  check('entitlements come from the signed plan', ent.source === 'PLAN' && ent.planCode === 'DIRECT_FREE' && ent.features.ordering === true && ent.features.reservations === false && ent.limits.locations.max === 1 && ent.limits.locations.used === 1, ent);
  const legacyEnt = (await call('GET', `/locations/${locId}/entitlements`, undefined, O)).json;
  check('contracts from before the catalog keep every feature', legacyEnt.source === 'LEGACY' && legacyEnt.unrestricted && legacyEnt.features.floor_plan === true, legacyEnt);
  const shiftBlocked = await call('POST', `/locations/${nLoc.id}/shifts`, { name: 'Dinner' }, N);
  check('merchant blocked from a feature outside the plan', shiftBlocked.status === 403 && shiftBlocked.json.code === 'FEATURE_NOT_IN_PLAN' && shiftBlocked.json.feature === 'reservations', shiftBlocked.json);
  const availBlocked = await call('GET', `/public/locations/${nLoc.id}/availability?date=${futureIso(1)}&partySize=2`);
  check('customers get a clear message for a service the plan lacks', availBlocked.status === 403 && /isn't available for this restaurant/.test(availBlocked.json.message), availBlocked.json);
  const expBlocked = await call('POST', `/locations/${nLoc.id}/experiences`, { name: 'Tasting' }, N);
  check('experiences gated by plan', expBlocked.status === 403 && expBlocked.json.feature === 'experiences', expBlocked.json);
  const secondLoc = await call('POST', `/organizations/${nOrg.id}/locations`, { name: `Smoke Diner Two ${Date.now()}`, addressLine1: '2 Test St', city: 'New York', region: 'NY', postalCode: '10002' }, N);
  check('location limit enforced', secondLoc.status === 403 && secondLoc.json.code === 'PLAN_LIMIT_REACHED' && secondLoc.json.limit === 1, secondLoc.json);
  const inv1 = await call('POST', `/organizations/${nOrg.id}/members`, { email: `smoke-staff1-${Date.now()}@example.com`, role: 'MERCHANT_STAFF' }, N);
  const inv2 = await call('POST', `/organizations/${nOrg.id}/members`, { email: `smoke-staff2-${Date.now()}@example.com`, role: 'MERCHANT_STAFF' }, N);
  const inv3 = await call('POST', `/organizations/${nOrg.id}/members`, { email: `smoke-staff3-${Date.now()}@example.com`, role: 'MERCHANT_STAFF' }, N);
  check('team member limit enforced (3 on this plan)', inv1.status < 300 && inv2.status < 300 && inv3.status === 403 && inv3.json.code === 'PLAN_LIMIT_REACHED', [inv1.status, inv2.status, inv3.json]);
  await call('PATCH', `/admin/tenants/${nOrg.id}/features`, { reservations: true, locations: 2 }, A);
  const shiftAllowed = await call('POST', `/locations/${nLoc.id}/shifts`, { name: 'Dinner' }, N);
  check('admin override unlocks a feature', shiftAllowed.status !== 403, shiftAllowed.json);
  const ent2 = (await call('GET', `/locations/${nLoc.id}/entitlements`, undefined, N)).json;
  check('admin override raises a limit', ent2.features.reservations === true && ent2.limits.locations.max === 2, ent2);
  await call('PATCH', `/admin/tenants/${owner.user.merchantIds?.[0] || (await call('GET', '/organizations', undefined, O)).json[0].id}/features`, { reservations: false }, A);
  const resSearch = (await call('GET', '/public/search?city=New%20York&service=reservations')).json;
  check('search hides a service the plan switched off', !resSearch.items.some((i) => i.slug === 'demo-bistro-new-york'), resSearch.items.map((i) => i.slug));
  const anyBistro = (await call('GET', '/public/search?city=New%20York')).json.items.find((i) => i.slug === 'demo-bistro-new-york');
  check('restaurant still listed, reservations masked', anyBistro && anyBistro.acceptsReservations === false && anyBistro.acceptsPickup === true, anyBistro);
  await call('PATCH', `/admin/tenants/${(await call('GET', '/organizations', undefined, O)).json[0].id}/features`, { reservations: true }, A);

  // ── Phase 3: merchant self-serve plan changes, add-ons, subscriptions
  await call('PATCH', `/admin/tenants/${nOrg.id}/features`, { reservations: null, locations: null }, A);
  const bill0 = (await call('GET', `/organizations/${nOrg.id}/billing`, undefined, N)).json;
  check('billing overview shows the free plan and no subscription', bill0.current?.planCode === 'DIRECT_FREE' && !bill0.subscription, bill0.current);
  const pvUp = (await call('GET', `/organizations/${nOrg.id}/plan-change/preview?plan=DIRECT_PRO`, undefined, N)).json;
  check('upgrade preview: starts now, lists features gained', pvUp.direction === 'UPGRADE' && Math.abs(new Date(pvUp.effectiveFrom) - Date.now()) < 60_000 && pvUp.gained.includes('Branded ordering site'), pvUp);
  const custChange = await call('POST', `/organizations/${nOrg.id}/plan-change`, { planCode: 'DIRECT_PRO', signatureName: 'Mallory', agreementVersion: agreement.version }, C);
  check('only the owner can switch plans', custChange.status === 403, custChange.status);
  const up = (await call('POST', `/organizations/${nOrg.id}/plan-change`, { planCode: 'DIRECT_PRO', signatureName: 'New Owner', agreementVersion: agreement.version }, N)).json;
  check('owner upgrades by signing the new Order Form', up.direction === 'UPGRADE' && up.contractId, up);
  const bill1 = (await call('GET', `/organizations/${nOrg.id}/billing`, undefined, N)).json;
  check('upgrade is immediate with an active subscription', bill1.current?.planCode === 'DIRECT_PRO' && bill1.current.signedAt && bill1.subscription?.status === 'ACTIVE' && bill1.nextInvoice?.totalCents === 22900, { current: bill1.current?.planCode, sub: bill1.subscription, next: bill1.nextInvoice });
  const entPro = (await call('GET', `/locations/${nLoc.id}/entitlements`, undefined, N)).json;
  check('new plan features apply right away', entPro.features.branded_site === true && entPro.limits.locations.max === 3, entPro.limits);
  const extraLoc = bill1.availableAddOns.find((a) => a.code === 'EXTRA_LOCATION');
  const bought = (await call('POST', `/organizations/${nOrg.id}/add-ons`, { addOnId: extraLoc.id }, N)).json;
  const entAdd = (await call('GET', `/locations/${nLoc.id}/entitlements`, undefined, N)).json;
  check('add-on raises the plan limit', bought.id && entAdd.limits.locations.max === 4 && entAdd.addOns.includes('EXTRA_LOCATION'), entAdd.limits);
  const bill2 = (await call('GET', `/organizations/${nOrg.id}/billing`, undefined, N)).json;
  check('add-on bought mid-period is invoiced (prorated) and on the next invoice', bill2.invoices.some((i) => i.lines.some((l) => /Extra location \(prorated\)/.test(l.description))) && bill2.nextInvoice.lines.some((l) => /Extra location/.test(l.description)), bill2.invoices.map((i) => i.lines));
  const myAddOn = bill2.addOns.find((a) => a.code === 'EXTRA_LOCATION');
  const cancelled = (await call('DELETE', `/organizations/${nOrg.id}/add-ons/${myAddOn.id}`, undefined, N)).json;
  check('add-on cancellation waits for renewal', cancelled.status === 'ACTIVE' && cancelled.cancelAt, cancelled);
  const pvDown = (await call('GET', `/organizations/${nOrg.id}/plan-change/preview?plan=DIRECT_FREE`, undefined, N)).json;
  check('downgrade preview: at renewal, warns about lost features', pvDown.direction === 'DOWNGRADE' && new Date(pvDown.effectiveFrom).getTime() === new Date(bill2.subscription.currentPeriodEnd).getTime() && pvDown.lost.includes('Branded ordering site'), pvDown);
  await call('POST', `/organizations/${nOrg.id}/plan-change`, { planCode: 'DIRECT_FREE', signatureName: 'New Owner', agreementVersion: agreement.version }, N);
  const bill3 = (await call('GET', `/organizations/${nOrg.id}/billing`, undefined, N)).json;
  check('downgrade is scheduled; current plan continues', bill3.scheduledChange?.planCode === 'DIRECT_FREE' && bill3.current.planCode === 'DIRECT_PRO', { scheduled: bill3.scheduledChange, current: bill3.current?.planCode });
  await call('DELETE', `/organizations/${nOrg.id}/plan-change`, undefined, N);
  const bill4 = (await call('GET', `/organizations/${nOrg.id}/billing`, undefined, N)).json;
  check('owner can keep the current plan (cancel the scheduled change)', !bill4.scheduledChange && bill4.current.planCode === 'DIRECT_PRO', bill4.scheduledChange);
  await call('POST', `/organizations/${nOrg.id}/plan-change`, { planCode: 'DIRECT_FREE', signatureName: 'New Owner', agreementVersion: agreement.version }, N);
  const subs = (await call('GET', '/admin/subscriptions', undefined, A)).json;
  const mySub = subs.find((x) => x.organizationId === nOrg.id && x.status !== 'CANCELED');
  check('admin sees the subscription, MRR and the scheduled change', mySub && mySub.mrrCents === 22900 && mySub.scheduled?.name === 'Direct (free listing)', mySub);
  const paused = (await call('POST', `/admin/subscriptions/${mySub.id}/pause`, { reason: 'smoke' }, A)).json;
  const resumed = (await call('POST', `/admin/subscriptions/${mySub.id}/resume`, {}, A)).json;
  check('admin pauses and resumes billing', paused.status === 'PAUSED' && resumed.status === 'ACTIVE', [paused.status, resumed.status]);
  const asOf = new Date(new Date(resumed.currentPeriodEnd).getTime() + 3_600_000).toISOString();
  const runRes = await call('POST', '/admin/billing/run', { asOf }, A);
  const subsAfter = (await call('GET', '/admin/subscriptions', undefined, A)).json.filter((x) => x.organizationId === nOrg.id);
  check('renewal bills the period and applies the scheduled downgrade (free plan ends the subscription)', runRes.status < 300 && runRes.json.invoices >= 1 && subsAfter.every((x) => x.status === 'CANCELED'), [runRes.json, subsAfter.map((x) => x.status)]);
  const custBill = await call('POST', '/admin/billing/run', {}, C);
  check('only staff can run billing', custBill.status === 403, custBill.status);
  const proPlan = (await call('GET', '/admin/plans', undefined, A)).json.plans.find((x) => x.code === 'DIRECT_PRO');
  const proLive = proPlan.versions.find((v) => v.status === 'PUBLISHED');
  const mig = (await call('POST', `/admin/plan-versions/${proLive.id}/migrate`, { effectiveFrom: new Date(Date.now() + 30 * 86400000).toISOString(), dryRun: true }, A)).json;
  check('move-subscribers preview runs without changing anything', mig.dryRun === true && Array.isArray(mig.moved) && Array.isArray(mig.skipped), mig);
  const addOnAdmin = (await call('POST', '/admin/add-ons', { code: 'SMOKE_ADDON', name: 'Smoke add-on', priceCents: 1000, features: { waitlist: true } }, A)).json;
  check('admin creates an add-on', addOnAdmin.code === 'SMOKE_ADDON' && addOnAdmin.features.waitlist === true, addOnAdmin);
  const badAddOn = await call('POST', '/admin/add-ons', { code: 'BAD_ADDON', name: 'Bad add-on', priceCents: 0, features: { not_a_feature: true } }, A);
  check('add-ons only unlock known features', badAddOn.status === 400, badAddOn.json);

  // ── Phase 4: promotions and the revenue report
  const stamp = String(Date.now()).slice(-6);
  const pFree = (await call('POST', '/admin/promotions', { code: `FREE${stamp}`, name: 'First month free', kind: 'FREE_PERIODS', periods: 1 }, A)).json;
  const pHol = (await call('POST', '/admin/promotions', { code: `HOL${stamp}`, name: 'Launch commission holiday', kind: 'COMMISSION_HOLIDAY', days: 30 }, A)).json;
  const pPct = (await call('POST', '/admin/promotions', { code: `PCT${stamp}`, name: '20% off', kind: 'PERCENT_OFF', percentOff: 20, periods: 3 }, A)).json;
  const pMax = (await call('POST', '/admin/promotions', { code: `MAX${stamp}`, name: 'One only', kind: 'COMMISSION_HOLIDAY', days: 7, maxRedemptions: 1 }, A)).json;
  check('admin creates promotions of each kind', pFree.id && pHol.id && pPct.id && pMax.id, [pFree, pHol, pPct, pMax].map((x) => x.code || x.message));
  const badPromo = await call('POST', '/admin/promotions', { code: `BAD${stamp}`, name: 'Broken', kind: 'PERCENT_OFF', percentOff: 0 }, A);
  check('promotion rules are validated', badPromo.status === 400, badPromo.json);
  const custRedeem = await call('POST', `/organizations/${nOrg.id}/promotions`, { code: pHol.code }, C);
  check('only the business can redeem its codes', custRedeem.status === 403, custRedeem.status);
  const termsBefore = (await call('GET', `/locations/${nLoc.id}/terms`, undefined, N)).json;
  const hol = (await call('POST', `/organizations/${nOrg.id}/promotions`, { code: pHol.code }, N)).json;
  const termsAfter = (await call('GET', `/locations/${nLoc.id}/terms`, undefined, N)).json;
  check('commission holiday sets marketplace commission to 0%', termsBefore.commissionBps > 0 && hol.endsAt && termsAfter.commissionBps === 0, [termsBefore.commissionBps, termsAfter.commissionBps]);
  const again = await call('POST', `/organizations/${nOrg.id}/promotions`, { code: pHol.code }, N);
  const unknown = await call('POST', `/organizations/${nOrg.id}/promotions`, { code: 'NOPE-NOT-A-CODE' }, N);
  check('a code works once per business; unknown codes are rejected', again.status === 400 && unknown.status === 400, [again.json.message, unknown.json.message]);
  await call('POST', `/organizations/${nOrg.id}/promotions`, { code: pMax.code }, N);
  const demoOrgId = (await call('GET', '/organizations', undefined, O)).json[0].id;
  const maxed = await call('POST', `/organizations/${demoOrgId}/promotions`, { code: pMax.code }, O);
  check('redemption limit enforced', maxed.status === 400 && /fully redeemed/.test(maxed.json.message), maxed.json);
  await call('POST', `/organizations/${demoOrgId}/promotions`, { code: pFree.code }, O);
  const demoBill = (await call('GET', `/organizations/${demoOrgId}/billing`, undefined, O)).json;
  check('free-period promotion shows on the next invoice', demoBill.nextInvoice && demoBill.nextInvoice.lines.some((l) => l.description.startsWith(`Promotion ${pFree.code}`)) && demoBill.nextInvoice.totalCents === 0, demoBill.nextInvoice);
  const twoDiscounts = await call('POST', `/organizations/${demoOrgId}/promotions`, { code: pPct.code }, O);
  check('one subscription discount at a time', twoDiscounts.status === 400, twoDiscounts.json);
  const demoSub = (await call('GET', '/admin/subscriptions', undefined, A)).json.find((x) => x.organizationId === demoOrgId && x.status !== 'CANCELED');
  await call('POST', '/admin/billing/run', { asOf: new Date(new Date(demoSub.currentPeriodEnd).getTime() + 3_600_000).toISOString() }, A);
  const demoBill2 = (await call('GET', `/organizations/${demoOrgId}/billing`, undefined, O)).json;
  const usedFree = demoBill2.promotions.find((x) => x.code === pFree.code);
  check('free renewal used up and the subscription renews', usedFree && !usedFree.active && usedFree.periodsUsed === 1 && demoBill2.subscription?.status === 'ACTIVE' && new Date(demoBill2.subscription.currentPeriodStart) >= new Date(demoSub.currentPeriodEnd), { usedFree, sub: demoBill2.subscription });
  const rev = (await call('GET', '/admin/reports/plans', undefined, A)).json;
  check('revenue report: MRR by plan, trials, plan changes, ledger revenue', typeof rev.mrrCents === 'number' && Array.isArray(rev.byPlan) && rev.statusCounts && rev.changes90d['plan.upgrade'] >= 1 && rev.revenueByMonth.some((x) => x.account === 'PLATFORM_REVENUE_SUBSCRIPTION' && x.cents > 0), { mrr: rev.mrrCents, changes: rev.changes90d });
  const custRev = await call('GET', '/admin/reports/plans', undefined, C);
  check('revenue report is staff-only', custRev.status === 403, custRev.status);

  await adminPhaseA({ call, check, A, O, C, o1, demoOrgId });
  await adminPhaseB({ call, check, A, O, C, locId, o1 });
  await adminPhaseC({ call, check, A, O, C, locId, demoOrgId });

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
