import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { SENSITIVITY } from '@gutad/shared';
import { CurrentUser, JwtPayload, Public, RequiresReason } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { IamService } from './iam.service';
import { IamGovernanceService } from './iam-governance.service';

const StepUp = z.object({ code: z.string().max(12).optional(), password: z.string().max(200).optional() }).nullable().optional();
const Reason = z.object({ reason: z.string().min(5), stepUp: StepUp });
const Limits = z.record(z.string(), z.number().int().min(0).nullable());
const UserDto = z.object({ email: z.string().email(), name: z.string().max(120).nullable().optional(), phone: z.string().max(40).nullable().optional(), title: z.string().max(120).nullable().optional(), department: z.string().max(120).nullable().optional(), team: z.string().max(60).nullable().optional(), managerId: z.string().uuid().nullable().optional(), employeeId: z.string().max(60).nullable().optional(), roleIds: z.array(z.string().uuid()).optional(), primaryRoleId: z.string().uuid().nullable().optional(), sendInvite: z.boolean().optional(), reason: z.string().min(5), stepUp: StepUp });
const UserPatch = UserDto.omit({ email: true, roleIds: true, primaryRoleId: true, sendInvite: true, reason: true, stepUp: true }).extend({ reason: z.string().optional() });
const StatusDto = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED', 'ARCHIVED']), reason: z.string().min(5), until: z.string().datetime().nullable().optional(), stepUp: StepUp });
const ImportDto = z.object({ rows: z.array(z.object({ email: z.string(), name: z.string().optional(), title: z.string().optional(), department: z.string().optional(), team: z.string().optional(), roles: z.array(z.string()).optional() })).min(1).max(500), sendInvites: z.boolean().optional(), dryRun: z.boolean().optional(), reason: z.string().min(5) });
const OffboardDto = z.object({ reason: z.string().min(5), transferToUserId: z.string().uuid().nullable().optional(), stepUp: StepUp });
const RoleDto = z.object({ name: z.string().min(2).max(80), description: z.string().max(500).optional(), permissions: z.array(z.string()).optional(), approvalLimits: Limits.optional(), mfaRequired: z.boolean().optional(), requestable: z.boolean().optional(), copyFromRoleId: z.string().uuid().optional(), reason: z.string().min(5) });
const RolePatchDto = z.object({ name: z.string().min(2).max(80).optional(), description: z.string().max(500).optional(), permissions: z.array(z.string()).optional(), approvalLimits: Limits.optional(), mfaRequired: z.boolean().optional(), requestable: z.boolean().optional(), reason: z.string().min(5), stepUp: StepUp });
const MatrixDto = z.object({ changes: z.array(z.object({ roleId: z.string().uuid(), permission: z.string(), granted: z.boolean() })).max(2000), reason: z.string().min(5), stepUp: StepUp });
const AssignDto = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200), roleId: z.string().uuid(), kind: z.enum(['STANDARD', 'TEMPORARY']).optional(), isPrimary: z.boolean().optional(), responsibility: z.string().max(200).nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), reason: z.string().min(5), stepUp: StepUp });
const ActingDto = z.object({ userId: z.string().uuid(), forUserId: z.string().uuid(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime(), reason: z.string().min(5) });
const AssignPatch = z.object({ isPrimary: z.boolean().optional(), responsibility: z.string().max(200).nullable().optional(), endsAt: z.string().datetime().nullable().optional(), reason: z.string().min(5), stepUp: StepUp });
const ScopeDto = z.object({ regionIds: z.array(z.string().uuid()).optional(), organizationIds: z.array(z.string().uuid()).optional(), locationIds: z.array(z.string().uuid()).optional(), companyIds: z.array(z.string().uuid()).optional(), kitchenIds: z.array(z.string().uuid()).optional(), brandIds: z.array(z.string().uuid()).optional(), teams: z.array(z.string().max(40)).optional(), maxSensitivity: z.enum(SENSITIVITY).optional(), note: z.string().nullable().optional(), reason: z.string().min(5) });
const RequestDto = z.object({ roleId: z.string().uuid(), justification: z.string().min(10).max(1000), durationHours: z.number().int().min(1).max(24 * 90).nullable().optional() });
const DecideDto = z.object({ note: z.string().max(500).optional(), durationHours: z.number().int().min(1).max(24 * 90).nullable().optional() });
const ReviewDto = z.object({ name: z.string().min(3).max(120), dueInDays: z.number().int().min(1).max(90).optional(), roleIds: z.array(z.string().uuid()).optional(), inactiveDays: z.number().int().min(1).max(365).optional() });
const ReviewItemDto = z.object({ decision: z.enum(['KEEP', 'REVOKE', 'SUSPEND']), note: z.string().max(500).optional(), stepUp: StepUp });
const ServiceDto = z.object({ name: z.string().min(2).max(80), description: z.string().max(500).optional(), ownerId: z.string().uuid().nullable().optional(), permissions: z.array(z.string()), organizationIds: z.array(z.string().uuid()).optional(), ipAllowlist: z.array(z.string().max(64)).optional(), reason: z.string().min(5) });
const ServicePatch = z.object({ description: z.string().max(500).optional(), ownerId: z.string().uuid().nullable().optional(), permissions: z.array(z.string()).optional(), organizationIds: z.array(z.string().uuid()).optional(), ipAllowlist: z.array(z.string().max(64)).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), reason: z.string().min(5) });
const KeyDto = z.object({ name: z.string().min(2).max(80), expiresInDays: z.number().int().min(1).max(3650), reason: z.string().optional() });
const RotateDto = z.object({ graceHours: z.number().int().min(0).max(168).optional(), expiresInDays: z.number().int().min(1).max(3650).optional(), reason: z.string().optional() });
const PolicyDto = z.object({ superadminGranters: z.array(z.string().uuid()).optional(), requireSecondApprover: z.boolean().optional(), maxLoginAttempts: z.number().int().min(3).max(50).optional(), lockMinutes: z.number().int().min(1).max(1440).optional(), ipMaxAttempts: z.number().int().min(10).max(10000).optional(), inactiveDays: z.number().int().min(7).max(365).optional(), autoSuspendInactiveDays: z.number().int().min(0).max(730).optional(), reviewIntervalDays: z.number().int().min(0).max(365).optional(), apiKeyMaxDays: z.number().int().min(1).max(3650).optional(), inviteDays: z.number().int().min(1).max(30).optional(), reason: z.string().min(5), stepUp: StepUp });
const AcceptDto = z.object({ token: z.string().min(10), password: z.string().min(10).max(200), name: z.string().max(120).optional() });

const meta = (r: Request) => ({ client: (r.headers['x-client'] as string) || 'web', ip: r.ip || null, userAgent: (r.headers['user-agent'] as string) || null, deviceId: (r.headers['x-device-id'] as string) || null });
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Users, Roles & Permissions (identity and access management). */
@ApiTags('02 Organization & access')
@ApiBearerAuth()
@Controller()
export class IamController {
  constructor(private readonly iam: IamService, private readonly gov: IamGovernanceService) {}

  // overview & directory
  @Get('admin/iam/overview') overview(@CurrentUser() u: JwtPayload) { return this.iam.overview(u); }
  @Get('admin/iam/users') users(@CurrentUser() u: JwtPayload, @Query('q') q?: string, @Query('status') status?: string, @Query('roleId') roleId?: string) { return this.iam.listUsers(u, { q, status, roleId }); }
  @Get('admin/iam/users/export.csv') async exportUsers(@CurrentUser() u: JwtPayload, @Res() res: Response) {
    const rows = await this.iam.listUsers(u, {});
    const head = ['email', 'name', 'status', 'title', 'department', 'team', 'roles', 'primaryRole', 'mfaEnabled', 'lastLoginAt', 'inactive'];
    const csv = [head.join(','), ...rows.map((r) => [r.email, r.name, r.status, r.title, r.department, r.team, r.roles.map((x) => x.key + (x.endsAt ? `(until ${new Date(x.endsAt).toISOString().slice(0, 10)})` : '')).join(' '), r.roles.find((x) => x.primary)?.key || '', r.mfaEnabled, r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : '', r.inactive].map(csvCell).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gutad-staff-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
  @Get('admin/iam/users/:id') user(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.iam.getUser(u, id); }
  @Get('admin/iam/users/:id/effective') effective(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.iam.effective(u, id); }
  @Get('admin/iam/explain') explain(@CurrentUser() u: JwtPayload, @Query('userId') userId: string, @Query('permission') permission: string, @Query('organizationId') organizationId?: string, @Query('locationId') locationId?: string) { return this.iam.explain(u, { userId, permission, organizationId, locationId }); }
  @RequiresReason() @Post('admin/iam/users') create(@CurrentUser() u: JwtPayload, @Body(zod(UserDto)) b: z.infer<typeof UserDto>) { return this.iam.createUser(u, b); }
  @RequiresReason() @Post('admin/iam/users/import') import(@CurrentUser() u: JwtPayload, @Body(zod(ImportDto)) b: z.infer<typeof ImportDto>) { return this.iam.importUsers(u, b); }
  @Patch('admin/iam/users/:id') update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(UserPatch)) b: z.infer<typeof UserPatch>) { return this.iam.updateUser(u, id, b); }
  @RequiresReason() @Post('admin/iam/users/:id/status') status(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(StatusDto)) b: z.infer<typeof StatusDto>) { return this.iam.setStatus(u, id, b); }
  @Post('admin/iam/users/:id/resend-invite') resend(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.iam.resendInvite(u, id); }
  @Post('admin/iam/users/:id/revoke-invite') revokeInvite(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.iam.revokeInvite(u, id); }
  @Post('admin/iam/users/:id/unlock') unlock(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.iam.unlock(u, id); }
  @RequiresReason() @Post('admin/iam/users/:id/force-logout') forceLogout(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.iam.forceLogout(u, id, b.reason); }
  @RequiresReason() @Post('admin/iam/users/:id/offboard') offboard(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(OffboardDto)) b: z.infer<typeof OffboardDto>) { return this.iam.offboard(u, id, b); }
  @RequiresReason() @Put('admin/iam/users/:id/scope') scope(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ScopeDto)) b: z.infer<typeof ScopeDto>) { return this.iam.setScope(u, id, b); }

  // public invitation acceptance
  @Public() @Get('auth/invite/:token') peek(@Param('token') t: string) { return this.iam.peekInvite(t); }
  @Public() @Post('auth/invite/accept') accept(@Req() r: Request, @Body(zod(AcceptDto)) b: z.infer<typeof AcceptDto>) { return this.iam.acceptInvite(b.token, b.password, b.name, meta(r)); }

  // roles & matrix
  @Get('admin/iam/roles') roles(@CurrentUser() u: JwtPayload, @Query('archived') archived?: string) { return this.iam.listRoles(u, archived === 'true'); }
  @RequiresReason() @Post('admin/iam/roles') createRole(@CurrentUser() u: JwtPayload, @Body(zod(RoleDto)) b: z.infer<typeof RoleDto>) { return this.iam.createRole(u, b); }
  @RequiresReason() @Patch('admin/iam/roles/:id') updateRole(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RolePatchDto)) b: z.infer<typeof RolePatchDto>) { return this.iam.updateRole(u, id, b); }
  @RequiresReason() @Post('admin/iam/roles/:id/duplicate') duplicate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ name: z.string().min(2).max(80), reason: z.string().min(5) }))) b: { name: string; reason: string }) { return this.iam.createRole(u, { name: b.name, copyFromRoleId: id, reason: b.reason }); }
  @RequiresReason() @Post('admin/iam/roles/:id/archive') archive(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.iam.archiveRole(u, id, b.reason); }
  @RequiresReason() @Post('admin/iam/roles/:id/restore') restore(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.iam.restoreRole(u, id, b.reason); }
  @RequiresReason() @Put('admin/iam/matrix') matrix(@CurrentUser() u: JwtPayload, @Body(zod(MatrixDto)) b: z.infer<typeof MatrixDto>) { return this.iam.saveMatrix(u, b); }

  // assignments
  @RequiresReason() @Post('admin/iam/assignments') assign(@CurrentUser() u: JwtPayload, @Body(zod(AssignDto)) b: z.infer<typeof AssignDto>) { return this.iam.assign(u, b); }
  @RequiresReason() @Post('admin/iam/assignments/acting') acting(@CurrentUser() u: JwtPayload, @Body(zod(ActingDto)) b: z.infer<typeof ActingDto>) { return this.iam.actFor(u, b); }
  @RequiresReason() @Patch('admin/iam/assignments/:id') updateAssignment(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(AssignPatch)) b: z.infer<typeof AssignPatch>) { return this.iam.updateAssignment(u, id, b); }
  @RequiresReason() @Post('admin/iam/assignments/:id/revoke') revokeAssignment(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: z.infer<typeof Reason>) { return this.iam.revokeAssignment(u, id, b); }

  // sessions & sign-ins
  @Get('admin/iam/sessions') sessions(@CurrentUser() u: JwtPayload, @Query('userId') userId?: string) { return this.iam.listSessions(u, { userId }); }
  @RequiresReason() @Post('admin/iam/sessions/revoke-all') revokeAll(@CurrentUser() u: JwtPayload, @Body(zod(Reason)) b: z.infer<typeof Reason>) { return this.iam.revokeAllStaffSessions(u, b.reason, b.stepUp); }
  @RequiresReason() @Post('admin/iam/sessions/:id/revoke') revokeSession(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(Reason)) b: { reason: string }) { return this.iam.revokeSession(u, id, b.reason); }
  @Get('admin/iam/login-events') logins(@CurrentUser() u: JwtPayload, @Query('userId') userId?: string, @Query('outcome') outcome?: string, @Query('suspicious') suspicious?: string, @Query('email') email?: string) { return this.iam.loginEvents(u, { userId, outcome, suspicious: suspicious === 'true', email }); }

  // access requests (any staff member)
  @Get('iam/requestable-roles') requestable(@CurrentUser() u: JwtPayload) { return this.gov.requestableRoles(u); }
  @Get('iam/access-requests') requests(@CurrentUser() u: JwtPayload, @Query('mine') mine?: string, @Query('status') status?: string) { return this.gov.listRequests(u, { mine: mine === 'true', status }); }
  @Post('iam/access-requests') request(@CurrentUser() u: JwtPayload, @Body(zod(RequestDto)) b: z.infer<typeof RequestDto>) { return this.gov.createRequest(u, b); }
  @Post('iam/access-requests/:id/approve') approve(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(DecideDto)) b: z.infer<typeof DecideDto>) { return this.gov.decideRequest(u, id, { approve: true, ...b }); }
  @Post('iam/access-requests/:id/reject') reject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ note: z.string().min(3).max(500) }))) b: { note: string }) { return this.gov.decideRequest(u, id, { approve: false, note: b.note }); }
  @Post('iam/access-requests/:id/cancel') cancelRequest(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gov.cancelRequest(u, id); }
  @Get('iam/whoami') whoami(@CurrentUser() u: JwtPayload) { return this.gov.whoami(u); }

  // access reviews
  @Get('admin/iam/reviews') reviews(@CurrentUser() u: JwtPayload) { return this.gov.listReviews(u); }
  @Post('admin/iam/reviews') createReview(@CurrentUser() u: JwtPayload, @Body(zod(ReviewDto)) b: z.infer<typeof ReviewDto>) { return this.gov.createReview(u, b); }
  @Get('admin/iam/reviews/:id') review(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gov.getReview(u, id); }
  @Post('admin/iam/reviews/:id/items/:itemId') decideItem(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string, @Body(zod(ReviewItemDto)) b: z.infer<typeof ReviewItemDto>) { return this.gov.decideItem(u, id, itemId, b); }
  @Post('admin/iam/reviews/:id/complete') completeReview(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gov.completeReview(u, id); }

  // service accounts & API keys
  @Get('admin/iam/service-accounts') services(@CurrentUser() u: JwtPayload) { return this.gov.listServiceAccounts(u); }
  @RequiresReason() @Post('admin/iam/service-accounts') createService(@CurrentUser() u: JwtPayload, @Body(zod(ServiceDto)) b: z.infer<typeof ServiceDto>) { return this.gov.createServiceAccount(u, b); }
  @RequiresReason() @Patch('admin/iam/service-accounts/:id') updateService(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(ServicePatch)) b: z.infer<typeof ServicePatch>) { return this.gov.updateServiceAccount(u, id, b); }
  @Post('admin/iam/service-accounts/:id/keys') createKey(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(KeyDto)) b: z.infer<typeof KeyDto>) { return this.gov.createKey(u, id, b); }
  @Post('admin/iam/keys/:id/rotate') rotate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(RotateDto)) b: z.infer<typeof RotateDto>) { return this.gov.rotateKey(u, id, b); }
  @Delete('admin/iam/keys/:id') revokeKey(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Query('reason') reason?: string) { return this.gov.revokeKey(u, id, reason || 'revoked'); }

  // security alerts
  @Get('admin/iam/alerts') alerts(@CurrentUser() u: JwtPayload, @Query('open') open?: string, @Query('type') type?: string) { return this.gov.listAlerts(u, { open: open === 'true', type }); }
  @Post('admin/iam/alerts/:id/ack') ack(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.gov.ackAlert(u, id); }

  // access policy
  @Get('admin/iam/policy') policy(@CurrentUser() u: JwtPayload) { return this.gov.getPolicy(u); }
  @RequiresReason() @Patch('admin/iam/policy') updatePolicy(@CurrentUser() u: JwtPayload, @Body(zod(PolicyDto)) b: z.infer<typeof PolicyDto>) { return this.gov.updatePolicy(u, b); }
}
