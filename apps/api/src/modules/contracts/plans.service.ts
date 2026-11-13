import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FeeRuleDto, PublicPlanDto } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { features, merchantContracts, planFeatures, planFees, plans, planVersions, platformSettings, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { isPlatformStaff, JwtPayload } from '../../common/auth';
import { DEFAULT_FEATURES, DEFAULT_PLANS } from './plan-defaults';

const LINE_ORDER: Record<string, number> = { ORDERING: 0, RESERVATIONS: 1, SUITE: 2 };

/** Inserts the default features and, when the catalog is empty, the default plans. Idempotent. */
export async function seedPlanCatalog(tx: DbOrTx) {
  await tx.insert(features).values(DEFAULT_FEATURES.map((f, i) => ({ ...f, sortOrder: (i + 1) * 10 }))).onConflictDoNothing();
  const existing = await tx.select({ id: plans.id }).from(plans).limit(1);
  if (existing.length) return false;
  for (const p of DEFAULT_PLANS) {
    const [plan] = await tx.insert(plans).values({ code: p.code, name: p.name, productLine: p.productLine, tagline: p.tagline, description: p.description, highlight: !!p.highlight, sortOrder: p.sortOrder }).returning();
    const [v] = await tx.insert(planVersions).values({ planId: plan.id, version: 1, status: 'PUBLISHED', subscriptionCents: p.subscriptionCents, publishedAt: new Date(), notes: 'Initial catalog' }).returning();
    await tx.insert(planFees).values(p.fees.map((f, i) => ({ type: f.type, channel: f.channel, fulfillment: f.fulfillment, bps: f.bps, cents: f.cents, capCents: f.capCents ?? null, planVersionId: v.id, sortOrder: i })));
    await tx.insert(planFeatures).values(Object.entries(p.features).map(([featureKey, val]) => ({ planVersionId: v.id, featureKey, enabled: val !== false, limitValue: typeof val === 'number' ? val : null })));
  }
  return true;
}

export interface VersionInput {
  subscriptionCents?: number;
  interval?: 'MONTH' | 'YEAR';
  perLocation?: boolean;
  setupFeeCents?: number;
  trialDays?: number;
  notes?: string | null;
  fees?: FeeRuleDto[];
  features?: { key: string; enabled: boolean; limitValue?: number | null }[];
}

/** 25 — the configurable plan catalog: plans → versions → fee rules + features. */
@Injectable()
export class PlansService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  private staff(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException('Platform staff only');
  }

  // ───── reads ─────

  private async versionDetail(versionIds: string[], tx: DbOrTx = this.db) {
    if (!versionIds.length) return { fees: [], feats: [] };
    const fees = await tx.select().from(planFees).where(inArray(planFees.planVersionId, versionIds)).orderBy(asc(planFees.sortOrder));
    const feats = await tx.select().from(planFeatures).where(inArray(planFeatures.planVersionId, versionIds));
    return { fees, feats };
  }

  private feeDto(f: typeof planFees.$inferSelect): FeeRuleDto {
    return { type: f.type as FeeRuleDto['type'], channel: f.channel, fulfillment: f.fulfillment, bps: f.bps, cents: f.cents, capCents: f.capCents, label: f.label };
  }

  /** Published, public, non-archived plans with their current version — for the pricing page and sign-up. */
  async publicPlans(): Promise<PublicPlanDto[]> {
    const ps = await this.db.select().from(plans).where(and(eq(plans.isPublic, true), eq(plans.isArchived, false)));
    const vs = ps.length ? await this.db.select().from(planVersions).where(and(inArray(planVersions.planId, ps.map((p) => p.id)), eq(planVersions.status, 'PUBLISHED'))) : [];
    const { fees, feats } = await this.versionDetail(vs.map((v) => v.id));
    const catalog = await this.db.select().from(features).where(eq(features.isActive, true)).orderBy(asc(features.sortOrder));
    return ps
      .map((p) => ({ p, v: vs.find((v) => v.planId === p.id) }))
      .filter((x): x is { p: typeof x.p; v: NonNullable<typeof x.v> } => !!x.v)
      .sort((a, b) => (LINE_ORDER[a.p.productLine] ?? 9) - (LINE_ORDER[b.p.productLine] ?? 9) || a.p.sortOrder - b.p.sortOrder)
      .map(({ p, v }) => ({
        code: p.code,
        name: p.name,
        productLine: p.productLine as PublicPlanDto['productLine'],
        tagline: p.tagline,
        description: p.description,
        highlight: p.highlight,
        version: v.version,
        subscriptionCents: v.subscriptionCents,
        interval: v.interval as 'MONTH' | 'YEAR',
        perLocation: v.perLocation,
        setupFeeCents: v.setupFeeCents,
        trialDays: v.trialDays,
        fees: fees.filter((f) => f.planVersionId === v.id).map((f) => this.feeDto(f)),
        features: catalog.map((c) => {
          const pf = feats.find((f) => f.planVersionId === v.id && f.featureKey === c.key);
          return { key: c.key, name: c.name, kind: c.kind as 'BOOLEAN' | 'LIMIT', enabled: !!pf?.enabled, limitValue: pf?.limitValue ?? null };
        }),
      }));
  }

  /** Everything for the admin editor: all plans (incl. archived), every version with fees & features, feature list. */
  async adminCatalog(user: JwtPayload) {
    this.staff(user);
    const ps = await this.db.select().from(plans).orderBy(asc(plans.productLine), asc(plans.sortOrder));
    const vs = ps.length ? await this.db.select().from(planVersions).where(inArray(planVersions.planId, ps.map((p) => p.id))).orderBy(desc(planVersions.version)) : [];
    const { fees, feats } = await this.versionDetail(vs.map((v) => v.id));
    const usage = vs.length ? await this.db.select({ planVersionId: merchantContracts.planVersionId }).from(merchantContracts).where(inArray(merchantContracts.planVersionId, vs.map((v) => v.id))) : [];
    const catalog = await this.db.select().from(features).orderBy(asc(features.sortOrder));
    const setting = await this.requireApproval();
    return {
      requireSecondApprover: setting,
      features: catalog,
      plans: ps.map((p) => ({
        ...p,
        versions: vs
          .filter((v) => v.planId === p.id)
          .map((v) => ({
            ...v,
            contracts: usage.filter((u) => u.planVersionId === v.id).length,
            fees: fees.filter((f) => f.planVersionId === v.id).map((f) => ({ id: f.id, ...this.feeDto(f) })),
            features: feats.filter((f) => f.planVersionId === v.id).map((f) => ({ key: f.featureKey, enabled: f.enabled, limitValue: f.limitValue })),
          })),
      })),
    };
  }

  /** The currently published version of a plan, with fees and features; used when issuing an Order Form. */
  async publishedVersion(code: string, tx: DbOrTx = this.db) {
    const [p] = await tx.select().from(plans).where(eq(plans.code, code)).limit(1);
    if (!p || p.isArchived) throw new NotFoundException('Unknown or archived plan');
    const [v] = await tx.select().from(planVersions).where(and(eq(planVersions.planId, p.id), eq(planVersions.status, 'PUBLISHED'))).limit(1);
    if (!v) throw new BadRequestException(`${p.name} has no published version`);
    const { fees, feats } = await this.versionDetail([v.id], tx);
    return {
      plan: p,
      version: v,
      fees: fees.map((f) => this.feeDto(f)),
      features: Object.fromEntries(feats.map((f) => [f.featureKey, f.limitValue ?? f.enabled])) as Record<string, boolean | number>,
    };
  }

  // ───── plan CRUD ─────

  async createPlan(user: JwtPayload, input: { code: string; name: string; productLine: string; tagline?: string; description?: string; isPublic?: boolean; highlight?: boolean; sortOrder?: number }) {
    this.staff(user);
    const code = input.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const [dupe] = await this.db.select({ id: plans.id }).from(plans).where(eq(plans.code, code)).limit(1);
    if (dupe) throw new BadRequestException('A plan with that code already exists');
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(plans).values({ ...input, code }).returning();
      await tx.insert(planVersions).values({ planId: p.id, version: 1, status: 'DRAFT' });
      await this.audit.log({ actorId: user.sub, action: 'plan.create', entityType: 'plan', entityId: p.id, after: p }, tx);
      return p;
    });
  }

  async updatePlan(user: JwtPayload, planId: string, input: Partial<{ name: string; productLine: string; tagline: string | null; description: string | null; isPublic: boolean; isArchived: boolean; highlight: boolean; sortOrder: number }>) {
    this.staff(user);
    const [before] = await this.db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (!before) throw new NotFoundException();
    const [p] = await this.db.update(plans).set(input).where(eq(plans.id, planId)).returning();
    await this.audit.log({ actorId: user.sub, action: 'plan.update', entityType: 'plan', entityId: planId, before, after: p });
    return p;
  }

  // ───── versions ─────

  /** New draft copied from the latest version (or empty). Only one draft per plan at a time. */
  async createDraft(user: JwtPayload, planId: string) {
    this.staff(user);
    const vs = await this.db.select().from(planVersions).where(eq(planVersions.planId, planId)).orderBy(desc(planVersions.version));
    if (!vs.length) {
      const [p] = await this.db.select({ id: plans.id }).from(plans).where(eq(plans.id, planId)).limit(1);
      if (!p) throw new NotFoundException();
    }
    if (vs.some((v) => v.status === 'DRAFT')) throw new BadRequestException('This plan already has a draft version');
    const base = vs.find((v) => v.status === 'PUBLISHED') || vs[0];
    return this.db.transaction(async (tx) => {
      const [d] = await tx
        .insert(planVersions)
        .values({ planId, version: (vs[0]?.version || 0) + 1, status: 'DRAFT', subscriptionCents: base?.subscriptionCents ?? 0, interval: base?.interval ?? 'MONTH', perLocation: base?.perLocation ?? true, setupFeeCents: base?.setupFeeCents ?? 0, trialDays: base?.trialDays ?? 0 })
        .returning();
      if (base) {
        const { fees, feats } = await this.versionDetail([base.id], tx);
        if (fees.length) await tx.insert(planFees).values(fees.map(({ id: _id, planVersionId: _v, ...f }) => ({ ...f, planVersionId: d.id })));
        if (feats.length) await tx.insert(planFeatures).values(feats.map((f) => ({ ...f, planVersionId: d.id })));
      }
      await this.audit.log({ actorId: user.sub, action: 'plan.version.draft', entityType: 'plan_version', entityId: d.id, after: { planId, version: d.version, copiedFrom: base?.version ?? null } }, tx);
      return d;
    });
  }

  async updateDraft(user: JwtPayload, versionId: string, input: VersionInput) {
    this.staff(user);
    const [v] = await this.db.select().from(planVersions).where(eq(planVersions.id, versionId)).limit(1);
    if (!v) throw new NotFoundException();
    if (v.status !== 'DRAFT') throw new BadRequestException('Only draft versions can be edited. Create a new draft to change a published plan.');
    if (input.features?.length) {
      const known = await this.db.select({ key: features.key }).from(features).where(inArray(features.key, input.features.map((f) => f.key)));
      const missing = input.features.map((f) => f.key).filter((k) => !known.some((x) => x.key === k));
      if (missing.length) throw new BadRequestException(`Unknown features: ${missing.join(', ')}`);
    }
    return this.db.transaction(async (tx) => {
      const { fees, features: feats, ...scalars } = input;
      const [row] = Object.keys(scalars).length ? await tx.update(planVersions).set(scalars).where(eq(planVersions.id, versionId)).returning() : [v];
      if (fees) {
        await tx.delete(planFees).where(eq(planFees.planVersionId, versionId));
        if (fees.length) await tx.insert(planFees).values(fees.map((f, i) => ({ planVersionId: versionId, type: f.type, channel: f.channel, fulfillment: f.fulfillment, bps: f.bps || 0, cents: f.cents || 0, capCents: f.capCents ?? null, label: f.label || null, sortOrder: i })));
      }
      if (feats) {
        await tx.delete(planFeatures).where(eq(planFeatures.planVersionId, versionId));
        const on = feats.filter((f) => f.enabled || f.limitValue != null);
        if (on.length) await tx.insert(planFeatures).values(on.map((f) => ({ planVersionId: versionId, featureKey: f.key, enabled: f.enabled, limitValue: f.limitValue ?? null })));
      }
      return row;
    });
  }

  async deleteDraft(user: JwtPayload, versionId: string) {
    this.staff(user);
    const [v] = await this.db.select().from(planVersions).where(eq(planVersions.id, versionId)).limit(1);
    if (!v) throw new NotFoundException();
    if (v.status !== 'DRAFT') throw new BadRequestException('Only drafts can be deleted');
    await this.db.delete(planVersions).where(eq(planVersions.id, versionId));
    return { ok: true };
  }

  private async requireApproval() {
    const [s] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, 'approvals.plan_publish')).limit(1);
    return s?.value === true;
  }

  /**
   * Publish a draft: it becomes the version new Order Forms use; the previous published version is retired.
   * Merchants already on the old version keep their signed terms.
   */
  async publish(user: JwtPayload, versionId: string, approverEmail?: string) {
    this.staff(user);
    const [v] = await this.db.select().from(planVersions).where(eq(planVersions.id, versionId)).limit(1);
    if (!v) throw new NotFoundException();
    if (v.status !== 'DRAFT') throw new BadRequestException('Only drafts can be published');
    const { fees } = await this.versionDetail([v.id]);
    if (!fees.length && v.subscriptionCents === 0) throw new BadRequestException('Add a price or at least one fee rule before publishing');
    let approvedById: string | null = null;
    if (await this.requireApproval()) {
      if (!approverEmail) throw new BadRequestException('Publishing a plan needs a second platform admin to approve. Enter their email.');
      const [a] = await this.db.select().from(users).where(eq(users.email, approverEmail.toLowerCase())).limit(1);
      if (!a || !a.roles.includes('PLATFORM_ADMIN') || a.id === user.sub) throw new ForbiddenException('Approver must be a different platform admin');
      approvedById = a.id;
    }
    return this.db.transaction(async (tx) => {
      const [prev] = await tx.select().from(planVersions).where(and(eq(planVersions.planId, v.planId), eq(planVersions.status, 'PUBLISHED'))).limit(1);
      if (prev) await tx.update(planVersions).set({ status: 'RETIRED' }).where(eq(planVersions.id, prev.id));
      const [row] = await tx.update(planVersions).set({ status: 'PUBLISHED', publishedAt: new Date(), publishedById: user.sub, approvedById }).where(eq(planVersions.id, versionId)).returning();
      await this.audit.configChange({ key: `plan:${v.planId}`, before: prev ? { version: prev.version } : null, after: { version: row.version, subscriptionCents: row.subscriptionCents, fees: fees.map((f) => this.feeDto(f)) }, actorId: user.sub, approvedById }, tx);
      return row;
    });
  }

  // ───── features ─────

  async upsertFeature(user: JwtPayload, input: { key: string; name: string; description?: string | null; kind?: 'BOOLEAN' | 'LIMIT'; productLine?: string; sortOrder?: number; isActive?: boolean }) {
    this.staff(user);
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const [row] = await this.db
      .insert(features)
      .values({ ...input, key })
      .onConflictDoUpdate({ target: features.key, set: { name: input.name, description: input.description ?? null, kind: input.kind, productLine: input.productLine, sortOrder: input.sortOrder, isActive: input.isActive } })
      .returning();
    await this.audit.log({ actorId: user.sub, action: 'feature.upsert', entityType: 'feature', entityId: key, after: row });
    return row;
  }
}
