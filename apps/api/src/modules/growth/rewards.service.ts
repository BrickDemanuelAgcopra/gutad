import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { DEFAULT_REFERRAL_RULES, TEST_CARDS, type ReferralRules } from '@gutad/shared';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { challengeProgress, challenges, locations, loyaltyEntries, orders, referrals, users } from '../../db/schema';
import { assertCan, assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import { SettingsService } from '../../core/settings.service';
import { addDays } from '../../common/utils';
import { PaymentsService } from '../payments/payments.service';

type Order = typeof orders.$inferSelect;
const rows = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));
export const referralCode = (userId: string) => userId.slice(0, 8).toUpperCase();

/** 25.5 referrals and 25.6 reward challenges. Both advance when an order completes. */
@Injectable()
export class RewardsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private rules() {
    return this.settings.getObject<ReferralRules>('growth.referrals', DEFAULT_REFERRAL_RULES);
  }

  // ───── 25.5 referrals ─────

  /** The referee enters a code. Nothing is paid yet: both sides are rewarded after the referee's first completed order. */
  async apply(refereeId: string, code: string) {
    const c = code.trim().toLowerCase();
    const [ref] = await this.db.select().from(users).where(sql`left(${users.id}::text, 8) = ${c}`).limit(1);
    if (!ref || ref.id === refereeId) throw new BadRequestException('Invalid referral code');
    const [done] = await this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, refereeId), eq(orders.status, 'COMPLETED')));
    if (done.n > 0) throw new BadRequestException({ message: 'Referral codes are for new customers before their first order', code: 'REFERRAL_NOT_NEW' });
    const [existing] = await this.db.select().from(referrals).where(eq(referrals.refereeId, refereeId)).limit(1);
    if (existing) throw new BadRequestException({ message: 'A referral code is already on your account', code: 'REFERRAL_EXISTS' });
    const r = await this.rules();
    const [row] = await this.db.insert(referrals).values({ referrerId: ref.id, refereeId, code: c.toUpperCase(), rewardPoints: r.rewardPoints }).returning();
    return { status: row.status, rewardPoints: row.rewardPoints, message: `You and ${ref.name?.split(' ')[0] || 'your friend'} each get ${row.rewardPoints} points after your first order is completed.` };
  }

  async mine(userId: string) {
    const sent = await this.db.select({ r: referrals, name: users.name }).from(referrals).innerJoin(users, eq(users.id, referrals.refereeId)).where(eq(referrals.referrerId, userId)).orderBy(desc(referrals.createdAt)).limit(100);
    const [received] = await this.db.select().from(referrals).where(eq(referrals.refereeId, userId)).limit(1);
    return {
      code: referralCode(userId),
      received: received ? { status: received.status, rewardPoints: received.rewardPoints } : null,
      referred: sent.map(({ r, name }) => ({ id: r.id, friend: name ? `${name.split(' ')[0]} ${name.split(' ')[1]?.[0] || ''}`.trim() : 'A friend', status: r.status, rewardPoints: r.rewardPoints, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
      earnedPoints: sent.filter((x) => x.r.status === 'REWARDED').reduce((a, x) => a + x.r.rewardPoints, 0),
    };
  }

  /** Same device (push token), card or delivery address on both accounts. */
  async signals(referrerId: string, refereeId: string, tx: DbOrTx = this.db) {
    const out: { kind: 'DEVICE' | 'PAYMENT' | 'ADDRESS'; detail: string }[] = [];
    const dev = rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from users a, users b where a.id = ${referrerId} and b.id = ${refereeId} and a.push_tokens && b.push_tokens`));
    const dev2 = rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from device_sessions a join device_sessions b on a.device_id = b.device_id where a.user_id = ${referrerId} and b.user_id = ${refereeId}`));
    if ((dev[0]?.n || 0) + (dev2[0]?.n || 0) > 0) out.push({ kind: 'DEVICE', detail: 'Both accounts used the same phone' });
    // shared processor token, or the same card details (brand, last 4, expiry); the mock processor's public test tokens don't count
    const test = sql.join(TEST_CARDS.map((c) => sql`${c.token}`), sql`, `);
    const pay = rows<{ brand: string | null; last4: string | null }>(await tx.execute(sql`select a.brand, a.last4 from payment_methods a join payment_methods b on ((a.provider_ref = b.provider_ref and a.provider_ref not in (${test})) or (a.last4 = b.last4 and coalesce(a.brand,'') = coalesce(b.brand,'') and a.exp_month = b.exp_month and a.exp_year = b.exp_year)) where a.user_id = ${referrerId} and b.user_id = ${refereeId} limit 1`));
    const payOrders = rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from payments a join payments b on a.payment_method_id = b.payment_method_id where a.user_id = ${referrerId} and b.user_id = ${refereeId} and a.payment_method_id is not null and a.payment_method_id not in (${test})`));
    if (pay.length || (payOrders[0]?.n || 0) > 0) out.push({ kind: 'PAYMENT', detail: pay[0]?.last4 ? `Same card ${pay[0].brand || ''} •••• ${pay[0].last4}`.trim() : 'Same card' });
    const norm = (col: string) => sql.raw(`lower(regexp_replace(${col}, '[^a-zA-Z0-9]', '', 'g'))`);
    const addr = rows<{ n: number }>(await tx.execute(sql`
      with a as (select ${norm('line1')} || ${norm('postal_code')} k from addresses where user_id = ${referrerId}
                 union select ${norm("delivery_address->>'line1'")} || ${norm("coalesce(delivery_address->>'postalCode','')")} from orders where user_id = ${referrerId} and delivery_address is not null),
           b as (select ${norm('line1')} || ${norm('postal_code')} k from addresses where user_id = ${refereeId}
                 union select ${norm("delivery_address->>'line1'")} || ${norm("coalesce(delivery_address->>'postalCode','')")} from orders where user_id = ${refereeId} and delivery_address is not null)
      select count(*)::int as n from a join b on a.k = b.k where length(a.k) > 4`));
    if ((addr[0]?.n || 0) > 0) out.push({ kind: 'ADDRESS', detail: 'Same delivery address' });
    return out;
  }

  private async reward(r: typeof referrals.$inferSelect, tx: DbOrTx, reviewerId?: string | null, note?: string) {
    await tx.insert(loyaltyEntries).values({ userId: r.refereeId, kind: 'REFERRAL', points: r.rewardPoints, cents: r.rewardPoints, orderId: r.qualifyingOrderId, expiresAt: addDays(new Date(), 365) });
    await tx.insert(loyaltyEntries).values({ userId: r.referrerId, kind: 'REFERRAL', points: r.rewardPoints, cents: r.rewardPoints, orderId: r.qualifyingOrderId, expiresAt: addDays(new Date(), 365) });
    await tx.update(referrals).set({ status: 'REWARDED', rewardedAt: new Date(), reviewedById: reviewerId ?? null, reviewNote: note ?? null }).where(eq(referrals.id, r.id));
    await this.outbox.publish('referral.rewarded', `${r.id}:referrer`, { userId: r.referrerId, points: r.rewardPoints }, tx);
    await this.outbox.publish('referral.rewarded', `${r.id}:referee`, { userId: r.refereeId, points: r.rewardPoints }, tx);
  }

  private async onReferral(o: Order, tx: DbOrTx) {
    const [r] = await tx.select().from(referrals).where(and(eq(referrals.refereeId, o.userId!), eq(referrals.status, 'PENDING'))).limit(1);
    if (!r) return;
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, o.userId!), eq(orders.status, 'COMPLETED')));
    if (n > 1) return; // only the first completed order qualifies
    const signals = await this.signals(r.referrerId, r.refereeId, tx);
    await tx.update(referrals).set({ qualifyingOrderId: o.id, signals }).where(eq(referrals.id, r.id));
    const rules = await this.rules();
    if (signals.length && rules.reviewOnSignals) {
      await tx.update(referrals).set({ status: 'REVIEW' }).where(eq(referrals.id, r.id));
      await this.audit.log({ actorId: null, action: 'referral.review', entityType: 'referral', entityId: r.id, after: { signals } }, tx);
      return;
    }
    await this.reward({ ...r, qualifyingOrderId: o.id }, tx);
  }

  async reviewQueue(user: JwtPayload, status = 'REVIEW') {
    assertCan(user, 'growth.read', 'customers.read');
    const list = await this.db.execute(sql`select r.*, a.email as referrer_email, a.name as referrer_name, b.email as referee_email, b.name as referee_name from referrals r join users a on a.id = r.referrer_id join users b on b.id = r.referee_id where r.status = ${status} order by r.created_at desc limit 200`);
    const [stats] = rows<Record<string, number>>(await this.db.execute(sql`select count(*) filter (where status='PENDING')::int as pending, count(*) filter (where status='REVIEW')::int as review, count(*) filter (where status='REWARDED')::int as rewarded, count(*) filter (where status='REJECTED')::int as rejected from referrals`));
    return { stats, items: rows<Record<string, unknown>>(list) };
  }

  async decide(user: JwtPayload, id: string, approve: boolean, note: string) {
    assertCan(user, 'growth.manage');
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(referrals).where(eq(referrals.id, id)).for('update').limit(1);
      if (!r) throw new NotFoundException();
      if (r.status !== 'REVIEW') throw new BadRequestException(`Referral is ${r.status}`);
      if (approve) await this.reward(r, tx, user.sub, note);
      else await tx.update(referrals).set({ status: 'REJECTED', reviewedById: user.sub, reviewNote: note }).where(eq(referrals.id, id));
      await this.audit.log({ actorId: user.sub, action: approve ? 'referral.approve' : 'referral.reject', entityType: 'referral', entityId: id, after: { signals: r.signals }, reason: note }, tx);
      return { id, status: approve ? 'REWARDED' : 'REJECTED' };
    });
  }

  // ───── 25.6 reward challenges ─────

  async upsertChallenge(user: JwtPayload, input: { id?: string; organizationId?: string | null; name: string; description?: string; goalOrders: number; windowDays: number; minSubtotalCents?: number; locationIds?: string[]; rewardCents: number; rewardExpiresDays?: number; maxCompletions?: number; startsAt?: Date | null; endsAt?: Date | null; isActive?: boolean }) {
    const orgId = input.organizationId ?? null;
    if (orgId) assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    else assertCan(user, 'growth.manage');
    if (input.id) {
      const [before] = await this.db.select().from(challenges).where(eq(challenges.id, input.id)).limit(1);
      if (!before) throw new NotFoundException();
      if (before.organizationId !== orgId) throw new ForbiddenException('Challenge belongs to another owner');
    }
    let locationIds = input.locationIds || [];
    if (orgId && locationIds.length) {
      const own = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
      locationIds = locationIds.filter((l) => own.some((o) => o.id === l));
    }
    const v = { organizationId: orgId, name: input.name, description: input.description ?? null, goalOrders: input.goalOrders, windowDays: input.windowDays, minSubtotalCents: input.minSubtotalCents || 0, locationIds, rewardCents: input.rewardCents, rewardExpiresDays: input.rewardExpiresDays ?? 30, maxCompletions: input.maxCompletions ?? 1, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, isActive: input.isActive ?? true };
    const [row] = input.id ? await this.db.update(challenges).set(v).where(eq(challenges.id, input.id)).returning() : await this.db.insert(challenges).values({ ...v, createdById: user.sub }).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'challenge.save', entityType: 'challenge', entityId: row.id, after: row });
    return row;
  }

  async listChallenges(user: JwtPayload, orgId?: string) {
    if (orgId) assertOrgAccess(user, orgId);
    else assertCan(user, 'growth.read');
    const list = await this.db.select().from(challenges).where(orgId ? eq(challenges.organizationId, orgId) : undefined).orderBy(desc(challenges.createdAt));
    const ids = list.map((c) => c.id);
    const stats = ids.length ? rows<{ challenge_id: string; active: number; completed: number }>(await this.db.execute(sql`select challenge_id, count(*) filter (where status='ACTIVE' and window_end > now())::int as active, count(*) filter (where status='COMPLETED')::int as completed from challenge_progress where challenge_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) group by 1`)) : [];
    return list.map((c) => ({ ...c, active: stats.find((s) => s.challenge_id === c.id)?.active || 0, completed: stats.find((s) => s.challenge_id === c.id)?.completed || 0, rewardsIssuedCents: (stats.find((s) => s.challenge_id === c.id)?.completed || 0) * c.rewardCents }));
  }

  private live(now: Date) {
    return and(eq(challenges.isActive, true), or(isNull(challenges.startsAt), lte(challenges.startsAt, now)), or(isNull(challenges.endsAt), gt(challenges.endsAt, now)));
  }

  /** Challenges a customer can see, with their progress in the current window. */
  async myChallenges(userId: string) {
    const now = new Date();
    const list = await this.db.select().from(challenges).where(this.live(now)).orderBy(challenges.endsAt);
    const prog = await this.db.select().from(challengeProgress).where(eq(challengeProgress.userId, userId)).orderBy(desc(challengeProgress.createdAt));
    const orgNames = list.some((c) => c.organizationId) ? rows<{ id: string; name: string }>(await this.db.execute(sql`select id, name from organizations where id in (${sql.join([...new Set(list.map((c) => c.organizationId).filter(Boolean))].map((i) => sql`${i}`), sql`, `)})`)) : [];
    return {
      active: list.map((c) => {
        const p = prog.find((x) => x.challengeId === c.id && x.status === 'ACTIVE' && x.windowEnd > now);
        const done = prog.filter((x) => x.challengeId === c.id && x.status === 'COMPLETED').length;
        return { id: c.id, name: c.name, description: c.description, merchant: orgNames.find((o) => o.id === c.organizationId)?.name ?? null, goalOrders: c.goalOrders, windowDays: c.windowDays, rewardCents: c.rewardCents, rewardExpiresDays: c.rewardExpiresDays, minSubtotalCents: c.minSubtotalCents, endsAt: c.endsAt, progress: p ? p.count : 0, windowEnd: p?.windowEnd ?? null, completions: done, available: !c.maxCompletions || done < c.maxCompletions };
      }),
      history: prog.filter((p) => p.status !== 'ACTIVE' || p.windowEnd <= now).slice(0, 20).map((p) => ({ id: p.id, challenge: list.find((c) => c.id === p.challengeId)?.name ?? 'Challenge', status: p.status === 'ACTIVE' ? 'EXPIRED' : p.status, count: p.count, completedAt: p.completedAt, windowEnd: p.windowEnd })),
    };
  }

  private async onChallenges(o: Order, tx: DbOrTx) {
    const now = new Date();
    const live = await tx.select().from(challenges).where(and(this.live(now), or(isNull(challenges.organizationId), eq(challenges.organizationId, o.organizationId))));
    for (const c of live) {
      if (c.locationIds.length && !c.locationIds.includes(o.locationId)) continue;
      if (o.subtotalCents - o.discountCents < c.minSubtotalCents) continue;
      const mine = await tx.select().from(challengeProgress).where(and(eq(challengeProgress.challengeId, c.id), eq(challengeProgress.userId, o.userId!))).orderBy(desc(challengeProgress.createdAt));
      if (mine.some((p) => p.orderIds.includes(o.id))) continue; // already counted
      const completions = mine.filter((p) => p.status === 'COMPLETED').length;
      if (c.maxCompletions && completions >= c.maxCompletions) continue;
      let p = mine.find((x) => x.status === 'ACTIVE');
      if (p && p.windowEnd <= now) {
        await tx.update(challengeProgress).set({ status: 'EXPIRED' }).where(eq(challengeProgress.id, p.id));
        p = undefined;
      }
      if (!p) [p] = await tx.insert(challengeProgress).values({ challengeId: c.id, userId: o.userId!, windowStart: now, windowEnd: addDays(now, c.windowDays) }).returning();
      const count = p.count + 1;
      if (count >= c.goalOrders) {
        const credit = await this.payments.issueCredit({ userId: o.userId!, cents: c.rewardCents, reason: `Challenge complete: ${c.name}`, funder: c.organizationId ? 'MERCHANT' : 'PLATFORM', organizationId: c.organizationId, expiresInDays: c.rewardExpiresDays }, tx);
        await tx.update(challengeProgress).set({ count, orderIds: [...p.orderIds, o.id], status: 'COMPLETED', completedAt: now, creditId: credit.id }).where(eq(challengeProgress.id, p.id));
        await this.outbox.publish('challenge.completed', p.id, { userId: o.userId, name: c.name, rewardCents: c.rewardCents, expiresInDays: c.rewardExpiresDays }, tx);
      } else {
        await tx.update(challengeProgress).set({ count, orderIds: [...p.orderIds, o.id] }).where(eq(challengeProgress.id, p.id));
      }
    }
  }

  /** Expire windows that ran out (daily). */
  async expireWindows(now = new Date()) {
    const r = await this.db.update(challengeProgress).set({ status: 'EXPIRED' }).where(and(eq(challengeProgress.status, 'ACTIVE'), lte(challengeProgress.windowEnd, now))).returning({ id: challengeProgress.id });
    return r.length;
  }

  async onOrderCompleted(o: Order, tx: DbOrTx) {
    if (!o.userId) return;
    await this.onReferral(o, tx);
    await this.onChallenges(o, tx);
  }

  /** Staff view of a customer's referral and challenge state (customer 360). */
  async forCustomer(user: JwtPayload, userId: string) {
    assertCan(user, 'customers.read', 'growth.read');
    const prog = await this.db.select({ p: challengeProgress, name: challenges.name }).from(challengeProgress).innerJoin(challenges, eq(challenges.id, challengeProgress.challengeId)).where(eq(challengeProgress.userId, userId)).orderBy(desc(challengeProgress.createdAt)).limit(20);
    const refs = await this.db.select().from(referrals).where(or(eq(referrals.referrerId, userId), eq(referrals.refereeId, userId)));
    return { challenges: prog.map((x) => ({ ...x.p, name: x.name })), referrals: refs };
  }
}
