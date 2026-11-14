import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DEFAULT_MEMBERSHIP_DUNNING, type AppliedPromotion, type MembershipDunning, type OfferKind } from '@gutad/shared';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { campaignAssignments, campaigns, coupons, guestProfiles, locations, loyaltyEntries, memberSubscriptions, membershipPlans, menuItems, offerRedemptions, orders, segments, sponsoredPlacements, users } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { NotifyService } from '../../core/notify.service';
import { OutboxService } from '../../core/outbox.service';
import { SettingsService } from '../../core/settings.service';
import { PaymentsService } from '../payments/payments.service';
import { addDays, bps, isWithin, localParts, shortCode } from '../../common/utils';
import { loadConfig } from '../../config/config';
import { RewardsService } from './rewards.service';

type Coupon = typeof coupons.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
const rows = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));
const n = (v: unknown) => Number(v || 0);

export interface PromoEvaluation {
  applied: AppliedPromotion[];
  discountCents: number;
  freeDelivery: boolean;
  platformShareCents: number;
  funder: 'MERCHANT' | 'PLATFORM' | 'SPLIT' | null;
  warnings: string[];
}

export interface OfferInput {
  name?: string;
  code?: string;
  automatic?: boolean;
  kind: OfferKind;
  value: number;
  funder?: 'MERCHANT' | 'PLATFORM';
  platformSharePct?: number | null;
  minSubtotalCents?: number;
  maxDiscountCents?: number | null;
  maxUses?: number | null;
  perUserLimit?: number;
  locationIds?: string[];
  channels?: string[];
  segmentId?: string | null;
  firstOrderOnly?: boolean;
  itemIds?: string[];
  categoryIds?: string[];
  daysOfWeek?: number[];
  startTime?: string | null;
  endTime?: string | null;
  stacking?: 'EXCLUSIVE' | 'STACKABLE';
  priority?: number;
  buyQty?: number | null;
  getQty?: number | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  campaignId?: string | null;
  isActive?: boolean;
}

const POINTS_PER_DOLLAR = 1;
const CENTS_PER_POINT = 1; // 100 points = $1
const MEMBER_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

@Injectable()
export class GrowthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly rewards: RewardsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ───── 25.1–25.3 promotions engine ─────

  /**
   * Every promotion that applies to a cart: automatic (codeless) offers plus the code the customer typed.
   * A typed code always applies (or explains why not). An EXCLUSIVE code stands alone; a STACKABLE one combines
   * with stackable offers. Without a code the customer gets the better of the best exclusive offer and all
   * stackable offers combined. Offers apply in priority order and never exceed the subtotal.
   */
  async evaluatePromotions(ctx: { loc: { id: string; organizationId: string; timezone: string }; channel: string; lines: { menuItemId: string; lineTotalCents: number; quantity?: number }[]; subtotalCents: number; userId?: string | null; code?: string | null; blocked?: boolean; now?: Date; simulate?: boolean }, tx: DbOrTx = this.db): Promise<PromoEvaluation> {
    const now = ctx.now || new Date();
    const warnings: string[] = [];
    let coded: Coupon | null = null;
    if (ctx.code) {
      const [c] = await tx.select().from(coupons).where(and(eq(coupons.code, ctx.code.trim().toUpperCase()), eq(coupons.isActive, true))).limit(1);
      if (!c) throw new BadRequestException('Promo code not found');
      coded = c;
    }
    const autos = ctx.blocked ? [] : await tx.select().from(coupons).where(and(eq(coupons.automatic, true), eq(coupons.isActive, true), or(isNull(coupons.organizationId), eq(coupons.organizationId, ctx.loc.organizationId)), or(isNull(coupons.startsAt), lte(coupons.startsAt, now)), or(isNull(coupons.expiresAt), gt(coupons.expiresAt, now)))).orderBy(desc(coupons.priority)).limit(50);
    const all = [...(coded ? [coded] : []), ...autos.filter((a) => a.id !== coded?.id)];
    const needCats = all.some((c) => c.categoryIds.length);
    const cats = needCats && ctx.lines.length ? new Map((await tx.select({ id: menuItems.id, categoryId: menuItems.categoryId }).from(menuItems).where(inArray(menuItems.id, ctx.lines.map((l) => l.menuItemId)))).map((r) => [r.id, r.categoryId])) : new Map<string, string>();

    const evalOne = async (c: Coupon, isCode: boolean): Promise<{ reason: string } | { promo: AppliedPromotion }> => {
      if (c.startsAt && c.startsAt > now) return { reason: 'Promo not started' };
      if (c.expiresAt && c.expiresAt < now) return { reason: 'Promo expired' };
      if (c.maxUses !== null && c.uses >= c.maxUses) return { reason: 'Promo fully redeemed' };
      if (c.organizationId && c.organizationId !== ctx.loc.organizationId) return { reason: 'Promo not valid at this restaurant' };
      if (c.locationIds.length && !c.locationIds.includes(ctx.loc.id)) return { reason: 'Promo not valid at this restaurant' };
      if (c.channels.length && !c.channels.includes(ctx.channel as never)) return { reason: 'Promo not valid on this channel' };
      if (ctx.subtotalCents < c.minSubtotalCents) return { reason: `Promo requires a subtotal of at least ${c.minSubtotalCents} cents` };
      if (c.daysOfWeek.length || (c.startTime && c.endTime)) {
        const lp = localParts(now, ctx.loc.timezone);
        if (c.daysOfWeek.length && !c.daysOfWeek.includes(lp.dayOfWeek)) return { reason: 'Promo is not valid today' };
        if (c.startTime && c.endTime && !isWithin(lp.hhmm, c.startTime, c.endTime)) return { reason: `Promo is valid ${c.startTime}–${c.endTime}` };
      }
      if ((c.firstOrderOnly || c.segmentId) && !ctx.userId && !ctx.simulate) return { reason: 'Sign in to use this promo' };
      if (ctx.userId && !ctx.simulate) {
        if (c.perUserLimit > 0) {
          const [{ n: used }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, ctx.userId), or(eq(orders.promoCode, c.code), sql`jsonb_exists(coalesce(${orders.priceSnapshot}->'promotionIds','[]'::jsonb), ${c.id})`), sql`${orders.status} not in ('REJECTED','CANCELED')`));
          if (used >= c.perUserLimit) return { reason: 'Promo already used' };
        }
        if (c.firstOrderOnly) {
          const [{ n: prior }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, ctx.userId), sql`${orders.status} not in ('REJECTED','CANCELED')`));
          if (prior > 0) return { reason: 'Promo is for your first order' };
        }
        if (c.segmentId && !(await this.inSegment(c.segmentId, ctx.userId))) return { reason: 'Promo is not available on this account' };
      }
      if (c.campaignId) {
        const [camp] = await tx.select().from(campaigns).where(eq(campaigns.id, c.campaignId)).limit(1);
        if (camp && camp.budgetCents > 0 && camp.spentCents >= camp.budgetCents) return { reason: 'Promotion budget exhausted' };
        if (camp && !['ACTIVE', 'DRAFT'].includes(camp.status)) return { reason: 'Promotion not active' };
        // 25.10 the holdout group never sees automatic offers from the campaign
        if (camp && camp.holdoutPct > 0 && ctx.userId && !ctx.simulate && !isCode && (await this.assign(camp.id, ctx.userId, camp.holdoutPct, tx)) === 'HOLDOUT') return { reason: 'holdout' };
      }
      const scoped = c.itemIds.length || c.categoryIds.length;
      const eligibleLines = scoped ? ctx.lines.filter((l) => c.itemIds.includes(l.menuItemId) || (cats.get(l.menuItemId) && c.categoryIds.includes(cats.get(l.menuItemId)!))) : ctx.lines;
      const base = scoped ? eligibleLines.reduce((a, l) => a + l.lineTotalCents, 0) : ctx.subtotalCents;
      if (scoped && base === 0) return { reason: c.kind === 'FREE_ITEM' ? 'Add the free item to your cart to get it free' : 'Promo applies to items that are not in your cart' };
      let d = c.kind === 'PERCENT' ? bps(base, c.value) : c.kind === 'FIXED' ? Math.min(c.value, base) : 0;
      if (c.kind === 'BOGO') {
        // 25.1-B buy X get Y: units sorted by price, in each block of X+Y the cheapest Y are free
        const buy = Math.max(1, c.buyQty || 1), get = Math.max(1, c.getQty || 1);
        const units = eligibleLines.flatMap((l) => { const q = Math.max(1, l.quantity || 1); return Array.from({ length: q }, () => Math.round(l.lineTotalCents / q)); }).sort((a, b) => b - a);
        for (let i = 0; i + buy + get <= units.length; i += buy + get) d += units.slice(i + buy, i + buy + get).reduce((a, u) => a + u, 0);
        if (!d) return { reason: `Add ${buy + get} qualifying items to get ${get} free` };
      }
      if (c.kind === 'FREE_ITEM') {
        const l = eligibleLines[0];
        d = Math.round(l.lineTotalCents / Math.max(1, l.quantity || 1));
      }
      if (c.maxDiscountCents !== null && c.maxDiscountCents !== undefined) d = Math.min(d, c.maxDiscountCents);
      return { promo: { promotionId: c.id, code: c.automatic && !isCode ? null : c.code, name: c.name || (c.kind === 'BOGO' ? `Buy ${c.buyQty || 1}, get ${c.getQty || 1} free` : c.kind === 'FREE_ITEM' ? 'Free item' : c.automatic ? 'Offer' : `Code ${c.code}`), automatic: c.automatic && !isCode, kind: c.kind as OfferKind, discountCents: d, freeDelivery: c.kind === 'FREE_DELIVERY', funder: c.funder as 'MERCHANT' | 'PLATFORM', platformShareCents: 0, campaignId: c.campaignId } };
    };

    let codePromo: AppliedPromotion | null = null;
    if (coded) {
      const r = await evalOne(coded, true);
      if ('reason' in r) throw new BadRequestException(r.reason);
      codePromo = r.promo;
    }
    const eligible: { c: Coupon; p: AppliedPromotion }[] = [];
    for (const a of autos) {
      if (a.id === coded?.id) continue;
      const r = await evalOne(a, false);
      if ('promo' in r) eligible.push({ c: a, p: r.promo });
    }
    const byPriority = (x: { c: Coupon; p: AppliedPromotion }[]) => [...x].sort((a, b) => b.c.priority - a.c.priority || b.p.discountCents - a.p.discountCents);
    const value = (list: AppliedPromotion[]) => Math.min(ctx.subtotalCents, list.reduce((a, p) => a + p.discountCents, 0));
    let chosen: AppliedPromotion[];
    if (codePromo) {
      if (coded!.stacking === 'EXCLUSIVE') {
        chosen = [codePromo];
        if (eligible.length) warnings.push('Your code replaces automatic offers (it can’t be combined)');
      } else chosen = [codePromo, ...byPriority(eligible.filter((e) => e.c.stacking === 'STACKABLE')).map((e) => e.p)];
    } else {
      const stack = byPriority(eligible.filter((e) => e.c.stacking === 'STACKABLE')).map((e) => e.p);
      const best = byPriority(eligible.filter((e) => e.c.stacking !== 'STACKABLE')).sort((a, b) => b.p.discountCents - a.p.discountCents || b.c.priority - a.c.priority)[0]?.p;
      chosen = best && value([best]) >= value(stack) && (best.discountCents > 0 || !stack.length) ? [best] : stack;
    }
    // apply in order, never beyond the subtotal; split funding per promotion (9.6)
    let left = ctx.subtotalCents;
    const share = new Map((coded ? [coded, ...autos] : autos).map((c) => [c.id, c.platformSharePct]));
    for (const p of chosen) {
      p.discountCents = Math.min(p.discountCents, left);
      left -= p.discountCents;
      const pct = share.get(p.promotionId);
      p.platformShareCents = pct !== null && pct !== undefined && pct > 0 && pct < 100 ? Math.round((p.discountCents * pct) / 100) : p.funder === 'PLATFORM' ? p.discountCents : 0;
    }
    chosen = chosen.filter((p) => p.discountCents > 0 || p.freeDelivery);
    const discountCents = chosen.reduce((a, p) => a + p.discountCents, 0);
    const platformShareCents = chosen.reduce((a, p) => a + p.platformShareCents, 0);
    const funder = !chosen.length ? null : platformShareCents === 0 ? 'MERCHANT' : platformShareCents === discountCents ? 'PLATFORM' : 'SPLIT';
    return { applied: chosen, discountCents, freeDelivery: chosen.some((p) => p.freeDelivery), platformShareCents, funder, warnings };
  }

  private async platformContacts(segmentId: string | null) {
    const { CustomersService } = await import('../customers/customers.service');
    return this.moduleRef.get(CustomersService, { strict: false }).segmentContacts(segmentId);
  }

  private async inSegment(segmentId: string, userId: string) {
    const { CustomersService } = await import('../customers/customers.service');
    return this.moduleRef.get(CustomersService, { strict: false }).inSegment(segmentId, userId);
  }

  /** Called when an order is accepted: counts each use, records who funded it, spends campaign budget. */
  async consumePromotions(o: OrderRow, tx: DbOrTx = this.db) {
    const snap = o.priceSnapshot as { promotions?: AppliedPromotion[]; couponId?: string | null; promotionPlatformShareCents?: number };
    const list = snap.promotions ?? (snap.couponId ? [{ promotionId: snap.couponId, discountCents: o.discountCents, platformShareCents: snap.promotionPlatformShareCents ?? (o.promotionFunder === 'PLATFORM' ? o.discountCents : 0), campaignId: null } as AppliedPromotion] : []);
    for (const p of list) {
      const [ins] = await tx.insert(offerRedemptions).values({ promotionId: p.promotionId, campaignId: p.campaignId, orderId: o.id, userId: o.userId, organizationId: o.organizationId, discountCents: p.discountCents, platformFundedCents: p.platformShareCents, merchantFundedCents: p.discountCents - p.platformShareCents, orderSubtotalCents: o.subtotalCents }).onConflictDoNothing().returning();
      if (ins) await this.consumeCoupon(p.promotionId, p.discountCents, o.totalCents, tx);
    }
  }

  /** Canceled / fully refunded orders drop out of the promotion cost and free the use. */
  async reverseRedemptions(orderId: string, tx: DbOrTx = this.db) {
    const r = await tx.update(offerRedemptions).set({ reversedAt: new Date() }).where(and(eq(offerRedemptions.orderId, orderId), isNull(offerRedemptions.reversedAt))).returning();
    for (const x of r) await tx.update(coupons).set({ uses: sql`greatest(${coupons.uses} - 1, 0)` }).where(eq(coupons.id, x.promotionId));
    return r.length;
  }

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

  /** Create or edit an offer (code or automatic). Merchants fund their own; only platform staff fund or split. */
  async saveOffer(user: JwtPayload, orgId: string | null, input: OfferInput & { id?: string }) {
    if (orgId) assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    else assertCan(user, 'growth.manage');
    if (input.funder === 'PLATFORM' && !isPlatformStaff(user)) throw new ForbiddenException('Only platform staff can fund promotions');
    if (input.platformSharePct && !isPlatformStaff(user)) throw new ForbiddenException('Only platform staff can set a platform funding share');
    if (!orgId && input.funder === 'MERCHANT') throw new BadRequestException('Gutad-wide offers are platform-funded');
    if ((input.startTime && !input.endTime) || (!input.startTime && input.endTime)) throw new BadRequestException('Give both a start and an end time for the daypart');
    if (input.kind === 'PERCENT' && input.value > 10000) throw new BadRequestException('Percent is in basis points (10000 = 100%)');
    if (input.kind === 'FREE_ITEM' && !input.itemIds?.length) throw new BadRequestException('Choose the item that is free');
    if (input.kind === 'BOGO' && (!input.buyQty || !input.getQty)) throw new BadRequestException('Set how many to buy and how many are free');
    let before: Coupon | undefined;
    if (input.id) {
      [before] = await this.db.select().from(coupons).where(eq(coupons.id, input.id)).limit(1);
      if (!before) throw new NotFoundException();
      if ((before.organizationId ?? null) !== orgId) throw new ForbiddenException('Offer belongs to another owner');
    }
    let locationIds = input.locationIds || [];
    if (orgId) {
      const locs = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
      locationIds = locationIds.length ? locationIds.filter((id) => locs.some((l) => l.id === id)) : locs.map((l) => l.id);
    }
    const v = {
      name: input.name ?? before?.name ?? null,
      automatic: input.automatic ?? before?.automatic ?? false,
      kind: input.kind,
      value: input.value,
      funder: input.funder || (orgId ? 'MERCHANT' : 'PLATFORM'),
      platformSharePct: input.platformSharePct ?? null,
      minSubtotalCents: input.minSubtotalCents ?? 0,
      maxDiscountCents: input.maxDiscountCents ?? null,
      maxUses: input.maxUses ?? null,
      perUserLimit: input.perUserLimit ?? (input.automatic ? 0 : 1),
      locationIds,
      channels: (input.channels || []) as never,
      segmentId: input.segmentId ?? null,
      firstOrderOnly: !!input.firstOrderOnly,
      itemIds: input.itemIds || [],
      categoryIds: input.categoryIds || [],
      daysOfWeek: input.daysOfWeek || [],
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      stacking: input.stacking || 'EXCLUSIVE',
      priority: input.priority ?? 0,
      buyQty: input.kind === 'BOGO' ? input.buyQty ?? 1 : null,
      getQty: input.kind === 'BOGO' ? input.getQty ?? 1 : null,
      startsAt: input.startsAt ?? null,
      expiresAt: input.expiresAt ?? null,
      campaignId: input.campaignId ?? null,
      isActive: input.isActive ?? true,
      organizationId: orgId,
    };
    const [row] = before
      ? await this.db.update(coupons).set(v).where(eq(coupons.id, before.id)).returning()
      : await this.db.insert(coupons).values({ ...v, code: (input.code || (v.automatic ? `AUTO-${shortCode(8)}` : shortCode(8))).toUpperCase() }).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: before ? 'promotion.update' : 'promotion.create', entityType: 'promotion', entityId: row.id, before, after: row });
    return row;
  }

  /** Back-compatible coupon creation (merchant growth page, older clients). */
  async createCoupon(user: JwtPayload, orgId: string, input: OfferInput) {
    return this.saveOffer(user, orgId, input);
  }

  async listOffers(user: JwtPayload, orgId: string | null) {
    if (orgId) assertOrgAccess(user, orgId);
    else assertCan(user, 'growth.read');
    const list = await this.db.select().from(coupons).where(orgId ? eq(coupons.organizationId, orgId) : undefined).orderBy(desc(coupons.isActive), desc(coupons.priority), desc(coupons.createdAt)).limit(300);
    const ids = list.map((c) => c.id);
    const cost = ids.length ? await this.db.select({ id: offerRedemptions.promotionId, orders: sql<number>`count(*)::int`, discount: sql<number>`coalesce(sum(${offerRedemptions.discountCents}),0)::int` }).from(offerRedemptions).where(and(inArray(offerRedemptions.promotionId, ids), isNull(offerRedemptions.reversedAt))).groupBy(offerRedemptions.promotionId) : [];
    return list.map((c) => ({ ...c, redemptions: cost.find((x) => x.id === c.id)?.orders || 0, discountCents: cost.find((x) => x.id === c.id)?.discount || 0 }));
  }

  /** 25.4 promotion cost: discount given, who funded it (platform / merchant / split), orders and sales it came with. */
  async promotionReport(user: JwtPayload, opts: { organizationId?: string | null; days?: number }) {
    if (opts.organizationId) assertOrgAccess(user, opts.organizationId);
    else assertCan(user, 'growth.read', 'finance.read');
    const since = addDays(new Date(), -(opts.days || 30));
    const org = opts.organizationId ? sql`and r.organization_id = ${opts.organizationId}` : sql``;
    const per = rows<Record<string, unknown>>(await this.db.execute(sql`
      select c.id, coalesce(c.name, c.code) as name, c.code, c.automatic, c.kind, c.funder, c.platform_share_pct, o.name as merchant,
        count(r.id)::int as orders, coalesce(sum(r.discount_cents),0)::bigint as discount, coalesce(sum(r.platform_funded_cents),0)::bigint as platform,
        coalesce(sum(r.merchant_funded_cents),0)::bigint as merchant_funded, coalesce(sum(r.order_subtotal_cents),0)::bigint as sales,
        count(distinct r.user_id)::int as customers
      from offer_redemptions r join coupons c on c.id = r.promotion_id left join organizations o on o.id = c.organization_id
      where r.reversed_at is null and r.created_at >= ${since.toISOString()} ${org}
      group by c.id, o.name order by discount desc limit 200`));
    const items = per.map((x) => ({ id: x.id, name: x.name, code: x.automatic ? null : x.code, automatic: x.automatic, kind: x.kind, merchant: x.merchant ?? 'Gutad-wide', orders: n(x.orders), customers: n(x.customers), discountCents: n(x.discount), platformFundedCents: n(x.platform), merchantFundedCents: n(x.merchant_funded), salesCents: n(x.sales), costPctOfSales: n(x.sales) ? Math.round((n(x.discount) / n(x.sales)) * 1000) / 10 : null }));
    const [led] = opts.organizationId ? [null] : rows<{ cents: number }>(await this.db.execute(sql`select coalesce(sum(debit_cents - credit_cents),0)::bigint as cents from journal_entries where account = 'PLATFORM_EXPENSE_PROMOTION' and created_at >= ${since.toISOString()}`));
    const sum = (k: keyof (typeof items)[number]) => items.reduce((a, i) => a + Number(i[k] || 0), 0);
    return { days: opts.days || 30, items, totals: { orders: sum('orders'), discountCents: sum('discountCents'), platformFundedCents: sum('platformFundedCents'), merchantFundedCents: sum('merchantFundedCents'), salesCents: sum('salesCents') }, ledgerPromotionExpenseCents: led ? n(led.cents) : null };
  }

  // ───── campaigns (email/sms/sponsored/referral) + 25.10 holdouts ─────

  async createCampaign(user: JwtPayload, orgId: string | null, input: { name: string; kind: 'EMAIL' | 'SMS' | 'COUPON' | 'SPONSORED' | 'REFERRAL'; budgetCents?: number; segmentId?: string; content?: Record<string, unknown>; startsAt?: Date; endsAt?: Date; funder?: 'MERCHANT' | 'PLATFORM'; holdoutPct?: number; sponsored?: { locationId: string; bidCents: number; keyword?: string; city?: string } }) {
    if (orgId) assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    else assertCan(user, 'growth.manage');
    if (orgId && (input.kind === 'SPONSORED' || input.sponsored)) {
      if (input.sponsored?.locationId) await this.entitlements.assertLocation(input.sponsored.locationId, 'ads');
      else await this.entitlements.assertOrg(orgId, 'ads');
    }
    if (!orgId && input.kind === 'SPONSORED') throw new BadRequestException('Sponsored placements belong to a merchant');
    return this.db.transaction(async (tx) => {
      const [camp] = await tx.insert(campaigns).values({ organizationId: orgId, name: input.name, kind: input.kind, budgetCents: input.budgetCents || 0, segmentId: input.segmentId ?? null, content: input.content || {}, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, funder: orgId ? input.funder || 'MERCHANT' : 'PLATFORM', holdoutPct: Math.min(Math.max(input.holdoutPct || 0, 0), 50), status: 'ACTIVE' }).returning();
      if (input.kind === 'SPONSORED' && input.sponsored) {
        await tx.insert(sponsoredPlacements).values({ locationId: input.sponsored.locationId, campaignId: camp.id, bidCents: input.sponsored.bidCents, keyword: input.sponsored.keyword ?? null, city: input.sponsored.city ?? null, startsAt: input.startsAt || new Date(), endsAt: input.endsAt || addDays(new Date(), 30) });
      }
      return camp;
    });
  }

  /** Stable treatment/holdout assignment: a hash of campaign and customer, recorded the first time they are seen. */
  async assign(campaignId: string, userId: string, holdoutPct: number, tx: DbOrTx = this.db): Promise<'TREATMENT' | 'HOLDOUT'> {
    const [a] = await tx.select().from(campaignAssignments).where(and(eq(campaignAssignments.campaignId, campaignId), eq(campaignAssignments.userId, userId))).limit(1);
    if (a) return a.grp as 'TREATMENT' | 'HOLDOUT';
    const bucket = parseInt(createHash('sha256').update(`${campaignId}:${userId}`).digest('hex').slice(0, 8), 16) % 100;
    const grp = bucket < holdoutPct ? 'HOLDOUT' : 'TREATMENT';
    await tx.insert(campaignAssignments).values({ campaignId, userId, grp }).onConflictDoNothing();
    return grp;
  }

  /** Send a consented EMAIL/SMS campaign to a segment. The holdout group is recorded but not messaged. */
  async sendCampaign(user: JwtPayload, campaignId: string) {
    const [camp] = await this.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!camp) throw new NotFoundException();
    if (camp.organizationId) assertOrgAccess(user, camp.organizationId, null, MANAGER_ROLES);
    else assertCan(user, 'growth.manage');
    if (!['EMAIL', 'SMS'].includes(camp.kind)) throw new BadRequestException('Only EMAIL/SMS campaigns can be sent');
    // 25.10-P Gutad-wide messages go to a platform customer segment (marketing consent only)
    const audience: { id: string; userId: string | null; email: string | null; phone: string | null }[] = camp.organizationId
      ? await this.segmentAudience(camp.organizationId, camp.segmentId)
      : (await this.platformContacts(camp.segmentId)).map((u) => ({ id: u.id, userId: u.id, email: u.email, phone: u.phone }));
    let sent = 0, held = 0;
    for (const g of audience) {
      const grp = camp.holdoutPct > 0 && g.userId ? await this.assign(camp.id, g.userId, camp.holdoutPct) : 'TREATMENT';
      if (grp === 'HOLDOUT') { held++; continue; }
      await this.notify.queue({ userId: g.userId, email: g.email, phone: g.phone, template: 'campaign', kind: 'MARKETING', payload: { campaignId, ...(camp.content as object) }, dedupeKey: `campaign:${campaignId}:${g.id}`, channels: camp.kind === 'EMAIL' ? ['EMAIL'] : ['SMS'] });
      sent++;
    }
    await this.db.update(campaigns).set({ sentCount: sql`${campaigns.sentCount} + ${sent}` }).where(eq(campaigns.id, campaignId));
    return { queued: sent, heldOut: held };
  }

  /**
   * 25.10 campaign profitability. Orders by customers in each group after they were assigned, inside the campaign
   * window (at the merchant for merchant campaigns). Incremental = treatment minus what the holdout rate predicts.
   */
  async campaignResults(user: JwtPayload, campaignId: string) {
    const [camp] = await this.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!camp) throw new NotFoundException();
    if (camp.organizationId) assertOrgAccess(user, camp.organizationId);
    else assertCan(user, 'growth.read');
    const start = camp.startsAt || camp.createdAt;
    const end = camp.endsAt && camp.endsAt < new Date() ? camp.endsAt : new Date();
    const org = camp.organizationId ? sql`and o.organization_id = ${camp.organizationId}` : sql``;
    // only a finished campaign is cut off; a running one counts everything so far (no app/DB clock skew)
    const endSql = camp.endsAt && camp.endsAt < new Date() ? sql`and o.created_at <= ${camp.endsAt.toISOString()}` : sql``;
    const g = rows<{ grp: string; users: number; buyers: number; orders: number; revenue: string }>(await this.db.execute(sql`
      select a.grp, count(distinct a.user_id)::int as users, count(distinct o.user_id)::int as buyers, count(o.id)::int as orders, coalesce(sum(o.subtotal_cents - o.discount_cents),0)::bigint as revenue
      from campaign_assignments a left join orders o on o.user_id = a.user_id and o.created_at >= a.created_at and o.created_at >= ${start.toISOString()} ${endSql} and o.status not in ('CANCELED','REJECTED') ${org}
      where a.campaign_id = ${campaignId} group by a.grp`));
    // 25.10-S per-customer spread for a 95% interval on the difference (normal approximation)
    const spread = rows<{ grp: string; n: number; o_mean: number; o_var: number; r_mean: number; r_var: number }>(await this.db.execute(sql`
      select grp, count(*)::int as n, avg(orders)::float as o_mean, coalesce(var_samp(orders),0)::float as o_var, avg(revenue)::float as r_mean, coalesce(var_samp(revenue),0)::float as r_var from (
        select a.grp, a.user_id, count(o.id) as orders, coalesce(sum(o.subtotal_cents - o.discount_cents),0) as revenue
        from campaign_assignments a left join orders o on o.user_id = a.user_id and o.created_at >= a.created_at and o.created_at >= ${start.toISOString()} ${endSql} and o.status not in ('CANCELED','REJECTED') ${org}
        where a.campaign_id = ${campaignId} group by a.grp, a.user_id) x group by grp`));
    const st = spread.find((x) => x.grp === 'TREATMENT'), sh = spread.find((x) => x.grp === 'HOLDOUT');
    const interval = (mean: 'o_mean' | 'r_mean', v: 'o_var' | 'r_var') => {
      if (!st || !sh || st.n < 2 || sh.n < 2) return null;
      const diff = st[mean] - sh[mean];
      const se = Math.sqrt(st[v] / st.n + sh[v] / sh.n);
      return { low: Math.round((diff - 1.96 * se) * st.n), high: Math.round((diff + 1.96 * se) * st.n), significant: diff - 1.96 * se > 0 || diff + 1.96 * se < 0 };
    };
    const t = g.find((x) => x.grp === 'TREATMENT') || { users: 0, buyers: 0, orders: 0, revenue: '0' };
    const h = g.find((x) => x.grp === 'HOLDOUT') || { users: 0, buyers: 0, orders: 0, revenue: '0' };
    const [cost] = await this.db.select({ cents: sql<number>`coalesce(sum(${offerRedemptions.discountCents}),0)::int`, platform: sql<number>`coalesce(sum(${offerRedemptions.platformFundedCents}),0)::int`, orders: sql<number>`count(*)::int` }).from(offerRedemptions).where(and(eq(offerRedemptions.campaignId, campaignId), isNull(offerRedemptions.reversedAt)));
    const margin = (await this.settings.get<number>('growth.contributionMarginBps', 3000)) ?? 3000;
    const rate = (x: { users: number; orders: number }) => (x.users ? x.orders / x.users : 0);
    const revPer = (x: { users: number; revenue: string }) => (x.users ? n(x.revenue) / x.users : 0);
    const incOrders = h.users ? Math.round(t.orders - rate(h) * t.users) : null;
    const incRevenue = h.users ? Math.round(n(t.revenue) - revPer(h) * t.users) : null;
    const incMargin = incRevenue !== null ? bps(incRevenue, margin) : null;
    const promotionCost = cost.cents;
    const profit = incMargin !== null ? incMargin - promotionCost : null;
    return {
      campaign: { id: camp.id, name: camp.name, kind: camp.kind, status: camp.status, holdoutPct: camp.holdoutPct, budgetCents: camp.budgetCents, spentCents: camp.spentCents, startsAt: start, endsAt: camp.endsAt },
      groups: {
        treatment: { users: t.users, buyers: t.buyers, orders: t.orders, revenueCents: n(t.revenue), conversionPct: t.users ? Math.round((t.buyers / t.users) * 1000) / 10 : null, ordersPerUser: Math.round(rate(t) * 100) / 100 },
        holdout: { users: h.users, buyers: h.buyers, orders: h.orders, revenueCents: n(h.revenue), conversionPct: h.users ? Math.round((h.buyers / h.users) * 1000) / 10 : null, ordersPerUser: Math.round(rate(h) * 100) / 100 },
      },
      attributed: { orders: camp.conversions, revenueCents: camp.attributedRevenueCents, redemptions: cost.orders },
      incrementalOrders: incOrders,
      incrementalOrdersRange: interval('o_mean', 'o_var'),
      incrementalRevenueRange: interval('r_mean', 'r_var'),
      incrementalRevenueCents: incRevenue,
      contributionMarginBps: margin,
      incrementalMarginCents: incMargin,
      promotionCostCents: promotionCost,
      platformFundedCents: cost.platform,
      profitCents: profit,
      roi: profit !== null && promotionCost ? Math.round((profit / promotionCost) * 100) / 100 : null,
      note: !camp.holdoutPct ? 'No holdout group: only attributed orders are shown; incremental orders need a holdout.' : h.users < 30 ? 'Small holdout so far: treat the incremental figures as directional.' : null,
    };
  }

  async segmentAudience(orgId: string, segmentId: string | null) {
    const all = await this.db.select().from(guestProfiles).where(eq(guestProfiles.organizationId, orgId));
    if (!segmentId) return all;
    const [seg] = await this.db.select().from(segments).where(eq(segments.id, segmentId)).limit(1);
    if (!seg) return all;
    const r = seg.rules as { minVisits?: number; minSpendCents?: number; lastVisitWithinDays?: number; tags?: string[] };
    return all.filter((g) => (r.minVisits === undefined || g.visitCount + g.orderCount >= r.minVisits) && (r.minSpendCents === undefined || g.lifetimeSpendCents >= r.minSpendCents) && (r.lastVisitWithinDays === undefined || (g.lastVisitAt && g.lastVisitAt > addDays(new Date(), -r.lastVisitWithinDays))) && (!r.tags?.length || r.tags.some((t) => g.tags.includes(t))));
  }

  async listCampaigns(user: JwtPayload, orgId: string | null) {
    if (orgId) assertOrgAccess(user, orgId);
    else assertCan(user, 'growth.read');
    return this.db.select().from(campaigns).where(orgId ? eq(campaigns.organizationId, orgId) : undefined).orderBy(desc(campaigns.createdAt)).limit(200);
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

  /** Completed order (pickup handoff, dine-in or delivered): points, referral qualification, challenge progress. */
  async onOrderCompleted(o: OrderRow, tx: DbOrTx = this.db) {
    if (!o.userId) return;
    await this.earnForOrder(o.userId, o.id, o.subtotalCents - o.discountCents, tx);
    await this.rewards.onOrderCompleted(o, tx);
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
    const membership = await this.currentMembership(userId);
    return { points, valueCents: points * CENTS_PER_POINT, entries, credits, membership };
  }

  applyReferral(newUserId: string, referrerCode: string) {
    return this.rewards.apply(newUserId, referrerCode);
  }

  // ───── 25.7 / 25.8 memberships ─────

  async plans() {
    return this.db.select().from(membershipPlans).where(eq(membershipPlans.isActive, true));
  }

  private dunning() {
    return this.settings.getObject<MembershipDunning>('membership.dunning', DEFAULT_MEMBERSHIP_DUNNING);
  }

  /** Benefits apply while trialing or active, and while past due inside the grace period. */
  async activeMembership(userId: string, tx: DbOrTx = this.db) {
    const now = new Date();
    const [row] = await tx
      .select({ sub: memberSubscriptions, plan: membershipPlans })
      .from(memberSubscriptions)
      .innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId))
      .where(and(eq(memberSubscriptions.userId, userId), or(and(inArray(memberSubscriptions.status, ['ACTIVE', 'TRIALING']), gte(memberSubscriptions.currentPeriodEnd, now)), and(eq(memberSubscriptions.status, 'PAST_DUE'), gte(memberSubscriptions.graceUntil, now)))))
      .orderBy(desc(memberSubscriptions.createdAt))
      .limit(1);
    return row ? { ...row.sub, plan: row.plan, benefits: row.plan.benefits as { freeDeliveryAboveCents?: number; priorityWaitlist?: boolean; creditCentsPerMonth?: number; serviceFeeWaived?: boolean } } : null;
  }

  /** The member's current subscription in any open state (including past due without benefits, for the card update). */
  async currentMembership(userId: string, tx: DbOrTx = this.db) {
    const [row] = await tx.select({ sub: memberSubscriptions, plan: membershipPlans }).from(memberSubscriptions).innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId)).where(and(eq(memberSubscriptions.userId, userId), inArray(memberSubscriptions.status, [...MEMBER_STATUSES, 'SUSPENDED']))).orderBy(desc(memberSubscriptions.createdAt)).limit(1);
    if (!row) return null;
    const active = await this.activeMembership(userId, tx);
    return { ...row.sub, plan: row.plan, benefitsActive: !!active, accessUntil: row.sub.status === 'PAST_DUE' ? row.sub.graceUntil : row.sub.currentPeriodEnd, renews: !row.sub.cancelAtPeriodEnd && ['ACTIVE', 'TRIALING'].includes(row.sub.status) };
  }

  async enroll(user: JwtPayload, planId: string, paymentMethodId?: string) {
    const [plan] = await this.db.select().from(membershipPlans).where(and(eq(membershipPlans.id, planId), eq(membershipPlans.isActive, true))).limit(1);
    if (!plan) throw new NotFoundException('Plan not found');
    const [open] = await this.db.select().from(memberSubscriptions).where(and(eq(memberSubscriptions.userId, user.sub), inArray(memberSubscriptions.status, MEMBER_STATUSES))).limit(1);
    if (open) throw new BadRequestException('Already a member');
    const [prior] = await this.db.select({ id: memberSubscriptions.id }).from(memberSubscriptions).where(eq(memberSubscriptions.userId, user.sub)).limit(1);
    const days = plan.interval === 'YEAR' ? 365 : 30;
    // 25.7 a free trial for first-time members; the card is kept and charged when the trial ends
    if (plan.trialDays > 0 && !prior) {
      if (!paymentMethodId) throw new BadRequestException({ message: 'Add a card to start your free trial; you are charged only if you keep the membership', code: 'CARD_REQUIRED' });
      const end = addDays(new Date(), plan.trialDays);
      const [sub] = await this.db.insert(memberSubscriptions).values({ userId: user.sub, planId, status: 'TRIALING', trialEndsAt: end, currentPeriodEnd: end, paymentMethodId }).returning();
      return { subscription: sub, trial: true, chargesOn: end, paymentId: null };
    }
    return this.db.transaction(async (tx) => {
      const p = await this.payments.chargeNow({ purpose: 'MEMBERSHIP', referenceId: planId, userId: user.sub, amountCents: plan.priceCents, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, paymentMethodId, idempotencyKey: `member:${user.sub}:${Date.now()}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: plan.priceCents }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: plan.priceCents, memo: plan.name }] }, tx);
      const [sub] = await tx.insert(memberSubscriptions).values({ userId: user.sub, planId, currentPeriodEnd: addDays(new Date(), days), paymentMethodId: paymentMethodId ?? null }).returning();
      const b = plan.benefits as { creditCentsPerMonth?: number };
      if (b.creditCentsPerMonth) await this.payments.issueCredit({ userId: user.sub, cents: b.creditCentsPerMonth, reason: 'Membership monthly credit', expiresInDays: 30 }, tx);
      return { subscription: sub, trial: false, paymentId: p.id };
    });
  }

  /** 25.7 cancel at the end of the paid period (benefits continue until then); `immediate` ends it now. */
  async cancelMembership(user: JwtPayload, opts: { immediate?: boolean } = {}) {
    const m = await this.currentMembership(user.sub);
    if (!m || m.status === 'SUSPENDED') throw new NotFoundException('No active membership');
    if (opts.immediate || m.status === 'PAST_DUE') {
      await this.db.update(memberSubscriptions).set({ status: 'CANCELED', canceledAt: new Date(), cancelAtPeriodEnd: false, nextRetryAt: null }).where(eq(memberSubscriptions.id, m.id));
      return { ok: true, status: 'CANCELED', accessUntil: null };
    }
    await this.db.update(memberSubscriptions).set({ cancelAtPeriodEnd: true, canceledAt: new Date() }).where(eq(memberSubscriptions.id, m.id));
    return { ok: true, status: m.status, cancelAtPeriodEnd: true, accessUntil: m.currentPeriodEnd };
  }

  async resumeMembership(user: JwtPayload) {
    const m = await this.currentMembership(user.sub);
    if (!m || !m.cancelAtPeriodEnd) throw new BadRequestException('Nothing to resume');
    if (m.currentPeriodEnd < new Date()) throw new BadRequestException('This membership already ended; join again');
    await this.db.update(memberSubscriptions).set({ cancelAtPeriodEnd: false, canceledAt: null }).where(eq(memberSubscriptions.id, m.id));
    return { ok: true, renewsOn: m.currentPeriodEnd };
  }

  /**
   * 25.7-P switch plans. Moving to a more expensive plan happens now: the unused part of the current period is credited
   * against the new price and a new period starts. Moving to a cheaper plan is scheduled for the next renewal.
   * On a free trial the plan simply changes (the trial end stays).
   */
  async switchPlan(user: JwtPayload, planId: string) {
    const m = await this.currentMembership(user.sub);
    if (!m || !['ACTIVE', 'TRIALING'].includes(m.status)) throw new BadRequestException('Switching needs an active membership');
    if (m.planId === planId) {
      if (m.pendingPlanId) { await this.db.update(memberSubscriptions).set({ pendingPlanId: null }).where(eq(memberSubscriptions.id, m.id)); return { mode: 'UNCHANGED', note: 'Scheduled change removed' }; }
      throw new BadRequestException('You are already on this plan');
    }
    const [next] = await this.db.select().from(membershipPlans).where(and(eq(membershipPlans.id, planId), eq(membershipPlans.isActive, true))).limit(1);
    if (!next) throw new NotFoundException('Plan not found');
    if (m.status === 'TRIALING') {
      await this.db.update(memberSubscriptions).set({ planId, pendingPlanId: null }).where(eq(memberSubscriptions.id, m.id));
      return { mode: 'NOW', chargedCents: 0, creditCents: 0, note: `Your trial continues on ${next.name}` };
    }
    const curDays = m.plan.interval === 'YEAR' ? 365 : 30;
    const nextDays = next.interval === 'YEAR' ? 365 : 30;
    if (next.priceCents < m.plan.priceCents) {
      await this.db.update(memberSubscriptions).set({ pendingPlanId: planId, cancelAtPeriodEnd: false }).where(eq(memberSubscriptions.id, m.id));
      await this.audit.log({ actorId: user.sub, action: 'membership.downgrade_scheduled', entityType: 'member_subscription', entityId: m.id, after: { planId, on: m.currentPeriodEnd } });
      return { mode: 'AT_RENEWAL', on: m.currentPeriodEnd, note: `You move to ${next.name} on ${m.currentPeriodEnd.toISOString().slice(0, 10)}` };
    }
    const now = new Date();
    const leftMs = Math.max(0, m.currentPeriodEnd.getTime() - now.getTime());
    const creditCents = Math.min(m.plan.priceCents, Math.round((m.plan.priceCents * leftMs) / (curDays * 86400_000)));
    const charge = Math.max(0, next.priceCents - creditCents);
    return this.db.transaction(async (tx) => {
      let paymentId: string | null = null;
      if (charge > 0) {
        const p = await this.payments.chargeNow({ purpose: 'MEMBERSHIP', referenceId: next.id, userId: user.sub, amountCents: charge, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, paymentMethodId: m.paymentMethodId, offSession: true, idempotencyKey: `switch:${m.id}:${planId}:${now.toISOString().slice(0, 16)}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: charge }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: charge, memo: `${m.plan.name} → ${next.name} (prorated)` }] }, tx);
        paymentId = p.id;
      }
      await tx.update(memberSubscriptions).set({ planId, pendingPlanId: null, currentPeriodEnd: addDays(now, nextDays), cancelAtPeriodEnd: false }).where(eq(memberSubscriptions.id, m.id));
      await this.audit.log({ actorId: user.sub, action: 'membership.upgrade', entityType: 'member_subscription', entityId: m.id, after: { from: m.planId, to: planId, creditCents, chargedCents: charge } }, tx);
      return { mode: 'NOW', chargedCents: charge, creditCents, paymentId, renewsOn: addDays(now, nextDays), note: `You're on ${next.name} now` };
    });
  }

  /** 25.8 update the card on file; a past-due or recently suspended membership is retried right away. */
  async updateMembershipCard(user: JwtPayload, paymentMethodId: string) {
    const m = await this.currentMembership(user.sub);
    if (!m) throw new NotFoundException('No membership');
    await this.db.update(memberSubscriptions).set({ paymentMethodId }).where(eq(memberSubscriptions.id, m.id));
    if (m.status === 'PAST_DUE' || m.status === 'SUSPENDED') {
      const r = await this.chargeRenewal(m.id, new Date(), true);
      if (r.ok) await this.audit.log({ actorId: user.sub, action: 'membership.recovered', entityType: 'member_subscription', entityId: m.id, reason: 'Card updated' });
      return { ok: r.ok, status: r.status, error: r.error ?? null };
    }
    return { ok: true, status: m.status };
  }

  /**
   * Charge one renewal. Success extends the period (from the old end, or from now after a failure) and issues the
   * monthly credit. Failure schedules the next retry with backoff; after the last retry the membership is suspended.
   */
  private async chargeRenewal(subId: string, now: Date, manual = false): Promise<{ ok: boolean; status: string; error?: string }> {
    const [row] = await this.db.select({ sub: memberSubscriptions, plan: membershipPlans, user: users }).from(memberSubscriptions).innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId)).innerJoin(users, eq(users.id, memberSubscriptions.userId)).where(eq(memberSubscriptions.id, subId)).limit(1);
    if (!row) throw new NotFoundException();
    const { sub, user } = row;
    let plan = row.plan;
    if (sub.pendingPlanId) {
      const [next] = await this.db.select().from(membershipPlans).where(eq(membershipPlans.id, sub.pendingPlanId)).limit(1);
      if (next) plan = next;
    }
    const days = plan.interval === 'YEAR' ? 365 : 30;
    if (sub.cancelAtPeriodEnd && !manual) {
      await this.db.update(memberSubscriptions).set({ status: 'CANCELED', nextRetryAt: null }).where(eq(memberSubscriptions.id, sub.id));
      return { ok: true, status: 'CANCELED' };
    }
    try {
      await this.db.transaction(async (tx) => {
        await this.payments.chargeNow({ purpose: 'MEMBERSHIP', referenceId: plan.id, userId: user.id, amountCents: plan.priceCents, currency: loadConfig().DEFAULT_CURRENCY, customerEmail: user.email, paymentMethodId: sub.paymentMethodId, offSession: true, idempotencyKey: `renew:${sub.id}:${sub.currentPeriodEnd.toISOString()}:${sub.renewalFailures}${manual ? `:m${Date.now()}` : ''}`, ledgerLines: [{ account: 'PROCESSOR_CLEARING', debitCents: plan.priceCents }, { account: 'PLATFORM_REVENUE_MEMBERSHIP', creditCents: plan.priceCents, memo: `${plan.name} ${sub.status === 'TRIALING' ? 'first charge after trial' : 'renewal'}` }] }, tx);
        const from = sub.status === 'PAST_DUE' || sub.status === 'SUSPENDED' ? now : sub.currentPeriodEnd;
        await tx.update(memberSubscriptions).set({ status: 'ACTIVE', planId: plan.id, pendingPlanId: null, currentPeriodEnd: addDays(from, days), renewalFailures: 0, nextRetryAt: null, graceUntil: null, lastFailureReason: null }).where(eq(memberSubscriptions.id, sub.id));
        const b = plan.benefits as { creditCentsPerMonth?: number };
        if (b.creditCentsPerMonth) await this.payments.issueCredit({ userId: user.id, cents: b.creditCentsPerMonth, reason: 'Membership monthly credit', expiresInDays: 30 }, tx);
      });
      return { ok: true, status: 'ACTIVE' };
    } catch (e) {
      const d = await this.dunning();
      const failures = sub.renewalFailures + 1;
      const giveUp = failures > d.retryDays.length;
      const firstFailure = sub.status !== 'PAST_DUE';
      await this.db.update(memberSubscriptions).set({ renewalFailures: failures, status: giveUp ? 'SUSPENDED' : 'PAST_DUE', nextRetryAt: giveUp ? null : addDays(now, d.retryDays[failures - 1]), graceUntil: firstFailure ? addDays(now, d.graceDays) : sub.graceUntil, lastFailureReason: (e as Error).message }).where(eq(memberSubscriptions.id, sub.id));
      await this.outbox.publish('membership.renewal_failed', `${sub.id}:${failures}`, { userId: user.id, failures, suspended: giveUp, nextRetryAt: giveUp ? null : addDays(now, d.retryDays[failures - 1]), error: (e as Error).message });
      return { ok: false, status: giveUp ? 'SUSPENDED' : 'PAST_DUE', error: (e as Error).message };
    }
  }

  /** Daily: renew what is due (trials convert), end memberships set to cancel, and retry past-due ones on schedule. */
  async renewDue(now = new Date()) {
    const due = await this.db.select({ id: memberSubscriptions.id }).from(memberSubscriptions).where(or(and(inArray(memberSubscriptions.status, ['ACTIVE', 'TRIALING']), lte(memberSubscriptions.currentPeriodEnd, now)), and(eq(memberSubscriptions.status, 'PAST_DUE'), lte(memberSubscriptions.nextRetryAt, now))));
    let renewed = 0, failed = 0, ended = 0;
    for (const d of due) {
      const r = await this.chargeRenewal(d.id, now);
      if (r.status === 'CANCELED') ended++;
      else if (r.ok) renewed++;
      else failed++;
    }
    return { renewed, failed, ended, total: due.length };
  }

  /** Staff view: trials, scheduled cancellations, past-due memberships with their retry schedule. */
  async membershipsAdmin(user: JwtPayload) {
    assertCan(user, 'growth.read', 'finance.read', 'support.read');
    const list = await this.db.select({ sub: memberSubscriptions, plan: membershipPlans.name, email: users.email, name: users.name }).from(memberSubscriptions).innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId)).innerJoin(users, eq(users.id, memberSubscriptions.userId)).where(or(inArray(memberSubscriptions.status, ['PAST_DUE', 'TRIALING', 'SUSPENDED']), eq(memberSubscriptions.cancelAtPeriodEnd, true))).orderBy(desc(memberSubscriptions.createdAt)).limit(200);
    const [stats] = rows<Record<string, number>>(await this.db.execute(sql`select count(*) filter (where status='ACTIVE')::int as active, count(*) filter (where status='TRIALING')::int as trialing, count(*) filter (where status='PAST_DUE')::int as past_due, count(*) filter (where status='SUSPENDED')::int as suspended, count(*) filter (where cancel_at_period_end and status in ('ACTIVE','TRIALING'))::int as canceling, count(*) filter (where status='ACTIVE' and renewal_failures = 0 and created_at < now() - interval '30 days')::int as retained from member_subscriptions`));
    const recovered = rows<{ n: number }>(await this.db.execute(sql`select count(*)::int as n from audit_logs where action = 'membership.recovered' and created_at > now() - interval '30 days'`));
    return { stats: { ...stats, recovered30d: recovered[0]?.n || 0 }, items: list.map((x) => ({ ...x.sub, plan: x.plan, email: x.email, name: x.name })), dunning: await this.dunning() };
  }

  async retryMembership(user: JwtPayload, subId: string) {
    assertCan(user, 'growth.manage', 'support.manage');
    const r = await this.chargeRenewal(subId, new Date(), true);
    if (r.ok) await this.audit.log({ actorId: user.sub, action: 'membership.recovered', entityType: 'member_subscription', entityId: subId });
    return r;
  }
}
