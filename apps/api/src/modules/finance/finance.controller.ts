import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { SettlementService } from '../settlement/settlement.service';
import { AccountingService } from './accounting.service';
import { FinanceService } from './finance.service';

const range = (from?: string, to?: string, days = 30) => ({ from: from ? new Date(from) : new Date(Date.now() - days * 86400_000), to: to ? new Date(to) : new Date(Date.now() + 60_000) });

@ApiTags('18-20 Payments, settlement & accounting')
@ApiBearerAuth()
@Controller()
export class FinanceController {
  constructor(private readonly fin: FinanceService, private readonly acc: AccountingService, private readonly settle: SettlementService) {}

  // 18 payments
  @Public() @Get('public/locations/:id/payment-methods') methods(@Param('id') id: string, @Query('channel') channel?: string) { return this.fin.methodsFor(id, channel); }
  @Get('admin/payments') console(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.fin.console(u, q); }
  @Get('admin/payments/failures') failures(@CurrentUser() u: JwtPayload, @Query('days') d?: string) { return this.fin.failures(u, Number(d) || 7); }
  @Get('admin/payments/duplicates') duplicates(@CurrentUser() u: JwtPayload, @Query('days') d?: string) { return this.fin.duplicates(u, Number(d) || 30); }
  @Get('admin/payments/unresolved') unresolved(@CurrentUser() u: JwtPayload) { return this.fin.unresolved(u); }
  @Get('admin/payments/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.fin.paymentDetail(u, id); }
  @Post('admin/payments/:id/retry-capture') retry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.fin.retryCapture(u, id); }
  @Post('admin/payments/:id/refund') refund(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ amountCents: z.number().int().positive(), reason: z.string().min(5), funder: z.enum(['MERCHANT', 'PLATFORM']) }))) b: { amountCents: number; reason: string; funder: 'MERCHANT' | 'PLATFORM' }) { return this.fin.refundAllocated(u, id, b); }
  @Post('admin/payments/settlement-file') file(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ csv: z.string().min(3) }))) b: { csv: string }) { return this.fin.settlementFile(u, b.csv, this.settle); }
  @Get('admin/disputes') disputes(@CurrentUser() u: JwtPayload, @Query('status') s?: string) { return this.fin.disputesList(u, s); }
  @Post('admin/disputes/:id/evidence') evidence(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.fin.submitEvidence(u, id, b.note); }
  @Post('admin/disputes/:id/outcome') outcome(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ outcome: z.enum(['WON', 'LOST', 'ACCEPTED']), liability: z.enum(['PLATFORM', 'MERCHANT']).optional(), note: z.string().min(3) }))) b: { outcome: 'WON' | 'LOST' | 'ACCEPTED'; liability?: 'PLATFORM' | 'MERCHANT'; note: string }) { return this.fin.disputeOutcome(u, id, b); }
  @Get('admin/webhooks') webhooks(@CurrentUser() u: JwtPayload, @Query('hours') h?: string) { return this.fin.webhooks(u, Number(h) || 24); }
  @Post('admin/webhooks/:id/replay') replay(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ dryRun: z.boolean().default(true) }))) b: { dryRun: boolean }) { return this.fin.replay(u, id, b.dryRun); }

  // 19 settlement
  @Post('finance/submit-payouts') submit(@CurrentUser() u: JwtPayload) { return this.settle.createBatch(u, { note: 'Submitted from the finance console' }); }
  @Get('finance/payouts') payouts(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.settle.payoutList(u, q); }
  @Get('finance/payout-batches') batches(@CurrentUser() u: JwtPayload) { return this.settle.batches(u); }
  @Post('finance/payout-batches') batch(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ partyType: z.enum(['MERCHANT', 'DRIVER']).optional(), payoutIds: z.array(z.string().uuid()).optional(), note: z.string().optional(), reason: z.string().optional() }))) b: { partyType?: 'MERCHANT' | 'DRIVER'; payoutIds?: string[]; note?: string; reason?: string }) { return this.settle.createBatch(u, b); }
  @Post('finance/payout-batches/:id/request-release') release(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.settle.requestBatchRelease(u, id, b.reason); }
  @Post('finance/payouts/:id/reprocess') reprocess(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.settle.reprocessPayout(u, id, b.reason); }
  @Post('finance/reconcile/transfers') transfers(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ lines: z.array(z.object({ transferId: z.string(), amountCents: z.number().int(), status: z.enum(['paid', 'failed', 'pending']), failureReason: z.string().optional() })) }))) b: { lines: { transferId: string; amountCents: number; status: 'paid' | 'failed' | 'pending'; failureReason?: string }[] }) { return this.settle.reconcileTransfers(u, b.lines); }
  @Post('finance/adjustments') adjust(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ organizationId: z.string().uuid(), cents: z.number().int(), reason: z.string().min(5) }))) b: { organizationId: string; cents: number; reason: string }) { return this.settle.adjustMerchant(u, b); }
  @Get('finance/ledger') ledger(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.settle.ledgerExplorer(u, { ...q, limit: q.limit ? Number(q.limit) : undefined }); }
  @Get('finance/liabilities') liabilities(@CurrentUser() u: JwtPayload) { return this.settle.liabilities(u); }
  @Get('finance/royalties') royalties(@CurrentUser() u: JwtPayload, @Query('from') f?: string, @Query('to') t?: string) { const r = range(f, t); return this.settle.royaltyStatements(u, r.from, r.to); }
  @Get('finance/statement-disputes') sDisputes(@CurrentUser() u: JwtPayload, @Query('organizationId') org?: string) { return this.settle.statementDisputesList(u, org); }
  @Post('finance/statement-disputes/:id/resolve') resolveSD(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ accept: z.boolean(), resolution: z.string().min(3), adjustmentCents: z.number().int().optional() }))) b: { accept: boolean; resolution: string; adjustmentCents?: number }) { return this.settle.resolveStatementDispute(u, id, b); }
  @Get('statements/:id/lines') lines(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.settle.statementLines(u, id); }
  @Post('statements/:id/dispute') disputeStmt(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(10), amountCents: z.number().int().optional() }))) b: { reason: string; amountCents?: number }) { return this.settle.disputeStatement(u, id, b); }

  // 20 accounting
  @Get('accounting/gl-map') gl(@CurrentUser() u: JwtPayload, @Query('entity') e?: string) { return this.acc.glMap(u, e); }
  @Post('accounting/gl-map') setGl(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ legalEntity: z.string().optional(), ledgerAccount: z.string(), glCode: z.string().min(1), glName: z.string().min(1) }))) b: { legalEntity?: string; ledgerAccount: string; glCode: string; glName: string }) { return this.acc.setGl(u, b); }
  @Get('accounting/journal.csv') @Header('Content-Type', 'text/csv') async journal(@CurrentUser() u: JwtPayload, @Query('from') f?: string, @Query('to') t?: string, @Query('entity') e?: string) { const r = range(f, t); return (await this.acc.journalExport(u, r.from, r.to, e)).csv; }
  @Get('accounting/pnl') pnl(@CurrentUser() u: JwtPayload, @Query('by') by?: string, @Query('from') f?: string, @Query('to') t?: string) { const r = range(f, t); return this.acc.pnl(u, (['location', 'entity', 'channel', 'brand'].includes(by || '') ? by : 'total') as 'total', r.from, r.to); }
  @Get('accounting/costs') costs(@CurrentUser() u: JwtPayload, @Query('from') f?: string, @Query('to') t?: string) { const r = range(f, t); return this.acc.costs(u, r.from, r.to); }
  @Get('accounting/credit-liability') credit(@CurrentUser() u: JwtPayload) { return this.acc.creditLiability(u); }
  @Get('accounting/deferred-revenue') deferred(@CurrentUser() u: JwtPayload, @Query('asOf') a?: string) { return this.acc.deferredSchedule(u, a ? new Date(a) : new Date()); }
  @Post('accounting/deferred-revenue/true-up') trueUp(@CurrentUser() u: JwtPayload) { return this.acc.trueUpDeferred(u); }
  @Post('accounting/breakage') breakage(@CurrentUser() u: JwtPayload) { return this.acc.postBreakageAs(u); }
  @Get('accounting/receivables') ar(@CurrentUser() u: JwtPayload) { return this.acc.receivablesAging(u); }
  @Get('accounting/payables') ap(@CurrentUser() u: JwtPayload) { return this.acc.payablesAging(u); }
  @Post('accounting/payables/:id/pay') pay(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reference: z.string().min(2) }))) b: { reference: string }) { return this.acc.payBill(u, id, b.reference); }
  @Get('accounting/cash-forecast') cash(@CurrentUser() u: JwtPayload) { return this.acc.cashForecast(u); }
  @Get('accounting/bank-reconciliation') bankRec(@CurrentUser() u: JwtPayload) { return this.acc.bankReconciliation(u); }
  @Get('accounting/close/:period') close(@CurrentUser() u: JwtPayload, @Param('period') p: string) { return this.acc.closeStatus(u, p); }
  @Post('accounting/close/:period/tick') tick(@CurrentUser() u: JwtPayload, @Param('period') p: string, @Body(zod(z.object({ key: z.string(), done: z.boolean() }))) b: { key: string; done: boolean }) { return this.acc.tickClose(u, p, b.key, b.done); }
  @Post('accounting/close/:period') closeMonth(@CurrentUser() u: JwtPayload, @Param('period') p: string, @Body(zod(z.object({ force: z.boolean().optional(), reason: z.string().optional() }).optional())) b?: { force?: boolean; reason?: string }) { return this.acc.closeMonth(u, p, b || {}); }
  @Get('accounting/budgets/:period') budgets(@CurrentUser() u: JwtPayload, @Param('period') p: string) { return this.acc.budgetVsActual(u, p); }
  @Post('accounting/budgets') setBudget(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ costCenter: z.string().min(1), period: z.string().regex(/^\d{4}-\d{2}$/), category: z.enum(['REVENUE', 'COGS', 'LABOR', 'DELIVERY', 'PROCESSING', 'PROMOTION', 'REFUNDS', 'OTHER']), amountCents: z.number().int() }))) b: { costCenter: string; period: string; category: string; amountCents: number }) { return this.acc.setBudget(u, b); }
  @Get('accounting/approval-limits') limits(@CurrentUser() u: JwtPayload) { return this.acc.approvalLimits(u); }
  @Get('accounting/audit-export') auditExport(@CurrentUser() u: JwtPayload, @Query('from') f?: string, @Query('to') t?: string) { const r = range(f, t); return this.acc.auditExport(u, r.from, r.to); }
}
