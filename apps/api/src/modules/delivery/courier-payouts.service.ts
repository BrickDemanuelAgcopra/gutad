import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { DEFAULT_INSTANT_PAYOUT, DEFAULT_RECON, type InstantPayoutConfig, type ReconConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { deliveryJobs, driverEarnings, drivers, payouts, users } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { SettingsService } from '../../core/settings.service';
import { PaymentsService } from '../payments/payments.service';
import { CourierFraudService } from './courier-fraud.service';

type Driver = typeof drivers.$inferSelect;
const DAY = 86_400_000;
const earningTotal = sql<number>`coalesce(sum(${driverEarnings.baseCents} + ${driverEarnings.distanceCents} + ${driverEarnings.timeCents} + ${driverEarnings.waitingCents} + ${driverEarnings.returnCents} + ${driverEarnings.tipCents} + ${driverEarnings.bonusCents}),0)::int`;

/**
 * Courier R3: instant cash-out of available earnings, automated partner-fee variance postings and the courier
 * ledger integrity check (earnings − payouts = DRIVER_PAYABLE).
 *
 * Instant payouts debit DRIVER_PAYABLE without a payout id and stay unreconciled, so the weekly close
 * (SettlementService.closeDriverPeriod) nets them against the earnings and never pays the same money twice.
 */
@Injectable()
export class CourierPayoutsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly fraud: CourierFraudService,
  ) {}

  instantCfg() { return this.settings.getObject<InstantPayoutConfig>('payouts.instant', DEFAULT_INSTANT_PAYOUT); }
  reconCfg() { return this.settings.getObject<ReconConfig>('delivery.recon', DEFAULT_RECON); }

  /** Not yet in a weekly payout, past the hold period. */
  private async available(driverId: string, tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0] = this.db) {
    const open = await this.ledger.balance('DRIVER_PAYABLE', driverId, { unreconciledOnly: true }, tx);
    const [p] = await tx.select({ s: earningTotal }).from(driverEarnings).where(and(eq(driverEarnings.driverId, driverId), gt(driverEarnings.availableAt, new Date())));
    return Math.max(0, open - p.s);
  }

  private async today(driverId: string, tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0] = this.db) {
    const [r] = await tx.select({ n: sql<number>`count(*)::int`, s: sql<number>`coalesce(sum(${payouts.amountCents} + ${payouts.feeCents}),0)::int` }).from(payouts).where(and(eq(payouts.partyType, 'DRIVER'), eq(payouts.partyId, driverId), eq(payouts.kind, 'INSTANT'), ne(payouts.status, 'FAILED'), gte(payouts.createdAt, new Date(Date.now() - DAY))));
    return { count: r.n, cents: r.s };
  }

  private async blocked(d: Driver, cfg: InstantPayoutConfig, availableCents: number, today: { count: number; cents: number }): Promise<string | null> {
    if (!cfg.enabled) return 'Instant cash-out is not available right now';
    if (!d.payoutAccountId) return 'Add a payout account first';
    if (await this.fraud.holdFor(d.id)) return 'Payouts are paused while we review recent account activity';
    if (!d.firstDeliveryAt || Date.now() - d.firstDeliveryAt.getTime() < cfg.minAccountAgeDays * DAY) return `Cash-out unlocks ${cfg.minAccountAgeDays} days after your first delivery`;
    if (today.count >= cfg.dailyCount) return `You can cash out ${cfg.dailyCount} times a day`;
    if (today.cents >= cfg.dailyMaxCents) return 'You reached today’s cash-out limit';
    if (availableCents < cfg.minCents) return `At least $${(cfg.minCents / 100).toFixed(2)} must be available`;
    return null;
  }

  async instantStatus(d: Driver) {
    const cfg = await this.instantCfg();
    const availableCents = await this.available(d.id);
    const today = await this.today(d.id);
    return {
      enabled: cfg.enabled, availableCents, feeCents: cfg.feeCents, minCents: cfg.minCents,
      remainingToday: { count: Math.max(0, cfg.dailyCount - today.count), cents: Math.max(0, cfg.dailyMaxCents - today.cents) },
      blockedReason: await this.blocked(d, cfg, availableCents, today),
    };
  }

  async cashOut(d: Driver, amountCents?: number) {
    const cfg = await this.instantCfg();
    return this.db.transaction(async (tx) => {
      // one cash-out at a time per courier
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`instant:${d.id}`}))`);
      const availableCents = await this.available(d.id, tx);
      const today = await this.today(d.id, tx);
      const why = await this.blocked(d, cfg, availableCents, today);
      if (why) throw new ConflictException({ message: why, code: 'INSTANT_UNAVAILABLE', reason: why });
      const gross = Math.min(amountCents ?? availableCents, availableCents, cfg.dailyMaxCents - today.cents);
      if (gross < cfg.minCents || gross <= cfg.feeCents) throw new ConflictException({ message: `Cash out at least $${(cfg.minCents / 100).toFixed(2)}`, code: 'INSTANT_UNAVAILABLE', reason: 'BELOW_MIN' });
      const net = gross - cfg.feeCents;
      const now = new Date();
      const [po] = await tx.insert(payouts).values({ partyType: 'DRIVER', partyId: d.id, provider: this.payments.providerName, status: 'SUBMITTED', currency: 'USD', amountCents: net, feeCents: cfg.feeCents, kind: 'INSTANT', periodStart: now, periodEnd: now, submittedAt: now, attempts: 1 }).returning();
      const res = await this.payments.transfer({ accountId: d.payoutAccountId!, amountCents: net, currency: 'USD', idempotencyKey: `instant:${po.id}`, description: 'Gutad instant cash-out' });
      if (res.status === 'failed') {
        const [f] = await tx.update(payouts).set({ status: 'FAILED', failureReason: res.failureReason ?? 'Transfer failed' }).where(eq(payouts.id, po.id)).returning();
        return { id: f.id, amountCents: f.amountCents, feeCents: f.feeCents, status: f.status, failureReason: f.failureReason };
      }
      const [u] = await tx.update(payouts).set({ status: res.status === 'paid' ? 'PAID' : 'SUBMITTED', providerTransferId: res.transferId, paidAt: res.status === 'paid' ? now : null }).where(eq(payouts.id, po.id)).returning();
      await this.ledger.post({ currency: 'USD' }, [
        { account: 'DRIVER_PAYABLE', partyId: d.id, debitCents: gross, memo: `Instant cash-out ${po.id}` },
        { account: 'BANK', creditCents: net, memo: `Instant transfer ${res.transferId}` },
        ...(cfg.feeCents ? [{ account: 'PLATFORM_REVENUE_INSTANT_FEE' as const, creditCents: cfg.feeCents, memo: `Instant cash-out fee ${po.id}` }] : []),
      ], tx);
      await this.audit.log({ actorId: d.userId, action: 'courier.instant_payout', entityType: 'payout', entityId: po.id, after: { gross, net, fee: cfg.feeCents } }, tx);
      return { id: u.id, amountCents: u.amountCents, feeCents: u.feeCents, status: u.status, failureReason: u.failureReason };
    });
  }

  // ───── reconciliation postings ─────

  /**
   * Book partner fee variance once per job: what we owe the partner (actual fee, else the quote for a delivered job,
   * plus any cancellation fee) less what was booked at delivery (the quote). Runs nightly and on demand.
   */
  async runRecon(user?: JwtPayload | null) {
    if (user) assertCan(user, 'finance.manage', 'delivery.manage');
    const jobs = await this.db.select().from(deliveryJobs).where(and(eq(deliveryJobs.fleet, 'PARTNER'), isNull(deliveryJobs.reconciledAt), inArray(deliveryJobs.status, ['DELIVERED', 'CANCELED', 'FAILED', 'RETURNED']), or(isNotNull(deliveryJobs.providerFeeCents), isNotNull(deliveryJobs.providerCancelFeeCents))));
    let posted = 0, varianceCents = 0;
    for (const j of jobs) {
      const booked = j.status === 'DELIVERED' ? j.providerCostCents : 0;
      const owed = (j.providerFeeCents ?? booked) + (j.providerCancelFeeCents ?? 0);
      const v = owed - booked;
      await this.db.transaction(async (tx) => {
        const [mark] = await tx.update(deliveryJobs).set({ reconciledAt: new Date(), reconVarianceCents: v }).where(and(eq(deliveryJobs.id, j.id), isNull(deliveryJobs.reconciledAt))).returning({ id: deliveryJobs.id });
        if (!mark) return;
        if (v !== 0) {
          const amt = Math.abs(v);
          await this.ledger.post({ orderId: j.orderId, currency: 'USD' }, v > 0
            ? [{ account: 'PLATFORM_EXPENSE_DELIVERY_VARIANCE', debitCents: amt, memo: `Partner fee variance job ${j.id}` }, { account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', creditCents: amt, memo: `Fee variance ${j.provider}` }]
            : [{ account: 'PROVIDER_PAYABLE', partyId: 'delivery-provider', debitCents: amt, memo: `Fee variance ${j.provider}` }, { account: 'PLATFORM_EXPENSE_DELIVERY_VARIANCE', creditCents: amt, memo: `Partner fee variance job ${j.id}` }], tx);
        }
        posted++;
        varianceCents += v;
      });
    }
    if (user) await this.audit.log({ actorId: user.sub, action: 'delivery.recon_run', entityType: 'delivery_recon', entityId: 'partner', after: { posted, varianceCents } });
    return { posted, varianceCents, exceptions: (await this.integrity()).length };
  }

  /** Couriers whose earnings − payouts don't equal their DRIVER_PAYABLE balance. */
  async integrity() {
    const e = await this.db.select({ driverId: driverEarnings.driverId, s: earningTotal }).from(driverEarnings).groupBy(driverEarnings.driverId);
    const p = await this.db.select({ partyId: payouts.partyId, s: sql<number>`coalesce(sum(${payouts.amountCents} + ${payouts.feeCents}),0)::int` }).from(payouts).where(and(eq(payouts.partyType, 'DRIVER'), isNotNull(payouts.providerTransferId), ne(payouts.status, 'FAILED'))).groupBy(payouts.partyId);
    const paid = new Map(p.map((x) => [x.partyId, x.s]));
    const out: { driverId: string; name: string; earningsCents: number; payoutsCents: number; ledgerCents: number; diffCents: number }[] = [];
    for (const r of e) {
      const ledger = await this.ledger.balance('DRIVER_PAYABLE', r.driverId);
      const payoutsCents = paid.get(r.driverId) ?? 0;
      const diff = r.s - payoutsCents - ledger;
      if (diff !== 0) out.push({ driverId: r.driverId, name: '', earningsCents: r.s, payoutsCents, ledgerCents: ledger, diffCents: diff });
    }
    if (out.length) {
      const names = new Map((await this.db.select({ id: drivers.id, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(inArray(drivers.id, out.map((x) => x.driverId)))).map((x) => [x.id, x.name]));
      for (const x of out) x.name = names.get(x.driverId) ?? '—';
    }
    return out;
  }

  /** Recent instant payouts for the courier's earnings page. */
  async recentInstant(driverId: string) {
    return this.db.select({ id: payouts.id, amountCents: payouts.amountCents, feeCents: payouts.feeCents, status: payouts.status, failureReason: payouts.failureReason, createdAt: payouts.createdAt, paidAt: payouts.paidAt }).from(payouts).where(and(eq(payouts.partyType, 'DRIVER'), eq(payouts.partyId, driverId), eq(payouts.kind, 'INSTANT'))).orderBy(desc(payouts.createdAt)).limit(20);
  }
}
