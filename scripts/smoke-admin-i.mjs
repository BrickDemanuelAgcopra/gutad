// Admin platform, phase I checks: inventory & procurement, food safety, workforce & equipment.
export async function adminPhaseI({ call, check, A, O, C, owner }) {
  console.log('\n── Admin platform I: supply, safety, workforce');
  const stamp = Date.now();
  const idem = () => ({ 'Idempotency-Key': globalThis.crypto.randomUUID() });
  const days = (d) => new Date(Date.now() + d * 86400_000).toISOString();
  const orgId = owner.user.merchantIds[0];
  const org = (await call('GET', `/organizations/${orgId}`, undefined, O)).json;
  const hallLoc = org.locations.find((l) => l.kitchenId);
  const kitchenId = hallLoc.kitchenId;
  const hall = (await call('GET', '/public/locations/demo-kitchen-collective')).json;
  const menu = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items));
  const smash = menu.find((i) => i.name === 'Double smash');
  const bowl = menu.find((i) => i.name === 'Harvest bowl');
  await call('POST', `/locations/${hall.id}/restart`, { reason: 'Smoke I: normal capacity', rampThrottlePer15m: 500, rampMinutes: 5 }, A);
  await call('PATCH', `/kitchens/${kitchenId}/settings`, { autoThrottle: { enabled: false } }, O);
  await call('POST', '/admin/jobs/kitchen-load', {}, A);
  const order = async (item, qty = 1) => { const q = (await call('POST', '/quotes', { locationId: hall.id, channel: 'MARKETPLACE', fulfillmentType: 'PICKUP', lines: [{ menuItemId: item.id, quantity: qty }] }, C)).json; const o = (await call('POST', '/orders', { quoteId: q.id }, C, idem())).json; await call('POST', `/orders/${o.id}/accept`, {}, O); return o; };
  const items = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json;
  const beef = items.find((i) => i.name === 'Ground beef');
  const rice = items.find((i) => i.name === 'Rice' || /rice/i.test(i.name));

  // 21.7 / 22.1 suppliers must be approved
  const sup = (await call('POST', '/suppliers', { organizationId: orgId, name: `Smoke Meats ${stamp}`, leadTimeDays: 2, specs: [{ ingredientId: beef.id, spec: '80/20 chuck, chilled', minTempC: 0, maxTempC: 5, shelfLifeDays: 5 }] }, O)).json;
  const blocked = await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: sup.id, lines: [{ ingredientId: beef.id, quantity: 2, unitCostCents: 900 }] }, O);
  await call('POST', `/suppliers/${sup.id}/approval`, { approved: true, note: 'Audit passed' }, O);
  check('purchase orders only go to approved suppliers', blocked.status === 400 && blocked.json.code === 'SUPPLIER_NOT_APPROVED', blocked.json);

  // 21.1 / 21.2 item master: purchase unit kg = 1000 g; 21.3 storage area
  await call('PATCH', `/kitchens/${kitchenId}/inventory/items/${beef.id}`, { purchaseUnit: 'kg', purchaseUnitFactor: 1000, supplierId: sup.id, shelfLifeDays: 5, minTempC: 0, maxTempC: 5 }, A);
  await call('PATCH', `/kitchens/${kitchenId}/inventory/items/${rice.id}`, { supplierId: sup.id }, A);
  const cold = (await call('POST', `/kitchens/${kitchenId}/storage-areas`, { name: `Walk-in ${stamp % 1000}`, kind: 'COLD' }, O)).json;
  const beefBefore = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json.find((i) => i.id === beef.id).onHand;

  // 21.7 receiving with lots, expiry and discrepancies
  const po1 = (await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: sup.id, lines: [{ ingredientId: beef.id, quantity: 2, unitCostCents: 900 }] }, O)).json;
  const pol1 = (await call('GET', `/kitchens/${kitchenId}/purchase-orders`, undefined, O)).json.find((p) => p.id === po1.id).lines[0];
  await call('POST', `/purchase-orders/${po1.id}/receive`, { received: [{ lineId: pol1.id, receivedQty: 1.8, lotCode: `LOT-A-${stamp}`, expiresAt: days(5), storageAreaId: cold.id, note: 'one case damaged' }] }, O);
  const po2 = (await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: sup.id, lines: [{ ingredientId: beef.id, quantity: 1, unitCostCents: 900 }] }, O)).json;
  const pol2 = (await call('GET', `/kitchens/${kitchenId}/purchase-orders`, undefined, O)).json.find((p) => p.id === po2.id).lines[0];
  await call('POST', `/purchase-orders/${po2.id}/receive`, { received: [{ lineId: pol2.id, receivedQty: 1, lotCode: `LOT-B-${stamp}`, expiresAt: days(2), storageAreaId: cold.id }] }, O);
  const lots = (await call('GET', `/kitchens/${kitchenId}/lots?ingredientId=${beef.id}`, undefined, O)).json;
  const lotA = lots.find((l) => l.lotCode === `LOT-A-${stamp}`), lotB = lots.find((l) => l.lotCode === `LOT-B-${stamp}`);
  const pos = (await call('GET', `/kitchens/${kitchenId}/purchase-orders`, undefined, O)).json;
  const beefAfter = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json.find((i) => i.id === beef.id).onHand;
  check('receiving creates lots in base units with expiry, storage and discrepancy notes', lotA?.quantity === 1800 && lotB?.quantity === 1000 && lotA.storageArea && beefAfter - beefBefore === 2800 && /Short/.test(pos.find((p) => p.id === po1.id).lines[0].discrepancyNote || ''), { lotA: lotA?.quantity, diff: beefAfter - beefBefore });

  // 21.5 first expiring first out
  const pick = (await call('GET', `/kitchens/${kitchenId}/pick?ingredientId=${beef.id}&quantity=1500`, undefined, O)).json;
  check('pick suggestion takes the earliest-expiring lot first', pick.picks[0].lotId === lotB.id && pick.picks[0].quantity === 1000 && pick.shortBy === 0, pick);

  // 22.5 an order consumes from LOT-B and can be traced both ways
  const o1 = await order(smash);
  const trace = (await call('GET', `/safety/trace/lot/${lotB.id}`, undefined, O)).json;
  const traceO = (await call('GET', `/safety/trace/order/${o1.id}`, undefined, O)).json;
  check('lot traceability: lot → orders and order → lots', trace.orders.some((o) => o.id === o1.id) && traceO.lots.some((l) => l.lot_id === lotB.id), { orders: trace.orders?.length, lots: traceO.lots });

  // 21.8 three-way match
  const m1 = (await call('POST', `/purchase-orders/${po1.id}/invoice`, { invoiceNumber: 'INV-1', lines: [{ ingredientId: beef.id, quantity: 1.8, unitCostCents: 900 }] }, O)).json;
  const m2 = (await call('POST', `/purchase-orders/${po2.id}/invoice`, { invoiceNumber: 'INV-2', lines: [{ ingredientId: beef.id, quantity: 1, unitCostCents: 1000 }] }, O)).json;
  check('three-way match: within tolerance matches, a price variance is flagged', m1.matchStatus === 'MATCHED' && m2.matchStatus === 'VARIANCE' && m2.matchDetail.varianceCents === 100, { m1: m1.matchStatus, m2: m2.matchStatus });

  // 21.4 counts and waste are movements
  const cur = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json.find((i) => i.id === beef.id).onHand;
  const cnt = (await call('POST', `/kitchens/${kitchenId}/counts`, { counts: [{ ingredientId: beef.id, counted: cur - 100 }], note: 'Weekly count' }, O)).json;
  await call('POST', `/kitchens/${kitchenId}/waste`, { ingredientId: beef.id, quantity: 50, reason: 'Dropped', lotId: lotA.id }, O);
  const mv = (await call('GET', `/kitchens/${kitchenId}/movements?ingredientId=${beef.id}`, undefined, O)).json;
  check('stock movements ledger: receipts, consumption, counts, spoilage', cnt[0].diff === -100 && ['RECEIPT', 'CONSUMPTION', 'COUNT', 'SPOILAGE'].every((k) => mv.some((m) => m.kind === k)), mv.map((m) => m.kind));

  // 21.10 stockout → sold out, receipt → auto-restore
  const riceNow = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json.find((i) => i.id === rice.id).onHand;
  await call('POST', `/kitchens/${kitchenId}/counts`, { counts: [{ ingredientId: rice.id, counted: 100 }], note: 'Running low' }, O);
  await order(bowl);
  const soldOut = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === bowl.id).soldOut;
  const po3 = (await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: sup.id, lines: [{ ingredientId: rice.id, quantity: 5000, unitCostCents: 1 }] }, O)).json;
  await call('POST', `/purchase-orders/${po3.id}/receive`, { received: [] }, O);
  const back = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === bowl.id).soldOut;
  check('running out sells the dish out; receiving stock brings it back automatically', riceNow >= 0 && soldOut === true && back === false, { soldOut, back });

  // 21.6 forecast & replenishment → draft PO
  await call('PATCH', `/kitchens/${kitchenId}/inventory/items/${beef.id}`, { parLevel: 100000 }, O);
  const fc = (await call('GET', `/kitchens/${kitchenId}/forecast`, undefined, O)).json;
  const rep = (await call('POST', `/kitchens/${kitchenId}/replenish`, {}, O)).json;
  const fb = fc.find((x) => x.ingredientId === beef.id);
  const draft = rep.drafts[0];
  const sent = draft ? (await call('POST', `/purchase-orders/${draft.id}/send`, {}, O)).json : null;
  await call('PATCH', `/kitchens/${kitchenId}/inventory/items/${beef.id}`, { parLevel: 0 }, O);
  check('demand forecast with safety stock; replenishment becomes a draft PO for the approved supplier', fb && fb.dailyDemand > 0 && fb.needsReorder && fb.proposedPurchaseUnits > 0 && draft?.status === 'DRAFT' && sent?.status === 'ORDERED', { fb, rep: rep.skipped });

  // 21.9 transfer between two kitchens of the merchant
  const k2 = (await call('POST', `/organizations/${orgId}/kitchens`, { name: `Commissary ${stamp % 1000}`, addressLine1: '1 Dock St', city: 'New York', region: 'NY', postalCode: '10014' }, O)).json;
  const tr = (await call('POST', '/transfers', { fromKitchenId: kitchenId, toKitchenId: k2.id, lines: [{ ingredientId: beef.id, quantity: 200 }] }, O)).json;
  await call('POST', `/transfers/${tr.id}/pick`, {}, O);
  await call('POST', `/transfers/${tr.id}/ship`, {}, O);
  const recv = (await call('POST', `/transfers/${tr.id}/receive`, { received: [{ ingredientId: beef.id, quantity: 190 }], note: 'One pack torn' }, O)).json;
  const k2lots = (await call('GET', `/kitchens/${k2.id}/lots`, undefined, O)).json;
  check('inter-site transfer: pick, ship, receive with lots and a discrepancy', recv.status === 'RECEIVED' && /received 190/.test(recv.discrepancy || '') && k2lots.reduce((a, l) => a + l.quantity, 0) === 190 && k2lots.every((l) => l.expiresAt), { recv: recv.discrepancy, k2: k2lots.length });

  // 21.11 reports
  const rpt = (await call('GET', `/kitchens/${kitchenId}/inventory/reports`, undefined, O)).json;
  check('inventory reports: waste, supplier performance, valuation', rpt.wasteCents > 0 && rpt.suppliers.some((s) => s.supplier.startsWith('Smoke Meats') && s.fillRatePct !== null && s.invoiceVariances === 1) && rpt.valuationCents > 0, { waste: rpt.wasteCents, sup: rpt.suppliers });

  // 22.2 temperatures: storage out of range → alert + corrective action; receiving out of range → quarantine
  const t1 = (await call('POST', `/kitchens/${kitchenId}/temperatures`, { kind: 'STORAGE', tempC: 9, storageAreaId: cold.id }, O)).json;
  const t2 = (await call('POST', `/kitchens/${kitchenId}/temperatures`, { kind: 'RECEIVING', tempC: 12, lotId: lotA.id }, O)).json;
  const acts = (await call('GET', `/corrective-actions?kitchenId=${kitchenId}`, undefined, O)).json;
  check('temperature logs: out-of-range storage raises a corrective action; warm deliveries are quarantined', t1.inRange === false && t1.maxC === 5 && t2.quarantined === true && acts.some((a) => a.source === 'TEMPERATURE' && a.sourceId === t1.id), { t1, t2: t2.quarantined });

  // 22.3 checklists
  const tpls = (await call('GET', `/organizations/${orgId}/checklists`, undefined, O)).json;
  const opening = tpls.find((t) => t.kind === 'OPENING');
  const run = (await call('POST', `/checklists/${opening.id}/runs`, { kitchenId, signedName: 'Dana Owner', answers: opening.items.map((i, n) => ({ key: i.key, done: n !== 0, value: i.requiresValue ? '3°C' : undefined })) }, O)).json;
  check('checklist templates and signed runs; missed steps raise a corrective action', tpls.length >= 3 && run.missedItems === 1 && run.missing.length === 1, run);

  // 22.6 recall: quarantine, stop-sell, notify, close
  const rc = (await call('POST', '/safety/recalls', { title: 'Supplier recall: ground beef', reason: 'Possible E. coli contamination at the plant', lotIds: [lotB.id], severity: 'CRITICAL' }, A)).json;
  const stopped = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === smash.id).soldOut;
  const nt = (await call('POST', `/safety/recalls/${rc.id}/notify`, { message: 'Please discard any leftovers and contact us for a refund.' }, A)).json;
  const wd = (await call('POST', `/safety/recalls/${rc.id}/withdraw`, {}, A)).json;
  const cl = (await call('POST', `/safety/recalls/${rc.id}/close`, { note: 'Supplier confirmed lots destroyed' }, A)).json;
  const after = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === smash.id).soldOut;
  check('recall: lots quarantined, affected dishes stopped, customers of affected orders notified, withdrawn, closed', rc.status === 'QUARANTINED' && rc.affectedMenuItemIds.includes(smash.id) && rc.affectedOrderCount >= 1 && stopped === true && nt.notifiedOrders >= 1 && wd.lots === 1 && cl.status === 'CLOSED' && after === false, { rc: rc.status, nt, after });

  // 22.7 illness cluster escalation
  for (const o of [o1, await order(smash)]) await call('POST', '/incidents', { orderId: o.id, category: 'FOOD_SAFETY', menuItemId: smash.id, description: 'Felt unwell after eating' }, C);
  await call('POST', '/admin/jobs/operations-sweep', {}, A);
  const alerts = (await call('GET', '/admin/alerts?status=ACTIVE', undefined, A)).json;
  check('two food-safety reports for one location raise a possible-cluster alert', alerts.some((a) => a.type === 'FOOD_SAFETY_CLUSTER'), alerts.map((a) => a.type));

  // 22.8 inspection → corrective actions, verified by someone else
  const ins = (await call('POST', '/inspections', { kitchenId, kind: 'HEALTH_DEPT', inspector: 'NYC DOH', score: 88, result: 'CONDITIONAL', findings: [{ finding: 'Hand-wash sink blocked by equipment', severity: 'HIGH' }, { finding: 'Label missing on one container', severity: 'LOW' }] }, O)).json;
  const ca = ins.correctiveActions[0];
  await call('POST', `/corrective-actions/${ca.id}/complete`, { evidenceNote: 'Moved the rack; photo attached', evidenceUrl: 'https://files.example/sink.jpg' }, O);
  const selfV = await call('POST', `/corrective-actions/${ca.id}/verify`, {}, O);
  const okV = (await call('POST', `/corrective-actions/${ca.id}/verify`, {}, A)).json;
  check('inspection findings become corrective actions; evidence verified by a second person', ins.correctiveActions.length === 1 && selfV.status === 403 && okV.status === 'VERIFIED', { n: ins.correctiveActions.length, self: selfV.status });

  // 23.2 skills gate station shifts; 23.1 staffing forecast
  const stations = (await call('GET', `/kitchens/${kitchenId}`, undefined, O)).json.stations;
  const grill = stations.find((s) => s.code === 'GRILL');
  await call('POST', `/kitchens/${kitchenId}/stations`, { id: grill.id, code: grill.code, name: grill.name, maxConcurrent: grill.maxConcurrent, isAvailable: true, requiredSkill: 'GRILL_CERT' }, O);
  const sh = { locationId: hall.id, userId: owner.user.id, startsAt: days(1), endsAt: new Date(Date.now() + 86400_000 + 6 * 3600_000).toISOString(), stationCode: 'GRILL' };
  const noSkill = await call('POST', '/staff-shifts', sh, O);
  await call('POST', '/skills', { organizationId: orgId, userId: owner.user.id, skill: 'GRILL_CERT' }, O);
  const shift = (await call('POST', '/staff-shifts', sh, O)).json;
  const fcst = (await call('GET', `/locations/${hall.id}/staffing-forecast?date=${days(1).slice(0, 10)}`, undefined, O)).json;
  check('station shifts need the station skill; staffing forecast by hour', noSkill.status === 400 && noSkill.json.code === 'SKILL_REQUIRED' && shift.id && fcst.hours.length === 24 && fcst.hours.some((h) => h.scheduled >= 1), { noSkill: noSkill.json?.code });

  // 23.3 attendance, approval by someone else, payroll export; 1.6-L actual labor
  await call('POST', '/attendance/clock-in', { locationId: hall.id }, O);
  const twice = await call('POST', '/attendance/clock-in', { locationId: hall.id }, O);
  const out = (await call('POST', '/attendance/clock-out', { breakMinutes: 0 }, O)).json;
  const ts = (await call('GET', `/locations/${hall.id}/timesheet`, undefined, O)).json;
  const selfApprove = await call('PATCH', `/time-entries/${out.id}`, { approve: true, clockInAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, O);
  const approved = (await call('PATCH', `/time-entries/${out.id}`, { approve: true, clockInAt: new Date(Date.now() - 3 * 3600_000).toISOString(), note: 'Corrected start time' }, A)).json;
  const pr = await call('GET', `/locations/${hall.id}/payroll.csv`, undefined, O);
  const prText = typeof pr.json === 'string' ? pr.json : pr.text || '';
  const lab = (await call('GET', `/locations/${hall.id}/labor-report`, undefined, O)).json;
  const contrib = (await call('GET', '/admin/ops/contribution', undefined, A)).json;
  check('attendance: one open clock-in, approval by someone else, payroll export, labor vs volume, actual labor in contribution', twice.status === 409 && ts.some((e) => e.id === out.id) && selfApprove.status === 403 && approved.approvedById && lab.length > 0 && lab.some((d) => d.laborHours > 0) && contrib.ordersWithActualLabor > 0, { csv: String(prText).slice(0, 80), contrib: contrib.ordersWithActualLabor });

  // 23.5 / 23.6 equipment outage takes station dishes off and restores them
  const eq = (await call('POST', '/equipment', { kitchenId, name: 'Flat-top grill', kind: 'GRILL', stationCode: 'GRILL', serviceIntervalDays: 30 }, O)).json;
  const down = (await call('POST', `/equipment/${eq.id}/status`, { status: 'DOWN', note: 'Burner will not light' }, O)).json;
  const offMenu = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === smash.id).soldOut;
  const st2 = (await call('GET', `/kitchens/${kitchenId}`, undefined, O)).json.stations.find((s) => s.code === 'GRILL');
  const tk = (await call('POST', `/equipment/${eq.id}/tickets`, { kind: 'SERVICE', title: 'Replace igniter', vendor: 'GrillFix' }, O)).json;
  await call('POST', `/equipment-tickets/${tk.id}/resolve`, { resolution: 'Igniter replaced' }, O);
  const onMenu = (await call('GET', `/public/locations/${hall.id}/menus`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.id === smash.id).soldOut;
  const st3 = (await call('GET', `/kitchens/${kitchenId}`, undefined, O)).json.stations.find((s) => s.code === 'GRILL');
  check('equipment outage pauses the station’s dishes and closes the station; the service fix restores both', down.status === 'DOWN' && down.outageState.soldOutItemIds.includes(smash.id) && offMenu === true && st2.isAvailable === false && onMenu === false && st3.isAvailable === true, { off: offMenu, on: onMenu });

  // 23.8 automated equipment: unapproved software & faults are alerts only
  await call('POST', '/admin/settings', { key: 'equipment.approvedVersions', value: { ROBOT_ARM: ['2.1'] }, reason: 'Smoke I' }, A);
  const robot = (await call('POST', '/equipment', { kitchenId, name: 'Bowl robot', kind: 'ROBOT_ARM', isAutomated: true, softwareVersion: '1.9' }, O)).json;
  const fault = (await call('POST', `/equipment/${robot.id}/faults/manual`, { faultCode: 'E42', message: 'Gripper torque high', severity: 'HIGH' }, O)).json;
  const eqList = (await call('GET', `/equipment?kitchenId=${kitchenId}`, undefined, O)).json;
  const al2 = (await call('GET', '/admin/alerts?status=ACTIVE', undefined, A)).json;
  check('automated equipment: unapproved software and faults are recorded and escalated (no commands sent)', eqList.find((e) => e.id === robot.id).softwareApproved === false && fault.escalated && al2.some((a) => a.type === 'EQUIPMENT_SOFTWARE') && al2.some((a) => a.type === 'EQUIPMENT_FAULT'), al2.map((a) => a.type));

  // 23.7 device health & safety overview
  const dh = await call('GET', `/devices/health?locationId=${hall.id}`, undefined, O);
  const ov = (await call('GET', '/safety/overview', undefined, A)).json;
  check('device health list and food-safety overview', dh.status === 200 && Array.isArray(dh.json) && ov.temperatures.some((t) => t.out >= 1) && typeof ov.allergenReviews === 'number', { ov: ov.correctiveActions });
  await call('PATCH', `/kitchens/${kitchenId}/settings`, { autoThrottle: null }, O);
}
