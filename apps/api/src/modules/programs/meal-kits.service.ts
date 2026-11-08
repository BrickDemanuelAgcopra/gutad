import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { mealKitProducts, packingBatches, shipmentCases, shipmentLines, shipments } from '../../db/schema';
import { isPlatformStaff, JwtPayload } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { loadConfig } from '../../config/config';
import { addDays, orderNumber } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

/** 19 — packaged goods inventory, delivery dates, shipping regions, packing batches, tracking and credits. */
@Injectable()
export class MealKitsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly outbox: OutboxService, private readonly payments: PaymentsService) {}

  async upsertProduct(user: JwtPayload, input: Partial<typeof mealKitProducts.$inferInsert> & { sku: string; name: string; priceCents: number }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [p] = await this.db.insert(mealKitProducts).values(input).onConflictDoUpdate({ target: mealKitProducts.sku, set: input }).returning();
    return p;
  }

  async catalog(region?: string) {
    const rows = await this.db.select().from(mealKitProducts).where(eq(mealKitProducts.isActive, true));
    return rows.filter((p) => !region || !p.shipRegions.length || p.shipRegions.includes(region.toUpperCase())).map((p) => ({ ...p, available: p.stockOnHand - p.stockReserved, earliestDeliveryDate: addDays(new Date(), p.leadDays).toISOString().slice(0, 10) }));
  }

  /** Eligible destination + product + delivery date → reserve stock, charge, create shipment. */
  async order(user: JwtPayload, input: { lines: { productId: string; quantity: number }[]; deliveryDate: string; address: Address; paymentMethodId?: string; idempotencyKey?: string }) {
    if (input.idempotencyKey) {
      const [ex] = await this.db.select().from(shipments).where(eq(shipments.orderNumber, input.idempotencyKey)).limit(1);
      if (ex) return ex;
    }
    const deliveryDate = new Date(input.deliveryDate);
    if (isNaN(deliveryDate.getTime())) throw new BadRequestException('Invalid delivery date');
    return this.db.transaction(async (tx) => {
      const products = await tx.select().from(mealKitProducts).where(inArray(mealKitProducts.id, input.lines.map((l) => l.productId))).for('update');
      let total = 0;
      for (const l of input.lines) {
        const p = products.find((x) => x.id === l.productId);
        if (!p || !p.isActive) throw new BadRequestException('Product unavailable');
        if (p.shipRegions.length && !p.shipRegions.includes(input.address.region.toUpperCase())) throw new BadRequestException(`${p.name} does not ship to ${input.address.region}`);
        if (deliveryDate < addDays(new Date(), p.leadDays)) throw new BadRequestException(`${p.name} needs ${p.leadDays} days lead time`);
        if (p.stockOnHand - p.stockReserved < l.quantity) throw new ConflictException(`${p.name} is out of stock`);
        total += p.priceCents * l.quantity;
        await tx.update(mealKitProducts).set({ stockReserved: p.stockReserved + l.quantity }).where(eq(mealKitProducts.id, p.id));
      }
      const [s] = await tx.insert(shipments).values({ userId: user.sub, orderNumber: input.idempotencyKey || orderNumber('K'), deliveryDate, address: input.address, totalCents: total }).returning();
      await tx.insert(shipmentLines).values(input.lines.map((l) => ({ shipmentId: s.id, productId: l.productId, quantity: l.quantity, unitCents: products.find((p) => p.id === l.productId)!.priceCents })));
      const p = await this.payments.chargeNow({ purpose: 'SHIPMENT', referenceId: s.id, userId: user.sub, amountCents: total, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, paymentMethodId: input.paymentMethodId, idempotencyKey: `ship:${s.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: total }, { account: 'PLATFORM_REVENUE_FOOD_SALES', creditCents: total, memo: `Meal kit ${s.orderNumber}` }] }, tx);
      const [u] = await tx.update(shipments).set({ paymentId: p.id }).where(eq(shipments.id, s.id)).returning();
      return u;
    });
  }

  async myShipments(user: JwtPayload) {
    const rows = await this.db.select().from(shipments).where(eq(shipments.userId, user.sub));
    const ids = rows.map((r) => r.id);
    const lines = ids.length ? await this.db.select({ l: shipmentLines, p: mealKitProducts }).from(shipmentLines).innerJoin(mealKitProducts, eq(mealKitProducts.id, shipmentLines.productId)).where(inArray(shipmentLines.shipmentId, ids)) : [];
    return rows.map((r) => ({ ...r, lines: lines.filter((x) => x.l.shipmentId === r.id).map((x) => ({ ...x.l, name: x.p.name })) }));
  }

  /** Ops: build a packing batch for a delivery date; pick/pack consumes reserved stock. */
  async createBatch(user: JwtPayload, deliveryDate: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const d = new Date(deliveryDate);
    const due = await this.db.select().from(shipments).where(and(eq(shipments.status, 'RESERVED'), eq(shipments.deliveryDate, d)));
    const [b] = await this.db.insert(packingBatches).values({ deliveryDate: d, status: 'PACKING', shipmentIds: due.map((s) => s.id) }).returning();
    if (due.length) await this.db.update(shipments).set({ status: 'PICKING', batchId: b.id }).where(inArray(shipments.id, due.map((s) => s.id)));
    return { ...b, count: due.length };
  }

  async transition(user: JwtPayload, shipmentId: string, status: 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'FAILED' | 'RETURNED', data: { carrier?: string; trackingNumber?: string }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [s] = await this.db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!s) throw new NotFoundException();
    return this.db.transaction(async (tx) => {
      const patch: Partial<typeof shipments.$inferInsert> = { status, carrier: data.carrier ?? s.carrier, trackingNumber: data.trackingNumber ?? s.trackingNumber };
      if (status === 'PACKED') {
        patch.packedAt = new Date();
        const lines = await tx.select().from(shipmentLines).where(eq(shipmentLines.shipmentId, s.id));
        for (const l of lines) await tx.update(mealKitProducts).set({ stockOnHand: sql`${mealKitProducts.stockOnHand} - ${l.quantity}`, stockReserved: sql`greatest(0, ${mealKitProducts.stockReserved} - ${l.quantity})` }).where(eq(mealKitProducts.id, l.productId));
      }
      if (status === 'SHIPPED') {
        patch.shippedAt = new Date();
        await this.outbox.publish('shipment.shipped', s.id, { userId: s.userId, orderNumber: s.orderNumber, trackingNumber: patch.trackingNumber, carrier: patch.carrier }, tx);
      }
      if (status === 'DELIVERED') patch.deliveredAt = new Date();
      const [u] = await tx.update(shipments).set(patch).where(eq(shipments.id, s.id)).returning();
      return u;
    });
  }

  /** Line-level case: missing/damaged/failed → replacement or credit. */
  async openCase(user: JwtPayload, shipmentId: string, input: { lineId?: string; kind: 'MISSING' | 'DAMAGED' | 'FAILED_DELIVERY'; description?: string }) {
    const [s] = await this.db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
    if (!s || (s.userId !== user.sub && !isPlatformStaff(user))) throw new NotFoundException();
    const [c] = await this.db.insert(shipmentCases).values({ shipmentId, lineId: input.lineId ?? null, kind: input.kind }).returning();
    return c;
  }

  async resolveCase(user: JwtPayload, caseId: string, remedy: 'REPLACEMENT' | 'CREDIT' | 'REFUND') {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [c] = await this.db.select().from(shipmentCases).where(eq(shipmentCases.id, caseId)).limit(1);
    if (!c) throw new NotFoundException();
    const [s] = await this.db.select().from(shipments).where(eq(shipments.id, c.shipmentId)).limit(1);
    const line = c.lineId ? (await this.db.select().from(shipmentLines).where(eq(shipmentLines.id, c.lineId)))[0] : null;
    const cents = line ? line.unitCents * line.quantity : s!.totalCents;
    return this.db.transaction(async (tx) => {
      if (remedy === 'CREDIT' && s!.userId) await this.payments.issueCredit({ userId: s!.userId, cents, reason: `Meal kit ${c.kind.toLowerCase()} (${s!.orderNumber})`, expiresInDays: 90 }, tx);
      if (remedy === 'REFUND' && s!.paymentId) await this.payments.refund({ paymentId: s!.paymentId, amountCents: cents, reason: `Meal kit ${c.kind.toLowerCase()}`, funder: 'PLATFORM', approvedById: user.sub, idempotencyKey: `case:${caseId}` }, tx);
      if (remedy === 'REPLACEMENT' && line) {
        const [r] = await tx.insert(shipments).values({ userId: s!.userId, orderNumber: orderNumber('KR'), deliveryDate: addDays(new Date(), 2), address: s!.address, totalCents: 0 }).returning();
        await tx.insert(shipmentLines).values({ shipmentId: r.id, productId: line.productId, quantity: line.quantity, unitCents: 0 });
        await tx.update(mealKitProducts).set({ stockReserved: sql`${mealKitProducts.stockReserved} + ${line.quantity}` }).where(eq(mealKitProducts.id, line.productId));
      }
      const [u] = await tx.update(shipmentCases).set({ remedy, creditCents: remedy === 'REPLACEMENT' ? 0 : cents, resolvedAt: new Date() }).where(eq(shipmentCases.id, caseId)).returning();
      return u;
    });
  }
}
