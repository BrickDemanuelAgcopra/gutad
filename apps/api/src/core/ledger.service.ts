import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB, Db, DbOrTx } from '../db/db.module';
import { journalEntries } from '../db/schema';

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
}

/**
 * Double-entry ledger. Every posting is a balanced batch (sum debits == sum credits).
 * Money is never "moved" by editing historical orders — a new posting changes the beneficiary.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async post(ref: PostingRef, lines: JournalLine[], tx: DbOrTx = this.db): Promise<string> {
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
        memo: l.memo ?? null,
        orderId: ref.orderId ?? null,
        reservationId: ref.reservationId ?? null,
        paymentId: ref.paymentId ?? null,
        refundId: ref.refundId ?? null,
        payoutId: ref.payoutId ?? null,
        invoiceId: ref.invoiceId ?? null,
        currency: ref.currency,
      }));
    if (rows.length) await tx.insert(journalEntries).values(rows);
    return batchId;
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
