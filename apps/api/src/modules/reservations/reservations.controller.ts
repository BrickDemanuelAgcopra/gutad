import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequiresFeature } from '../entitlements/requires-feature';
import { CurrentUser, JwtPayload, Public } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ReservationsService } from './reservations.service';

const FloorDto = z.object({ rooms: z.array(z.object({ name: z.string(), isPrivate: z.boolean().optional(), tables: z.array(z.object({ name: z.string(), section: z.string().optional(), minSeats: z.number().int().min(1), maxSeats: z.number().int().min(1), posTableId: z.string().optional() })) })).optional(), combinations: z.array(z.object({ name: z.string(), tableNames: z.array(z.string()).min(2), minSeats: z.number().int(), maxSeats: z.number().int() })).optional() });
const ShiftDto = z.object({ id: z.string().uuid().optional(), name: z.string(), daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), slotMinutes: z.number().int().positive().optional(), turnMinutesSmall: z.number().int().positive().optional(), turnMinutesMedium: z.number().int().positive().optional(), turnMinutesLarge: z.number().int().positive().optional(), maxPartySize: z.number().int().positive().optional(), maxCoversPerSlot: z.number().int().positive().optional(), maxBookingsPerSlot: z.number().int().positive().optional(), isActive: z.boolean().optional() });
const PolicyDto = z.object({ cancellationHours: z.number().int().min(0).optional(), requiresCardAbove: z.number().int().nullable().optional(), noShowFeeCents: z.number().int().min(0).optional(), depositCents: z.number().int().min(0).optional(), depositAppliesToCheck: z.boolean().optional(), holdMinutes: z.number().int().positive().optional(), reminderHoursBefore: z.number().int().positive().optional(), largePartyThreshold: z.number().int().positive().optional() });
const BookDto = z.object({ locationId: z.string().uuid(), startAt: z.string(), partySize: z.number().int().min(1).max(50), guestName: z.string().min(1), guestEmail: z.string().email().optional(), guestPhone: z.string().optional(), notes: z.string().max(500).optional(), occasion: z.string().optional(), channel: z.enum(['MARKETPLACE', 'DIRECT', 'WIDGET', 'PARTNER']).optional(), paymentMethodId: z.string().optional() });
const ModifyDto = z.object({ startAt: z.string().optional(), partySize: z.number().int().min(1).optional(), notes: z.string().optional() });
const HostBookDto = z.object({ startAt: z.string().optional(), partySize: z.number().int().min(1), guestName: z.string(), guestPhone: z.string().optional(), notes: z.string().optional(), channel: z.enum(['PHONE', 'WALK_IN']) });
const HostActionDto = z.object({ action: z.enum(['ARRIVE', 'SEAT', 'MOVE', 'COMPLETE', 'NO_SHOW']), actualPartySize: z.number().int().optional(), tableIds: z.array(z.string().uuid()).optional(), posCheckId: z.string().optional(), checkTotalCents: z.number().int().optional() });
const WaitlistDto = z.object({ guestName: z.string(), guestPhone: z.string().optional(), partySize: z.number().int().min(1) });

@ApiTags('14/15/16 Reservations, booking, host stand & waitlist')
@Controller()
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Public() @RequiresFeature('reservations', 'param:id', 'customer') @Get('public/locations/:id/availability') availability(@Param('id') id: string, @Query('date') date: string, @Query('partySize') party: string) { return this.svc.availability(id, date, Number(party || 2)); }
  @Public() @RequiresFeature('reservations', 'body:locationId', 'customer') @Post('reservations') book(@CurrentUser() u: JwtPayload | undefined, @Body(zod(BookDto)) b: z.infer<typeof BookDto>, @Headers('idempotency-key') key?: string) { return this.svc.book(u ?? null, { ...b, idempotencyKey: key }); }
  @Public() @Post('reservations/:id/confirm') confirm(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ paymentMethodId: z.string() }))) b: { paymentMethodId: string }) { return this.svc.confirmHold(u ?? null, id, b.paymentMethodId); }
  @Public() @Patch('reservations/:id') modify(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(ModifyDto)) b: z.infer<typeof ModifyDto>) { return this.svc.modify(u ?? null, id, b); }
  @Public() @Post('reservations/:id/cancel') cancel(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().optional() }))) b: { reason?: string }) { return this.svc.cancel(u ?? null, id, b.reason); }
  @Public() @Get('public/reservations/by-code/:code') byCode(@Param('code') code: string, @Query('email') email?: string) { return this.svc.byCode(code, email); }
  @ApiBearerAuth() @Get('me/reservations') mine(@CurrentUser() u: JwtPayload) { return this.svc.myReservations(u); }
  @ApiBearerAuth() @Get('reservations/:id/history') history(@Param('id') id: string) { return this.svc.history(id); }

  @ApiBearerAuth() @Post('locations/:id/floor') floor(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(FloorDto)) b: z.infer<typeof FloorDto>) { return this.svc.setupFloor(u, id, b); }
  @ApiBearerAuth() @Get('locations/:id/floor') getFloor(@Param('id') id: string) { return this.svc.floor(id); }
  @ApiBearerAuth() @RequiresFeature('reservations', 'param:id') @Post('locations/:id/shifts') shift(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ShiftDto)) b: z.infer<typeof ShiftDto>) { return this.svc.upsertShift(u, id, b); }
  @ApiBearerAuth() @Patch('locations/:id/reservation-policy') policy(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(PolicyDto)) b: z.infer<typeof PolicyDto>) { return this.svc.setPolicy(u, id, b); }
  @ApiBearerAuth() @Post('locations/:id/blackouts') blackout(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ date: z.string(), reason: z.string().optional() }))) b: { date: string; reason?: string }) { return this.svc.addBlackout(u, id, b.date, b.reason); }

  @ApiBearerAuth() @RequiresFeature('floor_plan', 'param:id') @Get('locations/:id/host') host(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('date') date?: string) { return this.svc.hostBoard(u, id, date); }
  @ApiBearerAuth() @RequiresFeature('floor_plan', 'param:id') @Post('locations/:id/host/book') hostBook(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(HostBookDto)) b: z.infer<typeof HostBookDto>) { return this.svc.hostBook(u, id, b); }
  @ApiBearerAuth() @Post('reservations/:id/host') hostAction(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(HostActionDto)) b: z.infer<typeof HostActionDto>) { const { action, ...data } = b; return this.svc.hostTransition(u, id, action, data); }

  @Public() @RequiresFeature('waitlist', 'param:id', 'customer') @Post('public/locations/:id/waitlist') join(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string, @Body(zod(WaitlistDto)) b: z.infer<typeof WaitlistDto>) { return this.svc.joinWaitlist(u ?? null, id, b); }
  @Public() @Get('public/waitlist/:id') wlStatus(@Param('id') id: string) { return this.svc.waitlistStatus(id); }
  @Public() @Post('public/waitlist/:id/leave') leave(@CurrentUser() u: JwtPayload | undefined, @Param('id') id: string) { return this.svc.leaveWaitlist(u ?? null, id); }
  @ApiBearerAuth() @Post('waitlist/:id/notify') notify(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.notifyWaitlist(u, id); }
  @ApiBearerAuth() @Post('waitlist/:id/seat') seat(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ tableIds: z.array(z.string().uuid()).optional() }))) b: { tableIds?: string[] }) { return this.svc.seatWaitlist(u, id, b.tableIds); }
}
