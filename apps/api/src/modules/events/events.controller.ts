import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequiresFeature } from '../entitlements/requires-feature';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { EventsService } from './events.service';

const ExperienceDto = z.object({ name: z.string(), description: z.string().optional(), imageUrl: z.string().optional(), pricingMode: z.enum(['FREE', 'PREPAID_PER_PERSON', 'PREPAID_PER_PARTY', 'PAY_AT_VENUE']), priceCents: z.number().int().min(0).optional(), serviceFeePayer: z.enum(['DINER', 'MERCHANT']).optional(), refundPolicy: z.string().optional(), refundCutoffHours: z.number().int().min(0).optional(), sessions: z.array(z.object({ startAt: z.string(), capacity: z.number().int().positive() })).min(1), addOns: z.array(z.object({ name: z.string(), priceCents: z.number().int().min(0) })).optional() });
const TicketDto = z.object({ sessionId: z.string().uuid(), spots: z.number().int().min(1).max(20), guestName: z.string(), guestEmail: z.string().email().optional(), addOnIds: z.array(z.string().uuid()).optional(), paymentMethodId: z.string().optional(), payAtVenue: z.boolean().optional() });
const InquiryDto = z.object({ contactName: z.string(), contactEmail: z.string().email(), contactPhone: z.string().optional(), eventDate: z.string(), partySize: z.number().int().positive(), budgetCents: z.number().int().optional(), notes: z.string().optional() });
const ProposeDto = z.object({ proposalCents: z.number().int().positive(), depositCents: z.number().int().min(0), roomId: z.string().uuid().optional(), contractUrl: z.string().optional(), validDays: z.number().int().positive().optional() });

@ApiTags('17 Experiences & private events')
@Controller()
export class EventsController {
  constructor(private readonly svc: EventsService) {}

  @Public() @Get('public/locations/:id/experiences') list(@Param('id') id: string) { return this.svc.listPublic(id); }
  @Public() @Get('public/experiences/:id') get(@Param('id') id: string) { return this.svc.publicExperience(id); }
  @Public() @Post('tickets') buy(@CurrentUser() u: JwtPayload | undefined, @Body(zod(TicketDto)) b: z.infer<typeof TicketDto>, @Headers('idempotency-key') key?: string) { return this.svc.buyTicket(u ?? null, { ...b, idempotencyKey: key }); }
  @Public() @Post('tickets/:id/pay') pay(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ paymentMethodId: z.string() }))) b: { paymentMethodId: string }) { return this.svc.payHeldTicket(u ?? null, id, b.paymentMethodId); }
  @Public() @Post('tickets/:id/cancel') cancelTicket(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ transferToSessionId: z.string().uuid().optional() }))) b: { transferToSessionId?: string }) { return this.svc.cancelTicket(u ?? null, id, b.transferToSessionId); }
  @ApiBearerAuth() @Get('me/tickets') mine(@CurrentUser() u: JwtPayload) { return this.svc.myTickets(u); }
  @ApiBearerAuth() @RequiresFeature('experiences', 'param:id') @Post('locations/:id/experiences') create(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExperienceDto)) b: z.infer<typeof ExperienceDto>) { return this.svc.createExperience(u, id, b); }
  @ApiBearerAuth() @Post('tickets/:id/attend') attend(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ extrasOnsiteCents: z.number().int().min(0).optional() }))) b: { extrasOnsiteCents?: number }) { return this.svc.attend(u, id, b.extrasOnsiteCents); }
  @ApiBearerAuth() @Post('experience-sessions/:id/close') close(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.closeSession(u, id); }

  @Public() @RequiresFeature('private_events', 'param:id', 'customer') @Post('public/locations/:id/event-inquiries') inquire(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(InquiryDto)) b: z.infer<typeof InquiryDto>) { return this.svc.inquire(u ?? null, id, b); }
  @Public() @Get('event-inquiries/:id') getInquiry(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string) { return this.svc.getInquiry(u ?? null, id); }
  @ApiBearerAuth() @Get('locations/:id/event-inquiries') inquiries(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listInquiries(u, id); }
  @ApiBearerAuth() @Post('event-inquiries/:id/propose') propose(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ProposeDto)) b: z.infer<typeof ProposeDto>) { return this.svc.propose(u, id, b); }
  @Public() @Post('event-inquiries/:id/accept') accept(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ paymentMethodId: z.string() }))) b: { paymentMethodId: string }) { return this.svc.acceptProposal(u ?? null, id, b.paymentMethodId); }
  @Public() @Post('event-inquiries/:id/headcount') headcount(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ finalHeadcount: z.number().int().positive() }))) b: { finalHeadcount: number }) { return this.svc.setFinalHeadcount(u ?? null, id, b.finalHeadcount); }
  @ApiBearerAuth() @Post('event-inquiries/:id/settle') settle(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ finalCents: z.number().int().optional(), paymentMethodId: z.string().optional() }))) b: { finalCents?: number; paymentMethodId?: string }) { return this.svc.settleEvent(u, id, b); }
  @Public() @Post('event-inquiries/:id/cancel') cancel(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().optional() }))) b: { reason?: string }) { return this.svc.cancelEvent(u ?? null, id, b.reason); }
}
