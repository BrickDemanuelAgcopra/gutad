import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { isStaffRole, permissionsFor, type Permission, type Sensitivity } from '@gutad/shared';
import { RedisService } from '../core/redis.service';
import { ctx, isMutatingRequest } from './request-context';

export type RoleName =
  | 'CUSTOMER'
  | 'MERCHANT_OWNER'
  | 'MERCHANT_MANAGER'
  | 'MERCHANT_STAFF'
  | 'HOST'
  | 'KITCHEN'
  | 'PACKER'
  | 'DISPATCHER'
  | 'DRIVER'
  | 'SUPPORT'
  | 'FINANCE'
  | 'PLATFORM_ADMIN'
  | 'ORG_MEMBER'
  | 'EXECUTIVE'
  | 'OPERATIONS'
  | 'CULINARY'
  | 'MARKETING'
  | 'IT';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: RoleName[];
  /** organization memberships: orgId -> { roles, locationIds (empty = all) } */
  orgs: Record<string, { roles: RoleName[]; locationIds: string[] }>;
  isGuest?: boolean;
  /** session id (user_sessions.id) — lets a session be revoked before the token expires */
  sid?: string;
  /** authentication methods used for this session: pwd, mfa, sso */
  amr?: string[];
  /** true when a role of this person requires MFA and this session did not use it */
  mfaPending?: boolean;
  /** emergency elevation: extra staff roles until an ISO time */
  elev?: { roles: RoleName[]; until: string; gid: string };
  /** audited support session for one organization */
  sup?: { org: string; until: string; ro: boolean; gid: string };
  /** staff scope: organizations and locations (regions expanded at sign-in); empty lists = unrestricted */
  scope?: { orgIds: string[]; locationIds: string[]; locOrgIds: string[]; max: Sensitivity };
}

export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES, roles);
export const PERMISSION = 'permission';
/** Route needs this admin-console permission (see `ROLE_PERMISSIONS` in @gutad/shared). */
export const RequiresPermission = (...perms: Permission[]) => SetMetadata(PERMISSION, perms);
export const REASON = 'requiresReason';
/** Route needs a reason (body `reason` or header `X-Audit-Reason`); it is written to the audit log. */
export const RequiresReason = () => SetMetadata(REASON, true);

export const CurrentUser = createParamDecorator((_data: unknown, c: ExecutionContext): JwtPayload | undefined => {
  return c.switchToHttp().getRequest<AuthedRequest>().user;
});

const live = (until?: string) => !!until && new Date(until).getTime() > Date.now();

/** Roles held right now: the person's own plus any unexpired emergency elevation. */
export function effectiveRoles(user: JwtPayload): RoleName[] {
  if (user.elev && live(user.elev.until)) return Array.from(new Set([...user.roles, ...user.elev.roles]));
  return user.roles;
}

/** Global guard: attaches user from Bearer token; rejects when route is not @Public and no token. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector, private readonly redis: RedisService) {}

  async canActivate(c: ExecutionContext): Promise<boolean> {
    const req = c.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        req.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
      } catch {
        req.user = undefined;
      }
      if (req.user?.sid) {
        // revoked sessions are written to Redis for the lifetime of their access tokens
        const revoked = await this.redis.client.exists(`sess:revoked:${req.user.sid}`).catch(() => 0);
        if (revoked) req.user = undefined;
      }
      if (req.user?.sup && !live(req.user.sup.until)) req.user.sup = undefined;
      const store = ctx();
      if (store && req.user) {
        store.userId = req.user.sub;
        store.grantId = (req.user.elev && live(req.user.elev.until) ? req.user.elev.gid : undefined) || req.user.sup?.gid;
        const b = (req.body || {}) as { reason?: unknown };
        if (!store.reason && typeof b.reason === 'string' && b.reason.trim()) store.reason = b.reason.trim().slice(0, 500);
      }
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [c.getHandler(), c.getClass()]);
    if (isPublic) return true;
    if (!req.user) throw new UnauthorizedException('Sign in required');
    return true;
  }
}

/** Role/permission guard: platform admins pass role checks; permission checks honour scope, MFA and sensitivity. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(c: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleName[]>(ROLES, [c.getHandler(), c.getClass()]);
    const perms = this.reflector.getAllAndOverride<Permission[]>(PERMISSION, [c.getHandler(), c.getClass()]);
    const needsReason = this.reflector.getAllAndOverride<boolean>(REASON, [c.getHandler(), c.getClass()]);
    const user = c.switchToHttp().getRequest<AuthedRequest>().user;
    if (needsReason && !(ctx()?.reason && ctx()!.reason!.length >= 5)) throw new ForbiddenException({ message: 'A reason (at least 5 characters) is required for this action', code: 'REASON_REQUIRED' });
    if ((!required || required.length === 0) && (!perms || perms.length === 0)) return true;
    if (!user) throw new UnauthorizedException();
    if (required?.length && !hasAnyRole(user, required)) throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    if (perms?.length && !perms.some((p) => can(user, p))) throw permissionError(user, perms);
    return true;
  }
}

function permissionError(user: JwtPayload, perms: Permission[]) {
  if (user.mfaPending) return new ForbiddenException({ message: 'Set up two-factor authentication to use the admin console', code: 'MFA_REQUIRED' });
  return new ForbiddenException({ message: `Requires permission: ${perms.join(' or ')}`, code: 'PERMISSION_REQUIRED' });
}

export function hasAnyRole(user: JwtPayload, roles: RoleName[]): boolean {
  const eff = user.mfaPending ? effectiveRoles(user).filter((r) => !isStaffRole(r)) : effectiveRoles(user);
  if (eff.includes('PLATFORM_ADMIN')) return true;
  if (eff.some((r) => roles.includes(r))) return true;
  return Object.values(user.orgs || {}).some((m) => m.roles.some((r) => roles.includes(r)));
}

/** Staff roles that act across tenants (platform DISPATCHER is permission-only and does not bypass org checks). */
const CROSS_TENANT = (r: string) => isStaffRole(r) && r !== 'DISPATCHER';

export function isPlatformStaff(user: JwtPayload): boolean {
  if (user.mfaPending) return false;
  return effectiveRoles(user).some(CROSS_TENANT);
}

/** Admin-console permissions held right now (empty while MFA is pending). */
export function permissionsOf(user: JwtPayload): Permission[] {
  if (user.mfaPending) return [];
  return permissionsFor(effectiveRoles(user), user.scope?.max || 'RESTRICTED');
}

export function can(user: JwtPayload | undefined, perm: Permission): boolean {
  return !!user && permissionsOf(user).includes(perm);
}

export function assertCan(user: JwtPayload, ...perms: Permission[]) {
  if (!perms.some((p) => can(user, p))) throw permissionError(user, perms);
}

/** True when a scoped staff member may reach this organization (and location, when given). */
export function staffCovers(user: JwtPayload, organizationId: string, locationId?: string | null): boolean {
  const s = user.scope;
  if (!s || (!s.orgIds.length && !s.locationIds.length)) return true;
  if (s.orgIds.includes(organizationId)) return true;
  if (locationId) return s.locationIds.includes(locationId);
  return s.locOrgIds.includes(organizationId);
}

/** Throws unless the user is (in-scope) platform staff or has a merchant role in the organization scoped to the location. */
export function assertOrgAccess(user: JwtPayload, organizationId: string, locationId?: string | null, roles?: RoleName[]) {
  if (isPlatformStaff(user)) {
    if (!staffCovers(user, organizationId, locationId)) throw new ForbiddenException('Outside your access scope');
    if (user.sup && user.sup.org === organizationId && user.sup.ro && isMutatingRequest() && !user.orgs?.[organizationId]) {
      throw new ForbiddenException({ message: 'Support access is read-only', code: 'SUPPORT_READ_ONLY' });
    }
    return;
  }
  const m = user.orgs?.[organizationId];
  if (!m) throw new ForbiddenException('No access to this organization');
  if (roles && roles.length && !m.roles.some((r) => roles.includes(r))) {
    throw new ForbiddenException(`Requires one of: ${roles.join(', ')}`);
  }
  if (locationId && m.locationIds.length && !m.locationIds.includes(locationId)) {
    throw new ForbiddenException('No access to this location');
  }
}

export const MERCHANT_ROLES: RoleName[] = ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST', 'KITCHEN', 'PACKER', 'DISPATCHER'];
export const MANAGER_ROLES: RoleName[] = ['MERCHANT_OWNER', 'MERCHANT_MANAGER'];
