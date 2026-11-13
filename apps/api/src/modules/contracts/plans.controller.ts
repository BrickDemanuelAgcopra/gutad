import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { FeeRuleSchema } from './contracts.controller';
import { PlansService } from './plans.service';

const LINE = z.enum(['ORDERING', 'RESERVATIONS', 'SUITE']);
const PlanDto = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(80),
  productLine: LINE,
  tagline: z.string().max(160).optional(),
  description: z.string().max(1000).optional(),
  isPublic: z.boolean().optional(),
  highlight: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const PlanPatchDto = PlanDto.omit({ code: true }).partial().extend({ isArchived: z.boolean().optional(), tagline: z.string().max(160).nullable().optional(), description: z.string().max(1000).nullable().optional() });
const VersionDto = z.object({
  subscriptionCents: z.number().int().min(0).max(10_000_000).optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  perLocation: z.boolean().optional(),
  setupFeeCents: z.number().int().min(0).max(10_000_000).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(1000).nullable().optional(),
  fees: z.array(FeeRuleSchema).max(60).optional(),
  features: z.array(z.object({ key: z.string(), enabled: z.boolean(), limitValue: z.number().int().min(0).nullable().optional() })).max(200).optional(),
});
const FeatureDto = z.object({
  key: z.string().min(2).max(60),
  name: z.string().min(2).max(80),
  description: z.string().max(300).nullable().optional(),
  kind: z.enum(['BOOLEAN', 'LIMIT']).optional(),
  productLine: z.enum(['ORDERING', 'RESERVATIONS', 'ALL']).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

@ApiTags('25 Contracts & monetization')
@ApiBearerAuth()
@Controller('admin')
export class PlansController {
  constructor(private readonly svc: PlansService) {}

  @Get('plans') catalog(@CurrentUser() u: JwtPayload) { return this.svc.adminCatalog(u); }
  @Post('plans') create(@CurrentUser() u: JwtPayload, @Body(zod(PlanDto)) b: z.infer<typeof PlanDto>) { return this.svc.createPlan(u, b); }
  @Patch('plans/:id') update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PlanPatchDto)) b: z.infer<typeof PlanPatchDto>) { return this.svc.updatePlan(u, id, b); }
  @Post('plans/:id/versions') draft(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.createDraft(u, id); }
  @Patch('plan-versions/:id') updateDraft(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(VersionDto)) b: z.infer<typeof VersionDto>) { return this.svc.updateDraft(u, id, b); }
  @Delete('plan-versions/:id') deleteDraft(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.deleteDraft(u, id); }
  @Post('plan-versions/:id/publish') publish(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approverEmail: z.string().email().optional() }))) b: { approverEmail?: string }) { return this.svc.publish(u, id, b.approverEmail); }
  @Post('features') feature(@CurrentUser() u: JwtPayload, @Body(zod(FeatureDto)) b: z.infer<typeof FeatureDto>) { return this.svc.upsertFeature(u, b); }
}
