// Admin platform, phase E checks: customer accounts, checkout eligibility (Gutad mixing rule), support & service recovery.
export async function adminPhaseE({ call, check, A, O, C, locId, demoOrgId }) {
  console.log('\n── Admin platform E: customers, checkout, support');
  const stamp = Date.now();
  const API = process.env.API_URL || 'http://localhost:4000';
  const reg = async (tag) => { const email = `${tag}-${stamp}@example.com`; const r = (await call('POST', '/auth/register', { email, password: 'custpass12345', name: tag, phone: `+1555${String(stamp).slice(-7)}` })).json; return { email, token: r.accessToken, id: r.user?.id }; };
  const me = (await call('GET', '/auth/me', undefined, C)).json;
  const items = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const hallItem = (await call('GET', `/public/locations/${hall.id}/menus?channel=DIRECT`)).json[0].categories[0].items[0];
  const q = (token, extra = {}, lines = [{ menuItemId: lemonade.id, quantity: 1 }], lid = locId) => call('POST', '/quotes', { locationId: lid, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines, ...extra }, token);

  // 11.3 / 11.4 Gutad mixing rule
  const cross = (await call('GET', `/public/cart-compatibility?current=${locId}&adding=${hall.id}`)).json;
  const same = (await call('GET', `/public/cart-compatibility?current=${hall.id}&adding=${hall.id}`)).json;
  const mixed = await q(C, {}, [{ menuItemId: lemonade.id, quantity: 1 }, { menuItemId: hallItem.id, quantity: 1 }]);
  check('independent restaurant and food hall need separate orders (explained)', !cross.ok && /independent/i.test(cross.reason) && same.ok && mixed.status === 400 && mixed.json.code === 'SEPARATE_ORDER_REQUIRED', { cross, mixed: mixed.json });

  // 11.1 closed with the next opening time
  const cl = (await call('POST', `/locations/${locId}/closures`, { kind: 'CLOSED', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), service: 'ORDERING', reason: 'Smoke E' }, O)).json;
  const closed = await q(C);
  await call('DELETE', `/closures/${cl.id}`, undefined, O);
  check('closed restaurant answers with a code and the next opening time', closed.status === 400 && closed.json.code === 'CLOSED' && 'nextOpenAt' in closed.json, closed.json);

  // 11.5 scheduled slot capacity
  const page = (await call('GET', `/public/locations/${locId}`)).json;
  const day = page.pickupTimes.find((d, i) => i > 0 && d.slots.length);
  const slotIso = (await call('GET', `/public/locations/${locId}/local-time?date=${day.date}&time=${day.slots[0]}`)).json.iso;
  await call('PATCH', `/locations/${locId}`, { scheduledSlotCapacity: 1 }, O);
  const s1 = (await q(C, { scheduledFor: slotIso })).json;
  const o1 = (await call('POST', '/orders', { quoteId: s1.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  const s2 = await q(C, { scheduledFor: slotIso });
  const page2 = (await call('GET', `/public/locations/${locId}`)).json;
  await call('PATCH', `/locations/${locId}`, { scheduledSlotCapacity: null }, O);
  check('scheduled slots have a capacity; full slots disappear from the picker', o1.id && s2.status === 400 && s2.json.code === 'SLOT_FULL' && !page2.pickupTimes.find((d) => d.date === day.date).slots.includes(day.slots[0]), s2.json);

  // 11.7 declined card keeps the quote for a retry; 10.3 saved card
  const qd = (await q(C)).json;
  const declined = await call('POST', '/orders', { quoteId: qd.id, paymentMethodId: 'mock_pm_0002' }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const rawCard = await call('POST', '/me/payment-methods', { paymentMethodId: '4242424242424242' }, C);
  const card = (await call('POST', '/me/payment-methods', { paymentMethodId: 'mock_pm_4242', brand: 'visa', expMonth: 12, expYear: 2030 }, C)).json;
  const retried = (await call('POST', '/orders', { quoteId: qd.id, savedPaymentMethodId: card.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  check('declined payment: no order, same quote retried with a saved card', declined.status === 400 && declined.json.code === 'PAYMENT_DECLINED' && declined.json.quoteId === qd.id && retried.id && retried.payment?.status === 'AUTHORIZED', { d: declined.json?.code, r: retried.payment?.status });
  check('cards are saved as processor tokens only (masked)', rawCard.status === 400 && card.last4 === '4242', [rawCard.status, card.last4]);

  // 10.1 / 10.2 directory & 360, PII masking
  const mkEmail = `marketing-e-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: mkEmail, password: 'staffpass12345', name: 'Mk' });
  await call('POST', '/admin/security/staff/roles', { email: mkEmail, roles: ['MARKETING'], reason: 'Smoke E staffing' }, A);
  const MK = (await call('POST', '/auth/login', { email: mkEmail, password: 'staffpass12345' })).json.accessToken;
  const dirA = (await call('GET', `/admin/customers?q=${encodeURIComponent(me.email)}`, undefined, A)).json;
  const dirM = (await call('GET', `/admin/customers?q=${encodeURIComponent(me.email)}`, undefined, MK)).json;
  check('customer directory, with contact details masked for roles without PII access', dirA.items?.[0]?.email === me.email && dirM.items?.[0]?.email?.includes('•••'), [dirA.items?.[0]?.email, dirM.items?.[0]?.email]);
  const prof = (await call('GET', `/admin/customers/${me.id}`, undefined, A)).json;
  check('customer 360: orders, refunds, credits, cards, goodwill, restrictions, privacy', prof.orders?.length >= 1 && Array.isArray(prof.refunds) && typeof prof.credits?.balanceCents === 'number' && prof.paymentMethods?.some((c) => c.last4 === '4242' && !c.providerRef) && prof.goodwill && Array.isArray(prof.restrictions), Object.keys(prof));

  // 10.5 notification preferences
  const pr = (await call('PUT', '/me/notification-prefs', { topics: [{ topic: 'orders', email: false, sms: false, push: true }, { topic: 'marketing', email: false, sms: false, push: false }] }, C)).json;
  check('per-topic notification preferences (marketing consent follows)', pr.topics.find((t) => t.topic === 'orders').email === false && pr.marketingConsent === false, pr.topics);

  // 10.4 duplicates & merge
  const dupEmail = me.email.replace('@', '+dup@');
  const dup = (await call('POST', '/auth/register', { email: dupEmail, password: 'custpass12345', name: 'Dup' })).json;
  const prof2 = (await call('GET', `/admin/customers/${me.id}`, undefined, A)).json;
  const found = prof2.duplicates.find((d) => d.id === dup.user.id);
  const merged = (await call('POST', `/admin/customers/${dup.user.id}/merge`, { intoUserId: me.id, reason: 'Same person, two sign-ups' }, A)).json;
  const dupLogin = await call('POST', '/auth/login', { email: dupEmail, password: 'custpass12345' });
  check('duplicate accounts are detected and merged', found?.why.includes('same email') && merged.merged && dupLogin.status === 401, { why: found?.why, login: dupLogin.status });
  const rec = await call('POST', `/admin/customers/${me.id}/send-recovery`, { reason: 'Customer locked out, verified by phone' }, A);
  check('support can send an account recovery link (audited)', rec.status === 201, rec.status);

  // 10.8 restrictions & appeals; customer strikes take effect
  const R = await reg('restricted');
  const rr = (await call('POST', `/admin/customers/${R.id}/restrictions`, { kind: 'ORDERING_BLOCKED', reason: 'Chargeback abuse under review' }, A)).json;
  const blocked = await q(R.token);
  const appeal = (await call('POST', `/me/restrictions/${rr.id}/appeal`, { note: 'I never filed a chargeback, please check' }, R.token)).json;
  const queue = (await call('GET', '/admin/appeals', undefined, A)).json;
  await call('POST', `/admin/restrictions/${rr.id}/appeal-decision`, { lift: true, note: 'Bank confirmed no dispute' }, A);
  const unblocked = await q(R.token);
  check('ordering restriction with reason, appeal and lift', blocked.status === 403 && blocked.json.code === 'ACCOUNT_RESTRICTED' && appeal.appealStatus === 'PENDING' && queue.some((x) => x.id === rr.id) && unblocked.status === 201, [blocked.status, unblocked.status]);
  await call('POST', `/admin/customers/${R.id}/restrictions`, { kind: 'PROMOTIONS_BLOCKED', reason: 'Promo abuse' }, A);
  const promo = await q(R.token, { promoCode: 'WELCOME10' });
  check('promotion restriction blocks promo codes', promo.status === 400 && promo.json.code === 'PROMOTIONS_BLOCKED', promo.json);
  const S = await reg('striked');
  for (let i = 0; i < 3; i++) await call('POST', '/policy/strikes', { subjectType: 'CUSTOMER', subjectId: S.id, reason: 'Abusive to couriers' }, A);
  const sr = (await call('GET', '/me/restrictions', undefined, S.token)).json;
  check('three customer strikes block ordering', sr.some((x) => x.kind === 'ORDERING_BLOCKED'), sr);

  // 10.6 segments
  const seg = (await call('POST', '/admin/segments', { name: `Smoke regulars ${stamp}`, rules: { minOrders: 1 } }, A)).json;
  const segs = (await call('GET', '/admin/segments', undefined, A)).json;
  const csv = await fetch(`${API}/admin/customers/export.csv?minOrders=1`, { headers: { Authorization: `Bearer ${A}` } });
  check('platform segments with size and CSV export', segs.find((s) => s.id === seg.id)?.size >= 1 && csv.status === 200 && (await csv.text()).startsWith('id,name,email'), segs.find((s) => s.id === seg.id));

  // 10.7 privacy: export now, deletion after review
  const exp = (await call('POST', '/me/data-request', { kind: 'ACCESS' }, R.token)).json;
  const del = (await call('POST', '/me/data-request', { kind: 'DELETE' }, R.token)).json;
  const mine = (await call('GET', '/me/data-requests', undefined, R.token)).json;
  const pq = (await call('GET', '/admin/privacy-requests?status=PENDING', undefined, A)).json;
  const ex = (await call('POST', `/admin/privacy-requests/${del.request.id}/decision`, { action: 'EXECUTE', note: 'Checked: no open orders or disputes' }, A)).json;
  const gone = await call('POST', '/auth/login', { email: R.email, password: 'custpass12345' });
  check('privacy: data export, deletion scheduled with a grace period, reviewed and executed', exp.export?.profile && del.request.status === 'PENDING' && del.request.scheduledFor && pq.some((x) => x.id === del.request.id) && ex.status === 'FULFILLED' && gone.status === 401 && mine.some((x) => x.id === del.request.id && x.status === 'PENDING'), { del: del.request?.status, ex: ex.status, login: gone.status });

  // 24 support: categories, priority/queue/SLA, food-safety alert, preview, first response, responsibility review, root causes
  const ordForTicket = (await call('GET', '/me/orders', undefined, C)).json[0];
  const fs = (await call('POST', '/incidents', { orderId: ordForTicket.id, category: 'FOOD_SAFETY', description: 'Felt sick after eating the burger' }, C)).json;
  const alerts = (await call('GET', '/admin/alerts', undefined, A)).json;
  check('food-safety reports are urgent, routed to food safety and raise a critical alert', fs.priority === 'URGENT' && fs.queue === 'FOOD_SAFETY' && fs.firstResponseDueAt && fs.paymentId && alerts.some((a) => a.type === 'FOOD_SAFETY' && a.subjectId === fs.id), { p: fs.priority, q: fs.queue });
  const wrong = (await call('POST', '/incidents', { orderId: ordForTicket.id, category: 'WRONG_ITEM', description: 'Got iced tea instead of lemonade', menuItemId: lemonade.id }, C)).json;
  const asg = (await call('POST', `/incidents/${wrong.id}/assign`, { assigneeId: (await call('GET', '/auth/me', undefined, A)).json.id, priority: 'URGENT' }, A)).json;
  await call('POST', `/incidents/${wrong.id}/messages`, { body: 'Sorry about that — looking into it now.' }, A);
  const after = (await call('GET', `/incidents/${wrong.id}`, undefined, A)).json.incident;
  check('tickets are assigned, re-prioritized, and the first staff reply is recorded', asg.status === 'INVESTIGATING' && asg.priority === 'URGENT' && after.firstRespondedAt, { s: asg.status, f: after.firstRespondedAt });
  const prev = (await call('GET', `/incidents/${wrong.id}/remedy-preview?remedy=REFUND&cents=99999`, undefined, A)).json;
  check('remedy preview: refundable amount, prior compensation, goodwill and why approval is needed', typeof prev.refundableCents === 'number' && prev.refundFits === false && prev.goodwill && Array.isArray(prev.reasons), prev);
  const queueSupport = (await call('GET', '/incidents?queue=FOOD_SAFETY', undefined, A)).json;
  check('support queues by team', queueSupport.some((i) => i.id === fs.id), queueSupport.length);
  // responsibility review: the merchant disputes a merchant-funded refund; reversed → merchant re-credited
  const resolvedList = (await call('GET', '/incidents?status=RESOLVED', undefined, A)).json;
  const merchantOwned = resolvedList.find((i) => i.owner === 'MERCHANT' && i.remedyCents > 0 && i.organizationId === demoOrgId);
  const bal1 = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  const disp = (await call('POST', `/incidents/${merchantOwned.id}/dispute-responsibility`, { reason: 'The courier dropped the bag; our packing photo shows it sealed' }, O)).json;
  const custDisp = await call('POST', `/incidents/${merchantOwned.id}/dispute-responsibility`, { reason: 'not me' }, C);
  const dec = (await call('POST', `/incidents/${merchantOwned.id}/responsibility-decision`, { reverse: true, note: 'Packing photo confirms the merchant packed correctly' }, A)).json;
  const bal2 = (await call('GET', `/organizations/${demoOrgId}/balance`, undefined, O)).json.payableCents;
  check('merchant disputes responsibility; reversal moves the cost to the platform and re-credits the merchant', disp.responsibilityDispute?.status === 'OPEN' && custDisp.status === 403 && dec.owner === 'PLATFORM' && dec.responsibilityDispute.status === 'REVERSED' && bal2 - bal1 === merchantOwned.remedyCents, { bal1, bal2, cents: merchantOwned.remedyCents, disp: disp.responsibilityDispute, cust: custDisp.status, owner: dec.owner, dst: dec.responsibilityDispute?.status, err: disp.message || dec.message });
  const rcDish = (await call('GET', '/admin/support/root-causes?dim=dish', undefined, A)).json;
  const rcCat = (await call('GET', '/admin/support/root-causes?dim=category', undefined, A)).json;
  const rcZone = (await call('GET', '/admin/support/root-causes?dim=merchant', undefined, A)).json;
  check('root causes by dish, category and merchant', rcDish.rows.some((r) => r.key === 'House lemonade') && rcCat.rows.some((r) => r.key === 'FOOD_SAFETY') && rcZone.rows.length >= 1, rcDish.rows.slice(0, 3));
}
