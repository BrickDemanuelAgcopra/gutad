// Admin platform, phase B checks: executive dashboard, live board, capacity, contribution, alerts, central orders.
export async function adminPhaseB({ call, check, A, O, C, locId, o1 }) {
  console.log('\n── Admin platform B: dashboard, live operations, alerts, orders');
  const stamp = Date.now();
  const supEmail = `support-b-${stamp}@example.com`;
  await call('POST', '/auth/register', { email: supEmail, password: 'staffpass12345', name: 'Support B' });
  await call('POST', '/admin/security/staff/roles', { email: supEmail, roles: ['SUPPORT'], reason: 'Smoke B staffing' }, A);
  const S = (await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' })).json.accessToken;

  // executive dashboard
  const ex = (await call('GET', '/admin/ops/executive', undefined, A)).json;
  const c = ex.current || {};
  check('executive: orders, sales, refunds, cancellations, AOV', c.orders > 0 && c.grossSalesCents > 0 && c.aovCents > 0 && typeof c.refundsCents === 'number' && typeof c.cancellationRate === 'number', c);
  check('executive: food sales, platform revenue and merchant payable are separate', c.foodSalesCents > 0 && c.platformRevenueCents >= 0 && c.merchantPayableCents > 0 && c.merchantPayableCents !== c.platformRevenueCents, { food: c.foodSalesCents, plat: c.platformRevenueCents, merch: c.merchantPayableCents });
  check('executive compares with the previous period and has a daily trend', ex.previous && Array.isArray(ex.trend) && ex.trend.length >= 1, ex.trend?.length);
  const supEx = await call('GET', '/admin/ops/executive', undefined, S);
  check('executive dashboard needs overview permission', supEx.status === 403, supEx.status);
  const dims = {};
  for (const d of ['region', 'location', 'merchant', 'brand', 'channel']) dims[d] = (await call('GET', `/admin/ops/breakdown?dim=${d}`, undefined, A)).json;
  check('performance by region, location, merchant, brand and channel', Object.values(dims).every((r) => Array.isArray(r) && r.length >= 1) && dims.channel.some((x) => x.key === 'MARKETPLACE') && dims.brand.some((x) => x.label === 'Smash Society' || x.label === 'Bowl Theory'), Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v.length])));
  const onlyLoc = (await call('GET', `/admin/ops/executive?locationId=${locId}`, undefined, A)).json;
  check('filters narrow the dashboard', onlyLoc.current.orders <= c.orders && onlyLoc.locations === 1, [onlyLoc.current.orders, c.orders]);

  // live board: a fresh order waits for acceptance
  const menus = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json;
  const lemonade = menus[0].categories.flatMap((x) => x.items).find((i) => i.name === 'House lemonade');
  const q = (await call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: lemonade.id, quantity: 1 }] }, C)).json;
  const fresh = (await call('POST', '/orders', { quoteId: q.id }, C, { 'Idempotency-Key': globalThis.crypto.randomUUID() })).json;
  const live = (await call('GET', '/admin/ops/live', undefined, A)).json;
  check('live board buckets: awaiting acceptance, cooking, ready, awaiting courier, out for delivery, overdue', ['awaitingAcceptance', 'cooking', 'ready', 'awaitingCourier', 'outForDelivery', 'overdue'].every((k) => typeof live.counts?.[k] === 'number') && live.items.some((i) => i.id === fresh.id && i.bucket === 'awaitingAcceptance'), live.counts);
  const supLive = await call('GET', '/admin/ops/live', undefined, S);
  check('support can watch live operations', supLive.status === 200, supLive.status);

  // capacity
  const cap = (await call('GET', '/admin/ops/capacity', undefined, A)).json;
  check('capacity: kitchen load, couriers, stockouts, outages', cap.couriers && typeof cap.couriers.available === 'number' && Array.isArray(cap.locations) && cap.locations.some((l) => l.id === locId) && typeof cap.totals.stockouts === 'number', cap.totals);

  // contribution margin
  const cm = (await call('GET', '/admin/ops/contribution', undefined, A)).json;
  check('contribution margin per order after food, labor, delivery, processing, promotions', cm.orders >= 1 && ['foodCents', 'laborCents', 'deliveryCents', 'processingCents', 'promotionsCents', 'contributionCents'].every((k) => typeof cm.average[k] === 'number') && Array.isArray(cm.worst), cm.average);

  // central order search & drill-down
  const byNum = (await call('GET', `/admin/orders?q=${encodeURIComponent(o1.number)}`, undefined, A)).json;
  check('order search by number', byNum.items?.length === 1 && byNum.items[0].id === o1.id, byNum.total);
  const payId = (await call('GET', `/orders/${o1.id}/timeline`, undefined, A)).json.payment?.providerIntentId;
  const byPay = payId ? (await call('GET', `/admin/orders?q=${encodeURIComponent(payId)}`, undefined, A)).json : { items: [] };
  check('order search by payment transaction', byPay.items.some((x) => x.id === o1.id), payId);
  const byCust = (await call('GET', `/admin/orders?customer=smoke-`, undefined, A)).json;
  check('order search by customer', byCust.total >= 1, byCust.total);
  const drill = (await call('GET', '/admin/orders?bucket=awaitingAcceptance', undefined, A)).json;
  check('metric drill-down lists the underlying orders', drill.items.some((x) => x.id === fresh.id), drill.total);
  const masked = (await call('GET', `/admin/orders?q=${encodeURIComponent(o1.number)}`, undefined, (await call('POST', '/auth/login', { email: supEmail, password: 'staffpass12345' })).json.accessToken)).json;
  check('support sees customer contact (has PII permission)', masked.items?.[0]?.customer?.email?.includes('@') && !masked.items[0].customer.email.includes('•••'), masked.items?.[0]?.customer);
  const det = (await call('GET', `/admin/orders/${o1.id}`, undefined, A)).json;
  check('order detail: separate order, kitchen, payment, delivery, refunds, incidents, notes', det.order && Array.isArray(det.tickets) && det.payment !== undefined && Array.isArray(det.refunds) && Array.isArray(det.incidents) && Array.isArray(det.notes) && Array.isArray(det.issues), Object.keys(det));

  // notes & customer messages with templates
  const tpls = (await call('GET', '/message-templates', undefined, S)).json;
  check('approved response templates are available', tpls.some((t) => t.key === 'delay_kitchen'), tpls.length);
  const internal = (await call('POST', `/orders/${fresh.id}/notes`, { body: 'Called the store, tablet was asleep', visibility: 'INTERNAL' }, S)).json;
  const msg = (await call('POST', `/orders/${fresh.id}/notes`, { body: '', templateKey: 'delay_kitchen', visibility: 'CUSTOMER' }, S)).json;
  check('internal notes and templated customer messages on the order', internal.id && msg.body.includes(fresh.number) && msg.visibility === 'CUSTOMER', msg.body);
  const custNote = await call('POST', `/orders/${fresh.id}/notes`, { body: 'hello', visibility: 'INTERNAL' }, C);
  check('customers cannot write staff notes', custNote.status === 403, custNote.status);

  // controlled remedy from the order page goes through approvals
  const rem = (await call('POST', `/admin/orders/${o1.id}/remedy`, { remedy: 'CREDIT', remedyCents: 9900, owner: 'PLATFORM', reason: 'Large goodwill credit for repeated issues' }, S)).json;
  check('order-page remedy above the limit waits for approval', rem.status === 'PENDING_APPROVAL', rem);

  // alerts: detectors raise, owners act, history is kept
  const ack = await call('POST', `/locations/${locId}/pause`, { reason: 'Smoke: hood fan broken' }, O);
  const det1 = (await call('POST', '/admin/alerts/detect', {}, A)).json;
  const alerts = (await call('GET', '/admin/alerts', undefined, A)).json;
  const paused = alerts.find((a) => a.type === 'LOCATION_PAUSED' && a.subjectId === locId);
  check('detectors raise alerts with an owner team and an escalation deadline', ack.status < 300 && det1.detected >= 1 && paused && paused.ownerRole === 'OPERATIONS' && paused.escalateAt, { det1, paused: paused?.title });
  const twice = (await call('POST', '/admin/alerts/detect', {}, A)).json;
  const again = (await call('GET', '/admin/alerts', undefined, A)).json.filter((a) => a.type === 'LOCATION_PAUSED' && a.subjectId === locId);
  check('alerts are not duplicated while open', again.length === 1 && twice.created === 0 || again.length === 1, again.length);
  const acked = (await call('POST', `/admin/alerts/${paused.id}/ack`, { note: 'Looking into it' }, A)).json;
  const commented = (await call('POST', `/admin/alerts/${paused.id}/comment`, { note: 'Technician booked for 3pm' }, S)).json;
  check('acknowledge and comment are recorded in the history', acked.status === 'ACKNOWLEDGED' && acked.ownerId && commented.history.length >= 3, commented.history?.map((h) => h.action));
  const supResolve = await call('POST', `/admin/alerts/${paused.id}/resolve`, { resolution: 'fixed' }, S);
  check('support cannot resolve operations alerts', supResolve.status === 403, supResolve.status);
  await call('POST', `/locations/${locId}/resume`, {}, O);
  const det2 = (await call('POST', '/admin/alerts/detect', {}, A)).json;
  const cleared = (await call('GET', `/admin/alerts?status=RESOLVED&subjectId=${locId}`, undefined, A)).json.find((a) => a.id === paused.id);
  check('alert auto-resolves when the condition clears', det2.cleared >= 1 && cleared?.autoResolved, cleared?.status);
  const manual = (await call('POST', '/admin/alerts', { title: 'Walk-in freezer warm at food hall', severity: 'CRITICAL', ownerRole: 'OPERATIONS' }, A)).json;
  const esc = (await call('POST', '/admin/alerts/escalate', {}, A)).json;
  check('manual alerts can be raised', manual.id && manual.severity === 'CRITICAL', manual);
  const resolved = (await call('POST', `/admin/alerts/${manual.id}/resolve`, { resolution: 'Door was left open; temperature back to -18C' }, A)).json;
  check('resolving keeps a resolution history', resolved.status === 'RESOLVED' && resolved.history.some((h) => h.action === 'RESOLVED'), resolved.history?.length);
  const sum = (await call('GET', '/admin/alerts/summary', undefined, A)).json;
  check('alert summary by severity', typeof sum.active === 'number' && sum.bySeverity && typeof esc.escalated === 'number', sum);
}
