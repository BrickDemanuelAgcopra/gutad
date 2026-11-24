// Gutad first-party selling: Gutad's own organization (kind PLATFORM) sells next to merchants. Setup, plan and
// onboarding exemption, seller-of-record money path (no commission, no merchant payable, no payout), labels, seller
// filter, ranking policy (neutral / boost / pinned / cap / excluded), versioning, kill switch, preview, report,
// operators with the data-separation conflict check, public policy page.
export async function firstPartyPhase({ call, check, A, O, C }) {
  console.log('\n── Gutad first-party');
  const stamp = Date.now().toString(36);
  const reason = 'Smoke first-party';
  const shared = await import('../packages/shared/dist/index.js');

  // ── pure ranking rules
  const R = (over) => ({ ...shared.DEFAULT_FIRST_PARTY_POLICY, ...over });
  const mk = (ids, fp = [], sp = []) => ids.map((id) => ({ id, firstParty: fp.includes(id), sponsored: sp.includes(id) }));
  const ids = (r) => r.items.map((i) => i.id).join('');
  check('ranking: neutral keeps the order', ids(shared.applyFirstPartyRanking(mk(['a', 'b', 'c', 'G']), R({ ranking: 'NEUTRAL', maxFirstPageSharePct: 100 }), 20)) === 'abcG');
  check('ranking: boost moves up N places, never above sponsored', ids(shared.applyFirstPartyRanking(mk(['s', 'a', 'b', 'c', 'G'], ['G'], ['s']), R({ ranking: 'BOOST', boostPositions: 2, maxFirstPageSharePct: 100 }), 20)) === 'saGbc' && ids(shared.applyFirstPartyRanking(mk(['s', 'a', 'G'], ['G'], ['s']), R({ ranking: 'BOOST', boostPositions: 9, maxFirstPageSharePct: 100 }), 20)) === 'sGa');
  check('ranking: pinned to organic slot after sponsored', ids(shared.applyFirstPartyRanking(mk(['s', 'a', 'b', 'c', 'G'], ['G'], ['s']), R({ ranking: 'PINNED', pinSlots: [2], maxFirstPageSharePct: 100 }), 20)) === 'saGbc');
  const capped = shared.applyFirstPartyRanking(mk(['G', 'H', 'a', 'b', 'c', 'd'], ['G', 'H']), R({ ranking: 'NEUTRAL', maxFirstPageSharePct: 25 }), 4);
  check('ranking: first-page share cap demotes extra Gutad results to page two', ids(capped) === 'GabcHd' && capped.why.size === 1, ids(capped));
  check('ranking: excluded or off removes Gutad results', ids(shared.applyFirstPartyRanking(mk(['a', 'G']), R({ ranking: 'EXCLUDED' }), 20)) === 'a' && ids(shared.applyFirstPartyRanking(mk(['a', 'G']), R({ enabled: false }), 20)) === 'a');
  check('rules: city overrides apply on top', shared.firstPartyRulesFor(R({ cities: { 'new york': { ranking: 'BOOST' } } }), 'New York ').ranking === 'BOOST' && shared.firstPartyRulesFor(R({}), 'Boston').ranking === 'NEUTRAL');

  // ── setup
  const before = (await call('GET', '/admin/first-party', undefined, A)).json;
  const setup = await call('POST', '/admin/first-party/setup', { name: 'Gutad', legalName: 'Gutad LLC' }, A);
  check('setup creates the Gutad organization (kind PLATFORM)', setup.status < 300 && setup.json.kind === 'PLATFORM', setup.json);
  const again = (await call('POST', '/admin/first-party/setup', {}, A)).json;
  check('setup is idempotent', again.id === setup.json.id);
  check('customers cannot reach first-party admin', (await call('GET', '/admin/first-party', undefined, C)).status === 403);
  check('merchant owners cannot reach first-party admin', (await call('POST', '/admin/first-party/setup', {}, O)).status === 403);
  const orgId = setup.json.id;
  check('onboarding needs no Merchant Agreement or Order Form for Gutad', ((await call('GET', `/organizations/${orgId}/onboarding`, undefined, A)).json.blockers || []).length === 0);

  // ── location, brand, menu, launch
  const loc = (await call('POST', '/admin/first-party/locations', { name: `Gutad Test Kitchen ${stamp}`, cuisine: ['bowls'], addressLine1: '410 W 14th St', city: 'New York', region: 'NY', postalCode: '10014', lat: 40.7417, lng: -74.0063, acceptsPickup: true, acceptsDelivery: false }, A)).json;
  check('first-party location created under Gutad', loc.id && loc.organizationId === orgId && loc.deliveryFleet === 'PLATFORM', loc);
  const brand = (await call('POST', '/admin/first-party/brands', { name: `Gutad Greens ${stamp}`, description: 'Smoke brand' }, A)).json;
  check('first-party brand is company-owned', brand.ownershipType === 'COMPANY_OWNED', brand);
  const ent = (await call('GET', `/locations/${loc.id}/entitlements`, undefined, A)).json;
  check('Gutad is exempt from merchant plans (unrestricted)', ent.unrestricted === true && ent.planCode === 'GUTAD_FIRST_PARTY', ent);
  await call('PATCH', `/locations/${loc.id}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opens: '00:00', closes: '23:59' })) }, A);
  const menu = (await call('POST', `/locations/${loc.id}/menus`, { name: 'Main' }, A)).json;
  const cat = (await call('POST', `/menus/${menu.id}/categories`, { name: 'Bowls' }, A)).json;
  const item = (await call('POST', `/categories/${cat.id}/items`, { name: 'Gutad bowl', priceCents: 1500 }, A)).json;
  check('menu built by staff in the same editor merchants use', item.id && item.priceCents === 1500, item);
  check('verify needs no onboarding documents', (await call('POST', `/locations/${loc.id}/verify`, { verified: true }, A)).json.status === 'VERIFIED');
  const settings = (await call('GET', '/admin/settings', undefined, A)).json.settings ?? {};
  const prevReadiness = settings['launch.require_readiness'];
  await call('POST', '/admin/settings', { key: 'launch.require_readiness', value: false, reason }, A);
  const live = (await call('POST', `/locations/${loc.id}/status`, { status: 'LIVE' }, A)).json;
  await call('POST', '/admin/settings', { key: 'launch.require_readiness', value: prevReadiness ?? true, reason }, A);
  check('first-party location goes live', live.status === 'LIVE', live);

  // ── policy: start from a known neutral version
  const pol0 = (await call('GET', '/admin/first-party/policy', undefined, A)).json;
  const prevPolicy = (({ version, ...p }) => p)(pol0.current);
  const neutral = { ...shared.DEFAULT_FIRST_PARTY_POLICY, maxFirstPageSharePct: 100, label: 'Sold by Gutad' };
  const saved = await call('PUT', '/admin/first-party/policy', { policy: neutral, reason }, A);
  check('policy saved as a new version', saved.status < 300 && saved.json.version === (pol0.current.version || 0) + 1, saved.json);
  check('saving the policy needs a reason', (await call('PUT', '/admin/first-party/policy', { policy: neutral }, A)).status === 400 || (await call('PUT', '/admin/first-party/policy', { policy: neutral }, A)).status === 403);
  check('customers cannot change the policy', (await call('PUT', '/admin/first-party/policy', { policy: neutral, reason }, C)).status === 403);

  // ── search, labels, seller filter
  const search = async (extra = '') => (await call('GET', `/public/search?city=New%20York&pageSize=50${extra}`)).json;
  const s1 = await search();
  const mine = s1.items.find((i) => i.id === loc.id);
  check('Gutad location listed with merchants, labelled', mine && mine.firstParty === true && mine.sellerLabel === 'Sold by Gutad' && s1.items.some((i) => !i.firstParty), mine);
  const onlyG = await search('&seller=gutad');
  check('seller filter: Gutad only', onlyG.items.length >= 1 && onlyG.items.every((i) => i.firstParty));
  const onlyM = await search('&seller=merchants');
  check('seller filter: restaurants only', onlyM.items.length >= 1 && onlyM.items.every((i) => !i.firstParty));
  const page = (await call('GET', `/public/locations/${loc.slug}`)).json;
  check('location page carries the seller label', page.firstParty === true && page.sellerLabel === 'Sold by Gutad', { firstParty: page.firstParty, label: page.sellerLabel });

  // ── money: seller of record
  const q = (await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: item.id, quantity: 2 }], tipCents: 200 }, C)).json;
  check('quote: no commission, seller shown', q.id && q.seller?.firstParty === true && q.seller.label === 'Sold by Gutad', q);
  const order = (await call('POST', '/orders', { quoteId: q.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  check('first-party order placed', order.id && order.commissionCents === 0, { id: order.id, commission: order.commissionCents });
  const acc = (await call('POST', `/orders/${order.id}/accept`, { prepMinutes: 10 }, A)).json;
  check('accept captures on the platform account (no connected account)', acc.payment?.status === 'CAPTURED' && !acc.payment?.destinationAccountId && !acc.payment?.applicationFeeCents, acc.payment);
  const led = (await call('GET', `/finance/ledger?orderId=${order.id}`, undefined, A)).json;
  const acct = (a) => led.entries.filter((e) => e.account === a).reduce((s, e) => s + e.creditCents - e.debitCents, 0);
  check('ledger: food booked as Gutad sales, tax payable, no merchant payable or commission', acct('PLATFORM_REVENUE_FOOD_SALES') === order.subtotalCents - order.discountCents + order.packagingFeeCents + order.tipCents && acct('TAX_PAYABLE') === order.taxCents && !led.entries.some((e) => e.account === 'MERCHANT_PAYABLE' || e.account === 'PLATFORM_REVENUE_COMMISSION'), led.entries.map((e) => [e.account, e.creditCents - e.debitCents]));
  check('ledger: the order batch balances', led.totals.debits === led.totals.credits, led.totals);
  const pay = (await call('GET', `/orders/${order.id}/payments`, undefined, A)).json;
  const pid = (Array.isArray(pay) ? pay[0] : pay?.payments?.[0])?.id || acc.payment?.id;
  if (pid) {
    const rf = await call('POST', `/payments/${pid}/refund`, { amountCents: 100, reason: 'Smoke first-party refund', funder: 'MERCHANT' }, A);
    if (rf.status < 300) {
      const led2 = (await call('GET', `/finance/ledger?orderId=${order.id}`, undefined, A)).json;
      check('refund on a Gutad sale is Gutad’s cost (never a merchant payable)', !led2.entries.some((e) => e.account === 'MERCHANT_PAYABLE') && led2.entries.some((e) => e.account === 'PLATFORM_EXPENSE_REFUND'), led2.entries.map((e) => e.account));
    }
  }
  const close = (await call('POST', '/finance/close-period', { periodStart: new Date(Date.now() - 7 * 86400000).toISOString(), periodEnd: new Date(Date.now() + 60000).toISOString() }, A)).json;
  check('settlement never pays Gutad out to itself', !Array.isArray(close) || !close.some((c) => c.organizationId === orgId), close);

  // ── ranking policy end to end
  const boost = await call('PUT', '/admin/first-party/policy', { policy: { ...neutral, ranking: 'PINNED', pinSlots: [1] }, reason }, A);
  check('pinned policy saved', boost.status < 300);
  const s2 = await search();
  const firstOrganic = s2.items.find((i) => !i.sponsored);
  check('pinned: a Gutad result takes organic position 1', firstOrganic?.firstParty === true, s2.items.slice(0, 3).map((i) => [i.name, i.firstParty, i.sponsored]));
  const pv = (await call('POST', '/admin/first-party/preview', { city: 'New York', policy: { ranking: 'EXCLUDED' } }, A)).json;
  check('preview: draft policy compared with neutral, current policy untouched', pv.neutral?.some((r) => r.firstParty) && pv.withPolicy?.every((r) => !r.firstParty) && (await search()).items.some((i) => i.firstParty), { n: pv.neutral?.length, w: pv.withPolicy?.length });
  const pvWhy = (await call('POST', '/admin/first-party/preview', { city: 'New York' }, A)).json;
  check('preview explains why a result moved', pvWhy.withPolicy?.some((r) => r.firstParty && r.why.some((w) => w.includes('pinned'))), pvWhy.withPolicy?.filter((r) => r.firstParty));
  const cityOff = await call('PUT', '/admin/first-party/policy', { policy: { ...neutral, cities: { boston: { ranking: 'EXCLUDED' } } }, reason }, A);
  check('city override saved', cityOff.status < 300 && (await search()).items.some((i) => i.firstParty));

  // ── kill switch
  const off = await call('POST', '/admin/first-party/policy/kill-switch', { enabled: false, reason }, A);
  check('kill switch: off', off.status < 300 && off.json.policy.enabled === false, off.json);
  check('kill switch: Gutad gone from search', !(await search()).items.some((i) => i.firstParty));
  check('kill switch: location page not found', (await call('GET', `/public/locations/${loc.slug}`)).status === 404);
  const blocked = await call('POST', '/quotes', { locationId: loc.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: item.id, quantity: 1 }] }, C);
  check('kill switch: new orders refused', blocked.status === 400 && blocked.json.code === 'FIRST_PARTY_OFF', blocked.json);
  check('kill switch needs a reason', (await call('POST', '/admin/first-party/policy/kill-switch', { enabled: true }, A)).status >= 400);
  const cityKill = await call('POST', '/admin/first-party/policy/kill-switch', { enabled: true, reason }, A);
  await call('POST', '/admin/first-party/policy/kill-switch', { enabled: false, city: 'New York', reason }, A);
  check('kill switch per city', cityKill.status < 300 && !(await search()).items.some((i) => i.firstParty));
  await call('POST', '/admin/first-party/policy/kill-switch', { enabled: true, city: 'New York', reason }, A);
  check('kill switch: back on', (await search()).items.some((i) => i.firstParty));
  const hist = (await call('GET', '/admin/first-party/policy', undefined, A)).json;
  check('every change is a version with a note', hist.versions.length >= 7 && hist.versions[0].note?.includes('Turned on'), hist.versions.slice(0, 3));
  const restored = await call('POST', `/admin/first-party/policy/versions/${saved.json.version}/restore`, { reason }, A);
  check('restore an earlier version', restored.status < 300 && restored.json.policy.ranking === 'NEUTRAL');

  // ── report
  const rep = (await call('GET', '/admin/first-party/report', undefined, A)).json;
  check('report: Gutad vs merchant sales, margin, shadow commission', rep.firstParty?.orders >= 1 && rep.firstParty.gmvCents > 0 && rep.merchants.gmvCents > 0 && rep.firstParty.shadowCommissionCents === Math.round((rep.firstParty.gmvCents * rep.firstParty.shadowCommissionBps) / 10000) && rep.byLocation.some((l) => l.locationId === loc.id), rep.firstParty);
  check('report is staff-only', (await call('GET', '/admin/first-party/report', undefined, C)).status === 403);

  // ── operators and data separation
  const opEmail = `gutad-kitchen-${stamp}@example.com`;
  const op = await call('POST', '/admin/first-party/operators', { email: opEmail, role: 'MERCHANT_MANAGER' }, A);
  check('operator added as a Gutad-only member', op.status < 300 && op.json.organizationId === orgId, op.json);
  const meA = (await call('GET', '/auth/me', undefined, A)).json;
  const conflict = await call('POST', '/admin/first-party/operators', { email: meA.email, role: 'MERCHANT_MANAGER' }, A);
  check('platform staff cannot also be a first-party operator', conflict.status === 409 && conflict.json.code === 'FIRST_PARTY_CONFLICT', conflict.json);
  check('operators cannot get platform roles', (await call('POST', '/admin/first-party/operators', { email: opEmail, role: 'PLATFORM_ADMIN' }, A)).status === 400);
  const ops = (await call('GET', '/admin/first-party/operators', undefined, A)).json;
  check('operators list with access check', ops.members.some((m) => m.email === opEmail && !m.crossTenantStaff) && ops.conflicts === 0, ops);
  const del = await call('DELETE', `/admin/first-party/operators/${op.json.id}`, undefined, A);
  check('operator removed', del.status < 300);

  // ── public page
  const pub = (await call('GET', '/public/marketplace-policy')).json;
  check('public ranking policy readable without sign-in', pub.label === 'Sold by Gutad' && pub.summary.some((s) => s.includes('same rules')), pub);
  const ov = (await call('GET', '/admin/first-party', undefined, A)).json;
  check('overview lists Gutad locations and brands', ov.org?.id === orgId && ov.locations.some((l) => l.id === loc.id) && ov.brands.some((b) => b.id === brand.id), { had: !!before.org });

  // leave the policy as it was before this phase
  await call('PUT', '/admin/first-party/policy', { policy: prevPolicy, reason: 'Smoke first-party: restore previous policy' }, A);
}
