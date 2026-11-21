import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DeliveryPolicyService } from './delivery-policy.service';
import { DeliveryService } from './delivery.service';

const MarketDto = z.object({ pay: z.record(z.string(), z.unknown()).optional(), batching: z.record(z.string(), z.unknown()).optional(), reason: z.string().trim().min(3).max(500) });
const ReasonDto = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Courier Release 2: market policies, batching preview, kitchen-ready sync (estimate + courier arrivals),
 * partner reconciliation and connectivity test.
 */
@ApiTags('12/13 Delivery & drivers')
@ApiBearerAuth()
@Controller()
export class DeliveryPolicyController {
  constructor(private readonly policy: DeliveryPolicyService, private readonly delivery: DeliveryService) {}

  @Get('admin/delivery/policies') policies(@CurrentUser() u: JwtPayload) { return this.policy.adminPolicies(u); }
  @Get('admin/delivery/policies/effective') effective(@CurrentUser() u: JwtPayload, @Query('locationId') locationId?: string, @Query('regionId') regionId?: string) { return this.policy.adminEffective(u, { locationId, regionId }); }
  @Put('admin/delivery/policies/markets/:regionId') upsertMarket(@CurrentUser() u: JwtPayload, @Param('regionId', ParseUUIDPipe) regionId: string, @Body(zod(MarketDto)) b: z.infer<typeof MarketDto>) { return this.policy.upsertMarket(u, regionId, b); }
  @Delete('admin/delivery/policies/markets/:regionId') deleteMarket(@CurrentUser() u: JwtPayload, @Param('regionId', ParseUUIDPipe) regionId: string, @Body(zod(ReasonDto)) b: z.infer<typeof ReasonDto>) { return this.policy.deleteMarket(u, regionId, b.reason); }
  @Post('admin/delivery/batching/preview') preview(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ jobId: z.string().uuid(), withJobId: z.string().uuid() }))) b: { jobId: string; withJobId: string }) { return this.policy.previewBatch(u, b.jobId, b.withJobId); }
  @Get('admin/delivery/reconciliation') reconciliation(@CurrentUser() u: JwtPayload, @Query('provider') provider?: string, @Query('from') from?: string, @Query('to') to?: string) { return this.delivery.reconciliation(u, { provider, from, to }); }
  @Post('admin/delivery/providers/:name/test') testProvider(@CurrentUser() u: JwtPayload, @Param('name') name: string, @Body(zod(z.object({ locationId: z.string().uuid().optional() }))) b: { locationId?: string }) { return this.delivery.testProvider(u, name, b.locationId); }

  @Get('locations/:id/courier-arrivals') arrivals(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.delivery.courierArrivals(u, id); }
  @Post('orders/:id/ready-estimate') readyEstimate(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(z.object({ minutes: z.number().int().min(0).max(240) }))) b: { minutes: number }) { return this.delivery.setReadyEstimate(u, id, b.minutes); }
}
