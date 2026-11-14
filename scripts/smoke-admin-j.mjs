// Admin platform, phase J checks: offers (eligibility, stacking, funding), referrals, challenges,
// membership trials and failed-payment recovery, gift cards (tender, refunds, liability, fraud), campaign holdouts.
export async function adminPhaseJ({ call, check, A, O, C, locId, demoOrgId }) {
  console.log('\n── Admin platform J: growth');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const days = (d) => new Date(Date.now() + d * 86400_000).toISOString();
  const reg = async (tag) => { const email = `j-${tag}-${stamp}@example.com`; const r = (await call('POST', '/auth/register', { email, password: 'custpass12345', name: `J ${tag} Tester` })).json; return { T: r.accessToken, id: r.user?.id, email }; };
  const cats = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories);
  const items = cats.flatMap((c) => c.items);
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const burger = items.find((i) => i.name === 'Bistro burger');
  const done = burger.modifierGroups.find((g) => g.name === 'Doneness').options[0].id;
  const L = lemonade.priceCents;
  const two = [{ menuItemId: lemonade.id, quantity: 2 }];
  const q = (T, extra = {}, lines = two) => call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines, ...extra }, T);
  const place = async (T, extra = {}, lines = two, card = 'mock_pm_4242') => { const qq = (await q(T, extra, lines)).json; const o = await call('POST', '/orders', { quoteId: qq.id, paymentMethodId: card }, T, idem()); return { quote: qq, order: o.json, status: o.status }; };
  const complete = async (o) => { await call('POST', `/orders/${o.id}/accept`, {}, O); await call('POST', `/orders/${o.id}/ready`, {}, O); return (await call('POST', `/orders/${o.id}/handoff`, { pickupCode: o.pickupCode }, O)).json; };
  const offerBody = (x) => ({ kind: 'FIXED', value: 100, ...x });
  const created = [];

  // ── 25.1 / 25.2 / 25.3 automatic offers, eligibility and stacking
  const today = new Date().getDay();
  const A1 = (await call('POST', '/admin/offers', offerBody({ name: `Smoke $2 off lemonade ${stamp}`, automatic: true, kind: 'FIXED', value: 200, funder: 'PLATFORM', itemIds: [lemonade.id], locationIds: [locId], stacking: 'STACKABLE', priority: 5 }), A)).json;
  const B1 = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ name: `Smoke 10% ${stamp}`, automatic: true, kind: 'PERCENT', value: 1000, locationIds: [locId], stacking: 'STACKABLE', priority: 1 }), O)).json;
  const X1 = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ name: `Smoke other-day 60% ${stamp}`, automatic: true, kind: 'PERCENT', value: 6000, locationIds: [locId], daysOfWeek: [(today + 3) % 7] }), O)).json;
  const F1 = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ name: `Smoke first order 50% ${stamp}`, automatic: true, kind: 'PERCENT', value: 5000, locationIds: [locId], firstOrderOnly: true }), O)).json;
  created.push({ org: null, o: A1 }, { org: demoOrgId, o: B1 }, { org: demoOrgId, o: X1 }, { org: demoOrgId, o: F1 });
  check('offers created: Gutad-wide by staff, merchant offers by the owner', A1.id && B1.id && X1.id && F1.id && A1.automatic && A1.organizationId === null && B1.organizationId === demoOrgId, { A1, B1 });
  const fundBlocked = await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ name: 'Sneaky', funder: 'PLATFORM' }), O);
  check('merchants cannot make Gutad fund their offer', fundBlocked.status === 403, fundBlocked.json);
  const pub = (await call('GET', `/public/locations/${locId}/offers`)).json;
  check('restaurant page lists its automatic offers', pub.some((o) => o.id === B1.id) && pub.some((o) => o.id === A1.id && o.gutadFunded), pub.map((o) => o.name));

  const qc = (await q(C)).json;
  const ids = (qq) => (qq.promotions || []).map((p) => p.promotionId).sort();
  const expStack = 200 + Math.round(2 * L * 0.1);
  check('regular customer: stackable offers combine; other-day and first-order offers are skipped', JSON.stringify(ids(qc)) === JSON.stringify([A1.id, B1.id].sort()) && qc.discountCents === expStack && qc.paymentMix?.cardCents === qc.totalCents, { promos: qc.promotions, d: qc.discountCents, expStack });
  const N1 = await reg('newbie');
  const qn = (await q(N1.T)).json;
  check('new customer gets the better deal: exclusive first-order offer beats the stack', ids(qn).length === 1 && ids(qn)[0] === F1.id && qn.discountCents === L, { promos: qn.promotions, d: qn.discountCents });

  const S1 = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ code: `STACK${stamp % 100000}`, kind: 'FIXED', value: 100, stacking: 'STACKABLE', perUserLimit: 5 }), O)).json;
  const E1 = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ code: `ALONE${stamp % 100000}`, kind: 'FIXED', value: 150, stacking: 'EXCLUSIVE', perUserLimit: 5 }), O)).json;
  created.push({ org: demoOrgId, o: S1 }, { org: demoOrgId, o: E1 });
  const qs = (await q(C, { promoCode: S1.code })).json;
  const qe = (await q(C, { promoCode: E1.code })).json;
  check('a stackable code combines with automatic offers; an exclusive code stands alone with a note', ids(qs).length === 3 && qs.discountCents === expStack + 100 && ids(qe).length === 1 && qe.discountCents === 150 && qe.warnings.some((w) => /replaces automatic/i.test(w)), { s: qs.discountCents, e: qe.discountCents, w: qe.warnings });

  const seg = (await call('POST', '/admin/segments', { name: `Smoke whales ${stamp}`, rules: { minOrders: 10000 } }, A)).json;
  const SEG = (await call('POST', '/admin/offers', offerBody({ code: `VIP${stamp % 100000}`, kind: 'FIXED', value: 300, segmentId: seg.id, locationIds: [locId] }), A)).json;
  const CAT = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ code: `MAINS${stamp % 100000}`, kind: 'PERCENT', value: 2000, categoryIds: [cats.find((c) => c.items.some((i) => i.id === burger.id)).id] }), O)).json;
  created.push({ org: null, o: SEG }, { org: demoOrgId, o: CAT });
  const segQ = await q(C, { promoCode: SEG.code });
  const catQ = await q(C, { promoCode: CAT.code });
  check('eligibility: segment and item/category rules explain why a code does not apply', segQ.status === 400 && /not available on this account/i.test(segQ.json.message) && catQ.status === 400 && /not in your cart/i.test(catQ.json.message), { seg: segQ.json.message, cat: catQ.json.message });

  // ── 25.4 funding split and promotion cost report
  const p1 = await place(C);
  await call('POST', `/orders/${p1.order.id}/accept`, {}, O);
  const rep = (await call('GET', '/admin/promotions/report?days=1', undefined, A)).json;
  const ra = rep.items.find((i) => i.id === A1.id), rb = rep.items.find((i) => i.id === B1.id);
  check('promotion cost report splits who funded each discount', ra?.platformFundedCents === 200 && ra.merchantFundedCents === 0 && rb?.merchantFundedCents === Math.round(2 * L * 0.1) && rb.platformFundedCents === 0 && rep.totals.discountCents >= expStack, { ra, rb });
  const orgRep = (await call('GET', `/organizations/${demoOrgId}/promotions/report?days=1`, undefined, O)).json;
  check('merchants see the cost of promotions at their restaurants', orgRep.items.some((i) => i.id === B1.id) && orgRep.ledgerPromotionExpenseCents === null, orgRep.totals);
  // automatic offers off for the rest of the run (they would change later totals)
  for (const c of created.filter((x) => x.o.automatic)) await call(c.org ? 'PATCH' : 'PATCH', c.org ? `/organizations/${c.org}/offers/${c.o.id}` : `/admin/offers/${c.o.id}`, { kind: c.o.kind, value: c.o.value, funder: c.o.funder, automatic: true, isActive: false, locationIds: c.o.locationIds, itemIds: c.o.itemIds }, c.org ? O : A);
  const after = (await q(C)).json;
  check('switched-off offers stop applying', !(after.promotions || []).length && after.discountCents === 0, after.promotions);

  // ── 25.5 referrals: reward after the first completed order; shared card goes to review
  const R = await reg('referrer');
  const E = await reg('referee');
  const code = (await call('GET', '/me/referral', undefined, R.T)).json.code;
  const ap = (await call('POST', '/me/referral', { code }, E.T)).json;
  const ptsBefore = (await call('GET', '/me/loyalty', undefined, E.T)).json.points;
  check('referral code accepted but nothing paid before an order', ap.status === 'PENDING' && ptsBefore === 0, { ap, ptsBefore });
  const notNew = await call('POST', '/me/referral', { code }, C);
  check('existing customers cannot use a referral code', notNew.status === 400 && notNew.json.code === 'REFERRAL_NOT_NEW', notNew.json);
  const eo = await place(E.T);
  await complete(eo.order);
  const rRef = (await call('GET', '/me/referral', undefined, R.T)).json;
  const ePts = (await call('GET', '/me/loyalty', undefined, E.T)).json.points, rPts = (await call('GET', '/me/loyalty', undefined, R.T)).json.points;
  check('both sides rewarded after the referee’s first completed order', rRef.referred[0]?.status === 'REWARDED' && rPts === 500 && ePts >= 500, { rPts, ePts, ref: rRef.referred });
  const R2 = await reg('referrer2');
  const E2 = await reg('referee2');
  const shared = `mock_pm_smk${stamp}`;
  await call('POST', '/me/payment-methods', { paymentMethodId: shared, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }, R2.T);
  await call('POST', '/me/payment-methods', { paymentMethodId: shared, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }, E2.T);
  await call('POST', '/me/referral', { code: (await call('GET', '/me/referral', undefined, R2.T)).json.code }, E2.T);
  const e2o = await place(E2.T);
  await complete(e2o.order);
  const queue = (await call('GET', '/admin/referrals', undefined, A)).json;
  const flagged = queue.items.find((x) => x.referee_id === E2.id);
  const r2Pts = (await call('GET', '/me/loyalty', undefined, R2.T)).json.points;
  check('same card on both accounts: referral held for review, no points yet', flagged?.status === 'REVIEW' && flagged.signals.some((s) => s.kind === 'PAYMENT') && r2Pts === 0, { flagged, r2Pts });
  await call('POST', `/admin/referrals/${flagged.id}/decision`, { approve: true, note: 'Household, verified' }, A);
  check('approved after review: points paid', (await call('GET', '/me/loyalty', undefined, R2.T)).json.points === 500);

  // ── 25.6 reward challenge
  const ch = (await call('POST', '/admin/challenges', { name: `Smoke 2 in 7 ${stamp}`, goalOrders: 2, windowDays: 7, rewardCents: 300, rewardExpiresDays: 10, locationIds: [locId] }, A)).json;
  const H = await reg('challenger');
  const c0 = (await call('GET', '/me/challenges', undefined, H.T)).json.active.find((x) => x.id === ch.id);
  const h1 = await place(H.T);
  await complete(h1.order);
  const c1 = (await call('GET', '/me/challenges', undefined, H.T)).json.active.find((x) => x.id === ch.id);
  const h2 = await place(H.T);
  await complete(h2.order);
  const me2 = (await call('GET', '/me/challenges', undefined, H.T)).json;
  const credits = (await call('GET', '/me/loyalty', undefined, H.T)).json.credits;
  check('challenge progress counts qualifying orders and pays expiring credit at the goal', c0?.progress === 0 && c1?.progress === 1 && me2.history.some((x) => x.status === 'COMPLETED') && credits.availableCents === 300, { c0: c0?.progress, c1: c1?.progress, hist: me2.history, credits });
  await call('POST', '/admin/challenges', { id: ch.id, name: ch.name, goalOrders: 2, windowDays: 7, rewardCents: 300, isActive: false }, A);

  // ── 25.7 / 25.8 memberships: trial, cancel at period end, failed renewals with retries and card update
  const plan = (await call('GET', '/public/membership/plans')).json.find((p) => p.trialDays > 0);
  const M = await reg('member'), D = await reg('dunning'), D2 = await reg('suspend');
  const noCard = await call('POST', '/me/membership', { planId: plan.id }, M.T);
  const tr = (await call('POST', '/me/membership', { planId: plan.id, paymentMethodId: 'mock_pm_4242' }, M.T)).json;
  await call('POST', '/me/membership', { planId: plan.id, paymentMethodId: 'mock_pm_0002' }, D.T);
  await call('POST', '/me/membership', { planId: plan.id, paymentMethodId: 'mock_pm_0002' }, D2.T);
  const mm = (await call('GET', '/me/loyalty', undefined, M.T)).json.membership;
  check('free trial needs a card, charges nothing and gives benefits now', noCard.status === 400 && noCard.json.code === 'CARD_REQUIRED' && tr.trial === true && !tr.paymentId && mm?.status === 'TRIALING' && mm.benefitsActive, { noCard: noCard.json, mm });
  const canc = (await call('POST', '/me/membership/cancel', {}, M.T)).json;
  const stillOn = (await call('GET', '/me/loyalty', undefined, M.T)).json.membership;
  const res = (await call('POST', '/me/membership/resume', {}, M.T)).json;
  check('cancel keeps benefits until the period ends, and can be undone', canc.cancelAtPeriodEnd && stillOn.benefitsActive && stillOn.cancelAtPeriodEnd && res.ok, { canc, stillOn });
  const job = (at) => call('POST', '/admin/jobs/growth', { at }, A);
  const j1 = (await job(days(8))).json;
  const mAfter = (await call('GET', '/me/loyalty', undefined, M.T)).json.membership;
  const dAfter = (await call('GET', '/me/loyalty', undefined, D.T)).json.membership;
  check('trial converts to a paid membership at the end of the trial', j1.memberships?.renewed >= 1 && mAfter.status === 'ACTIVE' && new Date(mAfter.currentPeriodEnd) > new Date(days(30)), { j1, mAfter: mAfter?.status });
  check('failed renewal: past due with a scheduled retry and benefits during grace', dAfter.status === 'PAST_DUE' && dAfter.renewalFailures === 1 && dAfter.nextRetryAt && dAfter.benefitsActive && dAfter.graceUntil, dAfter);
  await job(days(8.5));
  const dSame = (await call('GET', '/me/loyalty', undefined, D.T)).json.membership;
  await job(days(9.1));
  const dRetry = (await call('GET', '/me/loyalty', undefined, D.T)).json.membership;
  check('retries follow the backoff schedule', dSame.renewalFailures === 1 && dRetry.renewalFailures === 2, { same: dSame.renewalFailures, retry: dRetry.renewalFailures });
  const fix = (await call('POST', '/me/membership/payment-method', { paymentMethodId: 'mock_pm_4242' }, D.T)).json;
  const dFixed = (await call('GET', '/me/loyalty', undefined, D.T)).json.membership;
  check('updating the card retries at once and recovers the membership', fix.ok && fix.status === 'ACTIVE' && dFixed.status === 'ACTIVE' && dFixed.renewalFailures === 0, { fix, dFixed: dFixed?.status });
  await job(days(12.2));
  await job(days(17.3));
  const d2 = (await call('GET', '/me/loyalty', undefined, D2.T)).json.membership;
  check('after the last retry the membership is suspended and benefits stop', d2?.status === 'SUSPENDED' && !d2.benefitsActive, d2);
  await call('POST', '/me/membership/cancel', {}, M.T);
  await job(days(45));
  const mEnd = (await call('GET', '/me/loyalty', undefined, M.T)).json.membership;
  const adm = (await call('GET', '/admin/memberships', undefined, A)).json;
  check('cancel at period end ends it at renewal without a charge; admin sees recovery and suspensions', mEnd === null && adm.stats.recovered30d >= 1 && adm.items.some((x) => x.userId === D2.id && x.status === 'SUSPENDED'), { mEnd, stats: adm.stats });

  // ── 25.9 gift cards: purchase, claim, tender, refunds, liability, fraud controls
  const G = await reg('gifter'), W = await reg('giftee'), W2 = await reg('giftee2'), X = await reg('guesser');
  const g1 = (await call('POST', '/me/gift-cards', { amountCents: 2500, recipientEmail: W.email, recipientName: 'Wendy', message: 'Enjoy!', paymentMethodId: 'mock_pm_4242' }, G.T)).json;
  const claim = (await call('POST', '/me/gift-cards/claim', { code: g1.code }, W.T)).json;
  const reclaim = await call('POST', '/me/gift-cards/claim', { code: g1.code }, W2.T);
  check('gift card bought, emailed and added to the recipient’s wallet once', g1.status === 'ACTIVE' && claim.walletCents === 2500 && reclaim.status === 400 && reclaim.json.code === 'GIFT_CARD_CLAIMED', { g1, claim, reclaim: reclaim.json });
  await call('POST', '/me/gift-cards', { amountCents: 500, paymentMethodId: 'mock_pm_4242' }, G.T);
  await call('POST', '/me/gift-cards', { amountCents: 500, paymentMethodId: 'mock_pm_4242' }, G.T);
  const vel = await call('POST', '/me/gift-cards', { amountCents: 500, paymentMethodId: 'mock_pm_4242' }, G.T);
  check('purchase velocity limit per buyer', vel.status === 429 && vel.json.code === 'GIFT_CARD_VELOCITY', vel.json);
  let lastGuess;
  for (let i = 0; i < 6; i++) lastGuess = await call('POST', '/me/gift-cards/claim', { code: `GCNOPE-${i}-${stamp}` }, X.T);
  check('repeated wrong codes lock the customer out of gift cards for an hour', lastGuess.status === 429 && lastGuess.json.code === 'GIFT_CARD_ATTEMPTS', lastGuess.json);
  const G2 = await reg('biggifter');
  const big = (await call('POST', '/me/gift-cards', { amountCents: 30000, recipientEmail: W2.email, paymentMethodId: 'mock_pm_4242' }, G2.T)).json;
  const pendClaim = await call('POST', '/me/gift-cards/claim', { code: big.code }, W2.T);
  const appr = (await call('POST', `/admin/gift-cards/${big.id}/action`, { action: 'APPROVE', reason: 'Buyer verified' }, A)).json;
  const w2c = (await call('POST', '/me/gift-cards/claim', { code: big.code }, W2.T)).json;
  check('large purchased cards wait for review before they can be used', big.status === 'PENDING_REVIEW' && pendClaim.json.code === 'GIFT_CARD_PENDING' && appr.status === 'ACTIVE' && w2c.walletCents === 30000, { big: big.status, pend: pendClaim.json.code, appr: appr.status });

  // 11.6 payment mix and 18.3-G recorded split
  const burgerLines = [{ menuItemId: burger.id, quantity: 1, modifierOptionIds: [done] }, { menuItemId: lemonade.id, quantity: 1 }];
  const gq = (await q(W.T, { useGiftBalance: true }, burgerLines)).json;
  const gross = gq.totalCents + gq.giftCents + (gq.creditsCents || 0) + (gq.loyaltyCents || 0);
  check('payment mix: gift balance first, the card pays the rest', gq.giftCents === 2500 && gq.paymentMix.giftCents === 2500 && gq.paymentMix.cardCents === gq.totalCents && gq.totalCents > 0 && gross === gq.subtotalCents - gq.discountCents + gq.taxCents + gq.serviceFeeCents + gq.deliveryFeeCents + gq.tipCents + (gq.smallOrderFeeCents || 0) + (gq.packagingFeeCents || 0), gq.paymentMix);
  const go = (await call('POST', '/orders', { quoteId: gq.id, paymentMethodId: 'mock_pm_4242' }, W.T, idem())).json;
  await call('POST', `/orders/${go.id}/accept`, {}, O);
  const gp = (await call('GET', `/orders/${go.id}/payment`, undefined, A)).json.payment;
  const wal = (await call('GET', '/me/gift-cards', undefined, W.T)).json;
  check('order records the gift share in its payment split and spends the wallet', gp.split?.giftCents === 2500 && gp.split.cardCents === gq.totalCents && wal.balanceCents === 0 && wal.activity.some((a) => a.kind === 'REDEEM' && a.cents === -2500), { split: gp.split, bal: wal.balanceCents });
  const refundAmt = 1000;
  const rf = (await call('POST', `/admin/payments/${gp.id}/refund`, { amountCents: refundAmt, reason: 'Smoke partial refund', funder: 'MERCHANT' }, A)).json;
  const expGift = Math.round((refundAmt * 2500) / (2500 + gq.totalCents));
  const walAfter = (await call('GET', '/me/gift-cards', undefined, W.T)).json.balanceCents;
  check('partial refund goes back to card and gift card in proportion', rf.toGiftCents === expGift && rf.toCardCents === refundAmt - expGift && walAfter === expGift, { rf, expGift, walAfter });
  // a fully gift-paid order canceled before acceptance gives the balance back
  const fq = (await q(W2.T, { useGiftBalance: true })).json;
  const fo = (await call('POST', '/orders', { quoteId: fq.id }, W2.T, idem())).json;
  const midW2 = (await call('GET', '/me/gift-cards', undefined, W2.T)).json.balanceCents;
  await call('POST', `/orders/${fo.id}/cancel`, { reason: 'changed my mind' }, W2.T);
  const backW2 = (await call('GET', '/me/gift-cards', undefined, W2.T)).json.balanceCents;
  check('gift-only order: no card needed; canceling restores the balance', fq.totalCents === 0 && fq.giftCents > 0 && midW2 === 30000 - fq.giftCents && backW2 === 30000, { total: fq.totalCents, gift: fq.giftCents, midW2, backW2 });
  const fo2 = (await call('POST', '/orders', { quoteId: (await q(W2.T, { useGiftBalance: true })).json.id }, W2.T, idem())).json;
  await call('POST', `/orders/${fo2.id}/accept`, {}, O);
  // fraud lock and void; promotional issue
  const lock = (await call('POST', `/admin/gift-cards/${big.id}/action`, { action: 'LOCK', reason: 'Chargeback on the purchase' }, A)).json;
  const lockedQ = (await q(W2.T, { useGiftBalance: true })).json;
  const voided = (await call('POST', `/admin/gift-cards/${big.id}/action`, { action: 'VOID', reason: 'Chargeback lost' }, A)).json;
  const promo = (await call('POST', '/admin/gift-cards', { amountCents: 1000, count: 2, reason: 'Smoke apology cards' }, A)).json;
  check('locked cards cannot be spent; void zeroes the balance; promotional cards are issued', lock.status === 'LOCKED' && !lockedQ.giftCents && voided.status === 'VOID' && voided.balanceCents === 0 && promo.length === 2 && promo[0].code, { lock: lock.status, gift: lockedQ.giftCents, voided: voided.status });
  const liab = (await call('GET', '/admin/gift-cards/liability', undefined, A)).json;
  const credLiab = (await call('GET', '/accounting/credit-liability', undefined, A)).json;
  const fin = (await call('GET', '/finance/liabilities', undefined, A)).json;
  check('gift-card liability: ledger matches outstanding balances, shown in the liability reports', liab.ledgerLiabilityCents === liab.outstandingCents && liab.outstandingCents > 0 && credLiab.giftCards?.outstandingCents === liab.outstandingCents && fin.liabilities.some((l) => l.account === 'GIFT_CARD_LIABILITY' && l.balanceCents === liab.ledgerLiabilityCents), { ledger: liab.ledgerLiabilityCents, out: liab.outstandingCents, fin: fin.liabilities.find((l) => l.account === 'GIFT_CARD_LIABILITY') });
  const gl = (await call('GET', '/admin/gift-cards', undefined, A)).json;
  check('admin gift-card list shows velocity watch and lockouts', gl.cards.length >= 5 && gl.velocity.some((v) => v.userId === G.id) && gl.blocked.some((b) => b.action === 'giftcard.velocity_block'), { velocity: gl.velocity, blocked: gl.blocked?.length });

  // ── 25.10 campaign holdout and incremental orders
  const camp = (await call('POST', `/organizations/${demoOrgId}/campaigns`, { name: `Smoke holdout ${stamp}`, kind: 'COUPON', holdoutPct: 50, endsAt: days(7) }, O)).json;
  const off = (await call('POST', `/organizations/${demoOrgId}/offers`, offerBody({ name: `Smoke campaign 5% ${stamp}`, automatic: true, kind: 'PERCENT', value: 500, locationIds: [locId], stacking: 'STACKABLE', campaignId: camp.id }), O)).json;
  let withOffer = 0;
  for (let i = 0; i < 10; i++) {
    const u = await reg(`cohort${i}`);
    const r = await place(u.T);
    if ((r.quote.promotions || []).some((p) => p.promotionId === off.id)) withOffer++;
    if (r.order?.id) await call('POST', `/orders/${r.order.id}/accept`, {}, O);
  }
  const results = (await call('GET', `/campaigns/${camp.id}/results`, undefined, O)).json;
  const t = results.groups?.treatment, h = results.groups?.holdout;
  check('holdout group never sees the campaign offer; groups are recorded', t && h && t.users + h.users === 10 && withOffer === t.users && t.orders + h.orders === 10, { t, h, withOffer });
  check('campaign results: incremental orders, promotion cost and profit against the holdout', results.promotionCostCents === t.users * Math.round(2 * L * 0.05) && (h.users ? results.incrementalOrders === 0 && typeof results.profitCents === 'number' : results.incrementalOrders === null), { inc: results.incrementalOrders, cost: results.promotionCostCents, profit: results.profitCents });
  await call('PATCH', `/organizations/${demoOrgId}/offers/${off.id}`, { kind: 'PERCENT', value: 500, automatic: true, isActive: false }, O);

  // ── overview for the console and the phone
  const ov = (await call('GET', '/admin/growth/overview', undefined, A)).json;
  check('growth overview: promotion cost, gift liability, referral reviews, past-due memberships', ov.promotions?.discountCents > 0 && ov.giftCards?.outstandingCents > 0 && 'review' in ov.referrals && 'past_due' in ov.memberships, Object.keys(ov));
}
