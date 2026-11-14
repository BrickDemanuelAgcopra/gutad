// Follow-ups: 4.3-T document expiry, 5.1-L staff invite scope, growth follow-ups (25.1-B, 25.7-P, 25.9-E, 25.10-P, 25.10-S).
export async function followupsD({ call, check, A, O, C, locId, demoOrgId, API }) {
  console.log('\n── Follow-ups D: documents, staff invites, growth');
  const stamp = Date.now();
  const days = (d) => new Date(Date.now() + d * 86400_000).toISOString();
  const reg = async (tag) => { const email = `fd-${tag}-${stamp}@example.com`; const r = (await call('POST', '/auth/register', { email, password: 'custpass12345', name: `FD ${tag}` })).json; return { T: r.accessToken, id: r.user?.id, email }; };

  // ── 4.3-T documents past expiry become EXPIRED; soon-expiring ones get one reminder
  const upload = async () => {
    const fd = new FormData();
    fd.append('docType', 'INSURANCE');
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 smoke')], { type: 'application/pdf' }), `ins-${stamp}.pdf`);
    const r = await fetch(`${API}/organizations/${demoOrgId}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${O}` }, body: fd });
    return r.json();
  };
  const d1 = await upload(), d2 = await upload();
  await call('POST', `/documents/${d1.id}/review`, { status: 'APPROVED', expiresAt: new Date(Date.now() - 60_000).toISOString() }, A);
  await call('POST', `/documents/${d2.id}/review`, { status: 'APPROVED', expiresAt: days(10) }, A);
  const run1 = (await call('POST', '/admin/jobs/document-expiry', {}, A)).json;
  const run2 = (await call('POST', '/admin/jobs/document-expiry', {}, A)).json;
  const docs = (await call('GET', `/organizations/${demoOrgId}/documents`, undefined, O)).json;
  check('document expiry: past-due documents expire, soon-expiring ones get one reminder', run1.expired >= 1 && run1.reminded >= 1 && run2.reminded === 0 && docs.find((d) => d.id === d1.id)?.status === 'EXPIRED' && docs.find((d) => d.id === d2.id)?.status === 'APPROVED', { run1, run2 });

  // ── 5.1-L staff invite with locations and an approval limit
  const inviteEmail = `fd-mgr-${stamp}@example.com`;
  await call('POST', `/organizations/${demoOrgId}/members`, { email: inviteEmail, role: 'MERCHANT_MANAGER', locationIds: [locId], approvalLimitCents: 5000 }, A);
  const det = (await call('GET', `/admin/merchants/${demoOrgId}`, undefined, A)).json;
  const mem = det.members?.find((m) => m.email === inviteEmail);
  check('admin invite keeps the location scope and approval limit', mem && mem.locationIds.length === 1 && mem.locationIds[0] === locId && mem.approvalLimitCents === 5000, mem);

  // ── 25.1-B buy-one-get-one and free item
  const cats = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories);
  const items = cats.flatMap((c) => c.items);
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const q = (T, extra, lines) => call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines, ...extra }, T);
  const bogo = (await call('POST', `/organizations/${demoOrgId}/offers`, { code: `BOGO${stamp % 100000}`, kind: 'BOGO', value: 0, buyQty: 1, getQty: 1, itemIds: [lemonade.id], perUserLimit: 5 }, O)).json;
  const free = (await call('POST', `/organizations/${demoOrgId}/offers`, { code: `FREE${stamp % 100000}`, kind: 'FREE_ITEM', value: 0, itemIds: [lemonade.id], minSubtotalCents: 0, perUserLimit: 5 }, O)).json;
  const b2 = (await q(C, { promoCode: bogo.code }, [{ menuItemId: lemonade.id, quantity: 2 }])).json;
  const b1 = await q(C, { promoCode: bogo.code }, [{ menuItemId: lemonade.id, quantity: 1 }]);
  const fr = (await q(C, { promoCode: free.code }, [{ menuItemId: lemonade.id, quantity: 3 }])).json;
  check('buy one get one: second unit free; one unit explains what is missing', b2.discountCents === lemonade.priceCents && b2.promotions?.[0]?.name?.startsWith('Buy 1') && b1.status === 400 && /get 1 free/.test(b1.json.message), { b2: b2.discountCents, b1: b1.json?.message });
  check('free item: one unit of the item is free', fr.discountCents === lemonade.priceCents, fr.discountCents);

  // ── 25.7-P switch plans: upgrade now with proration, downgrade at renewal
  const plans = (await call('GET', '/public/membership/plans')).json;
  const monthly = plans.find((p) => p.interval === 'MONTH'), annual = plans.find((p) => p.interval === 'YEAR');
  const U = await reg('switcher');
  await call('POST', '/me/membership', { planId: monthly.id, paymentMethodId: 'mock_pm_4242' }, U.T); // first time: trial
  await call('POST', '/me/membership/cancel', { immediate: true }, U.T);
  await call('POST', '/me/membership', { planId: monthly.id, paymentMethodId: 'mock_pm_4242' }, U.T); // paid now
  const up = (await call('POST', '/me/membership/switch', { planId: annual.id }, U.T)).json;
  const afterUp = (await call('GET', '/me/loyalty', undefined, U.T)).json.membership;
  check('upgrade now: unused time credited, the difference charged, new yearly period', up.mode === 'NOW' && up.creditCents >= monthly.priceCents - 2 && up.chargedCents === annual.priceCents - up.creditCents && afterUp.planId === annual.id && new Date(afterUp.currentPeriodEnd) > new Date(days(360)), { up, plan: afterUp?.planId });
  const down = (await call('POST', '/me/membership/switch', { planId: monthly.id }, U.T)).json;
  const pend = (await call('GET', '/me/loyalty', undefined, U.T)).json.membership;
  await call('POST', '/admin/jobs/growth', { at: days(370) }, A);
  const renewed = (await call('GET', '/me/loyalty', undefined, U.T)).json.membership;
  check('downgrade waits for renewal, then the cheaper plan renews', down.mode === 'AT_RENEWAL' && pend.pendingPlanId === monthly.id && pend.planId === annual.id && renewed?.planId === monthly.id && !renewed.pendingPlanId, { down, pend: pend?.pendingPlanId, renewed: renewed?.planId });

  // ── 25.9-E escheat report
  const G = await reg('escheat');
  await call('POST', '/me/gift-cards', { amountCents: 1500, paymentMethodId: 'mock_pm_4242' }, G.T);
  const now = (await call('GET', '/admin/gift-cards/escheat', undefined, A)).json;
  const later = (await call('GET', `/admin/gift-cards/escheat?asOf=${encodeURIComponent(new Date(Date.now() + 10 * 365 * 86400_000).toISOString())}`, undefined, A)).json;
  const csv = await fetch(`${API}/admin/gift-cards/escheat.csv?asOf=${encodeURIComponent(new Date(Date.now() + 10 * 365 * 86400_000).toISOString())}`, { headers: { Authorization: `Bearer ${A}` } }).then((r) => r.text());
  check('escheat: dormant purchased balances by state, nothing new reportable today', later.totalCents >= 1500 && later.byState.length >= 1 && now.totalCents < later.totalCents && csv.startsWith('state,card,balance_cents'), { now: now.totalCents, later: later.totalCents });

  // ── 25.10-P Gutad-wide email campaign to a platform segment with holdout; 25.10-S result intervals
  const seg = (await call('POST', '/admin/segments', { name: `FD consented ${stamp}`, rules: { marketingConsent: true } }, A)).json;
  const pc = (await call('POST', '/admin/campaigns', { name: `FD platform email ${stamp}`, kind: 'EMAIL', segmentId: seg.id, holdoutPct: 50, content: { subject: 'Hello', body: 'News from Gutad' }, endsAt: days(7) }, A)).json;
  const sent = (await call('POST', `/campaigns/${pc.id}/send`, {}, A)).json;
  const pr = (await call('GET', `/campaigns/${pc.id}/results`, undefined, A)).json;
  check('Gutad-wide email campaign: consented segment, holdout recorded, not messaged', pc.organizationId === null && sent.queued + sent.heldOut >= 1 && pr.groups.treatment.users + pr.groups.holdout.users === sent.queued + sent.heldOut, { sent, groups: pr.groups });
  const camp = (await call('POST', `/organizations/${demoOrgId}/campaigns`, { name: `FD interval ${stamp}`, kind: 'COUPON', holdoutPct: 50, endsAt: days(7) }, O)).json;
  const off = (await call('POST', `/organizations/${demoOrgId}/offers`, { name: `FD 3% ${stamp}`, automatic: true, kind: 'PERCENT', value: 300, locationIds: [locId], stacking: 'STACKABLE', campaignId: camp.id }, O)).json;
  for (let i = 0; i < 12; i++) { const u = await reg(`int${i}`); await q(u.T, {}, [{ menuItemId: lemonade.id, quantity: 1 }]); }
  const ir = (await call('GET', `/campaigns/${camp.id}/results`, undefined, O)).json;
  const both = ir.groups.treatment.users >= 2 && ir.groups.holdout.users >= 2;
  check('campaign results carry a 95% range for incremental orders and sales', !both || (ir.incrementalOrdersRange && ir.incrementalOrdersRange.low <= 0 && ir.incrementalOrdersRange.high >= 0 && ir.incrementalOrdersRange.significant === false && ir.incrementalRevenueRange), { groups: ir.groups, range: ir.incrementalOrdersRange });
  await call('PATCH', `/organizations/${demoOrgId}/offers/${off.id}`, { kind: 'PERCENT', value: 300, automatic: true, isActive: false }, O);
}
