import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { AccountingService } from './accounting.service';
import { GlPushService } from './gl-push.service';

const Period = z.string().regex(/^\d{4}-\d{2}$/);

/** 20.1-L general-ledger push and 20.7-L ledger lock (reopen override, manual journals). */
@ApiTags('18-20 Payments, settlement & accounting')
@ApiBearerAuth()
@Controller()
export class GlController {
  constructor(private readonly gl: GlPushService, private readonly acc: AccountingService) {}

  @Get('accounting/gl/connection') connection(@CurrentUser() u: JwtPayload, @Query('entity') e?: string) { return this.gl.connection(u, e || 'GUTAD'); }
  @Post('accounting/gl/connection') connect(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ legalEntity: z.string().min(1).optional(), provider: z.enum(['MOCK', 'QBO', 'XERO']), externalTenantId: z.string().nullable().optional(), credentials: z.record(z.string()).optional(), config: z.record(z.unknown()).optional() }))) b: Parameters<GlPushService['connect']>[1]) { return this.gl.connect(u, b); }
  @Delete('accounting/gl/connection') disconnect(@CurrentUser() u: JwtPayload, @Query('entity') e?: string) { return this.gl.disconnect(u, e || 'GUTAD'); }
  @Post('accounting/gl/push') push(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ period: Period, legalEntity: z.string().min(1).optional(), allowOpen: z.boolean().optional() }))) b: { period: string; legalEntity?: string; allowOpen?: boolean }) { return this.gl.push(u, b); }
  @Post('accounting/gl/push-batches/:id/retry') retry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gl.retry(u, id); }

  @Get('accounting/ledger-lock') lock(@CurrentUser() u: JwtPayload) { return this.acc.ledgerLock(u); }
  @Post('accounting/close/:period/reopen') reopen(@CurrentUser() u: JwtPayload, @Param('period') p: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.acc.reopenMonth(u, p, b.reason); }
  @Post('accounting/journals') manual(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), memo: z.string().min(3), currency: z.string().length(3).optional(), lines: z.array(z.object({ account: z.string(), debitCents: z.number().int().min(0).optional(), creditCents: z.number().int().min(0).optional(), memo: z.string().optional() })).min(2) }))) b: Parameters<AccountingService['manualJournal']>[1]) { return this.acc.manualJournal(u, b); }
}
