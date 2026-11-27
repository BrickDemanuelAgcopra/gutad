import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { CustomerFeeRules, DeliveryPricing } from '@gutad/shared';
import { CurrentUser, JwtPayload } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { PricingService } from './pricing.service';

const List = z.array(z.string());
const Cents = z.number().int().min(0).max(100_000);
const FeeRuleDto = z.object({ baseCents: Cents, perKmCents: Cents, minCents: Cents, maxCents: Cents });
const DeliveryPricingDto = z.object({
  platformFreeDelivery: z.boolean(),
  platform: FeeRuleDto,
  partner: FeeRuleDto.extend({ mode: z.enum(['PASS_THROUGH', 'DISTANCE']), markupCents: Cents, markupBps: z.number().int().min(0).max(10_000) }),
  merchant: z.object({ storeSetsFee: z.boolean(), maxBaseCents: Cents, maxPerKmCents: Cents, maxCents: Cents }),
  storeFreeDelivery: z.object({ allowed: z.boolean(), minThresholdCents: Cents }),
});
const FeeRulesDto = z.object({
  service: z.object({ bps: z.number().int().min(0).max(3000), minCents: z.number().int().min(0), capCents: z.number().int().min(0), channels: List, fulfillments: List }),
  smallOrder: z.object({ thresholdCents: z.number().int().min(0), feeCents: z.number().int().min(0), channels: List, fulfillments: List }),
  packaging: z.object({ perOrderCents: z.number().int().min(0), perItemCents: z.number().int().min(0), fulfillments: List }),
});
const CartDto = z.object({
  locationId: z.string().uuid(),
  channel: z.string(),
  fulfillmentType: z.string(),
  lines: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1), modifierOptionIds: z.array(z.string().uuid()).optional() })).min(1),
  promoCode: z.string().optional(),
  tipCents: z.number().int().min(0).optional(),
  deliveryAddress: z.object({ line1: z.string(), city: z.string(), region: z.string(), postalCode: z.string(), lat: z.number().optional(), lng: z.number().optional() }).optional(),
});
const DraftDto = z.object({ feeRules: FeeRulesDto.optional(), taxRates: z.record(z.number().int().min(0)).optional(), priceOverrides: z.record(z.number().int().min(0)).optional() });

@ApiTags('09 Pricing, fees & tax')
@ApiBearerAuth()
@Controller()
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Get('admin/pricing/delivery') deliveryFees(@CurrentUser() u: JwtPayload) { return this.svc.deliveryFees(u); }
  @Post('admin/pricing/delivery') requestDeliveryFees(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ policy: DeliveryPricingDto, reason: z.string().min(5) }))) b: { policy: DeliveryPricing; reason: string }) { return this.svc.requestDeliveryFees(u, b.policy, b.reason); }
  @Get('admin/pricing/fees') fees(@CurrentUser() u: JwtPayload) { return this.svc.fees(u); }
  @Post('admin/pricing/fees') requestFees(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ rules: FeeRulesDto, reason: z.string().min(5) }))) b: { rules: CustomerFeeRules; reason: string }) { return this.svc.requestFees(u, b.rules, b.reason); }
  @Get('admin/pricing/overview') overview(@CurrentUser() u: JwtPayload) { return this.svc.overview(u); }
  @Get('admin/pricing/tax-engine') taxEngine(@CurrentUser() u: JwtPayload) { return this.svc.taxEngineInfo(u); }
  @Post('pricing/simulate') simulate(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ cart: CartDto, draft: DraftDto }))) b: { cart: z.infer<typeof CartDto>; draft: z.infer<typeof DraftDto> }) { return this.svc.simulate(u, b.cart as never, b.draft); }
  @Get('tax-rates') taxRates(@CurrentUser() u: JwtPayload, @Query('locationId') locationId?: string) { return this.svc.taxRates(u, locationId); }
  @Post('admin/tax-rates') upsertTax(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ id: z.string().uuid().optional(), locationId: z.string().uuid().nullable().optional(), region: z.string().nullable().optional(), category: z.string(), rateBps: z.number().int().min(0).max(5000), label: z.string().optional() }))) b: { id?: string; locationId?: string | null; region?: string | null; category: string; rateBps: number; label?: string }) { return this.svc.upsertTaxRate(u, b); }
  @Delete('admin/tax-rates/:id') deleteTax(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.deleteTaxRate(u, id); }
  @Get('admin/membership-plans') memberships(@CurrentUser() u: JwtPayload) { return this.svc.membershipPlans(u); }
  @Patch('admin/membership-plans/:id') updateMembership(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ name: z.string().optional(), priceCents: z.number().int().min(0).optional(), isActive: z.boolean().optional(), trialDays: z.number().int().min(0).max(90).optional(), benefits: z.object({ freeDeliveryAboveCents: z.number().int().min(0).optional(), serviceFeeWaived: z.boolean().optional(), creditCentsPerMonth: z.number().int().min(0).optional(), priorityWaitlist: z.boolean().optional() }).optional() }))) b: { name?: string; priceCents?: number; isActive?: boolean; benefits?: Record<string, unknown> }) { return this.svc.updateMembershipPlan(u, id, b); }
}
