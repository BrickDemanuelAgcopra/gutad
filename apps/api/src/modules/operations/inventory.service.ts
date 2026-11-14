import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DEFAULT_FORECAST_CONFIG, type ForecastConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { coupons, locations, menuCategories, menuItems, menus, recipeLines } from '../../db/schema';
import { ingredientStock, ingredients, kitchens, purchaseOrderLines, purchaseOrders, stockLots, stockMovements, stockTransfers, storageAreas, suppliers } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { KitchenService } from '../kitchen/kitchen.service';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const n = (x: unknown) => (x == null ? 0 : Number(x));
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Phase I, section 21: inventory, procurement and warehouse. Quantities are in each ingredient's base unit. */
@Injectable()
export class InventoryService {
  constructor(@Inject(DB) private readonly db: Db, private readonly kitchen: KitchenService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  private k(user: JwtPayload, kitchenId: string) { return this.kitchen.requireKitchen(user, kitchenId); }

  // 21.1 / 21.2 item masters
  async items(user: JwtPayload, kitchenId: string) {
    const k = await this.k(user, kitchenId);
    const list = await this.db.select({ i: ingredients, onHand: ingredientStock.onHand, par: ingredientStock.parLevel, safety: ingredientStock.safetyStock }).from(ingredients).leftJoin(ingredientStock, and(eq(ingredientStock.ingredientId, ingredients.id), eq(ingredientStock.kitchenId, kitchenId))).where(or(isNull(ingredients.organizationId), eq(ingredients.organizationId, k.organizationId))).orderBy(ingredients.name);
    return list.map((x) => ({ ...x.i, onHand: x.onHand ?? 0, parLevel: x.par ?? 0, safetyStock: x.safety ?? 0, valueCents: Math.round((x.onHand ?? 0) * x.i.costCentsPerUnit) }));
  }

  async updateItem(user: JwtPayload, kitchenId: string, ingredientId: string, input: { kind?: string; purchaseUnit?: string | null; purchaseUnitFactor?: number; supplierId?: string | null; shelfLifeDays?: number | null; minTempC?: number | null; maxTempC?: number | null; parLevel?: number; safetyStock?: number }) {
    const k = await this.k(user, kitchenId);
    const [ing] = await this.db.select().from(ingredients).where(eq(ingredients.id, ingredientId)).limit(1);
    if (!ing) throw new NotFoundException();
    if (ing.organizationId && ing.organizationId !== k.organizationId) throw new ForbiddenException();
    const { parLevel, safetyStock, ...master } = input;
    if (Object.keys(master).length) {
      if (!ing.organizationId && !isPlatformStaff(user)) throw new ForbiddenException('Shared catalog items are maintained by Gutad culinary');
      await this.db.update(ingredients).set(master).where(eq(ingredients.id, ingredientId));
    }
    if (parLevel !== undefined || safetyStock !== undefined) await this.db.insert(ingredientStock).values({ kitchenId, ingredientId, parLevel: parLevel ?? 0, safetyStock: safetyStock ?? 0 }).onConflictDoUpdate({ target: [ingredientStock.kitchenId, ingredientStock.ingredientId], set: { ...(parLevel !== undefined ? { parLevel } : {}), ...(safetyStock !== undefined ? { safetyStock } : {}) } });
    return { ok: true };
  }

  /** 21.2 expected consumption for planned portions of each menu item (from recipes). */
  async expectedConsumption(user: JwtPayload, kitchenId: string, plan: { menuItemId: string; portions: number }[]) {
    await this.k(user, kitchenId);
    if (!plan.length) return [];
    const r = rows<{ ingredient_id: string; name: string; unit: string; qty: number; on_hand: number | null }>(await this.db.execute(sql`select i.id as ingredient_id, i.name, i.unit, sum(rl.quantity / greatest(r.yield_portions, 1) * p.portions) as qty, max(s.on_hand) as on_hand
      from (select * from jsonb_to_recordset(${JSON.stringify(plan)}::jsonb) as x("menuItemId" uuid, portions numeric)) p join menu_items mi on mi.id = p."menuItemId" join recipes r on r.id = mi.recipe_id join recipe_lines rl on rl.recipe_id = r.id join ingredients i on i.id = rl.ingredient_id left join ingredient_stock s on s.ingredient_id = i.id and s.kitchen_id = ${kitchenId}
      group by 1, 2, 3 order by 2`));
    return r.map((x) => ({ ingredientId: x.ingredient_id, name: x.name, unit: x.unit, neededQty: r2(n(x.qty)), onHand: n(x.on_hand), shortBy: r2(Math.max(0, n(x.qty) - n(x.on_hand))) }));
  }

  // 21.3 storage & lots
  async storage(user: JwtPayload, kitchenId: string) { await this.k(user, kitchenId); return this.db.select().from(storageAreas).where(eq(storageAreas.kitchenId, kitchenId)).orderBy(storageAreas.name); }
  async addStorage(user: JwtPayload, kitchenId: string, input: { name: string; kind: string; minTempC?: number | null; maxTempC?: number | null }) {
    const k = await this.k(user, kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const [r] = await this.db.insert(storageAreas).values({ kitchenId, name: input.name, kind: input.kind, minTempC: input.minTempC ?? null, maxTempC: input.maxTempC ?? null }).returning();
    return r;
  }

  async lots(user: JwtPayload, kitchenId: string, f: { ingredientId?: string; status?: string; expiringDays?: number }) {
    await this.k(user, kitchenId);
    const list = await this.db.select({ l: stockLots, name: ingredients.name, unit: ingredients.unit, area: storageAreas.name, supplier: suppliers.name }).from(stockLots).innerJoin(ingredients, eq(ingredients.id, stockLots.ingredientId)).leftJoin(storageAreas, eq(storageAreas.id, stockLots.storageAreaId)).leftJoin(suppliers, eq(suppliers.id, stockLots.supplierId))
      .where(and(eq(stockLots.kitchenId, kitchenId), ...(f.ingredientId ? [eq(stockLots.ingredientId, f.ingredientId)] : []), ...(f.status ? [eq(stockLots.status, f.status)] : [sql`${stockLots.status} <> 'DEPLETED'`]), ...(f.expiringDays ? [sql`${stockLots.expiresAt} < ${new Date(Date.now() + f.expiringDays * 86400_000).toISOString()}`] : []))).orderBy(sql`${stockLots.expiresAt} asc nulls last`).limit(500);
    const now = Date.now();
    return list.map((x) => ({ ...x.l, ingredient: x.name, unit: x.unit, storageArea: x.area, supplier: x.supplier, daysLeft: x.l.expiresAt ? Math.floor((x.l.expiresAt.getTime() - now) / 86400_000) : null }));
  }

  /** 21.5 which lots to pick for a quantity (first expiring first out). */
  async pickSuggestion(user: JwtPayload, kitchenId: string, ingredientId: string, quantity: number) {
    await this.k(user, kitchenId);
    const lots = await this.db.select().from(stockLots).where(and(eq(stockLots.kitchenId, kitchenId), eq(stockLots.ingredientId, ingredientId), eq(stockLots.status, 'AVAILABLE'), sql`${stockLots.quantity} > 0`, sql`(${stockLots.expiresAt} is null or ${stockLots.expiresAt} > now())`)).orderBy(sql`${stockLots.expiresAt} asc nulls last`, stockLots.receivedAt);
    let left = quantity;
    const picks: { lotId: string; lotCode: string; quantity: number; expiresAt: Date | null }[] = [];
    for (const l of lots) { if (left <= 0) break; const q = Math.min(l.quantity, left); picks.push({ lotId: l.id, lotCode: l.lotCode, quantity: r2(q), expiresAt: l.expiresAt }); left -= q; }
    return { picks, shortBy: r2(Math.max(0, left)) };
  }

  // 21.4 movements, counts, adjustments
  async movements(user: JwtPayload, kitchenId: string, f: { ingredientId?: string; kind?: string; days?: number }) {
    await this.k(user, kitchenId);
    return this.db.select({ m: stockMovements, name: ingredients.name, unit: ingredients.unit, lot: stockLots.lotCode }).from(stockMovements).innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId)).leftJoin(stockLots, eq(stockLots.id, stockMovements.lotId)).where(and(eq(stockMovements.kitchenId, kitchenId), ...(f.ingredientId ? [eq(stockMovements.ingredientId, f.ingredientId)] : []), ...(f.kind ? [eq(stockMovements.kind, f.kind)] : []), gte(stockMovements.createdAt, new Date(Date.now() - (f.days || 7) * 86400_000)))).orderBy(desc(stockMovements.createdAt)).limit(500).then((r) => r.map((x) => ({ ...x.m, ingredient: x.name, unit: x.unit, lotCode: x.lot })));
  }

  /** A stock count sets the counted quantity; the difference is a COUNT movement (shrinkage or found stock). */
  async count(user: JwtPayload, kitchenId: string, counts: { ingredientId: string; counted: number }[], note?: string) {
    await this.k(user, kitchenId);
    const out: { ingredientId: string; before: number; counted: number; diff: number }[] = [];
    await this.db.transaction(async (tx) => {
      for (const c of counts) {
        const [s] = await tx.select().from(ingredientStock).where(and(eq(ingredientStock.kitchenId, kitchenId), eq(ingredientStock.ingredientId, c.ingredientId))).limit(1);
        const before = s?.onHand ?? 0;
        const diff = r2(c.counted - before);
        if (diff < 0) await this.kitchen.takeFromLots(tx, { kitchenId, ingredientId: c.ingredientId, quantity: -diff, kind: 'COUNT', reason: note || 'Stock count', createdById: user.sub });
        if (diff > 0) { const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, c.ingredientId)).limit(1); await this.kitchen.addLot(tx, { kitchenId, ingredientId: c.ingredientId, quantity: diff, unitCostCents: ing?.costCentsPerUnit ?? 0, lotCode: `COUNT-${new Date().toISOString().slice(0, 10)}`, expiresAt: null, kind: 'COUNT' }, user.sub); }
        out.push({ ingredientId: c.ingredientId, before, counted: c.counted, diff });
      }
    });
    await this.audit.log({ actorId: user.sub, action: 'inventory.count', entityType: 'kitchen', entityId: kitchenId, after: out, reason: note });
    await this.kitchen.restoreStockouts(kitchenId);
    return out;
  }

  // 21.7 / 22.1 suppliers
  async suppliersList(user: JwtPayload, organizationId?: string) {
    if (organizationId) assertOrgAccess(user, organizationId); else if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select().from(suppliers).where(organizationId ? or(eq(suppliers.organizationId, organizationId), isNull(suppliers.organizationId)) : sql`true`).orderBy(suppliers.name);
  }

  async upsertSupplier(user: JwtPayload, input: { id?: string; organizationId?: string | null; name: string; contactName?: string; email?: string; phone?: string; leadTimeDays?: number; deliveryDays?: number[]; specs?: { ingredientId: string; spec: string; minTempC?: number; maxTempC?: number; shelfLifeDays?: number }[]; notes?: string }) {
    if (input.organizationId) assertOrgAccess(user, input.organizationId, null, MANAGER_ROLES); else assertCan(user, 'kitchens.manage', 'culinary.manage');
    const v = { organizationId: input.organizationId ?? null, name: input.name, contactName: input.contactName ?? null, email: input.email ?? null, phone: input.phone ?? null, leadTimeDays: input.leadTimeDays ?? 2, deliveryDays: input.deliveryDays ?? [], specs: input.specs ?? [], notes: input.notes ?? null };
    if (input.id) {
      const [cur] = await this.db.select().from(suppliers).where(eq(suppliers.id, input.id)).limit(1);
      if (!cur) throw new NotFoundException();
      // a spec change sends the supplier back for approval
      const specsChanged = JSON.stringify(cur.specs) !== JSON.stringify(v.specs);
      const [u] = await this.db.update(suppliers).set({ ...v, ...(specsChanged ? { approved: false, approvedAt: null, approvedById: null } : {}) }).where(eq(suppliers.id, input.id)).returning();
      return u;
    }
    const [r] = await this.db.insert(suppliers).values(v).returning();
    return r;
  }

  /** 22.1 approval: Gutad food safety for shared suppliers, the merchant owner/manager for their own; never the person who created the spec change… (recorded). */
  async approveSupplier(user: JwtPayload, id: string, approved: boolean, note: string) {
    const [s] = await this.db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    if (!s) throw new NotFoundException();
    if (s.organizationId) assertOrgAccess(user, s.organizationId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']); else assertCan(user, 'culinary.manage');
    const [u] = await this.db.update(suppliers).set({ approved, approvedAt: approved ? new Date() : null, approvedById: approved ? user.sub : null }).where(eq(suppliers.id, id)).returning();
    await this.audit.log({ organizationId: s.organizationId, actorId: user.sub, action: approved ? 'supplier.approve' : 'supplier.revoke', entityType: 'supplier', entityId: id, reason: note });
    return u;
  }

  /** 21.7 purchase orders with delivery schedule and discrepancies. */
  async purchaseOrdersFor(user: JwtPayload, kitchenId: string) {
    await this.k(user, kitchenId);
    const pos = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.kitchenId, kitchenId)).orderBy(desc(purchaseOrders.createdAt)).limit(100);
    const lines = pos.length ? await this.db.select({ l: purchaseOrderLines, name: ingredients.name, unit: ingredients.unit, pu: ingredients.purchaseUnit }).from(purchaseOrderLines).innerJoin(ingredients, eq(ingredients.id, purchaseOrderLines.ingredientId)).where(inArray(purchaseOrderLines.purchaseOrderId, pos.map((p) => p.id))) : [];
    return pos.map((p) => ({ ...p, late: p.status === 'ORDERED' && !!p.expectedAt && p.expectedAt.getTime() < Date.now(), lines: lines.filter((x) => x.l.purchaseOrderId === p.id).map((x) => ({ ...x.l, ingredient: x.name, unit: x.pu || x.unit })) }));
  }

  async sendDraft(user: JwtPayload, poId: string) {
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
    if (!po) throw new NotFoundException();
    await this.k(user, po.kitchenId);
    if (po.status !== 'DRAFT') throw new ConflictException('Only drafts can be sent');
    const [u] = await this.db.update(purchaseOrders).set({ status: 'ORDERED' }).where(eq(purchaseOrders.id, poId)).returning();
    return u;
  }

  /**
   * 21.8 three-way match: purchase order ↔ goods received ↔ supplier invoice, per line and in total, within the
   * tolerance (setting `procurement.matchTolerancePct`, default 2%).
   */
  async recordInvoice(user: JwtPayload, poId: string, input: { invoiceNumber: string; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }) {
    const [po] = await this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
    if (!po) throw new NotFoundException();
    await this.k(user, po.kitchenId);
    return this.matchInvoice(po, input, user.sub);
  }

  /** The three-way match itself (staff entry, or a supplier submission via portal / EDI with no user: 21.8-P). */
  async matchInvoice(po: typeof purchaseOrders.$inferSelect, input: { invoiceNumber: string; lines: { ingredientId: string; quantity: number; unitCostCents: number }[] }, actorId: string | null, source = 'STAFF') {
    const poId = po.id;
    if (po.status !== 'RECEIVED') throw new ConflictException('Receive the goods before matching the invoice');
    const tol = await this.settings.get<number>('procurement.matchTolerancePct', 2);
    const lines = await this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
    const detail = lines.map((l) => {
      const inv = input.lines.find((x) => x.ingredientId === l.ingredientId);
      const ordered = l.quantity * l.unitCostCents, receivedC = (l.receivedQty ?? 0) * l.unitCostCents, invoiced = inv ? inv.quantity * inv.unitCostCents : 0;
      const qtyOk = !!inv && Math.abs(inv.quantity - (l.receivedQty ?? 0)) <= Math.max(0.0001, (l.receivedQty ?? 0) * tol / 100);
      const priceOk = !!inv && Math.abs(inv.unitCostCents - l.unitCostCents) <= l.unitCostCents * tol / 100;
      return { ingredientId: l.ingredientId, orderedQty: l.quantity, receivedQty: l.receivedQty ?? 0, invoicedQty: inv?.quantity ?? 0, poUnitCents: l.unitCostCents, invoiceUnitCents: inv?.unitCostCents ?? null, orderedCents: Math.round(ordered), receivedCents: Math.round(receivedC), invoicedCents: Math.round(invoiced), qtyOk, priceOk };
    });
    const extra = input.lines.filter((x) => !lines.some((l) => l.ingredientId === x.ingredientId));
    const invTotal = Math.round(input.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0));
    const recTotal = detail.reduce((a, d) => a + d.receivedCents, 0);
    const ok = detail.every((d) => d.qtyOk && d.priceOk) && !extra.length && Math.abs(invTotal - recTotal) <= recTotal * tol / 100;
    const [u] = await this.db.update(purchaseOrders).set({ invoiceNumber: input.invoiceNumber, invoiceLines: input.lines, invoiceTotalCents: invTotal, matchStatus: ok ? 'MATCHED' : 'VARIANCE', matchDetail: { tolerancePct: tol, lines: detail, unexpectedLines: extra, receivedCents: recTotal, invoicedCents: invTotal, varianceCents: invTotal - recTotal } }).where(eq(purchaseOrders.id, poId)).returning();
    await this.audit.log({ actorId, action: 'po.invoice_match', entityType: 'purchase_order', entityId: poId, after: { status: u.matchStatus, varianceCents: invTotal - recTotal, source } });
    return u;
  }

  // 21.9 transfers
  async transfers(user: JwtPayload, kitchenId: string) {
    await this.k(user, kitchenId);
    const list = await this.db.select().from(stockTransfers).where(or(eq(stockTransfers.fromKitchenId, kitchenId), eq(stockTransfers.toKitchenId, kitchenId))).orderBy(desc(stockTransfers.createdAt)).limit(100);
    const ks = await this.db.select({ id: kitchens.id, name: kitchens.name }).from(kitchens);
    return list.map((t) => ({ ...t, from: ks.find((k) => k.id === t.fromKitchenId)?.name, to: ks.find((k) => k.id === t.toKitchenId)?.name, direction: t.fromKitchenId === kitchenId ? 'OUT' : 'IN' }));
  }

  async requestTransfer(user: JwtPayload, input: { fromKitchenId: string; toKitchenId: string; lines: { ingredientId: string; quantity: number }[] }) {
    const to = await this.k(user, input.toKitchenId);
    const [from] = await this.db.select().from(kitchens).where(eq(kitchens.id, input.fromKitchenId)).limit(1);
    if (!from || from.organizationId !== to.organizationId) { if (!isPlatformStaff(user)) throw new ForbiddenException('Transfers are between kitchens of the same merchant'); }
    if (input.fromKitchenId === input.toKitchenId) throw new BadRequestException('Pick two different sites');
    const [t] = await this.db.insert(stockTransfers).values({ fromKitchenId: input.fromKitchenId, toKitchenId: input.toKitchenId, lines: input.lines, createdById: user.sub }).returning();
    return t;
  }

  /** Pick (FEFO lots), ship (stock leaves the sender), receive (lots arrive with the same expiry; differences recorded). */
  async advanceTransfer(user: JwtPayload, id: string, step: 'PICK' | 'SHIP' | 'RECEIVE' | 'CANCEL', received?: { ingredientId: string; quantity: number }[], note?: string) {
    const [t] = await this.db.select().from(stockTransfers).where(eq(stockTransfers.id, id)).limit(1);
    if (!t) throw new NotFoundException();
    await this.k(user, step === 'RECEIVE' ? t.toKitchenId : t.fromKitchenId);
    const lines = t.lines as { ingredientId: string; quantity: number; lots?: { lotId: string; quantity: number; expiresAt: string | null; unitCostCents: number; lotCode: string }[]; receivedQty?: number }[];
    if (step === 'CANCEL') {
      if (!['REQUESTED', 'PICKED'].includes(t.status)) throw new ConflictException('Already shipped');
      const [u] = await this.db.update(stockTransfers).set({ status: 'CANCELED' }).where(eq(stockTransfers.id, id)).returning();
      return u;
    }
    if (step === 'PICK') {
      if (t.status !== 'REQUESTED') throw new ConflictException(`Transfer is ${t.status.toLowerCase()}`);
      const picked = [];
      for (const l of lines) { const s = await this.pickSuggestion(user, t.fromKitchenId, l.ingredientId, l.quantity); picked.push({ ...l, lots: s.picks.map((p) => ({ lotId: p.lotId, quantity: p.quantity, expiresAt: p.expiresAt?.toISOString() ?? null, unitCostCents: 0, lotCode: p.lotCode })) }); }
      const [u] = await this.db.update(stockTransfers).set({ status: 'PICKED', pickedAt: new Date(), lines: picked }).where(eq(stockTransfers.id, id)).returning();
      return u;
    }
    if (step === 'SHIP') {
      if (t.status !== 'PICKED') throw new ConflictException('Pick the transfer first');
      await this.db.transaction(async (tx) => {
        for (const l of lines) {
          for (const p of l.lots || []) { const [lot] = await tx.select().from(stockLots).where(eq(stockLots.id, p.lotId)).limit(1); p.unitCostCents = lot?.unitCostCents ?? 0; await this.kitchen.takeFromLots(tx, { kitchenId: t.fromKitchenId, ingredientId: l.ingredientId, quantity: p.quantity, kind: 'TRANSFER_OUT', lotId: p.lotId, referenceId: t.id, reason: 'Transfer', createdById: user.sub }); }
          const lotted = (l.lots || []).reduce((a, p) => a + p.quantity, 0);
          if (l.quantity > lotted) await this.kitchen.takeFromLots(tx, { kitchenId: t.fromKitchenId, ingredientId: l.ingredientId, quantity: l.quantity - lotted, kind: 'TRANSFER_OUT', referenceId: t.id, reason: 'Transfer', createdById: user.sub });
        }
        await tx.update(stockTransfers).set({ status: 'SHIPPED', shippedAt: new Date(), lines }).where(eq(stockTransfers.id, id));
      });
      return (await this.db.select().from(stockTransfers).where(eq(stockTransfers.id, id)))[0];
    }
    if (t.status !== 'SHIPPED') throw new ConflictException('Not shipped yet');
    const diffs: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const l of lines) {
        const got = received?.find((r) => r.ingredientId === l.ingredientId)?.quantity ?? l.quantity;
        l.receivedQty = got;
        if (got !== l.quantity) diffs.push(`${l.ingredientId.slice(0, 8)}: sent ${l.quantity}, received ${got}`);
        let left = got;
        for (const p of l.lots || []) { if (left <= 0) break; const q = Math.min(p.quantity, left); await this.kitchen.addLot(tx, { kitchenId: t.toKitchenId, ingredientId: l.ingredientId, quantity: q, unitCostCents: p.unitCostCents, lotCode: p.lotCode, expiresAt: p.expiresAt ? new Date(p.expiresAt) : null, transferId: t.id, kind: 'TRANSFER_IN' }, user.sub); left -= q; }
        if (left > 0) await this.kitchen.addLot(tx, { kitchenId: t.toKitchenId, ingredientId: l.ingredientId, quantity: left, unitCostCents: 0, lotCode: `TR-${t.id.slice(0, 6)}`, expiresAt: null, transferId: t.id, kind: 'TRANSFER_IN' }, user.sub);
      }
      await tx.update(stockTransfers).set({ status: 'RECEIVED', receivedAt: new Date(), receivedById: user.sub, lines, discrepancy: diffs.length ? `${diffs.join('; ')}${note ? ` — ${note}` : ''}` : note ?? null }).where(eq(stockTransfers.id, id));
    });
    await this.kitchen.restoreStockouts(t.toKitchenId);
    return (await this.db.select().from(stockTransfers).where(eq(stockTransfers.id, id)))[0];
  }

  // 21.6 forecast & replenishment

  /** Average daily consumption per ingredient by weekday over the last 4 weeks (from CONSUMPTION movements). */
  private async demand(kitchenId: string, weeks = 4) {
    const r = rows<{ ingredient_id: string; dow: number; qty: number }>(await this.db.execute(sql`select ingredient_id, extract(dow from created_at)::int as dow, sum(-quantity) / ${weeks}::numeric as qty from stock_movements
      where kitchen_id = ${kitchenId} and kind = 'CONSUMPTION' and created_at > now() - make_interval(days => ${weeks * 7}) group by 1, 2`));
    const by = new Map<string, number[]>();
    for (const x of r) { const a = by.get(x.ingredient_id) || [0, 0, 0, 0, 0, 0, 0]; a[x.dow] = n(x.qty); by.set(x.ingredient_id, a); }
    return by;
  }

  forecastConfig() { return this.settings.getObject<ForecastConfig>('inventory.forecast', DEFAULT_FORECAST_CONFIG); }

  /**
   * 21.6-S seasonal factor per ingredient: recent-weeks trend (last 14 days vs the 14 before, blended by weight) times
   * year-over-year seasonality (the same upcoming days 364 days ago vs the 4 weeks before them), clamped.
   */
  private async seasonalFactors(kitchenId: string, horizonDays: number, cfg: ForecastConfig) {
    const out = new Map<string, { trend: number; yoy: number; factor: number }>();
    const clamp = (x: number) => Math.min(cfg.maxFactor, Math.max(cfg.minFactor, x));
    const blend = (ratio: number, w: number) => 1 + (ratio - 1) * Math.max(0, Math.min(1, w));
    const trend = cfg.trend.enabled ? rows<{ ingredient_id: string; recent: number; older: number }>(await this.db.execute(sql`select ingredient_id, sum(case when created_at > now() - interval '14 days' then -quantity else 0 end) as recent, sum(case when created_at <= now() - interval '14 days' then -quantity else 0 end) as older
      from stock_movements where kitchen_id = ${kitchenId} and kind = 'CONSUMPTION' and created_at > now() - interval '28 days' group by 1`)) : [];
    const yoy = cfg.yearOverYear.enabled ? rows<{ ingredient_id: string; upcoming: number; prior: number }>(await this.db.execute(sql`select ingredient_id,
        sum(case when created_at >= now() - interval '364 days' then -quantity else 0 end) as upcoming,
        sum(case when created_at < now() - interval '364 days' then -quantity else 0 end) as prior
      from stock_movements where kitchen_id = ${kitchenId} and kind = 'CONSUMPTION' and created_at >= now() - interval '392 days' and created_at < now() - interval '364 days' + make_interval(days => ${horizonDays}) group by 1`)) : [];
    const ids = new Set([...trend.map((t) => t.ingredient_id), ...yoy.map((y) => y.ingredient_id)]);
    for (const id of ids) {
      const t = trend.find((x) => x.ingredient_id === id), y = yoy.find((x) => x.ingredient_id === id);
      const tr = t && n(t.older) > 0 ? clamp(blend(Math.max(0, n(t.recent)) / n(t.older), cfg.trend.weight)) : 1;
      const yr = y && n(y.prior) > 0 ? clamp(blend((Math.max(0, n(y.upcoming)) / horizonDays) / (n(y.prior) / 28), cfg.yearOverYear.weight)) : 1;
      out.set(id, { trend: Math.round(tr * 100) / 100, yoy: Math.round(yr * 100) / 100, factor: Math.round(clamp(tr * yr) * 100) / 100 });
    }
    return out;
  }

  /**
   * 21.6-S active promotions at the kitchen locations: automatic offers and campaign coupons (merchant or Gutad-wide)
   * running in the horizon. Item/category-scoped ones lift only the ingredients in those items' recipes.
   */
  async activePromotions(kitchenId: string, horizonDays: number, cfg: ForecastConfig) {
    if (!cfg.promotions.enabled) return [];
    const locs = await this.db.select({ id: locations.id, organizationId: locations.organizationId }).from(locations).where(eq(locations.kitchenId, kitchenId));
    if (!locs.length) return [];
    const orgIds = [...new Set(locs.map((l) => l.organizationId))];
    const end = new Date(Date.now() + horizonDays * 86400_000);
    const list = await this.db.select().from(coupons).where(and(eq(coupons.isActive, true), or(eq(coupons.automatic, true), sql`${coupons.campaignId} is not null`), or(isNull(coupons.startsAt), lt(coupons.startsAt, end)), or(isNull(coupons.expiresAt), gte(coupons.expiresAt, new Date())), or(isNull(coupons.organizationId), inArray(coupons.organizationId, orgIds)), sql`(${coupons.maxUses} is null or ${coupons.uses} < ${coupons.maxUses})`));
    const locIds = locs.map((l) => l.id);
    const relevant = list.filter((c) => !c.locationIds.length || c.locationIds.some((id) => locIds.includes(id)));
    const out: { id: string; code: string; name: string | null; kind: string; automatic: boolean; startsAt: Date | null; expiresAt: Date | null; daysOfWeek: number[]; scope: 'MENU' | 'ITEMS'; ingredientIds: string[] | null }[] = [];
    for (const c of relevant) {
      let ingredientIds: string[] | null = null;
      if (c.itemIds.length || c.categoryIds.length) {
        const recs = await this.db.selectDistinct({ ingredientId: recipeLines.ingredientId }).from(menuItems).innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId)).innerJoin(menus, eq(menus.id, menuCategories.menuId)).innerJoin(recipeLines, eq(recipeLines.recipeId, menuItems.recipeId)).where(and(inArray(menus.locationId, locIds), or(c.itemIds.length ? inArray(menuItems.id, c.itemIds) : sql`false`, c.categoryIds.length ? inArray(menuItems.categoryId, c.categoryIds) : sql`false`)));
        ingredientIds = recs.map((r) => r.ingredientId);
      }
      out.push({ id: c.id, code: c.code, name: c.name, kind: c.kind, automatic: c.automatic, startsAt: c.startsAt, expiresAt: c.expiresAt, daysOfWeek: c.daysOfWeek, scope: ingredientIds ? 'ITEMS' : 'MENU', ingredientIds });
    }
    return out;
  }

  /** Factors behind the forecast: settings and active promotions (web supply UI). */
  async forecastFactors(user: JwtPayload, kitchenId: string, horizonDays = 7) {
    await this.k(user, kitchenId);
    const cfg = await this.forecastConfig();
    const promos = await this.activePromotions(kitchenId, horizonDays, cfg);
    return { config: cfg, horizonDays, promotions: promos.map(({ ingredientIds, ...p }) => ({ ...p, ingredientCount: ingredientIds?.length ?? null })) };
  }

  async forecast(user: JwtPayload, kitchenId: string, horizonDays = 7) {
    await this.k(user, kitchenId);
    const cfg = await this.forecastConfig();
    const by = await this.demand(kitchenId);
    const seasonal = await this.seasonalFactors(kitchenId, horizonDays, cfg);
    const promos = await this.activePromotions(kitchenId, horizonDays, cfg);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    // uplift (fraction) for an ingredient on day d of the horizon: each running promotion adds upliftPct, capped
    const upliftOn = (ingredientId: string, d: number) => {
      const day = new Date(dayStart.getTime() + d * 86400_000), dayEnd = new Date(day.getTime() + 86400_000);
      const hits = promos.filter((p) => (!p.ingredientIds || p.ingredientIds.includes(ingredientId)) && (!p.startsAt || p.startsAt < dayEnd) && (!p.expiresAt || p.expiresAt >= day) && (!p.daysOfWeek.length || p.daysOfWeek.includes(day.getDay())));
      return { pct: Math.min(cfg.promotions.maxUpliftPct, hits.length * cfg.promotions.upliftPct) / 100, codes: hits.map((h) => h.name || h.code) };
    };
    const stock = await this.db.select({ s: ingredientStock, i: ingredients, sup: suppliers }).from(ingredientStock).innerJoin(ingredients, eq(ingredients.id, ingredientStock.ingredientId)).leftJoin(suppliers, eq(suppliers.id, ingredients.supplierId)).where(eq(ingredientStock.kitchenId, kitchenId));
    const onOrder = rows<{ ingredient_id: string; qty: number }>(await this.db.execute(sql`select l.ingredient_id, sum(l.quantity * coalesce(i.purchase_unit_factor, 1)) as qty from purchase_order_lines l join purchase_orders p on p.id = l.purchase_order_id join ingredients i on i.id = l.ingredient_id where p.kitchen_id = ${kitchenId} and p.status in ('ORDERED','PENDING_APPROVAL','DRAFT') group by 1`));
    const today = new Date().getDay();
    return stock.map(({ s, i, sup }) => {
      const week = by.get(i.id) || [0, 0, 0, 0, 0, 0, 0];
      const baseDaily = week.reduce((a, b) => a + b, 0) / 7;
      const lead = sup?.leadTimeDays ?? 2;
      const sf = seasonal.get(i.id) || { trend: 1, yoy: 1, factor: 1 };
      const promoDays = Array.from({ length: Math.max(horizonDays, lead) }, (_, d) => upliftOn(i.id, d));
      const perDay = (d: number) => week[(today + d) % 7] * sf.factor * (1 + promoDays[d].pct);
      const baseHorizon = Array.from({ length: horizonDays }, (_, d) => week[(today + d) % 7]).reduce((a, b) => a + b, 0);
      const horizon = Array.from({ length: horizonDays }, (_, d) => perDay(d)).reduce((a, b) => a + b, 0);
      const leadDemand = Array.from({ length: lead }, (_, d) => perDay(d)).reduce((a, b) => a + b, 0);
      const daily = baseDaily * sf.factor;
      const horizonPromo = promoDays.slice(0, horizonDays);
      const promoUpliftPct = Math.round((horizonPromo.reduce((a, x) => a + x.pct, 0) / Math.max(1, horizonDays)) * 1000) / 10;
      const promotions = [...new Set(horizonPromo.flatMap((x) => x.codes))];
      const safety = Math.max(s.safetyStock, daily * 2);
      const reorderPoint = leadDemand + safety;
      const pending = n(onOrder.find((o) => o.ingredient_id === i.id)?.qty);
      const target = horizon + safety;
      const proposeBase = Math.max(0, target - s.onHand - pending, s.parLevel - s.onHand - pending);
      const factor = i.purchaseUnitFactor || 1;
      return { ingredientId: i.id, name: i.name, unit: i.unit, purchaseUnit: i.purchaseUnit, purchaseUnitFactor: factor, supplierId: sup?.id ?? null, supplier: sup?.name ?? null, supplierApproved: sup?.approved ?? null, onHand: r2(s.onHand), onOrder: r2(pending), dailyDemand: r2(daily), baseDailyDemand: r2(baseDaily), baseHorizonDemand: r2(baseHorizon), trendFactor: sf.trend, yoyFactor: sf.yoy, seasonalFactor: sf.factor, promoUpliftPct, promotions, weekdayDemand: week.map(r2), safetyStock: r2(safety), reorderPoint: r2(reorderPoint), horizonDemand: r2(horizon), daysOfCover: daily ? r2(s.onHand / daily) : null, needsReorder: s.onHand + pending <= reorderPoint || s.onHand < s.parLevel, proposedQty: r2(proposeBase), proposedPurchaseUnits: Math.ceil(proposeBase / factor), unitCostCents: i.costCentsPerUnit };
    }).sort((a, b) => Number(b.needsReorder) - Number(a.needsReorder) || a.name.localeCompare(b.name));
  }

  /** Turn reorder proposals into draft purchase orders, one per approved supplier (unassigned items are listed). */
  async proposeOrders(user: JwtPayload, kitchenId: string) {
    const f = (await this.forecast(user, kitchenId)).filter((x) => x.needsReorder && x.proposedPurchaseUnits > 0);
    const bySup = new Map<string, typeof f>();
    const skipped: { name: string; why: string }[] = [];
    for (const x of f) { if (!x.supplierId) { skipped.push({ name: x.name, why: 'no supplier' }); continue; } if (!x.supplierApproved) { skipped.push({ name: x.name, why: `${x.supplier} not approved` }); continue; } bySup.set(x.supplierId, [...(bySup.get(x.supplierId) || []), x]); }
    const created = [];
    for (const [supplierId, items] of bySup) {
      const po = await this.kitchen.createPurchaseOrder(user, kitchenId, { supplier: '', supplierId, draft: true, reason: 'Replenishment proposal', lines: items.map((x) => ({ ingredientId: x.ingredientId, quantity: x.proposedPurchaseUnits, unitCostCents: Math.round(x.unitCostCents * x.purchaseUnitFactor) })) });
      created.push(po);
    }
    return { drafts: created, skipped };
  }

  // 21.11 reports
  async reports(user: JwtPayload, kitchenId: string, days = 30) {
    await this.k(user, kitchenId);
    const from = new Date(Date.now() - days * 86400_000).toISOString();
    // forecast accuracy: each day's actual vs the same weekday's average of the 4 weeks before it
    const daily = rows<{ day: string; dow: number; ingredient_id: string; qty: number }>(await this.db.execute(sql`select date_trunc('day', created_at) as day, extract(dow from created_at)::int as dow, ingredient_id, sum(-quantity) as qty from stock_movements where kitchen_id = ${kitchenId} and kind = 'CONSUMPTION' and created_at > now() - interval '56 days' group by 1, 2, 3`));
    let absErr = 0, actualSum = 0;
    for (const d of daily.filter((x) => new Date(x.day) >= new Date(from))) {
      const prior = daily.filter((x) => x.ingredient_id === d.ingredient_id && x.dow === d.dow && new Date(x.day) < new Date(d.day) && new Date(x.day) >= new Date(new Date(d.day).getTime() - 28 * 86400_000));
      if (!prior.length) continue;
      const fc = prior.reduce((a, x) => a + n(x.qty), 0) / 4;
      absErr += Math.abs(n(d.qty) - fc); actualSum += n(d.qty);
    }
    const waste = rows<{ name: string; reason: string | null; qty: number; cents: number }>(await this.db.execute(sql`select i.name, m.reason, sum(-m.quantity) as qty, sum(-m.quantity * coalesce(m.unit_cost_cents, i.cost_cents_per_unit))::bigint as cents from stock_movements m join ingredients i on i.id = m.ingredient_id where m.kitchen_id = ${kitchenId} and m.kind in ('SPOILAGE','WITHDRAWAL') and m.created_at >= ${from} group by 1, 2 order by 4 desc limit 30`));
    const sup = rows<{ name: string; pos: number; on_time: number; with_expected: number; ordered: number; received: number; variance: number }>(await this.db.execute(sql`select coalesce(s.name, p.supplier) as name, count(distinct p.id)::int as pos, count(distinct p.id) filter (where p.received_at <= p.expected_at + interval '4 hours')::int as on_time, count(distinct p.id) filter (where p.expected_at is not null and p.received_at is not null)::int as with_expected,
      sum(l.quantity) as ordered, sum(coalesce(l.received_qty, 0)) as received, count(distinct p.id) filter (where p.match_status = 'VARIANCE')::int as variance
      from purchase_orders p left join suppliers s on s.id = p.supplier_id join purchase_order_lines l on l.purchase_order_id = p.id where p.kitchen_id = ${kitchenId} and p.created_at >= ${from} group by 1 order by 2 desc`));
    const val = rows<{ kind: string; cents: number; items: number }>(await this.db.execute(sql`select i.kind, sum(s.on_hand * i.cost_cents_per_unit)::bigint as cents, count(*)::int as items from ingredient_stock s join ingredients i on i.id = s.ingredient_id where s.kitchen_id = ${kitchenId} group by 1`));
    const expiring = rows<{ cents: number }>(await this.db.execute(sql`select coalesce(sum(quantity * unit_cost_cents),0)::bigint as cents from stock_lots where kitchen_id = ${kitchenId} and status = 'AVAILABLE' and quantity > 0 and expires_at < now() + interval '3 days'`))[0];
    return {
      forecastAccuracyPct: actualSum ? Math.max(0, Math.round((1 - absErr / actualSum) * 1000) / 10) : null,
      waste: waste.map((w) => ({ ingredient: w.name, reason: w.reason, quantity: r2(n(w.qty)), cents: n(w.cents) })), wasteCents: waste.reduce((a, w) => a + n(w.cents), 0),
      suppliers: sup.map((s) => ({ supplier: s.name, orders: s.pos, onTimePct: s.with_expected ? Math.round((s.on_time / s.with_expected) * 100) : null, fillRatePct: n(s.ordered) ? Math.round((n(s.received) / n(s.ordered)) * 100) : null, invoiceVariances: s.variance })),
      valuation: val.map((v) => ({ kind: v.kind, cents: n(v.cents), items: v.items })), valuationCents: val.reduce((a, v) => a + n(v.cents), 0), expiringIn3DaysCents: n(expiring?.cents),
    };
  }

  /** Expired lots leave stock as spoilage (hourly). */
  async expireLots(now = new Date()) {
    const due = await this.db.select().from(stockLots).where(and(eq(stockLots.status, 'AVAILABLE'), lt(stockLots.expiresAt, now), sql`${stockLots.quantity} > 0`));
    for (const l of due) {
      await this.db.transaction(async (tx) => {
        await this.kitchen.takeFromLots(tx, { kitchenId: l.kitchenId, ingredientId: l.ingredientId, quantity: l.quantity, kind: 'SPOILAGE', lotId: l.id, reason: 'Expired' });
        await tx.update(stockLots).set({ status: 'EXPIRED' }).where(eq(stockLots.id, l.id));
      });
    }
    return { expired: due.length };
  }
}
