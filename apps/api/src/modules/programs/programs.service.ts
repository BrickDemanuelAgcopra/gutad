import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { b2bOrders, brands, campusAccounts, campusLocations, invoices, kitchenBrands, locations, orders, payments, programs } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { QuoteService } from '../orders/quote.service';
import { OrdersService } from '../orders/orders.service';
import { addDays, invoiceNumber } from '../../common/utils';

/** 20 — campus eligibility & balances, B2B operator ordering, creator brand programs. Each enabled separately. */
@Injectable()
export class ProgramsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly ledger: LedgerService, private readonly outbox: OutboxService, private readonly quotes: QuoteService, private readonly orders: OrdersService) {}

  // ───── lifecycle: apply → qualify → contract → test → activate → offboard ─────

  async apply(user: JwtPayload, orgId: string, input: { type: 'CAMPUS' | 'B2B_OPERATOR' | 'CREATOR_BRAND'; name: string; config?: Record<string, unknown> }) {
    assertOrgAccess(user, orgId);
    const [p] = await this.db.insert(programs).values({ organizationId: orgId, type: input.type, name: input.name, config: input.config || {} }).returning();
    return p;
  }

  async transition(user: JwtPayload, programId: string, status: 'QUALIFIED' | 'CONTRACTED' | 'TESTING' | 'ACTIVE' | 'OFFBOARDED', input?: { contractRef?: string; compensationBps?: number; locationIds?: string[]; brandId?: string }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Platform qualifies programs');
    const [p] = await this.db.select().from(programs).where(eq(programs.id, programId)).limit(1);
    if (!p) throw new NotFoundException();
    const order = ['APPLIED', 'QUALIFIED', 'CONTRACTED', 'TESTING', 'ACTIVE', 'OFFBOARDED'];
    if (status !== 'OFFBOARDED' && order.indexOf(status) !== order.indexOf(p.status) + 1) throw new ConflictException(`Cannot move from ${p.status} to ${status}`);
    return this.db.transaction(async (tx) => {
      const [u] = await tx.update(programs).set({ status, contractRef: input?.contractRef ?? p.contractRef, compensationBps: input?.compensationBps ?? p.compensationBps, activatedAt: status === 'ACTIVE' ? new Date() : p.activatedAt, offboardedAt: status === 'OFFBOARDED' ? new Date() : null }).where(eq(programs.id, programId)).returning();
      if (status === 'CONTRACTED' && p.type === 'CAMPUS' && input?.locationIds?.length) await tx.insert(campusLocations).values(input.locationIds.map((locationId) => ({ programId, locationId }))).onConflictDoNothing();
      if (status === 'ACTIVE' && p.type === 'CREATOR_BRAND' && input?.brandId) await tx.update(brands).set({ royaltyBps: u.compensationBps }).where(eq(brands.id, input.brandId));
      if (status === 'OFFBOARDED' && p.type === 'CREATOR_BRAND') {
        const cfg = p.config as { brandId?: string };
        if (cfg.brandId) await tx.update(kitchenBrands).set({ isActive: false }).where(eq(kitchenBrands.brandId, cfg.brandId)); // stop new sales; historical obligations preserved
      }
      await this.audit.log({ organizationId: p.organizationId, actorId: user.sub, action: `program.${status.toLowerCase()}`, entityType: 'program', entityId: programId, before: p, after: u }, tx);
      return u;
    });
  }

  async list(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(programs).where(eq(programs.organizationId, orgId));
  }

  // ───── campus ─────

  async enrollCampusUser(user: JwtPayload, programId: string, input: { userId: string; campusUserId: string; balanceCents?: number; mealSwipes?: number }) {
    const [p] = await this.db.select().from(programs).where(eq(programs.id, programId)).limit(1);
    if (!p || p.type !== 'CAMPUS') throw new NotFoundException();
    assertOrgAccess(user, p.organizationId);
    const [a] = await this.db.insert(campusAccounts).values({ programId, userId: input.userId, campusUserId: input.campusUserId, balanceCents: input.balanceCents ?? 0, mealSwipes: input.mealSwipes ?? 0 }).onConflictDoUpdate({ target: [campusAccounts.programId, campusAccounts.userId], set: { balanceCents: input.balanceCents ?? 0, mealSwipes: input.mealSwipes ?? 0, isEligible: true } }).returning();
    return a;
  }

  async myCampus(user: JwtPayload) {
    return this.db.select({ account: campusAccounts, program: programs }).from(campusAccounts).innerJoin(programs, eq(programs.id, campusAccounts.programId)).where(eq(campusAccounts.userId, user.sub));
  }

  /** Campus meal: authenticate eligible diner, debit campus balance via integration (here: ledger), create pickup order. */
  async campusOrder(user: JwtPayload, input: { programId: string; locationId: string; lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[] }[]; scheduledFor?: string; idempotencyKey?: string }) {
    const [acct] = await this.db.select().from(campusAccounts).where(and(eq(campusAccounts.programId, input.programId), eq(campusAccounts.userId, user.sub))).limit(1);
    if (!acct || !acct.isEligible) throw new ForbiddenException('Not an eligible campus diner');
    const [p] = await this.db.select().from(programs).where(eq(programs.id, input.programId)).limit(1);
    if (!p || p.status !== 'ACTIVE') throw new ConflictException('Campus program not active');
    const [cl] = await this.db.select().from(campusLocations).where(and(eq(campusLocations.programId, input.programId), eq(campusLocations.locationId, input.locationId))).limit(1);
    if (!cl) throw new BadRequestException('Location not part of this campus program');
    const q = await this.quotes.quote({ locationId: input.locationId, channel: 'CAMPUS', fulfillmentType: 'PICKUP', lines: input.lines, scheduledFor: input.scheduledFor ?? null, userId: user.sub });
    if (acct.balanceCents < q.totalCents) throw new BadRequestException(`Insufficient campus balance (${acct.balanceCents} < ${q.totalCents}); use another payment method`);
    return this.db.transaction(async (tx) => {
      // debit balance; the institution settles the operator (reconciled via EMPLOYER-style invoice)
      await tx.update(campusAccounts).set({ balanceCents: acct.balanceCents - q.totalCents }).where(eq(campusAccounts.id, acct.id));
      const o = await this.orders.checkout(user, { quoteId: q.id, campusAccountId: acct.id, idempotencyKey: input.idempotencyKey || `campus:${q.id}`, paymentMethodId: 'campus_balance' });
      const [loc] = await tx.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
      await this.ledger.post({ orderId: o.id, currency: loc!.currency }, [
        { account: 'CUSTOMER_RECEIVABLE', partyId: p.organizationId, organizationId: p.organizationId, debitCents: q.totalCents, memo: `Campus balance debit ${o.number}` },
        { account: 'PROCESSOR_CLEARING', creditCents: q.totalCents, memo: 'Institution funds order' },
      ], tx);
      return o;
    });
  }

  /** Canceled campus order or institution downtime → explicit reversal to balance. */
  async reverseCampusDebit(user: JwtPayload, orderId: string) {
    const [o] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o?.campusAccountId) throw new NotFoundException();
    if (!['REJECTED', 'CANCELED'].includes(o.status)) throw new ConflictException('Order not canceled');
    const [acct] = await this.db.select().from(campusAccounts).where(eq(campusAccounts.id, o.campusAccountId)).limit(1);
    if (!acct || (acct.userId !== user.sub && !isPlatformStaff(user))) throw new ForbiddenException();
    const [p] = await this.db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    if (p && p.status !== 'VOIDED' && p.status !== 'REFUNDED') throw new ConflictException('Payment not released');
    await this.db.update(campusAccounts).set({ balanceCents: sql`${campusAccounts.balanceCents} + ${o.totalCents}` }).where(eq(campusAccounts.id, acct.id));
    return { ok: true, restoredCents: o.totalCents };
  }

  /** Institution statement: what the institution owes food operators for a period. */
  async campusStatement(user: JwtPayload, programId: string, from: Date, to: Date) {
    const [p] = await this.db.select().from(programs).where(eq(programs.id, programId)).limit(1);
    if (!p) throw new NotFoundException();
    assertOrgAccess(user, p.organizationId);
    const rows = await this.db.select({ locationId: orders.locationId, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${orders.totalCents}),0)::int` }).from(orders).innerJoin(campusAccounts, eq(campusAccounts.id, orders.campusAccountId)).where(and(eq(campusAccounts.programId, programId), sql`${orders.status} in ('COMPLETED','COLLECTED','READY','ACCEPTED','PREPARING')`, sql`${orders.createdAt} between ${from} and ${to}`)).groupBy(orders.locationId);
    return { programId, from, to, byLocation: rows, totalCents: rows.reduce((a, r) => a + r.cents, 0) };
  }

  // ───── B2B operator ordering ─────

  async b2bOrder(user: JwtPayload, programId: string, input: { items: { sku: string; name: string; quantity: number; unitCents: number }[] }) {
    const [p] = await this.db.select().from(programs).where(eq(programs.id, programId)).limit(1);
    if (!p || p.type !== 'B2B_OPERATOR') throw new NotFoundException();
    assertOrgAccess(user, p.organizationId);
    if (p.status !== 'ACTIVE') throw new ConflictException('Program not active');
    const total = input.items.reduce((a, i) => a + i.quantity * i.unitCents, 0);
    const [o] = await this.db.insert(b2bOrders).values({ programId, items: input.items, totalCents: total }).returning();
    return o;
  }

  async b2bFulfillAndInvoice(user: JwtPayload, b2bOrderId: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [o] = await this.db.select({ o: b2bOrders, p: programs }).from(b2bOrders).innerJoin(programs, eq(programs.id, b2bOrders.programId)).where(eq(b2bOrders.id, b2bOrderId)).limit(1);
    if (!o) throw new NotFoundException();
    return this.db.transaction(async (tx) => {
      const [inv] = await tx.insert(invoices).values({ organizationId: o.p.organizationId, number: invoiceNumber('B2B'), kind: 'B2B', currency: 'USD', lines: o.o.items as unknown[], totalCents: o.o.totalCents, dueAt: addDays(new Date(), 30) }).returning();
      await this.ledger.post({ invoiceId: inv.id, currency: 'USD' }, [{ account: 'CUSTOMER_RECEIVABLE', partyId: o.p.organizationId, organizationId: o.p.organizationId, debitCents: o.o.totalCents }, { account: 'PLATFORM_REVENUE_B2B', creditCents: o.o.totalCents, organizationId: o.p.organizationId }], tx);
      const [u] = await tx.update(b2bOrders).set({ status: 'INVOICED', invoiceId: inv.id }).where(eq(b2bOrders.id, b2bOrderId)).returning();
      return { order: u, invoice: inv };
    });
  }

  // ───── creator brand royalties ─────

  /** Monthly royalty accrual: contracted bps on net brand sales → PLATFORM_EXPENSE_ROYALTY / payable to creator org. */
  async accrueRoyalties(from: Date, to: Date, tx: DbOrTx = this.db) {
    const rows = await tx.execute(sql`
      select b.id as brand_id, b.organization_id, b.royalty_bps, coalesce(sum(ol.line_total_cents),0)::int as cents
      from order_lines ol join orders o on o.id = ol.order_id join brands b on b.id = ol.brand_id
      where o.status in ('COMPLETED','COLLECTED') and o.completed_at between ${from} and ${to} and b.royalty_bps > 0
      group by b.id, b.organization_id, b.royalty_bps`);
    const out: { brandId: string; cents: number }[] = [];
    for (const r of rows.rows as { brand_id: string; organization_id: string; royalty_bps: number; cents: number }[]) {
      const royalty = Math.round((r.cents * r.royalty_bps) / 10_000);
      if (!royalty) continue;
      await this.ledger.post({ currency: 'USD' }, [{ account: 'PLATFORM_EXPENSE_ROYALTY', debitCents: royalty, organizationId: r.organization_id, memo: `Royalty brand ${r.brand_id}` }, { account: 'MERCHANT_PAYABLE', partyId: r.organization_id, organizationId: r.organization_id, creditCents: royalty, memo: `Royalty brand ${r.brand_id}` }], tx);
      out.push({ brandId: r.brand_id, cents: royalty });
    }
    return out;
  }
}
