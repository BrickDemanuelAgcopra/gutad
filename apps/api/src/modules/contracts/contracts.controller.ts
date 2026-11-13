import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ContractsService } from './contracts.service';

export const FeeRuleSchema = z.object({
  type: z.enum(['COMMISSION', 'COVER_FEE', 'PREPAID_SERVICE_FEE', 'PROCESSING', 'DELIVERY_SUBSIDY', 'LOGISTICS_FEE']),
  channel: z.enum(['ANY', 'NETWORK', 'MARKETPLACE', 'PARTNER', 'DIRECT', 'WIDGET', 'QR']),
  fulfillment: z.enum(['ANY', 'DELIVERY', 'PICKUP', 'DINE_IN']),
  bps: z.number().int().min(0).max(10_000).default(0),
  cents: z.number().int().min(0).max(1_000_000).default(0),
  capCents: z.number().int().min(0).nullable().optional(),
  label: z.string().max(120).nullable().optional(),
});

const CreateDto = z.object({
  planCode: z.string(),
  locationIds: z.array(z.string().uuid()).default([]),
  overrides: z
    .object({
      subscriptionCents: z.number().int().optional(),
      marketplaceCommissionBps: z.number().int().optional(),
      directCommissionBps: z.number().int().optional(),
      processingBps: z.number().int().optional(),
      processingFixedCents: z.number().int().optional(),
      coverFeeNetworkCents: z.number().int().optional(),
      coverFeeDirectCents: z.number().int().optional(),
      prepaidServiceFeeBps: z.number().int().optional(),
      deliverySubsidyCents: z.number().int().optional(),
      logisticsFeeCents: z.number().int().optional(),
      cancellationRules: z.record(z.unknown()).optional(),
      features: z.record(z.unknown()).optional(),
      regionRules: z.record(z.unknown()).optional(),
      fees: z.array(FeeRuleSchema).optional(),
    })
    .optional(),
  effectiveFrom: z.coerce.date().optional(),
  sign: z.boolean().optional(),
});

@ApiTags('25 Contracts & monetization')
@Controller()
export class ContractsController {
  constructor(private readonly svc: ContractsService) {}

  @Public() @Get('public/plans') plans() { return this.svc.plans(); }
  @ApiBearerAuth() @Get('organizations/:id/contracts') list(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listForOrg(u, id); }
  @ApiBearerAuth() @Post('organizations/:id/contracts') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CreateDto)) b: z.infer<typeof CreateDto>) { return this.svc.create(u, id, b); }
  @ApiBearerAuth() @Get('locations/:id/terms') terms(@Param('id') id: string) { return this.svc.termsFor(id, 'MARKETPLACE'); }
}
