import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { DEFAULT_AUTO_THROTTLE, DEFAULT_PICKUP_POLICY, fireAt as computeFireAt, KITCHEN_REASONS, mentionsAllergy, suggestBags, type AutoThrottle, type PickupPolicy } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { brands, ingredientStock, ingredients, kitchenBrands, kitchenEvents, kitchenTickets, kitchens, laborEntries, locations, menuCategories, menuItems, opsAlerts, organizations, orderLines, orders, packingTasks, purchaseOrderLines, purchaseOrders, recipeLines, recipes, stationRoutes, stations, stockLots, stockMovements, suppliers, wasteEvents } from '../../db/schema';
import { assertCan, assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { shortCode } from '../../common/utils';
import { ApprovalsService } from '../security/approvals.service';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { LedgerService } from '../../core/ledger.service';
import { PrintingService } from './printing.service';

@Injectable()
export class KitchenService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db, private readonly outbox: OutboxService, private readonly approvals: ApprovalsService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly ledger: LedgerService, private readonly printing: PrintingService) {}

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

  async listKitchens(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select({ id: kitchens.id, name: kitchens.name, city: kitchens.city, loadLevel: kitchens.loadLevel }).from(kitchens).where(eq(kitchens.organizationId, orgId)).orderBy(kitchens.name);
  }

  async linkBrand(user: JwtPayload, kitchenId: string, brandId: string, isActive = true) {
    const k = await this.requireKitchen(user, kitchenId);
    const [b] = await this.db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
    if (!b) throw new NotFoundException('Brand not found');
    await this.db.insert(kitchenBrands).values({ kitchenId: k.id, brandId, isActive }).onConflictDoUpdate({ target: [kitchenBrands.kitchenId, kitchenBrands.brandId], set: { isActive } });
    return { ok: true };
  }

  async requireKitchen(user: JwtPayload, kitchenId: string) {
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

  // ───── production: tickets, packing (Phase F) ─────

  /** 14.4 packing verification is required at kitchen-backed locations unless the location turns it off. */
  requiresPackVerification(loc: { requirePackVerification: boolean | null; kitchenId: string | null }) {
    return loc.requirePackVerification ?? !!loc.kitchenId;
  }

  /**
   * Fan an accepted order out to station tickets.
   * - 13.2 station routing: item rule > category rule > brand rule > the item's own station > the kitchen default > MAIN.
   * - 13.3 each ticket gets a fire-at time so all stations finish together by the order's ready-by time.
   * - 14.1–14.4 every order gets a packing task with a checklist, handling flags and suggested bags.
   * Called by OrdersService inside the acceptance transaction; idempotent.
   */
  async fanOut(orderId: string, tx: DbOrTx = this.db) {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) throw new NotFoundException();
    const existing = await tx.select().from(kitchenTickets).where(eq(kitchenTickets.orderId, orderId));
    if (existing.length) return existing; // no duplicate kitchen ticket on retry
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const [loc] = await tx.select().from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const [kitchen] = loc?.kitchenId ? await tx.select().from(kitchens).where(eq(kitchens.id, loc.kitchenId)).limit(1) : [null];
    const stationRows = kitchen ? await tx.select().from(stations).where(eq(stations.kitchenId, kitchen.id)) : [];
    const routes = kitchen ? await tx.select().from(stationRoutes).where(eq(stationRoutes.kitchenId, kitchen.id)) : [];
    const itemIds = lines.map((l) => l.menuItemId).filter((x): x is string => !!x);
    const items = itemIds.length ? await tx.select({ id: menuItems.id, categoryId: menuItems.categoryId, cookMinutes: menuItems.cookMinutes, handling: menuItems.handling, recipeId: menuItems.recipeId, kind: menuItems.kind, allergens: menuItems.allergens }).from(menuItems).where(inArray(menuItems.id, itemIds)) : [];
    const recipeIds = items.map((i) => i.recipeId).filter((x): x is string => !!x);
    const recipeRows = recipeIds.length ? await tx.select({ id: recipes.id, prep: recipes.prepMinutes, batch: recipes.batchMaxPortions }).from(recipes).where(inArray(recipes.id, recipeIds)) : [];
    const recipePrep = new Map(recipeRows.map((r) => [r.id, r.prep]));
    // 8.5-K a line above the recipe's batch size cooks in several batches
    const batchesFor = (it: { recipeId: string | null } | undefined, qty: number) => { const b = it?.recipeId ? recipeRows.find((r) => r.id === it.recipeId)?.batch : null; return b && qty > b ? Math.ceil(qty / b) : 1; };
    const known = new Set(stationRows.map((s) => s.code));
    const stationFor = (l: typeof lines[number]) => {
      const it = items.find((i) => i.id === l.menuItemId);
      const r = routes.find((x) => x.matchType === 'ITEM' && x.matchId === it?.id) || routes.find((x) => x.matchType === 'CATEGORY' && x.matchId === it?.categoryId) || routes.find((x) => x.matchType === 'BRAND' && x.matchId === l.brandId);
      const code = r?.stationCode || l.stationCode || kitchen?.defaultStationCode || 'MAIN';
      return known.size && !known.has(code) && kitchen?.defaultStationCode ? kitchen.defaultStationCode : code;
    };
    const now = new Date();
    const prep = loc?.defaultPrepMinutes ?? 20;
    let readyBy = o.promiseAt ? new Date(o.promiseAt.getTime() - (o.fulfillmentType === 'DELIVERY' ? 15 * 60_000 : 0)) : new Date(now.getTime() + prep * 60_000);
    if (readyBy < now) readyBy = new Date(now.getTime() + Math.min(prep, 10) * 60_000);
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const code = stationFor(l);
      groups.set(code, [...(groups.get(code) || []), l]);
    }
    const values = Array.from(groups.entries()).map(([code, ls]) => {
      const station = stationRows.find((s) => s.code === code);
      const cook = Math.max(...ls.map((l) => { const it = items.find((i) => i.id === l.menuItemId); return (it?.cookMinutes ?? (it?.recipeId ? Math.round(recipePrep.get(it.recipeId) || 0) || null : null) ?? station?.targetMinutes ?? 10) * batchesFor(it, l.quantity); }));
      return { orderId, stationCode: code, stationId: station?.id ?? null, lineIds: ls.map((l) => l.id), cookMinutes: cook, readyBy, fireAt: computeFireAt(readyBy, cook, now) };
    });
    const tickets = await tx.insert(kitchenTickets).values(values).returning();
    // line routing + handling flags
    const lineFlags: string[][] = [];
    for (const [code, ls] of groups) {
      for (const l of ls) {
        const it = items.find((i) => i.id === l.menuItemId);
        // a customization that adds an allergen the dish does not normally contain (e.g. shrimp) is flagged for the cook and packer
        const addedAllergen = !!l.allergens?.some((a) => !(it?.allergens || []).includes(a));
        const flags = Array.from(new Set([...(it?.handling || []), ...(mentionsAllergy(l.specialInstructions) || addedAllergen ? ['ALLERGEN'] : [])]));
        lineFlags.push(flags);
        await tx.update(orderLines).set({ status: 'PREPARING', stationCode: code, handling: flags }).where(eq(orderLines.id, l.id));
      }
    }
    // 13.8-P queue station tickets for network printers with auto-print on (the worker sends them)
    await this.printing.queueForTickets(tickets, tx);
    const handling = Array.from(new Set(lineFlags.flat()));
    const extras = loc?.packingExtras?.length ? loc.packingExtras : ['Napkins', 'Receipt'];
    const checklist = [
      ...extras.map((e) => ({ key: `extra:${e}`, label: e, done: false })),
      ...(o.utensils ? [{ key: 'utensils', label: 'Utensils (requested)', done: false }] : []),
      ...(items.some((i) => i.kind === 'BEVERAGE') ? [{ key: 'drinks', label: 'Drinks lidded and sealed', done: false }] : []),
      ...(handling.includes('ALLERGEN') ? [{ key: 'allergen', label: 'Allergy label on the bag', done: false }] : []),
      ...(o.fulfillmentType === 'DELIVERY' ? [{ key: 'seal', label: 'Bag sealed (tamper sticker)', done: false }] : []),
    ];
    const bagCode = `BAG-${shortCode(4)}`;
    const bagCount = suggestBags(lineFlags);
    await tx.insert(packingTasks).values({ orderId, bagCode, checklist, handling, bagCount, bags: this.buildBags(bagCode, bagCount, handling) }).onConflictDoNothing();
    await this.consumeIngredients(lines, loc?.kitchenId ?? null, tx);
    if (loc?.platformOperated) await this.postCogs(o, lines, items, tx);
    return tickets;
  }

  /** 20.3 Gutad-operated kitchens: cost of goods from recipe ingredients, posted when the order is fired. */
  private async postCogs(o: typeof orders.$inferSelect, lines: (typeof orderLines.$inferSelect)[], items: { id: string; recipeId: string | null }[], tx: DbOrTx) {
    const recipeIds = [...new Set(items.map((i) => i.recipeId).filter((x): x is string => !!x))];
    if (!recipeIds.length) return;
    const rl = await tx.select({ recipeId: recipeLines.recipeId, qty: recipeLines.quantity, cost: ingredients.costCentsPerUnit }).from(recipeLines).innerJoin(ingredients, eq(ingredients.id, recipeLines.ingredientId)).where(inArray(recipeLines.recipeId, recipeIds));
    const rs = await tx.select({ id: recipes.id, y: recipes.yieldPortions }).from(recipes).where(inArray(recipes.id, recipeIds));
    let cents = 0;
    for (const l of lines) {
      const r = items.find((i) => i.id === l.menuItemId)?.recipeId;
      if (!r) continue;
      const per = rl.filter((x) => x.recipeId === r).reduce((a, x) => a + x.qty * x.cost, 0) / (rs.find((x) => x.id === r)?.y || 1);
      cents += per * l.quantity;
    }
    cents = Math.round(cents);
    if (cents > 0) await this.ledger.post({ orderId: o.id, currency: o.currency }, [{ account: 'PLATFORM_EXPENSE_COGS', debitCents: cents, organizationId: o.organizationId, locationId: o.locationId, memo: `COGS ${o.number}` }, { account: 'INVENTORY', creditCents: cents, locationId: o.locationId, memo: `Ingredients used ${o.number}` }], tx);
  }

  private buildBags(bagCode: string, count: number, handling: string[]) {
    const hotCold = handling.includes('HOT') && handling.includes('COLD');
    return Array.from({ length: count }, (_, i) => {
      const base = handling.filter((f) => f !== 'HOT' && f !== 'COLD');
      const temp = hotCold && count >= 2 ? (i === 0 ? ['HOT'] : i === 1 ? ['COLD'] : []) : handling.filter((f) => f === 'HOT' || f === 'COLD');
      return { n: i + 1, code: `${bagCode}-${i + 1}`, handling: [...temp, ...base] };
    });
  }

  private async locIdsFor(kitchenId: string) {
    return (await this.db.select({ id: locations.id }).from(locations).where(eq(locations.kitchenId, kitchenId))).map((l) => l.id);
  }

  /** Station screen: active tickets in fire order, with item-level status, hold/fire state and delay flags (13.1, 13.3, 13.5). */
  async stationQueue(user: JwtPayload, kitchenId: string, stationCode?: string) {
    await this.requireKitchen(user, kitchenId);
    const locIds = await this.locIdsFor(kitchenId);
    if (!locIds.length) return [];
    const rows = await this.db
      .select({ ticket: kitchenTickets, order: orders })
      .from(kitchenTickets)
      .innerJoin(orders, eq(orders.id, kitchenTickets.orderId))
      .where(and(inArray(orders.locationId, locIds), inArray(kitchenTickets.status, ['QUEUED', 'IN_PROGRESS']), ...(stationCode ? [eq(kitchenTickets.stationCode, stationCode)] : [])))
      .orderBy(sql`coalesce(${kitchenTickets.fireAt}, ${orders.promiseAt})`);
    const st = await this.db.select().from(stations).where(eq(stations.kitchenId, kitchenId));
    const lineIds = rows.flatMap((r) => r.ticket.lineIds);
    const lines = lineIds.length ? await this.db.select().from(orderLines).where(inArray(orderLines.id, lineIds)) : [];
    const now = Date.now();
    return rows.map((r) => {
      const target = st.find((s) => s.code === r.ticket.stationCode)?.targetMinutes ?? 10;
      const fire = r.ticket.fireAt?.getTime() ?? now;
      const startedFor = r.ticket.startedAt ? (now - r.ticket.startedAt.getTime()) / 60_000 : 0;
      const delayed = !!r.ticket.delayedAt || (r.ticket.status === 'IN_PROGRESS' ? startedFor > target : now > fire + target * 60_000);
      return {
        ...r.ticket, orderNumber: r.order.number, promiseAt: r.order.promiseAt, fulfillmentType: r.order.fulfillmentType, tableNumber: r.order.tableNumber,
        targetMinutes: target, fireState: r.ticket.status === 'QUEUED' && fire > now + 60_000 ? 'HOLD' : 'FIRE', minutesInProgress: Math.round(startedFor), delayed,
        lines: lines.filter((l) => r.ticket.lineIds.includes(l.id)),
      };
    });
  }

  async ticketTransition(user: JwtPayload, ticketId: string, status: 'IN_PROGRESS' | 'DONE' | 'VOID') {
    const [t] = await this.db.select({ ticket: kitchenTickets, order: orders }).from(kitchenTickets).innerJoin(orders, eq(orders.id, kitchenTickets.orderId)).where(eq(kitchenTickets.id, ticketId)).limit(1);
    if (!t) throw new NotFoundException();
    assertOrgAccess(user, t.order.organizationId, t.order.locationId);
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [u] = await tx.update(kitchenTickets).set({ status, startedAt: status === 'IN_PROGRESS' ? now : t.ticket.startedAt ?? (status === 'DONE' ? now : null), doneAt: status === 'DONE' ? now : null }).where(eq(kitchenTickets.id, ticketId)).returning();
      if (status === 'DONE') await tx.update(orderLines).set({ status: 'READY', readyAt: now }).where(and(inArray(orderLines.id, t.ticket.lineIds), inArray(orderLines.status, ['PENDING', 'PREPARING'])));
      if (status === 'IN_PROGRESS' && t.order.status === 'ACCEPTED') await tx.update(orders).set({ status: 'PREPARING' }).where(eq(orders.id, t.order.id));
      await this.afterTickets(t.order, tx, user.sub);
      return u;
    });
  }

  /** 13.1 bump one item on a ticket; the ticket finishes when its last item is ready. */
  async bumpLine(user: JwtPayload, lineId: string, ready: boolean) {
    const [l] = await this.db.select({ line: orderLines, order: orders }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderLines.id, lineId)).limit(1);
    if (!l) throw new NotFoundException();
    assertOrgAccess(user, l.order.organizationId, l.order.locationId);
    if (['UNAVAILABLE', 'CREDITED', 'REPLACED'].includes(l.line.status)) throw new ConflictException(`Item is ${l.line.status.toLowerCase()}`);
    return this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(orderLines).set({ status: ready ? 'READY' : 'PREPARING', readyAt: ready ? now : null }).where(eq(orderLines.id, lineId));
      const [t] = await tx.select().from(kitchenTickets).where(and(eq(kitchenTickets.orderId, l.order.id), sql`${lineId}::uuid = any(${kitchenTickets.lineIds})`, inArray(kitchenTickets.status, ['QUEUED', 'IN_PROGRESS', 'DONE']))).orderBy(desc(kitchenTickets.createdAt)).limit(1);
      if (t) {
        const ls = await tx.select({ id: orderLines.id, status: orderLines.status }).from(orderLines).where(inArray(orderLines.id, t.lineIds));
        const allDone = ls.every((x) => x.status !== 'PENDING' && x.status !== 'PREPARING');
        if (allDone && t.status !== 'DONE') await tx.update(kitchenTickets).set({ status: 'DONE', doneAt: now, startedAt: t.startedAt ?? now }).where(eq(kitchenTickets.id, t.id));
        else if (!allDone && t.status === 'QUEUED') await tx.update(kitchenTickets).set({ status: 'IN_PROGRESS', startedAt: now }).where(eq(kitchenTickets.id, t.id));
        else if (!allDone && t.status === 'DONE') await tx.update(kitchenTickets).set({ status: 'IN_PROGRESS', doneAt: null }).where(eq(kitchenTickets.id, t.id));
      }
      if (l.order.status === 'ACCEPTED') await tx.update(orders).set({ status: 'PREPARING' }).where(eq(orders.id, l.order.id));
      await this.afterTickets(l.order, tx, user.sub);
      return { ok: true };
    });
  }

  /** When every ticket is done: packing verification (14.4) or, where it is not required, straight to ready. */
  private async afterTickets(o: typeof orders.$inferSelect, tx: DbOrTx, actorId: string | null) {
    const all = await tx.select().from(kitchenTickets).where(eq(kitchenTickets.orderId, o.id));
    if (!all.every((x) => x.status === 'DONE' || x.status === 'VOID')) return;
    const [pack] = await tx.select().from(packingTasks).where(eq(packingTasks.orderId, o.id)).limit(1);
    const [loc] = await tx.select().from(locations).where(eq(locations.id, o.locationId)).limit(1);
    if (pack && pack.status !== 'RELEASED' && loc && this.requiresPackVerification(loc)) {
      if (pack.status !== 'BLOCKED') await tx.update(packingTasks).set({ status: 'VERIFYING' }).where(eq(packingTasks.id, pack.id));
      return;
    }
    if (o.status === 'PREPARING' || o.status === 'ACCEPTED') await this.markOrderReady(o, tx, actorId);
  }

  /** Order → READY: release the packing task, assign a pickup shelf (14.5) and tell the customer. */
  async markOrderReady(o: typeof orders.$inferSelect, tx: DbOrTx, actorId: string | null) {
    const now = new Date();
    await tx.update(packingTasks).set({ status: 'RELEASED', releasedAt: now, verifiedById: actorId }).where(and(eq(packingTasks.orderId, o.id), ne(packingTasks.status, 'RELEASED')));
    const shelfSlot = await this.assignShelf(o, tx);
    await tx.update(orders).set({ status: 'READY', readyAt: now, shelfSlot }).where(eq(orders.id, o.id));
    await this.outbox.publish('order.ready', o.id, { number: o.number, orderNumber: o.number, pickupCode: o.pickupCode, userId: o.userId, shelfSlot, tableNumber: o.tableNumber }, tx);
    return shelfSlot;
  }

  private async assignShelf(o: typeof orders.$inferSelect, tx: DbOrTx) {
    if (o.fulfillmentType === 'DINE_IN') return null;
    const [loc] = await tx.select({ shelves: locations.pickupShelves }).from(locations).where(eq(locations.id, o.locationId)).limit(1);
    if (!loc?.shelves.length) return null;
    const used = new Set((await tx.select({ s: orders.shelfSlot }).from(orders).where(and(eq(orders.locationId, o.locationId), eq(orders.status, 'READY'), isNotNull(orders.shelfSlot)))).map((x) => x.s));
    return loc.shelves.find((s) => !used.has(s)) ?? null;
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
      await tx.insert(kitchenEvents).values({ locationId: l.order.locationId, orderId: l.order.id, orderLineId: lineId, stationCode: l.line.stationCode, kind: 'MISSING', reasonCode: 'OUT_OF_STOCK', note: note ?? null, createdById: user.sub });
      await this.outbox.publish('order.line_unavailable', l.order.id, { lineId, name: l.line.name, note }, tx);
    });
    return { ok: true };
  }

  /**
   * 13.6 record a remake, a missing item or a quality failure with a reason code.
   * REMAKE and MISSING re-fire the item as a new REMAKE ticket at its station and take it out of the bag.
   */
  async recordEvent(user: JwtPayload, input: { orderId: string; orderLineId?: string; kind: 'REMAKE' | 'MISSING' | 'QUALITY_FAIL'; reasonCode: string; note?: string; refire?: boolean }) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (!o) throw new NotFoundException();
    assertOrgAccess(user, o.organizationId, o.locationId);
    if (!KITCHEN_REASONS[input.reasonCode]) throw new BadRequestException('Unknown reason code');
    const [line] = input.orderLineId ? await this.db.select().from(orderLines).where(and(eq(orderLines.id, input.orderLineId), eq(orderLines.orderId, o.id))).limit(1) : [null];
    if (input.orderLineId && !line) throw new NotFoundException('Item not on this order');
    const [loc] = await this.db.select({ kitchenId: locations.kitchenId }).from(locations).where(eq(locations.id, o.locationId)).limit(1);
    const refire = !!line && (input.kind !== 'QUALITY_FAIL' || input.refire) && ['ACCEPTED', 'PREPARING', 'READY'].includes(o.status);
    return this.db.transaction(async (tx) => {
      const [ev] = await tx.insert(kitchenEvents).values({ kitchenId: loc?.kitchenId ?? null, locationId: o.locationId, orderId: o.id, orderLineId: line?.id ?? null, stationCode: line?.stationCode ?? null, kind: input.kind, reasonCode: input.reasonCode, note: input.note ?? null, createdById: user.sub }).returning();
      if (refire && line) {
        const [station] = loc?.kitchenId && line.stationCode ? await tx.select().from(stations).where(and(eq(stations.kitchenId, loc.kitchenId), eq(stations.code, line.stationCode))).limit(1) : [null];
        const now = new Date();
        await tx.insert(kitchenTickets).values({ orderId: o.id, stationCode: line.stationCode || 'MAIN', stationId: station?.id ?? null, lineIds: [line.id], kind: 'REMAKE', fireAt: now, readyBy: new Date(now.getTime() + (station?.targetMinutes ?? 10) * 60_000), cookMinutes: station?.targetMinutes ?? 10 });
        await tx.update(orderLines).set({ status: 'PREPARING', readyAt: null }).where(eq(orderLines.id, line.id));
        const [pack] = await tx.select().from(packingTasks).where(eq(packingTasks.orderId, o.id)).limit(1);
        if (pack && pack.status !== 'RELEASED') await tx.update(packingTasks).set({ status: 'WAITING', verifiedLineIds: pack.verifiedLineIds.filter((x) => x !== line.id) }).where(eq(packingTasks.id, pack.id));
        if (o.status === 'READY') await tx.update(orders).set({ status: 'PREPARING', readyAt: null, shelfSlot: null }).where(eq(orders.id, o.id));
      }
      await this.audit.log({ organizationId: o.organizationId, actorId: user.sub, action: `kitchen.${input.kind.toLowerCase()}`, entityType: 'order', entityId: o.id, after: ev }, tx);
      return { event: ev, refired: refire };
    });
  }

  async events(user: JwtPayload, kitchenId: string, days = 7) {
    await this.requireKitchen(user, kitchenId);
    const locIds = await this.locIdsFor(kitchenId);
    if (!locIds.length) return [];
    return this.db.select({ e: kitchenEvents, orderNumber: orders.number, item: orderLines.name }).from(kitchenEvents).innerJoin(orders, eq(orders.id, kitchenEvents.orderId)).leftJoin(orderLines, eq(orderLines.id, kitchenEvents.orderLineId)).where(and(inArray(kitchenEvents.locationId, locIds), gte(kitchenEvents.createdAt, new Date(Date.now() - days * 86400_000)))).orderBy(desc(kitchenEvents.createdAt)).limit(200)
      .then((r) => r.map((x) => ({ ...x.e, orderNumber: x.orderNumber, item: x.item })));
  }

  /** 13.4 expo: every active order with the stations still holding it and how long finished food has waited. */
  async expo(user: JwtPayload, kitchenId: string) {
    await this.requireKitchen(user, kitchenId);
    const locIds = await this.locIdsFor(kitchenId);
    if (!locIds.length) return [];
    const os = await this.db.select().from(orders).where(and(inArray(orders.locationId, locIds), inArray(orders.status, ['ACCEPTED', 'PREPARING', 'READY']))).orderBy(orders.promiseAt).limit(100);
    if (!os.length) return [];
    const ids = os.map((o) => o.id);
    const ts = await this.db.select().from(kitchenTickets).where(inArray(kitchenTickets.orderId, ids));
    const ls = await this.db.select({ id: orderLines.id, orderId: orderLines.orderId, status: orderLines.status, readyAt: orderLines.readyAt }).from(orderLines).where(inArray(orderLines.orderId, ids));
    const packs = await this.db.select().from(packingTasks).where(inArray(packingTasks.orderId, ids));
    const now = Date.now();
    return os.map((o) => {
      const tk = ts.filter((t) => t.orderId === o.id && t.status !== 'VOID');
      const lines = ls.filter((l) => l.orderId === o.id);
      const ready = lines.filter((l) => l.status === 'READY');
      const firstReady = ready.map((l) => l.readyAt?.getTime() || now).sort()[0];
      const holding = tk.filter((t) => t.status !== 'DONE').map((t) => ({ stationCode: t.stationCode, status: t.status, fireAt: t.fireAt, kind: t.kind }));
      const pack = packs.find((p) => p.orderId === o.id);
      return {
        orderId: o.id, number: o.number, status: o.status, fulfillmentType: o.fulfillmentType, tableNumber: o.tableNumber, promiseAt: o.promiseAt, shelfSlot: o.shelfSlot,
        stations: tk.map((t) => ({ stationCode: t.stationCode, status: t.status, kind: t.kind, fireAt: t.fireAt, doneAt: t.doneAt })),
        holding, readyLines: ready.length, totalLines: lines.length, packingStatus: pack?.status ?? null,
        foodWaitingMinutes: firstReady && holding.length ? Math.round((now - firstReady) / 60_000) : 0,
        lateMinutes: o.promiseAt && o.status !== 'READY' ? Math.max(0, Math.round((now - o.promiseAt.getTime()) / 60_000)) : 0,
      };
    });
  }

  /** 13.5 per-station prep time vs target, late share, food waiting time and remakes. */
  async performance(user: JwtPayload, kitchenId: string, days = 7) {
    const k = await this.requireKitchen(user, kitchenId);
    const locIds = await this.locIdsFor(kitchenId);
    const from = new Date(Date.now() - days * 86400_000);
    const st = await this.db.select().from(stations).where(eq(stations.kitchenId, kitchenId));
    if (!locIds.length) return { kitchen: { id: k.id, name: k.name, loadLevel: k.loadLevel }, stations: [], waiting: [], reasons: [] };
    const arr = `{${locIds.join(',')}}`;
    const byStation = (await this.db.execute(sql`
      select t.station_code as code, count(*)::int as tickets,
        avg(extract(epoch from t.done_at - coalesce(t.started_at, t.fire_at, t.created_at)) / 60) as avg_min,
        count(*) filter (where t.kind = 'REMAKE')::int as remakes,
        count(*) filter (where t.delayed_at is not null)::int as delayed
      from kitchen_tickets t join orders o on o.id = t.order_id
      where o.location_id = any(${arr}::uuid[]) and t.status = 'DONE' and t.created_at >= ${from.toISOString()}
      group by 1 order by 2 desc`) as unknown as { rows: { code: string; tickets: number; avg_min: number | null; remakes: number; delayed: number }[] }).rows;
    const waiting = (await this.db.execute(sql`
      select fulfillment_type as f, count(*)::int as n, avg(extract(epoch from collected_at - ready_at) / 60) as avg_min, max(extract(epoch from collected_at - ready_at) / 60) as max_min
      from orders where location_id = any(${arr}::uuid[]) and ready_at is not null and collected_at is not null and created_at >= ${from.toISOString()} group by 1`) as unknown as { rows: { f: string; n: number; avg_min: number | null; max_min: number | null }[] }).rows;
    const reasons = (await this.db.execute(sql`select kind, reason_code, count(*)::int as n from kitchen_events where location_id = any(${arr}::uuid[]) and created_at >= ${from.toISOString()} group by 1, 2 order by 3 desc`) as unknown as { rows: { kind: string; reason_code: string; n: number }[] }).rows;
    const r1 = (x: number | null) => (x == null ? null : Math.round(Number(x) * 10) / 10);
    return {
      kitchen: { id: k.id, name: k.name, loadLevel: k.loadLevel, loadChangedAt: k.loadChangedAt },
      stations: byStation.map((s) => { const target = st.find((x) => x.code === s.code)?.targetMinutes ?? 10; return { code: s.code, tickets: s.tickets, avgMinutes: r1(s.avg_min), targetMinutes: target, delayed: s.delayed, remakes: s.remakes, onTargetPct: s.tickets ? Math.round(((s.tickets - s.delayed) / s.tickets) * 100) : null }; }),
      waiting: waiting.map((w) => ({ fulfillmentType: w.f, orders: w.n, avgMinutes: r1(w.avg_min), maxMinutes: r1(w.max_min) })),
      reasons: reasons.map((r) => ({ kind: r.kind, reasonCode: r.reason_code, count: r.n })),
    };
  }

  // 13.2 routing rules & kitchen settings
  async routes(user: JwtPayload, kitchenId: string) {
    const k = await this.requireKitchen(user, kitchenId);
    const rows = await this.db.select().from(stationRoutes).where(eq(stationRoutes.kitchenId, kitchenId)).orderBy(stationRoutes.createdAt);
    const ids = rows.map((r) => r.matchId);
    const names = new Map<string, string>();
    if (ids.length) {
      for (const x of await this.db.select({ id: menuItems.id, name: menuItems.name }).from(menuItems).where(inArray(menuItems.id, ids))) names.set(x.id, x.name);
      for (const x of await this.db.select({ id: menuCategories.id, name: menuCategories.name }).from(menuCategories).where(inArray(menuCategories.id, ids))) names.set(x.id, x.name);
      for (const x of await this.db.select({ id: brands.id, name: brands.name }).from(brands).where(inArray(brands.id, ids))) names.set(x.id, x.name);
    }
    return { defaultStationCode: k.defaultStationCode, autoThrottle: k.autoThrottle, loadLevel: k.loadLevel, routes: rows.map((r) => ({ ...r, matchName: names.get(r.matchId) || r.matchId })) };
  }

  async addRoute(user: JwtPayload, kitchenId: string, input: { matchType: 'ITEM' | 'CATEGORY' | 'BRAND'; matchId: string; stationCode: string }) {
    const k = await this.requireKitchen(user, kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const code = input.stationCode.toUpperCase();
    const [s] = await this.db.select().from(stations).where(and(eq(stations.kitchenId, kitchenId), eq(stations.code, code))).limit(1);
    if (!s) throw new BadRequestException(`No station ${code} in this kitchen`);
    await this.db.delete(stationRoutes).where(and(eq(stationRoutes.kitchenId, kitchenId), eq(stationRoutes.matchType, input.matchType), eq(stationRoutes.matchId, input.matchId)));
    const [r] = await this.db.insert(stationRoutes).values({ kitchenId, matchType: input.matchType, matchId: input.matchId, stationCode: code }).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'station.route', entityType: 'kitchen', entityId: kitchenId, after: r });
    return r;
  }

  async removeRoute(user: JwtPayload, routeId: string) {
    const [r] = await this.db.select().from(stationRoutes).where(eq(stationRoutes.id, routeId)).limit(1);
    if (!r) throw new NotFoundException();
    const k = await this.requireKitchen(user, r.kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    await this.db.delete(stationRoutes).where(eq(stationRoutes.id, routeId));
    return { ok: true };
  }

  async updateKitchen(user: JwtPayload, kitchenId: string, input: { defaultStationCode?: string | null; autoThrottle?: Partial<AutoThrottle> | null }) {
    const k = await this.requireKitchen(user, kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const set: Partial<typeof kitchens.$inferInsert> = {};
    if (input.defaultStationCode !== undefined) set.defaultStationCode = input.defaultStationCode ? input.defaultStationCode.toUpperCase() : null;
    if (input.autoThrottle !== undefined) set.autoThrottle = input.autoThrottle;
    const [row] = await this.db.update(kitchens).set(set).where(eq(kitchens.id, kitchenId)).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'kitchen.update', entityType: 'kitchen', entityId: kitchenId, before: { defaultStationCode: k.defaultStationCode, autoThrottle: k.autoThrottle }, after: set });
    return row;
  }

  /**
   * 13.7 load job: count fired tickets per kitchen, step the load level up at the thresholds and back down
   * on recovery (below threshold × recoverRatio). BUSY adds prep time to new quotes; OVERLOADED stops ASAP orders.
   * Also flags tickets that passed their station target (13.5).
   */
  async loadSweep() {
    await this.db.execute(sql`update kitchen_tickets t set delayed_at = now() from orders o where o.id = t.order_id and t.delayed_at is null and (
      (t.status = 'IN_PROGRESS' and t.started_at + make_interval(mins => coalesce((select s.target_minutes from stations s where s.id = t.station_id), 10)) < now()) or
      (t.status = 'QUEUED' and coalesce(t.fire_at, t.created_at) + make_interval(mins => coalesce((select s.target_minutes from stations s where s.id = t.station_id), 10)) < now()))`);
    const base = { ...DEFAULT_AUTO_THROTTLE, ...(await this.settings.getObject<Partial<AutoThrottle>>('kitchen.autoThrottle', {})) };
    const loads = (await this.db.execute(sql`select l.kitchen_id as kitchen_id, count(*)::int as active from kitchen_tickets t join orders o on o.id = t.order_id join locations l on l.id = o.location_id
      where l.kitchen_id is not null and (t.status = 'IN_PROGRESS' or (t.status = 'QUEUED' and coalesce(t.fire_at, now()) <= now() + interval '5 minutes')) group by 1`) as unknown as { rows: { kitchen_id: string; active: number }[] }).rows;
    const ks = await this.db.select().from(kitchens);
    const changed: { kitchenId: string; from: string; to: string; active: number }[] = [];
    for (const k of ks) {
      const cfg = { ...base, ...((k.autoThrottle as Partial<AutoThrottle> | null) || {}) };
      const active = loads.find((x) => x.kitchen_id === k.id)?.active ?? 0;
      let level = k.loadLevel;
      if (!cfg.enabled) level = 'NORMAL';
      else if (active >= cfg.overloadAtActiveTickets) level = 'OVERLOADED';
      else if (active >= cfg.busyAtActiveTickets) level = k.loadLevel === 'OVERLOADED' && active >= cfg.overloadAtActiveTickets * cfg.recoverRatio ? 'OVERLOADED' : 'BUSY';
      else if (k.loadLevel === 'OVERLOADED') level = active >= cfg.overloadAtActiveTickets * cfg.recoverRatio ? 'OVERLOADED' : active >= cfg.busyAtActiveTickets * cfg.recoverRatio ? 'BUSY' : 'NORMAL';
      else if (k.loadLevel === 'BUSY') level = active >= cfg.busyAtActiveTickets * cfg.recoverRatio ? 'BUSY' : 'NORMAL';
      if (level === k.loadLevel) continue;
      await this.db.update(kitchens).set({ loadLevel: level, loadChangedAt: new Date() }).where(eq(kitchens.id, k.id));
      changed.push({ kitchenId: k.id, from: k.loadLevel, to: level, active });
      await this.audit.log({ organizationId: k.organizationId, actorId: null, action: 'kitchen.load', entityType: 'kitchen', entityId: k.id, before: { loadLevel: k.loadLevel }, after: { loadLevel: level, activeTickets: active } });
      if (level === 'OVERLOADED') await this.db.insert(opsAlerts).values({ type: 'KITCHEN_OVERLOAD', severity: 'HIGH', title: `${k.name} is overloaded`, detail: `${active} active tickets. ASAP orders are paused and prep times extended until the queue recovers.`, subjectType: 'kitchen', subjectId: k.id, organizationId: k.organizationId, dedupeKey: `kitchen-load:${k.id}`, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + 20 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'Auto-throttle engaged' }] }).onConflictDoNothing();
      if (level === 'NORMAL') await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: 'Kitchen load recovered' }).where(and(eq(opsAlerts.dedupeKey, `kitchen-load:${k.id}`), ne(opsAlerts.status, 'RESOLVED')));
    }
    return { kitchens: ks.length, changed };
  }

  /** Load level for the quote: BUSY adds minutes; OVERLOADED stops ASAP orders. */
  async loadFor(kitchenId: string | null, tx: DbOrTx = this.db) {
    if (!kitchenId) return null;
    const [k] = await tx.select({ level: kitchens.loadLevel, autoThrottle: kitchens.autoThrottle }).from(kitchens).where(eq(kitchens.id, kitchenId)).limit(1);
    if (!k || k.level === 'NORMAL') return null;
    const cfg = { ...DEFAULT_AUTO_THROTTLE, ...(await this.settings.getObject<Partial<AutoThrottle>>('kitchen.autoThrottle', {})), ...((k.autoThrottle as Partial<AutoThrottle> | null) || {}) };
    return { level: k.level, extraMinutes: cfg.busyExtraMinutes };
  }

  /** Admin: every kitchen with load level, fired/in-progress/delayed tickets, packing backlog and ready orders waiting. */
  async adminKitchens(user: JwtPayload) {
    assertCan(user, 'kitchens.read', 'ops.read');
    const ks = await this.db.select({ k: kitchens, org: organizations.name }).from(kitchens).innerJoin(organizations, eq(organizations.id, kitchens.organizationId)).orderBy(kitchens.name);
    const stats = (await this.db.execute(sql`select l.kitchen_id as kitchen_id,
        count(*) filter (where t.status = 'QUEUED')::int as queued,
        count(*) filter (where t.status = 'IN_PROGRESS')::int as in_progress,
        count(*) filter (where t.status in ('QUEUED','IN_PROGRESS') and t.delayed_at is not null)::int as delayed,
        count(*) filter (where t.kind = 'REMAKE' and t.created_at > now() - interval '1 day')::int as remakes_today
      from kitchen_tickets t join orders o on o.id = t.order_id join locations l on l.id = o.location_id
      where l.kitchen_id is not null and (t.status in ('QUEUED','IN_PROGRESS') or t.created_at > now() - interval '1 day') group by 1`) as unknown as { rows: { kitchen_id: string; queued: number; in_progress: number; delayed: number; remakes_today: number }[] }).rows;
    const waiting = (await this.db.execute(sql`select l.kitchen_id as kitchen_id, count(*) filter (where o.status = 'READY')::int as ready_waiting,
        count(*) filter (where p.status in ('VERIFYING','BLOCKED'))::int as to_pack
      from orders o join locations l on l.id = o.location_id left join packing_tasks p on p.order_id = o.id
      where l.kitchen_id is not null and o.status in ('ACCEPTED','PREPARING','READY') group by 1`) as unknown as { rows: { kitchen_id: string; ready_waiting: number; to_pack: number }[] }).rows;
    return ks.map(({ k, org }) => {
      const st = stats.find((x) => x.kitchen_id === k.id);
      const w = waiting.find((x) => x.kitchen_id === k.id);
      return { id: k.id, name: k.name, organization: org, city: k.city, loadLevel: k.loadLevel, loadChangedAt: k.loadChangedAt, queued: st?.queued ?? 0, inProgress: st?.in_progress ?? 0, delayed: st?.delayed ?? 0, remakesToday: st?.remakes_today ?? 0, toPack: w?.to_pack ?? 0, readyWaiting: w?.ready_waiting ?? 0 };
    });
  }

  // ───── packing (14.1–14.4) ─────

  /** Packing screen: verify each line and checklist item into the bag; release only when everything is accounted for. */
  async packingQueue(user: JwtPayload, kitchenId: string) {
    await this.requireKitchen(user, kitchenId);
    const locIds = await this.locIdsFor(kitchenId);
    if (!locIds.length) return [];
    return this.packingFor(locIds);
  }

  /** Packing for a single location (independent restaurants use this from the tablet). */
  async packingForLocation(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, loc.id);
    return this.packingFor([loc.id]);
  }

  private async packingFor(locIds: string[]) {
    const rows = await this.db.select({ task: packingTasks, order: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(and(inArray(orders.locationId, locIds), inArray(packingTasks.status, ['WAITING', 'VERIFYING', 'BLOCKED']), inArray(orders.status, ['ACCEPTED', 'PREPARING']))).orderBy(orders.promiseAt);
    const ids = rows.map((r) => r.order.id);
    const lines = ids.length ? await this.db.select().from(orderLines).where(inArray(orderLines.orderId, ids)) : [];
    return rows.map((r) => ({ ...r.task, orderId: r.order.id, orderNumber: r.order.number, promiseAt: r.order.promiseAt, fulfillmentType: r.order.fulfillmentType, tableNumber: r.order.tableNumber, utensils: r.order.utensils, lines: lines.filter((l) => l.orderId === r.order.id) }));
  }

  private async requirePack(user: JwtPayload, packingTaskId: string) {
    const [p] = await this.db.select({ task: packingTasks, order: orders }).from(packingTasks).innerJoin(orders, eq(orders.id, packingTasks.orderId)).where(eq(packingTasks.id, packingTaskId)).limit(1);
    if (!p) throw new NotFoundException();
    assertOrgAccess(user, p.order.organizationId, p.order.locationId);
    return p;
  }

  async verifyLine(user: JwtPayload, packingTaskId: string, lineId: string) {
    const p = await this.requirePack(user, packingTaskId);
    const ids = Array.from(new Set([...p.task.verifiedLineIds, lineId]));
    const [u] = await this.db.update(packingTasks).set({ verifiedLineIds: ids }).where(eq(packingTasks.id, packingTaskId)).returning();
    return u;
  }

  /** 14.1 tick a checklist item (utensils, drinks, seal, extras). */
  async checkItem(user: JwtPayload, packingTaskId: string, key: string, done: boolean) {
    const p = await this.requirePack(user, packingTaskId);
    const list = p.task.checklist as { key: string; label: string; done: boolean }[];
    if (!list.some((c) => c.key === key)) throw new NotFoundException('Checklist item not found');
    const [u] = await this.db.update(packingTasks).set({ checklist: list.map((c) => (c.key === key ? { ...c, done } : c)) }).where(eq(packingTasks.id, packingTaskId)).returning();
    return u;
  }

  /** 14.2 set how many bags the order travels in; hot and cold go in separate bags. */
  async setBags(user: JwtPayload, packingTaskId: string, count: number) {
    const p = await this.requirePack(user, packingTaskId);
    const [u] = await this.db.update(packingTasks).set({ bagCount: count, bags: this.buildBags(p.task.bagCode, count, p.task.handling) }).where(eq(packingTasks.id, packingTaskId)).returning();
    return u;
  }

  /** 14.2 printable bag labels: order, bag n of N, handling flags, allergy notes. No pickup code is printed. */
  async labels(user: JwtPayload, packingTaskId: string) {
    const p = await this.requirePack(user, packingTaskId);
    const [loc] = await this.db.select({ name: locations.name }).from(locations).where(eq(locations.id, p.order.locationId)).limit(1);
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, p.order.id));
    const firstName = (p.order.guestName || '').split(' ')[0] || null;
    return {
      locationName: loc?.name, orderNumber: p.order.number, customer: firstName, fulfillmentType: p.order.fulfillmentType, tableNumber: p.order.tableNumber, promiseAt: p.order.promiseAt, shelfSlot: p.order.shelfSlot,
      bags: (p.task.bags as { n: number; code: string; handling: string[] }[]).map((b) => ({ ...b, of: p.task.bagCount })),
      allergyNotes: lines.filter((l) => l.handling.includes('ALLERGEN')).map((l) => `${l.name}${l.specialInstructions ? `: ${l.specialInstructions}` : ''}`),
      items: lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status)).map((l) => ({ name: l.name, quantity: l.quantity, handling: l.handling })),
    };
  }

  /** A missing item or an unticked checklist item stops bag release (14.4). */
  async releaseBag(user: JwtPayload, packingTaskId: string) {
    const p = await this.requirePack(user, packingTaskId);
    if (p.task.status === 'RELEASED') return p.task;
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, p.order.id));
    const required = lines.filter((l) => !['UNAVAILABLE', 'CREDITED'].includes(l.status));
    const missing = required.filter((l) => !p.task.verifiedLineIds.includes(l.id) || l.status !== 'READY');
    if (missing.length) throw new ConflictException(`Cannot release bag: ${missing.map((m) => m.name).join(', ')} not verified/ready`);
    if (lines.some((l) => l.status === 'UNAVAILABLE')) throw new ConflictException('Unresolved unavailable line; resolve replacement/credit first');
    const open = (p.task.checklist as { label: string; done: boolean }[]).filter((c) => !c.done);
    if (open.length) throw new ConflictException(`Cannot release bag: checklist not complete (${open.map((c) => c.label).join(', ')})`);
    return this.db.transaction(async (tx) => {
      await tx.update(packingTasks).set({ verifiedById: user.sub }).where(eq(packingTasks.id, packingTaskId));
      const shelfSlot = await this.markOrderReady(p.order, tx, user.sub);
      const [u] = await tx.select().from(packingTasks).where(eq(packingTasks.id, packingTaskId));
      return { ...u, shelfSlot };
    });
  }

  // ───── 14.5 / 14.8 pickup board & runner ─────

  /** Ready orders waiting for pickup or a courier, by shelf, with waiting time against the pickup policy. */
  async pickupBoard(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, loc.id);
    const policy = { ...DEFAULT_PICKUP_POLICY, ...(await this.settings.getObject<Partial<PickupPolicy>>('pickup.policy', {})) };
    const rows = await this.db.select().from(orders).where(and(eq(orders.locationId, locationId), eq(orders.status, 'READY'), ne(orders.fulfillmentType, 'DINE_IN'))).orderBy(orders.readyAt);
    const now = Date.now();
    return {
      shelves: loc.pickupShelves, policy,
      orders: rows.map((o) => { const w = o.readyAt ? Math.round((now - o.readyAt.getTime()) / 60_000) : 0; return { id: o.id, number: o.number, fulfillmentType: o.fulfillmentType, name: (o.guestName || '').split(' ')[0] || null, shelfSlot: o.shelfSlot, readyAt: o.readyAt, waitingMinutes: w, overWait: w >= policy.waitAlertMinutes, noShowStage: o.noShowStage }; }),
    };
  }

  async packingSettings(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, loc.id);
    return { kitchenId: loc.kitchenId, pickupShelves: loc.pickupShelves, packingExtras: loc.packingExtras, requirePackVerification: loc.requirePackVerification, effectiveRequired: this.requiresPackVerification(loc) };
  }

  /** 14.8 runner view: dine-in and kiosk orders ready to take to a table. */
  async runner(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, loc.id);
    const rows = await this.db.select().from(orders).where(and(eq(orders.locationId, locationId), eq(orders.fulfillmentType, 'DINE_IN'), inArray(orders.status, ['ACCEPTED', 'PREPARING', 'READY']))).orderBy(orders.readyAt, orders.promiseAt);
    const lines = rows.length ? await this.db.select({ orderId: orderLines.orderId, name: orderLines.name, quantity: orderLines.quantity, status: orderLines.status }).from(orderLines).where(inArray(orderLines.orderId, rows.map((r) => r.id))) : [];
    return rows.map((o) => ({ id: o.id, number: o.number, status: o.status, tableNumber: o.tableNumber, channel: o.channel, name: (o.guestName || '').split(' ')[0] || null, readyAt: o.readyAt, lines: lines.filter((l) => l.orderId === o.id) }));
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

  async createPurchaseOrder(user: JwtPayload, kitchenId: string, input: { supplier: string; supplierId?: string; expectedAt?: string; reason?: string; draft?: boolean; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }) {
    const k = await this.requireKitchen(user, kitchenId);
    // 22.1 only approved suppliers can be ordered from
    let expectedAt = input.expectedAt ? new Date(input.expectedAt) : null;
    if (input.supplierId) {
      const [sup] = await this.db.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
      if (!sup) throw new NotFoundException('Supplier not found');
      if (!sup.approved) throw new BadRequestException({ message: `${sup.name} is not an approved supplier yet`, code: 'SUPPLIER_NOT_APPROVED' });
      input.supplier = sup.name;
      expectedAt = expectedAt ?? new Date(Date.now() + sup.leadTimeDays * 86400_000);
    }
    const t = await this.approvals.thresholds();
    const total = Math.round(input.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0));
    const owner = !!user.orgs?.[k.organizationId]?.roles.includes('MERCHANT_OWNER') || user.roles.includes('PLATFORM_ADMIN');
    const needsApproval = t.purchaseOrderCents > 0 && total > t.purchaseOrderCents && !owner;
    const po = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(purchaseOrders).values({ kitchenId, supplier: input.supplier, supplierId: input.supplierId ?? null, expectedAt, status: input.draft ? 'DRAFT' : needsApproval ? 'PENDING_APPROVAL' : 'ORDERED', totalCents: total }).returning();
      await tx.insert(purchaseOrderLines).values(input.lines.map((l) => ({ ...l, purchaseOrderId: row.id })));
      await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'po.create', entityType: 'purchase_order', entityId: row.id, after: row }, tx);
      return row;
    });
    if (!needsApproval || input.draft) return po;
    const r = await this.approvals.submit(user, { kind: 'PURCHASE_ORDER', summary: `Purchase order $${(total / 100).toFixed(2)} from ${po.supplier} for ${k.name}`, organizationId: k.organizationId, subjectType: 'purchase_order', subjectId: po.id, amountCents: total, payload: { kitchenId }, reason: input.reason || `Supplier order over the $${(t.purchaseOrderCents / 100).toFixed(0)} approval limit`, dedupeKey: `po:${po.id}` });
    return { ...po, approval: r.approval };
  }

  /**
   * Receive a purchase order: each line becomes a lot (lot code, expiry from the line or the ingredient's shelf
   * life, storage area) with a RECEIPT movement; short or over deliveries are recorded as discrepancies (21.7);
   * items sold out for lack of stock come back automatically (21.10).
   */
  async receivePurchaseOrder(user: JwtPayload, poId: string, received: { lineId: string; receivedQty: number; lotCode?: string; expiresAt?: string; storageAreaId?: string; note?: string }[]) {
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
    if (!po) throw new NotFoundException();
    await this.requireKitchen(user, po.kitchenId);
    if (po.status === 'RECEIVED') throw new ConflictException('Already received');
    if (po.status === 'PENDING_APPROVAL') throw new ConflictException('This purchase order is waiting for approval');
    const res = await this.db.transaction(async (tx) => {
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
      const ings = lines.length ? await tx.select().from(ingredients).where(inArray(ingredients.id, lines.map((l) => l.ingredientId))) : [];
      const now = new Date();
      for (const l of lines) {
        const r = received.find((x) => x.lineId === l.id);
        const qty = r?.receivedQty ?? l.quantity;
        const ing = ings.find((i) => i.id === l.ingredientId);
        const base = qty * (ing?.purchaseUnitFactor || 1);
        const discrepancy = qty !== l.quantity ? `${qty < l.quantity ? 'Short' : 'Over'} by ${Math.abs(l.quantity - qty)}${r?.note ? `: ${r.note}` : ''}` : r?.note ?? null;
        await tx.update(purchaseOrderLines).set({ receivedQty: qty, discrepancyNote: discrepancy }).where(eq(purchaseOrderLines.id, l.id));
        if (base > 0) {
          const expiresAt = r?.expiresAt ? new Date(r.expiresAt) : ing?.shelfLifeDays ? new Date(now.getTime() + ing.shelfLifeDays * 86400_000) : null;
          const unitCost = Math.round(l.unitCostCents / (ing?.purchaseUnitFactor || 1));
          await this.addLot(tx, { kitchenId: po.kitchenId, ingredientId: l.ingredientId, quantity: base, unitCostCents: unitCost, lotCode: r?.lotCode || `PO-${po.id.slice(0, 6)}-${l.id.slice(0, 4)}`, expiresAt, storageAreaId: r?.storageAreaId ?? null, supplierId: po.supplierId, purchaseOrderId: po.id }, user.sub);
        }
        await tx.update(ingredients).set({ costCentsPerUnit: Math.round(l.unitCostCents / (ing?.purchaseUnitFactor || 1)) }).where(eq(ingredients.id, l.ingredientId));
      }
      const [u] = await tx.update(purchaseOrders).set({ status: 'RECEIVED', receivedAt: now, billDueAt: po.billDueAt ?? new Date(Date.now() + 30 * 86400_000) }).where(eq(purchaseOrders.id, poId)).returning();
      // 20.6 Gutad-operated kitchens: the supplier bill becomes a payable (inventory in, accounts payable)
      const [own] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.kitchenId, po.kitchenId), eq(locations.platformOperated, true))).limit(1);
      if (own) {
        const total = Math.round(lines.reduce((a, l) => a + (received.find((r) => r.lineId === l.id)?.receivedQty ?? l.quantity) * l.unitCostCents, 0));
        if (total > 0) await this.ledger.post({ currency: 'USD' }, [{ account: 'INVENTORY', debitCents: total, memo: `PO ${po.id.slice(0, 8)} received` }, { account: 'SUPPLIER_PAYABLE', partyId: po.supplier, creditCents: total, memo: `Bill: ${po.supplier}` }], tx);
      }
      return u;
    });
    await this.restoreStockouts(po.kitchenId);
    return res;
  }

  /** 21.4 spoilage / waste, taken from the earliest-expiring lots (or a named lot). */
  async recordWaste(user: JwtPayload, kitchenId: string, input: { ingredientId: string; quantity: number; reason?: string; lotId?: string }) {
    await this.requireKitchen(user, kitchenId);
    await this.db.transaction(async (tx) => {
      await tx.insert(wasteEvents).values({ kitchenId, ingredientId: input.ingredientId, quantity: input.quantity, reason: input.reason ?? null });
      await this.takeFromLots(tx, { kitchenId, ingredientId: input.ingredientId, quantity: input.quantity, kind: 'SPOILAGE', reason: input.reason ?? 'Waste', lotId: input.lotId, createdById: user.sub });
    });
    return { ok: true };
  }

  async recordLabor(user: JwtPayload, kitchenId: string, input: { userId?: string; hours: number; rateCents: number; date: Date }) {
    await this.requireKitchen(user, kitchenId);
    const [r] = await this.db.insert(laborEntries).values({ ...input, kitchenId }).returning();
    return r;
  }

  // ───── stock core (21.3–21.5, 21.10) — shared with the operations module ─────

  async addLot(tx: DbOrTx, input: { kitchenId: string; ingredientId: string; quantity: number; unitCostCents: number; lotCode: string; expiresAt: Date | null; storageAreaId?: string | null; supplierId?: string | null; purchaseOrderId?: string | null; transferId?: string | null; kind?: 'RECEIPT' | 'TRANSFER_IN' | 'ADJUSTMENT' | 'COUNT' }, actorId: string | null) {
    const [lot] = await tx.insert(stockLots).values({ kitchenId: input.kitchenId, ingredientId: input.ingredientId, storageAreaId: input.storageAreaId ?? null, supplierId: input.supplierId ?? null, purchaseOrderId: input.purchaseOrderId ?? null, transferId: input.transferId ?? null, lotCode: input.lotCode, receivedQty: input.quantity, quantity: input.quantity, unitCostCents: input.unitCostCents, receivedAt: new Date(), expiresAt: input.expiresAt }).returning();
    await tx.insert(stockMovements).values({ kitchenId: input.kitchenId, ingredientId: input.ingredientId, lotId: lot.id, kind: input.kind ?? 'RECEIPT', quantity: input.quantity, unitCostCents: input.unitCostCents, referenceId: input.purchaseOrderId ?? input.transferId ?? null, createdById: actorId });
    await tx.insert(ingredientStock).values({ kitchenId: input.kitchenId, ingredientId: input.ingredientId, onHand: input.quantity }).onConflictDoUpdate({ target: [ingredientStock.kitchenId, ingredientStock.ingredientId], set: { onHand: sql`${ingredientStock.onHand} + ${input.quantity}` } });
    return lot;
  }

  /**
   * 21.5 first-expiring-first-out: take a quantity from the available lots that expire first (expired lots are
   * skipped; quarantined ones are never used). Each lot touched gets a movement, so a lot can be traced to orders.
   * Stock without lots (legacy) is taken without a lot. On-hand is always reduced by the full quantity.
   */
  async takeFromLots(tx: DbOrTx, input: { kitchenId: string; ingredientId: string; quantity: number; kind: 'CONSUMPTION' | 'SPOILAGE' | 'TRANSFER_OUT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'COUNT'; reason?: string; orderId?: string | null; referenceId?: string | null; lotId?: string; createdById?: string | null }) {
    let left = input.quantity;
    const taken: { lotId: string; quantity: number }[] = [];
    const lots = input.lotId
      ? await tx.select().from(stockLots).where(and(eq(stockLots.id, input.lotId), eq(stockLots.kitchenId, input.kitchenId)))
      : await tx.select().from(stockLots).where(and(eq(stockLots.kitchenId, input.kitchenId), eq(stockLots.ingredientId, input.ingredientId), eq(stockLots.status, 'AVAILABLE'), sql`${stockLots.quantity} > 0`, sql`(${stockLots.expiresAt} is null or ${stockLots.expiresAt} > now())`)).orderBy(sql`${stockLots.expiresAt} asc nulls last`, stockLots.receivedAt);
    for (const lot of lots) {
      if (left <= 0) break;
      const q = Math.min(lot.quantity, left);
      await tx.update(stockLots).set({ quantity: lot.quantity - q, status: lot.quantity - q <= 0 && input.kind !== 'WITHDRAWAL' ? 'DEPLETED' : lot.status }).where(eq(stockLots.id, lot.id));
      await tx.insert(stockMovements).values({ kitchenId: input.kitchenId, ingredientId: input.ingredientId, lotId: lot.id, kind: input.kind, quantity: -q, unitCostCents: lot.unitCostCents, reason: input.reason ?? null, orderId: input.orderId ?? null, referenceId: input.referenceId ?? null, createdById: input.createdById ?? null });
      taken.push({ lotId: lot.id, quantity: q });
      left -= q;
    }
    if (left > 0) await tx.insert(stockMovements).values({ kitchenId: input.kitchenId, ingredientId: input.ingredientId, kind: input.kind, quantity: -left, reason: input.reason ?? 'Unlotted stock', orderId: input.orderId ?? null, referenceId: input.referenceId ?? null, createdById: input.createdById ?? null });
    const [row] = await tx.update(ingredientStock).set({ onHand: sql`greatest(0, ${ingredientStock.onHand} - ${input.quantity})` }).where(and(eq(ingredientStock.kitchenId, input.kitchenId), eq(ingredientStock.ingredientId, input.ingredientId))).returning();
    return { taken, onHand: row?.onHand ?? 0 };
  }

  /** Menu items served from this kitchen whose recipe uses an ingredient. */
  async itemsUsingIngredient(tx: DbOrTx, kitchenId: string | null, ingredientIds: string[]) {
    if (!ingredientIds.length) return [] as string[];
    const r = await tx.execute(sql`select distinct mi.id from menu_items mi join recipe_lines rl on rl.recipe_id = mi.recipe_id join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id join locations l on l.id = m.location_id
      where rl.ingredient_id = any(${'{' + ingredientIds.join(',') + '}'}::uuid[]) ${kitchenId ? sql`and l.kitchen_id = ${kitchenId}` : sql``}`);
    return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
  }

  /** 21.10 bring back items sold out for lack of stock once every recipe ingredient is back on hand. */
  async restoreStockouts(kitchenId: string) {
    const r = await this.db.execute(sql`update menu_items mi set sold_out = false, sold_out_source = null from menu_categories c, menus m, locations l
      where mi.category_id = c.id and c.menu_id = m.id and m.location_id = l.id and l.kitchen_id = ${kitchenId} and mi.sold_out and mi.sold_out_source = 'STOCKOUT'
      and not exists (select 1 from recipe_lines rl left join ingredient_stock s on s.ingredient_id = rl.ingredient_id and s.kitchen_id = ${kitchenId} where rl.recipe_id = mi.recipe_id and coalesce(s.on_hand, 0) <= 0)
      returning mi.id`);
    return (r as unknown as { rows: unknown[] }).rows.length;
  }

  /** Deduct recipe ingredients for prepared lines (FEFO lots, traced to the order); an ingredient that runs out sells out the items that use it at this kitchen. */
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
    const orderId = lines[0]?.orderId ?? null;
    const out: string[] = [];
    for (const [ingredientId, qty] of usage) {
      const [has] = await tx.select({ onHand: ingredientStock.onHand }).from(ingredientStock).where(and(eq(ingredientStock.kitchenId, kitchenId), eq(ingredientStock.ingredientId, ingredientId))).limit(1);
      if (!has) continue; // ingredient not stocked at this kitchen
      const r = await this.takeFromLots(tx, { kitchenId, ingredientId, quantity: qty, kind: 'CONSUMPTION', orderId, reason: 'Order' });
      if (r.onHand <= 0) out.push(ingredientId);
    }
    if (out.length) {
      const affected = await this.itemsUsingIngredient(tx, kitchenId, out);
      if (affected.length) await tx.update(menuItems).set({ soldOut: true, soldOutUntil: null, soldOutSource: 'STOCKOUT' }).where(and(inArray(menuItems.id, affected), eq(menuItems.soldOut, false)));
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
