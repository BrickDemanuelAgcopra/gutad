import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, RequiresReason } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CustomersService, type SegmentRules } from './customers.service';

const Rules = z.object({ minOrders: z.number().int().optional(), minSpendCents: z.number().int().optional(), lastOrderWithinDays: z.number().int().optional(), lastOrderBeforeDays: z.number().int().optional(), hasMembership: z.boolean().optional(), marketingConsent: z.boolean().optional(), status: z.string().optional(), q: z.string().optional() });
const parse = (q: Record<string, string>): SegmentRules & { limit?: number; offset?: number } => ({ q: q.q || undefined, status: q.status || undefined, minOrders: q.minOrders ? Number(q.minOrders) : undefined, minSpendCents: q.minSpendCents ? Number(q.minSpendCents) : undefined, lastOrderWithinDays: q.lastOrderWithinDays ? Number(q.lastOrderWithinDays) : undefined, lastOrderBeforeDays: q.lastOrderBeforeDays ? Number(q.lastOrderBeforeDays) : undefined, hasMembership: q.hasMembership ? q.hasMembership === 'true' : undefined, marketingConsent: q.marketingConsent ? q.marketingConsent === 'true' : undefined, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined });

@ApiTags('10 Customer accounts')
@ApiBearerAuth()
@Controller()
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  // staff
  @Get('admin/customers') directory(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.svc.directory(u, parse(q)); }
  @Get('admin/customers/export.csv') async export(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.svc.exportSegment(u, parse(q));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
  @Get('admin/customers/:id') profile(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.profile(u, id); }
  @RequiresReason() @Post('admin/customers/:id/send-recovery') recovery(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.svc.sendRecovery(u, id, b.reason); }
  @RequiresReason() @Post('admin/customers/:id/merge') merge(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ intoUserId: z.string().uuid(), reason: z.string().min(5) }))) b: { intoUserId: string; reason: string }) { return this.svc.merge(u, id, b.intoUserId, b.reason); }
  @Post('admin/customers/:id/restrictions') restrict(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ kind: z.enum(['ORDERING_BLOCKED', 'PROMOTIONS_BLOCKED', 'REFUND_REVIEW', 'CASH_LIMIT', 'CREDIT_LIMIT']), reason: z.string().min(5), expiresAt: z.string().datetime().optional(), limitCents: z.number().int().min(0).optional(), periodDays: z.number().int().min(1).max(365).optional() }))) b: { kind: 'ORDERING_BLOCKED' | 'PROMOTIONS_BLOCKED' | 'REFUND_REVIEW' | 'CASH_LIMIT' | 'CREDIT_LIMIT'; reason: string; expiresAt?: string; limitCents?: number; periodDays?: number }) { return this.svc.restrict(u, id, b); }
  @Post('admin/restrictions/:id/lift') lift(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.svc.lift(u, id, b.note); }
  @Post('admin/restrictions/:id/appeal-decision') decide(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ lift: z.boolean(), note: z.string().min(3) }))) b: { lift: boolean; note: string }) { return this.svc.decideAppeal(u, id, b.lift, b.note); }
  @Get('admin/appeals') appeals(@CurrentUser() u: JwtPayload) { return this.svc.appealsQueue(u); }
  @Get('admin/segments') segments(@CurrentUser() u: JwtPayload) { return this.svc.segments(u); }
  @Post('admin/segments') saveSegment(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ id: z.string().uuid().optional(), name: z.string().min(2), rules: Rules }))) b: { id?: string; name: string; rules: SegmentRules }) { return this.svc.upsertSegment(u, b); }
  @Get('admin/privacy-requests') privacy(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.svc.privacyQueue(u, status); }
  @Post('admin/privacy-requests/:id/decision') privacyDecide(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ action: z.enum(['EXECUTE', 'BLOCK']), note: z.string().min(3) }))) b: { action: 'EXECUTE' | 'BLOCK'; note: string }) { return this.svc.decidePrivacy(u, id, b.action, b.note); }

  @Public() @Get('public/cart-compatibility') compat(@Query('current') current: string, @Query('adding') adding: string) { return this.svc.cartCheck(current, adding); }

  // customer
  @Get('me/restrictions') myRestrictions(@CurrentUser() u: JwtPayload) { return this.svc.myRestrictions(u); }
  @Post('me/restrictions/:id/appeal') appeal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(10) }))) b: { note: string }) { return this.svc.appeal(u, id, b.note); }
  @Get('me/payment-methods') cards(@CurrentUser() u: JwtPayload) { return this.svc.myCards(u); }
  @Post('me/payment-methods') addCard(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ paymentMethodId: z.string(), brand: z.string().optional(), last4: z.string().regex(/^\d{4}$/).optional(), expMonth: z.number().int().min(1).max(12).optional(), expYear: z.number().int().optional(), makeDefault: z.boolean().optional() }))) b: { paymentMethodId: string; brand?: string; last4?: string; expMonth?: number; expYear?: number; makeDefault?: boolean }) { return this.svc.addCard(u, b); }
  @Delete('me/payment-methods/:id') removeCard(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.removeCard(u, id); }
  @Post('me/payment-methods/:id/default') defaultCard(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.defaultCard(u, id); }
  @Get('me/notification-prefs') prefs(@CurrentUser() u: JwtPayload) { return this.svc.prefs(u); }
  @Put('me/notification-prefs') setPrefs(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ topics: z.array(z.object({ topic: z.string(), email: z.boolean().optional(), sms: z.boolean().optional(), push: z.boolean().optional() })) }))) b: { topics: { topic: string; email?: boolean; sms?: boolean; push?: boolean }[] }) { return this.svc.setPrefs(u, b.topics); }
  @Get('me/data-requests') myData(@CurrentUser() u: JwtPayload) { return this.svc.myPrivacyRequests(u); }
  @Post('me/data-request') data(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ kind: z.enum(['ACCESS', 'DELETE']) }))) b: { kind: 'ACCESS' | 'DELETE' }) { return this.svc.privacyRequest(u, b.kind); }
  @Post('me/data-request/:id/cancel') cancelData(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.cancelPrivacy(u, id); }
}
