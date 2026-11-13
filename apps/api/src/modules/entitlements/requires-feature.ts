import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from './entitlements.service';

export const REQUIRES_FEATURE = 'requiresFeature';

/** Where the guard finds the location (or organization) the request is about. */
export type FeatureSource = `param:${string}` | `body:${string}` | `org-param:${string}`;

export interface FeatureRequirement {
  feature: string;
  from: FeatureSource;
  audience: 'merchant' | 'customer';
}

/**
 * Blocks the endpoint unless the location's plan includes `feature`.
 *   @RequiresFeature('reservations', 'param:id')           — /locations/:id/...
 *   @RequiresFeature('reservations', 'body:locationId', 'customer')
 *   @RequiresFeature('ads', 'org-param:id')               — /organizations/:id/...
 */
export const RequiresFeature = (feature: string, from: FeatureSource, audience: 'merchant' | 'customer' = 'merchant') => SetMetadata(REQUIRES_FEATURE, { feature, from, audience } satisfies FeatureRequirement);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly entitlements: EntitlementsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = this.reflector.getAllAndOverride<FeatureRequirement | undefined>(REQUIRES_FEATURE, [ctx.getHandler(), ctx.getClass()]);
    if (!req) return true;
    const http = ctx.switchToHttp().getRequest<{ params: Record<string, string>; body: Record<string, unknown> }>();
    const [kind, name] = req.from.split(':') as ['param' | 'body' | 'org-param', string];
    const id = kind === 'body' ? (http.body?.[name] as string | undefined) : http.params?.[name];
    if (!id || typeof id !== 'string') return true; // the endpoint's own validation reports the missing id
    if (kind === 'org-param') await this.entitlements.assertOrg(id, req.feature);
    else await this.entitlements.assertLocation(id, req.feature, req.audience);
    return true;
  }
}
