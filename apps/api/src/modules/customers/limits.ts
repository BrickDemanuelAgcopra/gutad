import { BadRequestException } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/db.module';
import { customerRestrictions } from '../../db/schema';

/** 10.8-L per-customer cash and credit limits (restriction kinds with a cap in cents). */
export const LIMIT_KINDS = ['CASH_LIMIT', 'CREDIT_LIMIT'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface ActiveLimit { kind: LimitKind; limitCents: number; periodDays: number | null; reason: string }

export async function activeLimits(db: DbOrTx, userId: string): Promise<ActiveLimit[]> {
  const r = await db
    .select({ kind: customerRestrictions.kind, limitCents: customerRestrictions.limitCents, periodDays: customerRestrictions.periodDays, reason: customerRestrictions.reason })
    .from(customerRestrictions)
    .where(and(eq(customerRestrictions.userId, userId), inArray(customerRestrictions.kind, [...LIMIT_KINDS]), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), gt(customerRestrictions.expiresAt, new Date()))));
  return r.filter((x) => x.limitCents !== null && x.limitCents >= 0).map((x) => ({ kind: x.kind as LimitKind, limitCents: x.limitCents as number, periodDays: x.periodDays, reason: x.reason }));
}

/** Credits redeemed / amount owed on live orders in the last `days` days (canceled and rejected orders do not count). */
async function usedInWindow(db: DbOrTx, userId: string, days: number, what: 'credits' | 'cash', excludeOrderId?: string) {
  const col = what === 'credits' ? sql`coalesce((o.price_snapshot->>'creditsCents')::int, 0)` : sql`o.total_cents`;
  const [r] = rows<{ n: number }>(await db.execute(sql`select coalesce(sum(${col}),0)::int as n from orders o where o.user_id = ${userId} and o.status not in ('CANCELED','REJECTED') and o.created_at > now() - make_interval(days => ${days}) ${excludeOrderId ? sql`and o.id <> ${excludeOrderId}` : sql``}`));
  return Number(r?.n || 0);
}

/** The most credits this customer may still use on one order (Infinity when no limit applies). */
export async function creditAllowance(db: DbOrTx, userId: string): Promise<number> {
  let allow = Number.POSITIVE_INFINITY;
  for (const l of (await activeLimits(db, userId)).filter((x) => x.kind === 'CREDIT_LIMIT')) {
    const left = l.periodDays ? l.limitCents - (await usedInWindow(db, userId, l.periodDays, 'credits')) : l.limitCents;
    allow = Math.min(allow, Math.max(0, left));
  }
  return allow;
}

/**
 * Rejects an order whose remaining charge (what the customer owes after credits, points and gift balance)
 * goes over a CASH_LIMIT, per order or across the rolling window.
 */
export async function assertCashLimit(db: DbOrTx, userId: string, owedCents: number) {
  for (const l of (await activeLimits(db, userId)).filter((x) => x.kind === 'CASH_LIMIT')) {
    const used = l.periodDays ? await usedInWindow(db, userId, l.periodDays, 'cash') : 0;
    if (used + owedCents > l.limitCents) {
      const left = Math.max(0, l.limitCents - used);
      throw new BadRequestException({ message: l.periodDays ? `This account can place up to ${money(l.limitCents)} in orders every ${l.periodDays} days (${money(left)} left).` : `Orders on this account are limited to ${money(l.limitCents)}.`, code: 'CASH_LIMIT', limitCents: l.limitCents, remainingCents: left, periodDays: l.periodDays });
    }
  }
}
