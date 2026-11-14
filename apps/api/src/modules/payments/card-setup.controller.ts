import { BadRequestException, Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { appReturnAllowed, CardSetupService } from './card-setup.service';

/** 10.3-P / 18.9-S processor card tokenization (SetupIntent, hosted setup page). */
@ApiTags('24 Payments & adjustments')
@Controller()
export class CardSetupController {
  constructor(private readonly svc: CardSetupService) {}

  @Public() @Get('public/payments/client-config') config() { return this.svc.clientConfig(); }

  @ApiBearerAuth() @Post('me/payment-methods/setup') start(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ hosted: z.boolean().optional(), returnTo: z.string().max(200).optional() }))) b: { hosted?: boolean; returnTo?: string }) { return this.svc.start(u, b); }
  @ApiBearerAuth() @Post('me/payment-methods/setup/complete') complete(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ sessionId: z.string().min(3).max(200) }))) b: { sessionId: string }) { return this.svc.complete(u, b.sessionId); }

  /** The processor's hosted page returns here; the browser is sent on to the app's deep link. */
  @Public() @Get('public/payments/setup-return') back(@Query('to') to: string, @Query('status') status: string, @Query('session_id') sessionId: string, @Res() res: Response) {
    if (!to || !appReturnAllowed(to)) throw new BadRequestException('Unsupported return link');
    const q = new URLSearchParams({ status: status === 'done' ? 'done' : 'canceled', ...(sessionId ? { session_id: sessionId } : {}) });
    res.redirect(302, `${to}${to.includes('?') ? '&' : '?'}${q}`);
  }
}
