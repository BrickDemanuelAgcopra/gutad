import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CHEF_AGREEMENT_VERSION, CHEF_APPLICATION_STEPS, CHEF_BUSINESS_TYPES, CHEF_CUISINES, CHEF_KITCHEN_TYPES } from '@gutad/shared';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ChefApplicationsService } from './chef-applications.service';
import { ChefFilesService, IncomingFile, MAX_CHEF_FILE_BYTES } from './chef-files.service';
import { ChefsService } from './chefs.service';
import { ChefDishesService } from './chef-dishes.service';
import { ChefOptionsService } from './chef-options.service';
import { ChefCalendarService } from './chef-calendar.service';

const StepDto = z.record(z.string(), z.unknown());
const DocDto = z.object({ requirementKey: z.string().min(2), expiresAt: z.string().optional().or(z.literal('').transform(() => undefined)) });
const AppealDto = z.object({ note: z.string().min(10).max(2000) });
const AssignDto = z.object({ reviewerId: z.string().uuid().nullable().optional() });
const ReviewDocDto = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(1000).optional(), expiresAt: z.string().nullable().optional() });
const ChangesDto = z.object({ steps: z.array(z.string()).min(1), note: z.string().min(5).max(2000) });
const DecideDto = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'WAITLIST']), reason: z.string().min(5).max(2000) });
const ReqDto = z.object({ key: z.string().min(2).max(60), label: z.string().min(2).max(200), description: z.string().max(500).nullable().optional(), regions: z.array(z.string()).optional(), kitchenTypes: z.array(z.string()).optional(), required: z.boolean().optional(), needsExpiry: z.boolean().optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() });
const ProfileDto = z.object({ bio: z.string().max(3000).optional(), cuisines: z.array(z.string()).max(10).optional(), languages: z.array(z.string()).max(10).optional(), experienceYears: z.number().int().min(0).max(80).nullable().optional(), portraitFileId: z.string().uuid().nullable().optional(), portfolioFileIds: z.array(z.string().uuid()).max(12).optional(), serviceRadiusKm: z.number().int().min(1).max(200).optional() });
const OptionDto = z.object({ id: z.string().max(64).optional().default(''), name: z.string().max(60), priceCents: z.number().int().min(0).max(50_000), soldOut: z.boolean().optional(), isDefault: z.boolean().optional(), maxQty: z.number().int().min(1).max(20).optional(), portionDesc: z.string().max(60).nullable().optional(), prepMinutesDelta: z.number().int().min(0).max(240).optional(), addsAllergens: z.array(z.string()).max(20).optional(), removesDietaryTags: z.array(z.string()).max(12).optional(), locked: z.boolean().optional(), description: z.string().max(200).nullable().optional(), searchTerms: z.array(z.string().max(40)).max(10).optional(), rules: z.record(z.string(), z.object({ maxQty: z.number().int().min(0).max(20).optional(), priceCents: z.number().int().min(0).max(50_000).optional(), hidden: z.boolean().optional() })).optional() });
const OptionGroupDto = z.object({ id: z.string().max(64).optional().default(''), name: z.string().max(60), selectionType: z.enum(['SINGLE', 'LEVEL', 'MULTI', 'QUANTITY', 'INCLUDED']), required: z.boolean(), minSelect: z.number().int().min(0).max(20), maxSelect: z.number().int().min(0).max(40), description: z.string().max(200).nullable().optional(), templateKey: z.string().max(40).nullable().optional(), parentOptionId: z.string().max(64).nullable().optional(), options: z.array(OptionDto).max(30) });
const DishDto = z.object({ dishName: z.string().min(1).max(80).optional(), description: z.string().max(1000).nullable().optional(), cuisine: z.string().max(60).nullable().optional(), portionDesc: z.string().max(120).optional(), ingredients: z.array(z.string().min(1).max(60)).max(40).optional(), allergens: z.array(z.string()).max(20).optional(), allergensConfirmed: z.boolean().optional(), dietaryTags: z.array(z.string()).max(12).optional(), priceCents: z.number().int().min(0).max(100_000).optional(), mode: z.enum(['FIXED', 'CUSTOMIZABLE']).optional(), acceptsSpecialRequests: z.boolean().optional(), fulfillmentFormat: z.enum(['HOT', 'CHILLED_REHEAT', 'FROZEN', 'ROOM_TEMP']).optional(), prepMinutes: z.number().int().min(5).max(24 * 60).optional(), dailyCapacity: z.number().int().min(1).max(500).nullable().optional(), minLeadDays: z.number().int().min(0).max(60).nullable().optional(), cutoffHour: z.number().int().min(0).max(23).nullable().optional(), maxAdvanceDays: z.number().int().min(1).max(365).nullable().optional(), photos: z.array(z.string()).max(8).optional(), sectionId: z.string().uuid().optional(), optionsConfig: z.array(OptionGroupDto).max(12).optional() });
const ExtraDto = z.object({ name: z.string().min(1).max(60).optional(), synonyms: z.array(z.string().max(40)).max(10).optional(), portionDesc: z.string().max(60).nullable().optional(), priceCents: z.number().int().min(0).max(50_000).optional(), maxQty: z.number().int().min(1).max(20).optional(), prepMinutesDelta: z.number().int().min(0).max(240).optional(), allergens: z.array(z.string()).max(20).optional(), removesDietaryTags: z.array(z.string()).max(12).optional(), allDishes: z.boolean().optional(), dishIds: z.array(z.string().uuid()).max(100).optional(), soldOut: z.boolean().optional() });
const ReorderDto = z.object({ sections: z.array(z.object({ id: z.string().uuid(), dishIds: z.array(z.string().uuid()) })).min(1) });
const DishReviewDto = z.object({ decision: z.enum(['APPROVE', 'CHANGES', 'SUSPEND', 'REINSTATE']), note: z.string().max(1000).optional() });
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const OperatingDto = z.object({ cookingDays: z.array(z.number().int().min(0).max(6)).max(7).optional(), cutoffHour: z.number().int().min(0).max(23).optional(), minLeadDays: z.number().int().min(0).max(30).optional(), dailyCapacity: z.number().int().min(1).max(2000).optional(), maxAdvanceDays: z.number().int().min(1).max(365).optional(), opens: Hhmm.optional(), closes: Hhmm.optional(), lateRefundPct: z.number().int().min(0).max(100).optional() });
const DayDto = z.object({ open: z.boolean().nullable().optional(), capacity: z.number().int().min(0).max(2000).nullable().optional(), note: z.string().max(200).nullable().optional(), acknowledgeOrders: z.boolean().optional() });
const PauseDto = z.object({ startDate: Ymd, endDate: Ymd, reason: z.string().max(200).nullable().optional(), acknowledgeOrders: z.boolean().optional() });
const CartAvailDto = z.object({ replacesOrderId: z.string().uuid().optional(), lines: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1).max(50) })).max(50).default([]), from: Ymd.optional(), to: Ymd.optional(), holdKey: z.string().max(80).optional() });
const StatusDto = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED']), reason: z.string().min(5).max(1000) });

function send(res: Response, d: { fileName: string; mimeType: string; content: Buffer }, cache: 'public' | 'private') {
  res.setHeader('Content-Type', d.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cache === 'public') res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  else {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${d.fileName.replace(/[^\w.\- ]/g, '_')}"`);
  }
  res.send(d.content);
}

@ApiTags('40 Chef Network')
@ApiBearerAuth()
@Controller()
export class ChefsController {
  constructor(private readonly apps: ChefApplicationsService, private readonly chefs: ChefsService, private readonly files: ChefFilesService, private readonly dishes: ChefDishesService, private readonly options: ChefOptionsService, private readonly calendar: ChefCalendarService) {}

  // ───── advance ordering: availability and the chef's cooking calendar
  @Public() @Get('public/chef-dishes/:id/availability') dishAvailability(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('quantity') quantity?: string, @Query('holdKey') holdKey?: string) { return this.calendar.dishAvailability(id, { from, to, quantity: quantity ? Number(quantity) || 1 : 1, holdKey }); }
  @Public() @Post('public/chef-kitchens/:locationId/availability') async cartAvailability(@CurrentUser() u: JwtPayload | undefined, @Param('locationId') locationId: string, @Body(zod(CartAvailDto)) b: z.infer<typeof CartAvailDto>) {
    // changing a paid order: its own portions don't count, for its customer only
    const { replacesOrderId, ...rest } = b;
    const excludeOrderId = replacesOrderId && u && (await this.calendar.ownsOrder(u.sub, replacesOrderId, locationId)) ? replacesOrderId : null;
    return this.calendar.availability({ locationId, ...rest, excludeOrderId });
  }
  @Get('chef/calendar') myCalendar(@CurrentUser() u: JwtPayload, @Query('from') from?: string, @Query('to') to?: string) { return this.calendar.chefCalendar(u, from, to); }
  @Put('chef/calendar/settings') setOperating(@CurrentUser() u: JwtPayload, @Body(zod(OperatingDto)) b: z.infer<typeof OperatingDto>) { return this.calendar.setOperating(u, b); }
  @Put('chef/calendar/days/:date') setDay(@CurrentUser() u: JwtPayload, @Param('date') date: string, @Body(zod(DayDto)) b: z.infer<typeof DayDto>) { return this.calendar.setDay(u, date, b); }
  @Post('chef/calendar/pauses') addPause(@CurrentUser() u: JwtPayload, @Body(zod(PauseDto)) b: z.infer<typeof PauseDto>) { return this.calendar.addPause(u, b); }
  @Delete('chef/calendar/pauses/:id') removePause(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.calendar.removePause(u, id); }
  @Get('admin/chefs/:id/calendar') adminCalendar(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.calendar.adminCalendar(u, id, from, to); }

  // ───── customization
  @Public() @Post('public/chef-dishes/:id/price') price(@Param('id') id: string, @Body(zod(z.object({ optionIds: z.array(z.string().uuid()).max(100) }))) b: { optionIds: string[] }) { return this.options.price(id, b.optionIds); }
  @Post('chef/dishes/:id/options/:optionId/sold-out') optionSoldOut(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('optionId') optionId: string, @Body(zod(z.object({ soldOut: z.boolean() }))) b: { soldOut: boolean }) { return this.options.setOptionSoldOut(u, id, optionId, b.soldOut); }
  @Get('chef/extras') extras(@CurrentUser() u: JwtPayload) { return this.options.listExtras(u); }
  @Post('chef/extras') addExtra(@CurrentUser() u: JwtPayload, @Body(zod(ExtraDto)) b: z.infer<typeof ExtraDto>) { return this.options.upsertExtra(u, null, b); }
  @Patch('chef/extras/:id') editExtra(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExtraDto)) b: z.infer<typeof ExtraDto>) { return this.options.upsertExtra(u, id, b); }
  @Delete('chef/extras/:id') removeExtra(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.options.removeExtra(u, id); }
  @Get('admin/chef-extras/review') extrasQueue(@CurrentUser() u: JwtPayload) { return this.options.extrasQueue(u); }
  @Post('admin/chef-extras/:id/review') reviewExtra(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }))) b: { approve: boolean; note?: string }) { return this.options.reviewExtra(u, id, b); }

  // ───── dishes: public
  @Public() @Get('public/chefs/:slug/dishes') storefront(@Param('slug') slug: string) { return this.dishes.storefront(slug); }
  @Public() @Get('public/chef-dishes/:id') publicDish(@Param('id') id: string) { return this.dishes.publicDishById(id); }

  // ───── dishes: chef builder
  @Get('chef/menu') menu(@CurrentUser() u: JwtPayload) { return this.dishes.myMenu(u); }
  @Post('chef/menu/sections') addSection(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ name: z.string().min(1).max(60) }))) b: { name: string }) { return this.dishes.addSection(u, b.name); }
  @Patch('chef/menu/sections/:id') renameSection(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ name: z.string().min(1).max(60) }))) b: { name: string }) { return this.dishes.renameSection(u, id, b.name); }
  @Delete('chef/menu/sections/:id') deleteSection(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.dishes.deleteSection(u, id); }
  @Put('chef/menu/order') reorder(@CurrentUser() u: JwtPayload, @Body(zod(ReorderDto)) b: z.infer<typeof ReorderDto>) { return this.dishes.reorder(u, b); }
  @Post('chef/dishes') createDish(@CurrentUser() u: JwtPayload, @Body(zod(DishDto)) b: z.infer<typeof DishDto>) { return this.dishes.create(u, b); }
  @Get('chef/dishes/:id') getDish(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.dishes.get(u, id); }
  @Patch('chef/dishes/:id') updateDish(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DishDto)) b: z.infer<typeof DishDto>) { return this.dishes.update(u, id, b); }
  @Post('chef/dishes/:id/submit') submitDish(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.dishes.submit(u, id); }
  @Post('chef/dishes/:id/sold-out') soldOut(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ soldOut: z.boolean() }))) b: { soldOut: boolean }) { return this.dishes.setSoldOut(u, id, b.soldOut); }
  @Post('chef/dishes/:id/archive') archiveDish(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.dishes.archive(u, id); }

  // ───── dishes: Gutad review
  @Get('admin/chef-dishes/review') dishQueue(@CurrentUser() u: JwtPayload) { return this.dishes.reviewQueue(u); }
  @Get('admin/chef-dishes') dishList(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('chefId') chefId?: string) { return this.dishes.adminList(u, { status, chefId }); }
  @Post('admin/chef-dishes/:id/review') reviewDish(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DishReviewDto)) b: z.infer<typeof DishReviewDto>) { return this.dishes.review(u, id, b); }

  // ───── public
  @Public() @Get('public/chef-network/config') async config() {
    return { agreementVersion: CHEF_AGREEMENT_VERSION, steps: CHEF_APPLICATION_STEPS, kitchenTypes: CHEF_KITCHEN_TYPES, businessTypes: CHEF_BUSINESS_TYPES, cuisines: CHEF_CUISINES, requirements: await this.apps.requirements(), maxFileBytes: MAX_CHEF_FILE_BYTES };
  }
  @Public() @Get('public/chefs') directory(@Query('city') city?: string, @Query('region') region?: string, @Query('cuisine') cuisine?: string, @Query('q') q?: string) { return this.chefs.directory({ city, region, cuisine, q }); }
  @Public() @Get('public/chefs/:slug') chef(@Param('slug') slug: string) { return this.chefs.bySlug(slug); }
  @Public() @Get('public/chef-photos/:id') async photo(@Param('id') id: string, @Res() res: Response) { send(res, await this.files.readPhoto(id), 'public'); }

  // ───── applicant
  @Get('chef/application') mine(@CurrentUser() u: JwtPayload) { return this.apps.mine(u); }
  @Post('chef/application') start(@CurrentUser() u: JwtPayload) { return this.apps.start(u); }
  @Put('chef/application/steps/:step') save(@CurrentUser() u: JwtPayload, @Param('step') step: string, @Body(zod(StepDto)) b: Record<string, unknown>) { return this.apps.saveStep(u, step, b); }
  @Post('chef/application/submit') submit(@CurrentUser() u: JwtPayload) { return this.apps.submit(u); }
  @Post('chef/application/appeal') appeal(@CurrentUser() u: JwtPayload, @Body(zod(AppealDto)) b: { note: string }) { return this.apps.appeal(u, b.note); }

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CHEF_FILE_BYTES, files: 1 } }))
  @Post('chef/application/documents') uploadDoc(@CurrentUser() u: JwtPayload, @UploadedFile() file: IncomingFile | undefined, @Body(zod(DocDto)) b: z.infer<typeof DocDto>) { return this.apps.uploadDocument(u, file, b.requirementKey, b.expiresAt); }

  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CHEF_FILE_BYTES, files: 1 } }))
  @Post('chef/photos') async uploadPhoto(@CurrentUser() u: JwtPayload, @UploadedFile() file: IncomingFile | undefined) {
    const f = await this.files.store(u, file, 'CHEF_PHOTO');
    return { id: f.id, url: `/public/chef-photos/${f.id}`, fileName: f.fileName };
  }

  @Get('chef/files/:id/link') fileLink(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.files.link(u, id); }
  @Public() @Get('public/chef-files/:id/signed') async signed(@Param('id') id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) { send(res, await this.files.readSigned(id, exp, sig), 'private'); }
  @Get('chef/files/:id') async file(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Res() res: Response) { send(res, await this.files.read(u, id), 'private'); }

  // ───── approved chef
  @Get('chef/me') me(@CurrentUser() u: JwtPayload) { return this.chefs.me(u); }
  @Patch('chef/me') updateMe(@CurrentUser() u: JwtPayload, @Body(zod(ProfileDto)) b: z.infer<typeof ProfileDto>) { return this.chefs.updateProfile(u, b); }
  @Post('chef/me/availability') accepting(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ accepting: z.boolean() }))) b: { accepting: boolean }) { return this.chefs.setAccepting(u, b.accepting); }
  @Post('chef/me/payouts') payouts(@CurrentUser() u: JwtPayload) { return this.chefs.connectPayouts(u); }

  // ───── admin
  @Get('admin/chef-applications') list(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('region') region?: string, @Query('mine') mine?: string) { return this.apps.list(u, { status, region, mine: mine === 'true' }); }
  @Get('admin/chef-applications/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.apps.detail(u, id); }
  @Post('admin/chef-applications/:id/assign') assign(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(AssignDto)) b: z.infer<typeof AssignDto>) { return this.apps.assign(u, id, b.reviewerId); }
  @Post('admin/chef-applications/:id/changes') changes(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ChangesDto)) b: z.infer<typeof ChangesDto>) { return this.apps.requestChanges(u, id, b); }
  @Post('admin/chef-applications/:id/decide') decide(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DecideDto)) b: z.infer<typeof DecideDto>) { return this.apps.decide(u, id, b); }
  @Post('admin/chef-documents/:id/review') reviewDoc(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReviewDocDto)) b: z.infer<typeof ReviewDocDto>) { return this.apps.reviewDocument(u, id, b); }
  @Get('admin/chef-requirements') reqs(@CurrentUser() u: JwtPayload) { return this.apps.requirements(true); }
  @Post('admin/chef-requirements') upsertReq(@CurrentUser() u: JwtPayload, @Body(zod(ReqDto)) b: z.infer<typeof ReqDto>) { return this.apps.upsertRequirement(u, b); }
  @Get('admin/chefs') chefsList(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.chefs.adminList(u, { status }); }
  @Post('admin/chefs/:id/status') chefStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(StatusDto)) b: z.infer<typeof StatusDto>) { return this.chefs.adminSetStatus(u, id, b.status, b.reason); }
}
