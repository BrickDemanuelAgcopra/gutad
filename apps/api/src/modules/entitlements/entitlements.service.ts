import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { addOns, contractLocations, features, locations, merchantContracts, orgAddOns, orgMemberships, organizations, platformSettings } from '../../db/schema';
import { PlansService } from '../contracts/plans.service';
import { FIRST_PARTY_ORG_KIND } from '@gutad/shared';

export type FeatureValue = boolean | number;

/**
 * What a location may use. Sources, in order of precedence:
 *   1. organization overrides (`organizations.feature_flags`, set by platform staff) — true/false/number per key
 *   2. the location's active contract, copied from a plan version (`merchant_contracts.features`)
 *   3. contracts that predate the plan catalog are grandfathered: everything allowed, no limits
 *   4. no contract yet: the default plan (platform setting `plans.default_plan_code`, DIRECT_FREE if unset)
 * Active add-ons are merged into 2 and 4: they switch features on and add to number limits.
 */
export interface Entitlements {
  source: 'PLAN' | 'LEGACY' | 'DEFAULT';
  planCode: string | null;
  planName: string | null;
  contractId: string | null;
  unrestricted: boolean;
  features: Record<string, FeatureValue>;
  overrides: Record<string, FeatureValue>;
  addOns: string[];
}

/** Plan features + add-ons: booleans OR together; numbers add up (a missing plan limit stays unlimited). */
export function mergeAddOns(base: Record<string, FeatureValue>, extras: { features: Record<string, FeatureValue>; quantity: number }[]) {
  const out = { ...base };
  for (const a of extras) {
    for (const [k, v] of Object.entries(a.features || {})) {
      if (typeof v === 'number') {
        if (typeof out[k] === 'number') out[k] = (out[k] as number) + v * a.quantity;
      } else if (v) out[k] = true;
    }
  }
  return out;
}

export function can(e: Entitlements, key: string): boolean {
  if (key in e.overrides) return !!e.overrides[key];
  if (e.unrestricted) return true;
  return !!e.features[key];
}

/** null = unlimited. */
export function limitOf(e: Entitlements, key: string): number | null {
  const o = e.overrides[key];
  if (typeof o === 'number') return o;
  if (o === true || e.unrestricted) return null;
  const v = e.features[key];
  return typeof v === 'number' ? v : null;
}

const CACHE_MS = 30_000;

@Injectable()
export class EntitlementsService {
  private defaultCache: { at: number; value: { code: string; name: string; features: Record<string, FeatureValue> } | null } | null = null;
  private namesCache: { at: number; names: Map<string, string> } | null = null;

  constructor(@Inject(DB) private readonly db: Db, private readonly plans: PlansService) {}

  private async defaultPlan() {
    if (this.defaultCache && Date.now() - this.defaultCache.at < CACHE_MS) return this.defaultCache.value;
    const [s] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, 'plans.default_plan_code')).limit(1);
    const code = typeof s?.value === 'string' ? s.value : 'DIRECT_FREE';
    let value: { code: string; name: string; features: Record<string, FeatureValue> } | null = null;
    try {
      const pv = await this.plans.publishedVersion(code);
      value = { code, name: pv.plan.name, features: pv.features };
    } catch {
      value = null; // no catalog yet → fall back to unrestricted below
    }
    this.defaultCache = { at: Date.now(), value };
    return value;
  }

  async featureName(key: string) {
    if (!this.namesCache || Date.now() - this.namesCache.at > CACHE_MS) {
      const rows = await this.db.select({ key: features.key, name: features.name }).from(features);
      this.namesCache = { at: Date.now(), names: new Map(rows.map((r) => [r.key, r.name])) };
    }
    return this.namesCache.names.get(key) || key.replace(/_/g, ' ');
  }

  private build(contract: typeof merchantContracts.$inferSelect | undefined, overrides: Record<string, FeatureValue>, def: Awaited<ReturnType<EntitlementsService['defaultPlan']>>, extras: { code: string; features: Record<string, FeatureValue>; quantity: number }[] = [], orgKind?: string | null): Entitlements {
    const addOnCodes = extras.map((x) => x.code);
    // Gutad's own organization (first-party) is not on a merchant plan: everything allowed, no limits, no billing
    if (orgKind === FIRST_PARTY_ORG_KIND) return { source: 'PLAN', planCode: 'GUTAD_FIRST_PARTY', planName: 'Gutad first-party', contractId: null, unrestricted: true, features: {}, overrides, addOns: addOnCodes };
    if (contract && !contract.planVersionId) return { source: 'LEGACY', planCode: contract.planCode, planName: contract.name, contractId: contract.id, unrestricted: true, features: {}, overrides, addOns: addOnCodes };
    if (contract) return { source: 'PLAN', planCode: contract.planCode, planName: contract.name, contractId: contract.id, unrestricted: false, features: mergeAddOns((contract.features as Record<string, FeatureValue>) || {}, extras), overrides, addOns: addOnCodes };
    if (def) return { source: 'DEFAULT', planCode: def.code, planName: def.name, contractId: null, unrestricted: false, features: mergeAddOns(def.features, extras), overrides, addOns: addOnCodes };
    return { source: 'DEFAULT', planCode: null, planName: null, contractId: null, unrestricted: true, features: {}, overrides, addOns: addOnCodes };
  }

  private async addOnsFor(orgIds: string[], at: Date, tx: DbOrTx) {
    if (!orgIds.length) return [];
    return tx
      .select({ orgId: orgAddOns.organizationId, code: addOns.code, features: addOns.features, quantity: orgAddOns.quantity })
      .from(orgAddOns)
      .innerJoin(addOns, eq(addOns.id, orgAddOns.addOnId))
      .where(and(inArray(orgAddOns.organizationId, orgIds), eq(orgAddOns.status, 'ACTIVE'), or(isNull(orgAddOns.cancelAt), gte(orgAddOns.cancelAt, at))));
  }

  private cleanOverrides(flags: unknown): Record<string, FeatureValue> {
    const out: Record<string, FeatureValue> = {};
    for (const [k, v] of Object.entries((flags as Record<string, unknown>) || {})) if (typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    return out;
  }

  /** Entitlements for many locations at once (search results, dashboards). */
  async forLocations(locationIds: string[], at = new Date(), tx: DbOrTx = this.db): Promise<Map<string, Entitlements>> {
    const out = new Map<string, Entitlements>();
    if (!locationIds.length) return out;
    const locs = await tx.select({ id: locations.id, orgId: locations.organizationId, flags: organizations.featureFlags, kind: organizations.kind }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId)).where(inArray(locations.id, locationIds));
    const rows = await tx
      .select({ locationId: contractLocations.locationId, c: merchantContracts })
      .from(contractLocations)
      .innerJoin(merchantContracts, eq(merchantContracts.id, contractLocations.contractId))
      .where(and(inArray(contractLocations.locationId, locationIds), lte(merchantContracts.effectiveFrom, at), or(isNull(merchantContracts.effectiveTo), gte(merchantContracts.effectiveTo, at))))
      .orderBy(desc(merchantContracts.version));
    const def = await this.defaultPlan();
    const extras = await this.addOnsFor([...new Set(locs.map((l) => l.orgId))], at, tx);
    for (const l of locs) {
      const contract = rows.find((r) => r.locationId === l.id)?.c;
      out.set(l.id, this.build(contract, this.cleanOverrides(l.flags), def, extras.filter((x) => x.orgId === l.orgId) as { code: string; features: Record<string, FeatureValue>; quantity: number }[], l.kind));
    }
    return out;
  }

  async forLocation(locationId: string, tx: DbOrTx = this.db) {
    const e = (await this.forLocations([locationId], new Date(), tx)).get(locationId);
    if (!e) throw new ForbiddenException('Location not found');
    return e;
  }

  /** Organization-level view (limits, org-wide features like ads): the org's current contract. */
  async forOrg(orgId: string, at = new Date(), tx: DbOrTx = this.db): Promise<Entitlements> {
    const [org] = await tx.select({ flags: organizations.featureFlags, kind: organizations.kind }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const [c] = await tx
      .select()
      .from(merchantContracts)
      .where(and(eq(merchantContracts.organizationId, orgId), lte(merchantContracts.effectiveFrom, at), or(isNull(merchantContracts.effectiveTo), gte(merchantContracts.effectiveTo, at))))
      .orderBy(desc(merchantContracts.version))
      .limit(1);
    const extras = (await this.addOnsFor([orgId], at, tx)) as { code: string; features: Record<string, FeatureValue>; quantity: number }[];
    return this.build(c, this.cleanOverrides(org?.flags), await this.defaultPlan(), extras, org?.kind);
  }

  private async deny(e: Entitlements, key: string, audience: 'merchant' | 'customer'): Promise<never> {
    const name = await this.featureName(key);
    const message =
      audience === 'customer'
        ? `${name} isn't available for this restaurant on Gutad.`
        : `${name} isn't included in your plan${e.planName ? ` (${e.planName})` : ''}. Switch plans or add it from Plan & billing in the merchant portal.`;
    throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', message, code: 'FEATURE_NOT_IN_PLAN', feature: key, plan: e.planCode });
  }

  async assertLocation(locationId: string, key: string, audience: 'merchant' | 'customer' = 'merchant', tx: DbOrTx = this.db) {
    const e = await this.forLocation(locationId, tx);
    if (!can(e, key)) await this.deny(e, key, audience);
    return e;
  }

  async assertOrg(orgId: string, key: string) {
    const e = await this.forOrg(orgId);
    if (!can(e, key)) await this.deny(e, key, 'merchant');
    return e;
  }

  /** Throws when adding one more of `key` (locations, team_members) would exceed the plan limit. */
  async assertLimit(orgId: string, key: 'locations' | 'team_members', tx: DbOrTx = this.db) {
    const e = await this.forOrg(orgId, new Date(), tx);
    const max = limitOf(e, key);
    if (max === null) return;
    const used = await this.usage(orgId, key, tx);
    if (used >= max) {
      const name = await this.featureName(key);
      const message = `Your plan${e.planName ? ` (${e.planName})` : ''} includes ${max} ${name.toLowerCase()}. Upgrade or buy an add-on from Plan & billing in the merchant portal.`;
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', message, code: 'PLAN_LIMIT_REACHED', feature: key, plan: e.planCode, limit: max, used });
    }
  }

  async usage(orgId: string, key: 'locations' | 'team_members', tx: DbOrTx = this.db) {
    if (key === 'locations') {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.organizationId, orgId), sql`${locations.status} not in ('OFFBOARDED')`));
      return r.n;
    }
    const [r] = await tx.select({ n: sql<number>`count(distinct ${orgMemberships.userId})::int` }).from(orgMemberships).where(eq(orgMemberships.organizationId, orgId));
    return r.n;
  }
}
