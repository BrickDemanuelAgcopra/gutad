import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { assertCan, CurrentUser, JwtPayload, Public, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { DeliveryService } from './delivery.service';
import { DeliveryAdminService } from './delivery-admin.service';
import { CourierService } from './courier.service';
import { can } from '../../common/auth';
import type { Address } from './providers/delivery-provider';

const AddressDto = z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), instructions: z.string().optional(), contactName: z.string().optional(), contactPhone: z.string().optional() });
const ZoneDto = z.object({ id: z.string().uuid().optional(), name: z.string(), polygon: z.unknown().optional(), feeCents: z.number().int().min(0), minOrderCents: z.number().int().min(0).optional(), etaMinutes: z.number().int().positive().optional(), isActive: z.boolean().optional(), kind: z.enum(['SERVICE', 'EXCLUSION']).optional(), locationIds: z.array(z.string().uuid()).optional(), kitchenId: z.string().uuid().nullable().optional(), travelMinutesPerKm: z.number().positive().nullable().optional(), capacityPerHour: z.number().int().positive().nullable().optional(), hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), opens: z.string().regex(/^\d{2}:\d{2}$/), closes: z.string().regex(/^\d{2}:\d{2}$/) })).nullable().optional(), feeTiers: z.array(z.object({ upToKm: z.number().positive(), feeCents: z.number().int().min(0) })).optional() });
const RestrictionDto = z.object({ kind: z.enum(['PAUSE', 'SHRINK_RADIUS', 'ADD_MINUTES']), value: z.number().int().positive().nullable().optional(), reason: z.string().min(3), zoneId: z.string().uuid().nullable().optional(), locationId: z.string().uuid().nullable().optional(), regionId: z.string().uuid().nullable().optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime() });
const ExceptionDto = z.object({ kind: z.enum(['CUSTOMER_UNREACHABLE', 'WRONG_ADDRESS', 'ACCESS_PROBLEM', 'UNSAFE_LOCATION']), method: z.enum(['CALL', 'SMS', 'DOOR', 'APP']).optional(), note: z.string().max(500).optional(), correctedAddress: AddressDto.partial().optional() });
const ResolveExDto = z.object({ resolution: z.enum(['RETURN', 'DISPOSE', 'SAFE_PLACE']), note: z.string().max(500).optional(), proofPhotoUrl: z.string().optional() });
const ExternalDto = z.object({ externalOrderId: z.string(), dropoff: AddressDto, orderValueCents: z.number().int().min(0), tipCents: z.number().int().min(0).optional() });
const TransitionDto = z.object({ status: z.enum(['ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED', 'RETURNED']), proofPhotoUrl: z.string().optional(), proofSignature: z.string().optional(), reason: z.string().optional(), costOwner: z.enum(['CUSTOMER', 'MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']).optional(), lat: z.number().optional(), lng: z.number().optional() });
const CancelDto = z.object({ reason: z.string(), costOwner: z.enum(['CUSTOMER', 'MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER']).optional() });
const DriverTransitionDto = z.object({ status: z.enum(['PICKED_UP', 'DELIVERED', 'FAILED']), proofPhotoUrl: z.string().optional(), proofSignature: z.string().optional(), handoffPin: z.string().max(8).optional(), idChecked: z.boolean().optional(), pickupCheck: z.object({ orderCode: z.string().max(12).optional(), bagCount: z.number().int().min(1).max(30), drinkCount: z.number().int().min(0).max(30).optional(), sealIntact: z.boolean(), note: z.string().max(500).optional() }).optional(), reason: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() });

@ApiTags('12/13 Delivery & drivers')
@Controller()
export class DeliveryController {
  constructor(private readonly svc: DeliveryService, private readonly admin: DeliveryAdminService, private readonly courierSvc: CourierService) {}

  @Public() @Post('webhooks/delivery') webhook(@Req() req: Request & { rawBody?: Buffer }) {
    return this.svc.ingestWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body)), req.headers as Record<string, string | undefined>);
  }
  @Public() @Get('public/delivery/:id/track') track(@Param('id') id: string) { return this.svc.track(id); }

  @ApiBearerAuth() @Get('locations/:id/delivery-zones') zones(@Param('id') id: string) { return this.svc.zones(id); }
  @ApiBearerAuth() @Post('locations/:id/delivery-zones') zone(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ZoneDto)) b: z.infer<typeof ZoneDto>) { return this.admin.upsertZone(u, id, b); }
  @ApiBearerAuth() @Get('locations/:id/delivery-area') area(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.zonesFor(u, id); }
  @Public() @Get('public/locations/:id/delivery-windows') windows(@Param('id') id: string, @Query('date') date: string) { return this.svc.deliveryWindows(id, date || new Date().toISOString().slice(0, 10)); }
  @ApiBearerAuth() @Post('locations/:id/delivery-jobs/external') external(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExternalDto)) b: z.infer<typeof ExternalDto>, @Headers('idempotency-key') key?: string) { return this.svc.externalDelivery(u, id, { ...b, idempotencyKey: key }); }
  @ApiBearerAuth() @Get('locations/:id/dispatch') queue(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.dispatcherQueue(u, id); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/transition') transition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(TransitionDto)) b: z.infer<typeof TransitionDto>) { const { status, ...data } = b; return this.svc.manualTransition(u, id, status, data); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(CancelDto)) b: z.infer<typeof CancelDto>) { return this.svc.cancel(u, id, b.reason, b.costOwner); }
  @ApiBearerAuth() @Post('delivery-jobs/:id/reassign') reassign(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.reassign(u, id); }

  // ───── Phase G admin ─────
  @ApiBearerAuth() @Get('admin/delivery/network') network(@CurrentUser() u: JwtPayload, @Query('regionId') r?: string) { return this.admin.network(u, r); }
  @ApiBearerAuth() @Get('admin/delivery/live') live(@CurrentUser() u: JwtPayload, @Query('regionId') r?: string) { return this.admin.live(u, r); }
  @ApiBearerAuth() @Get('admin/delivery/analysis') analysis(@CurrentUser() u: JwtPayload, @Query('by') by?: string, @Query('days') days?: string) { return this.admin.analysis(u, (['zone', 'provider', 'location'].includes(by || '') ? by : 'zone') as 'zone', Number(days) || 30); }
  @ApiBearerAuth() @Post('admin/delivery/coverage') coverage(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ lat: z.number(), lng: z.number(), radiusKm: z.number().positive().max(30), stepKm: z.number().positive().optional(), prepMinutes: z.number().int().optional() }))) b: { lat: number; lng: number; radiusKm: number; stepKm?: number; prepMinutes?: number }) { return this.admin.coverage(u, b); }
  @ApiBearerAuth() @Get('admin/delivery/restrictions') restrictions(@CurrentUser() u: JwtPayload, @Query('all') all?: string) { return this.admin.restrictions(u, all === 'true'); }
  @ApiBearerAuth() @Post('admin/delivery/restrictions') addRestriction(@CurrentUser() u: JwtPayload, @Body(zod(RestrictionDto)) b: z.infer<typeof RestrictionDto>) { return this.admin.addRestriction(u, b); }
  @ApiBearerAuth() @Post('admin/delivery/restrictions/:id/lift') lift(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.liftRestriction(u, id); }
  @ApiBearerAuth() @Get('admin/delivery/providers') providers(@CurrentUser() u: JwtPayload) { return this.admin.providers(u); }
  @ApiBearerAuth() @Post('admin/delivery/providers') provider(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ id: z.string().uuid().optional(), regionId: z.string().uuid().nullable().optional(), provider: z.string().min(2), priority: z.number().int().min(1), isActive: z.boolean().optional() }))) b: { id?: string; regionId?: string | null; provider: string; priority: number; isActive?: boolean }) { return this.admin.upsertProvider(u, b); }
  @ApiBearerAuth() @Post('admin/delivery-jobs/:id/assign') assign(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ driverId: z.string().uuid(), reason: z.string().min(5) }))) b: { driverId: string; reason: string }) { return this.admin.assign(u, id, b.driverId, b.reason); }
  @ApiBearerAuth() @Post('admin/delivery-jobs/:id/exception') staffEx(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExceptionDto)) b: z.infer<typeof ExceptionDto>) { return this.admin.staffException(u, id, b as { kind: string; correctedAddress?: Address }); }
  @ApiBearerAuth() @Post('admin/delivery-jobs/:id/exception/resolve') staffRes(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ResolveExDto)) b: z.infer<typeof ResolveExDto>) { return this.admin.staffResolve(u, id, b); }
  @ApiBearerAuth() @Get('delivery-jobs/:id/proof') proof(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.proof(u, id); }
  @ApiBearerAuth() @Get('admin/couriers') couriers(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.admin.couriers(u, q); }
  @ApiBearerAuth() @Get('admin/couriers/documents') docQueue(@CurrentUser() u: JwtPayload) { return this.admin.documentQueue(u); }
  @ApiBearerAuth() @Get('admin/couriers/shifts') shiftBoard(@CurrentUser() u: JwtPayload, @Query('days') days?: string) { return this.admin.shiftBoard(u, Number(days) || 2); }
  @ApiBearerAuth() @Get('admin/couriers/:id') async courier(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    const r = await this.admin.courier(u, id);
    const extras = await this.courierSvc.adminExtras(u, id);
    // payout details are finance data: masked for everyone else
    const courier = can(u, 'finance.read') ? r.courier : { ...r.courier, payoutAccountId: r.courier.payoutAccountId ? `••••${r.courier.payoutAccountId.slice(-4)}` : null };
    return { ...r, courier, ...extras };
  }
  @ApiBearerAuth() @Patch('admin/couriers/:id') updCourier(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ vehicleType: z.enum(['BIKE', 'EBIKE', 'SCOOTER', 'CAR', 'VAN', 'WALK']).optional(), capabilities: z.array(z.enum(['ALCOHOL', 'LARGE_ORDER', 'COLD_BAG', 'HOT_BAG'])).optional(), regionId: z.string().uuid().nullable().optional(), zoneIds: z.array(z.string().uuid()).optional(), maxConcurrent: z.number().int().min(1).max(4).optional() }))) b: { vehicleType?: string; capabilities?: string[]; regionId?: string | null; zoneIds?: string[]; maxConcurrent?: number }) { return this.admin.updateCourier(u, id, b); }
  @ApiBearerAuth() @Post('admin/courier-documents/:id/review') async review(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approve: z.boolean(), note: z.string().optional(), expiresAt: z.string().datetime().optional() }))) b: { approve: boolean; note?: string; expiresAt?: string }) { const doc = await this.admin.reviewDocument(u, id, b.approve, b.note, b.expiresAt); await this.courierSvc.syncDocChecks(doc.driverId); return doc; }
  @ApiBearerAuth() @Post('admin/couriers/:id/records') record(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ kind: z.enum(['INCIDENT', 'TRAINING', 'SUPPORT_NOTE']), title: z.string().min(2), detail: z.string().optional(), severity: z.number().int().min(1).max(3).optional() }))) b: { kind: 'INCIDENT' | 'TRAINING' | 'SUPPORT_NOTE'; title: string; detail?: string; severity?: number }) { return this.admin.addRecord(u, id, b); }
  @ApiBearerAuth() @Post('admin/couriers/:id/adjustments') adjust(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ cents: z.number().int().min(-50000).max(50000), reason: z.string().min(5), deliveryJobId: z.string().uuid().optional() }))) b: { cents: number; reason: string; deliveryJobId?: string }) { return this.admin.adjust(u, id, b); }
  @ApiBearerAuth() @Post('admin/couriers/:id/suspend') suspend(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.admin.suspend(u, id, b.reason); }
  @ApiBearerAuth() @Post('admin/couriers/:id/appeal-decision') appealDecision(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reinstate: z.boolean(), note: z.string().min(3) }))) b: { reinstate: boolean; note: string }) { return this.admin.decideAppeal(u, id, b.reinstate, b.note); }
  /** Housekeeping now (normally scheduled): document expiry and proof-of-delivery retention. `at` only with ALLOW_BILLING_TIME_TRAVEL=true. */
  @ApiBearerAuth() @Post('admin/jobs/delivery-housekeeping') house(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ at: z.string().datetime().optional() }))) b: { at?: string }) { assertCan(u, 'delivery.manage'); const at = b.at && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? new Date(b.at) : new Date(); return Promise.all([this.svc.expireCourierDocs(at), this.svc.purgeProofs(at)]).then(([docs, proofs]) => ({ docs, proofs })); }

  // courier app (Phase G)
  @ApiBearerAuth() @Get('driver/standing') standing(@CurrentUser() u: JwtPayload) { return this.admin.myStanding(u); }
  @ApiBearerAuth() @Get('driver/documents') myDocs(@CurrentUser() u: JwtPayload) { return this.admin.myDocuments(u); }
  @ApiBearerAuth() @Post('driver/documents') async upload(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ kind: z.string(), fileUrl: z.string().min(4), expiresAt: z.string().datetime().optional() }))) b: { kind: string; fileUrl: string; expiresAt?: string }) { const doc = await this.admin.uploadDocument(u, b); await this.courierSvc.syncDocChecks(doc.driverId); return doc; }
  @ApiBearerAuth() @Get('driver/shifts') myShifts(@CurrentUser() u: JwtPayload) { return this.admin.myShifts(u); }
  @ApiBearerAuth() @Post('driver/shifts') addShift(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime(), zoneId: z.string().uuid().optional() }))) b: { startsAt: string; endsAt: string; zoneId?: string }) { return this.admin.addShift(u, b); }
  @ApiBearerAuth() @Delete('driver/shifts/:id') cancelShift(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.cancelShift(u, id); }
  @ApiBearerAuth() @Post('driver/appeal') appeal(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ note: z.string().min(10) }))) b: { note: string }) { return this.admin.appeal(u, b.note); }
  @ApiBearerAuth() @Post('driver/jobs/:id/arrived') arrived(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ at: z.enum(['PICKUP', 'DROPOFF']), lat: z.number().optional(), lng: z.number().optional() }))) b: { at: 'PICKUP' | 'DROPOFF'; lat?: number; lng?: number }) { return this.svc.driverArrived(u, id, b.at, b.lat, b.lng); }
  @ApiBearerAuth() @Post('driver/jobs/:id/exception') exception(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ExceptionDto)) b: z.infer<typeof ExceptionDto>) { return this.svc.driverException(u, id, b as { kind: string; correctedAddress?: Address }); }
  @ApiBearerAuth() @Post('driver/jobs/:id/exception/resolve') resolveEx(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ResolveExDto)) b: z.infer<typeof ResolveExDto>) { return this.svc.resolveException(u, id, b); }

  // driver app
  @ApiBearerAuth() @Post('driver/apply') apply(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ vehicle: z.string() }))) b: { vehicle: string }) { return this.svc.applyAsDriver(u, b); }
  @ApiBearerAuth() @Roles('PLATFORM_ADMIN', 'SUPPORT') @Post('drivers/:id/approve') async approve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approved: z.boolean() }))) b: { approved: boolean }) { const d = await this.svc.approveDriver(u, id, b.approved); await this.courierSvc.legacyDecision(u, id, b.approved); return d; }
  @ApiBearerAuth() @Get('driver/me') me(@CurrentUser() u: JwtPayload) { return this.svc.myDriver(u); }
  @ApiBearerAuth() @Post('driver/availability') availability(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ isAvailable: z.boolean(), lat: z.number().optional(), lng: z.number().optional(), mode: z.enum(['ON_DEMAND', 'RESERVED']).optional() }))) b: { isAvailable: boolean; lat?: number; lng?: number; mode?: 'ON_DEMAND' | 'RESERVED' }) { return this.svc.setAvailability(u, b.isAvailable, b.lat, b.lng, b.mode === 'RESERVED' ? 'RESERVED' : 'ON_DEMAND'); }
  @ApiBearerAuth() @Post('driver/location') location(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ lat: z.number(), lng: z.number() }))) b: { lat: number; lng: number }) { return this.svc.updateLocation(u, b.lat, b.lng); }
  @ApiBearerAuth() @Get('driver/offers') offers(@CurrentUser() u: JwtPayload) { return this.svc.myOffers(u); }
  @ApiBearerAuth() @Post('driver/offers/:id') respond(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ accept: z.boolean() }))) b: { accept: boolean }) { return this.svc.respondOffer(u, id, b.accept); }
  @ApiBearerAuth() @Get('driver/jobs') jobs(@CurrentUser() u: JwtPayload) { return this.svc.myActiveJobs(u); }
  @ApiBearerAuth() @Post('driver/jobs/:id/transition') driverTransition(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DriverTransitionDto)) b: z.infer<typeof DriverTransitionDto>) { const { status, ...data } = b; return this.svc.driverTransition(u, id, status, data); }
}
