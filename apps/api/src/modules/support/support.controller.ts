import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Roles } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { SUPPORT_CATEGORY_KEYS, type SupportCategory } from '@gutad/shared';
import { SupportService } from './support.service';

const OpenDto = z.object({ paymentId: z.string().uuid().optional(), menuItemId: z.string().uuid().optional(), orderId: z.string().uuid().optional(), reservationId: z.string().uuid().optional(), deliveryJobId: z.string().uuid().optional(), category: z.enum(SUPPORT_CATEGORY_KEYS as [SupportCategory, ...SupportCategory[]]), description: z.string().min(3), evidence: z.array(z.unknown()).optional() });
const ResolveDto = z.object({ owner: z.enum(['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER']), remedy: z.enum(['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY', 'REASSIGN', 'NONE']), remedyCents: z.number().int().min(0).optional(), note: z.string().optional(), evidence: z.array(z.unknown()).optional() });
const StrikeDto = z.object({ subjectType: z.enum(['MERCHANT', 'DRIVER', 'CUSTOMER']), subjectId: z.string(), reason: z.string(), severity: z.number().int().min(1).max(3).optional() });

@ApiTags('28 Support & trust')
@ApiBearerAuth()
@Controller()
export class SupportController {
  constructor(private readonly svc: SupportService) {}

  @Post('incidents') open(@CurrentUser() u: JwtPayload, @Body(zod(OpenDto)) b: z.infer<typeof OpenDto>) { return this.svc.open(u, b); }
  @Get('incidents') queue(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.svc.queue(u, { status: q.status, owner: q.owner, priority: q.priority, queue: q.queue, reporterType: q.reporterType, mine: q.mine === 'true', breached: q.breached === 'true' }); }
  @Post('incidents/:id/assign') assign(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ assigneeId: z.string().uuid().nullable().optional(), queue: z.string().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional() }))) b: { assigneeId?: string | null; queue?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' }) { return this.svc.assign(u, id, b); }
  @Get('incidents/:id/remedy-preview') preview(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('remedy') remedy: string, @Query('cents') cents: string) { return this.svc.remedyPreview(u, id, remedy || 'REFUND', Number(cents) || 0); }
  @Get('me/responsibility-tickets') responsible(@CurrentUser() u: JwtPayload) { return this.svc.responsibleTickets(u); } // 24.6-W
  @Post('incidents/:id/dispute-responsibility') disputeResp(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reason: z.string().min(5) }))) b: { reason: string }) { return this.svc.disputeResponsibility(u, id, b.reason); }
  @Post('incidents/:id/responsibility-decision') decideResp(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ reverse: z.boolean(), note: z.string().min(3) }))) b: { reverse: boolean; note: string }) { return this.svc.decideResponsibility(u, id, b.reverse, b.note); }
  @Get('admin/support/root-causes') rootCauses(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.svc.rootCauses(u, q); }
  @Get('incidents/:id') timeline(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.timeline(u, id); }
  @Post('incidents/:id/resolve') resolve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ResolveDto)) b: z.infer<typeof ResolveDto>) { return this.svc.resolve(u, id, b); }
  @Post('incidents/:id/appeal') appeal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string() }))) b: { note: string }) { return this.svc.appeal(u, id, b.note); }
  @Roles('SUPPORT', 'FINANCE', 'PLATFORM_ADMIN') @Get('payments/:id/chargeback-evidence') evidence(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.chargebackEvidence(u, id); }
  @Roles('SUPPORT', 'PLATFORM_ADMIN') @Post('policy/strikes') strike(@CurrentUser() u: JwtPayload, @Body(zod(StrikeDto)) b: z.infer<typeof StrikeDto>) { return this.svc.strike(u, b); }
}
