import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { SettlementService } from './settlement.service';

const PeriodDto = z.object({ periodStart: z.coerce.date(), periodEnd: z.coerce.date(), organizationId: z.string().uuid().optional() });
const BankDto = z.object({ externalId: z.string(), amountCents: z.number().int(), currency: z.string().default('USD'), description: z.string().optional(), payoutId: z.string().uuid().optional() });
const ProcessorDto = z.object({ lines: z.array(z.object({ providerChargeId: z.string(), amountCents: z.number().int(), feeCents: z.number().int() })) });
const ProviderInvoiceDto = z.object({ provider: z.string(), externalId: z.string(), periodStart: z.string(), periodEnd: z.string(), lines: z.array(z.object({ providerJobId: z.string(), cents: z.number().int() })) });

@ApiTags('26 Settlement & reconciliation')
@ApiBearerAuth()
@Controller()
export class SettlementController {
  constructor(private readonly svc: SettlementService) {}

  @Get('organizations/:id/balance') balance(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.merchantBalance(u, id); }
  @Get('organizations/:id/statements') statements(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.statements(u, id); }
  @Get('statements/:id') statement(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.statementDetail(u, id); }
  @Get('organizations/:id/invoices') invoices(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.invoicesFor(u, id); }
  @Post('invoices/:id/pay') pay(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ paymentMethodId: z.string().optional() }))) b: { paymentMethodId?: string }) { return this.svc.payInvoice(u, id, b.paymentMethodId); }

  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/close-period') close(@Body(zod(PeriodDto)) b: z.infer<typeof PeriodDto>) { return this.svc.closePeriod(b.periodStart, b.periodEnd, b.organizationId); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/close-driver-period') closeDrivers(@Body(zod(PeriodDto)) b: z.infer<typeof PeriodDto>) { return this.svc.closeDriverPeriod(b.periodStart, b.periodEnd); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/reconcile/bank') bank(@CurrentUser() u: JwtPayload, @Body(zod(BankDto)) b: z.infer<typeof BankDto>) { return this.svc.reconcileBankLine(u, b); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/reconcile/processor') processor(@CurrentUser() u: JwtPayload, @Body(zod(ProcessorDto)) b: z.infer<typeof ProcessorDto>) { return this.svc.reconcileProcessorLines(u, b.lines); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/provider-invoices') providerInvoice(@CurrentUser() u: JwtPayload, @Body(zod(ProviderInvoiceDto)) b: z.infer<typeof ProviderInvoiceDto>) { return this.svc.ingestProviderInvoice(u, b); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Get('finance/unmatched') unmatched(@CurrentUser() u: JwtPayload) { return this.svc.unmatchedQueue(u); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Post('finance/unmatched/:id/resolve') resolve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ resolution: z.string() }))) b: { resolution: string }) { return this.svc.resolveUnmatched(u, id, b.resolution); }
  @Roles('FINANCE', 'PLATFORM_ADMIN') @Get('finance/integrity') integrity() { return this.svc.integrity(); }
}
