import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { feeAmount, resolveFee, type FeeRuleDto } from '@gutad/shared';
import { and, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { contractLocations, invoices, locations, merchantContracts, platformSubscriptions } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { loadConfig } from '../../config/config';
import { addDays, invoiceNumber } from '../../common/utils';
import { PlansService } from './plans.service';

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
  /** The fee rules the numbers above were resolved from (legacy contracts are translated on the fly). */
  fees: FeeRuleDto[];
}

type ContractRow = typeof merchantContracts.$inferSelect;

/**
 * Contracts created before the plan catalog have flat columns. Translate them into rules with exactly the old
 * meaning (network = marketplace + partner, everything else = direct) so signed terms never change.
 */
export function legacyFeeRules(c: ContractRow): FeeRuleDto[] {
  return [
    { type: 'COMMISSION', channel: 'NETWORK', fulfillment: 'ANY', bps: c.marketplaceCommissionBps, cents: 0 },
    { type: 'COMMISSION', channel: 'ANY', fulfillment: 'ANY', bps: c.directCommissionBps, cents: 0 },
    { type: 'COVER_FEE', channel: 'NETWORK', fulfillment: 'ANY', bps: 0, cents: c.coverFeeNetworkCents },
    { type: 'COVER_FEE', channel: 'ANY', fulfillment: 'ANY', bps: 0, cents: c.coverFeeDirectCents },
    { type: 'PREPAID_SERVICE_FEE', channel: 'ANY', fulfillment: 'ANY', bps: c.prepaidServiceFeeBps, cents: 0 },
    { type: 'PROCESSING', channel: 'ANY', fulfillment: 'ANY', bps: c.processingBps, cents: c.processingFixedCents },
    { type: 'DELIVERY_SUBSIDY', channel: 'ANY', fulfillment: 'ANY', bps: 0, cents: c.deliverySubsidyCents },
    { type: 'LOGISTICS_FEE', channel: 'ANY', fulfillment: 'ANY', bps: 0, cents: c.logisticsFeeCents },
  ];
}

export const contractFeeRules = (c: ContractRow): FeeRuleDto[] => ((c.fees as FeeRuleDto[] | null)?.length ? (c.fees as FeeRuleDto[]) : legacyFeeRules(c));

/** Flat columns kept on plan-based contracts for reports and older screens: the marketplace-delivery view. */
function flatColumnsFrom(rules: FeeRuleDto[]) {
  const r = (t: FeeRuleDto['type'], ch: string, ful?: string) => resolveFee(rules, t, ch, ful);
  const proc = r('PROCESSING', 'DIRECT');
  return {
    marketplaceCommissionBps: r('COMMISSION', 'MARKETPLACE', 'DELIVERY')?.bps ?? 0,
    directCommissionBps: r('COMMISSION', 'DIRECT')?.bps ?? 0,
    coverFeeNetworkCents: r('COVER_FEE', 'MARKETPLACE', 'DINE_IN')?.cents ?? 0,
    coverFeeDirectCents: r('COVER_FEE', 'DIRECT', 'DINE_IN')?.cents ?? 0,
    prepaidServiceFeeBps: r('PREPAID_SERVICE_FEE', 'MARKETPLACE')?.bps ?? 0,
    processingBps: proc?.bps ?? 295,
    processingFixedCents: proc?.cents ?? 29,
    deliverySubsidyCents: r('DELIVERY_SUBSIDY', 'MARKETPLACE', 'DELIVERY')?.cents ?? 0,
    logisticsFeeCents: r('LOGISTICS_FEE', 'MARKETPLACE', 'DELIVERY')?.cents ?? 0,
  };
}

function billingModelsFrom(subscriptionCents: number, rules: FeeRuleDto[], features: Record<string, unknown>) {
  const m = new Set<string>();
  if (subscriptionCents > 0) m.add('SUBSCRIPTION');
  if (rules.some((f) => f.type === 'COMMISSION' && (f.bps || f.cents))) m.add('COMMISSION');
  if (rules.some((f) => f.type === 'COVER_FEE' && f.cents)) m.add('PER_COVER');
  if (rules.some((f) => f.type === 'PREPAID_SERVICE_FEE' && f.bps)) m.add('PREPAID_SERVICE_FEE');
  if (features.ads) m.add('ADS');
  return [...m];
}

@Injectable()
export class ContractsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly ledger: LedgerService, private readonly plansSvc: PlansService) {}

  plans() {
    return this.plansSvc.publicPlans();
  }

  /**
   * Effective commercial terms for a location on a channel (and fulfillment type, for orders) at a point in time.
   * Each number is the most specific fee rule on the contract; missing rules fall back to platform defaults.
   */
  async termsFor(locationId: string, channel: Channel, at = new Date(), tx: DbOrTx = this.db, fulfillment?: 'DELIVERY' | 'PICKUP' | 'DINE_IN'): Promise<EffectiveTerms> {
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
        fees: [],
      };
    }
    const rules = contractFeeRules(c);
    const ful = fulfillment ?? (channel === 'WIDGET' ? 'DINE_IN' : undefined);
    const pick = (t: FeeRuleDto['type']) => resolveFee(rules, t, channel, ful);
    const commission = pick('COMMISSION');
    const processing = pick('PROCESSING');
    return {
      contractId: c.id,
      planCode: c.planCode,
      commissionBps: commission ? commission.bps : isNetwork ? cfg.DEFAULT_MARKETPLACE_COMMISSION_BPS : 0,
      processingBps: processing ? processing.bps : cfg.DEFAULT_DIRECT_PROCESSING_BPS,
      processingFixedCents: processing ? processing.cents : cfg.DEFAULT_DIRECT_PROCESSING_FIXED_CENTS,
      coverFeeCents: pick('COVER_FEE')?.cents ?? 0,
      prepaidServiceFeeBps: pick('PREPAID_SERVICE_FEE')?.bps ?? 0,
      deliverySubsidyCents: pick('DELIVERY_SUBSIDY')?.cents ?? 0,
      logisticsFeeCents: pick('LOGISTICS_FEE')?.cents ?? 0,
      cancellationRules: (c.cancellationRules as Record<string, unknown>) || {},
      features: (c.features as Record<string, unknown>) || {},
      fees: rules,
    };
  }

  /** Fee in cents for one event under a location's contract (e.g. commission on an order subtotal). */
  async feeFor(locationId: string, type: FeeRuleDto['type'], channel: Channel, baseCents: number, fulfillment?: 'DELIVERY' | 'PICKUP' | 'DINE_IN', at = new Date(), tx: DbOrTx = this.db) {
    const t = await this.termsFor(locationId, channel, at, tx, fulfillment);
    return feeAmount(resolveFee(t.fees, type, channel, fulfillment), baseCents);
  }

  async listForOrg(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const rows = await this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version));
    const links = rows.length ? await this.db.select().from(contractLocations) : [];
    return rows.map((c) => ({ ...c, fees: contractFeeRules(c), locationIds: links.filter((l) => l.contractId === c.id).map((l) => l.locationId) }));
  }

  /**
   * Commercial ops issues an Order Form: a contract version copied from the plan's published version (price, fee
   * rules, features), with optional per-merchant overrides, bound to locations.
   */
  async create(user: JwtPayload, orgId: string, input: { planCode: string; locationIds: string[]; overrides?: Partial<typeof merchantContracts.$inferInsert> & { fees?: FeeRuleDto[] }; effectiveFrom?: Date; sign?: boolean }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Commercial operations only');
    const pv = await this.plansSvc.publishedVersion(input.planCode);
    const { fees: feeOverride, features: featureOverride, ...columnOverrides } = input.overrides || {};
    const rules = feeOverride?.length ? feeOverride : pv.fees;
    const feats = { ...pv.features, ...((featureOverride as Record<string, boolean | number>) || {}) };
    const plan = {
      name: pv.plan.name,
      subscriptionCents: pv.version.subscriptionCents,
      subscriptionInterval: pv.version.interval,
      ...flatColumnsFrom(rules),
      billingModels: billingModelsFrom(pv.version.subscriptionCents, rules, feats),
      features: feats,
      planVersionId: pv.version.id,
      fees: rules,
    };
    const prev = await this.db.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version)).limit(1);
    const version = (prev[0]?.version || 0) + 1;
    return this.db.transaction(async (tx) => {
      const effectiveFrom = input.effectiveFrom || new Date();
      if (prev[0] && !prev[0].effectiveTo) await tx.update(merchantContracts).set({ effectiveTo: effectiveFrom }).where(eq(merchantContracts.id, prev[0].id));
      const [c] = await tx
        .insert(merchantContracts)
        .values({ ...plan, ...columnOverrides, organizationId: orgId, planCode: input.planCode, version, effectiveFrom, signedAt: input.sign ? new Date() : null, name: plan.name })
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
