import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { customerCredits, disputes, inboxEvents, legalSellers, locations, orders, payments, payouts, refunds } from '../../db/schema';
import { SettingsService } from '../../core/settings.service';
import { LedgerService } from '../../core/ledger.service';
import { OutboxService } from '../../core/outbox.service';
import { AuditService } from '../../core/audit.service';
import { isPlatformStaff, JwtPayload } from '../../common/auth';
import { ApprovalsService } from '../security/approvals.service';
import { loadConfig } from '../../config/config';
import { PAYMENT_PROVIDER } from './payments.constants';
import type { PaymentProvider, ProviderEvent } from './providers/payment-provider';

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly settings: SettingsService,
  ) {}

  get providerName() {
    return this.provider.name;
  }

  /** Resolve the connected payout account for a location's legal seller (destination charges). */
  async destinationFor(locationId: string, tx: DbOrTx = this.db): Promise<string | null> {
    const [row] = await tx
      .select({ acct: legalSellers.payoutAccountId, state: legalSellers.payoutOnboardingState })
      .from(locations)
      .leftJoin(legalSellers, eq(legalSellers.id, locations.legalSellerId))
      .where(eq(locations.id, locationId))
      .limit(1);
    return row?.state === 'COMPLETE' && row.acct ? row.acct : null;
  }

  /**
   * Authorize (manual capture) for an order. Ledger posting happens at capture.
   * Idempotent on `idempotencyKey` so a retried checkout never creates two holds.
   */
  async authorizeForOrder(
    input: { orderId: string; userId?: string | null; amountCents: number; currency: string; locationId: string; applicationFeeCents: number; customerEmail?: string | null; paymentMethodId?: string | null; idempotencyKey?: string },
    tx: DbOrTx = this.db,
  ) {
    if (input.idempotencyKey) {
      const [existing] = await tx.select().from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return existing;
    }
    const destination = await this.destinationFor(input.locationId, tx);
    const res = await this.provider.createIntent({
      amountCents: input.amountCents,
      currency: input.currency,
      captureMethod: 'manual',
      destinationAccountId: destination,
      applicationFeeCents: destination ? input.applicationFeeCents : 0,
      customerEmail: input.customerEmail,
      paymentMethodId: input.paymentMethodId,
      metadata: { orderId: input.orderId },
      idempotencyKey: input.idempotencyKey,
    });
    const [p] = await tx
      .insert(payments)
      .values({
        orderId: input.orderId,
        userId: input.userId ?? null,
        purpose: 'ORDER',
        provider: this.provider.name,
        providerIntentId: res.providerIntentId,
        providerChargeId: res.chargeId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        status: res.status === 'captured' ? 'CAPTURED' : res.status === 'authorized' ? 'AUTHORIZED' : 'REQUIRES_ACTION',
        currency: input.currency,
        amountCents: input.amountCents,
        authorizedCents: res.authorizedCents,
        capturedCents: res.capturedCents,
        processingFeeCents: res.processingFeeCents,
        applicationFeeCents: destination ? input.applicationFeeCents : 0,
        destinationAccountId: destination,
        clientSecret: res.clientSecret,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    return p;
  }

  /** Immediate charge for deposits, tickets, shipments, memberships, event balances. */
  async chargeNow(
    input: { purpose: string; referenceId: string; userId?: string | null; amountCents: number; currency: string; locationId?: string | null; applicationFeeCents?: number; customerEmail?: string | null; paymentMethodId?: string | null; offSession?: boolean; idempotencyKey?: string; ledgerLines?: Parameters<LedgerService['post']>[1] },
    tx: DbOrTx = this.db,
  ) {
    if (input.idempotencyKey) {
      const [existing] = await tx.select().from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return existing;
    }
    const destination = input.locationId ? await this.destinationFor(input.locationId, tx) : null;
    const res = await this.provider.createIntent({
      amountCents: input.amountCents,
      currency: input.currency,
      captureMethod: 'automatic',
      destinationAccountId: destination,
      applicationFeeCents: destination ? input.applicationFeeCents || 0 : 0,
      customerEmail: input.customerEmail,
      paymentMethodId: input.paymentMethodId,
      offSession: input.offSession,
      metadata: { purpose: input.purpose, referenceId: input.referenceId },
      idempotencyKey: input.idempotencyKey,
    });
    const [p] = await tx
      .insert(payments)
      .values({
        userId: input.userId ?? null,
        purpose: input.purpose,
        referenceId: input.referenceId,
        provider: this.provider.name,
        providerIntentId: res.providerIntentId,
        providerChargeId: res.chargeId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        status: res.status === 'captured' ? 'CAPTURED' : res.status === 'authorized' ? 'AUTHORIZED' : 'REQUIRES_ACTION',
        currency: input.currency,
        amountCents: input.amountCents,
        authorizedCents: res.authorizedCents,
        capturedCents: res.capturedCents,
        processingFeeCents: res.processingFeeCents,
        applicationFeeCents: destination ? input.applicationFeeCents || 0 : 0,
        destinationAccountId: destination,
        clientSecret: res.clientSecret,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    if (p.status === 'CAPTURED' && input.ledgerLines?.length) {
      await this.ledger.post({ paymentId: p.id, currency: p.currency }, input.ledgerLines, tx);
    }
    return p;
  }

  /** Capture an authorized order payment (full or partial) and post the settlement journal. */
  async captureForOrder(orderId: string, amountCents: number | null, tx: DbOrTx = this.db) {
    const [p] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    if (!p) throw new NotFoundException('Payment not found');
    if (p.status === 'CAPTURED' || p.status === 'SETTLED') return p; // idempotent
    if (p.status !== 'AUTHORIZED') throw new BadRequestException(`Payment is ${p.status}, cannot capture`);
    const amount = amountCents ?? p.authorizedCents;
    const res = await this.provider.capture(p.providerIntentId!, amount);
    const [updated] = await tx
      .update(payments)
      .set({ status: 'CAPTURED', capturedCents: res.capturedCents, processingFeeCents: res.processingFeeCents, providerChargeId: res.chargeId ?? p.providerChargeId })
      .where(eq(payments.id, p.id))
      .returning();
    await this.postOrderCapture(updated, tx);
    await this.outbox.publish('payment.captured', orderId, { paymentId: p.id, amountCents: res.capturedCents }, tx);
    return updated;
  }

  /** Settlement journal for an order capture. Beneficiaries follow the order's channel/contract snapshot. */
  private async postOrderCapture(p: typeof payments.$inferSelect, tx: DbOrTx) {
    const [o] = await tx.select().from(orders).where(eq(orders.id, p.orderId!)).limit(1);
    if (!o) return;
    const snap = o.priceSnapshot as { deliveryProviderCostCents?: number; platformDeliverySubsidyCents?: number; promotionFunder?: string | null; promotionPlatformShareCents?: number; taxRemitter?: string };
    const captured = p.capturedCents;
    // scale all components proportionally if a partial capture happened
    const ratio = o.totalCents > 0 ? captured / o.totalCents : 1;
    const r = (c: number) => Math.round(c * ratio);
    const food = r(o.subtotalCents - o.discountCents);
    const tax = r(o.taxCents);
    const tip = r(o.tipCents);
    const serviceFee = r(o.serviceFeeCents);
    const deliveryFee = r(o.deliveryFeeCents);
    const commission = r(o.commissionCents);
    // the platform re-credits the merchant for the part of the discount it funds (all, none, or a split share)
    const merchantDiscountFunded = snap.promotionPlatformShareCents !== undefined ? r(snap.promotionPlatformShareCents) : o.promotionFunder === 'MERCHANT' ? 0 : r(o.discountCents);
    const packagingFee = r(o.packagingFeeCents);
    const smallOrderFee = r(o.smallOrderFeeCents);
    const isDelivery = o.fulfillmentType === 'DELIVERY';
    const driverPayable = isDelivery ? tip : 0;
    const merchantTip = isDelivery ? 0 : tip;
    const merchantPayable = food + tax + merchantTip + packagingFee - commission + merchantDiscountFunded;
    const platformDeliveryRevenue = isDelivery ? deliveryFee : 0;
    const lines: Parameters<LedgerService['post']>[1] = [
      { account: 'PROCESSOR_CLEARING', debitCents: captured, memo: `Capture ${o.number}` },
      { account: 'MERCHANT_PAYABLE', partyId: o.organizationId, organizationId: o.organizationId, locationId: o.locationId, creditCents: merchantPayable, memo: 'Food + tax − commission' },
      { account: 'PLATFORM_REVENUE_COMMISSION', creditCents: commission, organizationId: o.organizationId },
      { account: 'PLATFORM_REVENUE_SERVICE_FEE', creditCents: serviceFee, organizationId: o.organizationId },
      { account: 'PLATFORM_REVENUE_SERVICE_FEE', creditCents: smallOrderFee, organizationId: o.organizationId, memo: 'Small-order fee' },
      { account: 'PLATFORM_REVENUE_DELIVERY', creditCents: platformDeliveryRevenue, organizationId: o.organizationId },
      { account: 'DRIVER_PAYABLE', partyId: `order:${o.id}`, creditCents: driverPayable, memo: 'Courier tip' },
      { account: 'PLATFORM_EXPENSE_PROMOTION', debitCents: merchantDiscountFunded, organizationId: o.organizationId, memo: 'Platform-funded promotion' },
      { account: 'PLATFORM_EXPENSE_PROCESSING', debitCents: p.processingFeeCents, memo: 'Processor fee' },
      { account: 'PROCESSOR_CLEARING', creditCents: p.processingFeeCents, memo: 'Processor fee withheld' },
    ];
    // tips for pickup orders sit inside merchantPayable; make the sum balance explicitly
    const credits = lines.reduce((a, l) => a + (l.creditCents || 0), 0);
    const debits = lines.reduce((a, l) => a + (l.debitCents || 0), 0);
    const diff = debits - credits;
    if (diff !== 0) lines.push({ account: 'PLATFORM_REVENUE_SERVICE_FEE', creditCents: diff > 0 ? diff : 0, debitCents: diff < 0 ? -diff : 0, memo: 'Rounding' });
    await this.ledger.post({ orderId: o.id, paymentId: p.id, currency: p.currency }, lines, tx);
  }

  /** Release an authorization (rejected order / cancellation before capture). */
  async voidForOrder(orderId: string, tx: DbOrTx = this.db) {
    const [p] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    if (!p) return null;
    if (p.status === 'VOIDED') return p;
    if (p.status !== 'AUTHORIZED' && p.status !== 'REQUIRES_ACTION') throw new BadRequestException('Payment already captured; use refund');
    if (p.providerIntentId) await this.provider.cancel(p.providerIntentId);
    const [row] = await tx.update(payments).set({ status: 'VOIDED' }).where(eq(payments.id, p.id)).returning();
    return row;
  }

  /**
   * Refund captured money. `funder` decides which ledger party bears it; the historical order total is never changed.
   * Safe after payout: a merchant-funded refund posts a negative balance that the next payout nets.
   */
  async refund(input: { paymentId: string; amountCents: number; reason: string; funder: 'MERCHANT' | 'PLATFORM' | 'PROVIDER' | 'DRIVER'; approvedById?: string | null; incidentId?: string | null; idempotencyKey?: string }, tx: DbOrTx = this.db) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
    if (!p) throw new NotFoundException('Payment not found');
    if (!['CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED'].includes(p.status)) throw new BadRequestException(`Cannot refund a ${p.status} payment`);
    const remaining = p.capturedCents - p.refundedCents;
    if (input.amountCents <= 0 || input.amountCents > remaining) throw new BadRequestException(`Refund must be between 1 and ${remaining} cents`);
    const res = await this.provider.refund(p.providerIntentId!, input.amountCents, input.reason, input.idempotencyKey);
    const [rf] = await tx
      .insert(refunds)
      .values({ paymentId: p.id, orderId: p.orderId, amountCents: input.amountCents, reason: input.reason, funder: input.funder, providerRefundId: res.providerRefundId, status: res.status === 'succeeded' ? 'SUCCEEDED' : res.status === 'failed' ? 'FAILED' : 'PENDING', approvedById: input.approvedById ?? null, incidentId: input.incidentId ?? null })
      .returning();
    if (res.status === 'failed') return rf;
    const newRefunded = p.refundedCents + input.amountCents;
    await tx.update(payments).set({ refundedCents: newRefunded, status: newRefunded >= p.capturedCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED' }).where(eq(payments.id, p.id));
    let orgId: string | null = null;
    if (p.orderId) {
      const [o] = await tx.select({ organizationId: orders.organizationId }).from(orders).where(eq(orders.id, p.orderId)).limit(1);
      orgId = o?.organizationId ?? null;
    }
    const funderLine =
      input.funder === 'MERCHANT'
        ? { account: 'MERCHANT_PAYABLE' as const, partyId: orgId ?? 'unknown', organizationId: orgId, debitCents: input.amountCents, memo: `Refund ${input.reason}` }
        : input.funder === 'PROVIDER'
          ? { account: 'PROVIDER_PAYABLE' as const, partyId: 'delivery-provider', debitCents: input.amountCents, memo: `Refund ${input.reason}` }
          : input.funder === 'DRIVER'
            ? { account: 'DRIVER_PAYABLE' as const, partyId: `order:${p.orderId}`, debitCents: input.amountCents, memo: `Refund ${input.reason}` }
            : { account: 'PLATFORM_EXPENSE_REFUND' as const, debitCents: input.amountCents, organizationId: orgId, memo: `Refund ${input.reason}` };
    await this.ledger.post({ orderId: p.orderId, paymentId: p.id, refundId: rf.id, currency: p.currency }, [funderLine, { account: 'PROCESSOR_CLEARING', creditCents: input.amountCents, memo: 'Refund to customer' }], tx);
    await this.outbox.publish('payment.refunded', p.orderId || p.referenceId || p.id, { paymentId: p.id, refundId: rf.id, amountCents: input.amountCents }, tx);
    return rf;
  }

  /** Customer credits: platform- or merchant-funded, expiring, redeemable at checkout. */
  async issueCredit(input: { userId: string; cents: number; reason: string; funder?: 'PLATFORM' | 'MERCHANT'; orderId?: string | null; expiresInDays?: number; organizationId?: string | null }, tx: DbOrTx = this.db) {
    const [c] = await tx
      .insert(customerCredits)
      .values({ userId: input.userId, cents: input.cents, reason: input.reason, funder: input.funder || 'PLATFORM', orderId: input.orderId ?? null, expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null })
      .returning();
    await this.ledger.post({ orderId: input.orderId ?? null, currency: loadConfig().DEFAULT_CURRENCY }, [
      input.funder === 'MERCHANT'
        ? { account: 'MERCHANT_PAYABLE', partyId: input.organizationId ?? 'unknown', organizationId: input.organizationId ?? null, debitCents: input.cents, memo: input.reason }
        : { account: 'PLATFORM_EXPENSE_REFUND', debitCents: input.cents, memo: input.reason },
      { account: 'CUSTOMER_CREDIT_LIABILITY', partyId: input.userId, creditCents: input.cents, memo: input.reason },
    ], tx);
    return c;
  }

  async availableCredit(userId: string, tx: DbOrTx = this.db): Promise<number> {
    const rows = await tx
      .select()
      .from(customerCredits)
      .where(and(eq(customerCredits.userId, userId), or(isNull(customerCredits.expiresAt), gt(customerCredits.expiresAt, new Date()))));
    return rows.reduce((a, c) => a + (c.cents - c.redeemedCents), 0);
  }

  /** Redeem credits oldest-first; returns the amount actually applied. */
  async redeemCredit(userId: string, cents: number, orderId: string, tx: DbOrTx = this.db): Promise<number> {
    if (cents <= 0) return 0;
    const rows = await tx
      .select()
      .from(customerCredits)
      .where(and(eq(customerCredits.userId, userId), or(isNull(customerCredits.expiresAt), gt(customerCredits.expiresAt, new Date()))))
      .orderBy(customerCredits.createdAt);
    let remaining = cents;
    for (const c of rows) {
      const avail = c.cents - c.redeemedCents;
      if (avail <= 0) continue;
      const take = Math.min(avail, remaining);
      await tx.update(customerCredits).set({ redeemedCents: c.redeemedCents + take }).where(eq(customerCredits.id, c.id));
      remaining -= take;
      if (remaining === 0) break;
    }
    const applied = cents - remaining;
    if (applied > 0) {
      await this.ledger.post({ orderId, currency: loadConfig().DEFAULT_CURRENCY }, [
        { account: 'CUSTOMER_CREDIT_LIABILITY', partyId: userId, debitCents: applied, memo: 'Credit redeemed' },
        { account: 'PROCESSOR_CLEARING', creditCents: applied, memo: 'Credit applied to order' },
      ], tx);
    }
    return applied;
  }

  /** Reverse credits earned on a refunded order (prevents duplicate accrual). */
  async reverseOrderCredits(orderId: string, tx: DbOrTx = this.db) {
    const rows = await tx.select().from(customerCredits).where(eq(customerCredits.orderId, orderId));
    for (const c of rows) {
      const unredeemed = c.cents - c.redeemedCents;
      if (unredeemed > 0) await tx.update(customerCredits).set({ cents: c.redeemedCents }).where(eq(customerCredits.id, c.id));
    }
  }

  async setupCard(customerEmail: string | null) {
    return this.provider.createSetup(customerEmail);
  }

  /** Merchant payout onboarding (Stripe Express or mock). */
  async onboardLegalSeller(user: JwtPayload, legalSellerId: string, opts?: { approved?: boolean; reason?: string }) {
    const [s] = await this.db.select().from(legalSellers).where(eq(legalSellers.id, legalSellerId)).limit(1);
    if (!s) throw new NotFoundException();
    if (!isPlatformStaff(user) && !user.orgs?.[s.organizationId]) throw new ForbiddenException();
    if (s.payoutAccountId && s.payoutOnboardingState === 'COMPLETE' && !opts?.approved) {
      return this.approvals.submit(user, { kind: 'BANK_ACCOUNT_CHANGE', summary: `Replace the payout account of ${s.legalName}`, organizationId: s.organizationId, subjectType: 'legal_seller', subjectId: s.id, payload: { sellerId: s.id, reconnect: true }, reason: opts?.reason || 'Merchant asked to connect a different payout account', dedupeKey: `bank:${s.id}` });
    }
    const web = loadConfig().PUBLIC_WEB_URL;
    const res = await this.provider.createConnectedAccount({ legalName: s.legalName, email: s.billingContact || user.email, country: s.country, returnUrl: `${web}/merchant/payouts?done=1`, refreshUrl: `${web}/merchant/payouts?refresh=1` });
    const complete = !res.onboardingUrl; // mock completes instantly
    await this.db
      .update(legalSellers)
      .set({ payoutProvider: this.provider.name, payoutAccountId: res.accountId, payoutOnboardingState: complete ? 'COMPLETE' : 'PENDING' })
      .where(eq(legalSellers.id, legalSellerId));
    await this.audit.log({ organizationId: s.organizationId, actorId: user.sub, action: 'seller.payout_onboard', entityType: 'legal_seller', entityId: s.id, after: { accountId: res.accountId } });
    return { accountId: res.accountId, onboardingUrl: res.onboardingUrl, state: complete ? 'COMPLETE' : 'PENDING' };
  }

  async transfer(input: { accountId: string; amountCents: number; currency: string; idempotencyKey: string; description: string }) {
    return this.provider.transfer(input);
  }

  /** Webhook ingestion with a durable inbox: unique per provider/event, processed once, replayable. */
  async ingestWebhook(rawBody: Buffer, signature: string | undefined) {
    const ev = await this.provider.parseWebhook(rawBody, signature);
    if (!ev) throw new BadRequestException('Invalid webhook signature');
    const [inserted] = await this.db
      .insert(inboxEvents)
      .values({ provider: this.provider.name, eventId: ev.id, type: ev.type, payload: ev as unknown as Record<string, unknown> })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return { duplicate: true };
    try {
      await this.applyProviderEvent(ev);
      await this.db.update(inboxEvents).set({ processedAt: new Date() }).where(eq(inboxEvents.id, inserted.id));
    } catch (e) {
      await this.db.update(inboxEvents).set({ error: (e as Error).message }).where(eq(inboxEvents.id, inserted.id));
      this.log.error(`webhook ${ev.id} failed: ${(e as Error).message}`);
    }
    return { ok: true };
  }

  async applyProviderEvent(ev: ProviderEvent) {
    if (ev.providerIntentId) {
      const [p] = await this.db.select().from(payments).where(eq(payments.providerIntentId, ev.providerIntentId)).limit(1);
      if (!p) return;
      if (ev.type === 'payment.captured' && p.status !== 'CAPTURED' && p.status !== 'SETTLED') {
        await this.db.transaction(async (tx) => {
          const [u] = await tx.update(payments).set({ status: 'CAPTURED', capturedCents: ev.amountCents ?? p.amountCents }).where(eq(payments.id, p.id)).returning();
          if (u.orderId) await this.postOrderCapture(u, tx);
        });
      }
      if (ev.type === 'dispute.created') {
        const disputeId = (ev.raw as { data?: { object?: { id?: string } } })?.data?.object?.id ?? ev.id;
        const amount = ev.amountCents ?? p.capturedCents - p.refundedCents;
        const reason = (ev.raw as { reason?: string; data?: { object?: { reason?: string } } })?.data?.object?.reason ?? (ev.raw as { reason?: string })?.reason ?? null;
        const [o] = p.orderId ? await this.db.select({ org: orders.organizationId }).from(orders).where(eq(orders.id, p.orderId)).limit(1) : [null];
        const days = (await this.settings.getObject('finance.controls', { disputeEvidenceDays: 7 })).disputeEvidenceDays;
        await this.db.transaction(async (tx) => {
          await tx.update(payments).set({ status: 'DISPUTED', disputeId, disputeStatus: 'OPEN' }).where(eq(payments.id, p.id));
          const [d] = await tx.insert(disputes).values({ paymentId: p.id, orderId: p.orderId, organizationId: o?.org ?? null, providerDisputeId: disputeId, reason, amountCents: amount, currency: p.currency, evidenceDueAt: new Date(Date.now() + days * 86400_000) }).onConflictDoNothing().returning();
          // 18.7 the processor withdraws the disputed funds until the outcome
          if (d) await this.ledger.post({ paymentId: p.id, orderId: p.orderId, currency: p.currency }, [{ account: 'DISPUTE_RECEIVABLE', debitCents: amount, memo: `Dispute ${disputeId}` }, { account: 'PROCESSOR_CLEARING', creditCents: amount, memo: 'Disputed funds withdrawn' }], tx);
        });
        await this.outbox.publish('payment.disputed', p.orderId || p.id, { paymentId: p.id, amountCents: ev.amountCents });
      }
      if (ev.type === 'dispute.closed') await this.db.update(payments).set({ disputeStatus: 'CLOSED' }).where(eq(payments.id, p.id));
    }
    if (ev.providerTransferId) {
      const [po] = await this.db.select().from(payouts).where(eq(payouts.providerTransferId, ev.providerTransferId)).limit(1);
      if (po) {
        if (ev.type === 'transfer.paid') await this.db.update(payouts).set({ status: 'PAID', paidAt: new Date() }).where(eq(payouts.id, po.id));
        if (ev.type === 'transfer.failed') await this.db.update(payouts).set({ status: 'FAILED', failureReason: 'Provider reported failure' }).where(eq(payouts.id, po.id));
      }
    }
    if (ev.type === 'account.updated' && ev.accountId) {
      const raw = ev.raw as { data?: { object?: { charges_enabled?: boolean; payouts_enabled?: boolean } } };
      const ok = raw?.data?.object?.charges_enabled && raw?.data?.object?.payouts_enabled;
      await this.db.update(legalSellers).set({ payoutOnboardingState: ok ? 'COMPLETE' : 'RESTRICTED' }).where(eq(legalSellers.payoutAccountId, ev.accountId));
    }
  }

  async replayInbox(id: string) {
    const [row] = await this.db.select().from(inboxEvents).where(eq(inboxEvents.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    await this.applyProviderEvent(row.payload as unknown as ProviderEvent);
    await this.db.update(inboxEvents).set({ processedAt: new Date(), error: null }).where(eq(inboxEvents.id, id));
    return { ok: true };
  }

  async listForOrder(orderId: string) {
    const [p] = await this.db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    const rf = p ? await this.db.select().from(refunds).where(eq(refunds.paymentId, p.id)).orderBy(desc(refunds.createdAt)) : [];
    return { payment: p ? { ...p, clientSecret: undefined } : null, refunds: rf };
  }

  async myCredits(userId: string) {
    const rows = await this.db.select().from(customerCredits).where(eq(customerCredits.userId, userId)).orderBy(desc(customerCredits.createdAt));
    const available = await this.availableCredit(userId);
    return { availableCents: available, entries: rows };
  }

  async expireCredits(now = new Date()) {
    const r = await this.db.execute(sql`update customer_credits set redeemed_cents = cents where expires_at < ${now} and redeemed_cents < cents`);
    return r.rowCount || 0;
  }
}
