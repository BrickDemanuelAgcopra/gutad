import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { blackoutDates, invoices, locations, reservationEvents, reservationPolicies, reservationTables, reservations, rooms, shifts, tableComboMembers, tableCombinations, tables, waitlistEntries } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { OutboxService } from '../../core/outbox.service';
import { LedgerService } from '../../core/ledger.service';
import { AuditService } from '../../core/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { ContractsService } from '../contracts/contracts.service';
import { CrmService } from '../crm/crm.service';
import { GrowthService } from '../growth/growth.service';
import { addMinutes, invoiceNumber, localParts, shortCode, zonedTimeToUtc } from '../../common/utils';

type Channel = (typeof reservations.channel.enumValues)[number];
type RStatus = (typeof reservations.status.enumValues)[number];

const ACTIVE: RStatus[] = ['HELD', 'CONFIRMED', 'ARRIVED', 'SEATED'];

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly contracts: ContractsService,
    private readonly crm: CrmService,
    private readonly growth: GrowthService,
  ) {}

  // ───── 14 inventory setup ─────

  private async requireLoc(user: JwtPayload, locationId: string, roles = MANAGER_ROLES) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    assertOrgAccess(user, loc.organizationId, locationId, roles);
    return loc;
  }

  async setupFloor(user: JwtPayload, locationId: string, input: { rooms?: { name: string; isPrivate?: boolean; tables: { name: string; section?: string; minSeats: number; maxSeats: number; posTableId?: string }[] }[]; combinations?: { name: string; tableNames: string[]; minSeats: number; maxSeats: number }[] }) {
    await this.requireLoc(user, locationId);
    return this.db.transaction(async (tx) => {
      const created: (typeof tables.$inferSelect)[] = [];
      for (const r of input.rooms || []) {
        const [room] = await tx.insert(rooms).values({ locationId, name: r.name, isPrivate: !!r.isPrivate }).returning();
        if (r.tables.length) created.push(...(await tx.insert(tables).values(r.tables.map((t) => ({ ...t, locationId, roomId: room.id }))).returning()));
      }
      for (const c of input.combinations || []) {
        const members = created.filter((t) => c.tableNames.includes(t.name));
        if (members.length < 2) throw new BadRequestException(`Combination ${c.name} needs 2+ known tables`);
        const [combo] = await tx.insert(tableCombinations).values({ locationId, name: c.name, minSeats: c.minSeats, maxSeats: c.maxSeats }).returning();
        await tx.insert(tableComboMembers).values(members.map((m) => ({ combinationId: combo.id, tableId: m.id })));
      }
      await this.audit.log({ organizationId: (await tx.select().from(locations).where(eq(locations.id, locationId)))[0].organizationId, actorId: user.sub, action: 'floor.setup', entityType: 'location', entityId: locationId, after: { tables: created.length } }, tx);
      return this.floor(locationId, tx);
    });
  }

  async floor(locationId: string, tx: DbOrTx = this.db) {
    const r = await tx.select().from(rooms).where(eq(rooms.locationId, locationId));
    const t = await tx.select().from(tables).where(eq(tables.locationId, locationId));
    const c = await tx.select().from(tableCombinations).where(eq(tableCombinations.locationId, locationId));
    const m = c.length ? await tx.select().from(tableComboMembers).where(inArray(tableComboMembers.combinationId, c.map((x) => x.id))) : [];
    return { rooms: r, tables: t, combinations: c.map((x) => ({ ...x, tableIds: m.filter((y) => y.combinationId === x.id).map((y) => y.tableId) })) };
  }

  async upsertShift(user: JwtPayload, locationId: string, input: Partial<typeof shifts.$inferInsert> & { name: string; startTime: string; endTime: string }) {
    await this.requireLoc(user, locationId);
    if (input.id) {
      const [s] = await this.db.update(shifts).set(input).where(and(eq(shifts.id, input.id), eq(shifts.locationId, locationId))).returning();
      return s;
    }
    const [s] = await this.db.insert(shifts).values({ ...input, locationId }).returning();
    return s;
  }

  async setPolicy(user: JwtPayload, locationId: string, input: Partial<typeof reservationPolicies.$inferInsert>) {
    const loc = await this.requireLoc(user, locationId);
    const { id: _i, locationId: _l, ...safe } = input;
    const [p] = await this.db.insert(reservationPolicies).values({ ...safe, locationId }).onConflictDoUpdate({ target: reservationPolicies.locationId, set: safe }).returning();
    await this.audit.configChange({ organizationId: loc.organizationId, key: `reservation_policy:${locationId}`, after: p, actorId: user.sub });
    return p;
  }

  async addBlackout(user: JwtPayload, locationId: string, date: string, reason?: string) {
    const loc = await this.requireLoc(user, locationId);
    const [b] = await this.db.insert(blackoutDates).values({ locationId, date: zonedTimeToUtc(date, '00:00', loc.timezone), reason: reason ?? null }).returning();
    return b;
  }

  // ───── availability ─────

  private turnMinutes(shift: typeof shifts.$inferSelect, party: number) {
    return party <= 2 ? shift.turnMinutesSmall : party <= 4 ? shift.turnMinutesMedium : shift.turnMinutesLarge;
  }

  /**
   * Candidate seatings for a party: single tables first (tightest fit), then combinations.
   * Conflict rule: a table is busy if any active reservation on it overlaps [start, end).
   */
  private async findTables(locationId: string, party: number, startAt: Date, endAt: Date, tx: DbOrTx, excludeReservationId?: string): Promise<string[] | null> {
    const allTables = await tx.select().from(tables).where(and(eq(tables.locationId, locationId), eq(tables.isActive, true)));
    const busy = await tx
      .select({ tableId: reservationTables.tableId })
      .from(reservationTables)
      .innerJoin(reservations, eq(reservations.id, reservationTables.reservationId))
      .where(and(eq(reservations.locationId, locationId), inArray(reservations.status, ACTIVE), lt(reservations.startAt, endAt), gt(reservations.endAt, startAt), or(isNullHold(), gt(reservations.holdExpiresAt, new Date())), ...(excludeReservationId ? [ne(reservations.id, excludeReservationId)] : [])));
    const busyIds = new Set(busy.map((b) => b.tableId));
    const free = allTables.filter((t) => !busyIds.has(t.id));
    const single = free.filter((t) => t.minSeats <= party && t.maxSeats >= party).sort((a, b) => a.maxSeats - b.maxSeats)[0];
    if (single) return [single.id];
    const combos = await tx.select().from(tableCombinations).where(and(eq(tableCombinations.locationId, locationId), lte(tableCombinations.minSeats, party), gte(tableCombinations.maxSeats, party)));
    const members = combos.length ? await tx.select().from(tableComboMembers).where(inArray(tableComboMembers.combinationId, combos.map((c) => c.id))) : [];
    for (const c of combos.sort((a, b) => a.maxSeats - b.maxSeats)) {
      const ids = members.filter((m) => m.combinationId === c.id).map((m) => m.tableId);
      if (ids.length && ids.every((id) => free.some((f) => f.id === id))) return ids;
    }
    return null;
  }

  /** Public availability for a date (YYYY-MM-DD local) and party size. Pacing caps covers/bookings per slot. */
  async availability(locationId: string, date: string, partySize: number) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    if (!loc.acceptsReservations) return { slots: [], reason: 'Reservations not offered' };
    const dayStart = zonedTimeToUtc(date, '00:00', loc.timezone);
    const [blackout] = await this.db.select().from(blackoutDates).where(and(eq(blackoutDates.locationId, locationId), eq(blackoutDates.date, dayStart), eq(blackoutDates.closed, true))).limit(1);
    if (blackout) return { slots: [], reason: blackout.reason || 'Closed' };
    const dow = localParts(addMinutes(dayStart, 720), loc.timezone).dayOfWeek;
    const shiftRows = await this.db.select().from(shifts).where(and(eq(shifts.locationId, locationId), eq(shifts.isActive, true)));
    const slots: { time: string; iso: string; shiftId: string }[] = [];
    const now = new Date();
    for (const s of shiftRows.filter((x) => x.daysOfWeek.includes(dow))) {
      if (partySize > s.maxPartySize) continue;
      const turn = this.turnMinutes(s, partySize);
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      for (let t = sh * 60 + sm; t + turn <= eh * 60 + em; t += s.slotMinutes) {
        const hhmm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        const startAt = zonedTimeToUtc(date, hhmm, loc.timezone);
        if (startAt < addMinutes(now, 30)) continue;
        const endAt = addMinutes(startAt, turn);
        const [pace] = await this.db.select({ n: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(${reservations.partySize}),0)::int` }).from(reservations).where(and(eq(reservations.locationId, locationId), inArray(reservations.status, ACTIVE), gte(reservations.startAt, startAt), lt(reservations.startAt, addMinutes(startAt, s.slotMinutes))));
        if (pace.n >= s.maxBookingsPerSlot || pace.covers + partySize > s.maxCoversPerSlot) continue;
        const tableIds = await this.findTables(locationId, partySize, startAt, endAt, this.db);
        if (tableIds) slots.push({ time: hhmm, iso: startAt.toISOString(), shiftId: s.id });
      }
    }
    const [policy] = await this.db.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, locationId)).limit(1);
    return { slots, policy: policy ? { cancellationHours: policy.cancellationHours, depositCents: policy.depositCents, noShowFeeCents: policy.noShowFeeCents, requiresCardAbove: policy.requiresCardAbove, largePartyThreshold: policy.largePartyThreshold } : null };
  }

  // ───── 15 booking ─────

  /**
   * Hold → confirm in one call unless a deposit/guarantee is required (then the hold is returned with payment needs).
   * Tables are assigned inside a transaction with a per-location advisory lock so two simultaneous bookings and a
   * walk-in cannot oversell overlapping tables.
   */
  async book(user: JwtPayload | null, input: { locationId: string; startAt: string; partySize: number; guestName: string; guestEmail?: string; guestPhone?: string; notes?: string; occasion?: string; channel?: Channel; paymentMethodId?: string; idempotencyKey?: string }) {
    if (input.idempotencyKey) {
      const [ex] = await this.db.select().from(reservations).where(eq(reservations.idempotencyKey, input.idempotencyKey)).limit(1);
      if (ex) return this.present(ex.id);
    }
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
    if (!loc || !loc.acceptsReservations) throw new BadRequestException('Reservations not available');
    const startAt = new Date(input.startAt);
    if (isNaN(startAt.getTime()) || startAt < new Date()) throw new BadRequestException('Invalid start time');
    const [policy] = await this.db.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, loc.id)).limit(1);
    const shiftRows = await this.db.select().from(shifts).where(and(eq(shifts.locationId, loc.id), eq(shifts.isActive, true)));
    const lp = localParts(startAt, loc.timezone);
    const shift = shiftRows.find((s) => s.daysOfWeek.includes(lp.dayOfWeek) && lp.hhmm >= s.startTime && lp.hhmm < s.endTime);
    if (!shift) throw new BadRequestException('No dining shift at that time');
    if (input.partySize > shift.maxPartySize) throw new BadRequestException(`Parties above ${shift.maxPartySize} must submit a private event inquiry`);
    const endAt = addMinutes(startAt, this.turnMinutes(shift, input.partySize));
    const needsCard = !!policy?.requiresCardAbove && input.partySize >= policy.requiresCardAbove;
    const depositCents = policy?.depositCents && input.partySize >= (policy.largePartyThreshold || 6) ? policy.depositCents * input.partySize : 0;
    const channel = input.channel || 'MARKETPLACE';

    const id = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'resv:' + loc.id}))`);
      const tableIds = await this.findTables(loc.id, input.partySize, startAt, endAt, tx);
      if (!tableIds) throw new ConflictException('That time is no longer available');
      const [pace] = await tx.select({ n: sql<number>`count(*)::int`, covers: sql<number>`coalesce(sum(${reservations.partySize}),0)::int` }).from(reservations).where(and(eq(reservations.locationId, loc.id), inArray(reservations.status, ACTIVE), gte(reservations.startAt, startAt), lt(reservations.startAt, addMinutes(startAt, shift.slotMinutes))));
      if (pace.n >= shift.maxBookingsPerSlot || pace.covers + input.partySize > shift.maxCoversPerSlot) throw new ConflictException('That slot is fully paced');
      const holdMinutes = policy?.holdMinutes || 10;
      const requiresPayment = (needsCard || depositCents > 0) && !input.paymentMethodId;
      const [r] = await tx
        .insert(reservations)
        .values({ locationId: loc.id, userId: user?.sub ?? null, channel, status: requiresPayment ? 'HELD' : 'CONFIRMED', confirmationCode: `R${shortCode(6)}`, partySize: input.partySize, startAt, endAt, holdExpiresAt: requiresPayment ? addMinutes(new Date(), holdMinutes) : null, guestName: input.guestName, guestEmail: input.guestEmail ?? user?.email ?? null, guestPhone: input.guestPhone ?? null, notes: input.notes ?? null, occasion: input.occasion ?? null, depositCents, idempotencyKey: input.idempotencyKey ?? null })
        .returning();
      await tx.insert(reservationTables).values(tableIds.map((tableId) => ({ reservationId: r.id, tableId })));
      await tx.insert(reservationEvents).values({ reservationId: r.id, type: requiresPayment ? 'HELD' : 'CONFIRMED', actorId: user?.sub ?? null, data: { channel, tableIds } });
      if (!requiresPayment && (needsCard || depositCents > 0)) await this.secure(r, policy!, input.paymentMethodId!, user?.email || input.guestEmail || null, tx);
      if (!requiresPayment) {
        const g = await this.crm.upsertGuest(loc.organizationId, { locationId: loc.id, userId: user?.sub, name: input.guestName, email: input.guestEmail ?? user?.email, phone: input.guestPhone }, tx);
        await tx.update(reservations).set({ guestProfileId: g.id }).where(eq(reservations.id, r.id));
        await this.outbox.publish('reservation.confirmed', r.id, { confirmationCode: r.confirmationCode, userId: user?.sub, email: r.guestEmail, startAt: r.startAt, locationName: loc.name }, tx);
      } else await this.outbox.publish('reservation.held', r.id, { confirmationCode: r.confirmationCode, holdExpiresAt: r.holdExpiresAt }, tx);
      return r.id;
    });
    return this.present(id);
  }

  /** Tokenize a card for the guarantee or collect the deposit. Deposits are liabilities until applied/forfeited. */
  private async secure(r: typeof reservations.$inferSelect, policy: typeof reservationPolicies.$inferSelect, paymentMethodId: string, email: string | null, tx: DbOrTx) {
    if (r.depositCents > 0) {
      const [loc] = await tx.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
      const p = await this.payments.chargeNow({ purpose: 'DEPOSIT', referenceId: r.id, userId: r.userId, amountCents: r.depositCents, currency: loc!.currency, locationId: r.locationId, customerEmail: email, paymentMethodId, idempotencyKey: `deposit:${r.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: r.depositCents, memo: `Deposit ${r.confirmationCode}` }, { account: 'DEPOSIT_LIABILITY', partyId: r.id, creditCents: r.depositCents, memo: `Deposit ${r.confirmationCode}` }] }, tx);
      await tx.update(reservations).set({ depositPaymentId: p.id, guaranteePaymentMethodId: paymentMethodId }).where(eq(reservations.id, r.id));
    } else {
      // guarantee only: a card on file is not money collected
      await tx.update(reservations).set({ guaranteePaymentMethodId: paymentMethodId }).where(eq(reservations.id, r.id));
    }
  }

  /** Complete a HELD reservation with a payment method (deposit/guarantee). */
  async confirmHold(user: JwtPayload | null, reservationId: string, paymentMethodId: string) {
    const [r] = await this.db.select().from(reservations).where(eq(reservations.id, reservationId)).limit(1);
    if (!r) throw new NotFoundException();
    if (r.status !== 'HELD') throw new ConflictException(`Reservation is ${r.status}`);
    if (r.holdExpiresAt && r.holdExpiresAt < new Date()) throw new ConflictException('Hold expired; book again');
    const [policy] = await this.db.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, r.locationId)).limit(1);
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    await this.db.transaction(async (tx) => {
      await this.secure(r, policy!, paymentMethodId, user?.email || r.guestEmail, tx);
      const g = await this.crm.upsertGuest(loc!.organizationId, { locationId: r.locationId, userId: r.userId, name: r.guestName, email: r.guestEmail, phone: r.guestPhone }, tx);
      await tx.update(reservations).set({ status: 'CONFIRMED', holdExpiresAt: null, guestProfileId: g.id }).where(eq(reservations.id, reservationId));
      await tx.insert(reservationEvents).values({ reservationId, type: 'CONFIRMED', actorId: user?.sub ?? null, data: {} });
      await this.outbox.publish('reservation.confirmed', r.id, { confirmationCode: r.confirmationCode, userId: r.userId, email: r.guestEmail, startAt: r.startAt, locationName: loc!.name }, tx);
    });
    return this.present(reservationId);
  }

  async modify(user: JwtPayload | null, reservationId: string, input: { startAt?: string; partySize?: number; notes?: string }) {
    const r = await this.requireOwnerOrStaff(user, reservationId);
    if (!['HELD', 'CONFIRMED'].includes(r.status)) throw new ConflictException(`Cannot modify a ${r.status} reservation`);
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    const startAt = input.startAt ? new Date(input.startAt) : r.startAt;
    const party = input.partySize ?? r.partySize;
    const shiftRows = await this.db.select().from(shifts).where(and(eq(shifts.locationId, r.locationId), eq(shifts.isActive, true)));
    const lp = localParts(startAt, loc!.timezone);
    const shift = shiftRows.find((s) => s.daysOfWeek.includes(lp.dayOfWeek) && lp.hhmm >= s.startTime && lp.hhmm < s.endTime);
    if (!shift) throw new BadRequestException('No dining shift at that time');
    const endAt = addMinutes(startAt, this.turnMinutes(shift, party));
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'resv:' + r.locationId}))`);
      const tableIds = await this.findTables(r.locationId, party, startAt, endAt, tx, r.id);
      if (!tableIds) throw new ConflictException('No availability for the new time/party');
      await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
      await tx.insert(reservationTables).values(tableIds.map((tableId) => ({ reservationId: r.id, tableId })));
      await tx.update(reservations).set({ startAt, endAt, partySize: party, notes: input.notes ?? r.notes }).where(eq(reservations.id, r.id));
      await tx.insert(reservationEvents).values({ reservationId: r.id, type: 'MODIFIED', actorId: user?.sub ?? null, data: { before: { startAt: r.startAt, partySize: r.partySize }, after: { startAt, partySize: party } } });
    });
    return this.present(reservationId);
  }

  /** Cancellation releases inventory; late cancellations under policy may forfeit the deposit or charge the guarantee. */
  async cancel(user: JwtPayload | null, reservationId: string, reason?: string) {
    const r = await this.requireOwnerOrStaff(user, reservationId);
    if (!['HELD', 'CONFIRMED'].includes(r.status)) throw new ConflictException(`Cannot cancel a ${r.status} reservation`);
    const [policy] = await this.db.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, r.locationId)).limit(1);
    const hoursBefore = (r.startAt.getTime() - Date.now()) / 3_600_000;
    const late = !!policy && hoursBefore < policy.cancellationHours;
    const staff = user && !(r.userId === user.sub);
    await this.db.transaction(async (tx) => {
      await tx.update(reservations).set({ status: 'CANCELED', canceledAt: new Date() }).where(eq(reservations.id, r.id));
      await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
      if (r.depositPaymentId) {
        if (late && !staff) await this.forfeitDeposit(r, 'Late cancellation', tx);
        else await this.payments.refund({ paymentId: r.depositPaymentId, amountCents: r.depositCents, reason: 'Reservation canceled', funder: 'MERCHANT', idempotencyKey: `dep-refund:${r.id}` }, tx).then(() => this.ledger.post({ reservationId: r.id, currency: 'USD' }, [{ account: 'DEPOSIT_LIABILITY', partyId: r.id, debitCents: r.depositCents, memo: 'Deposit returned' }, { account: 'MERCHANT_PAYABLE', partyId: 'deposit-offset', creditCents: r.depositCents, memo: 'Offset refund funder' }], tx));
      }
      await tx.insert(reservationEvents).values({ reservationId: r.id, type: 'CANCELED', actorId: user?.sub ?? null, data: { reason, late } });
      await this.outbox.publish('reservation.canceled', r.id, { confirmationCode: r.confirmationCode, userId: r.userId, email: r.guestEmail, late }, tx);
    });
    return this.present(reservationId);
  }

  private async forfeitDeposit(r: typeof reservations.$inferSelect, memo: string, tx: DbOrTx) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    await this.ledger.post({ reservationId: r.id, paymentId: r.depositPaymentId, currency: loc!.currency }, [
      { account: 'DEPOSIT_LIABILITY', partyId: r.id, debitCents: r.depositCents, memo },
      { account: 'MERCHANT_PAYABLE', partyId: loc!.organizationId, organizationId: loc!.organizationId, locationId: r.locationId, creditCents: r.depositCents, memo },
    ], tx);
  }

  // ───── 16 host stand ─────

  async hostBoard(user: JwtPayload, locationId: string, date?: string) {
    const loc = await this.requireLoc(user, locationId, undefined as never);
    const day = date || localParts(new Date(), loc.timezone).ymd;
    const start = zonedTimeToUtc(day, '00:00', loc.timezone);
    const end = addMinutes(start, 1440);
    const rows = await this.db.select().from(reservations).where(and(eq(reservations.locationId, locationId), gte(reservations.startAt, start), lt(reservations.startAt, end), ne(reservations.status, 'EXPIRED'))).orderBy(asc(reservations.startAt));
    const ids = rows.map((r) => r.id);
    const rt = ids.length ? await this.db.select().from(reservationTables).where(inArray(reservationTables.reservationId, ids)) : [];
    const wl = await this.db.select().from(waitlistEntries).where(and(eq(waitlistEntries.locationId, locationId), inArray(waitlistEntries.status, ['WAITING', 'NOTIFIED']))).orderBy(asc(waitlistEntries.position));
    const floor = await this.floor(locationId);
    const seatedTableIds = new Set(rt.filter((x) => rows.find((r) => r.id === x.reservationId)?.status === 'SEATED').map((x) => x.tableId));
    return { date: day, reservations: rows.map((r) => ({ ...r, tableIds: rt.filter((x) => x.reservationId === r.id).map((x) => x.tableId) })), waitlist: wl, floor: { ...floor, tables: floor.tables.map((t) => ({ ...t, occupied: seatedTableIds.has(t.id) })) } };
  }

  /** Phone bookings / walk-ins created by the host (same inventory rules, channel PHONE/WALK_IN). */
  async hostBook(user: JwtPayload, locationId: string, input: { startAt?: string; partySize: number; guestName: string; guestPhone?: string; notes?: string; channel: 'PHONE' | 'WALK_IN' }) {
    await this.requireLoc(user, locationId, undefined as never);
    const startAt = input.startAt || new Date(Date.now() + 60_000).toISOString();
    return this.book(user, { locationId, startAt, partySize: input.partySize, guestName: input.guestName, guestPhone: input.guestPhone, notes: input.notes, channel: input.channel });
  }

  async hostTransition(user: JwtPayload, reservationId: string, action: 'ARRIVE' | 'SEAT' | 'MOVE' | 'COMPLETE' | 'NO_SHOW', data: { actualPartySize?: number; tableIds?: string[]; posCheckId?: string; checkTotalCents?: number }) {
    const [r] = await this.db.select().from(reservations).where(eq(reservations.id, reservationId)).limit(1);
    if (!r) throw new NotFoundException();
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    assertOrgAccess(user, loc!.organizationId, r.locationId);
    await this.db.transaction(async (tx) => {
      const now = new Date();
      switch (action) {
        case 'ARRIVE':
          if (r.status !== 'CONFIRMED') throw new ConflictException(`Reservation is ${r.status}`);
          await tx.update(reservations).set({ status: 'ARRIVED', arrivedAt: now, actualPartySize: data.actualPartySize ?? r.partySize }).where(eq(reservations.id, r.id));
          break;
        case 'SEAT':
          if (!['CONFIRMED', 'ARRIVED'].includes(r.status)) throw new ConflictException(`Reservation is ${r.status}`);
          if (data.tableIds?.length) {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'resv:' + r.locationId}))`);
            await this.assertTablesFree(r, data.tableIds, tx);
            await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
            await tx.insert(reservationTables).values(data.tableIds.map((tableId) => ({ reservationId: r.id, tableId })));
          }
          await tx.update(reservations).set({ status: 'SEATED', seatedAt: now, arrivedAt: r.arrivedAt || now, actualPartySize: data.actualPartySize ?? r.actualPartySize ?? r.partySize }).where(eq(reservations.id, r.id));
          await this.outbox.publish('reservation.seated', r.id, { confirmationCode: r.confirmationCode }, tx);
          break;
        case 'MOVE':
          if (r.status !== 'SEATED') throw new ConflictException('Only seated parties can be moved');
          if (!data.tableIds?.length) throw new BadRequestException('tableIds required');
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'resv:' + r.locationId}))`);
          await this.assertTablesFree(r, data.tableIds, tx);
          await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
          await tx.insert(reservationTables).values(data.tableIds.map((tableId) => ({ reservationId: r.id, tableId })));
          break;
        case 'COMPLETE':
          if (r.status !== 'SEATED') throw new ConflictException('Party is not seated');
          await this.closeVisit(r, loc!, data, tx);
          break;
        case 'NO_SHOW':
          if (!['CONFIRMED', 'ARRIVED'].includes(r.status)) throw new ConflictException(`Reservation is ${r.status}`);
          await tx.update(reservations).set({ status: 'NO_SHOW', noShowAt: now }).where(eq(reservations.id, r.id));
          await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
          await this.chargeNoShow(r, loc!, tx);
          await this.outbox.publish('reservation.no_show', r.id, { confirmationCode: r.confirmationCode, userId: r.userId, email: r.guestEmail }, tx);
          break;
      }
      await tx.insert(reservationEvents).values({ reservationId: r.id, type: action, actorId: user.sub, data });
    });
    return this.present(reservationId);
  }

  private async assertTablesFree(r: typeof reservations.$inferSelect, tableIds: string[], tx: DbOrTx) {
    const busy = await tx.select({ tableId: reservationTables.tableId }).from(reservationTables).innerJoin(reservations, eq(reservations.id, reservationTables.reservationId)).where(and(inArray(reservationTables.tableId, tableIds), ne(reservations.id, r.id), inArray(reservations.status, ['SEATED', 'ARRIVED']), lt(reservations.startAt, r.endAt), gt(reservations.endAt, r.startAt)));
    if (busy.length) throw new ConflictException('One or more tables are occupied');
  }

  /**
   * Close visit: actual covers drive the cover fee under the contract; deposit applies to the check (per policy);
   * a POS check total enriches CRM spend. Billable covers only for network-sourced diners.
   */
  private async closeVisit(r: typeof reservations.$inferSelect, loc: typeof locations.$inferSelect, data: { posCheckId?: string; checkTotalCents?: number; actualPartySize?: number }, tx: DbOrTx) {
    const covers = data.actualPartySize ?? r.actualPartySize ?? r.partySize;
    const terms = await this.contracts.termsFor(r.locationId, r.channel as never, r.startAt, tx);
    const coverFee = terms.coverFeeCents * covers;
    const [policy] = await tx.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, r.locationId)).limit(1);
    let depositApplied = 0;
    if (r.depositPaymentId && r.depositCents > 0 && (policy?.depositAppliesToCheck ?? true)) {
      depositApplied = r.depositCents; // applied once
      await this.ledger.post({ reservationId: r.id, paymentId: r.depositPaymentId, currency: loc.currency }, [
        { account: 'DEPOSIT_LIABILITY', partyId: r.id, debitCents: depositApplied, memo: 'Deposit applied to check' },
        { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId: r.locationId, creditCents: depositApplied, memo: 'Deposit applied to check' },
      ], tx);
    }
    if (coverFee > 0) {
      await this.ledger.post({ reservationId: r.id, currency: loc.currency }, [
        { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId: r.locationId, debitCents: coverFee, memo: `Cover fee ${covers} × ${terms.coverFeeCents}` },
        { account: 'PLATFORM_REVENUE_COVER_FEE', creditCents: coverFee, organizationId: loc.organizationId, locationId: r.locationId },
      ], tx);
    }
    await tx.update(reservations).set({ status: 'COMPLETED', completedAt: new Date(), actualPartySize: covers, billableCovers: terms.coverFeeCents > 0 ? covers : 0, coverFeeCents: coverFee, depositAppliedCents: depositApplied, posCheckId: data.posCheckId ?? r.posCheckId, checkTotalCents: data.checkTotalCents ?? r.checkTotalCents }).where(eq(reservations.id, r.id));
    await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
    await this.crm.recordVisit(loc.organizationId, { locationId: r.locationId, userId: r.userId, name: r.guestName, email: r.guestEmail, phone: r.guestPhone, spendCents: data.checkTotalCents || 0 }, tx);
  }

  private async chargeNoShow(r: typeof reservations.$inferSelect, loc: typeof locations.$inferSelect, tx: DbOrTx) {
    const [policy] = await tx.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, r.locationId)).limit(1);
    if (r.depositPaymentId && r.depositCents > 0) {
      await this.forfeitDeposit(r, 'No-show: deposit forfeited', tx);
      await tx.update(reservations).set({ noShowChargedCents: r.depositCents }).where(eq(reservations.id, r.id));
      return;
    }
    if (policy?.noShowFeeCents && r.guaranteePaymentMethodId) {
      const amount = policy.noShowFeeCents * r.partySize;
      try {
        const p = await this.payments.chargeNow({ purpose: 'NO_SHOW', referenceId: r.id, userId: r.userId, amountCents: amount, currency: loc.currency, locationId: r.locationId, paymentMethodId: r.guaranteePaymentMethodId, offSession: true, customerEmail: r.guestEmail, idempotencyKey: `noshow:${r.id}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: amount }, { account: 'MERCHANT_PAYABLE', partyId: loc.organizationId, organizationId: loc.organizationId, locationId: r.locationId, creditCents: amount, memo: `No-show fee ${r.confirmationCode}` }] }, tx);
        await tx.update(reservations).set({ noShowChargedCents: p.capturedCents }).where(eq(reservations.id, r.id));
        await tx.insert(reservationEvents).values({ reservationId: r.id, type: 'NO_SHOW_CHARGED', data: { amount, paymentId: p.id, evidence: 'host marked no-show; policy accepted at booking' } });
      } catch (e) {
        await tx.insert(reservationEvents).values({ reservationId: r.id, type: 'NO_SHOW_CHARGE_FAILED', data: { error: (e as Error).message } });
      }
    }
  }

  // ───── waitlist ─────

  async joinWaitlist(user: JwtPayload | null, locationId: string, input: { guestName: string; guestPhone?: string; partySize: number }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    const waiting = await this.db.select().from(waitlistEntries).where(and(eq(waitlistEntries.locationId, locationId), inArray(waitlistEntries.status, ['WAITING', 'NOTIFIED'])));
    const member = user ? await this.growth.activeMembership(user.sub) : null;
    const priority = !!member?.benefits.priorityWaitlist;
    const position = priority ? Math.max(1, Math.ceil(waiting.length / 2)) : waiting.length + 1;
    const quoted = Math.max(5, position * 12);
    const [w] = await this.db.insert(waitlistEntries).values({ locationId, userId: user?.sub ?? null, guestName: input.guestName, guestPhone: input.guestPhone ?? null, partySize: input.partySize, quotedMinutes: quoted, position }).returning();
    return w;
  }

  async notifyWaitlist(user: JwtPayload, entryId: string) {
    const [w] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).limit(1);
    if (!w) throw new NotFoundException();
    await this.requireLoc(user, w.locationId, undefined as never);
    const [u] = await this.db.update(waitlistEntries).set({ status: 'NOTIFIED', notifiedAt: new Date(), offerExpiresAt: addMinutes(new Date(), 10) }).where(eq(waitlistEntries.id, entryId)).returning();
    await this.outbox.publish('waitlist.table_ready', entryId, { userId: w.userId, phone: w.guestPhone, guestName: w.guestName, expiresAt: u.offerExpiresAt });
    return u;
  }

  /** Seat from the waitlist: creates a WALK_IN reservation at "now" and seats it. */
  async seatWaitlist(user: JwtPayload, entryId: string, tableIds?: string[]) {
    const [w] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).limit(1);
    if (!w) throw new NotFoundException();
    if (!['WAITING', 'NOTIFIED'].includes(w.status)) throw new ConflictException(`Entry is ${w.status}`);
    const r = await this.hostBook(user, w.locationId, { partySize: w.partySize, guestName: w.guestName, guestPhone: w.guestPhone ?? undefined, channel: 'WALK_IN' });
    await this.hostTransition(user, r.id, 'SEAT', { tableIds });
    await this.db.update(waitlistEntries).set({ status: 'SEATED', seatedAt: new Date(), reservationId: r.id }).where(eq(waitlistEntries.id, entryId));
    return this.present(r.id);
  }

  async leaveWaitlist(user: JwtPayload | null, entryId: string) {
    const [w] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).limit(1);
    if (!w) throw new NotFoundException();
    if (user && w.userId && w.userId !== user.sub && !isPlatformStaff(user)) {
      const [loc] = await this.db.select().from(locations).where(eq(locations.id, w.locationId)).limit(1);
      assertOrgAccess(user, loc!.organizationId, w.locationId);
    }
    await this.db.update(waitlistEntries).set({ status: 'LEFT' }).where(eq(waitlistEntries.id, entryId));
    return { ok: true };
  }

  async waitlistStatus(entryId: string) {
    const [w] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).limit(1);
    if (!w) throw new NotFoundException();
    const ahead = await this.db.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(eq(waitlistEntries.locationId, w.locationId), eq(waitlistEntries.status, 'WAITING'), lt(waitlistEntries.position, w.position)));
    return { ...w, partiesAhead: ahead[0]?.n || 0 };
  }

  // ───── presentation & helpers ─────

  async present(id: string) {
    const [r] = await this.db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    const [loc] = await this.db.select({ name: locations.name, slug: locations.slug, addressLine1: locations.addressLine1, city: locations.city }).from(locations).where(eq(locations.id, r.locationId)).limit(1);
    const [policy] = await this.db.select().from(reservationPolicies).where(eq(reservationPolicies.locationId, r.locationId)).limit(1);
    const t = await this.db.select().from(reservationTables).where(eq(reservationTables.reservationId, id));
    return { ...r, location: loc, tableIds: t.map((x) => x.tableId), policy: policy ? { cancellationHours: policy.cancellationHours, noShowFeeCents: policy.noShowFeeCents, depositCents: policy.depositCents } : null, requiresPayment: r.status === 'HELD' };
  }

  async history(id: string) {
    return this.db.select().from(reservationEvents).where(eq(reservationEvents.reservationId, id)).orderBy(asc(reservationEvents.createdAt));
  }

  async myReservations(user: JwtPayload) {
    const rows = await this.db.select().from(reservations).where(eq(reservations.userId, user.sub)).orderBy(desc(reservations.startAt)).limit(100);
    const out = [];
    for (const r of rows) out.push(await this.present(r.id));
    return out;
  }

  async byCode(code: string, email?: string) {
    const [r] = await this.db.select().from(reservations).where(eq(reservations.confirmationCode, code.toUpperCase())).limit(1);
    if (!r) throw new NotFoundException();
    if (r.userId && (!email || r.guestEmail?.toLowerCase() !== email.toLowerCase())) throw new ForbiddenException();
    return this.present(r.id);
  }

  private async requireOwnerOrStaff(user: JwtPayload | null, reservationId: string) {
    const [r] = await this.db.select().from(reservations).where(eq(reservations.id, reservationId)).limit(1);
    if (!r) throw new NotFoundException();
    if (!user) {
      if (r.userId) throw new ForbiddenException();
      return r;
    }
    if (r.userId === user.sub || isPlatformStaff(user)) return r;
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    assertOrgAccess(user, loc!.organizationId, r.locationId);
    return r;
  }

  // ───── worker helpers ─────

  async expireHolds(now = new Date()) {
    const rows = await this.db.update(reservations).set({ status: 'EXPIRED' }).where(and(eq(reservations.status, 'HELD'), lt(reservations.holdExpiresAt, now))).returning({ id: reservations.id });
    if (rows.length) await this.db.delete(reservationTables).where(inArray(reservationTables.reservationId, rows.map((r) => r.id)));
    return rows.length;
  }

  async expireWaitlistOffers(now = new Date()) {
    const rows = await this.db.update(waitlistEntries).set({ status: 'EXPIRED' }).where(and(eq(waitlistEntries.status, 'NOTIFIED'), lt(waitlistEntries.offerExpiresAt, now))).returning();
    for (const w of rows) {
      await this.outbox.publish('waitlist.expired', w.id, { userId: w.userId, guestName: w.guestName, locationId: w.locationId });
      // notify next guest
      const [next] = await this.db.select().from(waitlistEntries).where(and(eq(waitlistEntries.locationId, w.locationId), eq(waitlistEntries.status, 'WAITING'))).orderBy(asc(waitlistEntries.position)).limit(1);
      if (next) {
        await this.db.update(waitlistEntries).set({ status: 'NOTIFIED', notifiedAt: now, offerExpiresAt: addMinutes(now, 10) }).where(eq(waitlistEntries.id, next.id));
        await this.outbox.publish('waitlist.table_ready', next.id, { userId: next.userId, phone: next.guestPhone, guestName: next.guestName, expiresAt: addMinutes(now, 10) });
      }
    }
    return rows.length;
  }

  async sendReminders(now = new Date()) {
    const rows = await this.db
      .select({ r: reservations, p: reservationPolicies, loc: locations })
      .from(reservations)
      .innerJoin(locations, eq(locations.id, reservations.locationId))
      .leftJoin(reservationPolicies, eq(reservationPolicies.locationId, reservations.locationId))
      .where(and(eq(reservations.status, 'CONFIRMED'), sql`${reservations.reminderSentAt} is null`, lte(reservations.startAt, addMinutes(now, 24 * 60)), gt(reservations.startAt, now)));
    let n = 0;
    for (const { r, p, loc } of rows) {
      const hours = p?.reminderHoursBefore ?? 24;
      if (r.startAt > addMinutes(now, hours * 60)) continue;
      await this.db.update(reservations).set({ reminderSentAt: now }).where(eq(reservations.id, r.id));
      await this.outbox.publish('reservation.reminder', r.id, { confirmationCode: r.confirmationCode, userId: r.userId, email: r.guestEmail, phone: r.guestPhone, startAt: r.startAt, locationName: loc.name });
      n++;
    }
    return n;
  }

  /** Auto no-show: confirmed but never arrived 45 min after start. */
  async autoNoShow(now = new Date()) {
    const rows = await this.db.select({ r: reservations, loc: locations }).from(reservations).innerJoin(locations, eq(locations.id, reservations.locationId)).where(and(eq(reservations.status, 'CONFIRMED'), lt(reservations.startAt, addMinutes(now, -45))));
    for (const { r, loc } of rows) {
      await this.db.transaction(async (tx) => {
        await tx.update(reservations).set({ status: 'NO_SHOW', noShowAt: now }).where(eq(reservations.id, r.id));
        await tx.delete(reservationTables).where(eq(reservationTables.reservationId, r.id));
        await this.chargeNoShow(r, loc, tx);
        await tx.insert(reservationEvents).values({ reservationId: r.id, type: 'NO_SHOW', data: { auto: true } });
        await this.outbox.publish('reservation.no_show', r.id, { confirmationCode: r.confirmationCode, userId: r.userId, email: r.guestEmail }, tx);
      });
    }
    return rows.length;
  }

  /** Monthly cover invoice per organization from completed reservations with billable covers. */
  async invoiceCovers(periodStart: Date, periodEnd: Date) {
    const rows = await this.db
      .select({ orgId: locations.organizationId, covers: sql<number>`coalesce(sum(${reservations.billableCovers}),0)::int`, cents: sql<number>`coalesce(sum(${reservations.coverFeeCents}),0)::int` })
      .from(reservations)
      .innerJoin(locations, eq(locations.id, reservations.locationId))
      .where(and(eq(reservations.status, 'COMPLETED'), gte(reservations.completedAt, periodStart), lt(reservations.completedAt, periodEnd), sql`${reservations.coverInvoiceId} is null`, gt(reservations.coverFeeCents, 0)))
      .groupBy(locations.organizationId);
    const out: string[] = [];
    for (const r of rows) {
      await this.db.transaction(async (tx) => {
        const [inv] = await tx.insert(invoices).values({ organizationId: r.orgId, number: invoiceNumber('COV'), kind: 'COVERS', currency: 'USD', lines: [{ description: `${r.covers} seated covers`, cents: r.cents, periodStart, periodEnd }], totalCents: r.cents, dueAt: addMinutes(periodEnd, 14 * 1440), paidAt: new Date() }).returning();
        await tx.execute(sql`update reservations set cover_invoice_id=${inv.id} where location_id in (select id from locations where organization_id=${r.orgId}) and status='COMPLETED' and completed_at >= ${periodStart} and completed_at < ${periodEnd} and cover_invoice_id is null and cover_fee_cents > 0`);
        out.push(inv.id);
      });
    }
    return out;
  }
}

function isNullHold() {
  return sql`${reservations.holdExpiresAt} is null`;
}
