import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { DEFAULT_GIFT_CARD_LIMITS, type GiftCardLimits } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { giftCards, giftCardTxns, users } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { RedisService } from '../../core/redis.service';
import { SettingsService } from '../../core/settings.service';
import { addDays, shortCode } from '../../common/utils';
import { loadConfig } from '../../config/config';
import { PaymentsService } from '../payments/payments.service';
import { giftBalance } from './gift-tender';

const mask = (code: string) => `••••-${code.slice(-4)}`;
const newCode = () => `GC${shortCode(4)}-${shortCode(4)}-${shortCode(4)}`.toUpperCase();

/** 25.9 gift cards: purchase and promotional issue, wallet, balances, liability and fraud controls. */
@Injectable()
export class GiftCardsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  limits() {
    return this.settings.getObject<GiftCardLimits>('giftcards.limits', DEFAULT_GIFT_CARD_LIMITS);
  }

  // ───── customer ─────

  /** Buy a card for someone (or yourself). Velocity limits per buyer; large cards wait for review before delivery. */
  async purchase(user: JwtPayload, input: { amountCents: number; recipientEmail?: string; recipientName?: string; message?: string; paymentMethodId?: string }) {
    const lim = await this.limits();
    if (input.amountCents < lim.minCardCents || input.amountCents > lim.maxCardCents) throw new BadRequestException(`Gift cards are between $${(lim.minCardCents / 100).toFixed(2)} and $${(lim.maxCardCents / 100).toFixed(2)}`);
    const since = addDays(new Date(), -1);
    const [v] = await this.db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${giftCards.initialCents}),0)::int` }).from(giftCards).where(and(eq(giftCards.purchaserId, user.sub), eq(giftCards.kind, 'PURCHASED'), gte(giftCards.createdAt, since)));
    if (v.n + 1 > lim.maxPurchasesPerDay || v.cents + input.amountCents > lim.maxCentsPerDay) {
      await this.audit.log({ actorId: user.sub, action: 'giftcard.velocity_block', entityType: 'user', entityId: user.sub, after: { purchases24h: v.n, cents24h: v.cents, attemptCents: input.amountCents } });
      throw new HttpException({ message: 'Gift card purchase limit reached for today. Try again tomorrow or contact support.', code: 'GIFT_CARD_VELOCITY' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const currency = loadConfig().DEFAULT_CURRENCY;
    return this.db.transaction(async (tx) => {
      const code = newCode();
      const p = await this.payments.chargeNow({ purpose: 'GIFT_CARD', referenceId: code, userId: user.sub, amountCents: input.amountCents, currency, customerEmail: user.email, paymentMethodId: input.paymentMethodId, idempotencyKey: `gift:${user.sub}:${code}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: input.amountCents, memo: 'Gift card sold' }, { account: 'GIFT_CARD_LIABILITY', partyId: 'gift-cards', creditCents: input.amountCents, memo: `Gift card ${mask(code)}` }] }, tx);
      const review = input.amountCents > lim.reviewAboveCents;
      const self = !input.recipientEmail || input.recipientEmail.toLowerCase() === user.email?.toLowerCase();
      const [card] = await tx.insert(giftCards).values({ code, kind: 'PURCHASED', currency, initialCents: input.amountCents, balanceCents: input.amountCents, status: review ? 'PENDING_REVIEW' : 'ACTIVE', purchaserId: user.sub, ownerId: self ? user.sub : null, claimedAt: self ? new Date() : null, recipientEmail: input.recipientEmail?.toLowerCase() ?? user.email ?? null, recipientName: input.recipientName ?? null, message: input.message ?? null, paymentId: p.id }).returning();
      await tx.insert(giftCardTxns).values({ giftCardId: card.id, kind: 'ISSUE', cents: input.amountCents, actorId: user.sub, note: 'Purchased' });
      if (!review && !self) await this.outbox.publish('giftcard.delivered', card.id, { email: card.recipientEmail, recipientName: card.recipientName, amountCents: card.initialCents, code: card.code, message: card.message, from: user.email }, tx);
      return { id: card.id, code: card.code, status: card.status, amountCents: card.initialCents, recipientEmail: card.recipientEmail, note: review ? 'Large gift cards are checked by our team before delivery (usually within a few hours).' : self ? 'Added to your wallet.' : 'Sent to the recipient by email.' };
    });
  }

  /** Add a card to your wallet by code. Repeated wrong codes lock the account out of gift cards for an hour. */
  async claim(user: JwtPayload, code: string) {
    const lim = await this.limits();
    const key = `gc-fail:${user.sub}`;
    const fails = Number((await this.redis.client.get(key)) || 0);
    if (fails >= lim.maxFailedRedeemsPerHour) throw new HttpException({ message: 'Too many incorrect gift card codes. Try again in an hour.', code: 'GIFT_CARD_ATTEMPTS' }, HttpStatus.TOO_MANY_REQUESTS);
    const [card] = await this.db.select().from(giftCards).where(eq(giftCards.code, code.trim().toUpperCase())).limit(1);
    if (!card) {
      const n = await this.redis.incrWindow(key, 3600);
      if (n >= lim.maxFailedRedeemsPerHour) await this.audit.log({ actorId: user.sub, action: 'giftcard.attempts_locked', entityType: 'user', entityId: user.sub, after: { failures: n } });
      throw new BadRequestException({ message: 'Gift card not found. Check the code and try again.', code: 'GIFT_CARD_NOT_FOUND' });
    }
    if (card.ownerId && card.ownerId !== user.sub) throw new BadRequestException({ message: 'This gift card is already in another account', code: 'GIFT_CARD_CLAIMED' });
    if (card.status === 'LOCKED') throw new BadRequestException({ message: 'This gift card is locked. Contact support.', code: 'GIFT_CARD_LOCKED' });
    if (card.status === 'VOID') throw new BadRequestException({ message: 'This gift card is no longer valid', code: 'GIFT_CARD_VOID' });
    if (card.status === 'PENDING_REVIEW') throw new BadRequestException({ message: 'This gift card is being activated; try again soon', code: 'GIFT_CARD_PENDING' });
    if (card.expiresAt && card.expiresAt < new Date()) throw new BadRequestException({ message: 'This gift card has expired', code: 'GIFT_CARD_EXPIRED' });
    if (!card.ownerId) await this.db.update(giftCards).set({ ownerId: user.sub, claimedAt: new Date() }).where(eq(giftCards.id, card.id));
    return { id: card.id, code: mask(card.code), balanceCents: card.balanceCents, walletCents: await giftBalance(this.db, user.sub) };
  }

  async mine(userId: string) {
    const owned = await this.db.select().from(giftCards).where(eq(giftCards.ownerId, userId)).orderBy(desc(giftCards.createdAt));
    const bought = await this.db.select().from(giftCards).where(eq(giftCards.purchaserId, userId)).orderBy(desc(giftCards.createdAt)).limit(50);
    const ids = owned.map((c) => c.id);
    const txns = ids.length ? await this.db.select().from(giftCardTxns).where(inArray(giftCardTxns.giftCardId, ids)).orderBy(desc(giftCardTxns.createdAt)).limit(100) : [];
    return {
      balanceCents: await giftBalance(this.db, userId),
      cards: owned.map((c) => ({ id: c.id, code: mask(c.code), status: c.status, balanceCents: c.balanceCents, initialCents: c.initialCents, expiresAt: c.expiresAt, kind: c.kind })),
      purchased: bought.map((c) => ({ id: c.id, code: c.ownerId === userId ? mask(c.code) : c.code, status: c.status, amountCents: c.initialCents, recipientEmail: c.recipientEmail, recipientName: c.recipientName, claimed: !!c.ownerId, createdAt: c.createdAt })),
      activity: txns.map((t) => ({ id: t.id, kind: t.kind, cents: t.cents, orderId: t.orderId, at: t.createdAt, card: mask(owned.find((c) => c.id === t.giftCardId)?.code || '') })),
    };
  }

  // ───── admin ─────

  async issuePromotional(user: JwtPayload, input: { amountCents: number; count?: number; recipientEmail?: string; reason: string; expiresInDays?: number }) {
    assertCan(user, 'growth.manage');
    const count = Math.min(Math.max(1, input.count || 1), 100);
    const currency = loadConfig().DEFAULT_CURRENCY;
    return this.db.transaction(async (tx) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const [card] = await tx.insert(giftCards).values({ code: newCode(), kind: 'PROMOTIONAL', currency, initialCents: input.amountCents, balanceCents: input.amountCents, status: 'ACTIVE', recipientEmail: input.recipientEmail?.toLowerCase() ?? null, issuedById: user.sub, reason: input.reason, expiresAt: input.expiresInDays ? addDays(new Date(), input.expiresInDays) : null }).returning();
        await tx.insert(giftCardTxns).values({ giftCardId: card.id, kind: 'ISSUE', cents: input.amountCents, actorId: user.sub, note: input.reason });
        if (card.recipientEmail) await this.outbox.publish('giftcard.delivered', card.id, { email: card.recipientEmail, amountCents: card.initialCents, code: card.code, message: input.reason, from: 'Gutad' }, tx);
        out.push(card);
      }
      const total = input.amountCents * count;
      await this.ledger.post({ currency }, [{ account: 'PLATFORM_EXPENSE_PROMOTION', debitCents: total, memo: `Promotional gift cards: ${input.reason}` }, { account: 'GIFT_CARD_LIABILITY', partyId: 'gift-cards', creditCents: total, memo: `${count} promotional gift card(s)` }], tx);
      await this.audit.log({ actorId: user.sub, action: 'giftcard.issue', entityType: 'gift_card', entityId: out[0].id, after: { count, amountCents: input.amountCents }, reason: input.reason }, tx);
      return out.map((c) => ({ id: c.id, code: c.code, amountCents: c.initialCents, expiresAt: c.expiresAt }));
    });
  }

  async list(user: JwtPayload, q: { status?: string; search?: string }) {
    assertCan(user, 'growth.read', 'finance.read', 'support.read');
    const conds = [];
    if (q.status) conds.push(eq(giftCards.status, q.status));
    if (q.search) conds.push(or(ilike(giftCards.code, `%${q.search.toUpperCase()}`), ilike(giftCards.recipientEmail, `%${q.search}%`)));
    const rows = await this.db.select({ c: giftCards, buyer: users.email }).from(giftCards).leftJoin(users, eq(users.id, giftCards.purchaserId)).where(conds.length ? and(...conds) : undefined).orderBy(desc(giftCards.createdAt)).limit(200);
    // velocity watch: buyers with 2+ cards in the last 24 hours
    const watch = await this.db.select({ userId: giftCards.purchaserId, email: users.email, n: sql<number>`count(*)::int`, cents: sql<number>`sum(${giftCards.initialCents})::int` }).from(giftCards).innerJoin(users, eq(users.id, giftCards.purchaserId)).where(and(eq(giftCards.kind, 'PURCHASED'), gte(giftCards.createdAt, addDays(new Date(), -1)))).groupBy(giftCards.purchaserId, users.email).having(sql`count(*) >= 2`);
    const blocked = await this.db.execute(sql`select actor_id, action, created_at from audit_logs where action in ('giftcard.velocity_block','giftcard.attempts_locked') and created_at > now() - interval '7 days' order by created_at desc limit 50`);
    return {
      cards: rows.map(({ c, buyer }) => ({ id: c.id, code: mask(c.code), kind: c.kind, status: c.status, initialCents: c.initialCents, balanceCents: c.balanceCents, buyer, recipientEmail: c.recipientEmail, claimed: !!c.ownerId, lockedReason: c.lockedReason, expiresAt: c.expiresAt, createdAt: c.createdAt })),
      velocity: watch,
      blocked: (blocked as unknown as { rows?: unknown[] }).rows ?? (blocked as unknown as unknown[]),
      limits: await this.limits(),
    };
  }

  async detail(user: JwtPayload, id: string) {
    assertCan(user, 'growth.read', 'finance.read', 'support.read');
    const [c] = await this.db.select().from(giftCards).where(eq(giftCards.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    const txns = await this.db.select().from(giftCardTxns).where(eq(giftCardTxns.giftCardId, id)).orderBy(desc(giftCardTxns.createdAt));
    return { ...c, code: mask(c.code), txns };
  }

  /** Lock / unlock (fraud hold), approve a card waiting for review, or void the remaining balance. */
  async act(user: JwtPayload, id: string, action: 'LOCK' | 'UNLOCK' | 'APPROVE' | 'VOID', reason: string) {
    assertCan(user, 'growth.manage', 'support.manage');
    if (action === 'VOID') assertCan(user, 'finance.manage', 'growth.manage');
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(giftCards).where(eq(giftCards.id, id)).for('update').limit(1);
      if (!c) throw new NotFoundException();
      if (c.status === 'VOID') throw new BadRequestException('Gift card is void');
      let patch: Partial<typeof giftCards.$inferInsert> = {};
      if (action === 'LOCK') patch = { status: 'LOCKED', lockedReason: reason };
      if (action === 'UNLOCK') { if (c.status !== 'LOCKED') throw new BadRequestException('Gift card is not locked'); patch = { status: 'ACTIVE', lockedReason: null }; }
      if (action === 'APPROVE') {
        if (c.status !== 'PENDING_REVIEW') throw new BadRequestException('Gift card is not waiting for review');
        if (c.purchaserId === user.sub) throw new ForbiddenException('Someone else must approve your own purchase');
        patch = { status: 'ACTIVE' };
        if (!c.ownerId && c.recipientEmail) await this.outbox.publish('giftcard.delivered', c.id, { email: c.recipientEmail, recipientName: c.recipientName, amountCents: c.initialCents, code: c.code, message: c.message }, tx);
      }
      if (action === 'VOID') {
        patch = { status: 'VOID', balanceCents: 0, lockedReason: reason };
        if (c.balanceCents > 0) {
          await tx.insert(giftCardTxns).values({ giftCardId: c.id, kind: 'VOID', cents: -c.balanceCents, actorId: user.sub, note: reason });
          await this.ledger.post({ currency: c.currency }, [{ account: 'GIFT_CARD_LIABILITY', partyId: 'gift-cards', debitCents: c.balanceCents, memo: `Gift card voided: ${reason}` }, c.kind === 'PROMOTIONAL' ? { account: 'PLATFORM_EXPENSE_PROMOTION', creditCents: c.balanceCents, memo: 'Promotional gift card voided' } : { account: 'PLATFORM_ADJUSTMENTS', creditCents: c.balanceCents, memo: 'Purchased gift card voided' }], tx);
        }
      }
      const [row] = await tx.update(giftCards).set(patch).where(eq(giftCards.id, id)).returning();
      await this.audit.log({ actorId: user.sub, action: `giftcard.${action.toLowerCase()}`, entityType: 'gift_card', entityId: id, before: { status: c.status, balanceCents: c.balanceCents }, after: { status: row.status, balanceCents: row.balanceCents }, reason }, tx);
      return { ...row, code: mask(row.code) };
    });
  }

  /** 20.4-G outstanding gift balances vs the ledger, by kind and status, plus redemptions in the last 30 days. */
  async liability() {
    const byStatus = await this.db.select({ kind: giftCards.kind, status: giftCards.status, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${giftCards.balanceCents}),0)::int` }).from(giftCards).groupBy(giftCards.kind, giftCards.status);
    const led = await this.ledger.accountTotals('GIFT_CARD_LIABILITY');
    const [red] = await this.db.select({ cents: sql<number>`coalesce(-sum(${giftCardTxns.cents}),0)::int` }).from(giftCardTxns).where(and(eq(giftCardTxns.kind, 'REDEEM'), gte(giftCardTxns.createdAt, addDays(new Date(), -30))));
    const outstanding = byStatus.filter((r) => r.status !== 'VOID').reduce((a, r) => a + r.cents, 0);
    return { outstandingCents: outstanding, cards: byStatus.reduce((a, r) => a + r.n, 0), byStatus, ledgerLiabilityCents: led.credits - led.debits, redeemedLast30dCents: red.cents, unclaimedCents: (await this.db.select({ c: sql<number>`coalesce(sum(${giftCards.balanceCents}),0)::int` }).from(giftCards).where(and(sql`${giftCards.ownerId} is null`, eq(giftCards.status, 'ACTIVE'))))[0].c };
  }
}
