import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { FIRST_PARTY_RANKING_MODES, type FirstPartyPolicy } from '@gutad/shared';
import { CurrentUser, JwtPayload, Public, RequiresReason, type RoleName } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { FirstPartyAdminService } from './first-party.service';

const Rules = z.object({
  enabled: z.boolean(),
  ranking: z.enum(FIRST_PARTY_RANKING_MODES),
  boostPositions: z.number().int().min(0).max(50),
  pinSlots: z.array(z.number().int().min(1).max(50)).max(10),
  maxFirstPageSharePct: z.number().int().min(0).max(100),
  allowSponsored: z.boolean(),
  label: z.string().min(3).max(40),
  shadowCommissionBps: z.number().int().min(0).max(5000),
});
const PolicyDto = Rules.partial().extend({ cities: z.record(Rules.partial()).optional() });
const SaveDto = z.object({ policy: PolicyDto, reason: z.string().min(5) });
const SetupDto = z.object({ name: z.string().min(2).optional(), legalName: z.string().min(2).optional(), taxId: z.string().optional() });
const KitchenDto = z.object({ name: z.string().min(2), addressLine1: z.string().min(1), city: z.string().min(1), region: z.string().min(1), postalCode: z.string().min(1), lat: z.number().optional(), lng: z.number().optional() });
const LocationDto = z.object({ name: z.string().min(2), description: z.string().optional(), cuisine: z.array(z.string()).optional(), addressLine1: z.string().min(1), city: z.string().min(1), region: z.string().min(1), postalCode: z.string().min(1), lat: z.number().optional(), lng: z.number().optional(), phone: z.string().optional(), kitchenId: z.string().uuid().optional(), foodHall: z.boolean().optional(), acceptsPickup: z.boolean().optional(), acceptsDelivery: z.boolean().optional(), heroImageUrl: z.string().optional() });
const BrandDto = z.object({ name: z.string().min(1), description: z.string().optional(), logoUrl: z.string().optional() });
const KillDto = z.object({ enabled: z.boolean(), city: z.string().nullable().optional(), reason: z.string().min(5) });
const PreviewDto = z.object({ city: z.string().optional(), q: z.string().optional(), service: z.enum(['pickup', 'delivery']).optional(), policy: PolicyDto.optional() });
const OperatorDto = z.object({ email: z.string().email(), role: z.enum(['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST', 'KITCHEN', 'PACKER', 'DISPATCHER']), locationIds: z.array(z.string().uuid()).optional() });

@ApiTags('Gutad first-party')
@ApiBearerAuth()
@Controller()
export class FirstPartyController {
  constructor(private readonly svc: FirstPartyAdminService) {}

  @Get('admin/first-party') overview(@CurrentUser() u: JwtPayload) { return this.svc.overview(u); }
  @Post('admin/first-party/setup') setup(@CurrentUser() u: JwtPayload, @Body(zod(SetupDto)) b: z.infer<typeof SetupDto>) { return this.svc.setup(u, b); }
  @Post('admin/first-party/kitchens') kitchen(@CurrentUser() u: JwtPayload, @Body(zod(KitchenDto)) b: z.infer<typeof KitchenDto>) { return this.svc.createKitchen(u, b); }
  @Post('admin/first-party/locations') location(@CurrentUser() u: JwtPayload, @Body(zod(LocationDto)) b: z.infer<typeof LocationDto>) { return this.svc.createLocation(u, b); }
  @Post('admin/first-party/brands') brand(@CurrentUser() u: JwtPayload, @Body(zod(BrandDto)) b: z.infer<typeof BrandDto>) { return this.svc.createBrand(u, b); }

  @Get('admin/first-party/policy') policy(@CurrentUser() u: JwtPayload) { return this.svc.policy(u); }
  @RequiresReason() @Put('admin/first-party/policy') save(@CurrentUser() u: JwtPayload, @Body(zod(SaveDto)) b: z.infer<typeof SaveDto>) { return this.svc.savePolicy(u, b.policy as Partial<FirstPartyPolicy>, b.reason); }
  @RequiresReason() @Post('admin/first-party/policy/kill-switch') kill(@CurrentUser() u: JwtPayload, @Body(zod(KillDto)) b: z.infer<typeof KillDto>) { return this.svc.killSwitch(u, b); }
  @RequiresReason() @Post('admin/first-party/policy/versions/:version/restore') restore(@CurrentUser() u: JwtPayload, @Param('version') v: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.svc.rollback(u, Number(v), b.reason); }
  @Post('admin/first-party/preview') preview(@CurrentUser() u: JwtPayload, @Body(zod(PreviewDto)) b: z.infer<typeof PreviewDto>) { return this.svc.preview(u, b as Parameters<FirstPartyAdminService['preview']>[1]); }
  @Get('admin/first-party/report') report(@CurrentUser() u: JwtPayload, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.report(u, from, to); }

  @Get('admin/first-party/operators') operators(@CurrentUser() u: JwtPayload) { return this.svc.operators(u); }
  @Post('admin/first-party/operators') addOperator(@CurrentUser() u: JwtPayload, @Body(zod(OperatorDto)) b: z.infer<typeof OperatorDto>) { return this.svc.addOperator(u, { ...b, role: b.role as RoleName }); }
  @Delete('admin/first-party/operators/:id') removeOperator(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.removeOperator(u, id); }

  @Public() @Get('public/marketplace-policy') publicPolicy() { return this.svc.publicPolicy(); }
}
