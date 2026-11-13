import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, RequiresPermission } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { AlertsService } from './alerts.service';
import { OpsFilter, OpsService } from './ops.service';

const F = (q: Record<string, string | undefined>): OpsFilter => ({ from: q.from || undefined, to: q.to || undefined, regionId: q.regionId || undefined, organizationId: q.organizationId || undefined, locationId: q.locationId || undefined, brandId: q.brandId || undefined, channel: q.channel || undefined });
const NoteDto = z.object({ body: z.string().default(''), visibility: z.enum(['INTERNAL', 'CUSTOMER']).default('INTERNAL'), templateKey: z.string().optional() }).refine((v) => v.body.trim() || v.templateKey, 'Write a note or pick a template');
const RemedyDto = z.object({ remedy: z.enum(['REFUND', 'CREDIT', 'REMAKE', 'REDELIVERY']), remedyCents: z.number().int().min(0).optional(), owner: z.enum(['MERCHANT', 'PLATFORM', 'PROVIDER', 'DRIVER', 'CUSTOMER']), category: z.string().optional(), reason: z.string().min(5) });
const AlertDto = z.object({ title: z.string().min(3), detail: z.string().optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), subjectType: z.string().optional(), subjectId: z.string().optional(), organizationId: z.string().uuid().optional(), locationId: z.string().uuid().optional(), ownerRole: z.string().optional() });
const ActDto = z.object({ note: z.string().optional(), ownerId: z.string().uuid().nullable().optional(), ownerRole: z.string().optional(), resolution: z.string().optional() });
const TemplateDto = z.object({ key: z.string().min(2).max(60), title: z.string().min(2), body: z.string().min(2), category: z.string().optional(), isActive: z.boolean().optional() });

@ApiTags('01 Executive dashboard & live operations')
@ApiBearerAuth()
@Controller()
export class OpsController {
  constructor(private readonly ops: OpsService, private readonly alerts: AlertsService) {}

  @Get('admin/ops/filters') filters(@CurrentUser() u: JwtPayload) { return this.ops.filterOptions(u); }
  @Get('admin/ops/executive') executive(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.executive(u, F(q)); }
  @Get('admin/ops/breakdown') breakdown(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.breakdown(u, (['region', 'location', 'merchant', 'brand', 'channel'].includes(q.dim) ? q.dim : 'location') as never, F(q)); }
  @Get('admin/ops/live') live(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.live(u, F(q)); }
  @Get('admin/ops/capacity') capacity(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.capacity(u, F(q)); }
  @Get('admin/ops/contribution') contribution(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.contribution(u, F(q)); }

  // central order management
  @Get('admin/orders') search(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.ops.searchOrders(u, { ...F(q), q: q.q, status: q.status, bucket: q.bucket, overdue: q.overdue === 'true', driverId: q.driverId, customer: q.customer, partial: q.partial === 'true', limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined }); }
  @Get('admin/orders/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.ops.orderDetail(u, id); }
  @Post('admin/orders/:id/remedy') remedy(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RemedyDto)) b: z.infer<typeof RemedyDto>) { return this.ops.remedy(u, id, b); }
  @Post('admin/orders/:id/reroute') reroute(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ fromStation: z.string(), toStation: z.string() }))) b: { fromStation: string; toStation: string }) { return this.ops.rerouteTickets(u, id, b.fromStation, b.toStation); }
  @Post('orders/:id/notes') note(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(NoteDto)) b: z.infer<typeof NoteDto>) { return this.ops.addNote(u, id, b); }
  @Get('message-templates') templates() { return this.ops.listTemplates(); }
  @Post('admin/message-templates') upsertTemplate(@CurrentUser() u: JwtPayload, @Body(zod(TemplateDto)) b: z.infer<typeof TemplateDto>) { return this.ops.upsertTemplate(u, b); }

  // alerts
  @Get('admin/alerts') list(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.alerts.list(u, { status: q.status, type: q.type, severity: q.severity, mine: q.mine === 'true', ownerRole: q.ownerRole, subjectId: q.subjectId }); }
  @Get('admin/alerts/summary') summary(@CurrentUser() u: JwtPayload) { return this.alerts.summary(u); }
  @Post('admin/alerts') create(@CurrentUser() u: JwtPayload, @Body(zod(AlertDto)) b: z.infer<typeof AlertDto>) { return this.alerts.create(u, b); }
  @RequiresPermission('ops.manage') @Post('admin/alerts/detect') detect() { return this.alerts.detect(); }
  @RequiresPermission('ops.manage') @Post('admin/alerts/escalate') escalate() { return this.alerts.escalate(); }
  @Post('admin/alerts/:id/:action') act(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('action') action: string, @Body(zod(ActDto)) b: z.infer<typeof ActDto>) {
    const map: Record<string, 'ACK' | 'ASSIGN' | 'RESOLVE' | 'COMMENT' | 'REOPEN'> = { ack: 'ACK', assign: 'ASSIGN', resolve: 'RESOLVE', comment: 'COMMENT', reopen: 'REOPEN' };
    return this.alerts.act(u, id, map[action] || 'COMMENT', b);
  }
}
