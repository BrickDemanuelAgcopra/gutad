import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DEFAULT_CUSTOMER_FEES, TAX_CATEGORIES, type CustomerFeeRules } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { brands, coupons, locations, membershipPlans, organizations, planFees, plans, planVersions, priceChanges, taxRates } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { assertCan, assertOrgAccess, JwtPayload } from '../../common/auth';
import { AdminService } from '../admin/admin.service';
import { QuoteService, type QuoteSimulation } from '../orders/quote.service';

/** 9 — customer fee rules, item tax categories & rates, membership benefits, commission/royalty overview, price simulation. */
@Injectable()
export class PricingService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly admin: AdminService, private readonly quotes: QuoteService) {}

  async fees(user: JwtPayload) {
    assertCan(user, 'finance.read', 'catalog.read');
    return { rules: await this.settings.getObject<CustomerFeeRules>('fees.customer', DEFAULT_CUSTOMER_FEES), defaults: DEFAULT_CUSTOMER_FEES, note: 'Changing fee rules needs a second person (Approvals).' };
  }

  /** Fee rule changes go through the approval engine (`fees.*` is a sensitive setting). */
  async requestFees(user: JwtPayload, rules: CustomerFeeRules, reason: string) {
    assertCan(user, 'settings.manage', 'finance.manage');
    return this.admin.setSetting(user, 'fees.customer', rules, reason);
  }

  // ───── tax ─────

  async taxRates(user: JwtPayload, locationId?: string) {
    if (locationId) {
      const [l] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
      if (!l) throw new NotFoundException();
      assertOrgAccess(user, l.organizationId, l.id);
      const rows = await this.db.select().from(taxRates).where(or(eq(taxRates.locationId, locationId), and(isNull(taxRates.locationId), or(eq(taxRates.region, l.region), isNull(taxRates.region)))));
      return { locationRateBps: l.taxRateBps, region: l.region, categories: TAX_CATEGORIES, rates: rows, effective: TAX_CATEGORIES.map((c) => { const r = rows.find((x) => x.category === c.key && x.locationId === l.id) || rows.find((x) => x.category === c.key && !x.locationId && x.region === l.region) || rows.find((x) => x.category === c.key && !x.locationId && !x.region); return { category: c.key, label: c.label, rateBps: c.key === 'EXEMPT' ? 0 : r ? r.rateBps : l.taxRateBps, source: c.key === 'EXEMPT' ? 'exempt' : r ? (r.locationId ? 'location' : r.region ? `region ${r.region}` : 'platform') : 'location default' }; }) };
    }
    assertCan(user, 'finance.read', 'catalog.read');
    return { categories: TAX_CATEGORIES, rates: await this.db.select().from(taxRates).orderBy(taxRates.category, taxRates.region) };
  }

  async upsertTaxRate(user: JwtPayload, input: { id?: string; locationId?: string | null; region?: string | null; category: string; rateBps: number; label?: string }) {
    assertCan(user, 'finance.manage');
    if (!TAX_CATEGORIES.some((c) => c.key === input.category)) throw new BadRequestException('Unknown tax category');
    const v = { locationId: input.locationId ?? null, region: input.region ? input.region.toUpperCase() : null, category: input.category, rateBps: input.rateBps, label: input.label ?? null };
    const [row] = input.id ? await this.db.update(taxRates).set(v).where(eq(taxRates.id, input.id)).returning() : await this.db.insert(taxRates).values(v).returning();
    await this.audit.log({ actorId: user.sub, action: 'tax.rate', entityType: 'tax_rate', entityId: row.id, after: row });
    return row;
  }

  async deleteTaxRate(user: JwtPayload, id: string) {
    assertCan(user, 'finance.manage');
    const [row] = await this.db.delete(taxRates).where(eq(taxRates.id, id)).returning();
    if (!row) throw new NotFoundException();
    await this.audit.log({ actorId: user.sub, action: 'tax.rate_delete', entityType: 'tax_rate', entityId: id, before: row });
    return { ok: true };
  }

  // ───── 9.3 membership benefits ─────

  async membershipPlans(user: JwtPayload) {
    assertCan(user, 'growth.read', 'finance.read');
    return this.db.select().from(membershipPlans).orderBy(membershipPlans.priceCents);
  }

  async updateMembershipPlan(user: JwtPayload, id: string, input: { name?: string; priceCents?: number; isActive?: boolean; benefits?: Record<string, unknown> }) {
    assertCan(user, 'growth.manage');
    const [before] = await this.db.select().from(membershipPlans).where(eq(membershipPlans.id, id)).limit(1);
    if (!before) throw new NotFoundException();
    const [row] = await this.db.update(membershipPlans).set({ ...input, ...(input.benefits ? { benefits: { ...(before.benefits as object), ...input.benefits } } : {}) }).where(eq(membershipPlans.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'membership.plan', entityType: 'membership_plan', entityId: id, before, after: row });
    return row;
  }

  // ───── 9.4 commission & royalty schedules together ─────

  async overview(user: JwtPayload) {
    assertCan(user, 'finance.read', 'catalog.read');
    const fees = await this.db.select({ plan: plans.name, code: plans.code, productLine: plans.productLine, version: planVersions.version, f: planFees }).from(planFees).innerJoin(planVersions, eq(planVersions.id, planFees.planVersionId)).innerJoin(plans, eq(plans.id, planVersions.planId)).where(eq(planVersions.status, 'PUBLISHED')).orderBy(plans.sortOrder);
    const royalties = await this.db.select({ id: brands.id, name: brands.name, org: organizations.name, ownershipType: brands.ownershipType, royaltyBps: brands.royaltyBps, royaltyRules: brands.royaltyRules }).from(brands).innerJoin(organizations, eq(organizations.id, brands.organizationId)).orderBy(brands.name);
    const promos = await this.db.select({ code: coupons.code, funder: coupons.funder, platformSharePct: coupons.platformSharePct, kind: coupons.kind, value: coupons.value, uses: coupons.uses }).from(coupons).orderBy(coupons.code).limit(50);
    const scheduled = await this.db.select().from(priceChanges).where(inArray(priceChanges.status, ['SCHEDULED', 'PENDING_APPROVAL'])).orderBy(priceChanges.effectiveAt).limit(100);
    return { commission: fees.map((x) => ({ plan: x.plan, code: x.code, productLine: x.productLine, version: x.version, type: x.f.type, channel: x.f.channel, fulfillment: x.f.fulfillment, bps: x.f.bps, cents: x.f.cents, capCents: x.f.capCents })), royalties, promotions: promos, customerFees: await this.settings.getObject<CustomerFeeRules>('fees.customer', DEFAULT_CUSTOMER_FEES), scheduledPriceChanges: scheduled };
  }

  // ───── 9.8 checkout-price simulation ─────

  async simulate(user: JwtPayload, cart: Parameters<QuoteService['quote']>[0], draft: QuoteSimulation) {
    const [l] = await this.db.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.id, cart.locationId)).limit(1);
    if (!l) throw new NotFoundException('Location not found');
    assertOrgAccess(user, l.organizationId, cart.locationId);
    const current = await this.quotes.simulate({ ...cart, userId: null }, {});
    const proposed = await this.quotes.simulate({ ...cart, userId: null }, draft);
    const keys = ['subtotalCents', 'discountCents', 'taxCents', 'serviceFeeCents', 'smallOrderFeeCents', 'packagingFeeCents', 'deliveryFeeCents', 'totalCents', 'commissionCents'] as const;
    return { current, proposed, delta: Object.fromEntries(keys.map((k) => [k, proposed[k] - current[k]])) };
  }
}

