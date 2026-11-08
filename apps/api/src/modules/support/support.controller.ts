import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { SupportService } from './support.service';

const OpenDto = z.object({ orderId: z.string().uuid().optional(), reservationId: z.string().uuid().optional(), deliveryJobId: z.string().uuid().optional(), category: z.enum(['MISSING_ITEM', 'LATE', 'DAMAGED', 'NO_HANDOFF', 'WRONG_ADDRESS', 'CHARGEBACK', 'NO_SHOW_DISPUTE', 'OTHER']), description: z.string().min(3), evidence: z.array(z.unknown()).optional() });
const ResolveDto = z.object({ owner: z.enum(['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER']), remedy: z.enum(['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY', 'REASSIGN', 'NONE']), remedyCents: z.number().int().min(0).optional(), note: z.string().optional(), evidence: z.array(z.unknown()).optional() });
const StrikeDto = z.object({ subjectType: z.enum(['MERCHANT', 'DRIVER', 'CUSTOMER']), subjectId: z.string(), reason: z.string(), severity: z.number().int().min(1).max(3).optional() });

@ApiTags('28 Support & trust')
@ApiBearerAuth()
@Controller()
export class SupportController {
  constructor(private readonly svc: SupportService) {}

  @Post('incidents') open(@CurrentUser() u: JwtPayload, @Body(zod(OpenDto)) b: z.infer<typeof OpenDto>) { return this.svc.open(u, b); }
  @Get('incidents') queue(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('owner') owner?: string) { return this.svc.queue(u, { status, owner }); }
  @Get('incidents/:id') timeline(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.timeline(u, id); }
  @Post('incidents/:id/resolve') resolve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ResolveDto)) b: z.infer<typeof ResolveDto>) { return this.svc.resolve(u, id, b); }
  @Post('incidents/:id/appeal') appeal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string() }))) b: { note: string }) { return this.svc.appeal(u, id, b.note); }
  @Roles('SUPPORT', 'FINANCE', 'PLATFORM_ADMIN') @Get('payments/:id/chargeback-evidence') evidence(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.chargebackEvidence(u, id); }
  @Roles('SUPPORT', 'PLATFORM_ADMIN') @Post('policy/strikes') strike(@CurrentUser() u: JwtPayload, @Body(zod(StrikeDto)) b: z.infer<typeof StrikeDto>) { return this.svc.strike(u, b); }
  @Post('me/data-request') data(@CurrentUser() u: JwtPayload, @Body(zod(z.object({ kind: z.enum(['ACCESS', 'DELETE']) }))) b: { kind: 'ACCESS' | 'DELETE' }) { return this.svc.dataRequest(u, b.kind); }
}
