// Follow-ups A checks: 10.8-L cash and credit limits per customer, 10.4-D device fingerprint as a duplicate
// signal, 10.3-P / 18.9-S processor tokenization endpoints (test mode keeps the test-card picker), 24.6-W merchant
// and courier responsibility disputes, 2.4c-M mobile SSO start/return endpoints.
export async function followupsA({ call, check, A, O, C, locId, demoOrgId, API }) {
  console.log('\n── Follow-ups A: limits, devices, tokenization, responsibility disputes, mobile SSO');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const device = `smoke-dev-${stamp}`;
  const reg = async (tag, headers = {}) => { const email = `fa-${tag}-${stamp}@example.com`; const r = (await call('POST', '/auth/register', { email, password: 'custpass12345', name: `FA ${tag}` }, undefined, headers)).json; return { T: r.accessToken, id: r.user?.id, email }; };
  const items = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories).flatMap((c) => c.items);
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const two = [{ menuItemId: lemonade.id, quantity: 2 }];
  const q = (T, extra = {}) => call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: two, ...extra }, T);
  const limit = (userId, body) => call('POST', `/admin/customers/${userId}/restrictions`, { reason: 'Smoke follow-up limit', ...body }, A);
  const lift = (id) => call('POST', `/admin/restrictions/${id}/lift`, { note: 'smoke cleanup' }, A);

  // ── 10.8-L cash / pay-later limit and credit usage limit
  const L1 = await reg('limits');
  const noAmount = await limit(L1.id, { kind: 'CASH_LIMIT' });
  check('10.8-L a cash limit needs an amount', noAmount.status === 400, noAmount.json);
  const cash = (await limit(L1.id, { kind: 'CASH_LIMIT', limitCents: 100 })).json;
  check('10.8-L staff set a per-order cash limit', cash.id && cash.kind === 'CASH_LIMIT' && cash.limitCents === 100 && cash.periodDays === null, cash);
  const overCash = await q(L1.T);
  check('10.8-L a quote over the cash limit is refused with CASH_LIMIT', overCash.status === 400 && (overCash.json.code === 'CASH_LIMIT' || /limited/i.test(String(overCash.json.message))), overCash.json);
  const mine = (await call('GET', '/me/restrictions', undefined, L1.T)).json;
  check('10.8-L the customer sees the limit amount', Array.isArray(mine) && mine.some((r) => r.kind === 'CASH_LIMIT' && r.limitCents === 100), mine);
  const replaced = (await limit(L1.id, { kind: 'CASH_LIMIT', limitCents: 999999 })).json;
  const prof1 = (await call('GET', `/admin/customers/${L1.id}`, undefined, A)).json;
  const activeCash = (prof1.restrictions || []).filter((r) => r.kind === 'CASH_LIMIT' && !r.liftedAt);
  check('10.8-L a new limit replaces the old one (one active per kind)', activeCash.length === 1 && activeCash[0].id === replaced.id && activeCash[0].limitCents === 999999, activeCash);
  const okQuote = await q(L1.T);
  check('10.8-L under the limit the quote goes through', okQuote.status === 201 && okQuote.json.id, okQuote.json);
  await lift(replaced.id);
  // a limit added after the quote was priced is enforced again at checkout
  const freshQuote = (await q(L1.T)).json;
  const late = (await limit(L1.id, { kind: 'CASH_LIMIT', limitCents: 100 })).json;
  const lateCheckout = await call('POST', '/orders', { quoteId: freshQuote.id, paymentMethodId: 'mock_pm_4242' }, L1.T, idem());
  check('10.8-L checkout re-checks the cash limit', lateCheckout.status === 400 && (lateCheckout.json.code === 'CASH_LIMIT' || /limited/i.test(String(lateCheckout.json.message))), lateCheckout.json);
  await lift(late.id);
  // rolling window: the first order fits, the second one goes over the 30-day total
  const w = (await q(L1.T)).json;
  const windowLimit = (await limit(L1.id, { kind: 'CASH_LIMIT', limitCents: w.totalCents + 1, periodDays: 30 })).json;
  const firstOrder = await call('POST', '/orders', { quoteId: w.id, paymentMethodId: 'mock_pm_4242' }, L1.T, idem());
  const second = await q(L1.T);
  check('10.8-L a rolling-window cash limit counts earlier orders', windowLimit.periodDays === 30 && firstOrder.status === 201 && second.status === 400 && second.json.remainingCents === 1, { first: firstOrder.status, second: second.json });
  await lift(windowLimit.id);
  // credit usage cap
  await call('POST', '/payments/credits', { userId: L1.id, cents: 1000, reason: 'Smoke credit for limits' }, A);
  const credit = (await limit(L1.id, { kind: 'CREDIT_LIMIT', limitCents: 150 })).json;
  const capped = (await q(L1.T, { useCreditsCents: 1000 })).json;
  check('10.8-L credits applied are capped at the credit limit', credit.kind === 'CREDIT_LIMIT' && capped.creditsCents === 150 && (capped.warnings || []).some((x) => /limited/i.test(x)), { creditsCents: capped.creditsCents, warnings: capped.warnings });
  await lift(credit.id);
  const uncapped = (await q(L1.T, { useCreditsCents: 1000 })).json;
  check('10.8-L lifting the credit limit restores normal credit use', uncapped.creditsCents > 150, uncapped.creditsCents);

  // ── 10.4-D device fingerprint
  const D1 = await reg('dev1', { 'X-Device-Id': device, 'X-Client': 'web' });
  const D2 = await reg('dev2', { 'X-Device-Id': device, 'X-Client': 'ios' });
  const D3 = await reg('dev3', { 'X-Device-Id': 'bad!' });
  await call('POST', '/auth/login', { email: D1.email, password: 'custpass12345' }, undefined, { 'X-Device-Id': device, 'X-Client': 'web' });
  const p1 = (await call('GET', `/admin/customers/${D1.id}`, undefined, A)).json;
  const dup = (p1.duplicates || []).find((d) => d.id === D2.id);
  check('10.4-D accounts registered from the same device are flagged as duplicates', dup && dup.why.includes('same device'), p1.duplicates);
  check('10.4-D the 360 lists sign-in devices with sign-in counts and sharing', Array.isArray(p1.devices) && p1.devices.length === 1 && p1.devices[0].signIns >= 2 && p1.devices[0].sharedWith >= 1 && p1.devices[0].client === 'web', p1.devices);
  const p3 = (await call('GET', `/admin/customers/${D3.id}`, undefined, A)).json;
  check('10.4-D malformed device ids are ignored', Array.isArray(p3.devices) && p3.devices.length === 0 && !(p3.duplicates || []).some((d) => d.why.includes('same device')), p3.devices);
  const pd = (await call('GET', `/admin/customers/${D1.id}`, undefined, A)).json;
  check('10.4-D the raw device id is never returned', !JSON.stringify(pd).includes(device), null);

  // ── 10.3-P / 18.9-S tokenization (test mode keeps the test-card picker)
  const prov = (await call('GET', '/public/payments/provider')).json;
  check('18.9-S provider endpoint reports the processor and (no) publishable key', typeof prov.provider === 'string' && (prov.provider !== 'mock' || prov.publishableKey === null), prov);
  const cfg = (await call('GET', '/public/payments/client-config')).json;
  check('18.9-S client config endpoint', cfg.provider === prov.provider && 'publishableKey' in cfg, cfg);
  if (prov.provider === 'mock') {
    const st = (await call('POST', '/me/payment-methods/setup', {}, D1.T)).json;
    check('10.3-P test mode: card setup returns the test cards, no processor call', st.mode === 'test' && Array.isArray(st.testCards) && st.testCards.length >= 3 && st.testCards.every((c) => c.token.startsWith('mock_pm_')), st);
    const comp = await call('POST', '/me/payment-methods/setup/complete', { sessionId: 'cs_test_x' }, D1.T);
    check('10.3-P test mode: nothing to complete', comp.status === 400, comp.json);
    const saved = await call('POST', '/me/payment-methods', { paymentMethodId: 'mock_pm_4444', brand: 'mastercard', last4: '4444' }, D1.T);
    check('10.3-P test mode: saving a test-card token still works', saved.status === 201 && saved.json.last4 === '4444', saved.json);
  }
  const anon = await call('POST', '/me/payment-methods/setup', {});
  check('10.3-P card setup requires sign-in', anon.status === 401, anon.status);
  const evil = await call('GET', '/public/payments/setup-return?to=https%3A%2F%2Fevil.example%2Fx&status=done');
  check('10.3-P hosted setup only returns to the app scheme', evil.status === 400, evil.json);
  const back = await fetch(`${API}/public/payments/setup-return?to=${encodeURIComponent('gutad://payments/card')}&status=done&session_id=cs_test_1`, { redirect: 'manual' });
  check('10.3-P hosted setup return forwards to the app deep link', back.status === 302 && (back.headers.get('location') || '').startsWith('gutad://payments/card?status=done&session_id=cs_test_1'), { status: back.status, loc: back.headers.get('location') });

  // ── 24.6-W merchant / courier responsibility disputes
  const R = await reg('resp');
  const rq = (await q(R.T)).json;
  const ord = (await call('POST', '/orders', { quoteId: rq.id, paymentMethodId: 'mock_pm_4242' }, R.T, idem())).json;
  const inc = (await call('POST', '/incidents', { orderId: ord.id, category: 'MISSING_ITEM', description: 'Smoke: one lemonade missing' }, R.T)).json;
  const res = await call('POST', `/incidents/${inc.id}/resolve`, { owner: 'MERCHANT', remedy: 'NONE', note: 'Smoke: merchant packed the bag' }, A);
  check('24.6-W setup: a merchant-owned ticket is resolved', inc.id && res.status < 300, res.json);
  const list = (await call('GET', '/me/responsibility-tickets', undefined, O)).json;
  const mineT = Array.isArray(list) && list.find((t) => t.id === inc.id);
  check('24.6-W the merchant owner sees tickets charged to the business', mineT && mineT.role === 'MERCHANT' && mineT.organizationId === demoOrgId && mineT.canDispute === true && mineT.dispute === null, mineT || list);
  check('24.6-W the list carries no customer contact details', mineT && !('description' in mineT) && !JSON.stringify(mineT).includes(R.email), mineT);
  const custList = (await call('GET', '/me/responsibility-tickets', undefined, C)).json;
  check('24.6-W customers see no responsibility tickets of others', Array.isArray(custList) && !custList.some((t) => t.id === inc.id), custList);
  const byCustomer = await call('POST', `/incidents/${inc.id}/dispute-responsibility`, { reason: 'I am not the merchant at all' }, R.T);
  check('24.6-W only the party held responsible can dispute', byCustomer.status === 403, byCustomer.json);
  const disp = await call('POST', `/incidents/${inc.id}/dispute-responsibility`, { reason: 'Smoke: courier confirmed the bag was sealed and complete' }, O);
  check('24.6-W the merchant disputes responsibility', disp.status === 201 && disp.json.status === 'APPEALED', disp.json);
  const again = await call('POST', `/incidents/${inc.id}/dispute-responsibility`, { reason: 'Smoke: second try' }, O);
  check('24.6-W a ticket can only be disputed once at a time', again.status === 400, again.json);
  const after = (await call('GET', '/me/responsibility-tickets', undefined, O)).json.find((t) => t.id === inc.id);
  check('24.6-W the dispute shows as under review', after && after.dispute?.status === 'OPEN' && after.canDispute === false, after);
  const decided = await call('POST', `/incidents/${inc.id}/responsibility-decision`, { reverse: false, note: 'Smoke: packing photo shows one drink' }, A);
  const reopen = await call('POST', `/incidents/${inc.id}/dispute-responsibility`, { reason: 'Smoke: but really' }, O);
  const final = (await call('GET', '/me/responsibility-tickets', undefined, O)).json.find((t) => t.id === inc.id);
  check('24.6-W after the decision the merchant sees the outcome and cannot re-open it', decided.status === 201 && reopen.status === 400 && final?.dispute?.status === 'UPHELD' && final?.dispute?.note, { decided: decided.status, reopen: reopen.json, final });
  const drv = await call('POST', '/auth/login', { email: 'driver@demo.gutad.io', password: 'driver12345' });
  if (drv.json?.accessToken) {
    const dl = await call('GET', '/me/responsibility-tickets', undefined, drv.json.accessToken);
    check('24.6-W couriers get their own list (no merchant tickets)', dl.status === 200 && Array.isArray(dl.json) && !dl.json.some((t) => t.id === inc.id) && dl.json.every((t) => t.role === 'DRIVER'), dl.json);
    const drvDisp = await call('POST', `/incidents/${inc.id}/dispute-responsibility`, { reason: 'Smoke: courier trying a merchant ticket' }, drv.json.accessToken);
    check('24.6-W a courier cannot dispute a ticket not charged to them', drvDisp.status === 403 || drvDisp.status === 400, drvDisp.json);
  }

  // ── 2.4c-M mobile SSO endpoints (no identity provider configured in the demo)
  const ssoCfg = (await call('GET', '/auth/sso/config')).json;
  const ret = (await call('GET', '/auth/sso/return?state=nope')).json;
  check('2.4c-M unknown SSO state has no app return link', ret.returnTo === null, ret);
  if (!ssoCfg.enabled) {
    const st = await call('POST', '/auth/sso/start', { returnTo: 'gutad://auth/sso' });
    check('2.4c-M mobile SSO start is refused while SSO is off', st.status === 400, st.json);
  }
  const badCb = await call('POST', '/auth/sso/callback', { code: 'x', state: 'nope', verifier: 'v' });
  check('2.4c-M an SSO callback with an unknown state is refused', badCb.status === 400 || badCb.status === 401, badCb.json);
}
