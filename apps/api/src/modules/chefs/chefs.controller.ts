import { Body, Controller, Get, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
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

const StepDto = z.record(z.string(), z.unknown());
const DocDto = z.object({ requirementKey: z.string().min(2), expiresAt: z.string().optional().or(z.literal('').transform(() => undefined)) });
const AppealDto = z.object({ note: z.string().min(10).max(2000) });
const AssignDto = z.object({ reviewerId: z.string().uuid().nullable().optional() });
const ReviewDocDto = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(1000).optional(), expiresAt: z.string().nullable().optional() });
const ChangesDto = z.object({ steps: z.array(z.string()).min(1), note: z.string().min(5).max(2000) });
const DecideDto = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'WAITLIST']), reason: z.string().min(5).max(2000) });
const ReqDto = z.object({ key: z.string().min(2).max(60), label: z.string().min(2).max(200), description: z.string().max(500).nullable().optional(), regions: z.array(z.string()).optional(), kitchenTypes: z.array(z.string()).optional(), required: z.boolean().optional(), needsExpiry: z.boolean().optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() });
const ProfileDto = z.object({ bio: z.string().max(3000).optional(), cuisines: z.array(z.string()).max(10).optional(), languages: z.array(z.string()).max(10).optional(), experienceYears: z.number().int().min(0).max(80).nullable().optional(), portraitFileId: z.string().uuid().nullable().optional(), portfolioFileIds: z.array(z.string().uuid()).max(12).optional(), serviceRadiusKm: z.number().int().min(1).max(200).optional() });
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
  constructor(private readonly apps: ChefApplicationsService, private readonly chefs: ChefsService, private readonly files: ChefFilesService) {}

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
