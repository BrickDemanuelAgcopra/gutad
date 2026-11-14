import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { PaymentsService } from './payments.service';
import { loadConfig } from '../../config/config';

const RefundDto = z.object({ paymentId: z.string().uuid(), amountCents: z.number().int().positive(), reason: z.string().min(2), funder: z.enum(['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']), incidentId: z.string().uuid().optional() });
const CreditDto = z.object({ userId: z.string().uuid(), cents: z.number().int().positive(), reason: z.string(), funder: z.enum(['PLATFORM', 'MERCHANT']).optional(), orderId: z.string().uuid().optional(), expiresInDays: z.number().int().positive().optional(), organizationId: z.string().uuid().optional() });

@ApiTags('24 Payments & adjustments')
@Controller()
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Public() @Get('public/payments/provider') provider() { return { provider: this.svc.providerName, publishableKey: this.svc.providerName === 'stripe' ? loadConfig().STRIPE_PUBLISHABLE_KEY || null : null }; } // 18.9-S

  /** Raw-body webhook (see main.ts rawBody). Signature header differs per provider. */
  @Public()
  @Post('webhooks/payments')
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') stripeSig?: string, @Headers('x-signature') sig?: string) {
    return this.svc.ingestWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body)), stripeSig || sig);
  }

  @ApiBearerAuth() @Post('payments/setup-card') setup(@CurrentUser() u: JwtPayload) { return this.svc.setupCard(u.email); }
  @ApiBearerAuth() @Get('orders/:id/payment') forOrder(@Param('id') id: string) { return this.svc.listForOrder(id); }
  @ApiBearerAuth() @Get('me/credits') credits(@CurrentUser() u: JwtPayload) { return this.svc.myCredits(u.sub); }
  @ApiBearerAuth() @Post('legal-sellers/:id/payout-onboarding') onboard(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.onboardLegalSeller(u, id); }

  @ApiBearerAuth() @Roles('SUPPORT', 'FINANCE', 'PLATFORM_ADMIN', 'MERCHANT_OWNER', 'MERCHANT_MANAGER')
  @Post('payments/refunds') refund(@CurrentUser() u: JwtPayload, @Body(zod(RefundDto)) b: z.infer<typeof RefundDto>, @Headers('idempotency-key') key?: string) {
    return this.svc.refund({ ...b, approvedById: u.sub, idempotencyKey: key });
  }
  @ApiBearerAuth() @Roles('SUPPORT', 'FINANCE', 'PLATFORM_ADMIN')
  @Post('payments/credits') credit(@Body(zod(CreditDto)) b: z.infer<typeof CreditDto>) { return this.svc.issueCredit(b); }
  @ApiBearerAuth() @Roles('FINANCE', 'PLATFORM_ADMIN')
  @Post('payments/inbox/:id/replay') replay(@Param('id') id: string) { return this.svc.replayInbox(id); }
}
