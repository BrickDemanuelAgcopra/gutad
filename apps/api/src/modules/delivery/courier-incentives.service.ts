import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { boostCents, guaranteeTopUp, questPayout, type CampaignEligibility, type CampaignKind, type CampaignRules } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { courierCampaignEnrolments, courierCampaigns, courierTimeEntries, deliveryJobs, deliveryZones, driverEarnings, drivers, regions, users } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';

type Campaign = typeof courierCampaigns.$inferSelect;
type Driver = typeof drivers.$inferSelect;
type Job = typeof deliveryJobs.$inferSelect;
export interface OfferIncentive { campaignId: string; name: string; cents: number }

export interface CampaignInput {
  kind: CampaignKind;
  name: string;
  description?: string | null;
  marketIds?: string[];
  zoneIds?: string[];
  windowStart: string;
  windowEnd: string;
  rules: CampaignRules;
  eligibility?: CampaignEligibility;
  enrolment?: 'AUTO' | 'OPT_IN';
  budgetCents: number;
  reason?: string;
}

/**
 * Courier R3 incentive campaigns. BOOST adds pay to each matching delivery (shown on the offer, paid with the delivery);
 * QUEST and GUARANTEE settle once when the window ends. Every payment is an INCENTIVE earning, unique per job+campaign
 * or courier+campaign, and stays inside the campaign budget.
 */
@Injectable()
export class CourierIncentivesService {
  constructor(@Inject(DB) private readonly db: Db, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  private validate(i: Partial<CampaignInput>, kind: CampaignKind) {
    const r = i.rules ?? {};
    if (kind === 'BOOST' && !((r.boostCents ?? 0) > 0 || (r.boostPercent ?? 0) > 0)) throw new BadRequestException('A boost needs an amount or a percentage');
    if (kind === 'QUEST' && !(r.tiers?.length && r.tiers.every((t) => t.deliveries > 0 && t.bonusCents > 0))) throw new BadRequestException('A quest needs at least one tier (deliveries and bonus)');
    if (kind === 'GUARANTEE' && !((r.minPerHourCents ?? 0) > 0)) throw new BadRequestException('A guarantee needs a minimum per hour');
    if (i.windowStart && i.windowEnd && new Date(i.windowEnd) <= new Date(i.windowStart)) throw new BadRequestException('The window must end after it starts');
  }

  private matchesJob(c: Campaign, job: { zoneId: string | null; marketId: string | null }) {
    if (c.zoneIds.length && (!job.zoneId || !c.zoneIds.includes(job.zoneId))) return false;
    if (c.marketIds.length && (!job.marketId || !c.marketIds.includes(job.marketId))) return false;
    return true;
  }

  /** Why a courier can't take part, or null when they can. */
  ineligible(c: Campaign, d: Driver): string | null {
    const e = (c.eligibility ?? {}) as CampaignEligibility;
    if (d.lifecycleStatus !== 'ACTIVE') return 'Your account must be active';
    if (e.minRating != null && d.ratingAvg != null && d.ratingCount >= 5 && d.ratingAvg < e.minRating) return `Needs a rating of ${e.minRating} or more`;
    if (e.vehicleTypes?.length && !e.vehicleTypes.includes(d.vehicleType)) return `For ${e.vehicleTypes.map((v) => v.toLowerCase()).join(', ')} couriers`;
    if (e.minDeliveries != null && e.minDeliveries > 0 && !d.firstDeliveryAt) return `Needs ${e.minDeliveries} completed deliveries`;
    return null;
  }

  private async enrolled(c: Campaign, driverId: string, tx: DbOrTx) {
    if (c.enrolment === 'AUTO') return true;
    const [e] = await tx.select({ id: courierCampaignEnrolments.id }).from(courierCampaignEnrolments).where(and(eq(courierCampaignEnrolments.campaignId, c.id), eq(courierCampaignEnrolments.driverId, driverId))).limit(1);
    return !!e;
  }

  /** BOOSTs that apply to this job and courier now (shown on the offer, kept in the accepted pay snapshot). */
  async offerBoosts(job: Pick<Job, 'zoneId' | 'marketId'>, d: Driver, payCents: number, tx: DbOrTx = this.db, at = new Date()): Promise<OfferIncentive[]> {
    const live = await tx.select().from(courierCampaigns).where(and(eq(courierCampaigns.kind, 'BOOST'), eq(courierCampaigns.status, 'ACTIVE'), lte(courierCampaigns.windowStart, at), gte(courierCampaigns.windowEnd, at)));
    const out: OfferIncentive[] = [];
    for (const c of live) {
      if (!this.matchesJob(c, job) || this.ineligible(c, d) || !(await this.enrolled(c, d.id, tx))) continue;
      const cents = boostCents(c.rules as CampaignRules, payCents);
      if (cents > 0 && c.spentCents + cents <= c.budgetCents) out.push({ campaignId: c.id, name: c.name, cents });
    }
    return out;
  }

  /** Spend from the budget atomically; false once it would go over. */
  private async spend(campaignId: string, cents: number, tx: DbOrTx) {
    const [u] = await tx.update(courierCampaigns).set({ spentCents: sql`${courierCampaigns.spentCents} + ${cents}` }).where(and(eq(courierCampaigns.id, campaignId), sql`${courierCampaigns.spentCents} + ${cents} <= ${courierCampaigns.budgetCents}`)).returning({ id: courierCampaigns.id });
    return !!u;
  }

  private async pay(driverId: string, c: { id: string; name: string }, cents: number, opts: { jobId?: string | null; orderId?: string | null; detail?: Record<string, unknown> }, tx: DbOrTx) {
    if (cents <= 0) return null;
    const [e] = await tx.insert(driverEarnings).values({ driverId, deliveryJobId: opts.jobId ?? null, campaignId: c.id, baseCents: 0, bonusCents: cents, kind: 'INCENTIVE', reason: c.name, availableAt: new Date(), detail: { campaignId: c.id, campaign: c.name, ...(opts.detail ?? {}) } }).onConflictDoNothing().returning();
    if (!e) return null;
    if (!(await this.spend(c.id, cents, tx))) {
      await tx.delete(driverEarnings).where(eq(driverEarnings.id, e.id));
      return null;
    }
    await this.ledger.post({ orderId: opts.orderId ?? null, currency: 'USD' }, [
      { account: 'PLATFORM_EXPENSE_COURIER_INCENTIVE', debitCents: cents, memo: `Incentive: ${c.name}` },
      { account: 'DRIVER_PAYABLE', partyId: driverId, creditCents: cents, memo: `Incentive: ${c.name}` },
    ], tx);
    return e;
  }

  /** Pay the BOOSTs recorded on the accepted offer once the delivery is completed. */
  async payBoosts(job: Job, tx: DbOrTx) {
    if (!job.driverId) return [];
    const snap = (job.payPolicy ?? {}) as { incentives?: OfferIncentive[] };
    const paid = [];
    for (const i of snap.incentives ?? []) {
      const e = await this.pay(job.driverId, { id: i.campaignId, name: i.name }, i.cents, { jobId: job.id, orderId: job.orderId }, tx);
      if (e) paid.push(e);
    }
    return paid;
  }

  // ───── window settlement ─────

  /** Every 15 minutes: start and end campaigns, settle ended quests and guarantees. */
  async sweep(now = new Date()) {
    const started = await this.db.update(courierCampaigns).set({ status: 'ACTIVE' }).where(and(eq(courierCampaigns.status, 'SCHEDULED'), lte(courierCampaigns.windowStart, now), gte(courierCampaigns.windowEnd, now))).returning({ id: courierCampaigns.id });
    const ended = await this.db.update(courierCampaigns).set({ status: 'ENDED' }).where(and(inArray(courierCampaigns.status, ['SCHEDULED', 'ACTIVE']), lte(courierCampaigns.windowEnd, now))).returning({ id: courierCampaigns.id });
    const due = await this.db.select().from(courierCampaigns).where(and(eq(courierCampaigns.status, 'ENDED'), isNull(courierCampaigns.settledAt), inArray(courierCampaigns.kind, ['QUEST', 'GUARANTEE'])));
    let paidCents = 0;
    for (const c of due) paidCents += await this.settle(c);
    return { started: started.length, ended: ended.length, settled: due.length, paidCents };
  }

  /** Deliveries in the window per courier, filtered to the campaign's zones/markets. */
  private async deliveriesIn(c: Campaign, driverId?: string) {
    const rows = await this.db.select({ id: deliveryJobs.id, driverId: deliveryJobs.driverId, zoneId: deliveryJobs.zoneId, marketId: deliveryJobs.marketId }).from(deliveryJobs).where(and(eq(deliveryJobs.status, 'DELIVERED'), eq(deliveryJobs.fleet, 'PLATFORM'), gte(deliveryJobs.deliveredAt, c.windowStart), lte(deliveryJobs.deliveredAt, c.windowEnd), ...(driverId ? [eq(deliveryJobs.driverId, driverId)] : [])));
    return rows.filter((r) => r.driverId && this.matchesJob(c, r));
  }

  /** Online minutes in the window (breaks excluded). */
  private async onlineMinutes(driverId: string, from: Date, to: Date) {
    const rows = await this.db.select().from(courierTimeEntries).where(and(eq(courierTimeEntries.driverId, driverId), lte(courierTimeEntries.startedAt, to), or(isNull(courierTimeEntries.endedAt), gte(courierTimeEntries.endedAt, from))));
    const overlap = (s: Date, e: Date | null) => Math.max(0, (Math.min((e ?? new Date()).getTime(), to.getTime()) - Math.max(s.getTime(), from.getTime())) / 60_000);
    const online = rows.filter((r) => r.kind === 'ONLINE').reduce((t, r) => t + overlap(r.startedAt, r.endedAt), 0);
    const brk = rows.filter((r) => r.kind === 'BREAK').reduce((t, r) => t + overlap(r.startedAt, r.endedAt), 0);
    return Math.round(Math.max(0, online - brk) * 10) / 10;
  }

  /** Earnings in the window without tips or incentives (what a guarantee tops up). */
  private async earnedIn(driverId: string, c: Campaign) {
    const jobIds = (await this.deliveriesIn(c, driverId)).map((j) => j.id);
    if (!jobIds.length) return 0;
    const [r] = await this.db.select({ s: sql<number>`coalesce(sum(${driverEarnings.baseCents} + ${driverEarnings.distanceCents} + ${driverEarnings.timeCents} + ${driverEarnings.waitingCents} + ${driverEarnings.returnCents}),0)::int` }).from(driverEarnings).where(and(eq(driverEarnings.driverId, driverId), inArray(driverEarnings.deliveryJobId, jobIds), inArray(driverEarnings.kind, ['DELIVERY', 'CANCEL_COMP'])));
    return r.s;
  }

  /** Candidates: enrolled couriers (opt-in) or anyone who delivered / was online in the window (auto). */
  private async participants(c: Campaign): Promise<Driver[]> {
    let ids: string[];
    if (c.enrolment === 'OPT_IN') ids = (await this.db.select({ d: courierCampaignEnrolments.driverId }).from(courierCampaignEnrolments).where(eq(courierCampaignEnrolments.campaignId, c.id))).map((x) => x.d);
    else if (c.kind === 'GUARANTEE') ids = (await this.db.selectDistinct({ d: courierTimeEntries.driverId }).from(courierTimeEntries).where(and(eq(courierTimeEntries.kind, 'ONLINE'), lte(courierTimeEntries.startedAt, c.windowEnd), or(isNull(courierTimeEntries.endedAt), gte(courierTimeEntries.endedAt, c.windowStart))))).map((x) => x.d);
    else ids = Array.from(new Set((await this.deliveriesIn(c)).map((j) => j.driverId!)));
    return ids.length ? this.db.select().from(drivers).where(inArray(drivers.id, ids)) : [];
  }

  async progress(c: Campaign, d: Driver) {
    const deliveries = (await this.deliveriesIn(c, d.id)).length;
    if (c.kind === 'QUEST') {
      const q = questPayout(c.rules as CampaignRules, deliveries);
      return { deliveries, onlineMinutes: null, earnedCents: null, targetDeliveries: q.next?.deliveries ?? q.reached, nextTier: q.next, estimatedPayoutCents: q.bonusCents };
    }
    if (c.kind === 'GUARANTEE') {
      const end = new Date(Math.min(Date.now(), c.windowEnd.getTime()));
      const onlineMinutes = await this.onlineMinutes(d.id, c.windowStart, end);
      const earnedCents = await this.earnedIn(d.id, c);
      return { deliveries, onlineMinutes, earnedCents, targetDeliveries: null, nextTier: null, estimatedPayoutCents: guaranteeTopUp(c.rules as CampaignRules, onlineMinutes, earnedCents) };
    }
    const [r] = await this.db.select({ s: sql<number>`coalesce(sum(${driverEarnings.bonusCents}),0)::int` }).from(driverEarnings).where(and(eq(driverEarnings.driverId, d.id), eq(driverEarnings.campaignId, c.id)));
    return { deliveries, onlineMinutes: null, earnedCents: r.s, targetDeliveries: null, nextTier: null, estimatedPayoutCents: r.s };
  }

  /** Pay a QUEST or GUARANTEE once (unique earning per courier+campaign). Returns cents paid. */
  async settle(c: Campaign) {
    let total = 0;
    for (const d of await this.participants(c)) {
      if (this.ineligible({ ...c }, { ...d, lifecycleStatus: d.lifecycleStatus === 'RESTRICTED' ? 'ACTIVE' : d.lifecycleStatus })) continue;
      const p = await this.progress(c, d);
      const due = p.estimatedPayoutCents;
      await this.db.transaction(async (tx) => {
        const [fresh] = await tx.select({ spent: courierCampaigns.spentCents, budget: courierCampaigns.budgetCents }).from(courierCampaigns).where(eq(courierCampaigns.id, c.id));
        const cents = Math.min(due, Math.max(0, fresh.budget - fresh.spent));
        const e = cents > 0 ? await this.pay(d.id, c, cents, { detail: { deliveries: p.deliveries, onlineMinutes: p.onlineMinutes, earnedCents: p.earnedCents, cappedByBudget: cents < due } }, tx) : null;
        if (e) total += cents;
        await tx.insert(courierCampaignEnrolments).values({ campaignId: c.id, driverId: d.id, joinedAt: c.windowStart, settledAt: new Date(), payoutCents: e ? cents : 0 }).onConflictDoUpdate({ target: [courierCampaignEnrolments.campaignId, courierCampaignEnrolments.driverId], set: { settledAt: new Date(), payoutCents: sql`coalesce(${courierCampaignEnrolments.payoutCents}, 0) + ${e ? cents : 0}` } });
      });
    }
    await this.db.update(courierCampaigns).set({ settledAt: new Date() }).where(eq(courierCampaigns.id, c.id));
    return total;
  }

  // ───── courier ─────

  async forCourier(d: Driver) {
    const now = new Date();
    const rows = await this.db.select().from(courierCampaigns).where(or(and(inArray(courierCampaigns.status, ['SCHEDULED', 'ACTIVE']), gte(courierCampaigns.windowEnd, now)), and(eq(courierCampaigns.status, 'ENDED'), gte(courierCampaigns.windowEnd, new Date(now.getTime() - 7 * 86_400_000))))).orderBy(courierCampaigns.windowStart);
    const zoneIds = Array.from(new Set(rows.flatMap((c) => c.zoneIds)));
    const zones = zoneIds.length ? new Map((await this.db.select({ id: deliveryZones.id, name: deliveryZones.name }).from(deliveryZones).where(inArray(deliveryZones.id, zoneIds))).map((z) => [z.id, z.name])) : new Map<string, string>();
    const mine = new Set((await this.db.select({ c: courierCampaignEnrolments.campaignId }).from(courierCampaignEnrolments).where(eq(courierCampaignEnrolments.driverId, d.id))).map((x) => x.c));
    const out = [];
    for (const c of rows) {
      // a zone-bound campaign is shown to couriers who work there (or anywhere)
      if (c.zoneIds.length && d.zoneIds.length && !c.zoneIds.some((z) => d.zoneIds.includes(z))) continue;
      const enrolled = c.enrolment === 'AUTO' || mine.has(c.id);
      const why = this.ineligible(c, d);
      out.push({
        id: c.id, kind: c.kind, name: c.name, description: c.description, status: c.status, windowStart: c.windowStart, windowEnd: c.windowEnd,
        zones: c.zoneIds.map((id) => ({ id, name: zones.get(id) ?? 'Zone' })), terms: this.terms(c), enrolment: c.enrolment, enrolled, eligible: !why, ineligibleReason: why,
        budgetLeft: c.spentCents < c.budgetCents,
        progress: enrolled && c.status !== 'SCHEDULED' ? await this.progress(c, d) : null,
      });
    }
    return out;
  }

  terms(c: Campaign): string {
    const r = c.rules as CampaignRules;
    const $ = (x: number) => `$${(x / 100).toFixed(2)}`;
    if (c.kind === 'BOOST') return [r.boostCents ? `+${$(r.boostCents)}` : null, r.boostPercent ? `+${r.boostPercent}%` : null].filter(Boolean).join(' and ') + ' on every delivery in the window';
    if (c.kind === 'QUEST') return (r.tiers ?? []).map((t) => `${t.deliveries} deliveries → ${$(t.bonusCents)}`).join(' · ');
    return `At least ${$(r.minPerHourCents ?? 0)} per online hour (tips not counted, min ${r.minOnlineMinutes ?? 60} min online); the difference is paid after the window`;
  }

  async join(d: Driver, id: string) {
    const [c] = await this.db.select().from(courierCampaigns).where(eq(courierCampaigns.id, id)).limit(1);
    if (!c || !['SCHEDULED', 'ACTIVE'].includes(c.status)) throw new NotFoundException('This campaign is not open');
    const why = this.ineligible(c, d);
    if (why) throw new ConflictException({ message: why, code: 'NOT_ELIGIBLE', reason: why });
    const [e] = await this.db.insert(courierCampaignEnrolments).values({ campaignId: c.id, driverId: d.id, joinedAt: new Date() }).onConflictDoNothing().returning();
    return e ?? (await this.db.select().from(courierCampaignEnrolments).where(and(eq(courierCampaignEnrolments.campaignId, c.id), eq(courierCampaignEnrolments.driverId, d.id))))[0];
  }

  // ───── admin ─────

  async list(user: JwtPayload, status?: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const rows = await this.db.select().from(courierCampaigns).where(status ? eq(courierCampaigns.status, status) : undefined).orderBy(desc(courierCampaigns.windowStart)).limit(200);
    return rows.map((c) => ({ ...c, terms: this.terms(c) }));
  }

  async detail(user: JwtPayload, id: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const [c] = await this.db.select().from(courierCampaigns).where(eq(courierCampaigns.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    const paid = await this.db.select({ driverId: driverEarnings.driverId, cents: sql<number>`sum(${driverEarnings.bonusCents})::int`, n: sql<number>`count(*)::int` }).from(driverEarnings).where(eq(driverEarnings.campaignId, id)).groupBy(driverEarnings.driverId);
    const enrolled = await this.db.select({ driverId: courierCampaignEnrolments.driverId }).from(courierCampaignEnrolments).where(eq(courierCampaignEnrolments.campaignId, id));
    const ids = Array.from(new Set([...paid.map((p) => p.driverId), ...enrolled.map((e) => e.driverId)]));
    const names = ids.length ? new Map((await this.db.select({ id: drivers.id, name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(inArray(drivers.id, ids))).map((x) => [x.id, x.name])) : new Map<string, string>();
    const regionNames = c.marketIds.length ? (await this.db.select({ id: regions.id, name: regions.name }).from(regions).where(inArray(regions.id, c.marketIds))) : [];
    const zoneNames = c.zoneIds.length ? (await this.db.select({ id: deliveryZones.id, name: deliveryZones.name }).from(deliveryZones).where(inArray(deliveryZones.id, c.zoneIds))) : [];
    return {
      ...c, terms: this.terms(c), markets: regionNames, zones: zoneNames, enrolled: enrolled.length,
      participants: ids.map((driverId) => { const p = paid.find((x) => x.driverId === driverId); return { driverId, name: names.get(driverId) ?? '—', payments: p?.n ?? 0, earnedCents: p?.cents ?? 0 }; }).sort((a, b) => b.earnedCents - a.earnedCents),
    };
  }

  async create(user: JwtPayload, i: CampaignInput) {
    assertCan(user, 'delivery.manage');
    this.validate(i, i.kind);
    const [c] = await this.db.insert(courierCampaigns).values({ kind: i.kind, name: i.name, description: i.description ?? null, marketIds: i.marketIds ?? [], zoneIds: i.zoneIds ?? [], windowStart: new Date(i.windowStart), windowEnd: new Date(i.windowEnd), rules: i.rules, eligibility: i.eligibility ?? {}, enrolment: i.enrolment ?? 'AUTO', budgetCents: i.budgetCents, createdById: user.sub }).returning();
    await this.audit.log({ actorId: user.sub, action: 'courier_campaign.create', entityType: 'courier_campaign', entityId: c.id, after: c, reason: i.reason ?? null });
    return c;
  }

  async update(user: JwtPayload, id: string, i: Partial<CampaignInput> & { reason: string }) {
    assertCan(user, 'delivery.manage');
    const [c] = await this.db.select().from(courierCampaigns).where(eq(courierCampaigns.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    if (['ENDED', 'CANCELED'].includes(c.status)) throw new ConflictException('This campaign is over');
    // a running campaign keeps its terms for couriers already working it: only budget, end, name and text can change
    if (c.status === 'ACTIVE' && (i.rules || i.kind || i.zoneIds || i.marketIds || i.windowStart || i.eligibility || i.enrolment)) throw new ConflictException({ message: 'A live campaign can only change its name, description, budget or end time', code: 'CAMPAIGN_LIVE' });
    if (i.budgetCents != null && i.budgetCents < c.spentCents) throw new BadRequestException(`Budget cannot go below what is already spent (${c.spentCents})`);
    this.validate({ rules: i.rules ?? (c.rules as CampaignRules), windowStart: i.windowStart ?? c.windowStart.toISOString(), windowEnd: i.windowEnd ?? c.windowEnd.toISOString() }, (i.kind ?? c.kind) as CampaignKind);
    const [u] = await this.db.update(courierCampaigns).set({
      ...(i.name ? { name: i.name } : {}), ...(i.description !== undefined ? { description: i.description } : {}), ...(i.kind ? { kind: i.kind } : {}),
      ...(i.marketIds ? { marketIds: i.marketIds } : {}), ...(i.zoneIds ? { zoneIds: i.zoneIds } : {}), ...(i.windowStart ? { windowStart: new Date(i.windowStart) } : {}),
      ...(i.windowEnd ? { windowEnd: new Date(i.windowEnd) } : {}), ...(i.rules ? { rules: i.rules } : {}), ...(i.eligibility ? { eligibility: i.eligibility } : {}),
      ...(i.enrolment ? { enrolment: i.enrolment } : {}), ...(i.budgetCents != null ? { budgetCents: i.budgetCents } : {}), version: c.version + 1,
    }).where(eq(courierCampaigns.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'courier_campaign.update', entityType: 'courier_campaign', entityId: id, before: c, after: u, reason: i.reason });
    return u;
  }

  async activate(user: JwtPayload, id: string, reason: string) {
    assertCan(user, 'delivery.manage');
    const [c] = await this.db.select().from(courierCampaigns).where(eq(courierCampaigns.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    if (c.status !== 'DRAFT') throw new ConflictException(`Campaign is ${c.status}`);
    const now = new Date();
    if (c.windowEnd <= now) throw new BadRequestException('The window has already ended');
    const [u] = await this.db.update(courierCampaigns).set({ status: c.windowStart <= now ? 'ACTIVE' : 'SCHEDULED' }).where(eq(courierCampaigns.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'courier_campaign.activate', entityType: 'courier_campaign', entityId: id, after: { status: u.status }, reason });
    return u;
  }

  async cancel(user: JwtPayload, id: string, reason: string) {
    assertCan(user, 'delivery.manage');
    const [u] = await this.db.update(courierCampaigns).set({ status: 'CANCELED' }).where(and(eq(courierCampaigns.id, id), inArray(courierCampaigns.status, ['DRAFT', 'SCHEDULED', 'ACTIVE']))).returning();
    if (!u) throw new ConflictException('Only a draft, scheduled or live campaign can be canceled');
    await this.audit.log({ actorId: user.sub, action: 'courier_campaign.cancel', entityType: 'courier_campaign', entityId: id, after: { status: 'CANCELED' }, reason });
    return u;
  }
}
