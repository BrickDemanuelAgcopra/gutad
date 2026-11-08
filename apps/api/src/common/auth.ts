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
  | 'ORG_MEMBER';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: RoleName[];
  /** organization memberships: orgId -> { roles, locationIds (empty = all) } */
  orgs: Record<string, { roles: RoleName[]; locationIds: string[] }>;
  isGuest?: boolean;
}

export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): JwtPayload | undefined => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/** Global guard: attaches user from Bearer token; rejects when route is not @Public and no token. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        req.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
      } catch {
        req.user = undefined;
      }
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    if (!req.user) throw new UnauthorizedException('Sign in required');
    return true;
  }
}

/** Role guard: platform admins pass everything; otherwise user must hold one of the listed roles globally or in any org. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleName[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthorizedException();
    if (hasAnyRole(user, required)) return true;
    throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
  }
}

export function hasAnyRole(user: JwtPayload, roles: RoleName[]): boolean {
  if (user.roles.includes('PLATFORM_ADMIN')) return true;
  if (user.roles.some((r) => roles.includes(r))) return true;
  return Object.values(user.orgs || {}).some((m) => m.roles.some((r) => roles.includes(r)));
}

export function isPlatformStaff(user: JwtPayload): boolean {
  return user.roles.some((r) => ['PLATFORM_ADMIN', 'SUPPORT', 'FINANCE'].includes(r));
}

/** Throws unless the user is platform staff or has a merchant role in the organization scoped to the location (when given). */
export function assertOrgAccess(user: JwtPayload, organizationId: string, locationId?: string | null, roles?: RoleName[]) {
  if (isPlatformStaff(user)) return;
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
