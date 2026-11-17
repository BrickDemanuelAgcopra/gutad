import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { OrdersService } from './orders.service';
import { QuoteService } from './quote.service';

const AddressDto = z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), instructions: z.string().optional(), contactName: z.string().optional(), contactPhone: z.string().optional() });
const QuoteDto = z.object({
  locationId: z.string().uuid(),
  channel: z.enum(['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'KIOSK', 'PARTNER', 'PHONE', 'WALK_IN', 'CAMPUS', 'CORPORATE', 'API']).default('MARKETPLACE'),
  fulfillmentType: z.enum(['PICKUP', 'DELIVERY', 'DINE_IN', 'CATERING']).default('PICKUP'),
  lines: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1).max(50), modifierOptionIds: z.array(z.string().uuid()).optional(), specialInstructions: z.string().max(300).optional(), chefRequestQuoteId: z.string().uuid().optional() })).min(1),
  scheduledFor: z.string().nullable().optional(),
  tipCents: z.number().int().min(0).optional(),
  promoCode: z.string().optional(),
  deliveryAddress: AddressDto.optional(),
  useCreditsCents: z.number().int().min(0).optional(),
  useLoyaltyPoints: z.number().int().min(0).optional(),
  useGiftBalance: z.boolean().optional(),
  holdKey: z.string().max(80).optional(),
  replacesOrderId: z.string().uuid().optional(),
});
const CheckoutDto = z.object({ tableNumber: z.string().max(10).optional(), utensils: z.boolean().optional(), quoteId: z.string().uuid(), paymentMethodId: z.string().optional(), savedPaymentMethodId: z.string().uuid().optional(), guest: z.object({ name: z.string(), email: z.string().email(), phone: z.string().optional() }).optional(), specialInstructions: z.string().max(500).optional(), groupOrderId: z.string().uuid().optional(), campusAccountId: z.string().uuid().optional() });
const GroupCheckoutDto = CheckoutDto.omit({ quoteId: true, tableNumber: true, groupOrderId: true, campusAccountId: true }).extend({ quoteIds: z.array(z.string().uuid()).min(1).max(6) });
const CounterDto = z.object({ lines: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1), modifierOptionIds: z.array(z.string().uuid()).optional() })).min(1), guestName: z.string(), guestPhone: z.string().optional(), fulfillmentType: z.enum(['PICKUP', 'DINE_IN']).optional(), channel: z.enum(['PHONE', 'WALK_IN']).optional() });
const ReasonDto = z.object({ reason: z.string().min(2) });
const StaffCancelDto = z.object({ reason: z.string().min(2), funder: z.enum(['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']) });
const ResolveDto = z.object({ lineId: z.string().uuid(), choice: z.enum(['REPLACE', 'CREDIT']), replacementNote: z.string().optional() });

@ApiTags('06/07/08/11 Cart, checkout, intake, pickup')
@Controller()
export class OrdersController {
  constructor(private readonly svc: OrdersService, private readonly quotes: QuoteService) {}

  @Public() @Post('quotes') quote(@CurrentUser() u: JwtPayload | undefined, @Body(zod(QuoteDto)) b: z.infer<typeof QuoteDto>) { return this.quotes.quote({ ...b, userId: u?.sub ?? null }); }
  @Public() @Get('quotes/:id') getQuote(@Param('id') id: string) { return this.quotes.get(id); }
  @Public() @Post('quotes/:id/revalidate') revalidate(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string) { return this.quotes.revalidate(id, u?.sub); }
  @Public() @Get('public/locations/:id/local-time') localTime(@Param('id') id: string, @Query('date') date: string, @Query('time') time: string) { return this.quotes.localToIso(id, date, time); }

  @Public() @Post('orders') checkout(@CurrentUser() u: JwtPayload | undefined, @Body(zod(CheckoutDto)) b: z.infer<typeof CheckoutDto>, @Headers('idempotency-key') key?: string) { return this.svc.checkout(u ?? null, { ...b, idempotencyKey: key }); }
  @Public() @Post('checkout-groups') checkoutGroup(@CurrentUser() u: JwtPayload | undefined, @Body(zod(GroupCheckoutDto)) b: z.infer<typeof GroupCheckoutDto>, @Headers('idempotency-key') key?: string) { return this.svc.checkoutGroup(u ?? null, { ...b, idempotencyKey: key }); }
  @Public() @Get('checkout-groups/:id') group(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Query('email') email?: string) { return this.svc.presentGroup(id, { user: u ?? null, email }); }
  @Public() @Get('orders/:id/cancellation') cancellation(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Query('email') email?: string) { return this.svc.cancellationPreview(u ?? null, id, email); }
  @Public() @Get('orders/:id') get(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Query('email') email?: string) { return this.svc.getForCustomer(u ?? null, id, email); }
  @ApiBearerAuth() @Get('me/orders') mine(@CurrentUser() u: JwtPayload) { return this.svc.myOrders(u); }
  @ApiBearerAuth() @Get('orders/:id/timeline') timeline(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.timeline(u, id); }
  @ApiBearerAuth() @Post('orders/:id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReasonDto)) b: z.infer<typeof ReasonDto>) { return this.svc.cancelByCustomer(u, id, b.reason); }
  @ApiBearerAuth() @Post('orders/:id/reorder') reorder(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ fulfillmentType: z.enum(['PICKUP', 'DELIVERY']).optional(), mode: z.enum(['quote', 'cart']).optional() }))) b: { fulfillmentType?: 'PICKUP' | 'DELIVERY'; mode?: 'quote' | 'cart' }) { return b.mode === 'cart' ? this.svc.reorderCart(u, id) : this.svc.reorder(u, id, b.fulfillmentType); }
  @ApiBearerAuth() @Get('orders/:id/amendment') amendment(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.amendment(u, id); }
  @ApiBearerAuth() @Post('orders/:id/amend') amend(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CheckoutDto.pick({ quoteId: true, paymentMethodId: true, savedPaymentMethodId: true, specialInstructions: true }))) b: { quoteId: string; paymentMethodId?: string; savedPaymentMethodId?: string; specialInstructions?: string }, @Headers('idempotency-key') key?: string) { return this.svc.amend(u, id, { ...b, idempotencyKey: key }); }
  @ApiBearerAuth() @Post('orders/:id/resolve-line') resolve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ResolveDto)) b: z.infer<typeof ResolveDto>) { return this.svc.resolveUnavailableLine(u, id, b.lineId, b.choice, b.replacementNote); }

  // merchant intake
  @ApiBearerAuth() @Get('locations/:id/orders') inbox(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('status') status?: string) { return this.svc.inbox(u, id, status ? (status.split(',') as never) : undefined); }
  @ApiBearerAuth() @Post('locations/:id/orders/counter') counter(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CounterDto)) b: z.infer<typeof CounterDto>) { return this.svc.counterOrder(u, id, b); }
  @ApiBearerAuth() @Post('orders/:id/accept') accept(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ prepMinutes: z.number().int().positive().optional() }))) b: { prepMinutes?: number }) { return this.svc.accept(u, id, b.prepMinutes); }
  @ApiBearerAuth() @Post('orders/:id/reject') reject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ReasonDto)) b: z.infer<typeof ReasonDto>) { return this.svc.reject(u, id, b.reason); }
  @ApiBearerAuth() @Post('orders/:id/prep-time') prep(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ prepMinutes: z.number().int().positive() }))) b: { prepMinutes: number }) { return this.svc.adjustTime(u, id, b.prepMinutes); }
  @ApiBearerAuth() @Post('orders/:id/ready') ready(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.markReady(u, id); }
  /** Run the pickup no-show sweep now (normally every minute). `at` is honored only when ALLOW_BILLING_TIME_TRAVEL=true (tests). */
  @ApiBearerAuth() @Post('admin/jobs/pickup-no-show') noShow(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) { assertCan(u, 'ops.manage'); return this.svc.noShowSweep(b.at && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(b.at) : new Date()); }
  @ApiBearerAuth() @Post('orders/:id/handoff') handoff(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ pickupCode: z.string().optional(), receiverName: z.string().max(80).optional(), courierId: z.string().uuid().optional(), tableNumber: z.string().max(10).optional() }))) b: { pickupCode?: string; receiverName?: string; courierId?: string; tableNumber?: string }) { return this.svc.handoff(u, id, b.pickupCode, b); }
  @ApiBearerAuth() @Post('orders/:id/staff-cancel') staffCancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(StaffCancelDto)) b: z.infer<typeof StaffCancelDto>) { return this.svc.cancelByStaff(u, id, b.reason, b.funder); }
}
