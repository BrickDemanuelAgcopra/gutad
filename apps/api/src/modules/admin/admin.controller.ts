import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, JwtPayload, Public, RoleName } from '../../common/auth';
import { zod } from '../../common/zod.pipe';
import { STAFF_ROLES } from '@gutad/shared';
import { AdminService } from './admin.service';

const TenantDto = z.object({ name: z.string(), kind: z.enum(['MERCHANT', 'CORPORATE', 'CAMPUS', 'PARTNER', 'CREATOR']).optional(), ownerEmail: z.string().email(), featureFlags: z.record(z.union([z.boolean(), z.number().int().min(0), z.null()])).optional(), billingEmail: z.string().email().optional() });
const RoleDto = z.object({ email: z.string().email(), role: z.enum(STAFF_ROLES), grant: z.boolean() });
const SettingDto = z.object({ key: z.string(), value: z.unknown(), reason: z.string().optional() });

@ApiTags('30 Platform administration')
@Controller()
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Public() @Get('health') health() { return this.svc.health(); }
  @ApiBearerAuth() @Get('admin/tenants') tenants(@CurrentUser() u: JwtPayload) { return this.svc.listTenants(u); }
  @ApiBearerAuth() @Post('admin/tenants') provision(@CurrentUser() u: JwtPayload, @Body(zod(TenantDto)) b: z.infer<typeof TenantDto>) { return this.svc.provisionTenant(u, b); }
  @ApiBearerAuth() @Patch('admin/tenants/:id/features') features(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.record(z.union([z.boolean(), z.number().int().min(0), z.null()])))) b: Record<string, boolean | number | null>) { return this.svc.setFeatureFlags(u, id, b); }
  @ApiBearerAuth() @Post('admin/tenants/:id/offboard') offboard(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.offboard(u, id); }
  @ApiBearerAuth() @Post('admin/roles') roles(@CurrentUser() u: JwtPayload, @Body(zod(RoleDto)) b: z.infer<typeof RoleDto>) { return this.svc.grantPlatformRole(u, b.email, b.role as RoleName, b.grant); }
  @ApiBearerAuth() @Patch('admin/memberships/:id/approval-limit') limit(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body(zod(z.object({ approvalLimitCents: z.number().int().min(0) }))) b: { approvalLimitCents: number }) { return this.svc.setApprovalLimit(u, id, b.approvalLimitCents); }
  @ApiBearerAuth() @Get('admin/settings') settings(@CurrentUser() u: JwtPayload) { return this.svc.getSettings(u); }
  @ApiBearerAuth() @Post('admin/settings') setSetting(@CurrentUser() u: JwtPayload, @Body(zod(SettingDto)) b: z.infer<typeof SettingDto>) { return this.svc.setSetting(u, b.key, b.value, b.reason); }
  @ApiBearerAuth() @Get('admin/config-history') history(@CurrentUser() u: JwtPayload, @Query('organizationId') orgId?: string) { return this.svc.configHistory(u, orgId); }
  @ApiBearerAuth() @Get('admin/audit') audit(@CurrentUser() u: JwtPayload, @Query('entityType') t?: string, @Query('entityId') id?: string) { return this.svc.auditTrail(u, t, id); }
  @ApiBearerAuth() @Post('admin/integrations/:id/rotate-secret') rotate(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.svc.rotateIntegrationSecret(u, id); }
}
