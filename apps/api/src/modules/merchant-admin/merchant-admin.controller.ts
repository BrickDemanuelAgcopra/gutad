import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, RequiresReason } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { BrandsAdminService } from './brands-admin.service';
import { LocationsAdminService } from './locations-admin.service';
import { MerchantsAdminService } from './merchants-admin.service';

const ApplyDto = z.object({ businessName: z.string().min(2), contactName: z.string().min(2), email: z.string().email(), phone: z.string().optional(), city: z.string().optional(), cuisine: z.string().optional(), locationsCount: z.number().int().min(1).max(500).optional(), website: z.string().optional(), interest: z.array(z.string()).optional(), estMonthlyOrders: z.number().int().min(0).optional(), source: z.string().optional() });
const AppUpdateDto = z.object({ stage: z.string().optional(), ownerId: z.string().uuid().nullable().optional(), note: z.string().optional(), lostReason: z.string().optional(), estMonthlyOrders: z.number().int().min(0).optional() });
const ClosureDto = z.object({ kind: z.enum(['CLOSED', 'SPECIAL_HOURS']), startsAt: z.string().datetime(), endsAt: z.string().datetime(), opens: z.string().regex(/^\d{2}:\d{2}$/).optional(), closes: z.string().regex(/^\d{2}:\d{2}$/).optional(), service: z.enum(['ALL', 'ORDERING', 'RESERVATIONS']).optional(), reason: z.string().optional() });
const StationDto = z.object({ id: z.string().uuid().optional(), code: z.string().min(1).max(20), name: z.string().min(1), maxConcurrent: z.number().int().min(1).nullable().optional(), isAvailable: z.boolean().optional(), equipment: z.array(z.string()).optional(), targetMinutes: z.number().int().min(1).max(240).optional() });
const EmergencyDto = z.object({ locationIds: z.array(z.string().uuid()).optional(), regionId: z.string().uuid().optional(), reason: z.string().min(5), minutes: z.number().int().min(5).optional() });
const RestartDto = z.object({ rampThrottlePer15m: z.number().int().min(1).optional(), rampMinutes: z.number().int().min(5).max(720).optional(), reason: z.string().min(5) });
const ProfileDto = z.object({ owners: z.array(z.object({ name: z.string(), title: z.string().optional(), ownershipPct: z.number().min(0).max(100).optional(), email: z.string().optional() })).optional(), contacts: z.array(z.object({ name: z.string(), role: z.string().optional(), email: z.string().optional(), phone: z.string().optional() })).optional(), website: z.string().nullable().optional(), taxId: z.string().nullable().optional(), billingEmail: z.string().email().nullable().optional() });
const LifecycleDto = z.object({ action: z.enum(['APPROVE', 'ACTIVATE', 'SUSPEND', 'REINSTATE', 'TERMINATE']), reason: z.string().min(5) });
const CaseDto = z.object({ category: z.string().min(2), description: z.string().min(5), orderId: z.string().uuid().optional(), locationId: z.string().uuid().optional() });
const MsgDto = z.object({ body: z.string().min(1), visibility: z.enum(['PARTIES', 'INTERNAL']).optional(), templateKey: z.string().optional() });
const RoyaltyRule = z.object({ type: z.enum(['BPS', 'PER_ITEM', 'TIERED']), bps: z.number().int().min(0).max(10000).optional(), cents: z.number().int().min(0).optional(), tiers: z.array(z.object({ uptoCents: z.number().int().nullable(), bps: z.number().int().min(0).max(10000) })).optional(), channel: z.string().optional(), minGuaranteeCents: z.number().int().min(0).optional() });
const BrandDto = z.object({ ownershipType: z.string().optional(), ownerName: z.string().nullable().optional(), operatingRights: z.string().nullable().optional(), territoryRegionIds: z.array(z.string().uuid()).optional(), contractStart: z.string().nullable().optional(), contractEnd: z.string().nullable().optional(), rightsStatus: z.string().optional(), rightsNote: z.string().nullable().optional(), authorizedChannels: z.array(z.string()).optional(), royaltyRules: z.array(RoyaltyRule).optional(), royaltyBps: z.number().int().min(0).max(10000).optional(), presentationStandards: z.string().nullable().optional(), assets: z.array(z.object({ kind: z.string(), url: z.string(), label: z.string().optional(), approved: z.boolean().optional() })).optional(), description: z.string().nullable().optional(), logoUrl: z.string().nullable().optional() });
const ReviewDto = z.object({ kind: z.enum(['RECIPE_APPROVAL', 'QUALITY_REVIEW', 'MYSTERY_SHOP']), subjectType: z.string().optional(), subjectId: z.string().optional(), locationId: z.string().uuid().optional(), score: z.number().int().min(1).max(5).optional(), result: z.enum(['PASS', 'FAIL', 'NEEDS_WORK']), notes: z.string().optional() });

@ApiTags('03–06 Locations, merchants & brands')
@ApiBearerAuth()
@Controller()
export class MerchantAdminController {
  constructor(private readonly locs: LocationsAdminService, private readonly merch: MerchantsAdminService, private readonly brandsSvc: BrandsAdminService) {}

  // 3 locations
  @Get('admin/locations') list(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.locs.list(u, q); }
  @Get('admin/locations/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.locs.detail(u, id); }
  @Get('locations/:id/launch-checklist') checklist(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.locs.detail(u, id).then((d) => d.checklist); }
  @Post('locations/:id/launch-items/:key') signOff(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('key') key: string, @Body(zod(z.object({ done: z.boolean(), note: z.string().optional() }))) b: { done: boolean; note?: string }) { return this.locs.signOff(u, id, key, b.done, b.note); }
  @Post('admin/locations/:id/readiness') readiness(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approve: z.boolean(), note: z.string().min(3) }))) b: { approve: boolean; note: string }) { return this.locs.approveReadiness(u, id, b.approve, b.note); }
  @Get('locations/:id/closures') closures(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.locs.closures(u, id); }
  @Post('locations/:id/closures') addClosure(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ClosureDto)) b: z.infer<typeof ClosureDto>) { return this.locs.addClosure(u, id, b); }
  @Delete('closures/:id') removeClosure(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.locs.removeClosure(u, id); }
  @Public() @Get('public/locations/:id/closures') publicClosures(@Param('id') id: string) { return this.locs.publicClosures(id); }
  @Post('kitchens/:id/stations') station(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(StationDto)) b: z.infer<typeof StationDto>) { return this.locs.upsertStation(u, id, b); }
  @RequiresReason() @Post('admin/locations/emergency-pause') emergency(@CurrentUser() u: JwtPayload, @Body(zod(EmergencyDto)) b: z.infer<typeof EmergencyDto>) { return this.locs.emergencyPause(u, b); }
  @RequiresReason() @Post('locations/:id/restart') restart(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RestartDto)) b: z.infer<typeof RestartDto>) { return this.locs.restart(u, id, b); }

  // 4 onboarding & lifecycle
  @Public() @Post('public/merchant-applications') apply(@Body(zod(ApplyDto)) b: z.infer<typeof ApplyDto>) { return this.merch.apply(b); }
  @Get('admin/pipeline') pipeline(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.merch.pipeline(u, q); }
  @Post('admin/pipeline') lead(@CurrentUser() u: JwtPayload, @Body(zod(ApplyDto)) b: z.infer<typeof ApplyDto>) { return this.merch.createLead(u, b); }
  @Patch('admin/pipeline/:id') updateApp(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(AppUpdateDto)) b: z.infer<typeof AppUpdateDto>) { return this.merch.updateApplication(u, id, b); }
  @Post('admin/pipeline/:id/convert') convert(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.merch.convert(u, id); }
  @Get('admin/merchants/onboarding') onboarding(@CurrentUser() u: JwtPayload) { return this.merch.onboardingBoard(u); }
  @Get('admin/merchants/performance') performance(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.merch.performance(u, q); }
  @Get('admin/merchants/:id') merchant(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.merch.detail(u, id); }
  @Patch('organizations/:id/profile') profile(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ProfileDto)) b: z.infer<typeof ProfileDto>) { return this.merch.updateProfile(u, id, b); }
  @Post('admin/organizations/:id/account-manager') am(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ userId: z.string().uuid().nullable() }))) b: { userId: string | null }) { return this.merch.setAccountManager(u, id, b.userId); }
  @Post('admin/organizations/:id/lifecycle') lifecycle(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(LifecycleDto)) b: z.infer<typeof LifecycleDto>) { return this.merch.lifecycle(u, id, b.action, b.reason); }

  // 5 merchant portal administration
  @Get('admin/change-requests') changes(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.merch.listChanges(u, { status }); }
  @Get('organizations/:id/change-requests') orgChanges(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.merch.listChanges(u, { organizationId: id }); }
  @Post('admin/change-requests/:id/approve') approveChange(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.merch.reviewChange(u, id, true, b.note); }
  @Post('admin/change-requests/:id/reject') rejectChange(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.merch.reviewChange(u, id, false, b.note); }
  @Get('admin/availability') availability(@CurrentUser() u: JwtPayload) { return this.merch.availability(u); }
  @Get('organizations/:id/statement-lines') lines(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query() q: Record<string, string>) { return this.merch.statementLines(u, id, q); }
  @Get('organizations/:id/statement-lines.csv') async linesCsv(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.merch.statementCsv(u, id, q);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="statement-lines-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
  @Get('organizations/:id/cases') cases(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('status') status?: string) { return this.merch.cases(u, id, status); }
  @Post('organizations/:id/cases') openCase(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CaseDto)) b: z.infer<typeof CaseDto>) { return this.merch.openCase(u, id, b); }
  @Get('incidents/:id/messages') messages(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.merch.caseMessages(u, id); }
  @Post('incidents/:id/messages') postMessage(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(MsgDto)) b: z.infer<typeof MsgDto>) { return this.merch.postCaseMessage(u, id, b); }

  // 6 brands
  @Get('admin/brands') brands(@CurrentUser() u: JwtPayload) { return this.brandsSvc.list(u); }
  @Get('brands/:id') brand(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.brandsSvc.detail(u, id); }
  @Patch('brands/:id') updateBrand(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(BrandDto)) b: z.infer<typeof BrandDto>) { return this.brandsSvc.update(u, id, b as never); }
  @Post('brands/:id/kitchens') brandKitchen(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ kitchenId: z.string().uuid(), isActive: z.boolean() }))) b: { kitchenId: string; isActive: boolean }) { return this.brandsSvc.authorizeKitchen(u, id, b.kitchenId, b.isActive); }
  @Post('brands/:id/reviews') review(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { return this.brandsSvc.addReview(u, id, b); }
  @Get('brands/:id/statement') statement(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query() q: Record<string, string>) { return this.brandsSvc.statement(u, id, q); }
  @Get('organizations/:id/brands') orgBrands(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.brandsSvc.ownedBrands(u, id); }
}

