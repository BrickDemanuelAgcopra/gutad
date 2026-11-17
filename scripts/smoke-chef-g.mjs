// Chef Network Phase 7 checks (imported by smoke.mjs): kitchen documents (reminders, expiry → automatic pause,
// renewal → automatic reinstatement), quality (food-safety report → dish suspended, thresholds, staff actions and
// the chef's record), earnings (held vs earned, adjustments), special-request escalation, and the analytics dashboard.

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const DAY = 86_400_000;

export async function chefPhaseG({ call, check, A, C, API }) {
  console.log('\n── Chef Network G: operations, quality and analytics');
  const K = (await call('POST', '/auth/login', { email: 'carlos@demo.gutad.io', password: 'chef12345' })).json.accessToken;
  const upload = async (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([PDF], { type: 'application/pdf' }), 'doc.pdf');
    const res = await fetch(`${API}/chef/application/documents`, { method: 'POST', headers: { Authorization: `Bearer ${K}` }, body: fd });
    return res.json();
  };
  const sweep = (days) => call('POST', '/admin/jobs/chef-operations', { at: new Date(Date.now() + days * DAY).toISOString() }, A);
  const me = (await call('GET', '/chef/me', undefined, K)).json;
  const chefId = me.profile.id;
  const orgId = me.organization.id;

  // ── documents
  const comp = (await call('GET', '/chef/compliance', undefined, K)).json;
  const req = comp.documents?.find((d) => d.needsExpiry);
  check('the chef sees their required documents and quality thresholds', Array.isArray(comp.documents) && !!req && comp.thresholds?.windowDays > 0, comp.documents?.map((d) => [d.key, d.state]));
  const doc = await upload({ requirementKey: req.key, expiresAt: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10) });
  await call('POST', `/admin/chef-documents/${doc.id}/review`, { status: 'APPROVED' }, A);
  const kit = (await call('GET', '/admin/chef-kitchens', undefined, A)).json;
  const mine = kit.kitchens?.find((k) => k.chefId === chefId);
  check('Admin → Kitchens lists each chef kitchen with document states', mine?.documents.find((d) => d.key === req.key)?.state === 'EXPIRING' && !!mine.kitchen, mine?.documents?.find((d) => d.key === req.key));
  const custKit = await call('GET', '/admin/chef-kitchens', undefined, C);
  check('customers can’t open kitchen operations', custKit.status === 403, custKit.status);
  const s1 = (await sweep(4)).json;
  const notesK = async () => (await call('GET', '/me/notifications', undefined, K)).json.map((n) => n.template);
  check('a chef is reminded before a required document expires', s1.documents?.reminded >= 1 && (await notesK()).includes('chef.document.expiring'), s1);
  const s2 = (await sweep(11)).json;
  const paused = (await call('GET', '/chef/compliance', undefined, K)).json;
  check('an expired required document pauses the chef automatically', s2.documents?.expired >= 1 && paused.status === 'PAUSED' && paused.statusCause === 'DOCUMENTS' && paused.documents.find((d) => d.key === req.key)?.state === 'EXPIRED', { s2, status: paused.status, cause: paused.statusCause });
  const pub = (await call('GET', '/public/chefs/chef-carlos')).json;
  check('…and the storefront stops taking orders', pub.acceptingOrders === false, pub.acceptingOrders);
  const reopen = await call('POST', '/chef/me/availability', { accepting: true }, K);
  check('a paused chef can’t switch availability back on', reopen.status === 403, reopen.status);
  const renewal = await upload({ requirementKey: req.key, expiresAt: new Date(Date.now() + 400 * DAY).toISOString().slice(0, 10) });
  const inReview = (await call('GET', '/chef/compliance', undefined, K)).json.documents.find((d) => d.key === req.key);
  check('an uploaded renewal shows as in review', inReview?.state === 'IN_REVIEW', inReview?.state);
  await call('POST', `/admin/chef-documents/${renewal.id}/review`, { status: 'APPROVED' }, A);
  const s3 = (await sweep(11)).json;
  const back = (await call('GET', '/chef/compliance', undefined, K)).json;
  check('an approved renewal reinstates the chef automatically', s3.documents?.reinstated >= 1 && back.status === 'ACTIVE' && !back.statusCause && back.events.some((e) => e.kind === 'DOCUMENT_EXPIRED') && back.events.some((e) => e.kind === 'CHEF_REINSTATED'), { status: back.status, s3 });
  const on = (await call('POST', '/chef/me/availability', { accepting: true }, K)).json;
  check('…and the chef can reopen', on.profile?.acceptingOrders === true, on.profile?.acceptingOrders ?? on);

  // ── food safety → the dish is suspended automatically
  const dishes = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  const lasagna = dishes.find((d) => d.dishName === 'Beef lasagna');
  const av = (await call('GET', `/public/chef-dishes/${lasagna.id}/availability`)).json;
  const day = av.days.find((d) => d.status === 'AVAILABLE');
  const at = (await call('GET', `/public/locations/${lasagna.location.id}/local-time?date=${day.date}&time=${day.slots[0]}`)).json.iso;
  const q = (await call('POST', '/quotes', { locationId: lasagna.location.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', scheduledFor: at, tipCents: 0, lines: [{ menuItemId: lasagna.menuItemId, quantity: 1 }] }, C)).json;
  const order = (await call('POST', '/orders', { quoteId: q.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  const earn = (await call('GET', '/chef/earnings', undefined, K)).json;
  const held = earn.orders?.find((o) => o.id === order.id);
  check('chef earnings show a new prepaid order as held until completion', held?.state === 'HELD' && held.netCents === held.foodCents + held.taxCents - held.commissionCents && earn.heldCents >= held.netCents && typeof earn.payableCents === 'number', { held, heldCents: earn.heldCents });
  check('…and completed orders as earned', earn.orders.some((o) => o.state === 'EARNED'), earn.orders?.map((o) => o.state).slice(0, 8));
  const inc = (await call('POST', '/incidents', { orderId: order.id, category: 'FOOD_SAFETY', description: 'Felt unwell a few hours after eating the lasagna' }, C)).json;
  const s4 = (await call('POST', '/admin/jobs/chef-operations', {}, A)).json;
  const after = (await call('GET', '/public/chefs/chef-carlos/dishes')).json;
  check('a food-safety report on a chef order suspends that dish automatically', !!inc.id && s4.quality?.foodSafetyActions >= 1 && !after.some((d) => d.id === lasagna.id), { s4, inc: inc.id });
  const again = (await call('POST', '/admin/jobs/chef-operations', {}, A)).json;
  check('…once per report', again.quality?.foodSafetyActions === 0, again.quality);
  const record = (await call('GET', `/admin/chefs/${chefId}/quality`, undefined, A)).json;
  check('the quality record shows the automatic suspension and food-safety count', record.events?.some((e) => e.kind === 'DISH_SUSPENDED' && e.source === 'AUTO' && e.incidentId === inc.id) && record.metrics?.foodSafety >= 1 && record.metrics.flags.includes('FOOD_SAFETY'), record.metrics);
  const lasagnaDish = record.dishes.find((d) => d.dishName === 'Beef lasagna');
  const reinst = (await call('POST', `/admin/chefs/${chefId}/quality`, { action: 'DISH_REINSTATED', dishId: lasagnaDish.id, note: 'Investigated: unrelated to the dish' }, A)).json;
  check('staff reinstate the dish after review', reinst.events?.[0]?.kind === 'DISH_REINSTATED' && (await call('GET', '/public/chefs/chef-carlos/dishes')).json.some((d) => d.id === lasagna.id), reinst.events?.[0]);
  await call('POST', `/orders/${order.id}/cancel`, { reason: 'smoke cleanup' }, C);

  // ── staff actions and thresholds
  await call('POST', `/admin/chefs/${chefId}/quality`, { action: 'WARNING', note: 'Several late confirmations this month' }, A);
  await call('POST', `/admin/chefs/${chefId}/quality`, { action: 'NOTE', note: 'Internal: spoke with the chef by phone' }, A);
  const chefView = (await call('GET', '/chef/compliance', undefined, K)).json;
  check('the chef sees warnings on their record but not internal notes', chefView.events.some((e) => e.kind === 'WARNING') && !chefView.events.some((e) => e.kind === 'NOTE'), chefView.events.map((e) => e.kind));
  const custAct = await call('POST', `/admin/chefs/${chefId}/quality`, { action: 'WARNING', note: 'not allowed here' }, C);
  check('only Gutad staff take quality actions', custAct.status === 403, custAct.status);
  await call('POST', '/admin/settings', { key: 'chefs.quality', value: { minOrders: 1, maxDeclineRatePct: 1 }, reason: 'Smoke threshold' }, A);
  const s5 = (await call('POST', '/admin/jobs/chef-operations', {}, A)).json;
  const qual = (await call('GET', '/admin/chef-quality', undefined, A)).json;
  const carlosQ = qual.chefs?.find((c) => c.chefId === chefId);
  check('chefs over a threshold are flagged once (record + alert)', s5.quality?.thresholdFlags >= 1 && carlosQ?.flags.includes('DECLINE_RATE') && qual.events.some((e) => e.kind === 'THRESHOLD_BREACH' && e.chefProfileId === chefId), { s5: s5.quality, flags: carlosQ?.flags });
  const s6 = (await call('POST', '/admin/jobs/chef-operations', {}, A)).json;
  check('…not again within the week', s6.quality?.thresholdFlags === 0, s6.quality);
  await call('POST', '/admin/settings', { key: 'chefs.quality', value: {}, reason: 'Smoke threshold reset' }, A);

  // ── earnings adjustments
  const before = (await call('GET', `/admin/chefs/${chefId}/earnings`, undefined, A)).json;
  const adj = await call('POST', '/finance/adjustments', { organizationId: orgId, cents: 500, reason: 'Goodwill: packaging reimbursement' }, A);
  const afterE = (await call('GET', '/chef/earnings', undefined, K)).json;
  check('an earnings adjustment credits the chef and shows on their earnings', adj.status === 201 && afterE.payableCents === before.payableCents + 500 && afterE.adjustments[0]?.cents === 500 && /Goodwill/.test(afterE.adjustments[0].memo), { before: before.payableCents, after: afterE.payableCents, adj: afterE.adjustments?.[0] });

  // ── special-request escalation
  const spaghetti = dishes.find((d) => d.dishName === 'Spaghetti');
  const sav = (await call('GET', `/public/chef-dishes/${spaghetti.id}/availability`)).json;
  const sday = sav.days.filter((d) => d.status === 'AVAILABLE')[2] || sav.days.find((d) => d.status === 'AVAILABLE');
  const r = (await call('POST', '/chef-requests', { dishId: spaghetti.id, requestType: 'REMOVE', ingredient: 'parmigiano', details: 'No cheese at all, please', servings: 1, requestedDate: sday.date, reason: 'ALLERGY' }, C)).json;
  const e1 = (await call('POST', '/admin/jobs/chef-requests', { at: new Date(Date.now() + 13 * 3_600_000).toISOString() }, A)).json;
  check('the chef is reminded halfway through the reply window', e1.reminded >= 1 && (await notesK()).includes('chef.request.reminder'), e1);
  const e2 = (await call('POST', '/admin/jobs/chef-requests', { at: new Date(Date.now() + 21 * 3_600_000).toISOString() }, A)).json;
  const esc = (await call('GET', '/admin/chef-requests?escalated=true', undefined, A)).json;
  check('Gutad is alerted before the deadline (escalated list and count)', e2.escalated >= 1 && esc.requests?.some((x) => x.id === r.id) && esc.stats.escalated >= 1, { e2, n: esc.requests?.length });
  const alerts = (await call('GET', `/admin/alerts?subjectId=${r.id}`, undefined, A)).json;
  const alertList = Array.isArray(alerts) ? alerts : alerts.alerts || alerts.items || [];
  check('…as an operations alert (high severity for allergies)', alertList.some((a) => a.type === 'CHEF_REQUEST_ESCALATED' && a.severity === 'HIGH'), alertList.map((a) => [a.type, a.severity, a.status]));
  await call('POST', `/chef/requests/${r.id}/decline`, { reason: 'Can’t guarantee a milk-free kitchen' }, K);
  const alerts2 = (await call('GET', `/admin/alerts?status=RESOLVED&subjectId=${r.id}`, undefined, A)).json;
  const list2 = Array.isArray(alerts2) ? alerts2 : alerts2.alerts || alerts2.items || [];
  check('the alert resolves when the chef answers', list2.some((a) => a.type === 'CHEF_REQUEST_ESCALATED' && a.status === 'RESOLVED'), list2.map((a) => a.status));

  // ── analytics
  const an = (await call('GET', '/admin/chef-network/analytics?days=30', undefined, A)).json;
  check('the analytics dashboard covers activation, orders, margin, fulfilment, requests and repeat customers', an.funnel?.approved >= 2 && an.orders?.placed > 0 && an.margin?.gutadRevenueCents > 0 && an.fulfilment?.declinedPct !== undefined && an.requests?.total > 0 && an.repeat?.buyers > 0, { funnel: an.funnel, orders: an.orders, margin: an.margin });
  check('…with a daily series, popular options and top dishes and chefs', Array.isArray(an.daily) && an.daily.length > 0 && Array.isArray(an.modifiers) && an.topDishes?.length > 0 && an.topChefs?.length > 0, { mods: an.modifiers?.slice(0, 3), dishes: an.topDishes?.length });
  const custAn = await call('GET', '/admin/chef-network/analytics', undefined, C);
  check('analytics are staff-only', custAn.status === 403, custAn.status);
}
