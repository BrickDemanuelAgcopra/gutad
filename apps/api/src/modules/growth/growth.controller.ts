import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { GrowthService } from './growth.service';

const CouponDto = z.object({ platformSharePct: z.number().int().min(0).max(100).nullable().optional(), code: z.string().optional(), kind: z.enum(['PERCENT', 'FIXED', 'FREE_DELIVERY']), value: z.number().int().min(0), funder: z.enum(['MERCHANT', 'PLATFORM']).optional(), minSubtotalCents: z.number().int().optional(), maxUses: z.number().int().optional(), perUserLimit: z.number().int().optional(), locationIds: z.array(z.string().uuid()).optional(), channels: z.array(z.string()).optional(), startsAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional(), campaignId: z.string().uuid().optional() });
const CampaignDto = z.object({ name: z.string(), kind: z.enum(['EMAIL', 'SMS', 'COUPON', 'SPONSORED', 'REFERRAL']), budgetCents: z.number().int().optional(), segmentId: z.string().uuid().optional(), content: z.record(z.unknown()).optional(), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(), funder: z.enum(['MERCHANT', 'PLATFORM']).optional(), sponsored: z.object({ locationId: z.string().uuid(), bidCents: z.number().int().positive(), keyword: z.string().optional(), city: z.string().optional() }).optional() });

@ApiTags('22 Growth & loyalty')
@Controller()
export class GrowthController {
  constructor(private readonly svc: GrowthService) {}

  @Public() @Get('public/membership/plans') plans() { return this.svc.plans(); }
  @ApiBearerAuth() @Get('me/loyalty') loyalty(@CurrentUser() u: JwtPayload) { return this.svc.myLoyalty(u.sub); }
  @ApiBearerAuth() @Post('me/membership') enroll(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ planId: z.string().uuid(), paymentMethodId: z.string().optional() }))) b: { planId: string; paymentMethodId?: string }) { return this.svc.enroll(u, b.planId, b.paymentMethodId); }
  @ApiBearerAuth() @Post('me/membership/cancel') cancel(@CurrentUser() u: JwtPayload) { return this.svc.cancelMembership(u); }
  @ApiBearerAuth() @Post('me/referral') referral(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ code: z.string() }))) b: { code: string }) { return this.svc.applyReferral(u.sub, b.code); }

  @ApiBearerAuth() @Get('organizations/:id/campaigns') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listCampaigns(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/campaigns') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CampaignDto)) b: z.infer<typeof CampaignDto>) { return this.svc.createCampaign(u, id, b); }
  @ApiBearerAuth() @Post('campaigns/:id/send') send(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.sendCampaign(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/coupons') coupon(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CouponDto)) b: z.infer<typeof CouponDto>) { return this.svc.createCoupon(u, id, b); }
}
