// Follow-ups C checks: versioned modifier groups (7.7-M), tax engine (9.5-X), GL push (20.1-L), ledger lock (20.7-L),
// forecast seasonality & promotions (21.6-S), supplier portal / EDI (21.8-P), temperature sensors (22.2-S),
// payroll provider push (23.3-P), equipment vendor feeds (23.8-V).
export async function followupsC({ call, check, A, O, C, locId, demoOrgId, owner, API }) {
  console.log('\n── Follow-ups C: menus, tax, ledger, supply, safety, workforce');
  const stamp = Date.now();
  const uuid = () => globalThis.crypto.randomUUID();
  const day = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const orgId = owner.user.merchantIds?.[0] || demoOrgId;
  const org = (await call('GET', `/organizations/${orgId}`, undefined, O)).json;
  const hallLoc = org.locations.find((l) => l.kitchenId);
  const kitchenId = hallLoc.kitchenId;
  void C; void API;

  // ── 7.7-M modifier groups travel with menu versions
  {
    const menusOf = async () => (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json;
    const menu = (await menusOf())[0];
    const items = () => menusOf().then((ms) => ms.flatMap((m) => m.categories.flatMap((c) => c.items)));
    const before = await items();
    const lemonade = before.find((i) => i.name === 'House lemonade');
    const burger = before.find((i) => i.name === 'Bistro burger');
    const bacon = burger.modifierGroups.find((g) => g.name === 'Extras').options.find((o) => o.name === 'Bacon');
    // a clean baseline version that already carries modifier groups
    const d0 = (await call('POST', `/menus/${menu.id}/drafts`, { note: 'Smoke C baseline' }, O)).json;
    const p0 = await call('POST', `/menu-versions/${d0.id}/publish`, { note: 'Smoke C baseline' }, O);
    const d1 = (await call('POST', `/menus/${menu.id}/drafts`, { note: 'Smoke C sauces' }, O)).json;
    const doc = d1.document;
    const groupId = uuid();
    const extras = doc.modifierGroups.find((g) => g.name === 'Extras');
    extras.options = extras.options.map((o) => (o.name === 'Bacon' ? { ...o, priceCents: o.priceCents + 10 } : o));
    doc.modifierGroups.push({ id: groupId, name: `Smoke sauces ${stamp}`, minSelect: 0, maxSelect: 2, required: false, options: [{ name: 'Aioli', priceCents: 50 }, { name: 'Harissa', priceCents: 75 }] });
    for (const c of doc.categories) for (const i of c.items) if (i.id === lemonade.id) i.modifierGroupIds = [...(i.modifierGroupIds || []), groupId];
    const badRef = await call('PUT', `/menu-versions/${d1.id}`, { document: { ...doc, categories: doc.categories.map((c) => ({ ...c, items: c.items.map((i) => (i.id === lemonade.id ? { ...i, modifierGroupIds: [uuid()] } : i)) })) } }, O);
    const saved = await call('PUT', `/menu-versions/${d1.id}`, { document: doc }, O);
    const diff = (await call('GET', `/menu-versions/${d1.id}/diff`, undefined, O)).json;
    check('7.7-M drafts carry modifier groups; the diff shows group and option changes', p0.status < 300 && badRef.status === 400 && saved.status === 200 && diff.modifiers?.added?.some((g) => g.name === `Smoke sauces ${stamp}`) && diff.modifiers?.changed?.some((g) => g.name === 'Extras' && g.optionsChanged.some((o) => o.name === 'Bacon' && o.fields.some((f) => f.field === 'priceCents'))) && diff.changed?.some((c) => c.fields.some((f) => f.field === 'modifierGroupIds' && JSON.stringify(f.to).includes('Smoke sauces'))), { modifiers: diff.modifiers, bad: badRef.status });
    const pub = await call('POST', `/menu-versions/${d1.id}/publish`, { note: 'Smoke C sauces' }, O);
    const live = await items();
    const lem1 = live.find((i) => i.id === lemonade.id), bur1 = live.find((i) => i.id === burger.id);
    check('7.7-M publishing applies modifier groups and option prices', pub.json?.status === 'PUBLISHED' && lem1.modifierGroups.some((g) => g.id === groupId && g.options.length === 2) && bur1.modifierGroups.find((g) => g.name === 'Extras').options.find((o) => o.name === 'Bacon').priceCents === bacon.priceCents + 10, { status: pub.json?.status, groups: lem1.modifierGroups.map((g) => g.name) });
    const rb = await call('POST', `/menu-versions/${d0.id}/rollback`, { reason: 'Smoke C: sauces were early' }, O);
    const after = await items();
    const lem2 = after.find((i) => i.id === lemonade.id), bur2 = after.find((i) => i.id === burger.id);
    check('7.7-M rollback restores modifier groups too', rb.json?.status === 'PUBLISHED' && !lem2.modifierGroups.some((g) => g.id === groupId) && bur2.modifierGroups.find((g) => g.name === 'Extras').options.find((o) => o.name === 'Bacon').priceCents === bacon.priceCents, { status: rb.json?.status, groups: lem2.modifierGroups.map((g) => g.name) });
  }

  // ── 9.5-X tax engine (built-in unless TAX_PROVIDER is set; no network calls without keys)
  {
    const eng = await call('GET', '/admin/pricing/tax-engine', undefined, A);
    const denied = await call('GET', '/admin/pricing/tax-engine', undefined, C);
    const q = await call('POST', '/quotes', { locationId: locId, channel: 'DIRECT', fulfillmentType: 'PICKUP', lines: [{ menuItemId: (await call('GET', `/public/locations/${locId}/menus?channel=DIRECT`)).json.flatMap((m) => m.categories.flatMap((c) => c.items)).find((i) => i.name === 'House lemonade').id, quantity: 1 }] }, C);
    check('9.5-X tax engine is reported (built-in by default) and quotes still price tax', eng.status === 200 && ['builtin', 'taxjar', 'avalara', 'mock'].includes(eng.json.engine) && (eng.json.engine !== 'builtin' || eng.json.configured === false) && denied.status === 403 && q.status < 300 && typeof q.json.taxCents === 'number', { engine: eng.json, quote: q.status });
  }

  // ── 20.7-L ledger lock: closed months redirect (or refuse) postings; audited reopen
  {
    const P = '2001-01';
    const pair = (memo) => ({ date: `${P}-15`, memo, lines: [{ account: 'PLATFORM_ADJUSTMENTS', debitCents: 1 }, { account: 'PLATFORM_ADJUSTMENTS', creditCents: 1 }] });
    const st = (await call('GET', `/accounting/close/${P}`, undefined, A)).json;
    const early = await call('POST', `/accounting/close/${thisMonth}`, { force: true, reason: 'Smoke C: current month' }, A);
    const noReason = st.status === 'CLOSED' ? { status: 400 } : await call('POST', `/accounting/close/${P}`, { force: true }, A);
    const closed = st.status === 'CLOSED' ? { status: 200, json: st } : await call('POST', `/accounting/close/${P}`, { force: true, reason: 'Smoke C: lock an empty past month' }, A);
    const lock = (await call('GET', '/accounting/ledger-lock', undefined, A)).json;
    const redirected = await call('POST', '/accounting/journals', pair('Smoke C late adjustment'), A);
    const unbalanced = await call('POST', '/accounting/journals', { date: `${P}-15`, memo: 'Smoke C unbalanced', lines: [{ account: 'PLATFORM_ADJUSTMENTS', debitCents: 2 }, { account: 'PLATFORM_ADJUSTMENTS', creditCents: 1 }] }, A);
    check('20.7-L a closed month redirects postings dated in it into the current month', early.status === 409 && noReason.status === 400 && closed.status < 300 && lock.closed.some((c) => c.period === P) && redirected.status === 201 && redirected.json.redirectedFrom === P && redirected.json.period === thisMonth && unbalanced.status === 400, { early: early.json?.code, red: redirected.json, closed: closed.status });
    await call('POST', '/admin/settings', { key: 'accounting.ledgerLock', value: { mode: 'reject' }, reason: 'Smoke C: refuse closed-month postings' }, A);
    const refused = await call('POST', '/accounting/journals', pair('Smoke C refused'), A);
    await call('POST', '/admin/settings', { key: 'accounting.ledgerLock', value: { mode: 'redirect' }, reason: 'Smoke C: back to redirect' }, A);
    const ownerReopen = await call('POST', `/accounting/close/${P}/reopen`, { reason: 'Owner should not reopen' }, O);
    const reopened = await call('POST', `/accounting/close/${P}/reopen`, { reason: 'Smoke C: audited reopen' }, A);
    const lock2 = (await call('GET', '/accounting/ledger-lock', undefined, A)).json;
    const inPlace = await call('POST', '/accounting/journals', pair('Smoke C dated adjustment'), A);
    check('20.7-L reject mode refuses; an audited admin reopen lets postings land in the month again', refused.status === 409 && refused.json.code === 'PERIOD_CLOSED' && ownerReopen.status === 403 && reopened.status < 300 && reopened.json.status === 'OPEN' && !lock2.closed.some((c) => c.period === P) && lock2.reopened.some((r) => r.period === P) && inPlace.json.period === P && inPlace.json.redirectedFrom === null, { refused: refused.status, reopen: reopened.status, inPlace: inPlace.json });
  }

  // ── 20.1-L GL push: CSV by default; mock adapter, failure + retry, idempotent per period
  {
    const entity = `SMOKE-${stamp}`;
    const c0 = (await call('GET', `/accounting/gl/connection?entity=${entity}`, undefined, A)).json;
    const noConn = await call('POST', '/accounting/gl/push', { period: thisMonth, legalEntity: entity, allowOpen: true }, A);
    const badQbo = await call('POST', '/accounting/gl/connection', { legalEntity: entity, provider: 'QBO' }, A);
    await call('POST', '/accounting/gl/connection', { legalEntity: entity, provider: 'MOCK', config: { mockFail: true } }, A);
    const openMonth = await call('POST', '/accounting/gl/push', { period: thisMonth, legalEntity: entity }, A);
    const failed = (await call('POST', '/accounting/gl/push', { period: thisMonth, legalEntity: entity, allowOpen: true }, A)).json;
    await call('POST', '/accounting/gl/connection', { legalEntity: entity, provider: 'MOCK', config: { mockFail: false } }, A);
    const retried = (await call('POST', `/accounting/gl/push-batches/${failed.batch?.id}/retry`, {}, A)).json;
    const again = (await call('POST', '/accounting/gl/push', { period: thisMonth, legalEntity: entity, allowOpen: true }, A)).json;
    const c1 = (await call('GET', `/accounting/gl/connection?entity=${entity}`, undefined, A)).json;
    const ownerDenied = await call('POST', '/accounting/gl/push', { period: thisMonth, legalEntity: entity, allowOpen: true }, O);
    check('20.1-L GL push: CSV until connected, failed pushes retry, one push per period', c0.mode === 'CSV' && noConn.status === 409 && noConn.json.code === 'GL_NOT_CONNECTED' && badQbo.status === 400 && openMonth.status === 409 && openMonth.json.code === 'PERIOD_OPEN' && failed.batch?.status === 'FAILED' && /mockFail/.test(failed.batch?.lastError || '') && retried.batch?.status === 'PUSHED' && !!retried.batch?.externalId && again.alreadyPushed === true && again.batch.externalId === retried.batch.externalId && c1.mode === 'PUSH' && c1.connection && !('credentials' in c1.connection) && c1.batches.length === 1 && c1.batches[0].attempts === 2 && ownerDenied.status === 403, { failed: failed.batch?.status, retried: retried.batch?.status, ext: retried.batch?.externalId });
    await call('DELETE', `/accounting/gl/connection?entity=${entity}`, undefined, A);
  }

  // ── 21.6-S forecast: seasonal / trend factor and promotion uplift
  {
    const offer = (await call('POST', `/organizations/${orgId}/offers`, { name: `Smoke C forecast promo ${stamp}`, automatic: true, kind: 'PERCENT', value: 500, locationIds: [hallLoc.id] }, O)).json;
    const factors = (await call('GET', `/kitchens/${kitchenId}/forecast/factors`, undefined, O)).json;
    const fc = (await call('GET', `/kitchens/${kitchenId}/forecast`, undefined, O)).json;
    if (offer?.id) await call('PATCH', `/organizations/${orgId}/offers/${offer.id}`, { kind: 'PERCENT', value: 500, automatic: true, isActive: false, locationIds: [hallLoc.id] }, O);
    const fc2 = (await call('GET', `/kitchens/${kitchenId}/forecast`, undefined, O)).json;
    const row = fc.find((r) => r.promotions?.includes(`Smoke C forecast promo ${stamp}`));
    const row2 = row && fc2.find((r) => r.ingredientId === row.ingredientId);
    check('21.6-S forecast shows seasonal factors and lifts demand for running promotions', factors.config?.promotions?.upliftPct > 0 && factors.promotions.some((p) => p.name === `Smoke C forecast promo ${stamp}`) && fc.every((r) => typeof r.seasonalFactor === 'number' && typeof r.trendFactor === 'number' && typeof r.yoyFactor === 'number') && row && row.promoUpliftPct >= factors.config.promotions.upliftPct && !row2.promotions.includes(`Smoke C forecast promo ${stamp}`), { promos: factors.promotions?.map((p) => p.name), uplift: row?.promoUpliftPct });
  }

  // ── 21.8-P supplier portal & EDI feed the three-way match
  {
    const items = (await call('GET', `/kitchens/${kitchenId}/inventory/items`, undefined, O)).json;
    const ing = items.find((i) => i.name === 'Ground beef') || items[0];
    const sup = (await call('POST', '/suppliers', { organizationId: orgId, name: `Smoke C Foods ${stamp}`, leadTimeDays: 2 }, O)).json;
    await call('POST', `/suppliers/${sup.id}/approval`, { approved: true, note: 'Smoke C approval' }, O);
    const receivedPo = async () => {
      const po = (await call('POST', `/kitchens/${kitchenId}/purchase-orders`, { supplier: '', supplierId: sup.id, lines: [{ ingredientId: ing.id, quantity: 2, unitCostCents: 900 }] }, O)).json;
      const line = (await call('GET', `/kitchens/${kitchenId}/purchase-orders`, undefined, O)).json.find((p) => p.id === po.id).lines[0];
      await call('POST', `/purchase-orders/${po.id}/receive`, { received: [{ lineId: line.id, receivedQty: 2, lotCode: `C-${stamp}-${po.id.slice(0, 4)}`, expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString() }] }, O);
      return po;
    };
    const po1 = await receivedPo();
    const po2 = await receivedPo();
    const tok = (await call('POST', `/suppliers/${sup.id}/portal-tokens`, { label: 'Smoke AP' }, O)).json;
    const H = (t) => ({ 'x-supplier-token': t });
    const bad = await call('GET', '/supplier-portal', undefined, undefined, H('sup_nope'));
    const view = (await call('GET', '/supplier-portal', undefined, undefined, H(tok.token))).json;
    const edi = ['ISA*00*          *00*          *ZZ*SMOKESUP       *ZZ*GUTAD          *261114*1200*U*00401*000000001*0*T*>', 'GS*IN*SMOKESUP*GUTAD*20261114*1200*1*X*004010', 'ST*810*0001', `BIG*20261114*INV-${stamp}-1**${po1.id}`, `IT1*1*2*KG*9.00**VP*${ing.id}`, 'TDS*1800', 'SE*5*0001', 'GE*1*1', 'IEA*1*000000001'].join('~') + '~';
    const ediRes = (await call('POST', '/supplier-portal/edi', { format: 'edi810', document: edi }, undefined, H(tok.token))).json;
    const form = (await call('POST', '/supplier-portal/invoices', { purchaseOrderId: po2.id, invoiceNumber: `INV-${stamp}-2`, lines: [{ ingredientId: ing.id, quantity: 2, unitCostCents: 1200 }] }, undefined, H(tok.token))).json;
    const csv = (await call('POST', '/supplier-portal/edi', { format: 'csv', document: `po,invoice_number,item,quantity,unit_price\n${uuid()},INV-${stamp}-3,${ing.name},1,9.00` }, undefined, H(tok.token))).json;
    const pos = (await call('GET', `/kitchens/${kitchenId}/purchase-orders`, undefined, O)).json;
    const m1 = pos.find((p) => p.id === po1.id), m2 = pos.find((p) => p.id === po2.id);
    await call('DELETE', `/supplier-portal-tokens/${tok.id}`, undefined, O);
    const revoked = await call('GET', '/supplier-portal', undefined, undefined, H(tok.token));
    const access = (await call('GET', `/suppliers/${sup.id}/portal-access`, undefined, O)).json;
    check('21.8-P supplier token portal and EDI 810 / CSV uploads feed the three-way match', !!tok.token && bad.status === 401 && view.supplier?.id === sup.id && view.purchaseOrders.some((p) => p.id === po1.id && p.canInvoice) && ediRes.results?.[0]?.status === 'MATCHED' && m1.matchStatus === 'MATCHED' && m1.invoiceNumber === `INV-${stamp}-1` && form.status === 'VARIANCE' && m2.matchStatus === 'VARIANCE' && csv.results?.[0]?.status === 'REJECTED' && revoked.status === 401 && access.submissions.length === 3 && access.tokens.some((t) => t.id === tok.id && !t.active), { edi: ediRes.results, form: form.status, csv: csv.results?.[0], revoked: revoked.status });
  }

  // ── 22.2-S wireless temperature sensors
  {
    const area = (await call('POST', `/kitchens/${kitchenId}/storage-areas`, { name: `Smoke C fridge ${stamp % 10000}`, kind: 'COLD' }, O)).json;
    const s1 = (await call('POST', `/kitchens/${kitchenId}/sensors`, { storageAreaId: area.id, name: `Fridge probe ${stamp % 10000}`, serial: 'SN-1', offlineAfterMinutes: 600 }, O)).json;
    const s2 = (await call('POST', `/kitchens/${kitchenId}/sensors`, { storageAreaId: area.id, name: `Spare probe ${stamp % 10000}`, offlineAfterMinutes: 30 }, O)).json;
    const H = (t) => ({ 'x-sensor-token': t });
    const unknown = await call('POST', '/sensors/readings', { tempC: 3 }, undefined, H('sens_nope'));
    const ok = (await call('POST', '/sensors/readings', { tempC: 3.5, batteryPct: 90 }, undefined, H(s1.token))).json;
    const warm = (await call('POST', '/sensors/readings', { readings: [{ tempC: 8.5 }, { tempC: 9.1 }] }, undefined, H(s1.token))).json;
    const temps = (await call('GET', `/kitchens/${kitchenId}/temperatures?days=1`, undefined, O)).json.filter((t) => t.storageAreaId === area.id);
    const actList = (await call('GET', `/corrective-actions?kitchenId=${kitchenId}&status=OPEN`, undefined, O)).json;
    check('22.2-S sensor readings become temperature logs with the out-of-range alert and corrective action', !!s1.token && unknown.status === 401 && ok.logged === 1 && ok.inRange === true && warm.outOfRange === 2 && warm.logged === 2 && temps.some((t) => t.inRange === false && /Fridge probe/.test(t.note || '')) && temps.some((t) => t.inRange === true) && actList.filter((a) => a.source === 'TEMPERATURE' && a.title.startsWith(`Fix ${area.name}:`)).length === 1, { ok, warm, temps: temps.length });
    const sweep = (await call('POST', '/admin/jobs/integrations-sweep', { at: new Date(Date.now() + 45 * 60_000).toISOString() }, A)).json;
    const list = (await call('GET', `/kitchens/${kitchenId}/sensors`, undefined, O)).json.sensors;
    const back = (await call('POST', '/sensors/readings', { tempC: 2 }, undefined, H(s2.token))).json;
    const list2 = (await call('GET', `/kitchens/${kitchenId}/sensors`, undefined, O)).json.sensors;
    const staff = (await call('GET', '/safety/sensors', undefined, A)).json;
    check('22.2-S silent sensors go offline with an alert; a reading brings them back; staff overview lists them', sweep.sensors?.offline >= 1 && list.find((x) => x.id === s2.id)?.isOnline === false && list.find((x) => x.id === s1.id)?.isOnline === true && back.accepted === 1 && list2.find((x) => x.id === s2.id)?.isOnline === true && staff.sensors?.some((x) => x.id === s1.id), { sweep: sweep.sensors, s2: list.find((x) => x.id === s2.id)?.isOnline });
    await call('DELETE', `/sensors/${s1.id}`, undefined, O);
    await call('DELETE', `/sensors/${s2.id}`, undefined, O);
    const retired = await call('POST', '/sensors/readings', { tempC: 3 }, undefined, H(s1.token));
    check('22.2-S a retired sensor can no longer post readings', retired.status === 401, retired.status);
  }

  // ── 23.3-P payroll provider push (mock adapter), per pay period
  {
    await call('POST', '/attendance/clock-out', { breakMinutes: 0 }, O); // in case an earlier phase left the owner clocked in
    await call('POST', '/attendance/clock-in', { locationId: hallLoc.id }, O);
    const out = (await call('POST', '/attendance/clock-out', { breakMinutes: 0 }, O)).json;
    await call('PATCH', `/time-entries/${out.id}`, { approve: true, clockInAt: new Date(Date.now() - 3 * 3600_000).toISOString(), note: 'Smoke C shift' }, A);
    const period = { periodStart: day(-1 - (stamp % 997)), periodEnd: day(2) };
    await call('DELETE', `/organizations/${orgId}/payroll/connection`, undefined, O);
    const none = await call('POST', `/locations/${hallLoc.id}/payroll/push`, period, O);
    const badGusto = await call('POST', `/organizations/${orgId}/payroll/connection`, { provider: 'GUSTO' }, O);
    await call('POST', `/organizations/${orgId}/payroll/connection`, { provider: 'MOCK', config: { mockFail: true } }, O);
    const failed = (await call('POST', `/locations/${hallLoc.id}/payroll/push`, period, O)).json;
    await call('POST', `/organizations/${orgId}/payroll/connection`, { provider: 'MOCK', config: { mockFail: false } }, O);
    const retried = (await call('POST', `/payroll-batches/${failed.batch?.id}/retry`, {}, O)).json;
    const again = (await call('POST', `/locations/${hallLoc.id}/payroll/push`, period, O)).json;
    const status = (await call('GET', `/locations/${hallLoc.id}/payroll/provider`, undefined, O)).json;
    const csv = await call('GET', `/locations/${hallLoc.id}/payroll.csv?from=${period.periodStart}&to=${period.periodEnd}`, undefined, O);
    check('23.3-P approved hours with overtime are pushed per pay period; failures retry; re-push is a no-op', none.status === 409 && none.json.code === 'PAYROLL_NOT_CONNECTED' && badGusto.status === 400 && failed.batch?.status === 'FAILED' && retried.batch?.status === 'PUSHED' && !!retried.batch.externalId && retried.batch.regularHours > 0 && typeof retried.batch.overtimeHours === 'number' && again.alreadyPushed === true && status.connection?.provider === 'MOCK' && status.batches.some((b) => b.id === failed.batch.id && b.status === 'PUSHED') && csv.status === 200, { failed: failed.batch?.lastError, retried: retried.batch?.status, hours: retried.batch?.regularHours });
  }

  // ── 23.8-V equipment vendor feeds: record & alert only
  {
    const eq = (await call('POST', '/equipment', { kitchenId, name: `Smoke C fryer ${stamp % 10000}`, kind: 'FRYER', isAutomated: true, softwareVersion: '5.0', serviceIntervalDays: 30 }, O)).json;
    const link = (await call('PUT', `/equipment/${eq.id}/vendor-link`, { vendor: 'MOCK', externalId: `FRY-${stamp}`, pollEnabled: true, config: { telemetryLimits: { oilTempC: { max: 190 } }, mockStatus: 'DOWN' } }, O)).json;
    const pushOnly = await call('PUT', `/equipment/${eq.id}/vendor-link`, { vendor: 'GENERIC', externalId: `FRY-${stamp}`, pollEnabled: true }, O);
    const H = (t) => ({ 'x-vendor-token': t });
    const unknown = await call('POST', '/equipment-vendor/events', { events: [{ kind: 'STATUS', status: 'OK' }] }, undefined, H('eqv_nope'));
    const at = new Date().toISOString();
    const first = (await call('POST', '/equipment-vendor/events', { events: [{ kind: 'TELEMETRY', metrics: { oilTempC: 205 }, at }, { id: `ev-${stamp}`, kind: 'FAULT', code: 'F12', severity: 'HIGH', message: 'Heating element fault', at }, { id: `mx-${stamp}`, kind: 'MAINTENANCE', code: 'SERVICE_DONE', message: 'Oil changed', at }] }, undefined, H(link.token))).json;
    const dup = (await call('POST', '/equipment-vendor/events', { events: [{ id: `ev-${stamp}`, kind: 'FAULT', code: 'F12', severity: 'HIGH', message: 'Heating element fault' }] }, undefined, H(link.token))).json;
    const polled = (await call('POST', `/equipment/${eq.id}/vendor-link/poll`, {}, O)).json;
    const view = (await call('GET', `/equipment/${eq.id}/vendor-link`, undefined, O)).json;
    const eqNow = (await call('GET', `/equipment?kitchenId=${kitchenId}`, undefined, O)).json.find((e) => e.id === eq.id);
    const tickets = (await call('GET', `/equipment/${eq.id}/tickets`, undefined, O)).json;
    check('23.8-V vendor telemetry, faults and maintenance are recorded and alerted; status is pulled; nothing is actuated', !!link.token && pushOnly.status === 400 && unknown.status === 401 && first.accepted === 3 && first.tickets === 1 && first.alerts >= 2 && dup.duplicates === 1 && dup.accepted === 0 && polled.status === 'DOWN' && view.link?.lastStatus?.status === 'DOWN' && view.events.length >= 4 && eqNow.status === 'OK' && !!eqNow.lastServiceAt && tickets.filter((t) => t.faultCode === 'F12').length === 1, { first, dup, polled: polled.status, eqStatus: eqNow?.status });
    await call('DELETE', `/equipment/${eq.id}/vendor-link`, undefined, O);
  }
}
