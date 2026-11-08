import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { campaigns, coupons, guestProfiles, locations, loyaltyEntries, memberSubscriptions, membershipPlans, orders, segments, sponsoredPlacements, users } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { LedgerService } from '../../core/ledger.service';
import { NotifyService } from '../../core/notify.service';
import { OutboxService } from '../../core/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { addDays, bps, shortCode } from '../../common/utils';
import { loadConfig } from '../../config/config';

export interface PromoResult {
  discountCents: number;
  freeDelivery: boolean;
  funder: 'MERCHANT' | 'PLATFORM';
  couponId: string;
  campaignId: string | null;
}

const POINTS_PER_DOLLAR = 1;
const CENTS_PER_POINT = 1; // 100 points = $1

@Injectable()
export class GrowthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
  ) {}

  // ───── coupons / promotions ─────

  async validateCoupon(code: string, ctx: { locationId: string; channel: string; subtotalCents: number; userId?: string | null }, tx: DbOrTx = this.db): Promise<PromoResult> {
    const [c] = await tx.select().from(coupons).where(and(eq(coupons.code, code.toUpperCase()), eq(coupons.isActive, true))).limit(1);
    if (!c) throw new BadRequestException('Promo code not found');
    const now = new Date();
    if (c.startsAt && c.startsAt > now) throw new BadRequestException('Promo not started');
    if (c.expiresAt && c.expiresAt < now) throw new BadRequestException('Promo expired');
    if (c.maxUses !== null && c.uses >= c.maxUses) throw new BadRequestException('Promo fully redeemed');
    if (c.locationIds.length && !c.locationIds.includes(ctx.locationId)) throw new BadRequestException('Promo not valid at this restaurant');
    if (c.channels.length && !c.channels.includes(ctx.channel as never)) throw new BadRequestException('Promo not valid on this channel');
    if (ctx.subtotalCents < c.minSubtotalCents) throw new BadRequestException(`Promo requires a subtotal of at least ${c.minSubtotalCents} cents`);
    if (ctx.userId && c.perUserLimit > 0) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, ctx.userId), eq(orders.promoCode, c.code), sql`${orders.status} not in ('REJECTED','CANCELED')`));
      if (n >= c.perUserLimit) throw new BadRequestException('Promo already used');
    }
    if (c.campaignId) {
      const [camp] = await tx.select().from(campaigns).where(eq(campaigns.id, c.campaignId)).limit(1);
      if (camp && camp.budgetCents > 0 && camp.spentCents >= camp.budgetCents) throw new BadRequestException('Promotion budget exhausted');
      if (camp && !['ACTIVE', 'DRAFT'].includes(camp.status)) throw new BadRequestException('Promotion not active');
    }
    const discount = c.kind === 'PERCENT' ? bps(ctx.subtotalCents, c.value) : c.kind === 'FIXED' ? Math.min(c.value, ctx.subtotalCents) : 0;
    return { discountCents: discount, freeDelivery: c.kind === 'FREE_DELIVERY', funder: c.funder as 'MERCHANT' | 'PLATFORM', couponId: c.id, campaignId: c.campaignId };
  }

  /** Called when an order is accepted: counts the use, spends campaign budget, stops at budget. */
  async consumeCoupon(couponId: string, discountCents: number, orderTotalCents: number, tx: DbOrTx = this.db) {
    const [c] = await tx.update(coupons).set({ uses: sql`${coupons.uses} + 1` }).where(eq(coupons.id, couponId)).returning();
    if (c?.campaignId) {
      const [camp] = await tx.update(campaigns).set({ spentCents: sql`${campaigns.spentCents} + ${discountCents}`, conversions: sql`${campaigns.conversions} + 1`, attributedRevenueCents: sql`${campaigns.attributedRevenueCents} + ${orderTotalCents}` }).where(eq(campaigns.id, c.campaignId)).returning();
      if (camp && camp.budgetCents > 0 && camp.spentCents >= camp.budgetCents) {
        await tx.update(campaigns).set({ status: 'EXHAUSTED' }).where(eq(campaigns.id, camp.id));
        await tx.update(coupons).set({ isActive: false }).where(eq(coupons.campaignId, camp.id));
      }
    }
  }

  async createCoupon(user: JwtPayload, orgId: string, input: { code?: string; kind: 'PERCENT' | 'FIXED' | 'FREE_DELIVERY'; value: number; funder?: 'MERCHANT' | 'PLATFORM'; minSubtotalCents?: number; maxUses?: number; perUserLimit?: number; locationIds?: string[]; channels?: string[]; startsAt?: Date; expiresAt?: Date; campaignId?: string }) {
    if (input.funder === 'PLATFORM' && !isPlatformStaff(user)) throw new ForbiddenException('Only platform staff can fund promotions');
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    const locs = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
    const locationIds = input.locationIds?.length ? input.locationIds.filter((id) => locs.some((l) => l.id === id)) : locs.map((l) => l.id);
    const [c] = await this.db.insert(coupons).values({ ...input, code: (input.code || shortCode(8)).toUpperCase(), locationIds, channels: (input.channels || []) as never, funder: input.funder || 'MERCHANT' }).returning();
    return c;
  }

  // ───── campaigns (email/sms/sponsored/referral) ─────

  async createCampaign(user: JwtPayload, orgId: string, input: { name: string; kind: 'EMAIL' | 'SMS' | 'COUPON' | 'SPONSORED' | 'REFERRAL'; budgetCents?: number; segmentId?: string; content?: Record<string, unknown>; startsAt?: Date; endsAt?: Date; funder?: 'MERCHANT' | 'PLATFORM'; sponsored?: { locationId: string; bidCents: number; keyword?: string; city?: string } }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    return this.db.transaction(async (tx) => {
      const [camp] = await tx.insert(campaigns).values({ organizationId: orgId, name: input.name, kind: input.kind, budgetCents: input.budgetCents || 0, segmentId: input.segmentId ?? null, content: input.content || {}, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, funder: input.funder || 'MERCHANT', status: 'ACTIVE' }).returning();
      if (input.kind === 'SPONSORED' && input.sponsored) {
        await tx.insert(sponsoredPlacements).values({ locationId: input.sponsored.locationId, campaignId: camp.id, bidCents: input.sponsored.bidCents, keyword: input.sponsored.keyword ?? null, city: input.sponsored.city ?? null, startsAt: input.startsAt || new Date(), endsAt: input.endsAt || addDays(new Date(), 30) });
      }
      return camp;
    });
  }

  /** Send a consented EMAIL/SMS campaign to a segment. Marketing messages are suppressed per consent in NotifyService. */
  async sendCampaign(user: JwtPayload, campaignId: string) {
    const [camp] = await this.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!camp) throw new NotFoundException();
    assertOrgAccess(user, camp.organizationId, null, MANAGER_ROLES);
    if (!['EMAIL', 'SMS'].includes(camp.kind)) throw new BadRequestException('Only EMAIL/SMS campaigns can be sent');
    const audience = await this.segmentAudience(camp.organizationId, camp.segmentId);
    let sent = 0;
    for (const g of audience) {
      await this.notify.queue({ userId: g.userId, email: g.email, phone: g.phone, template: 'campaign', kind: 'MARKETING', payload: { campaignId, ...(camp.content as object) }, dedupeKey: `campaign:${campaignId}:${g.id}`, channels: camp.kind === 'EMAIL' ? ['EMAIL'] : ['SMS'] });
      sent++;
    }
    await this.db.update(campaigns).set({ sentCount: sql`${campaigns.sentCount} + ${sent}` }).where(eq(campaigns.id, campaignId));
    return { queued: sent };
  }

  async segmentAudience(orgId: string, segmentId: string | null) {
    const all = await this.db.select().from(guestProfiles).where(eq(guestProfiles.organizationId, orgId));
    if (!segmentId) return all;
    const [seg] = await this.db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
    if (!seg) return all;
    const r = seg.rules as { minVisits?: number; minSpendCents?: number; lastVisitWithinDays?: number; tags?: string[] };
    return all.filter((g) => (r.minVisits === undefined || g.visitCount + g.orderCount >= r.minVisits) && (r.minSpendCents === undefined || g.lifetimeSpendCents >= r.minSpendCents) && (r.lastVisitWithinDays === undefined || (g.lastVisitAt && g.lastVisitAt > addDays(new Date(), -r.lastVisitWithinDays))) && (!r.tags?.length || r.tags.some((t) => g.tags.includes(t))));
  }

  async listCampaigns(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(campaigns).where(eq(campaigns.organizationId, orgId)).orderBy(desc(campaigns.createdAt));
  }

  async stopExhaustedOrEnded(now = new Date()) {
    const r = await this.db.update(campaigns).set({ status: 'ENDED' }).where(and(eq(campaigns.status, 'ACTIVE'), lte(campaigns.endsAt, now))).returning({ id: campaigns.id });
    return r.length;
  }

  // ───── loyalty ─────

  async earnForOrder(userId: string, orderId: string, subtotalCents: number, tx: DbOrTx = this.db) {
    const points = Math.floor((subtotalCents / 100) * POINTS_PER_DOLLAR);
    if (points <= 0) return;
    const [existing] = await tx.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.orderId, orderId), eq(loyaltyEntries.kind, 'EARN'))).limit(1);
    if (existing) return; // no duplicate accrual
    await tx.insert(loyaltyEntries).values({ userId, kind: 'EARN', points, cents: points * CENTS_PER_POINT, orderId, expiresAt: addDays(new Date(), 365) });
  }

  async reverseForOrder(orderId: string, tx: DbOrTx = this.db) {
    const rows = await tx.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.orderId, orderId), eq(loyaltyEntries.kind, 'EARN')));
    for (const e of rows) {
      const [rev] = await tx.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.orderId, orderId), eq(loyaltyEntries.kind, 'REVERSE'))).limit(1);
      if (rev) continue;
      await tx.insert(loyaltyEntries).values({ userId: e.userId, kind: 'REVERSE', points: -e.points, cents: -e.cents, orderId });
    }
  }

  async loyaltyBalance(userId: string, tx: DbOrTx = this.db) {
    const [r] = await tx.select({ points: sql<number>`coalesce(sum(${loyaltyEntries.points}),0)::int` }).from(loyaltyEntries).where(and(eq(loyaltyEntries.userId, userId), or(isNull(loyaltyEntries.expiresAt), gt(loyaltyEntries.expiresAt, new Date()))));
    return r?.points || 0;
  }

  async redeemPoints(userId: string, points: number, orderId: string, tx: DbOrTx = this.db): Promise<number> {
    const bal = await this.loyaltyBalance(userId, tx);
    const use = Math.min(points, bal);
    if (use <= 0) return 0;
    await tx.insert(loyaltyEntries).values({ userId, kind: 'REDEEM', points: -use, cents: -use * CENTS_PER_POINT, orderId });
    return use * CENTS_PER_POINT;
  }

  async expirePoints(now = new Date()) {
    const expired = await this.db.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.kind, 'EARN'), lte(loyaltyEntries.expiresAt, now)));
    let n = 0;
    for (const e of expired) {
      const [done] = await this.db.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.orderId, e.orderId!), eq(loyaltyEntries.kind, 'EXPIRE'))).limit(1);
      if (done) continue;
      await this.db.insert(loyaltyEntries).values({ userId: e.userId, kind: 'EXPIRE', points: -e.points, cents: -e.cents, orderId: e.orderId });
      n++;
    }
    return n;
  }

  async myLoyalty(userId: string) {
    const points = await this.loyaltyBalance(userId);
    const entries = await this.db.select().from(loyaltyEntries).where(eq(loyaltyEntries.userId, userId)).orderBy(desc(loyaltyEntries.createdAt)).limit(100);
    const credits = await this.payments.myCredits(userId);
    const membership = await this.activeMembership(userId);
    return { points, valueCents: points * CENTS_PER_POINT, entries, credits, membership };
  }

  /** Referral: both parties get platform-funded credit when the referred user's first order completes. */
  async applyReferral(newUserId: string, referrerCode: string) {
    const [ref] = await this.db.select().from(users).where(sql`left(${users.id}::text, 8) = ${referrerCode.toLowerCase()}`).limit(1);
    if (!ref || ref.id === newUserId) throw new BadRequestException('Invalid referral code');
    await this.db.insert(loyaltyEntries).values({ userId: newUserId, kind: 'REFERRAL', points: 500, cents: 500, expiresAt: addDays(new Date(), 90) });
    await this.db.insert(loyaltyEntries).values({ userId: ref.id, kind: 'REFERRAL', points: 500, cents: 500, expiresAt: addDays(new Date(), 90) });
    return { ok: true };
  }

  // ───── membership ─────

  async plans() {
    return this.db.select().from(membershipPlans).where(eq(membershipPlans.isActive, true));
  }

  async activeMembership(userId: string, tx: DbOrTx = this.db) {
    const [row] = await tx
      .select({ sub: memberSubscriptions, plan: membershipPlans })
      .from(memberSubscriptions)
      .innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId))
      .where(and(eq(memberSubscriptions.userId, userId), eq(memberSubscriptions.status, 'ACTIVE'), gte(memberSubscriptions.currentPeriodEnd, new Date())))
      .limit(1);
    return row ? { ...row.sub, plan: row.plan, benefits: row.plan.benefits as { freeDeliveryAboveCents?: number; priorityWaitlist?: boolean; creditCentsPerMonth?: number; serviceFeeWaived?: boolean } } : null;
  }

  async enroll(user: JwtPayload, planId: string, paymentMethodId?: string) {
    const [plan] = await this.db.select().from(membershipPlans).where(and(eq(membershipPlans.id, planId), eq(membershipPlans.isActive, true))).limit(1);
    if (!plan) throw new NotFoundException('Plan not found');
    const existing = await this.activeMembership(user.sub);
    if (existing) throw new BadRequestException('Already a member');
    return this.db.transaction(async (tx) => {
      const p = await this.payments.chargeNow({ purpose: 'MEMBERSHIP', referenceId: planId, userId: user.sub, amountCents: plan.priceCents, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, paymentMethodId, idempotencyKey: `member:${user.sub}:${Date.now()}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: plan.priceCents }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: plan.priceCents, memo: plan.name }] }, tx);
      const [sub] = await tx.insert(memberSubscriptions).values({ userId: user.sub, planId, currentPeriodEnd: addDays(new Date(), plan.interval === 'YEAR' ? 365 : 30) }).returning();
      const b = plan.benefits as { creditCentsPerMonth?: number };
      if (b.creditCentsPerMonth) await this.payments.issueCredit({ userId: user.sub, cents: b.creditCentsPerMonth, reason: 'Membership monthly credit', expiresInDays: 30 }, tx);
      return { subscription: sub, paymentId: p.id };
    });
  }

  async cancelMembership(user: JwtPayload) {
    const m = await this.activeMembership(user.sub);
    if (!m) throw new NotFoundException('No active membership');
    await this.db.update(memberSubscriptions).set({ status: 'CANCELED', canceledAt: new Date() }).where(eq(memberSubscriptions.id, m.id));
    return { ok: true };
  }

  /** Daily renewal: charge, extend, issue monthly credit; suspend after 3 failures. */
  async renewDue(now = new Date()) {
    const due = await this.db.select({ sub: memberSubscriptions, plan: membershipPlans, user: users }).from(memberSubscriptions).innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId)).innerJoin(users, eq(users.id, memberSubscriptions.userId)).where(and(eq(memberSubscriptions.status, 'ACTIVE'), lte(memberSubscriptions.currentPeriodEnd, now)));
    let ok = 0;
    for (const { sub, plan, user } of due) {
      try {
        await this.db.transaction(async (tx) => {
          await this.payments.chargeNow({ purpose: 'MEMBERSHIP', referenceId: plan.id, userId: user.id, amountCents: plan.priceCents, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, offSession: true, idempotencyKey: `renew:${sub.id}:${sub.currentPeriodEnd.toISOString()}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: plan.priceCents }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: plan.priceCents, memo: `${plan.name} renewal` }] }, tx);
          await tx.update(memberSubscriptions).set({ currentPeriodEnd: addDays(sub.currentPeriodEnd, plan.interval === 'YEAR' ? 365 : 30), renewalFailures: 0 }).where(eq(memberSubscriptions.id, sub.id));
          const b = plan.benefits as { creditCentsPerMonth?: number };
          if (b.creditCentsPerMonth) await this.payments.issueCredit({ userId: user.id, cents: b.creditCentsPerMonth, reason: 'Membership monthly credit', expiresInDays: 30 }, tx);
        });
        ok++;
      } catch (e) {
        const failures = sub.renewalFailures + 1;
        await this.db.update(memberSubscriptions).set({ renewalFailures: failures, status: failures >= 3 ? 'SUSPENDED' : 'PAST_DUE' }).where(eq(memberSubscriptions.id, sub.id));
        await this.outbox.publish('membership.renewal_failed', sub.id, { userId: user.id, failures, error: (e as Error).message });
      }
    }
    return { renewed: ok, total: due.length };
  }
}
