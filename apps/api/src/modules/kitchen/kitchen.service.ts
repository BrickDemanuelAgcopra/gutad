import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { brands, ingredientStock, ingredients, kitchenBrands, kitchenTickets, kitchens, laborEntries, locations, menuItems, orderLines, orders, packingTasks, purchaseOrderLines, purchaseOrders, recipeLines, recipes, stations, wasteEvents } from '../../db/schema';
import { assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { shortCode } from '../../common/utils';
import { ApprovalsService } from '../security/approvals.service';
import { AuditService } from '../../core/audit.service';

@Injectable()
export class KitchenService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly outbox: OutboxService, private readonly approvals: ApprovalsService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.approvals.register('PURCHASE_ORDER', {
      execute: async (req) => {
        const [po] = await this.db.update(purchaseOrders).set({ status: 'ORDERED' }).where(and(eq(purchaseOrders.id, req.subjectId), eq(purchaseOrders.status, 'PENDING_APPROVAL'))).returning();
        return po || (await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, req.subjectId)))[0];
      },
      // the kitchen's owner (or a manager) may approve a purchase raised by their own staff
      canDecide: (user, req) => !!req.organizationId && !!user.orgs?.[req.organizationId]?.roles.some((r) => r === 'MERCHANT_OWNER' || r === 'MERCHANT_MANAGER'),
    });
  }

  // ───── kitchens, stations, brands ─────

  async createKitchen(user: JwtPayload, orgId: string, input: { name: string; addressLine1: string; city: string; region: string; postalCode: string; lat?: number; lng?: number; isShared?: boolean; stations?: { code: string; name: string }[] }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    return this.db.transaction(async (tx) => {
      const [k] = await tx.insert(kitchens).values({ ...input, organizationId: orgId }).returning();
      const st = input.stations?.length ? input.stations : [{ code: 'GRILL', name: 'Grill' }, { code: 'COLD', name: 'Cold' }, { code: 'FRY', name: 'Fry' }, { code: 'PACK', name: 'Packing' }];
      await tx.insert(stations).values(st.map((s) => ({ ...s, kitchenId: k.id })));
      return k;
    });
  }

  async linkBrand(user: JwtPayload, kitchenId: string, brandId: string, isActive = true) {
    const k = await this.requireKitchen(user, kitchenId);
    const [b] = await this.db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
    if (!b) throw new NotFoundException('Brand not found');
    await this.db.insert(kitchenBrands).values({ kitchenId: k.id, brandId, isActive }).onConflictDoUpdate({ target: [kitchenBrands.kitchenId, kitchenBrands.brandId], set: { isActive } });
    return { ok: true };
  }

  private async requireKitchen(user: JwtPayload, kitchenId: string) {
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, kitchenId)).limit(1);
    if (!k) throw new NotFoundException('Kitchen not found');
    assertOrgAccess(user, k.organizationId);
    return k;
  }

  async overview(user: JwtPayload, kitchenId: string) {
    const k = await this.requireKitchen(user, kitchenId);
    const st = await this.db.select().from(stations).where(eq(stations.kitchenId, kitchenId));
    const kb = await this.db.select({ brand: brands, isActive: kitchenBrands.isActive }).from(kitchenBrands).innerJoin(brands, eq(brands.id, kitchenBrands.brandId)).where(eq(kitchenBrands.kitchenId, kitchenId));
    const locs = await this.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.kitchenId, kitchenId));
    return { ...k, stations: st, brands: kb, locations: locs };
  }

  /** Brands eligible at the kitchen behind a location — used by the multi-brand cart. */
  async eligibleBrands(locationId: string, tx: DbOrTx = this.db) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc?.kitchenId) return [];
    const rows = await tx.select({ brand: brands }).from(kitchenBrands).innerJoin(brands, eq(brands.id, kitchenBrands.brandId)).where(and(eq(kitchenBrands.kitchenId, loc.kitchenId), eq(kitchenBrands.isActive, true)));
    return rows.map((r) => r.brand);
  }

  // ───── production: tickets, packing ─────

  /**
   * Fan a (possibly multi-brand) accepted order out to station tickets. For single-station restaurants
   * a single ticket is created. Called by OrdersService inside the acceptance transaction.
   */
  async fanOut(orderId: string, tx: DbOrTx = this.db) {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    const existing = await tx.select().from(kitchenTickets).where(eq(kitchenTickets.orderId, orderId));
    if (existing.length) return existing; // no duplicate kitchen ticket on retry
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const [loc] = await tx.select().from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const stationRows = loc?.kitchenId ? await tx.select().from(stations).where(eq(stations.kitchenId, loc.kitchenId)) : [];
    const groups = new Map<string, string[]>();
    for (const l of lines) {
      const code = l.stationCode || 'MAIN';
      groups.set(code, [...(groups.get(code) || []), l.id]);
    }
    const tickets = await tx
      .insert(kitchenTickets)
      .values(Array.from(groups.entries()).map(([code, lineIds]) => ({ orderId, stationCode: code, stationId: stationRows.find((s) => s.code === code)?.id ?? null, lineIds })))
      .returning();
    const multi = tickets.length > 1 || new Set(lines.map((l) => l.brandId)).size > 1;
    if (multi) await tx.insert(packingTasks).values({ orderId, bagCode: `BAG-${shortCode(4)}` }).onConflictDoNothing();
    await tx.update(orderLines).set({ status: 'PREPARING' }).where(eq(orderLines.orderId, orderId));
    await this.consumeIngredients(lines, loc?.kitchenId ?? null, tx);
    return tickets;
  }

  /** Station screen: queued/in-progress tickets for a station (or all) at a kitchen. */
  async stationQueue(user: JwtPayload, kitchenId: string, stationCode?: string) {
    await this.requireKitchen(user, kitchenId);
    const locIds = (await this.db.select({ id: locations.id }).from(locations).where(eq(locations.kitchenId, kitchenId))).map((l) => l.id);
    if (!locIds.length) return [];
    const rows = await this.db
      .select({ ticket: kitchenTickets, order: orders })
      .from(kitchenTickets)
      .innerJoin(orders, eq(orders.id, kitchenTickets.orderId))
      .where(and(inArray(orders.locationId, locIds), inArray(kitchenTickets.status, ['QUEUED', 'IN_PROGRESS']), ...(stationCode ? [eq(kitchenTickets.stationCode, stationCode)] : [])))
      .orderBy(orders.promiseAt);
    const lineIds = rows.flatMap((r) => r.ticket.lineIds);
    const lines = lineIds.length ? await this.db.select().from(orderLines).where(inArray(orderLines.id, lineIds)) : [];
    return rows.map((r) => ({ ...r.ticket, orderNumber: r.order.number, promiseAt: r.order.promiseAt, lines: lines.filter((l) => r.ticket.lineIds.includes(l.id)) }));
  }

  async ticketTransition(user: JwtPayload, ticketId: string, status: 'IN_PROGRESS' | 'DONE' | 'VOID') {
    const [t] = await this.db.select({ ticket: kitchenTickets, order: orders }).from(kitchenTickets).innerJoin(orders, eq(orders.id, kitchenTickets.orderId)).where(eq(kitchenTickets.id, ticketId)).limit(1);
    if (!t) throw new NotFoundException();
    assertOrgAccess(user, t.order.organizationId, t.order.locationId);
    return this.db.transaction(async (tx) => {
      const [u] = await tx.update(kitchenTickets).set({ status, startedAt: status === 'IN_PROGRESS' ? new Date() : t.ticket.startedAt, doneAt: status === 'DONE' ? new Date() : null }).where(eq(kitchenTickets.id, ticketId)).returning();
      if (status === 'DONE') await tx.update(orderLines).set({ status: 'READY' }).where(inArray(orderLines.id, t.ticket.lineIds));
      // when all tickets done and no packing task → order ready
      const all = await tx.select().from(kitchenTickets).where(eq(kitchenTickets.orderId, t.order.id));
      const [pack] = await tx.select().from(packingTasks).where(eq(packingTasks.orderId, t.order.id)).limit(1);
      if (all.every((x) => x.status === 'DONE' || x.status === 'VOID')) {
        if (pack) await tx.update(packingTasks).set({ status: 'VERIFYING' }).where(eq(packingTasks.id, pack.id));
        else if (t.order.status === 'PREPARING' || t.order.status === 'ACCEPTED') {
          await tx.update(orders).set({ status: 'READY', readyAt: new Date() }).where(eq(orders.id, t.order.id));
          await this.outbox.publish('order.ready', t.order.id, { orderNumber: t.order.number, pickupCode: t.order.pickupCode }, tx);
        }
      } else if (status === 'IN_PROGRESS' && t.order.status === 'ACCEPTED') {
        await tx.update(orders).set({ status: 'PREPARING' }).where(eq(orders.id, t.order.id));
      }
      return u;
    });
  }

  /** Mark a line unavailable mid-prep: customer approval for replacement or partial credit (handled in OrdersService). */
  async lineUnavailable(user: JwtPayload, lineId: string, note?: string) {
    const [l] = await this.db.select({ line: orderLines, order: orders }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderLines.id, lineId)).limit(1);
    if (!l) throw new NotFoundException();
    assertOrgAccess(user, l.order.organizationId, l.order.locationId);
    await this.db.transaction(async (tx) => {
      await tx.update(orderLines).set({ status: 'UNAVAILABLE', replacementNote: note ?? null }).where(eq(orderLines.id, lineId));
      const [pack] = await tx.select().from(packingTasks).where(eq(packingTasks.orderId, l.order.id)).limit(1);
      if (pack) await tx.update(packingTasks).set({ status: 'BLOCKED', blockedReason: `Line ${l.line.name} unavailable` }).where(eq(packingTasks.id, pack.id));
      await this.outbox.publish('order.line_unavailable', l.order.id, { lineId, name: l.line.name, note }, tx);
    });
    return { ok: true };
  }

  /** Packing screen: verify each line into the bag; release only when everything is accounted for. */
  async packingQueue(user: JwtPayload, kitchenId: string) {
    await this.requireKitchen(user, kitchenId);
    const locIds = (await this.db.select({ id: locations.id }).from(locations).where(eq(locations.kitchenId, kitchenId))).map((l) => l.id);
    if (!locIds.length) return [];
    const rows = await this.db.select({ task: packingTasks, order: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(and(inArray(orders.locationId, locIds), inArray(packingTasks.status, ['WAITING', 'VERIFYING', 'BLOCKED']))).orderBy(orders.promiseAt);
    const ids = rows.map((r) => r.order.id);
    const lines = ids.length ? await this.db.select().from(orderLines).where(inArray(orderLines.orderId, ids)) : [];
    return rows.map((r) => ({ ...r.task, orderNumber: r.order.number, promiseAt: r.order.promiseAt, lines: lines.filter((l) => l.orderId === r.order.id) }));
  }

  async verifyLine(user: JwtPayload, packingTaskId: string, lineId: string) {
    const [p] = await this.db.select({ task: packingTasks, order: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(eq(packingTasks.id, packingTaskId)).limit(1);
    if (!p) throw new NotFoundException();
    assertOrgAccess(user, p.order.organizationId, p.order.locationId);
    const ids = Array.from(new Set([...p.task.verifiedLineIds, lineId]));
    const [u] = await this.db.update(packingTasks).set({ verifiedLineIds: ids }).where(eq(packingTasks.id, packingTaskId)).returning();
    return u;
  }

  /** A missing item stops bag release. */
  async releaseBag(user: JwtPayload, packingTaskId: string) {
    const [p] = await this.db.select({ task: packingTasks, order: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(eq(packingTasks.id, packingTaskId)).limit(1);
    if (!p) throw new NotFoundException();
    assertOrgAccess(user, p.order.organizationId, p.order.locationId);
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, p.order.id));
    const required = lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status));
    const missing = required.filter((l) => !p.task.verifiedLineIds.includes(l.id) || l.status !== 'READY');
    if (missing.length) throw new ConflictException(`Cannot release bag: ${missing.map((m) => m.name).join(', ')} not verified/ready`);
    if (lines.some((l) => l.status === 'UNAVAILABLE')) throw new ConflictException('Unresolved unavailable line; resolve replacement/credit first');
    return this.db.transaction(async (tx) => {
      const [u] = await tx.update(packingTasks).set({ status: 'RELEASED', releasedAt: new Date() }).where(eq(packingTasks.id, packingTaskId)).returning();
      await tx.update(orders).set({ status: 'READY', readyAt: new Date() }).where(eq(orders.id, p.order.id));
      await this.outbox.publish('order.ready', p.order.id, { orderNumber: p.order.number, pickupCode: p.order.pickupCode, bagCode: u.bagCode }, tx);
      return u;
    });
  }

  // ───── 10 supply & costing ─────

  async upsertIngredient(input: { id?: string; name: string; unit: string; costCentsPerUnit?: number }) {
    if (input.id) {
      const [r] = await this.db.update(ingredients).set(input).where(eq(ingredients.id, input.id)).returning();
      return r;
    }
    const [ex] = await this.db.select().from(ingredients).where(and(eq(ingredients.name, input.name), isNull(ingredients.organizationId))).limit(1);
    const [r] = ex ? await this.db.update(ingredients).set({ unit: input.unit, costCentsPerUnit: input.costCentsPerUnit ?? ex.costCentsPerUnit }).where(eq(ingredients.id, ex.id)).returning() : await this.db.insert(ingredients).values(input).returning();
    return r;
  }

  async listIngredients() {
    return this.db.select().from(ingredients).orderBy(ingredients.name);
  }

  async createRecipe(input: { name: string; yieldPortions?: number; laborMinutes?: number; lines: { ingredientId: string; quantity: number }[]; previousRecipeId?: string }) {
    return this.db.transaction(async (tx) => {
      let version = 1;
      if (input.previousRecipeId) {
        const [prev] = await tx.update(recipes).set({ isActive: false }).where(eq(recipes.id, input.previousRecipeId)).returning();
        version = (prev?.version || 0) + 1;
      }
      const [r] = await tx.insert(recipes).values({ name: input.name, yieldPortions: input.yieldPortions ?? 1, laborMinutes: input.laborMinutes ?? 0, version }).returning();
      if (input.lines.length) await tx.insert(recipeLines).values(input.lines.map((l) => ({ ...l, recipeId: r.id })));
      if (input.previousRecipeId) await tx.update(menuItems).set({ recipeId: r.id }).where(eq(menuItems.recipeId, input.previousRecipeId));
      return r;
    });
  }

  /** Plate cost = ingredient cost per portion + labor. */
  async recipeCost(recipeId: string) {
    const [r] = await this.db.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);
    if (!r) throw new NotFoundException();
    const lines = await this.db.select({ line: recipeLines, ing: ingredients }).from(recipeLines).innerJoin(ingredients, eq(ingredients.id, recipeLines.ingredientId)).where(eq(recipeLines.recipeId, recipeId));
    const ingredientCents = lines.reduce((a, { line, ing }) => a + line.quantity * ing.costCentsPerUnit, 0);
    const laborCents = Math.round((r.laborMinutes / 60) * 1800); // $18/h default labor rate
    return { recipe: r, lines, ingredientCentsPerPortion: Math.round(ingredientCents / r.yieldPortions), laborCentsPerPortion: Math.round(laborCents / r.yieldPortions), totalCentsPerPortion: Math.round((ingredientCents + laborCents) / r.yieldPortions) };
  }

  async stock(user: JwtPayload, kitchenId: string) {
    await this.requireKitchen(user, kitchenId);
    return this.db.select({ ingredient: ingredients, onHand: ingredientStock.onHand, parLevel: ingredientStock.parLevel }).from(ingredientStock).innerJoin(ingredients, eq(ingredients.id, ingredientStock.ingredientId)).where(eq(ingredientStock.kitchenId, kitchenId));
  }

  async setPar(user: JwtPayload, kitchenId: string, ingredientId: string, parLevel: number) {
    await this.requireKitchen(user, kitchenId);
    await this.db.insert(ingredientStock).values({ kitchenId, ingredientId, parLevel }).onConflictDoUpdate({ target: [ingredientStock.kitchenId, ingredientStock.ingredientId], set: { parLevel } });
    return { ok: true };
  }

  async createPurchaseOrder(user: JwtPayload, kitchenId: string, input: { supplier: string; reason?: string; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }) {
    const k = await this.requireKitchen(user, kitchenId);
    const t = await this.approvals.thresholds();
    const total = Math.round(input.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0));
    const owner = !!user.orgs?.[k.organizationId]?.roles.includes('MERCHANT_OWNER') || user.roles.includes('PLATFORM_ADMIN');
    const needsApproval = t.purchaseOrderCents > 0 && total > t.purchaseOrderCents && !owner;
    const po = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(purchaseOrders).values({ kitchenId, supplier: input.supplier, status: needsApproval ? 'PENDING_APPROVAL' : 'ORDERED', totalCents: total }).returning();
      await tx.insert(purchaseOrderLines).values(input.lines.map((l) => ({ ...l, purchaseOrderId: row.id })));
      await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'po.create', entityType: 'purchase_order', entityId: row.id, after: row }, tx);
      return row;
    });
    if (!needsApproval) return po;
    const r = await this.approvals.submit(user, { kind: 'PURCHASE_ORDER', summary: `Purchase order $${(total / 100).toFixed(2)} from ${po.supplier} for ${k.name}`, organizationId: k.organizationId, subjectType: 'purchase_order', subjectId: po.id, amountCents: total, payload: { kitchenId }, reason: input.reason || `Supplier order over the $${(t.purchaseOrderCents / 100).toFixed(0)} approval limit`, dedupeKey: `po:${po.id}` });
    return { ...po, approval: r.approval };
  }

  /** Receiving increases on-hand stock and refreshes ingredient cost (last price). */
  async receivePurchaseOrder(user: JwtPayload, poId: string, received: { lineId: string; receivedQty: number }[]) {
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
    if (!po) throw new NotFoundException();
    await this.requireKitchen(user, po.kitchenId);
    if (po.status === 'RECEIVED') throw new ConflictException('Already received');
    if (po.status === 'PENDING_APPROVAL') throw new ConflictException('This purchase order is waiting for approval');
    return this.db.transaction(async (tx) => {
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
      for (const l of lines) {
        const qty = received.find((r) => r.lineId === l.id)?.receivedQty ?? l.quantity;
        await tx.update(purchaseOrderLines).set({ receivedQty: qty }).where(eq(purchaseOrderLines.id, l.id));
        await tx.insert(ingredientStock).values({ kitchenId: po.kitchenId, ingredientId: l.ingredientId, onHand: qty }).onConflictDoUpdate({ target: [ingredientStock.kitchenId, ingredientStock.ingredientId], set: { onHand: sql`${ingredientStock.onHand} + ${qty}` } });
        await tx.update(ingredients).set({ costCentsPerUnit: l.unitCostCents }).where(eq(ingredients.id, l.ingredientId));
      }
      const [u] = await tx.update(purchaseOrders).set({ status: 'RECEIVED', receivedAt: new Date() }).where(eq(purchaseOrders.id, poId)).returning();
      return u;
    });
  }

  async recordWaste(user: JwtPayload, kitchenId: string, input: { ingredientId: string; quantity: number; reason?: string }) {
    await this.requireKitchen(user, kitchenId);
    await this.db.transaction(async (tx) => {
      await tx.insert(wasteEvents).values({ ...input, kitchenId });
      await tx.update(ingredientStock).set({ onHand: sql`greatest(0, ${ingredientStock.onHand} - ${input.quantity})` }).where(and(eq(ingredientStock.kitchenId, kitchenId), eq(ingredientStock.ingredientId, input.ingredientId)));
    });
    return { ok: true };
  }

  async recordLabor(user: JwtPayload, kitchenId: string, input: { userId?: string; hours: number; rateCents: number; date: Date }) {
    await this.requireKitchen(user, kitchenId);
    const [r] = await this.db.insert(laborEntries).values({ ...input, kitchenId }).returning();
    return r;
  }

  /** Deduct recipe ingredients for prepared lines; a sold-out ingredient flags all affected items across brands. */
  private async consumeIngredients(lines: (typeof orderLines.$inferSelect)[], kitchenId: string | null, tx: DbOrTx) {
    if (!kitchenId) return;
    const itemIds = lines.map((l) => l.menuItemId).filter((x): x is string => !!x);
    if (!itemIds.length) return;
    const items = await tx.select().from(menuItems).where(inArray(menuItems.id, itemIds));
    const recipeIds = items.map((i) => i.recipeId).filter((x): x is string => !!x);
    if (!recipeIds.length) return;
    const rl = await tx.select().from(recipeLines).where(inArray(recipeLines.recipeId, recipeIds));
    const rec = await tx.select().from(recipes).where(inArray(recipes.id, recipeIds));
    const usage = new Map<string, number>();
    for (const l of lines) {
      const item = items.find((i) => i.id === l.menuItemId);
      const r = rec.find((x) => x.id === item?.recipeId);
      if (!r) continue;
      for (const line of rl.filter((x) => x.recipeId === r.id)) usage.set(line.ingredientId, (usage.get(line.ingredientId) || 0) + (line.quantity / r.yieldPortions) * l.quantity);
    }
    for (const [ingredientId, qty] of usage) {
      const [row] = await tx.update(ingredientStock).set({ onHand: sql`${ingredientStock.onHand} - ${qty}` }).where(and(eq(ingredientStock.kitchenId, kitchenId), eq(ingredientStock.ingredientId, ingredientId))).returning();
      if (row && row.onHand <= 0) {
        // sold-out ingredient affects every item (any brand) whose recipe uses it
        const affectedRecipes = (await tx.select({ recipeId: recipeLines.recipeId }).from(recipeLines).where(eq(recipeLines.ingredientId, ingredientId))).map((x) => x.recipeId);
        if (affectedRecipes.length) await tx.update(menuItems).set({ soldOut: true, soldOutUntil: null }).where(inArray(menuItems.recipeId, affectedRecipes));
      }
    }
  }

  /** Site contribution: sales, COGS, labor, waste for a kitchen in a period. */
  async contribution(user: JwtPayload, kitchenId: string, from: Date, to: Date) {
    await this.requireKitchen(user, kitchenId);
    const locIds = (await this.db.select({ id: locations.id }).from(locations).where(eq(locations.kitchenId, kitchenId))).map((l) => l.id);
    const [sales] = locIds.length ? await this.db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${orders.subtotalCents} - ${orders.discountCents}),0)::int` }).from(orders).where(and(inArray(orders.locationId, locIds), inArray(orders.status, ['COMPLETED', 'COLLECTED']), gte(orders.createdAt, from), lte(orders.createdAt, to))) : [{ n: 0, cents: 0 }];
    const [po] = await this.db.select({ cents: sql<number>`coalesce(sum(${purchaseOrders.totalCents}),0)::int` }).from(purchaseOrders).where(and(eq(purchaseOrders.kitchenId, kitchenId), eq(purchaseOrders.status, 'RECEIVED'), gte(purchaseOrders.receivedAt, from), lte(purchaseOrders.receivedAt, to)));
    const [labor] = await this.db.select({ cents: sql<number>`coalesce(sum(${laborEntries.hours} * ${laborEntries.rateCents}),0)::int` }).from(laborEntries).where(and(eq(laborEntries.kitchenId, kitchenId), gte(laborEntries.date, from), lte(laborEntries.date, to)));
    const waste = await this.db.select({ w: wasteEvents, ing: ingredients }).from(wasteEvents).innerJoin(ingredients, eq(ingredients.id, wasteEvents.ingredientId)).where(and(eq(wasteEvents.kitchenId, kitchenId), gte(wasteEvents.createdAt, from), lte(wasteEvents.createdAt, to)));
    const wasteCents = Math.round(waste.reduce((a, { w, ing }) => a + w.quantity * ing.costCentsPerUnit, 0));
    const brandRows = await this.db.select({ brandId: orderLines.brandId, royaltyBps: brands.royaltyBps, cents: sql<number>`coalesce(sum(${orderLines.lineTotalCents}),0)::int` }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).leftJoin(brands, eq(brands.id, orderLines.brandId)).where(and(locIds.length ? inArray(orders.locationId, locIds) : sql`false`, inArray(orders.status, ['COMPLETED', 'COLLECTED']), gte(orders.createdAt, from), lte(orders.createdAt, to))).groupBy(orderLines.brandId, brands.royaltyBps);
    const royaltyCents = brandRows.reduce((a, b) => a + Math.round((b.cents * (b.royaltyBps || 0)) / 10_000), 0);
    const contribution = sales.cents - po.cents - labor.cents - wasteCents - royaltyCents;
    return { orders: sales.n, netSalesCents: sales.cents, purchasesCents: po.cents, laborCents: labor.cents, wasteCents, royaltyCents, contributionCents: contribution, byBrand: brandRows };
  }

  async ticketsForOrder(orderId: string) {
    return this.db.select().from(kitchenTickets).where(eq(kitchenTickets.orderId, orderId)).orderBy(desc(kitchenTickets.createdAt));
  }
}
