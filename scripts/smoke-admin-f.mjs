// Admin platform, phase F checks: kitchen display & preparation, packing, handoff, pickup and dine-in.
export async function adminPhaseF({ call, check, A, O, C, locId, owner }) {
  console.log('\n── Admin platform F: kitchen & packing');
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const hallItems = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const smash = hallItems.find((i) => i.name === 'Double smash');
  const fries = hallItems.find((i) => i.name === 'Crinkle fries');
  const bowl = hallItems.find((i) => i.name === 'Harvest bowl');
  const org = (await call('GET', `/organizations/${owner.user.merchantIds[0]}`, undefined, O)).json;
  const kitchenId = org.locations.find((l) => l.kitchenId)?.kitchenId;
  const order = async (lines, extra = {}, lid = hall.id, channel = 'MARKETPLACE', fulfillmentType = 'PICKUP') => {
    const q = (await call('POST', '/quotes', { locationId: lid, channel, fulfillmentType, lines }, C)).json;
    const o = (await call('POST', '/orders', { quoteId: q.id, ...extra }, C, idem())).json;
    return { q, o };
  };

  // 13.2 routing + 13.3 cook-time sequencing + 14.3 handling flags
  await call('PATCH', `/items/${smash.id}`, { cookMinutes: 12, handling: ['HOT'] }, O);
  await call('PATCH', `/items/${bowl.id}`, { cookMinutes: 3, handling: ['COLD'] }, O);
  const route = (await call('POST', `/kitchens/${kitchenId}/routes`, { matchType: 'ITEM', matchId: fries.id, stationCode: 'GRILL' }, O)).json;
  const badRoute = await call('POST', `/kitchens/${kitchenId}/routes`, { matchType: 'ITEM', matchId: fries.id, stationCode: 'NOPE' }, O);
  await call('PATCH', `/locations/${hall.id}`, { pickupShelves: ['A1', 'A2'], packingExtras: ['Napkins'] }, O);
  const { o: k1 } = await order([{ menuItemId: smash.id, quantity: 1 }, { menuItemId: fries.id, quantity: 1 }, { menuItemId: bowl.id, quantity: 1 }], { utensils: true });
  await call('POST', `/orders/${k1.id}/accept`, {}, O);
  const q1 = (await call('GET', `/kitchens/${kitchenId}/stations/queue`, undefined, O)).json.filter((t) => t.orderId === k1.id);
  const grill = q1.find((t) => t.stationCode === 'GRILL');
  const cold = q1.find((t) => t.stationCode === 'COLD');
  check('routing rule sends fries to the grill; unknown stations are refused', route.stationCode === 'GRILL' && badRoute.status === 400 && q1.length === 2 && grill?.lines.length === 2 && cold?.lines.length === 1, q1.map((t) => [t.stationCode, t.lines.length]));
  check('cook times stagger fire-at so stations finish together', grill.cookMinutes === 12 && cold.cookMinutes === 3 && new Date(cold.fireAt) > new Date(grill.fireAt) && cold.fireState === 'HOLD', { grill: grill.fireAt, cold: cold.fireAt, state: cold.fireState });
  const pk0 = (await call('GET', `/kitchens/${kitchenId}/packing`, undefined, O)).json.find((p) => p.orderId === k1.id);
  check('packing task for every order: checklist, hot/cold handling, two bags suggested', pk0 && pk0.handling.includes('HOT') && pk0.handling.includes('COLD') && pk0.bagCount === 2 && pk0.checklist.some((c) => c.key === 'utensils') && pk0.checklist.some((c) => c.label === 'Napkins'), pk0);

  // 13.1 item-level bump, 13.4 expo
  const smashLine = grill.lines.find((l) => l.menuItemId === smash.id);
  const friesLine = grill.lines.find((l) => l.menuItemId === fries.id);
  await call('POST', `/order-lines/${smashLine.id}/bump`, { ready: true }, O);
  const mid = (await call('GET', `/kitchens/${kitchenId}/stations/queue?station=GRILL`, undefined, O)).json.find((t) => t.id === grill.id);
  await call('POST', `/order-lines/${friesLine.id}/bump`, { ready: true }, O);
  const expo = (await call('GET', `/kitchens/${kitchenId}/expo`, undefined, O)).json.find((x) => x.orderId === k1.id);
  check('items bump one by one; the ticket finishes with its last item', mid?.status === 'IN_PROGRESS' && mid.lines.find((l) => l.id === smashLine.id).status === 'READY' && expo.stations.find((s) => s.stationCode === 'GRILL').status === 'DONE', { mid: mid?.status });
  check('expo shows which station still holds the order', expo.holding.length === 1 && expo.holding[0].stationCode === 'COLD' && expo.readyLines === 2 && expo.totalLines === 3, expo);

  // 13.6 remake with a reason code
  const badReason = await call('POST', '/kitchen-events', { orderId: k1.id, orderLineId: smashLine.id, kind: 'REMAKE', reasonCode: 'NOT_A_CODE' }, O);
  const remake = (await call('POST', '/kitchen-events', { orderId: k1.id, orderLineId: smashLine.id, kind: 'REMAKE', reasonCode: 'UNDERCOOKED', note: 'Pink in the middle' }, O)).json;
  const q2 = (await call('GET', `/kitchens/${kitchenId}/stations/queue?station=GRILL`, undefined, O)).json.filter((t) => t.orderId === k1.id);
  check('remake is recorded with a reason and re-fires the item', badReason.status === 400 && remake.refired && q2.some((t) => t.kind === 'REMAKE' && t.lineIds.includes(smashLine.id)), { remake, q2: q2.map((t) => t.kind) });
  for (const t of q2) await call('POST', `/tickets/${t.id}/transition`, { status: 'DONE' }, O);
  for (const l of cold.lines) await call('POST', `/order-lines/${l.id}/bump`, { ready: true }, O);

  // 14.4 verification for every order, 14.1 checklist, 14.2 bags & labels, 14.5 shelf
  const pk = (await call('GET', `/kitchens/${kitchenId}/packing`, undefined, O)).json.find((p) => p.orderId === k1.id);
  for (const l of pk.lines) await call('POST', `/packing/${pk.id}/verify`, { lineId: l.id }, O);
  const notChecked = await call('POST', `/packing/${pk.id}/release`, {}, O);
  for (const c of pk.checklist) await call('POST', `/packing/${pk.id}/checklist`, { key: c.key, done: true }, O);
  const bags = (await call('POST', `/packing/${pk.id}/bags`, { count: 3 }, O)).json;
  const labels = (await call('GET', `/packing/${pk.id}/labels`, undefined, O)).json;
  check('release waits for the checklist (utensils, extras)', pk.status === 'VERIFYING' && notChecked.status === 409 && /checklist/i.test(notChecked.json.message), notChecked.json);
  check('bag count and printable labels with handling flags, no pickup code', bags.bags.length === 3 && labels.bags[0].of === 3 && labels.bags[0].handling.includes('HOT') && labels.bags[1].handling.includes('COLD') && !JSON.stringify(labels).includes(k1.pickupCode || '@@'), labels.bags);
  const rel = (await call('POST', `/packing/${pk.id}/release`, {}, O)).json;
  const board = (await call('GET', `/locations/${hall.id}/pickup-board`, undefined, O)).json;
  check('released order gets a pickup shelf and shows on the pickup board', rel.status === 'RELEASED' && rel.shelfSlot === 'A1' && board.orders.some((x) => x.id === k1.id && x.shelfSlot === 'A1'), { rel: rel.shelfSlot });

  // 14.6 handoff receiver
  const ho = (await call('POST', `/orders/${k1.id}/handoff`, { pickupCode: k1.pickupCode }, O)).json;
  const tl = (await call('GET', `/orders/${k1.id}/timeline`, undefined, O)).json;
  check('handoff records who received it (code verified)', ho.status === 'COMPLETED' && tl.order.handoff?.type === 'CUSTOMER' && tl.order.handoff.codeVerified === true && tl.order.handoff.by, tl.order.handoff);

  // 14.4 tablet "ready" cannot skip packing where verification is required
  const { o: k2 } = await order([{ menuItemId: smash.id, quantity: 1 }, { menuItemId: bowl.id, quantity: 1 }]);
  await call('POST', `/orders/${k2.id}/accept`, {}, O);
  const skip = await call('POST', `/orders/${k2.id}/ready`, {}, O);
  check('kitchen orders cannot be marked ready without bag verification', skip.status === 409 && skip.json.code === 'PACK_VERIFICATION_REQUIRED', skip.json);

  // 13.7 auto-throttle
  await call('PATCH', `/kitchens/${kitchenId}/settings`, { autoThrottle: { busyAtActiveTickets: 1, overloadAtActiveTickets: 2, busyExtraMinutes: 15 } }, O);
  for (const t of (await call('GET', `/kitchens/${kitchenId}/stations/queue`, undefined, O)).json.filter((t) => t.orderId === k2.id)) await call('POST', `/tickets/${t.id}/transition`, { status: 'IN_PROGRESS' }, O);
  const sweep1 = (await call('POST', '/admin/jobs/kitchen-load', {}, A)).json;
  const busyQ = await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: bowl.id, quantity: 1 }] }, C);
  const alerts = (await call('GET', '/admin/alerts?status=ACTIVE', undefined, A)).json;
  await call('PATCH', `/kitchens/${kitchenId}/settings`, { autoThrottle: { enabled: false } }, O);
  await call('POST', '/admin/jobs/kitchen-load', {}, A);
  const okQ = await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: bowl.id, quantity: 1 }] }, C);
  await call('PATCH', `/kitchens/${kitchenId}/settings`, { autoThrottle: null }, O);
  check('overloaded kitchen pauses ASAP orders and raises an alert; recovery restores ordering', sweep1.changed.some((c) => c.kitchenId === kitchenId && c.to === 'OVERLOADED') && busyQ.status === 400 && busyQ.json.code === 'KITCHEN_BUSY' && alerts.some((a) => a.type === 'KITCHEN_OVERLOAD') && okQ.status === 201, { sweep1, busy: busyQ.json, ok: okQ.status });

  // 13.5 performance: prep vs target, remakes by reason
  const perf = (await call('GET', `/kitchens/${kitchenId}/performance?days=1`, undefined, O)).json;
  check('station performance with targets, waiting time and remake reasons', perf.stations.some((s) => s.code === 'GRILL' && s.targetMinutes > 0 && s.tickets >= 1) && perf.reasons.some((r) => r.reasonCode === 'UNDERCOOKED') && perf.waiting.some((w) => w.fulfillmentType === 'PICKUP'), perf);

  const ak = (await call('GET', '/admin/kitchens', undefined, A)).json;
  const ps = (await call('GET', `/locations/${hall.id}/packing-settings`, undefined, O)).json;
  const denied = await call('GET', '/admin/kitchens', undefined, C);
  check('admin kitchen overview (staff only) and location packing settings', ak.some((k) => k.id === kitchenId && k.loadLevel && 'delayed' in k) && denied.status === 403 && ps.effectiveRequired === true && ps.pickupShelves.includes('A1'), { ak: ak.length, denied: denied.status, ps });

  // 14.8 dine-in table routing + kiosk channel
  await call('PATCH', `/locations/${locId}`, { acceptsKiosk: true, acceptsDineIn: true }, O);
  const items = (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const lemonade = items.find((i) => i.name === 'House lemonade');
  const { q: kq, o: dine } = await order([{ menuItemId: lemonade.id, quantity: 2 }], { tableNumber: '12', guest: undefined }, locId, 'KIOSK', 'DINE_IN');
  await call('POST', `/orders/${dine.id}/accept`, {}, O);
  await call('POST', `/orders/${dine.id}/ready`, {}, O);
  const runner = (await call('GET', `/locations/${locId}/runner`, undefined, O)).json;
  const served = (await call('POST', `/orders/${dine.id}/handoff`, {}, O)).json;
  const dtl = (await call('GET', `/orders/${dine.id}/timeline`, undefined, O)).json;
  check('kiosk dine-in order routes to the runner by table and is served to the table', kq.channel === 'KIOSK' && runner.some((r) => r.id === dine.id && r.tableNumber === '12' && r.status === 'READY') && served.status === 'COMPLETED' && dtl.order.handoff?.type === 'TABLE' && dtl.order.handoff.tableNumber === '12', { runner, handoff: dtl.order.handoff });

  // 14.7 pickup no-show: remind, then resolve per policy (default: charge, treated as collected)
  const { o: ns } = await order([{ menuItemId: lemonade.id, quantity: 1 }], {}, locId, 'DIRECT');
  await call('POST', `/orders/${ns.id}/accept`, {}, O);
  await call('POST', `/orders/${ns.id}/ready`, {}, O);
  const r1 = (await call('POST', '/admin/jobs/pickup-no-show', { at: new Date(Date.now() + 25 * 60_000).toISOString() }, A)).json;
  const mid2 = (await call('GET', `/orders/${ns.id}/timeline`, undefined, O)).json;
  const r2 = (await call('POST', '/admin/jobs/pickup-no-show', { at: new Date(Date.now() + 70 * 60_000).toISOString() }, A)).json;
  const end = (await call('GET', `/orders/${ns.id}/timeline`, undefined, O)).json;
  check('pickup no-show: customer reminded, then resolved by policy', r1.reminded >= 1 && mid2.order.noShowStage === 'NOTIFIED' && r2.resolved >= 1 && end.order.status === 'COMPLETED' && end.order.handoff?.type === 'NO_SHOW', { r1, r2, status: end.order.status });

  await call('DELETE', `/station-routes/${route.id}`, undefined, O);
}
