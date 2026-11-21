import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CERTIFIABLE_CATEGORIES, REFUSAL_REASONS, type CertifiableCategory, type RefusalReason } from '@gutad/shared';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CourierSpecialService } from './courier-special.service';

const Category = z.enum(CERTIFIABLE_CATEGORIES);
const Training = z.object({ answers: z.array(z.number().int().min(0).max(10)).max(20) });
const Certificate = z.object({ fileUrl: z.string().min(3).max(500), expiresAt: z.string().datetime().optional() });
const Refuse = z.object({ reason: z.enum(REFUSAL_REASONS), note: z.string().trim().max(500).optional() });
const Temperature = z.object({ stage: z.enum(['PICKUP', 'DROPOFF']), tempC: z.number().min(-40).max(100) });
const Catering = z.object({ startSetup: z.boolean().optional(), finishSetup: z.boolean().optional(), checklist: z.object({ itemsCounted: z.boolean().optional(), utensils: z.boolean().optional(), labelsShown: z.boolean().optional() }).strict().optional(), headcount: z.number().int().min(1).max(5000).optional() });
const ReturnReceived = z.object({ sealIntact: z.boolean(), note: z.string().trim().max(500).optional() });
const Decide = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'REVOKE']), reason: z.string().trim().min(3).max(500), expiresAt: z.string().datetime().optional() });
const Grant = z.object({ category: Category, reason: z.string().trim().min(3).max(500), expiresAt: z.string().datetime().optional() });

/** Courier Release 4: specialised categories — certifications, restricted handoffs, refusals, temperature, catering. */
@ApiTags('12/13 Delivery & drivers')
@ApiBearerAuth()
@Controller()
export class CourierR4Controller {
  constructor(private readonly special: CourierSpecialService) {}

  // ───── courier ─────
  @Get('driver/certifications') certifications(@CurrentUser() u: JwtPayload) { return this.special.myCertifications(u); }
  @Post('driver/certifications/:category/training') training(@CurrentUser() u: JwtPayload, @Param('category', zod(Category)) c: CertifiableCategory, @Body(zod(Training)) b: { answers: number[] }) { return this.special.passTraining(u, c, b.answers); }
  @Post('driver/certifications/:category/certificate') certificate(@CurrentUser() u: JwtPayload, @Param('category', zod(Category)) c: CertifiableCategory, @Body(zod(Certificate)) b: { fileUrl: string; expiresAt?: string }) { return this.special.uploadCertificate(u, c, b); }
  @Post('driver/jobs/:id/refuse-handoff') refuse(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Refuse)) b: { reason: RefusalReason; note?: string }) { return this.special.refuseHandoff(u, id, b); }
  @Post('driver/jobs/:id/temperature') temperature(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Temperature)) b: { stage: 'PICKUP' | 'DROPOFF'; tempC: number }) { return this.special.temperature(u, id, b); }
  @Post('driver/jobs/:id/catering') catering(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Catering)) b: z.infer<typeof Catering>) { return this.special.catering(u, id, b); }

  // ───── kitchen ─────
  @Post('delivery-jobs/:id/return-received') returnReceived(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(ReturnReceived)) b: { sealIntact: boolean; note?: string }) { return this.special.returnReceived(u, id, b); }
  @Get('locations/:id/delivery-returns') returns(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.special.returns(u, id); }

  // ───── staff ─────
  @Get('admin/courier-certifications') queue(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('category') category?: string) { return this.special.queue(u, { status, category }); }
  @Post('admin/courier-certifications/:id/decide') decide(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Decide)) b: { decision: 'APPROVE' | 'REJECT' | 'REVOKE'; reason: string; expiresAt?: string }) { return this.special.decide(u, id, b); }
  @Get('admin/couriers/:id/certifications') courierCerts(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.special.courierCertifications(u, id); }
  @Post('admin/couriers/:id/certifications') grant(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Grant)) b: { category: CertifiableCategory; reason: string; expiresAt?: string }) { return this.special.grant(u, id, b); }
  @Get('admin/delivery/jobs/:id/special') jobSpecial(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.special.jobSpecial(u, id); }
  @Get('admin/delivery/special/report') report(@CurrentUser() u: JwtPayload, @Query('from') from?: string, @Query('to') to?: string) { return this.special.report(u, { from, to }); }
  @Post('admin/delivery/special/sweep') sweep(@CurrentUser() u: JwtPayload) { return this.special.sweepAsStaff(u); }
}
