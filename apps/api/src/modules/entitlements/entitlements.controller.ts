import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { asc, eq } from 'drizzle-orm';
import { assertOrgAccess, CurrentUser, JwtPayload } from '../../common/auth';
import { DB, Db } from '../../db/db.module';
import { features, locations } from '../../db/schema';
import { can, EntitlementsService, limitOf } from './entitlements.service';

@ApiTags('25 Contracts & monetization')
@ApiBearerAuth()
@Controller()
export class EntitlementsController {
  constructor(@Inject(DB) private readonly db: Db, private readonly svc: EntitlementsService) {}

  /** What this location's plan includes, resolved per feature, plus limits and current usage. Used by web and mobile. */
  @Get('locations/:id/entitlements') async forLocation(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    const [loc] = await this.db.select({ id: locations.id, orgId: locations.organizationId }).from(locations).where(eq(locations.id, id)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(u, loc.orgId, id);
    const e = await this.svc.forLocation(id);
    const org = await this.svc.forOrg(loc.orgId);
    const catalog = await this.db.select().from(features).where(eq(features.isActive, true)).orderBy(asc(features.sortOrder));
    return {
      source: e.source,
      planCode: e.planCode,
      planName: e.planName,
      unrestricted: e.unrestricted,
      features: Object.fromEntries(catalog.filter((f) => f.kind === 'BOOLEAN').map((f) => [f.key, can(e, f.key)])),
      limits: {
        locations: { max: limitOf(org, 'locations'), used: await this.svc.usage(loc.orgId, 'locations') },
        team_members: { max: limitOf(org, 'team_members'), used: await this.svc.usage(loc.orgId, 'team_members') },
      },
      names: Object.fromEntries(catalog.map((f) => [f.key, f.name])),
    };
  }
}
