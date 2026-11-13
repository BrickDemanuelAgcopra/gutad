import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { feeAmount, resolveFee, type FeeRuleDto } from '@gutad/shared';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { addOns, contractLocations, invoices, locations, merchantAgreementAcceptances, merchantContracts, orgAddOns, planVersions, platformSubscriptions } from '../../db/schema';
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
  async create(user: JwtPayload, orgId: string, input: IssueInput) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Commercial operations only');
    return this.issue(orgId, input, user.sub);
  }

  /**
   * Issue a contract version (staff Order Forms, merchant self-serve plan changes, version migrations).
   * - Open contracts end when this one starts; contracts scheduled after this one's start are superseded.
   * - Starting now: the subscription switches immediately (old plan billed for days used).
   * - Starting later: renewal picks it up (see renewSubscriptions).
   */
  async issue(orgId: string, input: IssueInput, actorId: string | null, txIn?: DbOrTx) {
    const pv = input.planVersionId ? await this.plansSvc.versionById(input.planVersionId) : await this.plansSvc.publishedVersion(input.planCode);
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
    const run = async (tx: DbOrTx) => {
      const now = new Date();
      const effectiveFrom = input.effectiveFrom && input.effectiveFrom > now ? input.effectiveFrom : now;
      const all = await tx.select().from(merchantContracts).where(eq(merchantContracts.organizationId, orgId)).orderBy(desc(merchantContracts.version));
      // supersede anything scheduled to start at/after this one
      const superseded = all.filter((c) => c.effectiveFrom >= effectiveFrom && c.effectiveFrom > now);
      if (superseded.length) {
        const ids = superseded.map((c) => c.id);
        await tx.update(merchantAgreementAcceptances).set({ contractId: null }).where(inArray(merchantAgreementAcceptances.contractId, ids));
        await tx.delete(merchantContracts).where(inArray(merchantContracts.id, ids));
      }
      for (const c of all) {
        if (superseded.some((x) => x.id === c.id)) continue;
        if (!c.effectiveTo || c.effectiveTo > effectiveFrom) await tx.update(merchantContracts).set({ effectiveTo: effectiveFrom }).where(eq(merchantContracts.id, c.id));
      }
      const version = (all[0]?.version || 0) + 1;
      const [c] = await tx
        .insert(merchantContracts)
        .values({ ...plan, ...columnOverrides, organizationId: orgId, planCode: pv.plan.code, version, effectiveFrom, signedAt: input.sign ? now : null, name: plan.name })
        .returning();
      const locs = await tx.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
      const ids = input.locationIds?.length ? input.locationIds.filter((id) => locs.some((l) => l.id === id)) : locs.map((l) => l.id);
      if (ids.length) await tx.insert(contractLocations).values(ids.map((locationId) => ({ contractId: c.id, locationId, entitlements: plan.features || {} })));
      if (effectiveFrom <= now) await this.switchSubscription(orgId, c, pv.version, now, tx);
      await this.audit.log({ organizationId: orgId, actorId, action: 'contract.create', entityType: 'contract', entityId: c.id, after: { ...c, fees: undefined } }, tx);
      return c;
    };
    return txIn ? run(txIn) : this.db.transaction(run);
  }

  // ───── subscriptions ─────

  async openSubscription(orgId: string, tx: DbOrTx = this.db) {
    const [s] = await tx.select().from(platformSubscriptions).where(and(eq(platformSubscriptions.organizationId, orgId), sql`${platformSubscriptions.status} <> 'CANCELED'`)).orderBy(desc(platformSubscriptions.currentPeriodStart)).limit(1);
    return s ?? null;
  }

  async activeAddOns(orgId: string, at = new Date(), tx: DbOrTx = this.db) {
    return tx
      .select({ id: orgAddOns.id, addOnId: addOns.id, code: addOns.code, name: addOns.name, priceCents: orgAddOns.priceCents, quantity: orgAddOns.quantity, perLocation: addOns.perLocation, interval: addOns.interval, features: addOns.features, startedAt: orgAddOns.startedAt, cancelAt: orgAddOns.cancelAt })
      .from(orgAddOns)
      .innerJoin(addOns, eq(addOns.id, orgAddOns.addOnId))
      .where(and(eq(orgAddOns.organizationId, orgId), eq(orgAddOns.status, 'ACTIVE'), or(isNull(orgAddOns.cancelAt), gte(orgAddOns.cancelAt, at))));
  }

  private intervalDays(interval: string) {
    return interval === 'YEAR' ? 365 : 30;
  }

  /** Recurring charge lines for a period: plan subscription (per location when the version says so) + add-ons. */
  async periodLines(orgId: string, contract: typeof merchantContracts.$inferSelect, locationCount: number, start: Date, end: Date, fraction = 1, tx: DbOrTx = this.db) {
    const lines: { description: string; cents: number; periodStart: Date; periodEnd: Date }[] = [];
    let perLocation = true;
    if (contract.planVersionId) {
      const [v] = await tx.select({ perLocation: planVersions.perLocation }).from(planVersions).where(eq(planVersions.id, contract.planVersionId)).limit(1);
      perLocation = v?.perLocation ?? true;
    }
    const units = perLocation ? Math.max(1, locationCount) : 1;
    if (contract.subscriptionCents > 0) lines.push({ description: `${contract.name}${units > 1 ? ` × ${units} locations` : ''}${fraction < 1 ? ' (prorated)' : ''}`, cents: Math.round(contract.subscriptionCents * units * fraction), periodStart: start, periodEnd: end });
    for (const a of await this.activeAddOns(orgId, start, tx)) {
      const n = (a.perLocation ? Math.max(1, locationCount) : 1) * a.quantity;
      const monthly = a.interval === 'YEAR' ? a.priceCents / 12 : a.priceCents;
      if (a.priceCents > 0) lines.push({ description: `${a.name}${n > 1 ? ` × ${n}` : ''}${fraction < 1 ? ' (prorated)' : ''}`, cents: Math.round(monthly * n * fraction * (this.intervalDays(contract.subscriptionInterval) / 30)), periodStart: start, periodEnd: end });
    }
    return lines.filter((l) => l.cents > 0);
  }

  /** Create an invoice + ledger entry for subscription lines. Returns null when there is nothing to charge. */
  async invoiceLines(orgId: string, lines: { description: string; cents: number; periodStart: Date; periodEnd: Date }[], memo: string, now = new Date(), tx: DbOrTx = this.db) {
    const total = lines.reduce((a, l) => a + l.cents, 0);
    if (total <= 0) return null;
    const [inv] = await tx.insert(invoices).values({ organizationId: orgId, number: invoiceNumber('SUB'), kind: 'SUBSCRIPTION', currency: loadConfig().DEFAULT_CURRENCY, lines, totalCents: total, dueAt: addDays(now, 14) }).returning();
    await this.ledger.post({ invoiceId: inv.id, currency: inv.currency }, [
      { account: 'CUSTOMER_RECEIVABLE', partyId: orgId, organizationId: orgId, debitCents: total, memo },
      { account: 'PLATFORM_REVENUE_SUBSCRIPTION', creditCents: total, organizationId: orgId },
    ], tx);
    return inv;
  }

  private async locationCount(orgId: string, tx: DbOrTx) {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.organizationId, orgId), sql`${locations.status} not in ('OFFBOARDED')`));
    return r.n;
  }

  /**
   * Move the organization's subscription onto `contract` right now. The current period is closed and billed for the
   * days used (nothing during a trial); a new period starts today. One trial per organization.
   */
  async switchSubscription(orgId: string, contract: typeof merchantContracts.$inferSelect, version: { trialDays: number; interval: string } | null, now: Date, tx: DbOrTx) {
    const s = await this.openSubscription(orgId, tx);
    const count = await this.locationCount(orgId, tx);
    let lastInvoiceId = s?.lastInvoiceId ?? null;
    if (s && s.status !== 'TRIAL' && s.status !== 'PAUSED' && now > s.currentPeriodStart) {
      const [old] = await tx.select().from(merchantContracts).where(eq(merchantContracts.id, s.contractId)).limit(1);
      if (old) {
        const span = s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime();
        const used = Math.min(1, Math.max(0, (now.getTime() - s.currentPeriodStart.getTime()) / span));
        const inv = await this.invoiceLines(orgId, await this.periodLines(orgId, old, s.locationCount || count, s.currentPeriodStart, now, used, tx), 'Subscription invoice (plan change, days used)', now, tx);
        if (inv) lastInvoiceId = inv.id;
      }
    }
    const addOnCount = (await this.activeAddOns(orgId, now, tx)).length;
    const needsSubscription = contract.subscriptionCents > 0 || addOnCount > 0;
    if (!needsSubscription) {
      if (s) await tx.update(platformSubscriptions).set({ status: 'CANCELED', canceledAt: now, contractId: contract.id, currentPeriodEnd: now, lastInvoiceId }).where(eq(platformSubscriptions.id, s.id));
      return;
    }
    const everTrialed = (await tx.select({ id: platformSubscriptions.id }).from(platformSubscriptions).where(and(eq(platformSubscriptions.organizationId, orgId), isNotNull(platformSubscriptions.trialEndsAt))).limit(1)).length > 0;
    const trialDays = !everTrialed && version?.trialDays ? version.trialDays : 0;
    const end = addDays(now, trialDays || this.intervalDays(contract.subscriptionInterval));
    const values = { contractId: contract.id, status: trialDays ? 'TRIAL' : 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: end, locationCount: count || 1, lastInvoiceId, canceledAt: null, pausedAt: null, pausedReason: null, ...(trialDays ? { trialEndsAt: end } : {}) };
    if (s) await tx.update(platformSubscriptions).set(values).where(eq(platformSubscriptions.id, s.id));
    else await tx.insert(platformSubscriptions).values({ organizationId: orgId, ...values });
  }

  /** The contract in force for an organization at a moment (latest version whose window contains it). */
  async contractAt(orgId: string, at: Date, tx: DbOrTx = this.db) {
    const [c] = await tx
      .select()
      .from(merchantContracts)
      .where(and(eq(merchantContracts.organizationId, orgId), lte(merchantContracts.effectiveFrom, at), or(isNull(merchantContracts.effectiveTo), gt(merchantContracts.effectiveTo, at))))
      .orderBy(desc(merchantContracts.version))
      .limit(1);
    return c ?? null;
  }

  /**
   * Daily: subscriptions whose period ended are billed (in arrears; trials free) and renewed on whichever contract
   * is in force at the renewal date — so scheduled downgrades and cancellations take effect here. Paused
   * subscriptions are skipped. Kept under the old name for the worker.
   */
  async billDueSubscriptions(now = new Date()) {
    const due = await this.db.select().from(platformSubscriptions).where(and(inArray(platformSubscriptions.status, ['ACTIVE', 'TRIAL', 'PAST_DUE']), lte(platformSubscriptions.currentPeriodEnd, now)));
    const out: string[] = [];
    for (const s of due) {
      await this.db.transaction(async (tx) => {
        const [c] = await tx.select().from(merchantContracts).where(eq(merchantContracts.id, s.contractId)).limit(1);
        let lastInvoiceId = s.lastInvoiceId;
        if (c && s.status !== 'TRIAL') {
          const inv = await this.invoiceLines(s.organizationId, await this.periodLines(s.organizationId, c, s.locationCount, s.currentPeriodStart, s.currentPeriodEnd, 1, tx), 'Subscription invoice', now, tx);
          if (inv) {
            lastInvoiceId = inv.id;
            out.push(inv.id);
          }
        }
        // add-ons canceled for this period end stop now
        await tx.update(orgAddOns).set({ status: 'CANCELED', canceledAt: now }).where(and(eq(orgAddOns.organizationId, s.organizationId), eq(orgAddOns.status, 'ACTIVE'), lte(orgAddOns.cancelAt, s.currentPeriodEnd)));
        const next = (await this.contractAt(s.organizationId, s.currentPeriodEnd, tx)) || c;
        const addOnsLeft = (await this.activeAddOns(s.organizationId, s.currentPeriodEnd, tx)).length;
        if (!next || (next.subscriptionCents <= 0 && !addOnsLeft)) {
          await tx.update(platformSubscriptions).set({ status: 'CANCELED', canceledAt: now, lastInvoiceId, contractId: next?.id ?? s.contractId }).where(eq(platformSubscriptions.id, s.id));
          return;
        }
        const nextEnd = addDays(s.currentPeriodEnd, this.intervalDays(next.subscriptionInterval));
        await tx
          .update(platformSubscriptions)
          .set({ contractId: next.id, status: s.status === 'PAST_DUE' ? 'PAST_DUE' : 'ACTIVE', currentPeriodStart: s.currentPeriodEnd, currentPeriodEnd: nextEnd, lastInvoiceId, locationCount: Math.max(1, await this.locationCount(s.organizationId, tx)) })
          .where(eq(platformSubscriptions.id, s.id));
      });
    }
    await this.syncPastDue();
    return out;
  }

  /** A subscription whose latest invoice is past due is PAST_DUE; paying it returns the subscription to ACTIVE. */
  async syncPastDue() {
    await this.db.execute(sql`update platform_subscriptions s set status = 'PAST_DUE' from invoices i where i.id = s.last_invoice_id and i.status = 'PAST_DUE' and s.status = 'ACTIVE'`);
    await this.db.execute(sql`update platform_subscriptions s set status = 'ACTIVE' from invoices i where i.id = s.last_invoice_id and i.status = 'PAID' and s.status = 'PAST_DUE'`);
  }
}

export interface IssueInput {
  planCode: string;
  planVersionId?: string;
  locationIds?: string[];
  overrides?: Partial<typeof merchantContracts.$inferInsert> & { fees?: FeeRuleDto[] };
  effectiveFrom?: Date;
  sign?: boolean;
}
