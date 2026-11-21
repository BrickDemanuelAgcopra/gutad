import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CAMPAIGN_KINDS, FRAUD_DECISIONS, RISK_SIGNAL_TYPES } from '@gutad/shared';
import { assertCan, CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { CourierForecastService } from './courier-forecast.service';
import { CourierFraudService } from './courier-fraud.service';
import { CourierIncentivesService } from './courier-incentives.service';
import { CourierPayoutsService } from './courier-payouts.service';
import { DeliveryService } from './delivery.service';

const Rules = z.object({
  boostCents: z.number().int().min(0).max(10_000).optional(),
  boostPercent: z.number().min(0).max(200).optional(),
  tiers: z.array(z.object({ deliveries: z.number().int().min(1).max(500), bonusCents: z.number().int().min(1).max(100_000) })).max(5).optional(),
  minPerHourCents: z.number().int().min(0).max(20_000).optional(),
  minOnlineMinutes: z.number().int().min(0).max(1440).optional(),
}).strict();
const Eligibility = z.object({ minRating: z.number().min(1).max(5).nullable().optional(), vehicleTypes: z.array(z.string()).optional(), minDeliveries: z.number().int().min(0).nullable().optional() }).strict();
const CampaignBase = {
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  marketIds: z.array(z.string().uuid()).optional(),
  zoneIds: z.array(z.string().uuid()).optional(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  rules: Rules,
  eligibility: Eligibility.optional(),
  enrolment: z.enum(['AUTO', 'OPT_IN']).optional(),
  budgetCents: z.number().int().min(100).max(100_000_000),
};
const CreateCampaign = z.object({ kind: z.enum(CAMPAIGN_KINDS), ...CampaignBase, reason: z.string().trim().max(500).optional() });
const UpdateCampaign = z.object({ ...Object.fromEntries(Object.entries(CampaignBase).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), kind: z.enum(CAMPAIGN_KINDS).optional(), reason: z.string().trim().min(3).max(500) });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const Decide = z.object({ decision: z.enum(FRAUD_DECISIONS), reason: z.string().trim().min(3).max(1000), noticeToCourier: z.string().trim().min(10).max(1000), clawbackEarningIds: z.array(z.string().uuid()).max(200).optional() });

/** Courier Release 3: forecast and busy times, incentive campaigns, fraud review, instant payouts, reconciliation postings. */
@ApiTags('12/13 Delivery & drivers')
@ApiBearerAuth()
@Controller()
export class CourierR3Controller {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly forecast: CourierForecastService,
    private readonly incentives: CourierIncentivesService,
    private readonly fraud: CourierFraudService,
    private readonly payouts: CourierPayoutsService,
  ) {}

  // ───── courier ─────
  @Get('driver/busy-times') async busy(@CurrentUser() u: JwtPayload, @Query('days') days?: string) { const d = await this.delivery.myDriver(u); return this.forecast.busyTimes(d.zoneIds, Number(days) || 3); }
  @Get('driver/campaigns') async campaigns(@CurrentUser() u: JwtPayload) { return this.incentives.forCourier(await this.delivery.myDriver(u)); }
  @Post('driver/campaigns/:id/join') async join(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.incentives.join(await this.delivery.myDriver(u), id); }
  @Get('driver/payouts/instant') async instant(@CurrentUser() u: JwtPayload) { const d = await this.delivery.myDriver(u); return { ...(await this.payouts.instantStatus(d)), recent: await this.payouts.recentInstant(d.id) }; }
  @Post('driver/payouts/instant') async cashOut(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ amountCents: z.number().int().min(1).optional() }))) b: { amountCents?: number }) { return this.payouts.cashOut(await this.delivery.myDriver(u), b.amountCents); }
  @Get('driver/notices') async notices(@CurrentUser() u: JwtPayload) { return this.fraud.notices((await this.delivery.myDriver(u)).id); }

  // ───── forecast ─────
  @Get('admin/delivery/forecast') adminForecast(@CurrentUser() u: JwtPayload, @Query('zoneId') zoneId?: string, @Query('from') from?: string, @Query('to') to?: string) { return this.forecast.adminForecast(u, { zoneId, from, to }); }
  /** `at` (tests only, ALLOW_BILLING_TIME_TRAVEL=true) builds the forecast as if it were that time. */
  @Post('admin/delivery/forecast/rebuild') rebuild(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) { assertCan(u, 'delivery.manage'); return this.forecast.rebuild(b.at && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(b.at) : new Date()); }

  // ───── campaigns ─────
  @Get('admin/courier-campaigns') list(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.incentives.list(u, status); }
  @Post('admin/courier-campaigns') create(@CurrentUser() u: JwtPayload, @Body(zod(CreateCampaign)) b: z.infer<typeof CreateCampaign>) { return this.incentives.create(u, b); }
  @Get('admin/courier-campaigns/:id') detail(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.incentives.detail(u, id); }
  @Put('admin/courier-campaigns/:id') update(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(UpdateCampaign)) b: Record<string, unknown> & { reason: string }) { return this.incentives.update(u, id, b); }
  @Post('admin/courier-campaigns/:id/activate') activate(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Reason)) b: { reason: string }) { return this.incentives.activate(u, id, b.reason); }
  @Post('admin/courier-campaigns/:id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Reason)) b: { reason: string }) { return this.incentives.cancel(u, id, b.reason); }
  @Post('admin/courier-campaigns/sweep') sweep(@CurrentUser() u: JwtPayload) { assertCan(u, 'delivery.manage'); return this.incentives.sweep(); }

  // ───── fraud ─────
  @Get('admin/courier-fraud/cases') cases(@CurrentUser() u: JwtPayload, @Query('status') status?: string) { return this.fraud.cases(u, status || 'OPEN'); }
  @Get('admin/courier-fraud/cases/:id') caseDetail(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { return this.fraud.caseDetail(u, id); }
  @Post('admin/courier-fraud/cases/:id/decide') decide(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(Decide)) b: z.infer<typeof Decide>) { return this.fraud.decide(u, id, b); }
  @Post('admin/courier-fraud/sweep') fraudSweep(@CurrentUser() u: JwtPayload) { assertCan(u, 'delivery.manage'); return this.fraud.patternSweep(); }
  @Post('admin/couriers/:id/risk-signals') manual(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(zod(z.object({ type: z.enum(RISK_SIGNAL_TYPES), note: z.string().trim().min(3).max(1000) }))) b: { type: (typeof RISK_SIGNAL_TYPES)[number]; note: string }) { return this.fraud.manual(u, id, b); }
  @Get('admin/couriers/:id/risk') risk(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) { assertCan(u, 'delivery.read', 'ops.read'); return this.fraud.scoreFor(id); }

  // ───── reconciliation ─────
  @Post('admin/delivery/reconciliation/run') recon(@CurrentUser() u: JwtPayload) { return this.payouts.runRecon(u); }
}
