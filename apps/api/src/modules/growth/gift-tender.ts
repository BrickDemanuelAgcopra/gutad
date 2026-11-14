import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/db.module';
import { giftCards, giftCardTxns } from '../../db/schema';
import type { LedgerService } from '../../core/ledger.service';

/**
 * 25.9 / 11.6 / 18.3-G — gift balance as a tender. Shared by checkout (redeem), cancellations (restore)
 * and refunds (refund back to the card it came from). Kept free of service dependencies so that
 * payments, orders and finance can all use it without circular injection.
 */

/** Spendable gift balance in a customer's wallet (active, unexpired cards they added). */
export async function giftBalance(tx: DbOrTx, userId: string): Promise<number> {
  const [r] = await tx
    .select({ c: sql<number>`coalesce(sum(${giftCards.balanceCents}),0)::int` })
    .from(giftCards)
    .where(and(eq(giftCards.ownerId, userId), eq(giftCards.status, 'ACTIVE'), or(isNull(giftCards.expiresAt), gt(giftCards.expiresAt, new Date()))));
  return r?.c || 0;
}

/** Spend up to `cents` from the wallet, oldest card first (row-locked). Returns what was applied. */
export async function redeemGift(tx: DbOrTx, userId: string, cents: number, orderId: string): Promise<number> {
  if (cents <= 0) return 0;
  const cards = await tx
    .select()
    .from(giftCards)
    .where(and(eq(giftCards.ownerId, userId), eq(giftCards.status, 'ACTIVE'), gt(giftCards.balanceCents, 0), or(isNull(giftCards.expiresAt), gt(giftCards.expiresAt, new Date()))))
    .orderBy(asc(giftCards.createdAt))
    .for('update');
  let left = cents;
  for (const c of cards) {
    if (left <= 0) break;
    const take = Math.min(c.balanceCents, left);
    await tx.update(giftCards).set({ balanceCents: c.balanceCents - take }).where(eq(giftCards.id, c.id));
    await tx.insert(giftCardTxns).values({ giftCardId: c.id, kind: 'REDEEM', cents: -take, orderId, note: 'Applied to order' });
    left -= take;
  }
  return cents - left;
}

/** Gift money spent on an order and not yet given back, per card (newest spend first). */
export async function giftOutstanding(tx: DbOrTx, orderId: string) {
  const t = await tx.select().from(giftCardTxns).where(and(eq(giftCardTxns.orderId, orderId), inArray(giftCardTxns.kind, ['REDEEM', 'RESTORE', 'REFUND']))).orderBy(desc(giftCardTxns.createdAt));
  const per = new Map<string, number>();
  for (const x of t) per.set(x.giftCardId, (per.get(x.giftCardId) || 0) - x.cents);
  return { total: [...per.values()].reduce((a, v) => a + Math.max(0, v), 0), perCard: [...per.entries()].filter(([, v]) => v > 0) };
}

/**
 * Give gift money back to the cards it came from. `cents` null = everything outstanding.
 * Before capture nothing was posted to the ledger, so `funder` is null. After capture the redemption is part of the
 * capture journal (liability debited), so the give-back credits the liability against whoever bears the refund.
 */
export async function restoreGift(
  tx: DbOrTx,
  ledger: LedgerService,
  input: { orderId: string; cents: number | null; kind: 'RESTORE' | 'REFUND'; actorId?: string | null; note: string; funder?: { account: 'MERCHANT_PAYABLE' | 'PLATFORM_EXPENSE_REFUND'; organizationId?: string | null } | null; currency?: string },
): Promise<number> {
  const out = await giftOutstanding(tx, input.orderId);
  let left = Math.min(input.cents ?? out.total, out.total);
  const want = left;
  for (const [cardId, owed] of out.perCard) {
    if (left <= 0) break;
    const back = Math.min(owed, left);
    await tx.update(giftCards).set({ balanceCents: sql`${giftCards.balanceCents} + ${back}` }).where(eq(giftCards.id, cardId));
    await tx.insert(giftCardTxns).values({ giftCardId: cardId, kind: input.kind, cents: back, orderId: input.orderId, actorId: input.actorId ?? null, note: input.note });
    left -= back;
  }
  const done = want - left;
  if (done > 0 && input.funder) {
    const f = input.funder;
    await ledger.post({ orderId: input.orderId, currency: input.currency || 'USD' }, [
      f.account === 'MERCHANT_PAYABLE' ? { account: 'MERCHANT_PAYABLE', partyId: f.organizationId ?? 'unknown', organizationId: f.organizationId ?? null, debitCents: done, memo: `Refund to gift card: ${input.note}` } : { account: 'PLATFORM_EXPENSE_REFUND', organizationId: f.organizationId ?? null, debitCents: done, memo: `Refund to gift card: ${input.note}` },
      { account: 'GIFT_CARD_LIABILITY', partyId: 'gift-cards', creditCents: done, memo: 'Gift balance returned' },
    ], tx);
  }
  return done;
}
