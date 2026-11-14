import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { SENSITIVITY, STAFF_ROLES } from '@gutad/shared';
import { CurrentUser, JwtPayload, RequiresPermission, RequiresReason, RoleName } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { ApprovalsService } from './approvals.service';
import { SecurityService } from './security.service';

const Reason = z.object({ reason: z.string().min(5) });
const RolesDto = z.object({ email: z.string().email(), roles: z.array(z.enum(STAFF_ROLES)), reason: z.string().min(5) });
const ScopeDto = z.object({ regionIds: z.array(z.string().uuid()).optional(), organizationIds: z.array(z.string().uuid()).optional(), locationIds: z.array(z.string().uuid()).optional(), maxSensitivity: z.enum(SENSITIVITY).optional(), note: z.string().nullable().optional(), reason: z.string().min(5) });
const EmergencyDto = z.object({ roles: z.array(z.enum(STAFF_ROLES)).min(1), minutes: z.number().int().min(5).max(1440), reason: z.string().min(10), ticketRef: z.string().optional() });
const SupportDto = z.object({ organizationId: z.string().uuid(), minutes: z.number().int().min(5).max(240).optional(), reason: z.string().min(5), readOnly: z.boolean().optional() });
const RegionDto = z.object({ id: z.string().uuid().optional(), code: z.string().min(2).max(20), name: z.string().min(2), parentId: z.string().uuid().nullable().optional(), timezone: z.string().optional() });
const SettingsDto = z.object({
  sso: z.object({ enabled: z.boolean().optional(), issuer: z.string().optional(), clientId: z.string().optional(), clientSecret: z.string().optional(), redirectUri: z.string().optional(), mobileRedirectUri: z.string().regex(/^(gutad:\/\/[A-Za-z0-9/_-]*)?$/).optional(), allowedDomains: z.array(z.string()).optional(), label: z.string().optional() }).optional(),
  mfaRequiredRoles: z.array(z.string()).optional(),
  sessions: z.object({ staffTokenMinutes: z.number().int().min(5).max(1440).optional(), staffIdleMinutes: z.number().int().min(5).max(10080).optional(), staffMaxHours: z.number().int().min(1).max(720).optional() }).optional(),
  emergency: z.object({ maxMinutes: z.number().int().min(5).max(1440).optional(), grantableRoles: z.array(z.string()).optional() }).optional(),
  reason: z.string().min(5),
});
const AuditQ = (q: Record<string, string | undefined>) => ({ actorId: q.actorId, actor: q.actor, action: q.action, entityType: q.entityType, entityId: q.entityId, organizationId: q.organizationId, from: q.from, to: q.to, withReason: q.withReason === 'true', limit: q.limit ? Number(q.limit) : undefined });

@ApiTags('02 Organization & access')
@ApiBearerAuth()
@Controller()
export class SecurityController {
  constructor(private readonly svc: SecurityService, private readonly approvals: ApprovalsService) {}

  // staff & access
  @Get('admin/security/overview') overview(@CurrentUser() u: JwtPayload) { return this.svc.overview(u); }
  @Get('admin/security/staff') staff(@CurrentUser() u: JwtPayload) { return this.svc.listStaff(u); }
  @Get('admin/security/staff/:id') staffDetail(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.userDetail(u, id); }
  @RequiresReason() @Post('admin/security/staff/roles') setRoles(@CurrentUser() u: JwtPayload, @Body(zod(RolesDto)) b: z.infer<typeof RolesDto>) { return this.svc.setStaffRoles(u, b); }
  @RequiresReason() @Put('admin/security/staff/:id/scope') setScope(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ScopeDto)) b: z.infer<typeof ScopeDto>) { return this.svc.setScope(u, id, b); }
  @Post('admin/security/staff/:id/disable') disable(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.svc.setStatus(u, id, 'DISABLED', b.reason); }
  @Post('admin/security/staff/:id/enable') enable(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.svc.setStatus(u, id, 'ACTIVE', b.reason); }
  @Post('admin/security/staff/:id/reset-mfa') resetMfa(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.svc.resetMfa(u, id, b.reason); }
  @Post('admin/security/staff/:id/revoke-sessions') revoke(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason.extend({ sessionId: z.string().uuid().optional() }))) b: { reason: string; sessionId?: string }) { return this.svc.revokeUserSessions(u, id, b.reason, b.sessionId); }
  @Get('admin/security/settings') settings(@CurrentUser() u: JwtPayload) { return this.svc.securitySettings(u); }
  @RequiresReason() @Patch('admin/security/settings') updateSettings(@CurrentUser() u: JwtPayload, @Body(zod(SettingsDto)) b: z.infer<typeof SettingsDto>) { return this.svc.updateSecuritySettings(u, b); }

  // emergency & support access
  @Get('access-grants') grants(@CurrentUser() u: JwtPayload, @Query('kind') kind?: string, @Query('active') active?: string, @Query('unreviewed') unreviewed?: string) { return this.svc.listGrants(u, { kind, active: active === 'true', unreviewed: unreviewed === 'true' }); }
  @Post('access-grants/emergency') emergency(@CurrentUser() u: JwtPayload, @Body(zod(EmergencyDto)) b: z.infer<typeof EmergencyDto>) { return this.svc.requestEmergency(u, { ...b, roles: b.roles as RoleName[] }); }
  @Post('access-grants/support') support(@CurrentUser() u: JwtPayload, @Body(zod(SupportDto)) b: z.infer<typeof SupportDto>) { return this.svc.startSupportAccess(u, b); }
  @Post('access-grants/:id/end') end(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.endGrant(u, id); }
  @Post('access-grants/:id/review') review(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.svc.reviewGrant(u, id, b.note); }

  // structure
  @Get('admin/structure') structure(@CurrentUser() u: JwtPayload) { return this.svc.structure(u); }
  @RequiresPermission('merchants.read') @Get('admin/regions') regions() { return this.svc.listRegions(); }
  @Post('admin/regions') upsertRegion(@CurrentUser() u: JwtPayload, @Body(zod(RegionDto)) b: z.infer<typeof RegionDto>) { return this.svc.upsertRegion(u, b); }
  @Post('admin/locations/:id/region') locRegion(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ regionId: z.string().uuid().nullable() }))) b: { regionId: string | null }) { return this.svc.assignLocationRegion(u, id, b.regionId); }
  @Post('admin/organizations/:id/parent') parent(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ parentId: z.string().uuid().nullable() }))) b: { parentId: string | null }) { return this.svc.setParentOrg(u, id, b.parentId); }
  @Get('admin/organizations/lookup') lookup(@CurrentUser() u: JwtPayload, @Query('q') q?: string) { return this.svc.orgsLookup(u, q); }

  // audit
  @Get('admin/audit/search') audit(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>) { return this.svc.searchAudit(u, AuditQ(q)); }
  @Get('admin/audit/export.csv') async exportAudit(@CurrentUser() u: JwtPayload, @Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.svc.exportAudit(u, AuditQ(q));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gutad-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  // approvals
  @Get('approvals') list(@CurrentUser() u: JwtPayload, @Query('status') status?: string, @Query('kind') kind?: string, @Query('mine') mine?: string, @Query('organizationId') organizationId?: string) { return this.approvals.list(u, { status, kind, mine: mine === 'true', organizationId }); }
  @Get('approvals/summary') summary(@CurrentUser() u: JwtPayload) { return this.approvals.pendingCount(u); }
  @Get('approvals/:id') get(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.approvals.get(u, id); }
  @Post('approvals/:id/approve') approve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().optional() }))) b: { note?: string }) { return this.approvals.decide(u, id, true, b.note); }
  @Post('approvals/:id/reject') reject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3) }))) b: { note: string }) { return this.approvals.decide(u, id, false, b.note); }
  @Post('approvals/:id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.approvals.cancel(u, id); }
  @Post('approvals/:id/retry') retry(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.approvals.retry(u, id); }
  @Delete('approvals/:id') del(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.approvals.cancel(u, id); }
}
