import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DeliveryService } from './delivery.service';

const AddressDto = z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), instructions: z.string().optional(), contactName: z.string().optional(), contactPhone: z.string().optional() });
const ZoneDto = z.object({ id: z.string().uuid().optional(), name: z.string(), polygon: z.unknown().optional(), feeCents: z.number().int().min(0), minOrderCents: z.number().int().min(0).optional(), etaMinutes: z.number().int().positive().optional(), isActive: z.boolean().optional() });
const ExternalDto = z.object({ externalOrderId: z.string(), dropoff: AddressDto, orderValueCents: z.number().int().min(0), tipCents: z.number().int().min(0).optional() });
const TransitionDto = z.object({ status: z.enum(['ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED', 'RETURNED']), proofPhotoUrl: z.string().optional(), proofSignature: z.string().optional(), reason: z.string().optional(), costOwner: z.enum(['CUSTOMER', 'MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']).optional(), lat: z.number().optional(), lng: z.number().optional() });
const CancelDto = z.object({ reason: z.string(), costOwner: z.enum(['CUSTOMER', 'MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']).optional() });
const DriverTransitionDto = z.object({ status: z.enum(['PICKED_UP', 'DELIVERED', 'FAILED']), proofPhotoUrl: z.string().optional(), proofSignature: z.string().optional(), reason: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() });

@ApiTags('12/13 Delivery & drivers')
@Controller()
export class DeliveryController {
  constructor(private readonly svc: DeliveryService) {}

  @Public() @Post('webhooks/delivery') webhook(@Req() req: Request & { rawBody?: Buffer }) {
    return this.svc.ingestWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body)), req.headers as Record<string, string | undefined>);
  }
  @Public() @Get('public/delivery/:id/track') track(@Param('id') id: string) { return this.svc.track(id); }

  @ApiBearerAuth() @Get('locations/:id/delivery-zones') zones(@Param('id') id: string) { return this.svc.zones(id); }
  @ApiBearerAuth() @Post('locations/:id/delivery-zones') zone(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ZoneDto)) b: z.infer<typeof ZoneDto>) { return this.svc.upsertZone(u, id, b); }
  @ApiBearerAuth() @Post('locations/:id/delivery-jobs/external') external(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExternalDto)) b: z.infer<typeof ExternalDto>, @Headers('idempotency-key') key?: string) { return this.svc.externalDelivery(u, id, { ...b, idempotencyKey: key }); }
  @ApiBearerAuth() @Get('locations/:id/dispatch') queue(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.dispatcherQueue(u, id); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/transition') transition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(TransitionDto)) b: z.infer<typeof TransitionDto>) { const { status, ...data } = b; return this.svc.manualTransition(u, id, status, data); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CancelDto)) b: z.infer<typeof CancelDto>) { return this.svc.cancel(u, id, b.reason, b.costOwner); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/reassign') reassign(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.reassign(u, id); }

  // driver app
  @ApiBearerAuth() @Post('driver/apply') apply(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ vehicle: z.string() }))) b: { vehicle: string }) { return this.svc.applyAsDriver(u, b); }
  @ApiBearerAuth() @Roles('PLATFORM_ADMIN', 'SUPPORT') @Post('drivers/:id/approve') approve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approved: z.boolean() }))) b: { approved: boolean }) { return this.svc.approveDriver(u, id, b.approved); }
  @ApiBearerAuth() @Get('driver/me') me(@CurrentUser() u: JwtPayload) { return this.svc.myDriver(u); }
  @ApiBearerAuth() @Post('driver/availability') availability(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ isAvailable: z.boolean(), lat: z.number().optional(), lng: z.number().optional() }))) b: { isAvailable: boolean; lat?: number; lng?: number }) { return this.svc.setAvailability(u, b.isAvailable, b.lat, b.lng); }
  @ApiBearerAuth() @Post('driver/location') location(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ lat: z.number(), lng: z.number() }))) b: { lat: number; lng: number }) { return this.svc.updateLocation(u, b.lat, b.lng); }
  @ApiBearerAuth() @Get('driver/offers') offers(@CurrentUser() u: JwtPayload) { return this.svc.myOffers(u); }
  @ApiBearerAuth() @Post('driver/offers/:id') respond(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ accept: z.boolean() }))) b: { accept: boolean }) { return this.svc.respondOffer(u, id, b.accept); }
  @ApiBearerAuth() @Get('driver/jobs') jobs(@CurrentUser() u: JwtPayload) { return this.svc.myActiveJobs(u); }
  @ApiBearerAuth() @Post('driver/jobs/:id/transition') driverTransition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DriverTransitionDto)) b: z.infer<typeof DriverTransitionDto>) { const { status, ...data } = b; return this.svc.driverTransition(u, id, status, data); }
  @ApiBearerAuth() @Get('driver/earnings') earnings(@CurrentUser() u: JwtPayload) { return this.svc.myEarnings(u); }
}
