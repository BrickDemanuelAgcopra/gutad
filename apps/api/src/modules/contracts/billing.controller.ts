import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { BillingService } from './billing.service';

const ChangeDto = z.object({ planCode: z.string(), signatureName: z.string().min(2).max(120), signatureTitle: z.string().max(120).optional(), agreementVersion: z.string() });
const AddOnDto = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(80),
  description: z.string().max(300).nullable().optional(),
  productLine: z.enum(['ORDERING', 'RESERVATIONS', 'ALL']).optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  perLocation: z.boolean().optional(),
  features: z.record(z.union([z.boolean(), z.number().int().min(0)])).optional(),
  isPublic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const PromotionDto = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(3).max(40),
  name: z.string().min(2).max(80),
  kind: z.enum(['PERCENT_OFF', 'FREE_PERIODS', 'COMMISSION_HOLIDAY']),
  percentOff: z.number().int().min(0).max(100).optional(),
  periods: z.number().int().min(1).max(36).optional(),
  days: z.number().int().min(0).max(730).optional(),
  planCodes: z.array(z.string()).optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  newMerchantsOnly: z.boolean().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});
const MigrateDto = z.object({ effectiveFrom: z.coerce.date(), includeLegacy: z.boolean().optional(), includeOverridden: z.boolean().optional(), dryRun: z.boolean().optional() });

@ApiTags('25 Contracts & monetization')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  // merchant self-serve
  @Get('organizations/:id/billing') overview(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.overview(u, id); }
  @Get('organizations/:id/plan-change/preview') preview(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('plan') plan: string) { return this.svc.preview(u, id, plan); }
  @Post('organizations/:id/plan-change') change(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ChangeDto)) b: z.infer<typeof ChangeDto>, @Req() req: Request) {
    return this.svc.change(u, id, b, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }
  @Delete('organizations/:id/plan-change') cancelChange(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.cancelScheduled(u, id); }
  @Post('organizations/:id/promotions') redeem(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ code: z.string().min(2).max(40) }))) b: { code: string }) { return this.svc.redeem(u, id, b.code); }
  @Post('organizations/:id/add-ons') buy(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ addOnId: z.string().uuid(), quantity: z.number().int().min(1).max(50).optional() }))) b: { addOnId: string; quantity?: number }) { return this.svc.buyAddOn(u, id, b.addOnId, b.quantity); }
  @Delete('organizations/:id/add-ons/:aid') cancelAddOn(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('aid') aid: string) { return this.svc.cancelAddOn(u, id, aid); }

  // admin
  @Get('admin/add-ons') addOns(@CurrentUser() u: JwtPayload) { return this.svc.adminAddOns(u); }
  @Post('admin/add-ons') upsertAddOn(@CurrentUser() u: JwtPayload, @Body(zod(AddOnDto)) b: z.infer<typeof AddOnDto>) { return this.svc.upsertAddOn(u, b); }
  @Get('admin/promotions') promotions(@CurrentUser() u: JwtPayload) { return this.svc.adminPromotions(u); }
  @Post('admin/promotions') upsertPromotion(@CurrentUser() u: JwtPayload, @Body(zod(PromotionDto)) b: z.infer<typeof PromotionDto>) { return this.svc.upsertPromotion(u, b); }
  @Get('admin/reports/plans') revenue(@CurrentUser() u: JwtPayload) { return this.svc.revenueReport(u); }
  @Get('admin/subscriptions') subscriptions(@CurrentUser() u: JwtPayload) { return this.svc.adminSubscriptions(u); }
  @Post('admin/subscriptions/:id/pause') pause(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().max(300).optional() }))) b: { reason?: string }) { return this.svc.pause(u, id, true, b.reason); }
  @Post('admin/subscriptions/:id/resume') resume(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.pause(u, id, false); }
  /** Run renewals now (normally daily at 03:00). `asOf` lets tests jump ahead; only honored when ALLOW_BILLING_TIME_TRAVEL=true. */
  @Post('admin/billing/run') runBilling(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ asOf: z.coerce.date().optional() }))) b: { asOf?: Date }) { return this.svc.runRenewals(u, b.asOf); }
  @Post('admin/plan-versions/:id/migrate') migrate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MigrateDto)) b: z.infer<typeof MigrateDto>) { return this.svc.migrate(u, id, b); }
}
