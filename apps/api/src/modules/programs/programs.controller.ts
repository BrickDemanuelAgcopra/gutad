import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequiresFeature } from '../entitlements/requires-feature';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { GroupOrdersService } from './group-orders.service';
import { MealKitsService } from './meal-kits.service';
import { ProgramsService } from './programs.service';

const AddressDto = z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), instructions: z.string().optional(), contactName: z.string().optional(), contactPhone: z.string().optional() });
const LinesDto = z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1), modifierOptionIds: z.array(z.string().uuid()).optional(), specialInstructions: z.string().optional() })).min(1);
const GroupDto = z.object({ locationId: z.string().uuid(), organizationId: z.string().uuid().optional(), budgetId: z.string().uuid().optional(), mode: z.enum(['SHARED_BASKET', 'INDIVIDUAL', 'CATERING_TRAYS']), name: z.string(), cutoffAt: z.string(), deliverAt: z.string(), fulfillmentType: z.enum(['DELIVERY', 'PICKUP', 'CATERING']).optional(), deliveryAddress: AddressDto.optional(), headcount: z.number().int().optional(), dietaryNotes: z.string().optional(), payer: z.enum(['ORGANIZER', 'EMPLOYER_INVOICE', 'INDIVIDUAL']).optional() });
const ChoiceDto = z.object({ name: z.string(), email: z.string().email().optional(), lines: LinesDto });
const KitProductDto = z.object({ sku: z.string(), name: z.string(), description: z.string().optional(), imageUrl: z.string().optional(), priceCents: z.number().int().min(0), weightGrams: z.number().int().optional(), shipRegions: z.array(z.string()).optional(), leadDays: z.number().int().min(0).optional(), stockOnHand: z.number().int().min(0).optional(), isActive: z.boolean().optional(), locationId: z.string().uuid().optional() });
const KitOrderDto = z.object({ lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1), deliveryDate: z.string(), address: AddressDto, paymentMethodId: z.string().optional() });
const ProgramDto = z.object({ type: z.enum(['CAMPUS', 'B2B_OPERATOR', 'CREATOR_BRAND']), name: z.string(), config: z.record(z.unknown()).optional() });
const TransitionDto = z.object({ status: z.enum(['QUALIFIED', 'CONTRACTED', 'TESTING', 'ACTIVE', 'OFFBOARDED']), contractRef: z.string().optional(), compensationBps: z.number().int().optional(), locationIds: z.array(z.string().uuid()).optional(), brandId: z.string().uuid().optional() });

@ApiTags('18/19/20 Group orders, meal kits, programs')
@Controller()
export class ProgramsController {
  constructor(private readonly groups: GroupOrdersService, private readonly kits: MealKitsService, private readonly programs: ProgramsService) {}

  // 18
  @ApiBearerAuth() @Post('organizations/:id/budgets') budget(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ name: z.string(), perPersonCents: z.number().int(), periodCents: z.number().int().optional() }))) b: { name: string; perPersonCents: number; periodCents?: number }) { return this.groups.createBudget(u, id, b); }
  @ApiBearerAuth() @RequiresFeature('group_orders', 'body:locationId', 'customer') @Post('group-orders') createGroup(@CurrentUser() u: JwtPayload, @Body(zod(GroupDto)) b: z.infer<typeof GroupDto>) { return this.groups.create(u, b); }
  @ApiBearerAuth() @Get('me/group-orders') myGroups(@CurrentUser() u: JwtPayload) { return this.groups.myGroupOrders(u); }
  @Public() @Get('public/group-orders/:code') getGroup(@Param('code') code: string) { return this.groups.get(code); }
  @Public() @Post('public/group-orders/:code/choices') choose(@CurrentUser() u: JwtPayload | undefined, @Param('code') code: string, @Body(zod(ChoiceDto)) b: z.infer<typeof ChoiceDto>) { return this.groups.submitChoice(u ?? null, code, b); }
  @ApiBearerAuth() @Post('group-orders/:code/submit') submitGroup(@CurrentUser() u: JwtPayload, @Param('code') code: string, @Body(zod(z.object({ paymentMethodId: z.string().optional() }))) b: { paymentMethodId?: string }) { return this.groups.submit(u, code, b.paymentMethodId); }
  @ApiBearerAuth() @Get('group-orders/:code/receipts') receipts(@Param('code') code: string) { return this.groups.receipts(code); }
  @ApiBearerAuth() @Post('group-orders/:code/participants/:pid/cancel') cancelPart(@CurrentUser() u: JwtPayload, @Param('code') code: string, @Param('pid') pid: string) { return this.groups.cancelParticipant(u, code, pid); }

  // 19
  @Public() @Get('public/meal-kits') kitCatalog(@Query('region') region?: string) { return this.kits.catalog(region); }
  @ApiBearerAuth() @Post('meal-kits/products') kitProduct(@CurrentUser() u: JwtPayload, @Body(zod(KitProductDto)) b: z.infer<typeof KitProductDto>) { return this.kits.upsertProduct(u, b); }
  @ApiBearerAuth() @Post('meal-kits/orders') kitOrder(@CurrentUser() u: JwtPayload, @Body(zod(KitOrderDto)) b: z.infer<typeof KitOrderDto>, @Headers('idempotency-key') key?: string) { return this.kits.order(u, { ...b, idempotencyKey: key }); }
  @ApiBearerAuth() @Get('me/shipments') shipments(@CurrentUser() u: JwtPayload) { return this.kits.myShipments(u); }
  @ApiBearerAuth() @Post('meal-kits/batches') batch(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ deliveryDate: z.string() }))) b: { deliveryDate: string }) { return this.kits.createBatch(u, b.deliveryDate); }
  @ApiBearerAuth() @Post('shipments/:id/transition') shipTransition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ status: z.enum(['PACKED', 'SHIPPED', 'DELIVERED', 'FAILED', 'RETURNED']), carrier: z.string().optional(), trackingNumber: z.string().optional() }))) b: { status: 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'FAILED' | 'RETURNED'; carrier?: string; trackingNumber?: string }) { const { status, ...d } = b; return this.kits.transition(u, id, status, d); }
  @ApiBearerAuth() @Post('shipments/:id/cases') openCase(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ lineId: z.string().uuid().optional(), kind: z.enum(['MISSING', 'DAMAGED', 'FAILED_DELIVERY']), description: z.string().optional() }))) b: { lineId?: string; kind: 'MISSING' | 'DAMAGED' | 'FAILED_DELIVERY'; description?: string }) { return this.kits.openCase(u, id, b); }
  @ApiBearerAuth() @Post('shipment-cases/:id/resolve') resolveCase(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ remedy: z.enum(['REPLACEMENT', 'CREDIT', 'REFUND']) }))) b: { remedy: 'REPLACEMENT' | 'CREDIT' | 'REFUND' }) { return this.kits.resolveCase(u, id, b.remedy); }

  // 20
  @ApiBearerAuth() @Post('organizations/:id/programs') apply(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ProgramDto)) b: z.infer<typeof ProgramDto>) { return this.programs.apply(u, id, b); }
  @ApiBearerAuth() @Get('organizations/:id/programs') listPrograms(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.programs.list(u, id); }
  @ApiBearerAuth() @Post('programs/:id/transition') programTransition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(TransitionDto)) b: z.infer<typeof TransitionDto>) { const { status, ...rest } = b; return this.programs.transition(u, id, status, rest); }
  @ApiBearerAuth() @Post('programs/:id/campus-accounts') enroll(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ userId: z.string().uuid(), campusUserId: z.string(), balanceCents: z.number().int().optional(), mealSwipes: z.number().int().optional() }))) b: { userId: string; campusUserId: string; balanceCents?: number; mealSwipes?: number }) { return this.programs.enrollCampusUser(u, id, b); }
  @ApiBearerAuth() @Get('me/campus') myCampus(@CurrentUser() u: JwtPayload) { return this.programs.myCampus(u); }
  @ApiBearerAuth() @Post('campus/orders') campusOrder(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ programId: z.string().uuid(), locationId: z.string().uuid(), lines: LinesDto, scheduledFor: z.string().optional() }))) b: { programId: string; locationId: string; lines: z.infer<typeof LinesDto>; scheduledFor?: string }, @Headers('idempotency-key') key?: string) { return this.programs.campusOrder(u, { ...b, idempotencyKey: key }); }
  @ApiBearerAuth() @Post('campus/orders/:id/reverse') reverse(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.programs.reverseCampusDebit(u, id); }
  @ApiBearerAuth() @Get('programs/:id/campus-statement') campusStatement(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.programs.campusStatement(u, id, from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000), to ? new Date(to) : new Date()); }
  @ApiBearerAuth() @Post('programs/:id/b2b-orders') b2b(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ items: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int().min(1), unitCents: z.number().int().min(0) })).min(1) }))) b: { items: { sku: string; name: string; quantity: number; unitCents: number }[] }) { return this.programs.b2bOrder(u, id, b); }
  @ApiBearerAuth() @Post('b2b-orders/:id/invoice') b2bInvoice(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.programs.b2bFulfillAndInvoice(u, id); }
}
