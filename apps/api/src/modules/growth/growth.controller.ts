import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { assertCan, CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DB, Db } from '../../db/db.module';
import { coupons, locations } from '../../db/schema';
import { GiftCardsService } from './gift-cards.service';
import { GrowthService, type OfferInput } from './growth.service';
import { RewardsService } from './rewards.service';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const OfferDto = z.object({
  name: z.string().min(2).optional(),
  code: z.string().min(3).max(32).optional(),
  automatic: z.boolean().optional(),
  kind: z.enum(['PERCENT', 'FIXED', 'FREE_DELIVERY']),
  value: z.number().int().min(0),
  funder: z.enum(['MERCHANT', 'PLATFORM']).optional(),
  platformSharePct: z.number().int().min(0).max(100).nullable().optional(),
  minSubtotalCents: z.number().int().min(0).optional(),
  maxDiscountCents: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().min(0).optional(),
  locationIds: z.array(z.string().uuid()).optional(),
  channels: z.array(z.string()).optional(),
  segmentId: z.string().uuid().nullable().optional(),
  firstOrderOnly: z.boolean().optional(),
  itemIds: z.array(z.string().uuid()).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  stacking: z.enum(['EXCLUSIVE', 'STACKABLE']).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
const CampaignDto = z.object({ name: z.string(), kind: z.enum(['EMAIL', 'SMS', 'COUPON', 'SPONSORED', 'REFERRAL']), budgetCents: z.number().int().optional(), segmentId: z.string().uuid().optional(), content: z.record(z.unknown()).optional(), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(), funder: z.enum(['MERCHANT', 'PLATFORM']).optional(), holdoutPct: z.number().int().min(0).max(50).optional(), sponsored: z.object({ locationId: z.string().uuid(), bidCents: z.number().int().positive(), keyword: z.string().optional(), city: z.string().optional() }).optional() });
const ChallengeDto = z.object({ id: z.string().uuid().optional(), name: z.string().min(2), description: z.string().optional(), goalOrders: z.number().int().min(1).max(50), windowDays: z.number().int().min(1).max(365), minSubtotalCents: z.number().int().min(0).optional(), locationIds: z.array(z.string().uuid()).optional(), rewardCents: z.number().int().min(1).max(100000), rewardExpiresDays: z.number().int().min(1).max(365).optional(), maxCompletions: z.number().int().min(0).max(100).optional(), startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional(), isActive: z.boolean().optional() });
type ChallengeIn = z.infer<typeof ChallengeDto>;
const at = (s?: string) => (s && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(s) : new Date());

@ApiTags('25 Growth: promotions, rewards, memberships, gift cards')
@Controller()
export class GrowthController {
  constructor(private readonly svc: GrowthService, private readonly rewards: RewardsService, private readonly gifts: GiftCardsService, @Inject(DB) private readonly db: Db) {}

  // ───── customers ─────
  @Public() @Get('public/membership/plans') plans() { return this.svc.plans(); }
  /** 25.1 automatic offers running at a restaurant (what the menu page shows). */
  @Public() @Get('public/locations/:id/offers') async offersAt(@Param('id') id: string) {
    const [l] = await this.db.select().from(locations).where(eq(locations.id, id)).limit(1);
    if (!l) return [];
    const now = new Date();
    const list = await this.db.select().from(coupons).where(and(eq(coupons.automatic, true), eq(coupons.isActive, true), or(isNull(coupons.organizationId), eq(coupons.organizationId, l.organizationId)), or(isNull(coupons.startsAt), lte(coupons.startsAt, now)), or(isNull(coupons.expiresAt), gt(coupons.expiresAt, now))));
    return list.filter((c) => !c.locationIds.length || c.locationIds.includes(id)).filter((c) => !c.segmentId).map((c) => ({ id: c.id, name: c.name, kind: c.kind, value: c.value, minSubtotalCents: c.minSubtotalCents, maxDiscountCents: c.maxDiscountCents, firstOrderOnly: c.firstOrderOnly, daysOfWeek: c.daysOfWeek, startTime: c.startTime, endTime: c.endTime, itemIds: c.itemIds, categoryIds: c.categoryIds, stacking: c.stacking, expiresAt: c.expiresAt, gutadFunded: !c.organizationId }));
  }
  @ApiBearerAuth() @Get('me/loyalty') loyalty(@CurrentUser() u: JwtPayload) { return this.svc.myLoyalty(u.sub); }
  @ApiBearerAuth() @Post('me/membership') enroll(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ planId: z.string().uuid(), paymentMethodId: z.string().optional() }))) b: { planId: string; paymentMethodId?: string }) { return this.svc.enroll(u, b.planId, b.paymentMethodId); }
  @ApiBearerAuth() @Post('me/membership/cancel') cancel(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ immediate: z.boolean().optional() }).optional())) b?: { immediate?: boolean }) { return this.svc.cancelMembership(u, b || {}); }
  @ApiBearerAuth() @Post('me/membership/resume') resume(@CurrentUser() u: JwtPayload) { return this.svc.resumeMembership(u); }
  @ApiBearerAuth() @Post('me/membership/payment-method') card(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ paymentMethodId: z.string().min(3) }))) b: { paymentMethodId: string }) { return this.svc.updateMembershipCard(u, b.paymentMethodId); }
  @ApiBearerAuth() @Get('me/referral') myReferral(@CurrentUser() u: JwtPayload) { return this.rewards.mine(u.sub); }
  @ApiBearerAuth() @Post('me/referral') referral(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ code: z.string().min(4) }))) b: { code: string }) { return this.svc.applyReferral(u.sub, b.code); }
  @ApiBearerAuth() @Get('me/challenges') myChallenges(@CurrentUser() u: JwtPayload) { return this.rewards.myChallenges(u.sub); }
  @ApiBearerAuth() @Get('me/gift-cards') myGifts(@CurrentUser() u: JwtPayload) { return this.gifts.mine(u.sub); }
  @ApiBearerAuth() @Post('me/gift-cards') buyGift(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ amountCents: z.number().int().positive(), recipientEmail: z.string().email().optional(), recipientName: z.string().max(80).optional(), message: z.string().max(300).optional(), paymentMethodId: z.string().optional() }))) b: Parameters<GiftCardsService['purchase']>[1]) { return this.gifts.purchase(u, b); }
  @ApiBearerAuth() @Post('me/gift-cards/claim') claimGift(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ code: z.string().min(4).max(40) }))) b: { code: string }) { return this.gifts.claim(u, b.code); }

  // ───── merchants ─────
  @ApiBearerAuth() @Get('organizations/:id/campaigns') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listCampaigns(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/campaigns') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CampaignDto)) b: z.infer<typeof CampaignDto>) { return this.svc.createCampaign(u, id, b); }
  @ApiBearerAuth() @Post('campaigns/:id/send') send(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.sendCampaign(u, id); }
  @ApiBearerAuth() @Get('campaigns/:id/results') results(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.campaignResults(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/coupons') coupon(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(OfferDto)) b: OfferInput) { return this.svc.createCoupon(u, id, b); }
  @ApiBearerAuth() @Get('organizations/:id/offers') orgOffers(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listOffers(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/offers') orgOffer(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(OfferDto)) b: OfferInput) { return this.svc.saveOffer(u, id, b); }
  @ApiBearerAuth() @Patch('organizations/:id/offers/:offerId') orgOfferEdit(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('offerId') offerId: string, @Body(zod(OfferDto)) b: OfferInput) { return this.svc.saveOffer(u, id, { ...b, id: offerId }); }
  @ApiBearerAuth() @Get('organizations/:id/promotions/report') orgReport(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('days') d?: string) { return this.svc.promotionReport(u, { organizationId: id, days: Number(d) || 30 }); }
  @ApiBearerAuth() @Get('organizations/:id/challenges') orgChallenges(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.rewards.listChallenges(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/challenges') orgChallenge(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ChallengeDto)) b: ChallengeIn) { return this.rewards.upsertChallenge(u, { ...b, organizationId: id }); }

  // ───── admin ─────
  @ApiBearerAuth() @Get('admin/growth/overview') async overview(@CurrentUser() u: JwtPayload) {
    assertCan(u, 'growth.read');
    const [promo, gifts, refs, members] = await Promise.all([this.svc.promotionReport(u, { days: 30 }), this.gifts.liability(), this.rewards.reviewQueue(u), this.svc.membershipsAdmin(u)]);
    const campaigns = (await this.svc.listCampaigns(u, null)).filter((c) => c.status === 'ACTIVE').slice(0, 10);
    return { promotions: { ...promo.totals, top: promo.items.slice(0, 5) }, giftCards: gifts, referrals: { ...refs.stats, queue: refs.items.slice(0, 20) }, memberships: { ...members.stats, pastDue: members.items.filter((m) => m.status === 'PAST_DUE').slice(0, 20) }, campaigns };
  }
  @ApiBearerAuth() @Get('admin/offers') offers(@CurrentUser() u: JwtPayload) { return this.svc.listOffers(u, null); }
  @ApiBearerAuth() @Post('admin/offers') offer(@CurrentUser() u: JwtPayload, @Body(zod(OfferDto.extend({ organizationId: z.string().uuid().nullable().optional() }))) b: OfferInput & { organizationId?: string | null }) { return this.svc.saveOffer(u, b.organizationId ?? null, b); }
  @ApiBearerAuth() @Patch('admin/offers/:id') offerEdit(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(OfferDto.extend({ organizationId: z.string().uuid().nullable().optional() }))) b: OfferInput & { organizationId?: string | null }) { return this.svc.saveOffer(u, b.organizationId ?? null, { ...b, id }); }
  @ApiBearerAuth() @Get('admin/promotions/report') report(@CurrentUser() u: JwtPayload, @Query('days') d?: string, @Query('organizationId') org?: string) { return this.svc.promotionReport(u, { organizationId: org || null, days: Number(d) || 30 }); }
  @ApiBearerAuth() @Get('admin/campaigns') adminCampaigns(@CurrentUser() u: JwtPayload) { return this.svc.listCampaigns(u, null); }
  @ApiBearerAuth() @Post('admin/campaigns') adminCampaign(@CurrentUser() u: JwtPayload, @Body(zod(CampaignDto)) b: z.infer<typeof CampaignDto>) { return this.svc.createCampaign(u, null, b); }
  @ApiBearerAuth() @Get('admin/referrals') referrals(@CurrentUser() u: JwtPayload, @Query('status') s?: string) { return this.rewards.reviewQueue(u, s || 'REVIEW'); }
  @ApiBearerAuth() @Post('admin/referrals/:id/decision') decide(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approve: z.boolean(), note: z.string().min(3) }))) b: { approve: boolean; note: string }) { return this.rewards.decide(u, id, b.approve, b.note); }
  @ApiBearerAuth() @Get('admin/challenges') challenges(@CurrentUser() u: JwtPayload) { return this.rewards.listChallenges(u); }
  @ApiBearerAuth() @Post('admin/challenges') challenge(@CurrentUser() u: JwtPayload, @Body(zod(ChallengeDto)) b: ChallengeIn) { return this.rewards.upsertChallenge(u, { ...b, organizationId: null }); }
  @ApiBearerAuth() @Get('admin/memberships') memberships(@CurrentUser() u: JwtPayload) { return this.svc.membershipsAdmin(u); }
  @ApiBearerAuth() @Post('admin/memberships/:id/retry') retry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.retryMembership(u, id); }
  @ApiBearerAuth() @Get('admin/gift-cards') giftCards(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.gifts.list(u, { status: q.status, search: q.search }); }
  @ApiBearerAuth() @Get('admin/gift-cards/liability') giftLiability(@CurrentUser() u: JwtPayload) { assertCan(u, 'growth.read', 'finance.read'); return this.gifts.liability(); }
  @ApiBearerAuth() @Get('admin/gift-cards/:id') giftCard(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gifts.detail(u, id); }
  @ApiBearerAuth() @Post('admin/gift-cards') issue(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ amountCents: z.number().int().min(100).max(100000), count: z.number().int().min(1).max(100).optional(), recipientEmail: z.string().email().optional(), reason: z.string().min(3), expiresInDays: z.number().int().min(30).optional() }))) b: Parameters<GiftCardsService['issuePromotional']>[1]) { return this.gifts.issuePromotional(u, b); }
  @ApiBearerAuth() @Post('admin/gift-cards/:id/action') giftAct(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ action: z.enum(['LOCK', 'UNLOCK', 'APPROVE', 'VOID']), reason: z.string().min(3) }))) b: { action: 'LOCK' | 'UNLOCK' | 'APPROVE' | 'VOID'; reason: string }) { return this.gifts.act(u, id, b.action, b.reason); }
  @ApiBearerAuth() @Get('admin/customers/:id/rewards') customerRewards(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.rewards.forCustomer(u, id); }
  /** Daily growth jobs on demand: renewals and retries, challenge windows, ended campaigns (`at` only with ALLOW_BILLING_TIME_TRAVEL). */
  @ApiBearerAuth() @Post('admin/jobs/growth') async jobs(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) {
    assertCan(u, 'growth.manage');
    const now = at(b.at);
    return { memberships: await this.svc.renewDue(now), challengeWindows: await this.rewards.expireWindows(now), campaigns: await this.svc.stopExhaustedOrEnded(now) };
  }
}
