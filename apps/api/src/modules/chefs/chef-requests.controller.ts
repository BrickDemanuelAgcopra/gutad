import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ChefRequestsService } from './chef-requests.service';

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const CreateDto = z.object({
  dishId: z.string().uuid(),
  requestType: z.enum(['ADD', 'REMOVE', 'SWAP', 'PORTION', 'OTHER']),
  details: z.string().trim().min(5, 'Tell the chef what you’d like (at least 5 characters)').max(1000),
  ingredient: z.string().trim().max(80).nullable().optional(),
  servings: z.number().int().min(1).max(50),
  requestedDate: Ymd,
  requestedTime: Hhmm.nullable().optional(),
  reason: z.enum(['PREFERENCE', 'ALLERGY', 'DIETARY', 'OCCASION']).default('PREFERENCE'),
  budgetCents: z.number().int().min(0).max(500_000).nullable().optional(),
  alternativesOk: z.boolean().optional(),
  alternativesNote: z.string().max(500).nullable().optional(),
  baseOptionIds: z.array(z.string().uuid()).max(100).optional(),
});
const QuoteDto = z.object({
  kind: z.enum(['QUOTE', 'ALTERNATIVE']).default('QUOTE'),
  altDishId: z.string().uuid().nullable().optional(),
  optionIds: z.array(z.string().uuid()).max(100).optional(),
  changes: z.string().trim().min(3).max(1000),
  portionDesc: z.string().max(120).nullable().optional(),
  unitPriceCents: z.number().int().min(0).max(100_000),
  quantity: z.number().int().min(1).max(50).optional(),
  allergens: z.array(z.string().max(40)).max(20),
  dietaryTags: z.array(z.string().max(40)).max(12).default([]),
  prepMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
  serviceDate: Ymd,
  serviceTime: Hhmm.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  validHours: z.number().int().min(1).max(168).optional(),
});
const BodyDto = z.object({ body: z.string().trim().min(1).max(2000) });
const ReasonDto = z.object({ reason: z.string().trim().min(3).max(1000) });

/** Gutad Chef Network special requests and chef quotes. */
@ApiTags('40 Chef Network')
@ApiBearerAuth()
@Controller()
export class ChefRequestsController {
  constructor(private readonly svc: ChefRequestsService) {}

  // customer
  @Post('chef-requests') create(@CurrentUser() u: JwtPayload, @Body(zod(CreateDto)) b: z.infer<typeof CreateDto>) { return this.svc.create(u, b); }
  @Get('chef-requests') mine(@CurrentUser() u: JwtPayload) { return this.svc.mine(u); }
  @Get('chef-requests/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.detail(u, id); }
  @Post('chef-requests/:id/messages') message(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(BodyDto)) b: { body: string }) { return this.svc.message(u, id, b.body); }
  @Post('chef-requests/:id/accept') accept(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ quoteId: z.string().uuid() }))) b: { quoteId: string }) { return this.svc.accept(u, id, b.quoteId); }
  @Post('chef-requests/:id/revise') revise(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().trim().min(3).max(1000) }))) b: { note: string }) { return this.svc.revise(u, id, b.note); }
  @Post('chef-requests/:id/withdraw') withdraw(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().max(1000).optional() }))) b: { reason?: string }) { return this.svc.withdraw(u, id, b.reason); }

  // chef
  @Get('chef/requests') inbox(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.svc.inbox(u, status); }
  @Post('chef/requests/:id/quote') quote(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(QuoteDto)) b: z.infer<typeof QuoteDto>) { return this.svc.quote(u, id, b); }
  @Post('chef/requests/:id/question') ask(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(BodyDto)) b: { body: string }) { return this.svc.ask(u, id, b.body); }
  @Post('chef/requests/:id/decline') decline(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReasonDto)) b: { reason: string }) { return this.svc.decline(u, id, b.reason); }

  // Gutad staff
  @Get('admin/chef-requests') adminList(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('chefId') chefId?: string, @Query('overdue') overdue?: string, @Query('escalated') escalated?: string) { return this.svc.adminList(u, { status, chefId, overdue: overdue === 'true', escalated: escalated === 'true' }); }
  @Get('admin/chef-requests/:id/alternatives') alternatives(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.adminAlternatives(u, id); }
  @Post('admin/chef-requests/:id/quote') staffQuote(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(QuoteDto)) b: z.infer<typeof QuoteDto>) { return this.svc.quote(u, id, b); }
  @Post('admin/chef-requests/:id/extend') extend(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ hours: z.number().int().min(1).max(168) }))) b: { hours: number }) { return this.svc.extend(u, id, b.hours); }
  @Post('admin/chef-requests/:id/close') close(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReasonDto)) b: { reason: string }) { return this.svc.close(u, id, b.reason); }
  @Post('admin/jobs/chef-requests') expire(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) {
    assertCan(u, 'chefs.manage');
    return this.svc.expireDue(b.at && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(b.at) : new Date());
  }
}
