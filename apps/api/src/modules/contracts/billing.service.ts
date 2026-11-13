import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { resolveFee, type FeeRuleDto } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { addOns, auditLogs, features, invoices, journalEntries, locations, merchantContracts, orders, orgAddOns, organizations, planFees, planVersions, platformSettings, platformSubscriptions, promotionRedemptions, promotions, reservations } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { assertOrgAccess, isPlatformStaff, JwtPayload } from '../../common/auth';
import { MERCHANT_AGREEMENT_VERSION, OnboardingService } from '../onboarding/onboarding.service';
import { contractFeeRules, ContractsService } from './contracts.service';
import { PlansService } from './plans.service';

type FeatureMap = Record<string, boolean | number>;
const monthly = (cents: number, interval: string) => (interval === 'YEAR' ? Math.round(cents / 12) : cents);

/** 25 — merchant self-serve plan & billing, add-ons, and the admin tools around subscriptions. */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly contracts: ContractsService,
    private readonly plans: PlansService,
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditService,
  ) {}

  private async defaultPlanCode() {
    const [s] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, 'plans.default_plan_code')).limit(1);
    return typeof s?.value === 'string' ? s.value : 'DIRECT_FREE';
  }

  private async scheduled(orgId: string) {
    const now = new Date();
    const [c] = await this.db.select().from(merchantContracts).where(and(eq(merchantContracts.organizationId, orgId), gt(merchantContracts.effectiveFrom, now))).orderBy(asc(merchantContracts.effectiveFrom)).limit(1);
    return c ?? null;
  }

  // ───── merchant overview ─────

  async overview(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const now = new Date();
    const current = await this.contracts.contractAt(orgId, now);
    const sub = await this.contracts.openSubscription(orgId);
    const next = await this.scheduled(orgId);
    const version = current?.planVersionId ? (await this.db.select().from(planVersions).where(eq(planVersions.id, current.planVersionId)).limit(1))[0] : null;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const locs = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
    const locIds = locs.map((l) => l.id);
    const orderUsage = locIds.length
      ? await this.db
          .select({ channel: orders.channel, fulfillment: orders.fulfillmentType, orders: sql<number>`count(*)::int`, salesCents: sql<number>`coalesce(sum(${orders.subtotalCents}),0)::int`, commissionCents: sql<number>`coalesce(sum(${orders.commissionCents}),0)::int` })
          .from(orders)
          .where(and(inArray(orders.locationId, locIds), gte(orders.createdAt, monthStart), sql`${orders.status} not in ('REJECTED','CANCELED')`))
          .groupBy(orders.channel, orders.fulfillmentType)
      : [];
    const [covers] = locIds.length
      ? await this.db.select({ covers: sql<number>`coalesce(sum(${reservations.billableCovers}),0)::int`, feeCents: sql<number>`coalesce(sum(${reservations.coverFeeCents}),0)::int` }).from(reservations).where(and(inArray(reservations.locationId, locIds), gte(reservations.createdAt, monthStart)))
      : [{ covers: 0, feeCents: 0 }];
    const active = await this.contracts.activeAddOns(orgId, now);
    let nextInvoice: { date: Date; lines: { description: string; cents: number }[]; totalCents: number } | null = null;
    if (sub && current && sub.status !== 'PAUSED') {
      const subContract = (await this.db.select().from(merchantContracts).where(eq(merchantContracts.id, sub.contractId)).limit(1))[0] || current;
      const lines = sub.status === 'TRIAL' ? [] : await this.contracts.periodLines(orgId, subContract, sub.locationCount, sub.currentPeriodStart, sub.currentPeriodEnd);
      const promo = sub.status === 'TRIAL' ? null : await this.contracts.promotionLine(orgId, subContract, lines.find((l) => l.description.startsWith(subContract.name))?.cents ?? 0, sub.currentPeriodStart, sub.currentPeriodEnd);
      if (promo) lines.push(promo.line);
      nextInvoice = { date: sub.currentPeriodEnd, lines: lines.map((l) => ({ description: l.description, cents: l.cents })), totalCents: lines.reduce((a, l) => a + l.cents, 0) };
    }
    const catalogAddOns = await this.db.select().from(addOns).where(and(eq(addOns.isActive, true), eq(addOns.isPublic, true))).orderBy(asc(addOns.sortOrder));
    const invs = await this.db.select().from(invoices).where(eq(invoices.organizationId, orgId)).orderBy(desc(invoices.createdAt)).limit(24);
    const promos = await this.db.select({ r: promotionRedemptions, p: promotions }).from(promotionRedemptions).innerJoin(promotions, eq(promotions.id, promotionRedemptions.promotionId)).where(eq(promotionRedemptions.organizationId, orgId)).orderBy(desc(promotionRedemptions.redeemedAt));
    return {
      current: current
        ? { contractId: current.id, planCode: current.planCode, name: current.name, version: version?.version ?? null, legacy: !current.planVersionId, subscriptionCents: current.subscriptionCents, interval: current.subscriptionInterval, signedAt: current.signedAt, effectiveFrom: current.effectiveFrom, fees: contractFeeRules(current), features: current.features }
        : null,
      defaultPlanCode: await this.defaultPlanCode(),
      subscription: sub ? { id: sub.id, status: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt, pausedAt: sub.pausedAt, locationCount: sub.locationCount } : null,
      scheduledChange: next ? { contractId: next.id, planCode: next.planCode, name: next.name, effectiveFrom: next.effectiveFrom, subscriptionCents: next.subscriptionCents, interval: next.subscriptionInterval } : null,
      usage: { since: monthStart, orders: orderUsage, covers: covers?.covers ?? 0, coverFeeCents: covers?.feeCents ?? 0 },
      nextInvoice,
      addOns: active.map((a) => ({ id: a.id, addOnId: a.addOnId, code: a.code, name: a.name, priceCents: a.priceCents, interval: a.interval, quantity: a.quantity, cancelAt: a.cancelAt, startedAt: a.startedAt })),
      availableAddOns: catalogAddOns.filter((a) => !active.some((x) => x.addOnId === a.id)).map((a) => ({ id: a.id, code: a.code, name: a.name, description: a.description, priceCents: a.priceCents, interval: a.interval, perLocation: a.perLocation, productLine: a.productLine, features: a.features })),
      promotions: promos.map(({ r, p }) => ({ code: p.code, name: p.name, kind: p.kind, percentOff: p.percentOff, periods: p.periods, periodsUsed: r.periodsUsed, endsAt: r.endsAt, redeemedAt: r.redeemedAt, active: p.kind === 'COMMISSION_HOLIDAY' ? !!r.endsAt && r.endsAt > now : r.periodsUsed < p.periods })),
      invoices: invs.map((i) => ({ id: i.id, number: i.number, kind: i.kind, status: i.status, totalCents: i.totalCents, dueAt: i.dueAt, paidAt: i.paidAt, createdAt: i.createdAt, lines: i.lines })),
    };
  }

  // ───── plan change ─────

  private featureDiff(from: FeatureMap | null, to: FeatureMap, names: Map<string, string>, legacy: boolean) {
    const keys = new Set([...Object.keys(from || {}), ...Object.keys(to)]);
    const gained: string[] = [];
    const lost: string[] = [];
    const limits: { key: string; name: string; from: number | null; to: number | null }[] = [];
    for (const k of keys) {
      const a = legacy ? true : from?.[k];
      const b = to[k];
      const name = names.get(k) || k;
      if (typeof a === 'number' || typeof b === 'number') {
        const av = typeof a === 'number' ? a : legacy ? null : null;
        const bv = typeof b === 'number' ? b : null;
        if (av !== bv) limits.push({ key: k, name, from: av, to: bv });
      } else if (!a && b) gained.push(name);
      else if (a && !b) lost.push(name);
    }
    return { gained, lost, limits };
  }

  /**
   * What switching to `planCode` would mean: when it takes effect (upgrades now, downgrades at renewal), the
   * charge for days used on the current plan, the new price, features gained/lost, limits vs. current usage.
   */
  async preview(user: JwtPayload, orgId: string, planCode: string) {
    assertOrgAccess(user, orgId);
    const now = new Date();
    const target = await this.plans.publishedVersion(planCode);
    if (!target.plan.isPublic && !isPlatformStaff(user)) throw new ForbiddenException('That plan is not available for self-serve');
    const current = await this.contracts.contractAt(orgId, now);
    const sub = await this.contracts.openSubscription(orgId);
    const curMonthly = current ? monthly(current.subscriptionCents, current.subscriptionInterval) : 0;
    const newMonthly = monthly(target.version.subscriptionCents, target.version.interval);
    const same = current?.planVersionId === target.version.id;
    const direction: 'UPGRADE' | 'DOWNGRADE' | 'SAME' = same ? 'SAME' : newMonthly > curMonthly ? 'UPGRADE' : 'DOWNGRADE';
    const effectiveFrom = direction === 'UPGRADE' || !sub || sub.status === 'CANCELED' ? now : sub.currentPeriodEnd;
    let usedChargeCents = 0;
    if (direction === 'UPGRADE' && sub && current && sub.status === 'ACTIVE') {
      const span = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
      const used = Math.min(1, Math.max(0, (now.getTime() - sub.currentPeriodStart.getTime()) / span));
      usedChargeCents = (await this.contracts.periodLines(orgId, current, sub.locationCount, sub.currentPeriodStart, now, used)).reduce((a, l) => a + l.cents, 0);
    }
    const names = new Map((await this.db.select({ key: features.key, name: features.name }).from(features)).map((f) => [f.key, f.name]));
    const diff = this.featureDiff((current?.features as FeatureMap) || null, target.features, names, !!current && !current.planVersionId);
    const warnings: string[] = [];
    const [locCount] = await this.db.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.organizationId, orgId), sql`${locations.status} not in ('OFFBOARDED')`));
    const maxLoc = target.features.locations;
    if (typeof maxLoc === 'number' && locCount.n > maxLoc) warnings.push(`You have ${locCount.n} locations; ${target.plan.name} includes ${maxLoc}. You won't be able to add more, and Gutad may ask you to remove extras.`);
    if (diff.lost.length) warnings.push(`You'll lose: ${diff.lost.join(', ')}.`);
    const everTrialed = (await this.db.select({ id: platformSubscriptions.id }).from(platformSubscriptions).where(and(eq(platformSubscriptions.organizationId, orgId), sql`${platformSubscriptions.trialEndsAt} is not null`)).limit(1)).length > 0;
    return {
      plan: { code: target.plan.code, name: target.plan.name, productLine: target.plan.productLine, version: target.version.version, subscriptionCents: target.version.subscriptionCents, interval: target.version.interval, perLocation: target.version.perLocation, trialDays: everTrialed ? 0 : target.version.trialDays, fees: target.fees },
      current: current ? { planCode: current.planCode, name: current.name, subscriptionCents: current.subscriptionCents, interval: current.subscriptionInterval, legacy: !current.planVersionId } : null,
      direction,
      effectiveFrom,
      usedChargeCents,
      gained: diff.gained,
      lost: diff.lost,
      limits: diff.limits,
      warnings,
      agreementVersion: MERCHANT_AGREEMENT_VERSION,
    };
  }

  /** The owner signs the new Order Form; it's issued now (upgrade) or for the renewal date (downgrade). */
  async change(user: JwtPayload, orgId: string, input: { planCode: string; signatureName: string; signatureTitle?: string; agreementVersion: string }, meta: { ip?: string; userAgent?: string }) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER']);
    const p = await this.preview(user, orgId, input.planCode);
    if (p.direction === 'SAME') throw new BadRequestException(`You're already on ${p.plan.name}`);
    if (input.agreementVersion !== MERCHANT_AGREEMENT_VERSION) throw new BadRequestException('The Merchant Agreement changed. Reload and review it before switching.');
    return this.db.transaction(async (tx) => {
      const c = await this.contracts.issue(orgId, { planCode: input.planCode, effectiveFrom: p.effectiveFrom, sign: true }, user.sub, tx);
      await this.onboarding.recordAcceptance(orgId, user.sub, { signatureName: input.signatureName, signatureTitle: input.signatureTitle, contractId: c.id }, meta, tx);
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: `plan.${p.direction.toLowerCase()}`, entityType: 'contract', entityId: c.id, after: { from: p.current?.planCode ?? null, to: p.plan.code, effectiveFrom: p.effectiveFrom, usedChargeCents: p.usedChargeCents } }, tx);
      return { contractId: c.id, direction: p.direction, effectiveFrom: c.effectiveFrom, planCode: p.plan.code };
    });
  }

  /** Undo a scheduled (not yet effective) plan change; the current plan simply continues. */
  async cancelScheduled(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER']);
    const next = await this.scheduled(orgId);
    if (!next) throw new BadRequestException('No scheduled plan change');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`update merchant_agreement_acceptances set contract_id = null where contract_id = ${next.id}`);
      await tx.delete(merchantContracts).where(eq(merchantContracts.id, next.id));
      const current = await this.contracts.contractAt(orgId, new Date(), tx);
      if (current && current.effectiveTo && current.effectiveTo.getTime() === next.effectiveFrom.getTime()) await tx.update(merchantContracts).set({ effectiveTo: null }).where(eq(merchantContracts.id, current.id));
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'plan.change.cancel', entityType: 'contract', entityId: next.id, before: { planCode: next.planCode, effectiveFrom: next.effectiveFrom } }, tx);
      return { ok: true };
    });
  }

  // ───── promotions ─────

  /** A merchant redeems a promotion code (one redemption per code per business). */
  async redeem(user: JwtPayload, orgId: string, rawCode: string) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    const code = rawCode.trim().toUpperCase();
    const now = new Date();
    const [p] = await this.db.select().from(promotions).where(eq(promotions.code, code)).limit(1);
    if (!p || !p.isActive || (p.startsAt && p.startsAt > now) || (p.expiresAt && p.expiresAt < now)) throw new BadRequestException('That code is not valid or has expired');
    if (p.maxRedemptions !== null) {
      const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(promotionRedemptions).where(eq(promotionRedemptions.promotionId, p.id));
      if (n.n >= p.maxRedemptions) throw new BadRequestException('That code has been fully redeemed');
    }
    const [already] = await this.db.select({ id: promotionRedemptions.id }).from(promotionRedemptions).where(and(eq(promotionRedemptions.promotionId, p.id), eq(promotionRedemptions.organizationId, orgId))).limit(1);
    if (already) throw new BadRequestException('You already used this code');
    if (p.newMerchantsOnly) {
      const [paid] = await this.db.select({ n: sql<number>`count(*)::int` }).from(invoices).where(and(eq(invoices.organizationId, orgId), eq(invoices.status, 'PAID')));
      if (paid.n > 0) throw new BadRequestException('This code is for new merchants only');
    }
    const current = await this.contracts.contractAt(orgId, now);
    if (p.planCodes.length && (!current || !p.planCodes.includes(current.planCode))) throw new BadRequestException(`This code applies to: ${p.planCodes.join(', ')}. Switch plan first.`);
    if (p.kind !== 'COMMISSION_HOLIDAY') {
      const open = await this.db.select({ id: promotionRedemptions.id }).from(promotionRedemptions).innerJoin(promotions, eq(promotions.id, promotionRedemptions.promotionId)).where(and(eq(promotionRedemptions.organizationId, orgId), inArray(promotions.kind, ['PERCENT_OFF', 'FREE_PERIODS']), sql`${promotionRedemptions.periodsUsed} < ${promotions.periods}`)).limit(1);
      if (open.length) throw new BadRequestException('You already have a subscription discount running');
    }
    const endsAt = p.kind === 'COMMISSION_HOLIDAY' ? new Date(now.getTime() + p.days * 86_400_000) : null;
    const [r] = await this.db.insert(promotionRedemptions).values({ promotionId: p.id, organizationId: orgId, redeemedById: user.sub, endsAt, redeemedAt: now }).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'promotion.redeem', entityType: 'promotion', entityId: p.id, after: { code: p.code, kind: p.kind, endsAt } });
    return { id: r.id, code: p.code, name: p.name, kind: p.kind, endsAt };
  }

  async adminPromotions(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const rows = await this.db.select().from(promotions).orderBy(desc(promotions.createdAt));
    const counts = await this.db.select({ id: promotionRedemptions.promotionId, n: sql<number>`count(*)::int` }).from(promotionRedemptions).groupBy(promotionRedemptions.promotionId);
    return rows.map((p) => ({ ...p, redemptions: counts.find((c) => c.id === p.id)?.n ?? 0 }));
  }

  async upsertPromotion(user: JwtPayload, input: { id?: string; code: string; name: string; kind: 'PERCENT_OFF' | 'FREE_PERIODS' | 'COMMISSION_HOLIDAY'; percentOff?: number; periods?: number; days?: number; planCodes?: string[]; maxRedemptions?: number | null; newMerchantsOnly?: boolean; startsAt?: Date | null; expiresAt?: Date | null; isActive?: boolean }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    if (input.kind === 'PERCENT_OFF' && !(input.percentOff && input.percentOff > 0 && input.percentOff <= 100)) throw new BadRequestException('Percent off must be 1–100');
    if (input.kind === 'COMMISSION_HOLIDAY' && !(input.days && input.days > 0)) throw new BadRequestException('Set how many days the commission holiday lasts');
    const { id, ...rest } = input;
    const values = { ...rest, code: input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''), planCodes: input.planCodes || [] };
    if (!id && (await this.db.select({ id: promotions.id }).from(promotions).where(eq(promotions.code, values.code)).limit(1)).length) throw new BadRequestException(`A promotion with code ${values.code} already exists`);
    const [row] = id ? await this.db.update(promotions).set(values).where(eq(promotions.id, id)).returning() : await this.db.insert(promotions).values(values).returning();
    await this.audit.log({ actorId: user.sub, action: id ? 'promotion.update' : 'promotion.create', entityType: 'promotion', entityId: row.id, after: row });
    return row;
  }

  // ───── revenue report (admin) ─────

  async revenueReport(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const now = new Date();
    const subs = await this.adminSubscriptions(user);
    const open = subs.filter((s) => s.status !== 'CANCELED');
    const byPlan = new Map<string, { plan: string; subscribers: number; mrrCents: number }>();
    for (const s of open) {
      const k = s.planName;
      const row = byPlan.get(k) || { plan: k, subscribers: 0, mrrCents: 0 };
      row.subscribers += 1;
      row.mrrCents += s.mrrCents;
      byPlan.set(k, row);
    }
    const addOnRows = await this.db.select({ name: addOns.name, priceCents: orgAddOns.priceCents, quantity: orgAddOns.quantity, interval: addOns.interval }).from(orgAddOns).innerJoin(addOns, eq(addOns.id, orgAddOns.addOnId)).where(eq(orgAddOns.status, 'ACTIVE'));
    const addOnMrr = addOnRows.reduce((a, r) => a + monthly(r.priceCents, r.interval) * r.quantity, 0);
    const trials = subs.filter((s) => s.trialEndsAt);
    const trialsEnded = trials.filter((s) => s.trialEndsAt && new Date(s.trialEndsAt) < now);
    const converted = trialsEnded.filter((s) => s.status === 'ACTIVE' || s.status === 'PAST_DUE' || s.status === 'PAUSED');
    const since90 = new Date(now.getTime() - 90 * 86_400_000);
    const changes = await this.db.select({ action: auditLogs.action, n: sql<number>`count(*)::int` }).from(auditLogs).where(and(inArray(auditLogs.action, ['plan.upgrade', 'plan.downgrade', 'plan.change.cancel', 'addon.buy', 'addon.cancel', 'promotion.redeem']), gte(auditLogs.createdAt, since90))).groupBy(auditLogs.action);
    const since6m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const revenue = await this.db
      .select({ month: sql<string>`to_char(date_trunc('month', ${journalEntries.createdAt}), 'YYYY-MM')`, account: journalEntries.account, cents: sql<number>`coalesce(sum(${journalEntries.creditCents} - ${journalEntries.debitCents}),0)::int` })
      .from(journalEntries)
      .where(and(inArray(journalEntries.account, ['PLATFORM_REVENUE_SUBSCRIPTION', 'PLATFORM_REVENUE_COMMISSION', 'PLATFORM_REVENUE_COVER_FEE', 'PLATFORM_REVENUE_ADS', 'PLATFORM_REVENUE_SERVICE_FEE']), gte(journalEntries.createdAt, since6m)))
      .groupBy(sql`1`, journalEntries.account)
      .orderBy(sql`1`);
    const statusCounts = Object.fromEntries(['TRIAL', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED'].map((k) => [k, subs.filter((s) => s.status === k).length]));
    return {
      mrrCents: open.reduce((a, s) => a + s.mrrCents, 0) + addOnMrr,
      planMrrCents: open.reduce((a, s) => a + s.mrrCents, 0),
      addOnMrrCents: addOnMrr,
      byPlan: [...byPlan.values()].sort((a, b) => b.mrrCents - a.mrrCents),
      statusCounts,
      trials: { started: trials.length, ended: trialsEnded.length, converted: converted.length, conversionRate: trialsEnded.length ? converted.length / trialsEnded.length : null },
      changes90d: Object.fromEntries(changes.map((c) => [c.action, c.n])),
      revenueByMonth: revenue,
    };
  }

  // ───── add-ons (merchant) ─────

  async buyAddOn(user: JwtPayload, orgId: string, addOnId: string, quantity = 1) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    const [a] = await this.db.select().from(addOns).where(and(eq(addOns.id, addOnId), eq(addOns.isActive, true))).limit(1);
    if (!a || (!a.isPublic && !isPlatformStaff(user))) throw new NotFoundException('Add-on not available');
    const existing = (await this.contracts.activeAddOns(orgId)).find((x) => x.addOnId === addOnId);
    if (existing && !existing.cancelAt) throw new BadRequestException(`${a.name} is already active`);
    const now = new Date();
    return this.db.transaction(async (tx) => {
      if (existing?.cancelAt) {
        // re-activating an add-on that was set to end: just keep it
        await tx.update(orgAddOns).set({ cancelAt: null }).where(eq(orgAddOns.id, existing.id));
        return { id: existing.id, reactivated: true };
      }
      const [row] = await tx.insert(orgAddOns).values({ organizationId: orgId, addOnId, priceCents: a.priceCents, quantity, createdById: user.sub }).returning();
      let sub = await this.contracts.openSubscription(orgId, tx);
      const current = await this.contracts.contractAt(orgId, now, tx);
      if (!sub && current) {
        await this.contracts.switchSubscription(orgId, current, null, now, tx); // start a billing period for the add-on
        sub = await this.contracts.openSubscription(orgId, tx);
      } else if (sub && sub.status === 'ACTIVE' && a.priceCents > 0) {
        // charge the rest of this period now; renewals include it from then on
        const span = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
        const left = Math.min(1, Math.max(0, (sub.currentPeriodEnd.getTime() - now.getTime()) / span));
        const per = (a.perLocation ? Math.max(1, sub.locationCount) : 1) * quantity;
        const cents = Math.round(monthly(a.priceCents, a.interval) * per * left * ((sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime()) / (30 * 86_400_000)));
        await this.contracts.invoiceLines(orgId, [{ description: `${a.name} (prorated)`, cents, periodStart: now, periodEnd: sub.currentPeriodEnd }], 'Add-on invoice', now, tx);
      }
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'addon.buy', entityType: 'org_add_on', entityId: row.id, after: { code: a.code, priceCents: a.priceCents, quantity } }, tx);
      return row;
    });
  }

  /** Ends at the end of the current billing period (immediately when there is no subscription). */
  async cancelAddOn(user: JwtPayload, orgId: string, orgAddOnId: string) {
    assertOrgAccess(user, orgId, null, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    const [row] = await this.db.select().from(orgAddOns).where(and(eq(orgAddOns.id, orgAddOnId), eq(orgAddOns.organizationId, orgId), eq(orgAddOns.status, 'ACTIVE'))).limit(1);
    if (!row) throw new NotFoundException();
    const sub = await this.contracts.openSubscription(orgId);
    const at = sub && sub.status !== 'CANCELED' ? sub.currentPeriodEnd : new Date();
    const [u] = await this.db.update(orgAddOns).set(sub ? { cancelAt: at } : { status: 'CANCELED', canceledAt: at, cancelAt: at }).where(eq(orgAddOns.id, row.id)).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'addon.cancel', entityType: 'org_add_on', entityId: row.id, after: { cancelAt: at } });
    return u;
  }

  // ───── add-ons (admin catalog) ─────

  async adminAddOns(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const rows = await this.db.select().from(addOns).orderBy(asc(addOns.sortOrder), asc(addOns.name));
    const counts = await this.db.select({ addOnId: orgAddOns.addOnId, n: sql<number>`count(*)::int` }).from(orgAddOns).where(eq(orgAddOns.status, 'ACTIVE')).groupBy(orgAddOns.addOnId);
    return rows.map((r) => ({ ...r, activeCount: counts.find((c) => c.addOnId === r.id)?.n ?? 0 }));
  }

  async upsertAddOn(user: JwtPayload, input: { id?: string; code: string; name: string; description?: string | null; productLine?: string; priceCents: number; interval?: string; perLocation?: boolean; features?: FeatureMap; isPublic?: boolean; isActive?: boolean; sortOrder?: number }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (input.features) {
      const known = await this.db.select({ key: features.key }).from(features).where(inArray(features.key, Object.keys(input.features).length ? Object.keys(input.features) : ['__none__']));
      const missing = Object.keys(input.features).filter((k) => !known.some((x) => x.key === k));
      if (missing.length) throw new BadRequestException(`Unknown features: ${missing.join(', ')}`);
    }
    const { id, ...rest } = input;
    const values = { ...rest, code };
    if (!id && (await this.db.select({ id: addOns.id }).from(addOns).where(eq(addOns.code, code)).limit(1)).length) throw new BadRequestException(`An add-on with code ${code} already exists`);
    const [row] = id ? await this.db.update(addOns).set(values).where(eq(addOns.id, id)).returning() : await this.db.insert(addOns).values(values).returning();
    await this.audit.log({ actorId: user.sub, action: id ? 'addon.update' : 'addon.create', entityType: 'add_on', entityId: row.id, after: row });
    return row;
  }

  // ───── subscriptions (admin) ─────

  async runRenewals(user: JwtPayload, asOf?: Date) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const now = new Date();
    if (asOf && asOf.getTime() > now.getTime() + 60_000 && process.env.ALLOW_BILLING_TIME_TRAVEL !== 'true') throw new BadRequestException('Billing can only run for the current time');
    const invoicesCreated = await this.contracts.billDueSubscriptions(asOf && process.env.ALLOW_BILLING_TIME_TRAVEL === 'true' ? asOf : now);
    await this.audit.log({ actorId: user.sub, action: 'billing.run', entityType: 'billing', entityId: 'renewals', after: { asOf: asOf ?? now, invoices: invoicesCreated.length } });
    return { invoices: invoicesCreated.length };
  }

  async adminSubscriptions(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const subs = await this.db
      .select({ s: platformSubscriptions, orgName: organizations.name, planName: merchantContracts.name, planCode: merchantContracts.planCode, priceCents: merchantContracts.subscriptionCents, interval: merchantContracts.subscriptionInterval })
      .from(platformSubscriptions)
      .innerJoin(organizations, eq(organizations.id, platformSubscriptions.organizationId))
      .innerJoin(merchantContracts, eq(merchantContracts.id, platformSubscriptions.contractId))
      .orderBy(desc(platformSubscriptions.currentPeriodEnd))
      .limit(500);
    const now = new Date();
    const future = await this.db.select({ orgId: merchantContracts.organizationId, name: merchantContracts.name, effectiveFrom: merchantContracts.effectiveFrom }).from(merchantContracts).where(gt(merchantContracts.effectiveFrom, now));
    return subs.map(({ s, ...r }) => ({ ...s, ...r, mrrCents: s.status === 'ACTIVE' || s.status === 'PAST_DUE' ? monthly(r.priceCents, r.interval) * Math.max(1, s.locationCount) : 0, scheduled: future.find((f) => f.orgId === s.organizationId) ?? null }));
  }

  async pause(user: JwtPayload, subId: string, paused: boolean, reason?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [s] = await this.db.select().from(platformSubscriptions).where(eq(platformSubscriptions.id, subId)).limit(1);
    if (!s) throw new NotFoundException();
    if (paused && s.status === 'CANCELED') throw new BadRequestException('Subscription is canceled');
    const now = new Date();
    let patch: Partial<typeof platformSubscriptions.$inferInsert>;
    if (paused) patch = { status: 'PAUSED', pausedAt: now, pausedReason: reason ?? null };
    else {
      if (s.status !== 'PAUSED') throw new BadRequestException('Subscription is not paused');
      // resume: push the period end out by the time spent paused, so the merchant isn't charged for it
      const pausedMs = s.pausedAt ? now.getTime() - s.pausedAt.getTime() : 0;
      patch = { status: 'ACTIVE', pausedAt: null, pausedReason: null, currentPeriodEnd: new Date(s.currentPeriodEnd.getTime() + pausedMs) };
    }
    const [u] = await this.db.update(platformSubscriptions).set(patch).where(eq(platformSubscriptions.id, subId)).returning();
    await this.audit.log({ organizationId: s.organizationId, actorId: user.sub, action: paused ? 'subscription.pause' : 'subscription.resume', entityType: 'subscription', entityId: subId, after: { reason } });
    return u;
  }

  /**
   * Move merchants on older versions of a plan onto this published version from a date. Contracts with
   * per-merchant fee overrides are skipped unless `includeOverridden`; pre-catalog contracts only with `includeLegacy`.
   */
  async migrate(user: JwtPayload, versionId: string, input: { effectiveFrom: Date; includeLegacy?: boolean; includeOverridden?: boolean; dryRun?: boolean }) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const target = await this.plans.versionById(versionId);
    if (target.version.status !== 'PUBLISHED') throw new BadRequestException('Only the published version can receive subscribers');
    const now = new Date();
    const at = input.effectiveFrom < now ? now : input.effectiveFrom;
    const sameCode = await this.db.select().from(merchantContracts).where(and(eq(merchantContracts.planCode, target.plan.code), sql`(${merchantContracts.effectiveTo} is null or ${merchantContracts.effectiveTo} > ${now})`, lt(merchantContracts.effectiveFrom, sql`${now}::timestamptz + interval '1 second'`)));
    const versionFees = new Map<string, FeeRuleDto[]>();
    const moved: { organizationId: string; from: number | 'legacy' }[] = [];
    const skipped: { organizationId: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const c of sameCode.sort((a, b) => b.version - a.version)) {
      if (seen.has(c.organizationId)) continue;
      seen.add(c.organizationId);
      if (c.planVersionId === versionId) continue;
      if (!c.planVersionId && !input.includeLegacy) {
        skipped.push({ organizationId: c.organizationId, reason: 'contract predates the plan catalog' });
        continue;
      }
      if (c.planVersionId && !input.includeOverridden) {
        if (!versionFees.has(c.planVersionId)) versionFees.set(c.planVersionId, (await this.db.select().from(planFees).where(eq(planFees.planVersionId, c.planVersionId))).map((f) => ({ type: f.type as FeeRuleDto['type'], channel: f.channel, fulfillment: f.fulfillment, bps: f.bps, cents: f.cents, capCents: f.capCents })));
        const base = versionFees.get(c.planVersionId)!;
        const mine = contractFeeRules(c);
        const same = base.length === mine.length && base.every((f) => { const m = resolveFee(mine, f.type, f.channel, f.fulfillment); return m && m.bps === f.bps && m.cents === f.cents; });
        if (!same) {
          skipped.push({ organizationId: c.organizationId, reason: 'has negotiated fees' });
          continue;
        }
      }
      const fromVersion = c.planVersionId ? (await this.db.select({ v: planVersions.version }).from(planVersions).where(eq(planVersions.id, c.planVersionId)).limit(1))[0]?.v ?? 0 : 'legacy';
      if (!input.dryRun) await this.contracts.issue(c.organizationId, { planCode: target.plan.code, planVersionId: versionId, effectiveFrom: at, sign: false }, user.sub);
      moved.push({ organizationId: c.organizationId, from: fromVersion as number | 'legacy' });
    }
    if (!input.dryRun) await this.audit.log({ actorId: user.sub, action: 'plan.migrate', entityType: 'plan_version', entityId: versionId, after: { effectiveFrom: at, moved: moved.length, skipped: skipped.length } });
    return { plan: target.plan.code, version: target.version.version, effectiveFrom: at, dryRun: !!input.dryRun, moved, skipped };
  }
}

