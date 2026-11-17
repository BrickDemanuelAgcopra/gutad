import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CHEF_QUALITY_ACTIONS, type ChefQualityAction } from '@gutad/shared';
import { assertCan, CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ChefOpsService } from './chef-ops.service';

const ActionDto = z.object({ action: z.enum(CHEF_QUALITY_ACTIONS), note: z.string().trim().min(5).max(2000), dishId: z.string().uuid().nullable().optional() });

/** Gutad Chef Network operations: kitchens and documents, quality, earnings and analytics. */
@ApiTags('40 Chef Network')
@ApiBearerAuth()
@Controller()
export class ChefOpsController {
  constructor(private readonly svc: ChefOpsService) {}

  // chef
  @Get('chef/compliance') compliance(@CurrentUser() u: JwtPayload) { return this.svc.myCompliance(u); }
  @Get('chef/earnings') earnings(@CurrentUser() u: JwtPayload) { return this.svc.myEarnings(u); }

  // Gutad staff
  @Get('admin/chef-kitchens') kitchens(@CurrentUser() u: JwtPayload) { return this.svc.kitchens(u); }
  @Get('admin/chef-quality') quality(@CurrentUser() u: JwtPayload, @Query('days') days?: string) { return this.svc.quality(u, days ? Number(days) : undefined); }
  @Get('admin/chefs/:id/quality') chefQuality(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.chefQuality(u, id); }
  @Post('admin/chefs/:id/quality') qualityAction(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ActionDto)) b: { action: ChefQualityAction; note: string; dishId?: string | null }) { return this.svc.qualityAction(u, id, b); }
  @Get('admin/chefs/:id/earnings') chefEarnings(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.adminEarnings(u, id); }
  @Get('admin/chef-network/analytics') analytics(@CurrentUser() u: JwtPayload, @Query('days') days?: string) { return this.svc.analytics(u, days ? Number(days) || 30 : 30); }
  @Post('admin/jobs/chef-operations') sweep(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) {
    assertCan(u, 'chefs.manage');
    const at = b.at && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(b.at) : new Date();
    return Promise.all([this.svc.documentSweep(at), this.svc.qualitySweep(at)]).then(([documents, quality]) => ({ documents, quality }));
  }
}
