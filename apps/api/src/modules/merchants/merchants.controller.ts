import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, RoleName } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { MerchantsService } from './merchants.service';

const OrgDto = z.object({ name: z.string().min(2), kind: z.enum(['MERCHANT', 'CORPORATE', 'CAMPUS', 'PARTNER', 'CREATOR']).optional(), taxId: z.string().optional(), billingEmail: z.string().email().optional() });
const InviteDto = z.object({
  email: z.string().email(),
  role: z.enum(['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST', 'KITCHEN', 'PACKER', 'DISPATCHER', 'ORG_MEMBER']),
  locationIds: z.array(z.string().uuid()).optional(),
  approvalLimitCents: z.number().int().min(0).optional(),
});
const SellerDto = z.object({ id: z.string().uuid().optional(), legalName: z.string().min(2), taxId: z.string().optional(), country: z.string().optional(), beneficiaryName: z.string().optional(), billingContact: z.string().optional() });
const BrandDto = z.object({ id: z.string().uuid().optional(), name: z.string().min(1), legalSellerId: z.string().uuid().optional(), description: z.string().optional(), logoUrl: z.string().optional(), royaltyBps: z.number().int().min(0).max(5000).optional(), contentRightsOk: z.boolean().optional() });
const LocationDto = z.object({
  name: z.string().min(1),
  legalSellerId: z.string().uuid().optional(),
  kitchenId: z.string().uuid().optional(),
  description: z.string().optional(),
  cuisine: z.array(z.string()).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  heroImageUrl: z.string().optional(),
  photos: z.array(z.string()).optional(),
  amenities: z.array(z.string()).optional(),
  acceptsPickup: z.boolean().optional(),
  acceptsDelivery: z.boolean().optional(),
  acceptsDineIn: z.boolean().optional(),
  acceptsReservations: z.boolean().optional(),
  acceptsEvents: z.boolean().optional(),
  acceptsCatering: z.boolean().optional(),
  orderThrottlePer15m: z.number().int().positive().nullable().optional(),
  defaultPrepMinutes: z.number().int().positive().optional(),
  taxRateBps: z.number().int().min(0).optional(),
  minOrderCents: z.number().int().min(0).optional(),
  deliveryFleet: z.enum(['MERCHANT', 'PARTNER', 'PLATFORM']).optional(),
  deliveryRadiusKm: z.number().positive().optional(),
  deliveryBaseFeeCents: z.number().int().min(0).optional(),
  deliveryPerKmCents: z.number().int().min(0).optional(),
  posProvider: z.string().optional(),
  posExternalId: z.string().optional(),
  tabletFallbackPhone: z.string().optional(),
  contacts: z.array(z.object({ name: z.string(), role: z.string().optional(), phone: z.string().optional(), email: z.string().optional() })).optional(),
  acceptsKiosk: z.boolean().optional(),
  pickupInstructions: z.string().nullable().optional(),
  parkingInfo: z.string().nullable().optional(),
  courierInstructions: z.string().nullable().optional(),
  courierPointLat: z.number().nullable().optional(),
  courierPointLng: z.number().nullable().optional(),
  autoAccept: z.boolean().optional(),
  packagingFeeCents: z.number().int().min(0).nullable().optional(),
  scheduledSlotCapacity: z.number().int().min(1).nullable().optional(),
  scheduleLeadMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  acceptTimeoutMinutes: z.number().int().min(2).max(30).optional(),
  pickupShelves: z.array(z.string().min(1).max(10)).max(100).optional(),
  packingExtras: z.array(z.string().min(1).max(60)).max(20).optional(),
  requirePackVerification: z.boolean().nullable().optional(),
  deliveryWindowMinutes: z.number().int().min(10).max(240).nullable().optional(),
  deliveryWindowCapacity: z.number().int().min(1).nullable().optional(),
});
const HoursDto = z.object({ hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), opens: z.string().regex(/^\d{2}:\d{2}$/), closes: z.string().regex(/^\d{2}:\d{2}$/), service: z.string().optional() })) });
const StatusDto = z.object({ status: z.enum(['LIVE', 'PAUSED', 'SUSPENDED', 'OFFBOARDED']), reason: z.string().optional() });
const PauseDto = z.object({ minutes: z.number().int().positive().nullable().optional(), reason: z.string().optional() });
const PubDto = z.object({ kind: z.enum(['LISTING', 'BRANDED_SITE', 'ORDER_LINK', 'QR', 'BOOKING_WIDGET', 'PARTNER_LINK']), channel: z.enum(['MARKETPLACE', 'DIRECT', 'WIDGET', 'QR', 'PARTNER']), config: z.record(z.unknown()).optional(), partnerName: z.string().optional(), partnerUrl: z.string().url().optional() });
const FleetRequestDto = z.object({ fleet: z.enum(['MERCHANT', 'PARTNER', 'PLATFORM']), note: z.string().max(1000).optional() });
const FleetReviewDto = z.object({ approve: z.boolean(), note: z.string().max(1000).optional() });
const ConversionDto = z.object({ referralCode: z.string(), partnerOrderId: z.string(), payableCents: z.number().int().min(0), agreementRef: z.string().optional() });

@ApiTags('02 Merchants, locations & publishing')
@ApiBearerAuth()
@Controller()
export class MerchantsController {
  constructor(private readonly svc: MerchantsService) {}

  @Post('organizations') createOrg(@CurrentUser() u: JwtPayload, @Body(zod(OrgDto)) b: z.infer<typeof OrgDto>) { return this.svc.createOrganization(u, b); }
  @Get('organizations') listOrgs(@CurrentUser() u: JwtPayload) { return this.svc.listMyOrganizations(u); }
  @Get('organizations/:id') getOrg(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.getOrganization(u, id); }
  @Post('organizations/:id/members') invite(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(InviteDto)) b: z.infer<typeof InviteDto>) { return this.svc.inviteMember(u, id, { ...b, role: b.role as RoleName }); }
  @Delete('organizations/:id/members/:mid') removeMember(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('mid') mid: string) { return this.svc.removeMember(u, id, mid); }
  @Post('legal-sellers/:id/bank-change') bankChange(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ beneficiaryName: z.string().optional(), bankLast4: z.string().regex(/^\d{4}$/).optional(), taxId: z.string().optional(), reason: z.string().min(5) }))) b: { beneficiaryName?: string; bankLast4?: string; taxId?: string; reason: string }) { return this.svc.requestBankChange(u, id, b); }
  @Post('organizations/:id/legal-sellers') seller(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(SellerDto)) b: z.infer<typeof SellerDto>) { return this.svc.upsertLegalSeller(u, id, b); }
  @Post('organizations/:id/brands') brand(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(BrandDto)) b: z.infer<typeof BrandDto>) { return this.svc.upsertBrand(u, id, b); }
  @Post('organizations/:id/locations') createLocation(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(LocationDto)) b: z.infer<typeof LocationDto>) { return this.svc.createLocation(u, id, b); }

  @Post('locations/:id/claim') claim(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ organizationId: z.string().uuid() }))) b: { organizationId: string }) { return this.svc.claimLocation(u, id, b.organizationId); }
  @Post('locations/:id/verify') verify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ verified: z.boolean() }))) b: { verified: boolean }) { return this.svc.verifyLocation(u, id, b.verified); }
  @Get('locations/:id/delivery-pricing') deliveryPricing(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.deliveryPricing(u, id); }
  @Post('locations/:id/delivery-pricing') setDeliveryPricing(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ baseCents: z.number().int().min(0).optional(), perKmCents: z.number().int().min(0).optional(), freeDeliveryMinCents: z.number().int().min(0).nullable().optional() }))) b: { baseCents?: number; perKmCents?: number; freeDeliveryMinCents?: number | null }) { return this.svc.setDeliveryPricing(u, id, b); }
  @Patch('locations/:id') update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(LocationDto.partial())) b: Partial<z.infer<typeof LocationDto>>) { return this.svc.updateLocation(u, id, b); }
  @Post('locations/:id/status') status(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(StatusDto)) b: z.infer<typeof StatusDto>) { return this.svc.setStatus(u, id, b.status, b.reason); }
  @Post('locations/:id/pause') pause(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PauseDto)) b: z.infer<typeof PauseDto>) { return this.svc.pause(u, id, b.minutes ?? null, b.reason); }
  @Post('locations/:id/resume') resume(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.resume(u, id); }
  @Post('locations/:id/delivery-fleet-request') fleetRequest(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(FleetRequestDto)) b: z.infer<typeof FleetRequestDto>) { return this.svc.requestDeliveryFleet(u, id, b.fleet, b.note); }
  @Delete('locations/:id/delivery-fleet-request') fleetRequestCancel(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.cancelDeliveryFleetRequest(u, id); }
  @Get('admin/delivery-fleet-requests') fleetRequests(@CurrentUser() u: JwtPayload) { return this.svc.listDeliveryFleetRequests(u); }
  @Post('locations/:id/delivery-fleet-request/review') fleetReview(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(FleetReviewDto)) b: z.infer<typeof FleetReviewDto>) { return this.svc.reviewDeliveryFleet(u, id, b.approve, b.note); }
  @Post('locations/:id/platform-operated') platformOperated(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ value: z.boolean() }))) b: { value: boolean }) { return this.svc.setPlatformOperated(u, id, b.value); }
  @Patch('locations/:id/hours') hours(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(HoursDto)) b: z.infer<typeof HoursDto>) { return this.svc.setHours(u, id, b.hours); }

  @Get('locations/:id/publications') pubs(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.listPublications(u, id); }
  @Post('locations/:id/publications') createPub(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PubDto)) b: z.infer<typeof PubDto>) { return this.svc.createPublication(u, id, b); }
  @Patch('publications/:id') togglePub(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ isActive: z.boolean() }))) b: { isActive: boolean }) { return this.svc.togglePublication(u, id, b.isActive); }

  @Public() @Get('public/source') resolveSource(@Query('src') src: string) { return this.svc.resolveSource(src || ''); }
  @Public() @Post('public/referrals/:publicationId/click') referralClick(@Param('publicationId') id: string) { return this.svc.recordReferralClick(id); }
  @Public() @Post('partners/referrals/conversion') conversion(@Body(zod(ConversionDto)) b: z.infer<typeof ConversionDto>) { return this.svc.recordReferralConversion(b.referralCode, b.partnerOrderId, b.payableCents, b.agreementRef); }
}
