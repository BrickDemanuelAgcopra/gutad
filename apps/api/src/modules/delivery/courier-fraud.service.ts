import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { DEFAULT_FRAUD, RISK_SIGNAL_LABELS, type FraudConfig, type FraudDecision, type RiskSignalType } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { courierCampaigns, courierFraudCases, courierRecords, courierRiskSignals, deliveryEvents, deliveryJobs, driverEarnings, drivers, opsAlerts, orders, storedFiles, users } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { LedgerService } from '../../core/ledger.service';
import { SettingsService } from '../../core/settings.service';
import { haversineKm } from '../../common/utils';
import { storedFileId, viewableUrl } from './file-links';

type Job = typeof deliveryJobs.$inferSelect;
/** digits of the phone on the courier profile, else the account phone (7+ digits) */
const phoneOf = (r: { d: { onboarding: unknown }; phone: string | null }) => {
  const p = ((r.d.onboarding as { profile?: { phone?: string } } | null)?.profile?.phone || r.phone || '').replace(/\D/g, '');
  return p.length >= 7 ? p.slice(-10) : null;
};
type Driver = typeof drivers.$inferSelect;
const DAY = 86_400_000;

/**
 * Courier R3 fraud review. Signals are raised at the event (location, delivery, payout setup) or by the hourly pattern
 * sweep. Open signals over the window add up to a score; past the review threshold a case opens, past the hold threshold
 * the courier's payouts wait until staff decide.
 */
@Injectable()
export class CourierFraudService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  cfg() { return this.settings.getObject<FraudConfig>('delivery.fraud', DEFAULT_FRAUD); }

  // ───── raising signals ─────

  /** Record a signal once (by dedupe key) and re-score the courier. Returns the signal when it is new. */
  async raise(driverId: string, type: RiskSignalType, opts: { dedupeKey: string; jobId?: string | null; data?: Record<string, unknown>; by?: string | null }, tx: DbOrTx = this.db) {
    const cfg = await this.cfg();
    const weight = cfg.weights[type] ?? DEFAULT_FRAUD.weights[type] ?? 10;
    const [s] = await tx.insert(courierRiskSignals).values({ driverId, type, weight, deliveryJobId: opts.jobId ?? null, data: opts.data ?? {}, dedupeKey: opts.dedupeKey, createdById: opts.by ?? null }).onConflictDoNothing().returning();
    if (s) await this.evaluate(driverId, tx, cfg);
    return s ?? null;
  }

  /** Score = open signal weights in the window. Opens (or updates) the case and the payout hold. */
  async evaluate(driverId: string, tx: DbOrTx = this.db, cfg?: FraudConfig) {
    cfg ??= await this.cfg();
    const since = new Date(Date.now() - cfg.windowDays * DAY);
    const open = await tx.select().from(courierRiskSignals).where(and(eq(courierRiskSignals.driverId, driverId), eq(courierRiskSignals.status, 'OPEN'), gte(courierRiskSignals.createdAt, since)));
    const score = open.reduce((s, x) => s + x.weight, 0);
    const [existing] = await tx.select().from(courierFraudCases).where(and(eq(courierFraudCases.driverId, driverId), eq(courierFraudCases.status, 'OPEN'))).limit(1);
    if (!existing && score < cfg.reviewThreshold) return { score, caseId: null };
    const hold = score >= cfg.holdThreshold;
    let c = existing;
    if (c) {
      [c] = await tx.update(courierFraudCases).set({ score, holdActive: c.holdActive || hold }).where(eq(courierFraudCases.id, c.id)).returning();
    } else {
      [c] = await tx.insert(courierFraudCases).values({ driverId, score, holdActive: hold, openedAt: new Date() }).onConflictDoNothing().returning();
      if (!c) [c] = await tx.select().from(courierFraudCases).where(and(eq(courierFraudCases.driverId, driverId), eq(courierFraudCases.status, 'OPEN'))).limit(1);
      const [d] = await tx.select({ name: users.name }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, driverId)).limit(1);
      await tx.insert(opsAlerts).values({ type: 'COURIER_FRAUD', severity: hold ? 'HIGH' : 'MEDIUM', title: `Courier fraud review: ${d?.name ?? 'courier'}`, detail: `Risk score ${score}. ${hold ? 'Payouts are on hold until a decision.' : 'Review the signals.'}`, subjectType: 'driver', subjectId: driverId, dedupeKey: `fraud:${c.id}`, ownerRole: 'DISPATCHER', escalateAt: new Date(Date.now() + 24 * 3600_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: `score ${score}` }] }).onConflictDoNothing();
    }
    await tx.update(courierRiskSignals).set({ caseId: c.id }).where(and(eq(courierRiskSignals.driverId, driverId), eq(courierRiskSignals.status, 'OPEN'), isNull(courierRiskSignals.caseId)));
    return { score, caseId: c.id };
  }

  /** True while an open case holds the courier's payouts. */
  async holdFor(driverId: string, tx: DbOrTx = this.db): Promise<boolean> {
    const [c] = await tx.select({ id: courierFraudCases.id }).from(courierFraudCases).where(and(eq(courierFraudCases.driverId, driverId), eq(courierFraudCases.status, 'OPEN'), eq(courierFraudCases.holdActive, true))).limit(1);
    return !!c;
  }

  /** GPS_JUMP: the move since the previous ping implies an impossible speed. */
  async onLocation(d: Driver, lat: number, lng: number, at = new Date()) {
    if (d.lastLat == null || d.lastLng == null || !d.lastSeenAt) return null;
    const hours = (at.getTime() - d.lastSeenAt.getTime()) / 3600_000;
    if (hours <= 0 || hours > 1) return null;
    const km = haversineKm(d.lastLat, d.lastLng, lat, lng);
    const cfg = await this.cfg();
    const speed = km / Math.max(hours, 1 / 3600);
    if (km < 1 || speed <= cfg.maxSpeedKmh) return null;
    return this.raise(d.id, 'GPS_JUMP', { dedupeKey: `gps:${d.id}:${Math.floor(at.getTime() / 600_000)}`, data: { from: { lat: d.lastLat, lng: d.lastLng, at: d.lastSeenAt }, to: { lat, lng, at }, km: Math.round(km * 10) / 10, kmh: Math.round(speed) } });
  }

  /** DROPOFF_FAR and PROOF_REUSED at handoff. */
  async onDelivered(job: Job, driverId: string, pos: { lat?: number | null; lng?: number | null }, tx: DbOrTx) {
    const cfg = await this.cfg();
    const drop = job.dropoffAddress as { lat?: number; lng?: number };
    if (pos.lat != null && pos.lng != null && drop.lat != null && drop.lng != null) {
      const m = haversineKm(pos.lat, pos.lng, drop.lat, drop.lng) * 1000;
      if (m > cfg.dropoffFarMeters) await this.raise(driverId, 'DROPOFF_FAR', { dedupeKey: `far:${job.id}`, jobId: job.id, data: { meters: Math.round(m), at: { lat: pos.lat, lng: pos.lng }, dropoff: { lat: drop.lat, lng: drop.lng } } }, tx);
    }
    if (job.proofPhotoUrl) {
      const fid = storedFileId(job.proofPhotoUrl);
      const [f] = fid ? await tx.select().from(storedFiles).where(eq(storedFiles.id, fid)).limit(1) : [];
      const twins = f ? (await tx.select({ id: storedFiles.id }).from(storedFiles).where(and(eq(storedFiles.sha256, f.sha256), ne(storedFiles.id, f.id)))).map((x) => x.id) : [];
      const urls = [job.proofPhotoUrl, ...twins.map((id) => `/files/${id}`)];
      const others = await tx.select({ id: deliveryJobs.id, driverId: deliveryJobs.driverId }).from(deliveryJobs).where(and(ne(deliveryJobs.id, job.id), inArray(deliveryJobs.proofPhotoUrl, urls))).limit(5);
      if (others.length) await this.raise(driverId, 'PROOF_REUSED', { dedupeKey: `proof:${job.id}`, jobId: job.id, data: { otherJobs: others.map((o) => o.id), sameFile: others.length > 0 } }, tx);
    }
  }

  /** SHARED_PAYOUT / SHARED_PHONE: another courier with the same payout account (or holder + last 4) or phone. */
  async checkShared(driverId: string, tx: DbOrTx = this.db) {
    const [me] = await tx.select({ d: drivers, phone: users.phone }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, driverId)).limit(1);
    if (!me) return [];
    const raised: string[] = [];
    const pay = (me.d.onboarding as { payout?: { accountHolder?: string; accountLast4?: string } } | null)?.payout;
    const holder = pay?.accountHolder?.trim().toLowerCase().replace(/\s+/g, ' ');
    const others = await tx.select({ d: drivers, phone: users.phone }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(ne(drivers.id, driverId));
    for (const o of others) {
      const op = (o.d.onboarding as { payout?: { accountHolder?: string; accountLast4?: string } } | null)?.payout;
      const sameAcct = (me.d.payoutAccountId && me.d.payoutAccountId === o.d.payoutAccountId) || (holder && pay?.accountLast4 && op?.accountLast4 === pay.accountLast4 && op?.accountHolder?.trim().toLowerCase().replace(/\s+/g, ' ') === holder);
      const pair = [driverId, o.d.id].sort().join(':');
      if (sameAcct) {
        for (const [a, b] of [[driverId, o.d.id], [o.d.id, driverId]]) if (await this.raise(a, 'SHARED_PAYOUT', { dedupeKey: `sharedpay:${pair}:${a}`, data: { otherDriverId: b, accountLast4: pay?.accountLast4 ?? null } }, tx)) raised.push(a);
      }
      const myPhone = phoneOf(me), theirPhone = phoneOf(o);
      if (myPhone && theirPhone && myPhone === theirPhone) {
        for (const [a, b] of [[driverId, o.d.id], [o.d.id, driverId]]) if (await this.raise(a, 'SHARED_PHONE', { dedupeKey: `sharedphone:${pair}:${a}`, data: { otherDriverId: b } }, tx)) raised.push(a);
      }
    }
    return raised;
  }

  /** Hourly: patterns that need a window of history. */
  async patternSweep(now = new Date()) {
    const week = new Date(now.getTime() - 7 * DAY);
    const day = now.toISOString().slice(0, 10);
    const out: Record<string, number> = { release: 0, unreachable: 0, collusion: 0, gaming: 0 };
    // releases after arriving at the pickup
    const rel = await this.db.select({ driverId: sql<string>`${deliveryEvents.data}->>'driverId'`, n: sql<number>`count(*)::int` }).from(deliveryEvents).where(and(eq(deliveryEvents.type, 'DRIVER_RELEASED'), gte(deliveryEvents.createdAt, week), sql`(${deliveryEvents.data}->>'arrived')::boolean is true`)).groupBy(sql`${deliveryEvents.data}->>'driverId'`);
    for (const r of rel) if (r.driverId && r.n >= 3 && (await this.raise(r.driverId, 'RELEASE_PATTERN', { dedupeKey: `release:${r.driverId}:${day}`, data: { releases: r.n, days: 7 } }))) out.release++;
    // customer-unreachable returns
    const unr = await this.db.select({ driverId: deliveryJobs.driverId, n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.status, 'RETURNED'), isNotNull(deliveryJobs.driverId), gte(deliveryJobs.updatedAt, week), sql`${deliveryJobs.exception}->>'kind' = 'CUSTOMER_UNREACHABLE'`)).groupBy(deliveryJobs.driverId);
    for (const r of unr) if (r.driverId && r.n >= 3 && (await this.raise(r.driverId, 'UNREACHABLE_PATTERN', { dedupeKey: `unreach:${r.driverId}:${day}`, data: { returns: r.n, days: 7 } }))) out.unreachable++;
    // the same customer and courier again and again, with unusual tips
    const since14 = new Date(now.getTime() - 14 * DAY);
    const delivered = await this.db.select({ driverId: deliveryJobs.driverId, customerId: orders.userId, tip: deliveryJobs.tipCents }).from(deliveryJobs).innerJoin(orders, eq(orders.id, deliveryJobs.orderId)).where(and(eq(deliveryJobs.status, 'DELIVERED'), eq(deliveryJobs.fleet, 'PLATFORM'), gte(deliveryJobs.deliveredAt, since14)));
    const tips = delivered.map((x) => x.tip).sort((a, b) => a - b);
    const median = tips.length ? tips[Math.floor(tips.length / 2)] : 0;
    const limit = Math.max(2 * median, 200);
    const pairs = new Map<string, { driverId: string; customerId: string; n: number; tips: number }>();
    for (const x of delivered) {
      if (!x.driverId || !x.customerId) continue;
      const k = `${x.driverId}:${x.customerId}`;
      const p = pairs.get(k) ?? { driverId: x.driverId, customerId: x.customerId, n: 0, tips: 0 };
      p.n++; p.tips += x.tip;
      pairs.set(k, p);
    }
    for (const p of pairs.values()) if (p.n >= 4 && p.tips / p.n > limit && (await this.raise(p.driverId, 'COLLUSION', { dedupeKey: `collusion:${p.driverId}:${p.customerId}:${day}`, data: { customerId: p.customerId, deliveries: p.n, avgTipCents: Math.round(p.tips / p.n), medianTipCents: median } }))) out.collusion++;
    // incentive gaming: quest deliveries handed over within 2 minutes of pickup
    const quests = await this.db.select().from(courierCampaigns).where(and(eq(courierCampaigns.kind, 'QUEST'), inArray(courierCampaigns.status, ['ACTIVE', 'ENDED']), gte(courierCampaigns.windowEnd, week)));
    for (const q of quests) {
      const fast = await this.db.select({ driverId: deliveryJobs.driverId, n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(eq(deliveryJobs.status, 'DELIVERED'), isNotNull(deliveryJobs.driverId), gte(deliveryJobs.deliveredAt, q.windowStart), sql`${deliveryJobs.deliveredAt} <= ${q.windowEnd}`, sql`${deliveryJobs.deliveredAt} - ${deliveryJobs.pickedUpAt} < interval '2 minutes'`)).groupBy(deliveryJobs.driverId);
      for (const r of fast) if (r.driverId && r.n >= 3 && (await this.raise(r.driverId, 'INCENTIVE_GAMING', { dedupeKey: `gaming:${q.id}:${r.driverId}`, data: { campaignId: q.id, campaign: q.name, fastDeliveries: r.n } }))) out.gaming++;
    }
    return out;
  }

  // ───── staff ─────

  async manual(user: JwtPayload, driverId: string, b: { type: RiskSignalType; note: string }) {
    assertCan(user, 'delivery.manage');
    const [d] = await this.db.select({ id: drivers.id }).from(drivers).where(eq(drivers.id, driverId)).limit(1);
    if (!d) throw new NotFoundException();
    const s = await this.raise(driverId, b.type, { dedupeKey: `manual:${globalThis.crypto.randomUUID()}`, data: { note: b.note }, by: user.sub });
    await this.audit.log({ actorId: user.sub, action: 'courier.risk_signal', entityType: 'driver', entityId: driverId, after: { type: b.type }, reason: b.note });
    return { signal: s, score: (await this.evaluate(driverId)).score };
  }

  async cases(user: JwtPayload, status = 'OPEN') {
    assertCan(user, 'delivery.read', 'ops.read');
    const rows = await this.db.select({ c: courierFraudCases, name: users.name }).from(courierFraudCases).innerJoin(drivers, eq(drivers.id, courierFraudCases.driverId)).innerJoin(users, eq(users.id, drivers.userId)).where(status === 'ALL' ? undefined : eq(courierFraudCases.status, status)).orderBy(desc(courierFraudCases.score), desc(courierFraudCases.openedAt)).limit(200);
    const ids = rows.map((r) => r.c.id);
    const sigs = ids.length ? await this.db.select({ caseId: courierRiskSignals.caseId, type: courierRiskSignals.type, weight: courierRiskSignals.weight }).from(courierRiskSignals).where(inArray(courierRiskSignals.caseId, ids)) : [];
    return rows.map(({ c, name }) => {
      const mine = sigs.filter((s) => s.caseId === c.id);
      const byType = new Map<string, number>();
      for (const s of mine) byType.set(s.type, (byType.get(s.type) ?? 0) + s.weight);
      return { id: c.id, driverId: c.driverId, driverName: name, score: c.score, status: c.status, holdActive: c.holdActive, decision: c.decision, openedAt: c.openedAt, decidedAt: c.decidedAt, topSignals: [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([type, weight]) => ({ type, label: RISK_SIGNAL_LABELS[type as RiskSignalType] ?? type, weight })) };
    });
  }

  async caseDetail(user: JwtPayload, id: string) {
    assertCan(user, 'delivery.read', 'ops.read');
    const [c] = await this.db.select().from(courierFraudCases).where(eq(courierFraudCases.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    const [d] = await this.db.select({ d: drivers, name: users.name, email: users.email, phone: users.phone }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(eq(drivers.id, c.driverId)).limit(1);
    const signals = await this.db.select().from(courierRiskSignals).where(eq(courierRiskSignals.driverId, c.driverId)).orderBy(desc(courierRiskSignals.createdAt)).limit(100);
    const jobIds = Array.from(new Set(signals.flatMap((s) => [s.deliveryJobId, ...(((s.data as { otherJobs?: string[] }).otherJobs) ?? [])]).filter((x): x is string => !!x)));
    const jobs = jobIds.length ? await this.db.select({ id: deliveryJobs.id, status: deliveryJobs.status, orderNumber: orders.number, dropoff: deliveryJobs.dropoffAddress, deliveredAt: deliveryJobs.deliveredAt, proofPhotoUrl: deliveryJobs.proofPhotoUrl }).from(deliveryJobs).leftJoin(orders, eq(orders.id, deliveryJobs.orderId)).where(inArray(deliveryJobs.id, jobIds)) : [];
    const linkedIds = Array.from(new Set(signals.map((s) => (s.data as { otherDriverId?: string }).otherDriverId).filter((x): x is string => !!x)));
    const linked = linkedIds.length ? await this.db.select({ id: drivers.id, name: users.name, lifecycleStatus: drivers.lifecycleStatus }).from(drivers).innerJoin(users, eq(users.id, drivers.userId)).where(inArray(drivers.id, linkedIds)) : [];
    const held = c.holdActive ? await this.db.select().from(driverEarnings).where(and(eq(driverEarnings.driverId, c.driverId), gte(driverEarnings.createdAt, new Date(Date.now() - 30 * DAY)))).orderBy(desc(driverEarnings.createdAt)).limit(100) : [];
    const earnings = c.holdActive ? held : await this.db.select().from(driverEarnings).where(eq(driverEarnings.driverId, c.driverId)).orderBy(desc(driverEarnings.createdAt)).limit(30);
    return {
      case: c,
      courier: d ? { id: d.d.id, name: d.name, email: d.email, phone: d.phone, lifecycleStatus: d.d.lifecycleStatus, ratingAvg: d.d.ratingAvg, firstDeliveryAt: d.d.firstDeliveryAt, vehicleType: d.d.vehicleType } : null,
      payableCents: await this.ledger.balance('DRIVER_PAYABLE', c.driverId),
      signals: signals.map((s) => ({ ...s, label: RISK_SIGNAL_LABELS[s.type as RiskSignalType] ?? s.type })),
      jobs: await Promise.all(jobs.map(async (j) => ({ ...j, proofUrl: j.proofPhotoUrl ? await viewableUrl(j.proofPhotoUrl) : null, proofPhotoUrl: undefined }))),
      linkedCouriers: linked,
      earnings: earnings.map((e) => ({ id: e.id, kind: e.kind, deliveryJobId: e.deliveryJobId, totalCents: e.baseCents + e.distanceCents + e.timeCents + e.waitingCents + e.returnCents + e.tipCents + e.bonusCents, createdAt: e.createdAt, reason: e.reason })),
    };
  }

  async decide(user: JwtPayload, id: string, b: { decision: FraudDecision; reason: string; noticeToCourier: string; clawbackEarningIds?: string[] }) {
    assertCan(user, 'delivery.manage');
    const [c] = await this.db.select().from(courierFraudCases).where(eq(courierFraudCases.id, id)).limit(1);
    if (!c) throw new NotFoundException();
    if (c.status !== 'OPEN') throw new ConflictException('This case is already decided');
    if (b.decision === 'CLAWBACK' && !b.clawbackEarningIds?.length) throw new BadRequestException('Choose the earnings to claw back');
    const result = await this.db.transaction(async (tx) => {
      let clawedCents = 0;
      if (b.decision === 'CLAWBACK') {
        const rows = await tx.select().from(driverEarnings).where(and(eq(driverEarnings.driverId, c.driverId), inArray(driverEarnings.id, b.clawbackEarningIds!)));
        for (const e of rows) {
          const amt = e.baseCents + e.distanceCents + e.timeCents + e.waitingCents + e.returnCents + e.bonusCents; // tips stay with the courier
          if (amt <= 0) continue;
          await tx.insert(driverEarnings).values({ driverId: c.driverId, deliveryJobId: e.deliveryJobId, baseCents: 0, bonusCents: -amt, kind: 'DEDUCTION', reason: `Clawback after review: ${b.reason}`, createdById: user.sub });
          await this.ledger.post({ currency: 'USD' }, [{ account: 'DRIVER_PAYABLE', partyId: c.driverId, debitCents: amt, memo: `Clawback ${e.id}` }, { account: 'PLATFORM_EXPENSE_DELIVERY_SUBSIDY', creditCents: amt, memo: `Courier clawback: ${b.reason}` }], tx);
          clawedCents += amt;
        }
      }
      await tx.update(courierRiskSignals).set({ status: b.decision === 'CLEAR' ? 'DISMISSED' : 'CONFIRMED' }).where(and(eq(courierRiskSignals.driverId, c.driverId), eq(courierRiskSignals.status, 'OPEN')));
      const [u] = await tx.update(courierFraudCases).set({ status: 'DECIDED', decision: b.decision, reason: b.reason, notice: b.noticeToCourier, holdActive: false, decidedById: user.sub, decidedAt: new Date() }).where(eq(courierFraudCases.id, id)).returning();
      await tx.insert(courierRecords).values({ driverId: c.driverId, kind: 'INCIDENT', title: `Account review: ${b.decision.toLowerCase()}`, detail: b.noticeToCourier, createdById: user.sub });
      await tx.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date() }).where(eq(opsAlerts.dedupeKey, `fraud:${id}`));
      await this.audit.log({ actorId: user.sub, action: 'courier.fraud_decision', entityType: 'courier_fraud_case', entityId: id, before: { score: c.score, holdActive: c.holdActive }, after: { decision: b.decision, clawedCents }, reason: b.reason }, tx);
      return { ...u, clawedCents };
    });
    if (b.decision === 'RESTRICT' || b.decision === 'SUSPEND') {
      const { CourierService } = await import('./courier.service');
      await this.moduleRef.get(CourierService, { strict: false }).setLifecycle(user, c.driverId, b.decision === 'RESTRICT' ? 'RESTRICTED' : 'SUSPENDED', b.reason);
    }
    return result;
  }

  /** What a courier sees: decisions and warnings, never the signal internals. */
  async notices(driverId: string) {
    const decided = await this.db.select({ decision: courierFraudCases.decision, notice: courierFraudCases.notice, decidedAt: courierFraudCases.decidedAt }).from(courierFraudCases).where(and(eq(courierFraudCases.driverId, driverId), eq(courierFraudCases.status, 'DECIDED'), isNotNull(courierFraudCases.notice))).orderBy(desc(courierFraudCases.decidedAt)).limit(20);
    const hold = await this.holdFor(driverId);
    return { hold, holdMessage: hold ? 'Your payouts are paused while we review recent account activity. Deliveries and earnings continue as normal.' : null, notices: decided };
  }

  /** Risk score for the courier page. */
  async scoreFor(driverId: string) {
    const cfg = await this.cfg();
    const since = new Date(Date.now() - cfg.windowDays * DAY);
    const [r] = await this.db.select({ s: sql<number>`coalesce(sum(${courierRiskSignals.weight}),0)::int` }).from(courierRiskSignals).where(and(eq(courierRiskSignals.driverId, driverId), eq(courierRiskSignals.status, 'OPEN'), gte(courierRiskSignals.createdAt, since)));
    const [c] = await this.db.select().from(courierFraudCases).where(and(eq(courierFraudCases.driverId, driverId), eq(courierFraudCases.status, 'OPEN'))).limit(1);
    return { score: r.s, reviewThreshold: cfg.reviewThreshold, holdThreshold: cfg.holdThreshold, openCaseId: c?.id ?? null, holdActive: !!c?.holdActive };
  }
}
