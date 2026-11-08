import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { corporateBudgets, groupOrderParticipants, groupOrders, invoices, locations, orderLines, orders } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { LedgerService } from '../../core/ledger.service';
import { OrdersService } from '../orders/orders.service';
import { QuoteService } from '../orders/quote.service';
import { CatalogService } from '../catalog/catalog.service';
import { addDays, invoiceNumber, shortCode } from '../../common/utils';
import type { Address } from '../delivery/providers/delivery-provider';

interface PLine {
  menuItemId: string;
  quantity: number;
  modifierOptionIds?: string[];
  specialInstructions?: string;
  name?: string;
  cents?: number;
}

/** 18 — shared basket / individual orders / catering trays with employer budgets, cutoffs and labels. */
@Injectable()
export class GroupOrdersService {
  constructor(@Inject(DB) private readonly db: Db, private readonly outbox: OutboxService, private readonly ledger: LedgerService, private readonly orders: OrdersService, private readonly quotes: QuoteService, private readonly catalog: CatalogService) {}

  async createBudget(user: JwtPayload, orgId: string, input: { name: string; perPersonCents: number; periodCents?: number }) {
    assertOrgAccess(user, orgId);
    const [b] = await this.db.insert(corporateBudgets).values({ ...input, organizationId: orgId }).returning();
    return b;
  }

  async create(user: JwtPayload, input: { locationId: string; organizationId?: string; budgetId?: string; mode: 'SHARED_BASKET' | 'INDIVIDUAL' | 'CATERING_TRAYS'; name: string; cutoffAt: string; deliverAt: string; fulfillmentType?: 'DELIVERY' | 'PICKUP' | 'CATERING'; deliveryAddress?: Address; headcount?: number; dietaryNotes?: string; payer?: 'ORGANIZER' | 'EMPLOYER_INVOICE' | 'INDIVIDUAL' }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (input.payer === 'EMPLOYER_INVOICE' && !input.organizationId) throw new BadRequestException('Employer invoice requires an organization');
    if (input.organizationId) assertOrgAccess(user, input.organizationId);
    const cutoffAt = new Date(input.cutoffAt);
    const deliverAt = new Date(input.deliverAt);
    if (cutoffAt >= deliverAt) throw new BadRequestException('Cutoff must be before delivery');
    const [g] = await this.db.insert(groupOrders).values({ ...input, organizerUserId: user.sub, joinCode: shortCode(6), cutoffAt, deliverAt, fulfillmentType: input.fulfillmentType || 'DELIVERY', deliveryAddress: input.deliveryAddress ?? null, payer: input.payer || 'ORGANIZER', organizationId: input.organizationId ?? null, budgetId: input.budgetId ?? null }).returning();
    return g;
  }

  async get(code: string) {
    const [g] = await this.db.select().from(groupOrders).where(eq(groupOrders.joinCode, code.toUpperCase())).limit(1);
    if (!g) throw new NotFoundException('Group order not found');
    const parts = await this.db.select().from(groupOrderParticipants).where(eq(groupOrderParticipants.groupOrderId, g.id));
    const budget = g.budgetId ? (await this.db.select().from(corporateBudgets).where(eq(corporateBudgets.id, g.budgetId)))[0] : null;
    return { ...g, participants: parts.map((p) => ({ id: p.id, name: p.name, submittedAt: p.submittedAt, lines: p.lines, overageCents: p.overageCents, lateJoin: p.lateJoin })), allowanceCents: budget?.perPersonCents ?? null, isOpen: g.status === 'OPEN' && g.cutoffAt > new Date() };
  }

  /** Invitee picks dishes before the cutoff. Overage beyond the allowance is charged to the participant (recorded). */
  async submitChoice(user: JwtPayload | null, code: string, input: { name: string; email?: string; lines: PLine[] }) {
    const g = await this.get(code);
    const late = !g.isOpen;
    if (g.status !== 'OPEN') throw new ConflictException('Group order is closed');
    if (late && g.mode !== 'INDIVIDUAL') throw new ConflictException('Cutoff passed');
    const items = await this.catalog.resolveItems(g.locationId, 'CORPORATE', input.lines.map((l) => l.menuItemId));
    let cents = 0;
    const priced = input.lines.map((l) => {
      const it = items.get(l.menuItemId);
      if (!it) throw new BadRequestException('Item not available');
      const c = it.priceCents * l.quantity;
      cents += c;
      return { ...l, name: it.name, cents: c };
    });
    const allowance = g.allowanceCents ?? null;
    const overage = allowance !== null ? Math.max(0, cents - allowance) : 0;
    const [p] = await this.db.insert(groupOrderParticipants).values({ groupOrderId: g.id, userId: user?.sub ?? null, name: input.name, email: input.email ?? user?.email ?? null, allowanceCents: allowance, overageCents: overage, lines: priced, submittedAt: new Date(), lateJoin: late }).returning();
    return { ...p, totalCents: cents };
  }

  /** Organizer locks at cutoff and submits one consolidated order: labeled lines, batch handoff, one payer. */
  async submit(user: JwtPayload, code: string, paymentMethodId?: string) {
    const g = await this.get(code);
    if (g.organizerUserId !== user.sub && !isPlatformStaff(user)) throw new ForbiddenException();
    if (g.status !== 'OPEN') throw new ConflictException(`Group order is ${g.status}`);
    const parts = await this.db.select().from(groupOrderParticipants).where(eq(groupOrderParticipants.groupOrderId, g.id));
    const lines: (PLine & { label: string })[] = [];
    for (const p of parts) for (const l of p.lines as PLine[]) lines.push({ ...l, label: p.name, specialInstructions: `${p.name}${l.specialInstructions ? ' — ' + l.specialInstructions : ''}` });
    if (!lines.length) throw new BadRequestException('No items chosen');
    await this.db.update(groupOrders).set({ status: 'LOCKED' }).where(eq(groupOrders.id, g.id));
    const q = await this.quotes.quote({ locationId: g.locationId, channel: 'CORPORATE', fulfillmentType: g.fulfillmentType === 'CATERING' ? 'CATERING' : (g.fulfillmentType as 'DELIVERY' | 'PICKUP'), lines: lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, specialInstructions: l.specialInstructions })), scheduledFor: g.deliverAt.toISOString(), deliveryAddress: (g.deliveryAddress as Address) ?? undefined, userId: user.sub });
    const order = await this.orders.checkout(user, { quoteId: q.id, paymentMethodId, groupOrderId: g.id, idempotencyKey: `group:${g.id}`, specialInstructions: `Group order ${g.name} (${parts.length} people)${g.dietaryNotes ? ' — ' + g.dietaryNotes : ''}` });
    // attach participant labels to lines for batch labeling
    const dbLines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    for (const p of parts) {
      for (const l of p.lines as PLine[]) {
        const match = dbLines.find((d) => d.menuItemId === l.menuItemId && !d.participantId && d.quantity === l.quantity);
        if (match) await this.db.update(orderLines).set({ participantId: p.id, label: p.name }).where(eq(orderLines.id, match.id));
      }
    }
    let invoiceId: string | null = null;
    if (g.payer === 'EMPLOYER_INVOICE' && g.organizationId) {
      const [inv] = await this.db.insert(invoices).values({ organizationId: g.organizationId, number: invoiceNumber('EMP'), kind: 'EMPLOYER', currency: order.currency, lines: parts.map((p) => ({ description: p.name, cents: (p.lines as PLine[]).reduce((a, l) => a + (l.cents || 0), 0) - p.overageCents })), totalCents: order.totalCents - parts.reduce((a, p) => a + p.overageCents, 0), dueAt: addDays(new Date(), 30) }).returning();
      invoiceId = inv.id;
      if (g.budgetId) await this.db.update(corporateBudgets).set({ spentCents: sql`${corporateBudgets.spentCents} + ${inv.totalCents}` }).where(eq(corporateBudgets.id, g.budgetId));
    }
    await this.db.update(groupOrders).set({ status: 'SUBMITTED', consolidatedOrderId: order.id, invoiceId }).where(eq(groupOrders.id, g.id));
    await this.outbox.publish('group_order.cutoff', g.id, { orderId: order.id, participants: parts.length });
    return { groupOrder: await this.get(code), order };
  }

  /** Individual receipts per participant (consolidated invoice when employer pays). */
  async receipts(code: string) {
    const g = await this.get(code);
    if (!g.consolidatedOrderId) throw new ConflictException('Not submitted yet');
    const parts = await this.db.select().from(groupOrderParticipants).where(eq(groupOrderParticipants.groupOrderId, g.id));
    const [o] = await this.db.select().from(orders).where(eq(orders.id, g.consolidatedOrderId)).limit(1);
    const taxRate = o && o.subtotalCents ? o.taxCents / o.subtotalCents : 0;
    return parts.map((p) => {
      const sub = (p.lines as PLine[]).reduce((a, l) => a + (l.cents || 0), 0);
      return { participant: p.name, email: p.email, lines: p.lines, subtotalCents: sub, taxCents: Math.round(sub * taxRate), allowanceCents: p.allowanceCents, overageCents: p.overageCents, payer: g.payer };
    });
  }

  async cancelParticipant(user: JwtPayload, code: string, participantId: string) {
    const g = await this.get(code);
    if (g.status !== 'OPEN') throw new ConflictException('Group order locked; partial cancellation goes through support');
    const [p] = await this.db.select().from(groupOrderParticipants).where(eq(groupOrderParticipants.id, participantId)).limit(1);
    if (!p || (p.userId !== user.sub && g.organizerUserId !== user.sub)) throw new ForbiddenException();
    await this.db.delete(groupOrderParticipants).where(eq(groupOrderParticipants.id, participantId));
    return { ok: true };
  }

  async myGroupOrders(user: JwtPayload) {
    return this.db.select().from(groupOrders).where(eq(groupOrders.organizerUserId, user.sub));
  }

  /** Worker: auto-lock when cutoff passes so late participants are rejected consistently. */
  async lockPastCutoff(now = new Date()) {
    const rows = await this.db.update(groupOrders).set({ status: 'LOCKED' }).where(and(eq(groupOrders.status, 'OPEN'), lt(groupOrders.cutoffAt, now))).returning();
    for (const g of rows) await this.outbox.publish('group_order.cutoff', g.id, { organizerUserId: g.organizerUserId, name: g.name, locked: true });
    return rows.length;
  }
}
