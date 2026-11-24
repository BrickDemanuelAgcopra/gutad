import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { DEFAULT_FIRST_PARTY_POLICY, describeFirstPartyRules, FIRST_PARTY_ORG_KIND, FIRST_PARTY_RANKING_MODES, firstPartyRulesFor, type FirstPartyPolicy, type FirstPartyRules } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { brands, journalEntries, kitchens, legalSellers, locations, marketplacePolicyVersions, orders, orgMemberships, organizations, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { AclService } from '../../core/acl.service';
import { FirstPartyService } from '../../core/first-party.service';
import { assertCan, can, JwtPayload, MERCHANT_ROLES, RoleName } from '../../common/auth';
import { MerchantsService } from '../merchants/merchants.service';
import { DiscoveryService } from '../discovery/discovery.service';

export interface FpLocationInput {
  name: string;
  description?: string;
  cuisine?: string[];
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  lat?: number;
  lng?: number;
  phone?: string;
  kitchenId?: string;
  foodHall?: boolean;
  acceptsPickup?: boolean;
  acceptsDelivery?: boolean;
  heroImageUrl?: string;
}

/** Admin side of Gutad first-party selling: setup, locations and brands, policy, kill switch, preview, report, operators. */
@Injectable()
export class FirstPartyAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fp: FirstPartyService,
    private readonly audit: AuditService,
    private readonly acl: AclService,
    private readonly merchants: MerchantsService,
    private readonly discovery: DiscoveryService,
  ) {}

  private async org() {
    const [o] = await this.db.select().from(organizations).where(eq(organizations.kind, FIRST_PARTY_ORG_KIND)).orderBy(organizations.createdAt).limit(1);
    return o || null;
  }

  private async requireOrg() {
    const o = await this.org();
    if (!o) throw new BadRequestException({ message: 'Set up the Gutad first-party organization first', code: 'FIRST_PARTY_NOT_SET_UP' });
    return o;
  }

  async overview(user: JwtPayload) {
    assertCan(user, 'merchants.read');
    const org = await this.org();
    const policy = await this.fp.policy();
    if (!org) return { org: null, sellers: [], locations: [], brands: [], kitchens: await this.kitchenChoices(null), memberCount: 0, policyVersion: policy.version };
    const [sellers, locs, brandRows, members] = await Promise.all([
      this.db.select({ id: legalSellers.id, legalName: legalSellers.legalName, taxId: legalSellers.taxId }).from(legalSellers).where(eq(legalSellers.organizationId, org.id)),
      this.db.select({ id: locations.id, name: locations.name, slug: locations.slug, city: locations.city, region: locations.region, status: locations.status, verifiedAt: locations.verifiedAt, readinessApprovedAt: locations.readinessApprovedAt, platformOperated: locations.platformOperated, kitchenId: locations.kitchenId, isPaused: locations.isPaused, acceptsPickup: locations.acceptsPickup, acceptsDelivery: locations.acceptsDelivery }).from(locations).where(eq(locations.organizationId, org.id)).orderBy(locations.createdAt),
      this.db.select({ id: brands.id, name: brands.name, slug: brands.slug, description: brands.description, ownershipType: brands.ownershipType, rightsStatus: brands.rightsStatus }).from(brands).where(eq(brands.organizationId, org.id)).orderBy(brands.createdAt),
      this.db.select({ n: sql<number>`count(distinct ${orgMemberships.userId})::int` }).from(orgMemberships).where(eq(orgMemberships.organizationId, org.id)),
    ]);
    return { org: { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt }, sellers, locations: locs, brands: brandRows, kitchens: await this.kitchenChoices(org.id), memberCount: members[0]?.n ?? 0, policyVersion: policy.version };
  }

  /** Kitchens a Gutad location can be produced in: Gutad's own and shared kitchens. */
  private async kitchenChoices(orgId: string | null) {
    const rows = await this.db.select({ id: kitchens.id, name: kitchens.name, city: kitchens.city, organizationId: kitchens.organizationId, isShared: kitchens.isShared }).from(kitchens).where(orgId ? or(eq(kitchens.organizationId, orgId), eq(kitchens.isShared, true)) : eq(kitchens.isShared, true)).limit(200);
    return rows.map((k) => ({ ...k, own: k.organizationId === orgId }));
  }

  /** Creates Gutad's own organization (kind PLATFORM) and its legal seller. Safe to call twice. */
  async setup(user: JwtPayload, input: { name?: string; legalName?: string; taxId?: string }) {
    assertCan(user, 'merchants.manage');
    const existing = await this.org();
    if (existing) return existing;
    const org = await this.db.transaction(async (tx) => {
      const [o] = await tx.insert(organizations).values({ name: input.name || 'Gutad', slug: `gutad-first-party-${Date.now().toString(36)}`, kind: FIRST_PARTY_ORG_KIND, status: 'LIVE', billingEmail: null, taxId: input.taxId ?? null }).returning();
      await tx.insert(legalSellers).values({ organizationId: o.id, legalName: input.legalName || input.name || 'Gutad', taxId: input.taxId ?? null, payoutProvider: 'none', payoutOnboardingState: 'NOT_REQUIRED' });
      await this.audit.log({ organizationId: o.id, actorId: user.sub, action: 'first_party.setup', entityType: 'organization', entityId: o.id, after: o }, tx);
      return o;
    });
    await this.fp.clearOrgCache();
    return org;
  }

  async createKitchen(user: JwtPayload, input: { name: string; addressLine1: string; city: string; region: string; postalCode: string; lat?: number; lng?: number }) {
    assertCan(user, 'merchants.manage');
    const org = await this.requireOrg();
    const [k] = await this.db.insert(kitchens).values({ ...input, organizationId: org.id, isShared: false }).returning();
    await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'first_party.kitchen.create', entityType: 'kitchen', entityId: k.id, after: k });
    return k;
  }

  async createLocation(user: JwtPayload, input: FpLocationInput) {
    assertCan(user, 'merchants.manage');
    const org = await this.requireOrg();
    const [seller] = await this.db.select({ id: legalSellers.id }).from(legalSellers).where(eq(legalSellers.organizationId, org.id)).limit(1);
    const { foodHall, ...rest } = input;
    const loc = await this.merchants.createLocation(user, org.id, { ...rest, legalSellerId: seller?.id, platformOperated: !!foodHall, deliveryFleet: 'PLATFORM', acceptsPickup: input.acceptsPickup ?? true, acceptsDelivery: input.acceptsDelivery ?? true });
    await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'first_party.location.create', entityType: 'location', entityId: loc.id, after: { name: loc.name, foodHall: !!foodHall } });
    return loc;
  }

  async createBrand(user: JwtPayload, input: { name: string; description?: string; logoUrl?: string }) {
    assertCan(user, 'merchants.manage');
    const org = await this.requireOrg();
    const [seller] = await this.db.select({ id: legalSellers.id }).from(legalSellers).where(eq(legalSellers.organizationId, org.id)).limit(1);
    const b = await this.merchants.upsertBrand(user, org.id, { ...input, legalSellerId: seller?.id, royaltyBps: 0 });
    const [row] = await this.db.update(brands).set({ ownershipType: 'COMPANY_OWNED', ownerName: org.name }).where(eq(brands.id, b.id)).returning();
    return row;
  }

  // ───── marketplace policy ─────

  async policy(user: JwtPayload) {
    assertCan(user, 'merchants.read');
    const current = await this.fp.policy();
    const versions = await this.db.select({ id: marketplacePolicyVersions.id, version: marketplacePolicyVersions.version, note: marketplacePolicyVersions.note, createdAt: marketplacePolicyVersions.createdAt, policy: marketplacePolicyVersions.policy, by: users.email }).from(marketplacePolicyVersions).leftJoin(users, eq(users.id, marketplacePolicyVersions.createdById)).orderBy(desc(marketplacePolicyVersions.version)).limit(25);
    return { current, defaults: DEFAULT_FIRST_PARTY_POLICY, versions, summary: describeFirstPartyRules(firstPartyRulesFor(current)) };
  }

  private clean(p: Partial<FirstPartyPolicy>): FirstPartyPolicy {
    const base = { ...DEFAULT_FIRST_PARTY_POLICY, ...p };
    const rules = (r: Partial<FirstPartyRules>, partial: boolean): Partial<FirstPartyRules> => {
      const out: Partial<FirstPartyRules> = {};
      if (r.enabled !== undefined) out.enabled = !!r.enabled;
      if (r.ranking !== undefined) {
        if (!FIRST_PARTY_RANKING_MODES.includes(r.ranking)) throw new BadRequestException(`Unknown ranking mode ${r.ranking}`);
        out.ranking = r.ranking;
      }
      if (r.boostPositions !== undefined) out.boostPositions = Math.max(0, Math.min(50, Math.round(Number(r.boostPositions) || 0)));
      if (r.pinSlots !== undefined) out.pinSlots = [...new Set((r.pinSlots || []).map((n) => Math.round(Number(n))).filter((n) => n >= 1 && n <= 50))].sort((a, b) => a - b);
      if (r.maxFirstPageSharePct !== undefined) out.maxFirstPageSharePct = Math.max(0, Math.min(100, Math.round(Number(r.maxFirstPageSharePct) || 0)));
      if (r.allowSponsored !== undefined) out.allowSponsored = !!r.allowSponsored;
      if (r.label !== undefined) {
        const l = String(r.label).trim();
        if (!partial && l.length < 3) throw new BadRequestException('The customer label must be at least 3 characters');
        if (l.length > 40) throw new BadRequestException('The customer label must be at most 40 characters');
        if (l) out.label = l;
      }
      if (r.shadowCommissionBps !== undefined) out.shadowCommissionBps = Math.max(0, Math.min(5000, Math.round(Number(r.shadowCommissionBps) || 0)));
      return out;
    };
    const global = rules(base, false) as FirstPartyRules;
    const cities: Record<string, Partial<FirstPartyRules>> = {};
    for (const [city, over] of Object.entries(base.cities || {})) {
      const key = city.trim().toLowerCase();
      if (!key) continue;
      const r = rules(over || {}, true);
      if (Object.keys(r).length) cities[key] = r;
    }
    return { ...DEFAULT_FIRST_PARTY_POLICY, ...global, cities };
  }

  private async saveVersion(user: JwtPayload, policy: FirstPartyPolicy, note: string, action: string) {
    const before = await this.fp.policy();
    const row = await this.db.transaction(async (tx) => {
      const [m] = await tx.select({ v: sql<number>`coalesce(max(${marketplacePolicyVersions.version}), 0)::int` }).from(marketplacePolicyVersions);
      const [r] = await tx.insert(marketplacePolicyVersions).values({ version: (m?.v ?? 0) + 1, policy, note, createdById: user.sub }).returning();
      await this.audit.log({ actorId: user.sub, action, entityType: 'marketplace_policy', entityId: r.id, before, after: { version: r.version, policy, note } }, tx);
      return r;
    });
    await this.fp.clearPolicyCache();
    return { version: row.version, policy };
  }

  async savePolicy(user: JwtPayload, input: Partial<FirstPartyPolicy>, note: string) {
    assertCan(user, 'settings.manage');
    return this.saveVersion(user, this.clean(input), note, 'first_party.policy.update');
  }

  /** Instant on/off for all of Gutad's own food, or for one city. */
  async killSwitch(user: JwtPayload, input: { enabled: boolean; city?: string | null; reason: string }) {
    if (!can(user, 'ops.manage') && !can(user, 'settings.manage')) assertCan(user, 'ops.manage', 'settings.manage');
    const cur = await this.fp.policy();
    const { version: _v, ...p } = cur;
    const city = input.city?.trim().toLowerCase();
    const next: FirstPartyPolicy = city ? { ...p, cities: { ...p.cities, [city]: { ...(p.cities[city] || {}), enabled: input.enabled } } } : { ...p, enabled: input.enabled };
    return this.saveVersion(user, this.clean(next), `${input.enabled ? 'Turned on' : 'Turned off'}${city ? ` in ${city}` : ' everywhere'}: ${input.reason}`, input.enabled ? 'first_party.kill_switch.on' : 'first_party.kill_switch.off');
  }

  async rollback(user: JwtPayload, version: number, reason: string) {
    assertCan(user, 'settings.manage');
    const [row] = await this.db.select().from(marketplacePolicyVersions).where(eq(marketplacePolicyVersions.version, version)).limit(1);
    if (!row) throw new NotFoundException('Policy version not found');
    return this.saveVersion(user, this.clean(row.policy as FirstPartyPolicy), `Restored version ${version}: ${reason}`, 'first_party.policy.rollback');
  }

  /** What customers would see for a search: with the draft (or current) policy, next to neutral ranking. */
  async preview(user: JwtPayload, input: { city?: string; q?: string; service?: 'pickup' | 'delivery'; policy?: Partial<FirstPartyPolicy> }) {
    assertCan(user, 'merchants.read');
    const base = input.policy ? this.clean({ ...(await this.fp.policy()), ...input.policy }) : await this.fp.policy();
    const rules = firstPartyRulesFor(base, input.city);
    const params = { city: input.city || undefined, q: input.q || undefined, service: input.service, pageSize: 20 };
    const neutral = await this.discovery.search(params, { rules: { ...rules, enabled: true, ranking: 'NEUTRAL', maxFirstPageSharePct: 100 }, explain: true });
    const withPolicy = await this.discovery.search(params, { rules, explain: true });
    const brief = (r: { items: unknown[] }) => (r.items as { id: string; name: string; city: string; firstParty?: boolean; sponsored?: boolean; isOpenNow: boolean; rating: number | null; why?: string[] }[]).map((i, k) => ({ position: k + 1, id: i.id, name: i.name, city: i.city, firstParty: !!i.firstParty, sponsored: !!i.sponsored, isOpenNow: i.isOpenNow, rating: i.rating, why: i.why || [] }));
    return { rules, summary: describeFirstPartyRules(rules), neutral: brief(neutral), withPolicy: brief(withPolicy), total: withPolicy.total };
  }

  // ───── report ─────

  async report(user: JwtPayload, fromIso?: string, toIso?: string) {
    if (!can(user, 'finance.read') && !can(user, 'overview.read')) assertCan(user, 'finance.read', 'overview.read');
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 86400000);
    if (!(from < to)) throw new BadRequestException('from must be before to');
    const fpOrgs = await this.fp.platformOrgIds();
    const policy = await this.fp.policy();
    const live = and(gte(orders.createdAt, from), lt(orders.createdAt, to), notInArray(orders.status, ['REJECTED', 'CANCELED']));
    const isFp = fpOrgs.length ? inArray(orders.organizationId, fpOrgs) : sql`false`;
    const agg = (where: ReturnType<typeof and>) => this.db.select({ n: sql<number>`count(*)::int`, gmv: sql<number>`coalesce(sum(${orders.subtotalCents} - ${orders.discountCents}),0)::int`, commission: sql<number>`coalesce(sum(${orders.commissionCents}),0)::int` }).from(orders).where(where);
    const [[fpAgg], [mAgg]] = await Promise.all([agg(and(live, isFp)), agg(and(live, sql`not (${isFp})`))]);
    const ledger = async (account: 'PLATFORM_REVENUE_FOOD_SALES' | 'PLATFORM_EXPENSE_COGS' | 'PLATFORM_REVENUE_COMMISSION', onlyFp: boolean) => {
      const conds = [eq(journalEntries.account, account), gte(journalEntries.createdAt, from), lt(journalEntries.createdAt, to)];
      if (onlyFp) conds.push(fpOrgs.length ? inArray(journalEntries.organizationId, fpOrgs) : sql`false`);
      const [r] = await this.db.select({ c: sql<number>`coalesce(sum(${journalEntries.creditCents} - ${journalEntries.debitCents}),0)::int` }).from(journalEntries).where(and(...conds));
      return r?.c ?? 0;
    };
    const [fpSales, fpCogsNeg, commissionEarned] = await Promise.all([ledger('PLATFORM_REVENUE_FOOD_SALES', true), ledger('PLATFORM_EXPENSE_COGS', true), ledger('PLATFORM_REVENUE_COMMISSION', false)]);
    const fpCogs = -fpCogsNeg;
    const byLocation = fpOrgs.length
      ? await this.db.select({ locationId: orders.locationId, name: locations.name, city: locations.city, n: sql<number>`count(*)::int`, gmv: sql<number>`coalesce(sum(${orders.subtotalCents} - ${orders.discountCents}),0)::int` }).from(orders).innerJoin(locations, eq(locations.id, orders.locationId)).where(and(live, isFp)).groupBy(orders.locationId, locations.name, locations.city).orderBy(desc(sql`2`))
      : [];
    const totalGmv = fpAgg.gmv + mAgg.gmv;
    return {
      from, to,
      firstParty: { orders: fpAgg.n, gmvCents: fpAgg.gmv, foodSalesCents: fpSales, cogsCents: fpCogs, grossMarginCents: fpSales - fpCogs, grossMarginPct: fpSales ? Math.round(((fpSales - fpCogs) / fpSales) * 1000) / 10 : null, shadowCommissionCents: Math.round((fpAgg.gmv * policy.shadowCommissionBps) / 10000), shadowCommissionBps: policy.shadowCommissionBps },
      merchants: { orders: mAgg.n, gmvCents: mAgg.gmv, commissionCents: commissionEarned },
      firstPartySharePct: totalGmv ? Math.round((fpAgg.gmv / totalGmv) * 1000) / 10 : 0,
      byLocation,
    };
  }

  // ───── operators (data separation) ─────

  /**
   * People who run Gutad's own kitchens are members of the first-party organization only, so they see its data and
   * nothing about other merchants. A member who also holds cross-tenant staff access is flagged as a conflict.
   */
  async operators(user: JwtPayload) {
    assertCan(user, 'merchants.read');
    const org = await this.org();
    if (!org) return { members: [], conflicts: 0 };
    const rows = await this.db.select({ id: orgMemberships.id, userId: users.id, email: users.email, name: users.name, role: orgMemberships.role, locationIds: orgMemberships.locationIds, acceptedAt: orgMemberships.acceptedAt }).from(orgMemberships).innerJoin(users, eq(users.id, orgMemberships.userId)).where(eq(orgMemberships.organizationId, org.id));
    const members = await Promise.all(rows.map(async (m) => {
      const a = await this.acl.get(m.userId).catch(() => null);
      return { ...m, crossTenantStaff: !!a?.crossTenant, staffRoles: a?.staffRoles || [] };
    }));
    return { members, conflicts: members.filter((m) => m.crossTenantStaff).length };
  }

  async addOperator(user: JwtPayload, input: { email: string; role: RoleName; locationIds?: string[] }) {
    assertCan(user, 'merchants.manage');
    if (!MERCHANT_ROLES.includes(input.role)) throw new ForbiddenException('Operators get a merchant role in the Gutad organization, never a platform role');
    const org = await this.requireOrg();
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
    if (u) {
      const a = await this.acl.get(u.id).catch(() => null);
      if (a?.crossTenant) throw new ConflictException({ message: 'This person has platform-wide staff access. Remove it (Users, roles & permissions) before adding them as a first-party operator, so Gutad’s kitchen team never sees other merchants’ data.', code: 'FIRST_PARTY_CONFLICT' });
    }
    return this.merchants.inviteMember(user, org.id, input);
  }

  async removeOperator(user: JwtPayload, membershipId: string) {
    assertCan(user, 'merchants.manage');
    const org = await this.requireOrg();
    return this.merchants.removeMember(user, org.id, membershipId);
  }

  /** Public: the rules customers and merchants can read (/marketplace-policy). */
  async publicPolicy() {
    const p = await this.fp.policy();
    const global = firstPartyRulesFor(p);
    const cities = Object.keys(p.cities || {}).map((c) => ({ city: c, summary: describeFirstPartyRules(firstPartyRulesFor(p, c)) })).filter((c) => JSON.stringify(c.summary) !== JSON.stringify(describeFirstPartyRules(global)));
    return { version: p.version, label: global.label, summary: describeFirstPartyRules(global), cities };
  }
}
