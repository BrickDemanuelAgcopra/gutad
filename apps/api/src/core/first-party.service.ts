import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import { DEFAULT_FIRST_PARTY_POLICY, FIRST_PARTY_ORG_KIND, firstPartyRulesFor, type FirstPartyPolicy, type FirstPartyRules } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../db/db.module';
import { locations, marketplacePolicyVersions, organizations } from '../db/schema';
import { RedisService } from './redis.service';

const POLICY_KEY = 'fp:policy';
const ORGS_KEY = 'fp:orgs';

/**
 * Who is first-party (Gutad's own organization, kind PLATFORM) and which marketplace policy applies to it.
 * Cached in Redis for a short time and cleared on every change, so the kill switch reaches every API instance at once.
 */
@Injectable()
export class FirstPartyService {
  constructor(@Inject(DB) private readonly db: Db, private readonly redis: RedisService) {}

  async platformOrgIds(tx: DbOrTx = this.db): Promise<string[]> {
    if (tx === this.db) {
      const cached = await this.redis.getJson<string[]>(ORGS_KEY);
      if (cached) return cached;
    }
    const rows = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.kind, FIRST_PARTY_ORG_KIND));
    const ids = rows.map((r) => r.id);
    if (tx === this.db) await this.redis.setJson(ORGS_KEY, ids, 60);
    return ids;
  }

  async clearOrgCache() {
    await this.redis.del(ORGS_KEY);
  }

  async isFirstPartyOrg(orgId: string | null | undefined, tx: DbOrTx = this.db) {
    return !!orgId && (await this.platformOrgIds(tx)).includes(orgId);
  }

  async isFirstPartyLocation(locationId: string, tx: DbOrTx = this.db) {
    const [l] = await tx.select({ orgId: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    return this.isFirstPartyOrg(l?.orgId, tx);
  }

  async firstPartyLocationIds(ids: string[], tx: DbOrTx = this.db): Promise<Set<string>> {
    const orgs = await this.platformOrgIds(tx);
    if (!ids.length || !orgs.length) return new Set();
    const rows = await tx.select({ id: locations.id }).from(locations).where(inArray(locations.organizationId, orgs));
    const all = new Set(rows.map((r) => r.id));
    return new Set(ids.filter((i) => all.has(i)));
  }

  async policy(): Promise<FirstPartyPolicy & { version: number }> {
    const cached = await this.redis.getJson<FirstPartyPolicy & { version: number }>(POLICY_KEY);
    if (cached) return cached;
    const [row] = await this.db.select().from(marketplacePolicyVersions).orderBy(desc(marketplacePolicyVersions.version)).limit(1);
    const value = { ...DEFAULT_FIRST_PARTY_POLICY, ...((row?.policy as Partial<FirstPartyPolicy>) || {}), version: row?.version ?? 0 };
    await this.redis.setJson(POLICY_KEY, value, 30);
    return value;
  }

  async rulesFor(city?: string | null): Promise<FirstPartyRules> {
    return firstPartyRulesFor(await this.policy(), city);
  }

  async clearPolicyCache() {
    await this.redis.del(POLICY_KEY);
  }
}
