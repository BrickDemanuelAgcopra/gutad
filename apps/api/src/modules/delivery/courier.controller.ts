import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ELIGIBILITY_CHECKS, EQUIPMENT_ITEMS, REVIEW_ISSUES, TRAINING_MODULES, TRIP_ISSUES, VEHICLE_TYPES, type ReviewIssue, type TripIssue } from '@gutad/shared';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CourierService } from './courier.service';

const Steps = {
  profile: z.object({ legalName: z.string().trim().min(2).max(120), addressLine1: z.string().trim().min(3).max(200), city: z.string().trim().min(2).max(80), postalCode: z.string().trim().min(2).max(20), phone: z.string().trim().min(7).max(30), languages: z.array(z.string().max(40)).max(10).default([]), photoUrl: z.string().max(500).optional() }),
  vehicle: z.object({ make: z.string().trim().max(60).optional(), model: z.string().trim().max(60).optional(), plate: z.string().trim().max(20).optional(), color: z.string().trim().max(30).optional(), year: z.number().int().min(1950).max(2100).optional() }),
  screening: z.object({ consent: z.literal(true), consentVersion: z.string() }),
  payout: z.object({ accountHolder: z.string().trim().min(2).max(120), accountLast4: z.string().regex(/^\d{4}$/), taxFormAccepted: z.literal(true), password: z.string().max(200).optional() }),
  agreement: z.object({ version: z.string(), accept: z.literal(true) }),
  training: z.object({ module: z.enum(TRAINING_MODULES.map((m) => m.key) as [string, ...string[]]), answer: z.number().int().min(0) }),
  equipment: z.object({ items: z.array(z.enum(EQUIPMENT_ITEMS)).max(10), photoUrl: z.string().max(500).optional() }),
} as const;
const LocationDto = z.object({ country: z.string().trim().min(2).max(60), city: z.string().trim().min(2).max(80), zoneIds: z.array(z.string().uuid()).max(20).optional(), transport: z.enum(VEHICLE_TYPES) });
const Pt = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const ReviewDto = z.object({ rating: z.number().int().min(1).max(5), tags: z.array(z.string()).max(10).optional(), comment: z.string().max(1000).optional(), foodRating: z.number().int().min(1).max(5).optional(), packagingRating: z.number().int().min(1).max(5).optional(), issues: z.array(z.enum(Object.keys(REVIEW_ISSUES) as [ReviewIssue, ...ReviewIssue[]])).max(4).optional() });

/** Courier Release 1: onboarding, starting work, trip problems, earnings, delivery reviews and staff decisions. */
@ApiTags('12/13 Delivery & drivers')
@ApiBearerAuth()
@Controller()
export class CourierController {
  constructor(private readonly svc: CourierService) {}

  // onboarding
  @Get('driver/onboarding') onboarding(@CurrentUser() u: JwtPayload) { return this.svc.onboardingView(u.sub); }
  @Post('driver/onboarding/location') location(@CurrentUser() u: JwtPayload, @Body(zod(LocationDto)) b: z.infer<typeof LocationDto>) { return this.svc.saveStep(u, 'location', b); }
  @Post('driver/onboarding/submit') submit(@CurrentUser() u: JwtPayload) { return this.svc.submit(u); }
  @Post('driver/onboarding/:step') step(@CurrentUser() u: JwtPayload, @Param('step') step: string, @Body() body: unknown) {
    const schema = Steps[step as keyof typeof Steps];
    return this.svc.saveStep(u, step, schema ? (zod(schema as z.ZodTypeAny).transform(body, { type: 'body' }) as Record<string, unknown>) : {});
  }
  @Post('driver/reactivation') reactivation(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ note: z.string().trim().min(10).max(1000) }))) b: { note: string }) { return this.svc.requestReactivation(u, b.note); }

  // starting work
  @Get('driver/status') status(@CurrentUser() u: JwtPayload) { return this.svc.status(u); }
  @Post('driver/break') brk(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ on: z.boolean() }))) b: { on: boolean }) { return this.svc.setBreak(u, b.on); }
  @Post('driver/finish-after-current') finish(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ on: z.boolean() }))) b: { on: boolean }) { return this.svc.setFinishAfterCurrent(u, b.on); }
  @Post('driver/shifts/:id/check-in') checkIn(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Pt)) b: { lat: number; lng: number }) { return this.svc.checkIn(u, id, b.lat, b.lng); }

  // trip problems
  @Post('driver/jobs/:id/release') release(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().trim().min(3).max(500) }))) b: { reason: string }) { return this.svc.release(u, id, b.reason); }
  @Post('driver/jobs/:id/issue') issue(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ kind: z.enum(Object.keys(TRIP_ISSUES) as [TripIssue, ...TripIssue[]]), note: z.string().max(500).optional(), photoUrl: z.string().max(500).optional() }))) b: { kind: TripIssue; note?: string; photoUrl?: string }) { return this.svc.issue(u, id, b); }

  // earnings & feedback
  @Get('driver/earnings') earnings(@CurrentUser() u: JwtPayload) { return this.svc.earnings(u); }
  @Post('driver/earnings/dispute') dispute(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ deliveryJobId: z.string().uuid().optional(), note: z.string().trim().min(10).max(1000) }))) b: { deliveryJobId?: string; note: string }) { return this.svc.disputeEarnings(u, b); }
  @Get('driver/feedback') feedback(@CurrentUser() u: JwtPayload) { return this.svc.myFeedback(u); }
  @Post('driver/feedback/:id/dispute') disputeReview(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().trim().min(10).max(1000) }))) b: { note: string }) { return this.svc.disputeReview(u, id, b.note); }

  // customer
  @Get('orders/:id/delivery-review') reviewState(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.reviewState(u, id); }
  @Post('orders/:id/delivery-review') review(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { return this.svc.submitReview(u, id, b); }

  // staff
  @Get('admin/couriers/pipeline') pipeline(@CurrentUser() u: JwtPayload) { return this.svc.pipeline(u); }
  @Post('admin/couriers/:id/checks/:check') check(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('check') check: string, @Body(zod(z.object({ status: z.enum(['PASSED', 'FAILED', 'NEEDS_ACTION', 'PENDING']), note: z.string().trim().max(500).optional(), expiresAt: z.string().datetime().optional() }))) b: { status: string; note?: string; expiresAt?: string }) {
    return this.svc.decideCheck(u, id, (ELIGIBILITY_CHECKS as readonly string[]).includes(check) ? check : 'UNKNOWN', b);
  }
  @Post('admin/couriers/:id/decision') decision(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ decision: z.enum(['APPROVE', 'NEEDS_ACTION', 'WAITLIST', 'REJECT', 'REOPEN']), note: z.string().trim().min(3).max(1000) }))) b: { decision: 'APPROVE' | 'NEEDS_ACTION' | 'WAITLIST' | 'REJECT' | 'REOPEN'; note: string }) { return this.svc.decide(u, id, b.decision, b.note); }
  @Post('admin/couriers/:id/lifecycle') lifecycle(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DEACTIVATED']), reason: z.string().trim().min(5).max(1000) }))) b: { status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'DEACTIVATED'; reason: string }) { return this.svc.setLifecycle(u, id, b.status, b.reason); }
  @Get('admin/delivery-reviews') reviews(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.svc.adminReviews(u, status || 'ALL'); }
  @Post('admin/delivery-reviews/:id/moderate') moderate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ action: z.enum(['APPROVE', 'HIDE', 'EXCLUDE', 'RESTORE', 'UPHOLD_DISPUTE', 'REJECT_DISPUTE']), note: z.string().trim().min(3).max(1000) }))) b: { action: 'APPROVE' | 'HIDE' | 'EXCLUDE' | 'RESTORE' | 'UPHOLD_DISPUTE' | 'REJECT_DISPUTE'; note: string }) { return this.svc.moderateReview(u, id, b.action, b.note); }
}
