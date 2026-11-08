import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { contractLocations, invoices, locations, merchantContracts, platformSubscriptions } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { loadConfig } from '../../config/config';
import { addDays, invoiceNumber } from '../../common/utils';

export type Channel = 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR' | 'PARTNER' | 'PHONE' | 'WALK_IN' | 'CAMPUS' | 'CORPORATE' | 'API';

export interface EffectiveTerms {
  contractId: string | null;
  planCode: string;
  commissionBps: number;
  processingBps: number;
  processingFixedCents: number;
  coverFeeCents: number;
  prepaidServiceFeeBps: number;
  deliverySubsidyCents: number;
  logisticsFeeCents: number;
  cancellationRules: Record<string, unknown>;
  features: Record<string, unknown>;
}

/** Plan catalog — published benchmarks are inputs, not launch prices. Editable via admin settings. */
export const PLAN_CATALOG: Record<string, Partial<typeof merchantContracts.$inferInsert> & { name: string }> = {
  DIRECT_FREE: { name: 'Direct (free listing)', billingModels: ['COMMISSION'], subscriptionCents: 0, marketplaceCommissionBps: 1500, directCommissionBps: 0 },
  DIRECT_PRO: { name: 'Direct Pro', billingModels: ['SUBSCRIPTION', 'COMMISSION'], subscriptionCents: 22900, marketplaceCommissionBps: 1500, directCommissionBps: 0 },
  MARKETPLACE_PLUS: { name: 'Marketplace Plus', billingModels: ['COMMISSION'], subscriptionCents: 0, marketplaceCommissionBps: 2000, directCommissionBps: 0, deliverySubsidyCents: 100 },
  RESERVATIONS_CORE: { name: 'Reservations Core', billingModels: ['SUBSCRIPTION', 'PER_COVER', 'PREPAID_SERVICE_FEE'], subscriptionCents: 14900, coverFeeNetworkCents: 150, coverFeeDirectCents: 0, prepaidServiceFeeBps: 200 },
  RESERVATIONS_PRO: { name: 'Reservations Pro', billingModels: ['SUBSCRIPTION', 'PER_COVER', 'PREPAID_SERVICE_FEE'], subscriptionCents: 29900, coverFeeNetworkCents: 100, coverFeeDirectCents: 0, prepaidServiceFeeBps: 200 },
  FULL_SUITE: { name: 'Full suite', billingModels: ['SUBSCRIPTION', 'COMMISSION', 'PER_COVER', 'PREPAID_SERVICE_FEE', 'ADS'], subscriptionCents: 49900, marketplaceCommissionBps: 1500, coverFeeNetworkCents: 100, prepaidServiceFeeBps: 200 },
};

@Injectable()
export class ContractsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly ledger: LedgerService) {}

  plans() {
    return Object.entries(PLAN_CATALOG).map(([code, p]) => ({ code, ...p }));
  }

  /** Effective commercial terms for a location on a channel at a point in time. Falls back to platform defaults. */
  async termsFor(locationId: string, channel: Channel, at = new Date(), tx: DbOrTx = this.db): Promise<EffectiveTerms> {
    const cfg = loadConfig();
    const [row] = await tx
      .select({ c: merchantContracts })
      .from(contractLocations)
      .innerJoin(merchantContracts, eq(merchantContracts.id, contractLocations.contractId))
      .where(and(eq(contractLocations.locationId, locationId), lte(merchantContracts.effectiveFrom, at), or(isNull(merchantContracts.effectiveTo), gte(merchantContracts.effectiveTo, at))))
      .orderBy(desc(merchantContracts.version))
      .limit(1);
    const c = row?.c;
    const isNetwork = channel === 'MARKETPLACE' || channel === 'PARTNER';
    if (!c) {
      return {
        contractId: null,
        planCode: 'DIRECT_FREE',
        commissionBps: isNetwork ? cfg.DEFAULT_MARKETPLACE_COMMISSION_BPS : 0,
        processingBps: cfg.DEFAULT_DIRECT_PROCESSING_BPS,
        processingFixedCents: cfg.DEFAULT_DIRECT_PROCESSING_FIXED_CENTS,
        coverFeeCents: isNetwork ? cfg.DEFAULT_COVER_FEE_CENTS : 0,
        prepaidServiceFeeBps: cfg.DEFAULT_PREPAID_EXPERIENCE_FEE_BPS,
        deliverySubsidyCents: 0,
        logisticsFeeCents: 0,
        cancellationRules: {},
        features: {},
      };
    }
    return {
      contractId: c.id,
      planCode: c.planCode,
      commissionBps: isNetwork ? c.marketplaceCommissionBps : c.directCommissionBps,
      processingBps: c.processingBps,
      processingFixedCents: c.processingFixedCents,
      coverFeeCents: isNetwork ? c.coverFeeNetworkCents : c.coverFeeDirectCents,
      prepaidServiceFeeBps: c.prepaidServiceFeeBps,
      deliverySubsidyCents: c.deliverySubsidyCents,
      logisticsFeeCents: c.logisticsFeeCents,
      cancellationRules: (c.cancellationRules as Record<string, unknown>) || {},
      features: (c.features as Record<string, unknown>) || {},
    };
  }

  async listForOrg(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const rows = await this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version));
    const links = rows.length ? await this.db.select().from(contractLocations) : [];
    return rows.map((c) => ({ ...c, locationIds: links.filter((l) => l.contractId === c.id).map((l) => l.locationId) }));
  }

  /** Commercial ops creates a versioned agreement from a plan code with overrides, bound to locations. */
  async create(user: JwtPayload, orgId: string, input: { planCode: string; locationIds: string[]; overrides?: Partial<typeof merchantContracts.$inferInsert>; effectiveFrom?: Date; sign?: boolean }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Commercial operations only');
    const plan = PLAN_CATALOG[input.planCode];
    if (!plan) throw new NotFoundException('Unknown plan');
    const prev = await this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version)).limit(1);
    const version = (prev[0]?.version || 0) + 1;
    return this.db.transaction(async (tx) => {
      const effectiveFrom = input.effectiveFrom || new Date();
      if (prev[0] && !prev[0].effectiveTo) await tx.update(merchantContracts).set({ effectiveTo: effectiveFrom }).where(eq(merchantContracts.id, prev[0].id));
      const [c] = await tx
        .insert(merchantContracts)
        .values({ ...plan, ...(input.overrides || {}), organizationId: orgId, planCode: input.planCode, version, effectiveFrom, signedAt: input.sign ? new Date() : null, name: plan.name })
        .returning();
      const locs = await tx.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
      const ids = input.locationIds.length ? input.locationIds.filter((id) => locs.some((l) => l.id === id)) : locs.map((l) => l.id);
      if (ids.length) await tx.insert(contractLocations).values(ids.map((locationId) => ({ contractId: c.id, locationId, entitlements: plan.features || {} })));
      if ((c.billingModels as string[]).includes('SUBSCRIPTION') && c.subscriptionCents > 0) {
        await tx.insert(platformSubscriptions).values({ organizationId: orgId, contractId: c.id, currentPeriodStart: effectiveFrom, currentPeriodEnd: addDays(effectiveFrom, c.subscriptionInterval === 'YEAR' ? 365 : 30), locationCount: ids.length || 1 });
      }
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'contract.create', entityType: 'contract', entityId: c.id, after: c }, tx);
      return c;
    });
  }

  /** Bills subscriptions whose period ended; invoices are independent of food payouts. Called by the worker daily. */
  async billDueSubscriptions(now = new Date()) {
    const due = await this.db.select().from(platformSubscriptions).where(and(eq(platformSubscriptions.status, 'ACTIVE'), lte(platformSubscriptions.currentPeriodEnd, now)));
    const out: string[] = [];
    for (const s of due) {
      const [c] = await this.db.select().from(merchantContracts).where(eq(merchantContracts.id, s.contractId)).limit(1);
      if (!c) continue;
      const total = c.subscriptionCents * Math.max(1, s.locationCount);
      await this.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            organizationId: s.organizationId,
            number: invoiceNumber('SUB'),
            kind: 'SUBSCRIPTION',
            currency: loadConfig().DEFAULT_CURRENCY,
            lines: [{ description: `${c.name} × ${s.locationCount} location(s)`, cents: total, periodStart: s.currentPeriodStart, periodEnd: s.currentPeriodEnd }],
            totalCents: total,
            dueAt: addDays(now, 14),
          })
          .returning();
        await this.ledger.post({ invoiceId: inv.id, currency: inv.currency }, [
          { account: 'CUSTOMER_RECEIVABLE', partyId: s.organizationId, organizationId: s.organizationId, debitCents: total, memo: 'Subscription invoice' },
          { account: 'PLATFORM_REVENUE_SUBSCRIPTION', creditCents: total, organizationId: s.organizationId },
        ], tx);
        const nextEnd = addDays(s.currentPeriodEnd, c.subscriptionInterval === 'YEAR' ? 365 : 30);
        await tx.update(platformSubscriptions).set({ currentPeriodStart: s.currentPeriodEnd, currentPeriodEnd: nextEnd, lastInvoiceId: inv.id }).where(eq(platformSubscriptions.id, s.id));
        out.push(inv.id);
      });
    }
    return out;
  }
}
