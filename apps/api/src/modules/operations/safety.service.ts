import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { DEFAULT_CHECKLISTS, DEFAULT_TEMP_RANGES } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { checklistRuns, checklistTemplates, correctiveActions, incidents, ingredients, inspections, kitchens, locations, menuItems, opsAlerts, orders, recalls, stockLots, stockMovements, storageAreas, temperatureLogs } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import { KitchenService } from '../kitchen/kitchen.service';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const alert = (v: { type: string; severity: string; title: string; detail: string; subjectType: string; subjectId: string; organizationId?: string | null; locationId?: string | null; dedupeKey: string; ownerRole: string; minutes: number }) =>
  ({ type: v.type, severity: v.severity, title: v.title, detail: v.detail, subjectType: v.subjectType, subjectId: v.subjectId, organizationId: v.organizationId ?? null, locationId: v.locationId ?? null, dedupeKey: v.dedupeKey, ownerRole: v.ownerRole, escalateAt: new Date(Date.now() + v.minutes * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: v.detail.slice(0, 120) }] });

/** Phase I, section 22: food safety, quality and recalls. */
@Injectable()
export class SafetyService {
  constructor(@Inject(DB) private readonly db: Db, private readonly kitchen: KitchenService, private readonly audit: AuditService, private readonly outbox: OutboxService) {}

  private k(user: JwtPayload, kitchenId: string) { return this.kitchen.requireKitchen(user, kitchenId); }

  private async action(input: { source: string; sourceId?: string | null; kitchenId?: string | null; locationId?: string | null; title: string; dueHours: number; ownerId?: string | null }) {
    const [a] = await this.db.insert(correctiveActions).values({ source: input.source, sourceId: input.sourceId ?? null, kitchenId: input.kitchenId ?? null, locationId: input.locationId ?? null, title: input.title, ownerId: input.ownerId ?? null, dueAt: new Date(Date.now() + input.dueHours * 3600_000) }).returning();
    return a;
  }

  // 22.2 temperatures
  async logTemperature(user: JwtPayload, kitchenId: string, input: { kind: 'RECEIVING' | 'STORAGE' | 'HOT_HOLD' | 'COOLING'; tempC: number; storageAreaId?: string; lotId?: string; purchaseOrderId?: string; ingredientId?: string; note?: string }) {
    const k = await this.k(user, kitchenId);
    return this.recordTemperature(k, input, user.sub);
  }

  /** The reading itself, with the out-of-range alert and corrective action (staff entry, or a wireless sensor: 22.2-S). */
  async recordTemperature(k: { id: string; name: string; organizationId: string }, input: { kind: 'RECEIVING' | 'STORAGE' | 'HOT_HOLD' | 'COOLING'; tempC: number; storageAreaId?: string; lotId?: string; purchaseOrderId?: string; ingredientId?: string; note?: string }, recordedById: string | null, opts: { alertKey?: string } = {}) {
    const kitchenId = k.id;
    let min: number | null = null, max: number | null = null, label = input.kind.toLowerCase().replace('_', ' ');
    if (input.storageAreaId) {
      const [a] = await this.db.select().from(storageAreas).where(and(eq(storageAreas.id, input.storageAreaId), eq(storageAreas.kitchenId, kitchenId))).limit(1);
      if (!a) throw new NotFoundException('Storage area not found');
      min = a.minTempC ?? DEFAULT_TEMP_RANGES[a.kind]?.min ?? null; max = a.maxTempC ?? DEFAULT_TEMP_RANGES[a.kind]?.max ?? null; label = a.name;
    }
    const ingId = input.ingredientId ?? (input.lotId ? (await this.db.select({ i: stockLots.ingredientId }).from(stockLots).where(eq(stockLots.id, input.lotId)).limit(1))[0]?.i : undefined);
    if (ingId && min === null && max === null) {
      const [ing] = await this.db.select().from(ingredients).where(eq(ingredients.id, ingId)).limit(1);
      if (ing) { min = ing.minTempC; max = ing.maxTempC; label = `${ing.name} (${label})`; }
    }
    if (min === null && max === null) { const d = DEFAULT_TEMP_RANGES[input.kind] ?? (input.kind === 'RECEIVING' ? DEFAULT_TEMP_RANGES.RECEIVING_COLD : null); min = d?.min ?? null; max = d?.max ?? null; }
    const inRange = (min === null || input.tempC >= min) && (max === null || input.tempC <= max);
    const [log] = await this.db.insert(temperatureLogs).values({ kitchenId, storageAreaId: input.storageAreaId ?? null, lotId: input.lotId ?? null, purchaseOrderId: input.purchaseOrderId ?? null, kind: input.kind, tempC: input.tempC, minC: min, maxC: max, inRange, note: input.note ?? null, recordedById }).returning();
    let quarantined = false;
    if (!inRange) {
      const range = `${min ?? '—'}…${max ?? '—'} °C`;
      await this.db.insert(opsAlerts).values(alert({ type: 'FOOD_SAFETY_TEMP', severity: 'HIGH', title: `Temperature out of range: ${label}`, detail: `${input.tempC} °C recorded (safe ${range}) at ${k.name}.`, subjectType: 'kitchen', subjectId: kitchenId, organizationId: k.organizationId, dedupeKey: opts.alertKey ?? `temp:${log.id}`, ownerRole: 'CULINARY', minutes: 30 })).onConflictDoNothing();
      // a sensor stays out of range for many readings: one open alert and one corrective action per excursion
      if (!opts.alertKey || !(await this.db.select({ id: correctiveActions.id }).from(correctiveActions).innerJoin(temperatureLogs, eq(temperatureLogs.id, correctiveActions.sourceId)).where(and(eq(correctiveActions.source, 'TEMPERATURE'), eq(temperatureLogs.storageAreaId, input.storageAreaId ?? ''), sql`${correctiveActions.completedAt} is null`)).limit(1)).length) await this.action({ source: 'TEMPERATURE', sourceId: log.id, kitchenId, title: `Fix ${label}: ${input.tempC} °C (safe ${range}); re-check and discard affected food if needed`, dueHours: 2 });
      // goods received out of range are quarantined until someone decides
      if (input.lotId && input.kind === 'RECEIVING') { await this.db.update(stockLots).set({ status: 'QUARANTINED' }).where(and(eq(stockLots.id, input.lotId), eq(stockLots.status, 'AVAILABLE'))); quarantined = true; }
    }
    return { ...log, quarantined };
  }

  async temperatures(user: JwtPayload, kitchenId: string, days = 7) {
    await this.k(user, kitchenId);
    return this.db.select({ t: temperatureLogs, area: storageAreas.name }).from(temperatureLogs).leftJoin(storageAreas, eq(storageAreas.id, temperatureLogs.storageAreaId)).where(and(eq(temperatureLogs.kitchenId, kitchenId), gte(temperatureLogs.createdAt, new Date(Date.now() - days * 86400_000)))).orderBy(desc(temperatureLogs.createdAt)).limit(300).then((r) => r.map((x) => ({ ...x.t, storageArea: x.area })));
  }

  // 22.3 checklists
  async templates(user: JwtPayload, organizationId: string) {
    assertOrgAccess(user, organizationId);
    let list = await this.db.select().from(checklistTemplates).where(and(or(eq(checklistTemplates.organizationId, organizationId), isNull(checklistTemplates.organizationId)), eq(checklistTemplates.isActive, true)));
    if (!list.some((t) => t.organizationId === null)) {
      await this.db.insert(checklistTemplates).values(DEFAULT_CHECKLISTS.map((d) => ({ organizationId: null, name: d.name, kind: d.kind, frequency: d.frequency, items: d.items as unknown as Record<string, unknown>[] })));
      list = await this.db.select().from(checklistTemplates).where(and(or(eq(checklistTemplates.organizationId, organizationId), isNull(checklistTemplates.organizationId)), eq(checklistTemplates.isActive, true)));
    }
    return list;
  }

  async upsertTemplate(user: JwtPayload, input: { id?: string; organizationId: string; name: string; kind: string; frequency: string; items: { key: string; label: string; requiresValue?: boolean }[] }) {
    assertOrgAccess(user, input.organizationId, null, MANAGER_ROLES);
    if (input.id) { const [u] = await this.db.update(checklistTemplates).set({ name: input.name, kind: input.kind, frequency: input.frequency, items: input.items }).where(and(eq(checklistTemplates.id, input.id), eq(checklistTemplates.organizationId, input.organizationId))).returning(); if (!u) throw new NotFoundException(); return u; }
    const [r] = await this.db.insert(checklistTemplates).values({ organizationId: input.organizationId, name: input.name, kind: input.kind, frequency: input.frequency, items: input.items }).returning();
    return r;
  }

  /** A signed completion; unticked items raise a corrective action. */
  async runChecklist(user: JwtPayload, input: { templateId: string; kitchenId?: string; locationId?: string; answers: { key: string; done: boolean; value?: string; note?: string }[]; signedName: string }) {
    const [t] = await this.db.select().from(checklistTemplates).where(eq(checklistTemplates.id, input.templateId)).limit(1);
    if (!t) throw new NotFoundException();
    if (input.kitchenId) await this.k(user, input.kitchenId);
    else if (input.locationId) { const [l] = await this.db.select().from(locations).where(eq(locations.id, input.locationId)).limit(1); if (!l) throw new NotFoundException(); assertOrgAccess(user, l.organizationId, l.id); }
    else throw new BadRequestException('Say which kitchen or location this is for');
    const items = t.items as { key: string; label: string; requiresValue?: boolean }[];
    const missing = items.filter((i) => { const a = input.answers.find((x) => x.key === i.key); return !a?.done || (i.requiresValue && !a.value); });
    const [run] = await this.db.insert(checklistRuns).values({ templateId: t.id, kitchenId: input.kitchenId ?? null, locationId: input.locationId ?? null, answers: input.answers, missedItems: missing.length, signedName: input.signedName, completedById: user.sub }).returning();
    if (missing.length) await this.action({ source: 'CHECKLIST', sourceId: run.id, kitchenId: input.kitchenId, locationId: input.locationId, title: `${t.name} checklist: ${missing.map((m) => m.label).join('; ')}`, dueHours: 4 });
    return { ...run, missing: missing.map((m) => m.label) };
  }

  async checklistHistory(user: JwtPayload, f: { kitchenId?: string; locationId?: string; days?: number }) {
    if (f.kitchenId) await this.k(user, f.kitchenId);
    else if (f.locationId) { const [l] = await this.db.select().from(locations).where(eq(locations.id, f.locationId)).limit(1); if (!l) throw new NotFoundException(); assertOrgAccess(user, l.organizationId, l.id); }
    else assertCan(user, 'kitchens.read', 'culinary.manage');
    return this.db.select({ r: checklistRuns, name: checklistTemplates.name, kind: checklistTemplates.kind }).from(checklistRuns).innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistRuns.templateId)).where(and(...(f.kitchenId ? [eq(checklistRuns.kitchenId, f.kitchenId)] : []), ...(f.locationId ? [eq(checklistRuns.locationId, f.locationId)] : []), gte(checklistRuns.completedAt, new Date(Date.now() - (f.days || 7) * 86400_000)))).orderBy(desc(checklistRuns.completedAt)).limit(200).then((r) => r.map((x) => ({ ...x.r, template: x.name, kind: x.kind })));
  }

  // 22.4 allergen review sign-off (recipe changes flag menu items, 8.8)
  async allergenReviews(user: JwtPayload, organizationId?: string) {
    if (organizationId) assertOrgAccess(user, organizationId); else assertCan(user, 'culinary.manage', 'catalog.read');
    return rows<{ id: string; name: string; allergens: string[]; location: string; organization_id: string }>(await this.db.execute(sql`select mi.id, mi.name, mi.allergens, l.name as location, m.organization_id from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id left join locations l on l.id = m.location_id where mi.allergen_review_needed ${organizationId ? sql`and m.organization_id = ${organizationId}` : sql``} order by l.name, mi.name limit 300`));
  }

  async signOffAllergens(user: JwtPayload, itemId: string, input: { allergens: string[]; note: string }) {
    const r = rows<{ org: string; loc: string | null }>(await this.db.execute(sql`select m.organization_id as org, m.location_id as loc from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id where mi.id = ${itemId}`))[0];
    if (!r) throw new NotFoundException();
    if (!isPlatformStaff(user)) assertOrgAccess(user, r.org, r.loc, MANAGER_ROLES); else assertCan(user, 'culinary.manage');
    const [before] = await this.db.select({ allergens: menuItems.allergens }).from(menuItems).where(eq(menuItems.id, itemId));
    await this.db.update(menuItems).set({ allergens: input.allergens, allergenReviewNeeded: false }).where(eq(menuItems.id, itemId));
    await this.audit.log({ organizationId: r.org, actorId: user.sub, action: 'allergen.sign_off', entityType: 'menu_item', entityId: itemId, before, after: { allergens: input.allergens }, reason: input.note });
    return { ok: true };
  }

  // 22.5 traceability
  async traceLot(user: JwtPayload, lotId: string) {
    const [lot] = await this.db.select({ l: stockLots, ing: ingredients.name }).from(stockLots).innerJoin(ingredients, eq(ingredients.id, stockLots.ingredientId)).where(eq(stockLots.id, lotId)).limit(1);
    if (!lot) throw new NotFoundException();
    await this.k(user, lot.l.kitchenId);
    const moves = await this.db.select().from(stockMovements).where(eq(stockMovements.lotId, lotId)).orderBy(stockMovements.createdAt);
    const orderIds = [...new Set(moves.map((m) => m.orderId).filter((x): x is string => !!x))];
    const os = orderIds.length ? await this.db.select({ id: orders.id, number: orders.number, createdAt: orders.createdAt, location: locations.name, userId: orders.userId, guestEmail: orders.guestEmail }).from(orders).innerJoin(locations, eq(locations.id, orders.locationId)).where(inArray(orders.id, orderIds)) : [];
    // the same lot code may have travelled to other kitchens by transfer
    const linked = await this.db.select({ id: stockLots.id, kitchenId: stockLots.kitchenId, quantity: stockLots.quantity, status: stockLots.status }).from(stockLots).where(and(eq(stockLots.lotCode, lot.l.lotCode), eq(stockLots.ingredientId, lot.l.ingredientId)));
    return { lot: { ...lot.l, ingredient: lot.ing }, movements: moves, orders: os.map((o) => ({ ...o, customer: !!(o.userId || o.guestEmail) })), linkedLots: linked, locations: [...new Set(os.map((o) => o.location))] };
  }

  async traceOrder(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    assertOrgAccess(user, o.organizationId, o.locationId);
    const r = rows<{ lot_id: string | null; lot_code: string | null; ingredient: string; quantity: number; expires_at: string | null; supplier: string | null }>(await this.db.execute(sql`select m.lot_id, l.lot_code, i.name as ingredient, -m.quantity as quantity, l.expires_at, s.name as supplier from stock_movements m join ingredients i on i.id = m.ingredient_id left join stock_lots l on l.id = m.lot_id left join suppliers s on s.id = l.supplier_id where m.order_id = ${orderId} and m.kind = 'CONSUMPTION'`));
    return { orderId, number: o.number, lots: r };
  }

  // 22.6 recalls
  async recallsList(user: JwtPayload) { assertCan(user, 'culinary.manage', 'kitchens.read'); return this.db.select().from(recalls).orderBy(desc(recalls.createdAt)).limit(100); }

  /** Open a recall: quarantine the lots, stop-sell the menu items that use the ingredient where those lots are, count affected orders. */
  async openRecall(user: JwtPayload, input: { title: string; reason: string; severity?: string; ingredientId?: string; supplierId?: string; lotIds?: string[] }) {
    let lotRows = input.lotIds?.length ? await this.db.select().from(stockLots).where(inArray(stockLots.id, input.lotIds)) : input.ingredientId ? await this.db.select().from(stockLots).where(and(eq(stockLots.ingredientId, input.ingredientId), ...(input.supplierId ? [eq(stockLots.supplierId, input.supplierId)] : []))) : [];
    if (!lotRows.length) throw new BadRequestException('No lots match this recall');
    const kitchenIds = [...new Set(lotRows.map((l) => l.kitchenId))];
    if (!isPlatformStaff(user)) { for (const kid of kitchenIds) await this.k(user, kid); } else assertCan(user, 'culinary.manage', 'kitchens.manage');
    const ids = lotRows.map((l) => l.id);
    const ingIds = [...new Set(lotRows.map((l) => l.ingredientId))];
    return this.db.transaction(async (tx) => {
      await tx.update(stockLots).set({ status: 'QUARANTINED' }).where(and(inArray(stockLots.id, ids), inArray(stockLots.status, ['AVAILABLE'])));
      const items: string[] = [];
      for (const kid of kitchenIds) items.push(...(await this.kitchen.itemsUsingIngredient(tx, kid, ingIds)));
      const stop = [...new Set(items)];
      if (stop.length) await tx.update(menuItems).set({ soldOut: true, soldOutUntil: null, soldOutSource: 'RECALL' }).where(and(inArray(menuItems.id, stop), eq(menuItems.soldOut, false)));
      const [{ n }] = rows<{ n: number }>(await tx.execute(sql`select count(distinct order_id)::int as n from stock_movements where lot_id = any(${'{' + ids.join(',') + '}'}::uuid[]) and order_id is not null`));
      const [r] = await tx.insert(recalls).values({ title: input.title, reason: input.reason, severity: input.severity || 'HIGH', ingredientId: input.ingredientId ?? lotRows[0].ingredientId, supplierId: input.supplierId ?? null, lotIds: ids, status: 'QUARANTINED', affectedMenuItemIds: stop, affectedOrderCount: n, createdById: user.sub }).returning();
      const [k0] = await tx.select().from(kitchens).where(eq(kitchens.id, kitchenIds[0])).limit(1);
      await tx.insert(opsAlerts).values(alert({ type: 'RECALL', severity: 'CRITICAL', title: `Recall: ${input.title}`, detail: `${ids.length} lot(s) quarantined, ${stop.length} menu item(s) stopped, ${n} order(s) affected. ${input.reason}`, subjectType: 'recall', subjectId: r.id, organizationId: k0?.organizationId, dedupeKey: `recall:${r.id}`, ownerRole: 'CULINARY', minutes: 15 })).onConflictDoNothing();
      await this.audit.log({ actorId: user.sub, action: 'recall.open', entityType: 'recall', entityId: r.id, after: { lots: ids.length, items: stop.length, orders: n }, reason: input.reason }, tx);
      return r;
    });
  }

  /** Withdraw: remaining stock of the recalled lots is removed (WITHDRAWAL movements). */
  async withdrawRecall(user: JwtPayload, id: string) {
    const [r] = await this.db.select().from(recalls).where(eq(recalls.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    if (r.status === 'CLOSED') throw new ConflictException('Recall is closed');
    const lots = await this.db.select().from(stockLots).where(inArray(stockLots.id, r.lotIds));
    if (!isPlatformStaff(user)) for (const kid of new Set(lots.map((l) => l.kitchenId))) await this.k(user, kid);
    await this.db.transaction(async (tx) => {
      for (const l of lots) { if (l.quantity > 0) await this.kitchen.takeFromLots(tx, { kitchenId: l.kitchenId, ingredientId: l.ingredientId, quantity: l.quantity, kind: 'WITHDRAWAL', lotId: l.id, referenceId: r.id, reason: `Recall: ${r.title}`, createdById: user.sub }); await tx.update(stockLots).set({ status: 'WITHDRAWN' }).where(eq(stockLots.id, l.id)); }
      await tx.update(recalls).set({ status: 'WITHDRAWN' }).where(eq(recalls.id, id));
    });
    return { ok: true, lots: lots.length };
  }

  /** Tell the customers whose orders used the recalled lots. */
  async notifyRecallCustomers(user: JwtPayload, id: string, message: string) {
    assertCan(user, 'culinary.manage', 'support.manage');
    const [r] = await this.db.select().from(recalls).where(eq(recalls.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    const os = rows<{ id: string; number: string }>(await this.db.execute(sql`select distinct o.id, o.number from stock_movements m join orders o on o.id = m.order_id where m.lot_id = any(${'{' + r.lotIds.join(',') + '}'}::uuid[])`));
    for (const o of os) await this.outbox.publish('recall.notice', o.id, { orderId: o.id, number: o.number, title: r.title, message });
    await this.db.update(recalls).set({ customersNotifiedAt: new Date() }).where(eq(recalls.id, id));
    await this.audit.log({ actorId: user.sub, action: 'recall.notify', entityType: 'recall', entityId: id, after: { orders: os.length }, reason: message });
    return { notifiedOrders: os.length };
  }

  /** Close: stopped items come back (unless stopped for another reason); lots stay withdrawn or quarantined. */
  async closeRecall(user: JwtPayload, id: string, note: string) {
    assertCan(user, 'culinary.manage', 'kitchens.manage');
    const [r] = await this.db.select().from(recalls).where(eq(recalls.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    if (r.affectedMenuItemIds.length) await this.db.update(menuItems).set({ soldOut: false, soldOutSource: null }).where(and(inArray(menuItems.id, r.affectedMenuItemIds), eq(menuItems.soldOutSource, 'RECALL')));
    const [u] = await this.db.update(recalls).set({ status: 'CLOSED', closedAt: new Date(), closedNote: note }).where(eq(recalls.id, id)).returning();
    await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: note }).where(eq(opsAlerts.dedupeKey, `recall:${id}`));
    await this.audit.log({ actorId: user.sub, action: 'recall.close', entityType: 'recall', entityId: id, reason: note });
    return u;
  }

  // 22.7 illness / food-quality escalation
  async foodSafetyCases(user: JwtPayload) {
    assertCan(user, 'culinary.manage', 'support.read');
    return rows<Record<string, unknown>>(await this.db.execute(sql`select i.id, i.status, i.priority, i.description, i.created_at, i.order_id, o.number, l.name as location, mi.name as item from incidents i left join orders o on o.id = i.order_id left join locations l on l.id = o.location_id left join menu_items mi on mi.id = i.menu_item_id where i.category = 'FOOD_SAFETY' and i.created_at > now() - interval '30 days' order by i.created_at desc limit 100`));
  }

  /** Two or more food-safety reports for one location (or one dish) within 72 hours raise a possible-cluster alert. */
  async clusterSweep() {
    const c = rows<{ location_id: string; location: string; org: string; item: string | null; n: number }>(await this.db.execute(sql`select o.location_id, l.name as location, l.organization_id as org, mi.name as item, count(*)::int as n from incidents i join orders o on o.id = i.order_id join locations l on l.id = o.location_id left join menu_items mi on mi.id = i.menu_item_id
      where i.category = 'FOOD_SAFETY' and i.created_at > now() - interval '72 hours' group by 1, 2, 3, 4 having count(*) >= 2`));
    for (const x of c) await this.db.insert(opsAlerts).values(alert({ type: 'FOOD_SAFETY_CLUSTER', severity: 'CRITICAL', title: `Possible illness cluster at ${x.location}`, detail: `${x.n} food-safety reports in 72 hours${x.item ? ` for ${x.item}` : ''}. Trace the lots used and consider a quarantine.`, subjectType: 'location', subjectId: x.location_id, organizationId: x.org, locationId: x.location_id, dedupeKey: `cluster:${x.location_id}:${x.item ?? ''}`, ownerRole: 'CULINARY', minutes: 10 })).onConflictDoNothing();
    return { clusters: c.length };
  }

  // 22.8 inspections & corrective actions
  async addInspection(user: JwtPayload, input: { kitchenId?: string; locationId?: string; kind: string; inspector: string; score?: number; result: string; findings: { code?: string; finding: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' }[]; reportUrl?: string; inspectedAt?: string }) {
    if (input.kitchenId) await this.k(user, input.kitchenId);
    else if (input.locationId) { const [l] = await this.db.select().from(locations).where(eq(locations.id, input.locationId)).limit(1); if (!l) throw new NotFoundException(); assertOrgAccess(user, l.organizationId, l.id); }
    else throw new BadRequestException('Say which kitchen or location was inspected');
    const [ins] = await this.db.insert(inspections).values({ kitchenId: input.kitchenId ?? null, locationId: input.locationId ?? null, kind: input.kind, inspector: input.inspector, score: input.score ?? null, result: input.result, findings: input.findings, reportUrl: input.reportUrl ?? null, inspectedAt: input.inspectedAt ? new Date(input.inspectedAt) : new Date(), createdById: user.sub }).returning();
    const actions = [];
    for (const f of input.findings.filter((x) => x.severity !== 'LOW' || input.result === 'FAIL')) actions.push(await this.action({ source: 'INSPECTION', sourceId: ins.id, kitchenId: input.kitchenId, locationId: input.locationId, title: f.finding, dueHours: f.severity === 'HIGH' ? 24 : 72 }));
    return { inspection: ins, correctiveActions: actions };
  }

  async inspectionsList(user: JwtPayload, f: { kitchenId?: string; locationId?: string }) {
    if (f.kitchenId) await this.k(user, f.kitchenId); else if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select().from(inspections).where(f.kitchenId ? eq(inspections.kitchenId, f.kitchenId) : f.locationId ? eq(inspections.locationId, f.locationId) : sql`true`).orderBy(desc(inspections.inspectedAt)).limit(100);
  }

  async actions(user: JwtPayload, f: { kitchenId?: string; status?: string }) {
    if (f.kitchenId) await this.k(user, f.kitchenId); else assertCan(user, 'culinary.manage', 'kitchens.read');
    const now = Date.now();
    const list = await this.db.select().from(correctiveActions).where(and(...(f.kitchenId ? [eq(correctiveActions.kitchenId, f.kitchenId)] : []), ...(f.status ? [eq(correctiveActions.status, f.status)] : []))).orderBy(correctiveActions.dueAt).limit(300);
    return list.map((a) => ({ ...a, overdue: a.status === 'OPEN' && !!a.dueAt && a.dueAt.getTime() < now }));
  }

  private async requireAction(user: JwtPayload, id: string) {
    const [a] = await this.db.select().from(correctiveActions).where(eq(correctiveActions.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    if (a.kitchenId) await this.k(user, a.kitchenId); else if (a.locationId) { const [l] = await this.db.select().from(locations).where(eq(locations.id, a.locationId)).limit(1); assertOrgAccess(user, l!.organizationId, l!.id); }
    return a;
  }

  async completeAction(user: JwtPayload, id: string, input: { evidenceUrl?: string; evidenceNote: string }) {
    const a = await this.requireAction(user, id);
    if (a.status !== 'OPEN') throw new ConflictException('Already completed');
    const [u] = await this.db.update(correctiveActions).set({ status: 'DONE', evidenceUrl: input.evidenceUrl ?? null, evidenceNote: input.evidenceNote, completedById: user.sub, completedAt: new Date() }).where(eq(correctiveActions.id, id)).returning();
    return u;
  }

  /** A second person verifies the evidence. */
  async verifyAction(user: JwtPayload, id: string) {
    const a = await this.requireAction(user, id);
    if (a.status !== 'DONE') throw new ConflictException('Complete the action first');
    if (a.completedById === user.sub) throw new ForbiddenException('Someone other than the person who did it must verify');
    const [u] = await this.db.update(correctiveActions).set({ status: 'VERIFIED', verifiedById: user.sub, verifiedAt: new Date() }).where(eq(correctiveActions.id, id)).returning();
    return u;
  }

  /** Cross-kitchen safety overview for Gutad food safety. */
  async overview(user: JwtPayload) {
    assertCan(user, 'culinary.manage', 'kitchens.read');
    const temps = rows<{ kitchen: string; out: number; total: number }>(await this.db.execute(sql`select k.name as kitchen, count(*) filter (where not t.in_range)::int as out, count(*)::int as total from temperature_logs t join kitchens k on k.id = t.kitchen_id where t.created_at > now() - interval '7 days' group by 1 order by 2 desc`));
    const acts = rows<{ open: number; overdue: number; done: number }>(await this.db.execute(sql`select count(*) filter (where status = 'OPEN')::int as open, count(*) filter (where status = 'OPEN' and due_at < now())::int as overdue, count(*) filter (where status = 'DONE')::int as done from corrective_actions`))[0];
    const checks = rows<{ runs: number; missed: number }>(await this.db.execute(sql`select count(*)::int as runs, coalesce(sum(missed_items),0)::int as missed from checklist_runs where created_at > now() - interval '7 days'`))[0];
    const open = await this.db.select().from(recalls).where(sql`${recalls.status} <> 'CLOSED'`);
    const [fs] = await this.db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(and(eq(incidents.category, 'FOOD_SAFETY'), sql`${incidents.status} in ('OPEN','INVESTIGATING')`));
    const allergen = rows<{ n: number }>(await this.db.execute(sql`select count(*)::int as n from menu_items where allergen_review_needed`))[0];
    return { temperatures: temps, correctiveActions: acts, checklists7d: checks, openRecalls: open, openFoodSafetyTickets: fs.n, allergenReviews: allergen.n };
  }
}
