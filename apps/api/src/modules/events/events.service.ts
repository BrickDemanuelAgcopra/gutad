import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { experienceAddOns, experienceSessions, experienceTickets, experiences, eventInquiries, invoices, locations, rooms } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { LedgerService } from '../../core/ledger.service';
import { PaymentsService } from '../payments/payments.service';
import { ContractsService } from '../contracts/contracts.service';
import { addDays, addMinutes, bps, invoiceNumber, shortCode } from '../../common/utils';

@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly outbox: OutboxService, private readonly ledger: LedgerService, private readonly payments: PaymentsService, private readonly contracts: ContractsService) {}

  private async requireLoc(user: JwtPayload, locationId: string, roles = MANAGER_ROLES) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId, roles);
    return loc;
  }

  // ───── experiences (ticketed / prepaid / pay-at-venue) ─────

  async createExperience(user: JwtPayload, locationId: string, input: { name: string; description?: string; imageUrl?: string; pricingMode: 'FREE' | 'PREPAID_PER_PERSON' | 'PREPAID_PER_PARTY' | 'PAY_AT_VENUE'; priceCents?: number; serviceFeePayer?: 'DINER' | 'MERCHANT'; refundPolicy?: string; refundCutoffHours?: number; sessions: { startAt: string; capacity: number }[]; addOns?: { name: string; priceCents: number }[] }) {
    const loc = await this.requireLoc(user, locationId);
    const terms = await this.contracts.termsFor(locationId, 'MARKETPLACE', new Date(), undefined, 'DINE_IN');
    return this.db.transaction(async (tx) => {
      const [e] = await tx.insert(experiences).values({ locationId, name: input.name, description: input.description ?? null, imageUrl: input.imageUrl ?? null, pricingMode: input.pricingMode, priceCents: input.priceCents ?? 0, serviceFeeBps: terms.prepaidServiceFeeBps, serviceFeePayer: input.serviceFeePayer || 'DINER', refundPolicy: input.refundPolicy || `Refundable up to ${input.refundCutoffHours ?? 48} hours before the session.`, refundCutoffHours: input.refundCutoffHours ?? 48 }).returning();
      await tx.insert(experienceSessions).values(input.sessions.map((s) => ({ experienceId: e.id, startAt: new Date(s.startAt), capacity: s.capacity })));
      if (input.addOns?.length) await tx.insert(experienceAddOns).values(input.addOns.map((a) => ({ ...a, experienceId: e.id })));
      if (!loc.acceptsEvents) await tx.update(locations).set({ acceptsEvents: true }).where(eq(locations.id, locationId));
      return this.publicExperience(e.id, tx);
    });
  }

  async publicExperience(id: string, tx: DbOrTx = this.db) {
    const [e] = await tx.select().from(experiences).where(eq(experiences.id, id)).limit(1);
    if (!e) throw new NotFoundException();
    const sessions = await tx.select().from(experienceSessions).where(and(eq(experienceSessions.experienceId, id), gt(experienceSessions.startAt, new Date()))).orderBy(asc(experienceSessions.startAt));
    const addOns = await tx.select().from(experienceAddOns).where(eq(experienceAddOns.experienceId, id));
    return { ...e, sessions: sessions.map((s) => ({ id: s.id, startAt: s.startAt, capacity: s.capacity, remaining: s.capacity - s.sold - s.held })), addOns };
  }

  async listPublic(locationId: string) {
    const rows = await this.db.select().from(experiences).where(and(eq(experiences.locationId, locationId), eq(experiences.isActive, true)));
    const out = [];
    for (const r of rows) out.push(await this.publicExperience(r.id));
    return out;
  }

  /** Hold → pay → confirm. Inventory is consumed atomically; expired holds restore capacity (worker). */
  async buyTicket(user: JwtPayload | null, input: { sessionId: string; spots: number; guestName: string; guestEmail?: string; addOnIds?: string[]; paymentMethodId?: string; payAtVenue?: boolean; idempotencyKey?: string }) {
    if (input.idempotencyKey) {
      const [ex] = await this.db.select().from(experienceTickets).where(eq(experienceTickets.confirmationCode, input.idempotencyKey)).limit(1);
      if (ex) return ex;
    }
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(experienceSessions).where(eq(experienceSessions.id, input.sessionId)).for('update');
      if (!s) throw new NotFoundException('Session not found');
      if (s.closedAt) throw new ConflictException('Session closed');
      const [e] = await tx.select().from(experiences).where(eq(experiences.id, s.experienceId)).limit(1);
      if (!e || !e.isActive) throw new NotFoundException('Experience not available');
      if (s.capacity - s.sold - s.held < input.spots) throw new ConflictException('Not enough spots left');
      const addOns = input.addOnIds?.length ? await tx.select().from(experienceAddOns).where(inArray(experienceAddOns.id, input.addOnIds)) : [];
      const addOnCents = addOns.reduce((a, x) => a + x.priceCents, 0) * input.spots;
      const ticketCents = e.pricingMode === 'PREPAID_PER_PERSON' ? e.priceCents * input.spots : e.pricingMode === 'PREPAID_PER_PARTY' ? e.priceCents : 0;
      const prepaid = ticketCents + (e.pricingMode.startsWith('PREPAID') ? addOnCents : 0);
      const serviceFee = prepaid > 0 ? bps(prepaid, e.serviceFeeBps) : 0;
      const dinerPays = prepaid + (e.serviceFeePayer === 'DINER' ? serviceFee : 0);
      const payAtVenue = e.pricingMode === 'PAY_AT_VENUE' || (e.pricingMode === 'FREE' && !prepaid);
      const needsPayment = dinerPays > 0 && !input.paymentMethodId;
      const [t] = await tx.insert(experienceTickets).values({ sessionId: s.id, userId: user?.sub ?? null, guestName: input.guestName, guestEmail: input.guestEmail ?? user?.email ?? null, spots: input.spots, addOns: addOns.map((a) => ({ id: a.id, name: a.name, priceCents: a.priceCents })), status: needsPayment ? 'HELD' : 'CONFIRMED', holdExpiresAt: needsPayment ? addMinutes(new Date(), 10) : null, ticketCents: prepaid, serviceFeeCents: serviceFee, confirmationCode: input.idempotencyKey || `T${shortCode(6)}` }).returning();
      await tx.update(experienceSessions).set(needsPayment ? { held: s.held + input.spots } : { sold: s.sold + input.spots }).where(eq(experienceSessions.id, s.id));
      if (!needsPayment && dinerPays > 0) await this.collectTicket(t, e, dinerPays, input.paymentMethodId!, tx);
      if (!needsPayment) await this.outbox.publish('ticket.confirmed', t.id, { confirmationCode: t.confirmationCode, userId: t.userId, email: t.guestEmail, experience: e.name, startAt: s.startAt, payAtVenue }, tx);
      return { ...t, dinerPaysCents: dinerPays, payAtVenue };
    });
  }

  /** Ticket price, processor charge, service fee and refundable components are accounted separately. */
  private async collectTicket(t: typeof experienceTickets.$inferSelect, e: typeof experiences.$inferSelect, dinerPays: number, paymentMethodId: string, tx: DbOrTx) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, e.locationId)).limit(1);
    const merchantNet = t.ticketCents - (e.serviceFeePayer === 'MERCHANT' ? t.serviceFeeCents : 0);
    const p = await this.payments.chargeNow({ purpose: 'TICKET', referenceId: t.id, userId: t.userId, amountCents: dinerPays, currency: loc!.currency, locationId: e.locationId, applicationFeeCents: t.serviceFeeCents, customerEmail: t.guestEmail, paymentMethodId, idempotencyKey: `ticket:${t.id}`, ledgerLines: [
      { account: 'PROCESSOR_CLEARING', debitCents: dinerPays, memo: `Ticket ${t.confirmationCode}` },
      { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, locationId: e.locationId, creditCents: merchantNet, memo: 'Ticket revenue' },
      { account: 'PLATFORM_REVENUE_SERVICE_FEE', creditCents: t.serviceFeeCents, organizationId: loc!.organizationId, memo: 'Prepaid service fee' },
    ] }, tx);
    await tx.update(experienceTickets).set({ paymentId: p.id }).where(eq(experienceTickets.id, t.id));
  }

  async payHeldTicket(user: JwtPayload | null, ticketId: string, paymentMethodId: string) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(experienceTickets).where(eq(experienceTickets.id, ticketId)).limit(1);
      if (!t) throw new NotFoundException();
      if (t.status !== 'HELD') throw new ConflictException(`Ticket is ${t.status}`);
      if (t.holdExpiresAt && t.holdExpiresAt < new Date()) throw new ConflictException('Hold expired');
      const [s] = await tx.select().from(experienceSessions).where(eq(experienceSessions.id, t.sessionId)).for('update');
      const [e] = await tx.select().from(experiences).where(eq(experiences.id, s.experienceId)).limit(1);
      const dinerPays = t.ticketCents + (e.serviceFeePayer === 'DINER' ? t.serviceFeeCents : 0);
      await this.collectTicket(t, e, dinerPays, paymentMethodId, tx);
      await tx.update(experienceTickets).set({ status: 'CONFIRMED', holdExpiresAt: null }).where(eq(experienceTickets.id, t.id));
      await tx.update(experienceSessions).set({ held: Math.max(0, s.held - t.spots), sold: s.sold + t.spots }).where(eq(experienceSessions.id, s.id));
      await this.outbox.publish('ticket.confirmed', t.id, { confirmationCode: t.confirmationCode, userId: t.userId, email: t.guestEmail, experience: e.name, startAt: s.startAt }, tx);
      return { ok: true };
    });
  }

  /** Staff validate attendance and record extras collected onsite. */
  async attend(user: JwtPayload, ticketId: string, extrasOnsiteCents = 0) {
    const [t] = await this.db.select({ t: experienceTickets, s: experienceSessions, e: experiences }).from(experienceTickets).innerJoin(experienceSessions, eq(experienceSessions.id, experienceTickets.sessionId)).innerJoin(experiences, eq(experiences.id, experienceSessions.experienceId)).where(eq(experienceTickets.id, ticketId)).limit(1);
    if (!t) throw new NotFoundException();
    await this.requireLoc(user, t.e.locationId, undefined as never);
    if (t.t.status !== 'CONFIRMED') throw new ConflictException(`Ticket is ${t.t.status}`);
    const [u] = await this.db.update(experienceTickets).set({ status: 'ATTENDED', attendedAt: new Date(), extrasOnsiteCents }).where(eq(experienceTickets.id, ticketId)).returning();
    return u;
  }

  /** Refund or transfer per policy. */
  async cancelTicket(user: JwtPayload | null, ticketId: string, transferToSessionId?: string) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(experienceTickets).where(eq(experienceTickets.id, ticketId)).limit(1);
      if (!t) throw new NotFoundException();
      if (user && t.userId && t.userId !== user.sub && !isPlatformStaff(user)) throw new ForbiddenException();
      if (!['CONFIRMED', 'HELD'].includes(t.status)) throw new ConflictException(`Ticket is ${t.status}`);
      const [s] = await tx.select().from(experienceSessions).where(eq(experienceSessions.id, t.sessionId)).for('update');
      const [e] = await tx.select().from(experiences).where(eq(experiences.id, s.experienceId)).limit(1);
      const hoursBefore = (s.startAt.getTime() - Date.now()) / 3_600_000;
      if (transferToSessionId) {
        const [ns] = await tx.select().from(experienceSessions).where(eq(experienceSessions.id, transferToSessionId)).for('update');
        if (!ns || ns.experienceId !== e.id) throw new BadRequestException('Invalid target session');
        if (ns.capacity - ns.sold - ns.held < t.spots) throw new ConflictException('Target session full');
        await tx.update(experienceSessions).set({ sold: s.sold - t.spots }).where(eq(experienceSessions.id, s.id));
        await tx.update(experienceSessions).set({ sold: ns.sold + t.spots }).where(eq(experienceSessions.id, ns.id));
        const [u] = await tx.update(experienceTickets).set({ sessionId: ns.id }).where(eq(experienceTickets.id, t.id)).returning();
        return u;
      }
      const refundable = hoursBefore >= e.refundCutoffHours;
      await tx.update(experienceSessions).set(t.status === 'HELD' ? { held: Math.max(0, s.held - t.spots) } : { sold: Math.max(0, s.sold - t.spots) }).where(eq(experienceSessions.id, s.id));
      if (t.paymentId && refundable) {
        const refundCents = t.ticketCents; // service fee is non-refundable
        await this.payments.refund({ paymentId: t.paymentId, amountCents: refundCents, reason: 'Ticket canceled within policy', funder: 'MERCHANT', idempotencyKey: `ticket-refund:${t.id}` }, tx);
      }
      const [u] = await tx.update(experienceTickets).set({ status: refundable && t.paymentId ? 'REFUNDED' : 'CANCELED' }).where(eq(experienceTickets.id, t.id)).returning();
      return u;
    });
  }

  /** Close a session: reconcile prepaid amounts vs attendance for the merchant statement. */
  async closeSession(user: JwtPayload, sessionId: string) {
    const [s] = await this.db.select({ s: experienceSessions, e: experiences }).from(experienceSessions).innerJoin(experiences, eq(experiences.id, experienceSessions.experienceId)).where(eq(experienceSessions.id, sessionId)).limit(1);
    if (!s) throw new NotFoundException();
    await this.requireLoc(user, s.e.locationId, undefined as never);
    const tickets = await this.db.select().from(experienceTickets).where(eq(experienceTickets.sessionId, sessionId));
    await this.db.update(experienceSessions).set({ closedAt: new Date() }).where(eq(experienceSessions.id, sessionId));
    return { sold: tickets.filter((t) => ['CONFIRMED', 'ATTENDED'].includes(t.status)).length, attended: tickets.filter((t) => t.status === 'ATTENDED').length, prepaidCents: tickets.filter((t) => t.status === 'ATTENDED' || t.status === 'CONFIRMED').reduce((a, t) => a + t.ticketCents, 0), extrasOnsiteCents: tickets.reduce((a, t) => a + t.extrasOnsiteCents, 0), serviceFeesCents: tickets.reduce((a, t) => a + (t.paymentId ? t.serviceFeeCents : 0), 0) };
  }

  async expireTicketHolds(now = new Date()) {
    const rows = await this.db.select().from(experienceTickets).where(and(eq(experienceTickets.status, 'HELD'), lt(experienceTickets.holdExpiresAt, now)));
    for (const t of rows) {
      await this.db.transaction(async (tx) => {
        await tx.update(experienceTickets).set({ status: 'EXPIRED' }).where(eq(experienceTickets.id, t.id));
        await tx.update(experienceSessions).set({ held: sql`greatest(0, ${experienceSessions.held} - ${t.spots})` }).where(eq(experienceSessions.id, t.sessionId));
      });
    }
    return rows.length;
  }

  async myTickets(user: JwtPayload) {
    return this.db.select({ t: experienceTickets, s: experienceSessions, e: experiences }).from(experienceTickets).innerJoin(experienceSessions, eq(experienceSessions.id, experienceTickets.sessionId)).innerJoin(experiences, eq(experiences.id, experienceSessions.experienceId)).where(eq(experienceTickets.userId, user.sub)).orderBy(asc(experienceSessions.startAt));
  }

  // ───── private events: inquiry → proposal → contract → deposit → confirm → headcount → balance → invoice ─────

  async inquire(user: JwtPayload | null, locationId: string, input: { contactName: string; contactEmail: string; contactPhone?: string; eventDate: string; partySize: number; budgetCents?: number; notes?: string }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    const [i] = await this.db.insert(eventInquiries).values({ ...input, locationId, userId: user?.sub ?? null, eventDate: new Date(input.eventDate), budgetCents: input.budgetCents ?? null, notes: input.notes ?? null, contactPhone: input.contactPhone ?? null }).returning();
    return i; // an inquiry never consumes committed inventory
  }

  async listInquiries(user: JwtPayload, locationId: string) {
    await this.requireLoc(user, locationId, undefined as never);
    return this.db.select().from(eventInquiries).where(eq(eventInquiries.locationId, locationId)).orderBy(asc(eventInquiries.eventDate));
  }

  /** Venue qualifies and sends a proposal (holds a room for the proposal window). */
  async propose(user: JwtPayload, inquiryId: string, input: { proposalCents: number; depositCents: number; roomId?: string; contractUrl?: string; validDays?: number }) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, inquiryId)).limit(1);
    if (!i) throw new NotFoundException();
    await this.requireLoc(user, i.locationId);
    if (!['INQUIRY', 'QUALIFIED', 'PROPOSED'].includes(i.status)) throw new ConflictException(`Inquiry is ${i.status}`);
    if (input.roomId) {
      const [room] = await this.db.select().from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.locationId, i.locationId))).limit(1);
      if (!room) throw new BadRequestException('Room not found');
    }
    const [u] = await this.db.update(eventInquiries).set({ status: 'PROPOSED', proposalCents: input.proposalCents, depositCents: input.depositCents, balanceCents: input.proposalCents - input.depositCents, roomId: input.roomId ?? null, contractUrl: input.contractUrl ?? null, proposalExpiresAt: addDays(new Date(), input.validDays ?? 7), holdExpiresAt: addDays(new Date(), input.validDays ?? 7) }).where(eq(eventInquiries.id, inquiryId)).returning();
    await this.outbox.publish('event.proposal_sent', inquiryId, { email: i.contactEmail, userId: i.userId, proposalCents: input.proposalCents, depositCents: input.depositCents, expiresAt: u.proposalExpiresAt });
    return u;
  }

  /** Customer signs (accepts) and pays the deposit → space is confirmed. */
  async acceptProposal(user: JwtPayload | null, inquiryId: string, paymentMethodId: string) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, inquiryId)).limit(1);
    if (!i) throw new NotFoundException();
    if (user && i.userId && i.userId !== user.sub) throw new ForbiddenException();
    if (i.status !== 'PROPOSED') throw new ConflictException(`Inquiry is ${i.status}`);
    if (i.proposalExpiresAt && i.proposalExpiresAt < new Date()) throw new ConflictException('Proposal expired');
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, i.locationId)).limit(1);
    return this.db.transaction(async (tx) => {
      await tx.update(eventInquiries).set({ status: 'CONTRACTED' }).where(eq(eventInquiries.id, i.id));
      if (i.depositCents > 0) {
        const p = await this.payments.chargeNow({ purpose: 'EVENT_DEPOSIT', referenceId: i.id, userId: i.userId, amountCents: i.depositCents, currency: loc!.currency, locationId: i.locationId, customerEmail: i.contactEmail, paymentMethodId, idempotencyKey: `event-deposit:${i.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: i.depositCents }, { account: 'DEPOSIT_LIABILITY', partyId: `event:${i.id}`, creditCents: i.depositCents, memo: 'Private event deposit' }] }, tx);
        await tx.update(eventInquiries).set({ depositPaymentId: p.id, status: 'DEPOSIT_PAID' }).where(eq(eventInquiries.id, i.id));
      }
      const [u] = await tx.update(eventInquiries).set({ status: 'CONFIRMED', holdExpiresAt: null }).where(eq(eventInquiries.id, i.id)).returning();
      return u;
    });
  }

  async setFinalHeadcount(user: JwtPayload | null, inquiryId: string, finalHeadcount: number) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, inquiryId)).limit(1);
    if (!i) throw new NotFoundException();
    if (i.status !== 'CONFIRMED') throw new ConflictException(`Inquiry is ${i.status}`);
    const [u] = await this.db.update(eventInquiries).set({ finalHeadcount }).where(eq(eventInquiries.id, inquiryId)).returning();
    return u;
  }

  /** After the event: charge the remaining balance, apply deposit, issue the final invoice. */
  async settleEvent(user: JwtPayload, inquiryId: string, input: { finalCents?: number; paymentMethodId?: string }) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, inquiryId)).limit(1);
    if (!i) throw new NotFoundException();
    const loc = await this.requireLoc(user, i.locationId);
    if (i.status !== 'CONFIRMED') throw new ConflictException(`Inquiry is ${i.status}`);
    const finalTotal = input.finalCents ?? i.proposalCents ?? 0;
    const balance = Math.max(0, finalTotal - i.depositCents);
    return this.db.transaction(async (tx) => {
      if (i.depositCents > 0) {
        await this.ledger.post({ currency: loc.currency }, [
          { account: 'DEPOSIT_LIABILITY', partyId: `event:${i.id}`, debitCents: i.depositCents, memo: 'Event deposit applied' },
          { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId: i.locationId, creditCents: i.depositCents, memo: 'Event deposit applied' },
        ], tx);
      }
      let balancePaymentId: string | null = null;
      if (balance > 0 && input.paymentMethodId) {
        const p = await this.payments.chargeNow({ purpose: 'EVENT_BALANCE', referenceId: i.id, userId: i.userId, amountCents: balance, currency: loc.currency, locationId: i.locationId, customerEmail: i.contactEmail, paymentMethodId: input.paymentMethodId, idempotencyKey: `event-balance:${i.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: balance }, { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId: i.locationId, creditCents: balance, memo: 'Event balance' }] }, tx);
        balancePaymentId = p.id;
      }
      const [inv] = await tx.insert(invoices).values({ organizationId: loc.organizationId, number: invoiceNumber('EVT'), kind: 'EVENT', currency: loc.currency, lines: [{ description: `Private event ${i.eventDate.toISOString().slice(0, 10)} (${i.finalHeadcount ?? i.partySize} guests)`, cents: finalTotal }, { description: 'Deposit applied', cents: -i.depositCents }], totalCents: balance, dueAt: addDays(new Date(), 7), paidAt: balancePaymentId ? new Date() : null }).returning();
      const [u] = await tx.update(eventInquiries).set({ status: 'COMPLETED', balanceCents: balance, balancePaymentId, invoiceId: inv.id }).where(eq(eventInquiries.id, i.id)).returning();
      return { inquiry: u, invoice: inv };
    });
  }

  async cancelEvent(user: JwtPayload | null, inquiryId: string, reason?: string) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, inquiryId)).limit(1);
    if (!i) throw new NotFoundException();
    if (['COMPLETED', 'CANCELED'].includes(i.status)) throw new ConflictException(`Inquiry is ${i.status}`);
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, i.locationId)).limit(1);
    const staff = user && (isPlatformStaff(user) || !!user.orgs?.[loc!.organizationId]);
    await this.db.transaction(async (tx) => {
      if (i.depositPaymentId && i.depositCents > 0) {
        if (staff) {
          await this.payments.refund({ paymentId: i.depositPaymentId, amountCents: i.depositCents, reason: reason || 'Venue canceled', funder: 'MERCHANT', idempotencyKey: `event-dep-refund:${i.id}` }, tx);
          await this.ledger.post({ currency: loc!.currency }, [{ account: 'DEPOSIT_LIABILITY', partyId: `event:${i.id}`, debitCents: i.depositCents, memo: 'Deposit returned' }, { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, creditCents: i.depositCents, memo: 'Offset refund funder' }], tx);
        } else {
          // customer cancellation under contract: deposit forfeited to venue
          await this.ledger.post({ currency: loc!.currency }, [{ account: 'DEPOSIT_LIABILITY', partyId: `event:${i.id}`, debitCents: i.depositCents, memo: 'Deposit forfeited' }, { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, locationId: i.locationId, creditCents: i.depositCents, memo: 'Deposit forfeited' }], tx);
        }
      }
      await tx.update(eventInquiries).set({ status: 'CANCELED', holdExpiresAt: null, notes: `${i.notes || ''}\nCanceled: ${reason || ''}`.trim() }).where(eq(eventInquiries.id, i.id));
    });
    return { ok: true };
  }

  async expireProposals(now = new Date()) {
    const r = await this.db.update(eventInquiries).set({ status: 'EXPIRED', holdExpiresAt: null }).where(and(eq(eventInquiries.status, 'PROPOSED'), lt(eventInquiries.proposalExpiresAt, now))).returning({ id: eventInquiries.id });
    return r.length;
  }

  async getInquiry(user: JwtPayload | null, id: string) {
    const [i] = await this.db.select().from(eventInquiries).where(eq(eventInquiries.id, id)).limit(1);
    if (!i) throw new NotFoundException();
    return i;
  }
}
