import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LEDGER_LOCK, type LedgerLockConfig } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../db/db.module';
import { closePeriods, journalEntries } from '../db/schema';
import { SettingsService } from './settings.service';

export type LedgerAccount = (typeof journalEntries.account.enumValues)[number];

export interface JournalLine {
  account: LedgerAccount;
  debitCents?: number;
  creditCents?: number;
  partyId?: string | null;
  organizationId?: string | null;
  locationId?: string | null;
  memo?: string;
}

export interface PostingRef {
  orderId?: string | null;
  reservationId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  payoutId?: string | null;
  invoiceId?: string | null;
  currency: string;
  /**
   * 20.7-L accounting date of the posting (default: now). A date in an open past month back-dates the entries; a date in a
   * closed month is redirected into the current month with a memo naming the original date, or refused
   * (setting `accounting.ledgerLock`).
   */
  effectiveAt?: Date | null;
}

export interface PostingResult { batchId: string; period: string; postedAt: Date; redirectedFrom: string | null }
const periodOf = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Double-entry ledger. Every posting is a balanced batch (sum debits == sum credits).
 * Money is never "moved" by editing historical orders — a new posting changes the beneficiary.
 */
@Injectable()
export class LedgerService {
  private readonly log = new Logger('LedgerService');
  private closedCache: { at: number; periods: Set<string> } | null = null;
  constructor(@Inject(DB) private readonly db: Db, private readonly settings: SettingsService) {}

  /** Closed months (cached 30 s; `invalidateClosedPeriods` after a close or reopen). */
  async closedPeriods(): Promise<Set<string>> {
    if (this.closedCache && Date.now() - this.closedCache.at < 30_000) return this.closedCache.periods;
    const rows = await this.db.select({ period: closePeriods.period }).from(closePeriods).where(eq(closePeriods.status, 'CLOSED'));
    this.closedCache = { at: Date.now(), periods: new Set(rows.map((r) => r.period)) };
    return this.closedCache.periods;
  }

  invalidateClosedPeriods() { this.closedCache = null; }

  async post(ref: PostingRef, lines: JournalLine[], tx: DbOrTx = this.db): Promise<string> {
    return (await this.postDetailed(ref, lines, tx)).batchId;
  }

  /** Like `post`, also saying which month the batch landed in and whether a closed month redirected it. */
  async postDetailed(ref: PostingRef, lines: JournalLine[], tx: DbOrTx = this.db): Promise<PostingResult> {
    const now = new Date();
    const eff = ref.effectiveAt && ref.effectiveAt < now ? ref.effectiveAt : now;
    let postedAt = eff;
    let redirectedFrom: string | null = null;
    let memoSuffix = '';
    const closed = await this.closedPeriods();
    if (closed.has(periodOf(eff))) {
      const cur = periodOf(now);
      const lock = await this.settings.getObject<LedgerLockConfig>('accounting.ledgerLock', DEFAULT_LEDGER_LOCK);
      if (periodOf(eff) === cur) {
        // the current month should never be closed (closeMonth refuses it); keep operations running and say so
        if (ref.effectiveAt) throw new ConflictException({ message: `Period ${cur} is closed; reopen it to post`, code: 'PERIOD_CLOSED', period: cur });
        this.log.warn(`Posting into closed current period ${cur}`);
      } else if (lock.mode === 'reject' || closed.has(cur)) {
        throw new ConflictException({ message: `Period ${periodOf(eff)} is closed; reopen it to post entries dated ${eff.toISOString().slice(0, 10)}`, code: 'PERIOD_CLOSED', period: periodOf(eff) });
      } else {
        redirectedFrom = periodOf(eff);
        postedAt = now;
        memoSuffix = ` [dated ${eff.toISOString().slice(0, 10)}; ${redirectedFrom} closed, posted in ${cur}]`;
      }
    }
    const debits = lines.reduce((a, l) => a + (l.debitCents || 0), 0);
    const credits = lines.reduce((a, l) => a + (l.creditCents || 0), 0);
    if (debits !== credits) {
      throw new BadRequestException(`Unbalanced journal batch: debits ${debits} != credits ${credits}`);
    }
    const batchId = randomUUID();
    const rows = lines
      .filter((l) => (l.debitCents || 0) !== 0 || (l.creditCents || 0) !== 0)
      .map((l) => ({
        batchId,
        account: l.account,
        debitCents: l.debitCents || 0,
        creditCents: l.creditCents || 0,
        partyId: l.partyId ?? null,
        organizationId: l.organizationId ?? null,
        locationId: l.locationId ?? null,
        memo: memoSuffix ? `${l.memo ?? ''}${memoSuffix}`.trim() : l.memo ?? null,
        orderId: ref.orderId ?? null,
        reservationId: ref.reservationId ?? null,
        paymentId: ref.paymentId ?? null,
        refundId: ref.refundId ?? null,
        payoutId: ref.payoutId ?? null,
        invoiceId: ref.invoiceId ?? null,
        currency: ref.currency,
        ...(postedAt !== now ? { createdAt: postedAt } : {}),
      }));
    if (rows.length) await tx.insert(journalEntries).values(rows);
    return { batchId, period: periodOf(postedAt), postedAt, redirectedFrom };
  }

  /** Net balance for an account/party: credits − debits (liabilities such as MERCHANT_PAYABLE grow by credits). */
  async balance(account: LedgerAccount, partyId: string, opts?: { unreconciledOnly?: boolean }, tx: DbOrTx = this.db): Promise<number> {
    const where = opts?.unreconciledOnly
      ? and(eq(journalEntries.account, account), eq(journalEntries.partyId, partyId), isNull(journalEntries.reconciledAt))
      : and(eq(journalEntries.account, account), eq(journalEntries.partyId, partyId));
    const [r] = await tx
      .select({
        credits: sql<number>`coalesce(sum(${journalEntries.creditCents}),0)::int`,
        debits: sql<number>`coalesce(sum(${journalEntries.debitCents}),0)::int`,
      })
      .from(journalEntries)
      .where(where);
    return (r?.credits || 0) - (r?.debits || 0);
  }

  async accountTotals(account: LedgerAccount, tx: DbOrTx = this.db): Promise<{ credits: number; debits: number }> {
    const [r] = await tx
      .select({
        credits: sql<number>`coalesce(sum(${journalEntries.creditCents}),0)::int`,
        debits: sql<number>`coalesce(sum(${journalEntries.debitCents}),0)::int`,
      })
      .from(journalEntries)
      .where(eq(journalEntries.account, account));
    return { credits: r?.credits || 0, debits: r?.debits || 0 };
  }

  /** Verifies that every batch balances; returns offending batch ids (should always be empty). */
  async unbalancedBatches(tx: DbOrTx = this.db): Promise<string[]> {
    const rows = await tx
      .select({ batchId: journalEntries.batchId })
      .from(journalEntries)
      .groupBy(journalEntries.batchId)
      .having(sql`sum(${journalEntries.debitCents}) <> sum(${journalEntries.creditCents})`);
    return rows.map((r) => r.batchId);
  }
}
