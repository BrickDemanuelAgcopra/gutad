import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { cartCompatibility, STAFF_ROLES } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { locations, addresses, consents, customerCredits, customerRestrictions, dataRequests, guestProfiles, incidents, loyaltyEntries, memberSubscriptions, membershipPlans, orders, paymentMethods, platformSegments, refunds, reservations, reviews, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { assertCan, can, JwtPayload } from '../../common/auth';
import { AuthService } from '../auth/auth.service';
import { SupportService } from '../support/support.service';
import { CardSetupService } from '../payments/card-setup.service';

const STAFF = sql.raw(`array[${STAFF_ROLES.map((r) => `'${r}'`).join(',')}]::role[]`);
const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];
const n = (v: unknown) => Number(v || 0);
const mask = (e: string | null) => (e ? e.replace(/^(.).*(@.*)$/, '$1•••$2') : null);
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** gmail-style normalization for duplicate detection: case, dots and +tags. */
const normEmail = (e: string) => { const [u, d] = e.toLowerCase().split('@'); return d === 'gmail.com' || d === 'googlemail.com' ? `${u.split('+')[0].replace(/\./g, '')}@gmail.com` : `${u.split('+')[0]}@${d}`; };
const normPhone = (p: string | null) => (p ? p.replace(/\D/g, '').slice(-10) : null);
export interface SegmentRules { minOrders?: number; minSpendCents?: number; lastOrderWithinDays?: number; lastOrderBeforeDays?: number; hasMembership?: boolean; marketingConsent?: boolean; status?: string; q?: string }
export const NOTIFY_TOPICS = ['orders', 'reservations', 'account', 'marketing'] as const;
export const PRIVACY_DEFAULTS = { deleteGraceDays: 14, guestRetentionDays: 1095 };

/** 10 — customer directory & 360, duplicates & merge, restrictions & appeals, segments, saved cards, notification preferences, privacy. */
@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly auth: AuthService, private readonly support: SupportService, private readonly cardSetup: CardSetupService) {}

  private pii(user: JwtPayload) {
    return can(user, 'customers.pii');
  }

  private filterSql(r: SegmentRules) {
    const parts = [sql`not (u.roles && ${STAFF})`, sql`u.merged_into_id is null`];
    if (r.q) parts.push(sql`(u.email ilike ${'%' + r.q + '%'} or u.name ilike ${'%' + r.q + '%'} or u.phone ilike ${'%' + r.q.replace(/\D/g, '') + '%'} or u.id::text = ${r.q})`);
    if (r.status) parts.push(sql`u.status = ${r.status}`);
    if (r.marketingConsent !== undefined) parts.push(sql`u.marketing_consent = ${r.marketingConsent}`);
    if (r.hasMembership !== undefined) parts.push(r.hasMembership ? sql`exists (select 1 from member_subscriptions ms where ms.user_id = u.id and ms.status = 'ACTIVE')` : sql`not exists (select 1 from member_subscriptions ms where ms.user_id = u.id and ms.status = 'ACTIVE')`);
    const having: ReturnType<typeof sql>[] = [];
    if (r.minOrders) having.push(sql`count(o.id) >= ${r.minOrders}`);
    if (r.minSpendCents) having.push(sql`coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELED','REJECTED')),0) >= ${r.minSpendCents}`);
    if (r.lastOrderWithinDays) having.push(sql`max(o.created_at) > now() - make_interval(days => ${r.lastOrderWithinDays})`);
    if (r.lastOrderBeforeDays) having.push(sql`(max(o.created_at) is null or max(o.created_at) < now() - make_interval(days => ${r.lastOrderBeforeDays}))`);
    return { where: sql.join(parts, sql` and `), having: having.length ? sql`having ${sql.join(having, sql` and `)}` : sql`` };
  }

  /** 11.3 / 11.4 — can an item from `adding` go into a cart at `current`? (Gutad food-hall mixing rule) */
  async cartCheck(current: string, adding: string) {
    const locs = await this.db.select({ id: locations.id, name: locations.name, platformOperated: locations.platformOperated }).from(locations).where(inArray(locations.id, [current, adding].filter(Boolean)));
    const a = locs.find((l) => l.id === current), b = locs.find((l) => l.id === adding);
    if (!b) throw new NotFoundException();
    return cartCompatibility(a ? { locationId: a.id, name: a.name, platformOperated: a.platformOperated } : null, { locationId: b.id, name: b.name, platformOperated: b.platformOperated });
  }

  // ───── 10.1 / 10.6 directory & segments ─────

  async directory(user: JwtPayload, r: SegmentRules & { limit?: number; offset?: number }) {
    assertCan(user, 'customers.read');
    const f = this.filterSql(r);
    const list = rows<Record<string, unknown>>(await this.db.execute(sql`
      select u.id, u.email, u.name, u.phone, u.status, u.is_guest, u.marketing_consent, u.created_at, count(o.id)::int as orders,
        coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELED','REJECTED')),0)::bigint as spend, max(o.created_at) as last_order
      from users u left join orders o on o.user_id = u.id where ${f.where} group by u.id ${f.having} order by max(o.created_at) desc nulls last, u.created_at desc limit ${Math.min(r.limit || 50, 500)} offset ${r.offset || 0}`));
    const [cnt] = rows<{ n: number }>(await this.db.execute(sql`select count(*)::int as n from (select u.id from users u left join orders o on o.user_id = u.id where ${f.where} group by u.id ${f.having}) x`));
    const show = this.pii(user);
    return { total: n(cnt?.n), items: list.map((x) => ({ id: x.id, name: x.name, email: show ? x.email : mask(x.email as string), phone: show ? x.phone : x.phone ? '•••' + String(x.phone).slice(-2) : null, status: x.status, isGuest: x.is_guest, marketingConsent: x.marketing_consent, orders: n(x.orders), spendCents: n(x.spend), lastOrderAt: x.last_order, createdAt: x.created_at })) };
  }

  /** 25.10-P marketing-consented customers in a platform segment (null = all consented customers). */
  async segmentContacts(segmentId: string | null): Promise<{ id: string; email: string | null; phone: string | null }[]> {
    const [seg] = segmentId ? await this.db.select().from(platformSegments).where(eq(platformSegments.id, segmentId)).limit(1) : [null];
    if (segmentId && !seg) return [];
    const f = this.filterSql({ ...((seg?.rules as SegmentRules) || {}), marketingConsent: true });
    return rows<{ id: string; email: string | null; phone: string | null }>(await this.db.execute(sql`select u.id, u.email, u.phone from users u left join orders o on o.user_id = u.id where ${f.where} and u.is_guest = false group by u.id ${f.having} limit 20000`));
  }

  /** 25.2 is this customer in a saved platform segment (offer eligibility)? */
  async inSegment(segmentId: string, userId: string): Promise<boolean> {
    const [seg] = await this.db.select().from(platformSegments).where(eq(platformSegments.id, segmentId)).limit(1);
    if (!seg) return false;
    const f = this.filterSql(seg.rules as SegmentRules);
    const r = rows<{ id: string }>(await this.db.execute(sql`select u.id from users u left join orders o on o.user_id = u.id where ${f.where} and u.id = ${userId} group by u.id ${f.having}`));
    return r.length > 0;
  }

  async segments(user: JwtPayload) {
    assertCan(user, 'customers.read');
    const list = await this.db.select().from(platformSegments).orderBy(platformSegments.name);
    const out = [];
    for (const s of list) out.push({ ...s, size: (await this.directory(user, { ...(s.rules as SegmentRules), limit: 1 })).total });
    return out;
  }

  async upsertSegment(user: JwtPayload, input: { id?: string; name: string; rules: SegmentRules }) {
    assertCan(user, 'growth.manage', 'support.manage');
    const [row] = input.id ? await this.db.update(platformSegments).set({ name: input.name, rules: input.rules }).where(eq(platformSegments.id, input.id)).returning() : await this.db.insert(platformSegments).values({ name: input.name, rules: input.rules, createdById: user.sub }).returning();
    return row;
  }

  async exportSegment(user: JwtPayload, rules: SegmentRules) {
    assertCan(user, 'customers.pii');
    const d = await this.directory(user, { ...rules, limit: 500 });
    await this.audit.log({ actorId: user.sub, action: 'customers.export', entityType: 'segment', entityId: 'export', after: { rules, rows: d.items.length } });
    const head = ['id', 'name', 'email', 'phone', 'status', 'orders', 'spendCents', 'lastOrderAt', 'marketingConsent'];
    return [head.join(','), ...d.items.map((i) => head.map((h) => csvCell(h === 'lastOrderAt' && i.lastOrderAt ? new Date(i.lastOrderAt as string).toISOString() : (i as Record<string, unknown>)[h])).join(','))].join('\n');
  }

  // ───── 10.2 / 10.3 customer 360 ─────

  async profile(user: JwtPayload, id: string) {
    assertCan(user, 'customers.read');
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new NotFoundException();
    const show = this.pii(user);
    const [addrs, cons, ords, incs, refs, credits, loyalty, subs, cards, restr, privacy, resv] = await Promise.all([
      this.db.select().from(addresses).where(eq(addresses.userId, id)),
      this.db.select().from(consents).where(eq(consents.userId, id)).orderBy(desc(consents.createdAt)).limit(20),
      this.db.select({ id: orders.id, number: orders.number, status: orders.status, totalCents: orders.totalCents, createdAt: orders.createdAt, locationId: orders.locationId, channel: orders.channel }).from(orders).where(eq(orders.userId, id)).orderBy(desc(orders.createdAt)).limit(50),
      this.db.select({ i: incidents }).from(incidents).leftJoin(orders, eq(orders.id, incidents.orderId)).where(or(eq(incidents.reporterId, id), eq(orders.userId, id))).orderBy(desc(incidents.createdAt)).limit(50),
      this.db.select({ id: refunds.id, amountCents: refunds.amountCents, reason: refunds.reason, funder: refunds.funder, status: refunds.status, createdAt: refunds.createdAt, orderId: refunds.orderId }).from(refunds).innerJoin(orders, eq(orders.id, refunds.orderId)).where(eq(orders.userId, id)).orderBy(desc(refunds.createdAt)).limit(50),
      this.db.select().from(customerCredits).where(eq(customerCredits.userId, id)).orderBy(desc(customerCredits.createdAt)).limit(50),
      this.db.select({ points: sql<number>`coalesce(sum(${loyaltyEntries.points}),0)::int` }).from(loyaltyEntries).where(eq(loyaltyEntries.userId, id)),
      this.db.select({ s: memberSubscriptions, plan: membershipPlans.name }).from(memberSubscriptions).innerJoin(membershipPlans, eq(membershipPlans.id, memberSubscriptions.planId)).where(eq(memberSubscriptions.userId, id)),
      this.db.select().from(paymentMethods).where(eq(paymentMethods.userId, id)),
      this.db.select().from(customerRestrictions).where(eq(customerRestrictions.userId, id)).orderBy(desc(customerRestrictions.createdAt)),
      this.db.select().from(dataRequests).where(eq(dataRequests.userId, id)).orderBy(desc(dataRequests.createdAt)),
      this.db.select({ id: reservations.id, status: reservations.status, startAt: reservations.startAt, partySize: reservations.partySize }).from(reservations).where(eq(reservations.userId, id)).orderBy(desc(reservations.startAt)).limit(20),
    ]);
    const creditBalance = credits.filter((c) => !c.expiresAt || c.expiresAt > new Date()).reduce((a, c) => a + c.cents - c.redeemedCents, 0);
    if (show) await this.audit.log({ actorId: user.sub, action: 'customer.view_pii', entityType: 'user', entityId: id });
    return {
      customer: { id: u.id, name: u.name, email: show ? u.email : mask(u.email), phone: show ? u.phone : u.phone ? '•••' + u.phone.slice(-2) : null, status: u.status, statusReason: u.statusReason, isGuest: u.isGuest, createdAt: u.createdAt, marketingConsent: u.marketingConsent, smsConsent: u.smsConsent, notificationPrefs: u.notificationPrefs, dietaryNotes: show ? u.dietaryNotes : null, paymentCustomerRef: u.paymentCustomerRef, mergedIntoId: u.mergedIntoId, mfaEnabled: !!u.mfaEnabledAt },
      piiVisible: show,
      addresses: show ? addrs : addrs.map((a) => ({ id: a.id, label: a.label, city: a.city, region: a.region, isDefault: a.isDefault })),
      consents: cons,
      orders: ords,
      stats: { orders: ords.length, spendCents: ords.filter((o) => !['CANCELED', 'REJECTED'].includes(o.status)).reduce((a, o) => a + o.totalCents, 0) },
      incidents: incs.map((x) => x.i),
      refunds: refs,
      credits: { balanceCents: creditBalance, entries: credits },
      loyaltyPoints: loyalty[0]?.points ?? 0,
      memberships: subs.map((s) => ({ ...s.s, planName: s.plan })),
      reservations: resv,
      paymentMethods: cards.map((c) => ({ id: c.id, provider: c.provider, brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, isDefault: c.isDefault })),
      restrictions: restr,
      privacyRequests: privacy,
      goodwill: await this.support.goodwill(id),
      duplicates: await this.duplicates(id),
      devices: await this.devices(id),
    };
  }

  // ───── 10.4 recovery & duplicates ─────

  async duplicates(id: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) return [];
    const ph = normPhone(u.phone);
    const cand = await this.db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone, isGuest: users.isGuest, createdAt: users.createdAt }).from(users).where(and(ne(users.id, id), isNull(users.mergedIntoId), or(sql`split_part(lower(${users.email}), '@', 2) = ${u.email.toLowerCase().split('@')[1]}`, ph ? sql`right(regexp_replace(coalesce(${users.phone}, ''), '\\D', '', 'g'), 10) = ${ph}` : sql`false`))).limit(200);
    const sameAddress = await this.db.execute(sql`select distinct a2.user_id as id from addresses a1 join addresses a2 on lower(a1.line1) = lower(a2.line1) and a1.postal_code = a2.postal_code and a2.user_id <> a1.user_id where a1.user_id = ${id} limit 20`);
    const addrIds = new Set(rows<{ id: string }>(sameAddress).map((r) => r.id));
    const out = cand.filter((c) => normEmail(c.email) === normEmail(u.email) || (ph && normPhone(c.phone) === ph)).map((c) => ({ ...c, why: [normEmail(c.email) === normEmail(u.email) ? 'same email' : null, ph && normPhone(c.phone) === ph ? 'same phone' : null].filter(Boolean) as string[] }));
    if (addrIds.size) {
      const extra = await this.db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone, isGuest: users.isGuest, createdAt: users.createdAt }).from(users).where(and(inArray(users.id, [...addrIds]), isNull(users.mergedIntoId)));
      for (const e of extra) { const ex = out.find((o) => o.id === e.id); if (ex) ex.why.push('same address'); else out.push({ ...e, why: ['same address'] }); }
    }
    // 10.4-D accounts that signed in from the same device (staff accounts excluded: shared tills and test devices)
    const sameDevice = rows<{ id: string; client: string | null }>(await this.db.execute(sql`select distinct on (d2.user_id) d2.user_id as id, d2.client from user_devices d1 join user_devices d2 on d2.device_hash = d1.device_hash and d2.user_id <> d1.user_id join users u on u.id = d2.user_id where d1.user_id = ${id} and u.merged_into_id is null and not (u.roles && ${STAFF}) order by d2.user_id, d2.last_seen_at desc limit 20`));
    if (sameDevice.length) {
      const extra = await this.db.select({ id: users.id, email: users.email, name: users.name, phone: users.phone, isGuest: users.isGuest, createdAt: users.createdAt }).from(users).where(inArray(users.id, sameDevice.map((d) => d.id)));
      for (const e of extra) { const ex = out.find((o) => o.id === e.id); if (ex) ex.why.push('same device'); else out.push({ ...e, why: ['same device'] }); }
    }
    return out;
  }

  /** 10.4-D devices this account signed in from, and how many other accounts share each one. */
  async devices(id: string) {
    return rows<{ id: string; client: string | null; user_agent: string | null; sign_ins: number; first_seen_at: string; last_seen_at: string; shared_with: number }>(await this.db.execute(sql`select d.id, d.client, d.user_agent, d.sign_ins, d.created_at as first_seen_at, d.last_seen_at, (select count(distinct o.user_id)::int from user_devices o where o.device_hash = d.device_hash and o.user_id <> d.user_id) as shared_with from user_devices d where d.user_id = ${id} order by d.last_seen_at desc limit 20`)).map((d) => ({ id: d.id, client: d.client, userAgent: d.user_agent, signIns: Number(d.sign_ins), firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, sharedWith: Number(d.shared_with) }));
  }

  async sendRecovery(user: JwtPayload, id: string, reason: string) {
    assertCan(user, 'customers.pii');
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new NotFoundException();
    await this.auth.requestRecovery(u.email);
    await this.audit.log({ actorId: user.sub, action: 'customer.recovery_sent', entityType: 'user', entityId: id, reason });
    return { ok: true };
  }

  /** Merge a duplicate account into the one the customer keeps: history moves, the duplicate is closed. */
  async merge(user: JwtPayload, sourceId: string, targetId: string, reason: string) {
    assertCan(user, 'customers.pii');
    if (!can(user, 'support.manage')) throw new ForbiddenException();
    if (sourceId === targetId) throw new BadRequestException('Choose two different accounts');
    const [src] = await this.db.select().from(users).where(eq(users.id, sourceId)).limit(1);
    const [dst] = await this.db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!src || !dst) throw new NotFoundException();
    if (src.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r)) || src.mergedIntoId) throw new ConflictException('This account cannot be merged');
    const moved: Record<string, number> = {};
    await this.db.transaction(async (tx) => {
      const mv = async (name: string, q: Promise<unknown>) => { const r = await q; moved[name] = Array.isArray(r) ? r.length : 0; };
      await mv('orders', tx.update(orders).set({ userId: targetId }).where(eq(orders.userId, sourceId)).returning({ id: orders.id }));
      await mv('reservations', tx.update(reservations).set({ userId: targetId }).where(eq(reservations.userId, sourceId)).returning({ id: reservations.id }));
      await mv('addresses', tx.update(addresses).set({ userId: targetId, isDefault: false }).where(eq(addresses.userId, sourceId)).returning({ id: addresses.id }));
      await mv('credits', tx.update(customerCredits).set({ userId: targetId }).where(eq(customerCredits.userId, sourceId)).returning({ id: customerCredits.id }));
      await mv('loyalty', tx.update(loyaltyEntries).set({ userId: targetId }).where(eq(loyaltyEntries.userId, sourceId)).returning({ id: loyaltyEntries.id }));
      await mv('incidents', tx.update(incidents).set({ reporterId: targetId }).where(eq(incidents.reporterId, sourceId)).returning({ id: incidents.id }));
      await mv('reviews', tx.update(reviews).set({ userId: targetId }).where(eq(reviews.userId, sourceId)).returning({ id: reviews.id }));
      await mv('paymentMethods', tx.update(paymentMethods).set({ userId: targetId, isDefault: false }).where(eq(paymentMethods.userId, sourceId)).returning({ id: paymentMethods.id }));
      await tx.update(guestProfiles).set({ userId: targetId }).where(eq(guestProfiles.userId, sourceId));
      await tx.update(users).set({ mergedIntoId: targetId, status: 'DISABLED', statusReason: `Merged into ${targetId}: ${reason}`, email: `merged+${sourceId.slice(0, 8)}@anon.gutad.io`, passwordHash: null, pushTokens: [] }).where(eq(users.id, sourceId));
    });
    await this.auth.revokeAllSessions(sourceId, 'account merged');
    await this.audit.log({ actorId: user.sub, action: 'customer.merge', entityType: 'user', entityId: targetId, before: { sourceId, sourceEmail: src.email }, after: moved, reason });
    return { merged: true, into: targetId, moved };
  }

  // ───── 10.8 restrictions & appeals ─────

  async restrict(user: JwtPayload, userId: string, input: { kind: 'ORDERING_BLOCKED' | 'PROMOTIONS_BLOCKED' | 'REFUND_REVIEW' | 'CASH_LIMIT' | 'CREDIT_LIMIT'; reason: string; expiresAt?: string; limitCents?: number; periodDays?: number }) {
    assertCan(user, 'support.manage');
    // 10.8-L cash and credit limits carry a cap; one active limit per kind (a new one replaces the old)
    const isLimit = input.kind === 'CASH_LIMIT' || input.kind === 'CREDIT_LIMIT';
    if (isLimit && (input.limitCents === undefined || input.limitCents < 0)) throw new BadRequestException('Set the limit amount');
    if (isLimit) await this.db.update(customerRestrictions).set({ liftedAt: new Date(), liftedById: user.sub, appealDecisionNote: 'Replaced by a new limit' }).where(and(eq(customerRestrictions.userId, userId), eq(customerRestrictions.kind, input.kind), isNull(customerRestrictions.liftedAt)));
    const [r] = await this.db.insert(customerRestrictions).values({ userId, kind: input.kind, reason: input.reason, createdById: user.sub, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, limitCents: isLimit ? input.limitCents : null, periodDays: isLimit ? input.periodDays || null : null }).returning();
    if (input.kind === 'ORDERING_BLOCKED') await this.db.update(users).set({ status: 'RESTRICTED', statusReason: input.reason }).where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')));
    await this.audit.log({ actorId: user.sub, action: 'customer.restrict', entityType: 'user', entityId: userId, after: r, reason: input.reason });
    return r;
  }

  async lift(user: JwtPayload, restrictionId: string, note: string) {
    assertCan(user, 'support.manage');
    const [r] = await this.db.update(customerRestrictions).set({ liftedAt: new Date(), liftedById: user.sub, appealDecisionNote: note, appealStatus: sql`case when ${customerRestrictions.appealStatus} = 'PENDING' then 'LIFTED' else ${customerRestrictions.appealStatus} end` as never }).where(and(eq(customerRestrictions.id, restrictionId), isNull(customerRestrictions.liftedAt))).returning();
    if (!r) throw new NotFoundException('No active restriction');
    await this.syncStatus(r.userId);
    await this.audit.log({ actorId: user.sub, action: 'customer.unrestrict', entityType: 'user', entityId: r.userId, after: { restrictionId }, reason: note });
    return r;
  }

  private async syncStatus(userId: string) {
    const [still] = await this.db.select({ id: customerRestrictions.id }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, userId), eq(customerRestrictions.kind, 'ORDERING_BLOCKED'), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), sql`${customerRestrictions.expiresAt} > now()`))).limit(1);
    if (!still) await this.db.update(users).set({ status: 'ACTIVE', statusReason: null }).where(and(eq(users.id, userId), eq(users.status, 'RESTRICTED')));
  }

  async myRestrictions(user: JwtPayload) {
    return this.db.select({ id: customerRestrictions.id, kind: customerRestrictions.kind, reason: customerRestrictions.reason, limitCents: customerRestrictions.limitCents, periodDays: customerRestrictions.periodDays, expiresAt: customerRestrictions.expiresAt, appealStatus: customerRestrictions.appealStatus, appealDecisionNote: customerRestrictions.appealDecisionNote, createdAt: customerRestrictions.createdAt }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, user.sub), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), sql`${customerRestrictions.expiresAt} > now()`)));
  }

  async appeal(user: JwtPayload, restrictionId: string, note: string) {
    const [r] = await this.db.update(customerRestrictions).set({ appealStatus: 'PENDING', appealNote: note, appealedAt: new Date() }).where(and(eq(customerRestrictions.id, restrictionId), eq(customerRestrictions.userId, user.sub), isNull(customerRestrictions.liftedAt), inArray(customerRestrictions.appealStatus, ['NONE', 'UPHELD']))).returning();
    if (!r) throw new NotFoundException('Nothing to appeal');
    return r;
  }

  async decideAppeal(user: JwtPayload, restrictionId: string, lift: boolean, note: string) {
    assertCan(user, 'support.manage');
    if (lift) return this.lift(user, restrictionId, note);
    const [r] = await this.db.update(customerRestrictions).set({ appealStatus: 'UPHELD', appealDecisionNote: note }).where(and(eq(customerRestrictions.id, restrictionId), eq(customerRestrictions.appealStatus, 'PENDING'))).returning();
    if (!r) throw new NotFoundException('No pending appeal');
    await this.audit.log({ actorId: user.sub, action: 'customer.appeal_upheld', entityType: 'user', entityId: r.userId, reason: note });
    return r;
  }

  async appealsQueue(user: JwtPayload) {
    assertCan(user, 'support.read');
    return this.db.select({ r: customerRestrictions, email: users.email, name: users.name }).from(customerRestrictions).innerJoin(users, eq(users.id, customerRestrictions.userId)).where(eq(customerRestrictions.appealStatus, 'PENDING')).orderBy(customerRestrictions.appealedAt).then((x) => x.map((y) => ({ ...y.r, email: this.pii(user) ? y.email : mask(y.email), name: y.name })));
  }

  /** Used by checkout and quotes. */
  async activeRestrictions(userId: string) {
    return (await this.db.select({ kind: customerRestrictions.kind, reason: customerRestrictions.reason }).from(customerRestrictions).where(and(eq(customerRestrictions.userId, userId), isNull(customerRestrictions.liftedAt), or(isNull(customerRestrictions.expiresAt), sql`${customerRestrictions.expiresAt} > now()`))));
  }

  // ───── 10.3 saved cards (masked) ─────

  async myCards(user: JwtPayload) {
    return this.db.select({ id: paymentMethods.id, brand: paymentMethods.brand, last4: paymentMethods.last4, expMonth: paymentMethods.expMonth, expYear: paymentMethods.expYear, isDefault: paymentMethods.isDefault, providerRef: paymentMethods.providerRef }).from(paymentMethods).where(eq(paymentMethods.userId, user.sub)).orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt));
  }

  /** Save a processor token. The card number never reaches Gutad; brand and last 4 come from the processor (mock: from the token). */
  async addCard(user: JwtPayload, input: { paymentMethodId: string; brand?: string; last4?: string; expMonth?: number; expYear?: number; makeDefault?: boolean }) {
    if (!/^(pm_|mock_pm_)[A-Za-z0-9_]+$/.test(input.paymentMethodId)) throw new BadRequestException('Not a payment token');
    // 10.3-P live processor: the masked details come from the processor, never from the client
    if (this.cardSetup.live) {
      if (input.paymentMethodId.startsWith('mock_')) throw new BadRequestException('Test cards are not accepted by the live processor');
      const d = await this.cardSetup.describe(input.paymentMethodId);
      if (!d) throw new BadRequestException('The processor does not recognise this card');
      if (d.customerRef) await this.db.update(users).set({ paymentCustomerRef: d.customerRef }).where(and(eq(users.id, user.sub), isNull(users.paymentCustomerRef)));
      // a card tokenized for one payment (checkout's "save this card") is single-use until it belongs to a customer
      else await this.cardSetup.attach(user.sub, input.paymentMethodId).catch(() => { throw new BadRequestException({ message: 'This card can’t be saved. Enter it again to save it.', code: 'CARD_NOT_REUSABLE' }); });
      input = { ...input, brand: d.brand || 'card', last4: d.last4 || undefined, expMonth: d.expMonth ?? undefined, expYear: d.expYear ?? undefined };
    }
    const last4 = input.last4 || input.paymentMethodId.match(/(\d{4})$/)?.[1] || null;
    const existing = await this.myCards(user);
    if (existing.some((c) => c.providerRef === input.paymentMethodId)) throw new ConflictException('Card already saved');
    if (input.makeDefault || !existing.length) await this.db.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.userId, user.sub));
    const [row] = await this.db.insert(paymentMethods).values({ userId: user.sub, provider: input.paymentMethodId.startsWith('mock_') ? 'mock' : 'stripe', providerRef: input.paymentMethodId, brand: input.brand || 'card', last4, expMonth: input.expMonth ?? null, expYear: input.expYear ?? null, isDefault: input.makeDefault || !existing.length }).returning();
    return { id: row.id, brand: row.brand, last4: row.last4, isDefault: row.isDefault };
  }

  async removeCard(user: JwtPayload, id: string) {
    await this.db.delete(paymentMethods).where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, user.sub)));
    return { ok: true };
  }

  async defaultCard(user: JwtPayload, id: string) {
    await this.db.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.userId, user.sub));
    await this.db.update(paymentMethods).set({ isDefault: true }).where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, user.sub)));
    return { ok: true };
  }

  // ───── 10.5 notification preferences ─────

  async prefs(user: JwtPayload) {
    const [u] = await this.db.select({ p: users.notificationPrefs, m: users.marketingConsent, s: users.smsConsent }).from(users).where(eq(users.id, user.sub)).limit(1);
    const p = (u?.p || {}) as Record<string, Record<string, boolean>>;
    return { topics: NOTIFY_TOPICS.map((t) => ({ topic: t, email: p[t]?.email ?? true, sms: p[t]?.sms ?? (t === 'marketing' ? u?.s : true), push: p[t]?.push ?? true })), marketingConsent: u?.m, smsConsent: u?.s };
  }

  async setPrefs(user: JwtPayload, topics: { topic: string; email?: boolean; sms?: boolean; push?: boolean }[]) {
    const [u] = await this.db.select({ p: users.notificationPrefs }).from(users).where(eq(users.id, user.sub)).limit(1);
    const next = { ...((u?.p || {}) as Record<string, unknown>) };
    for (const t of topics) if ((NOTIFY_TOPICS as readonly string[]).includes(t.topic)) next[t.topic] = { email: t.email, sms: t.sms, push: t.push };
    await this.db.update(users).set({ notificationPrefs: next }).where(eq(users.id, user.sub));
    const mk = topics.find((t) => t.topic === 'marketing');
    if (mk) {
      const consentEmail = !!mk.email, consentSms = !!mk.sms;
      await this.db.update(users).set({ marketingConsent: consentEmail, smsConsent: consentSms }).where(eq(users.id, user.sub));
      await this.db.insert(consents).values([{ userId: user.sub, purpose: 'marketing_email', granted: consentEmail, source: 'preferences' }, { userId: user.sub, purpose: 'marketing_sms', granted: consentSms, source: 'preferences' }]);
    }
    return this.prefs(user);
  }

  // ───── 10.7 privacy requests & retention ─────

  async privacyRequest(user: JwtPayload, kind: 'ACCESS' | 'DELETE') {
    if (kind === 'ACCESS') return { ...(await this.support.dataRequest(user, 'ACCESS')) };
    const [open] = await this.db.select().from(dataRequests).where(and(eq(dataRequests.userId, user.sub), eq(dataRequests.kind, 'DELETE'), eq(dataRequests.status, 'PENDING'))).limit(1);
    if (open) return { request: open };
    const cfg = await this.settings.getObject('privacy', PRIVACY_DEFAULTS);
    const [r] = await this.db.insert(dataRequests).values({ userId: user.sub, kind: 'DELETE', status: 'PENDING', scheduledFor: new Date(Date.now() + cfg.deleteGraceDays * 86400_000) }).returning();
    return { request: r, note: `Your account will be deleted on ${r.scheduledFor!.toDateString()}. You can cancel until then.` };
  }

  async myPrivacyRequests(user: JwtPayload) {
    return this.db.select({ id: dataRequests.id, kind: dataRequests.kind, status: dataRequests.status, scheduledFor: dataRequests.scheduledFor, createdAt: dataRequests.createdAt }).from(dataRequests).where(eq(dataRequests.userId, user.sub)).orderBy(desc(dataRequests.createdAt)).limit(20);
  }

  async cancelPrivacy(user: JwtPayload, id: string) {
    const [r] = await this.db.update(dataRequests).set({ status: 'CANCELED' }).where(and(eq(dataRequests.id, id), eq(dataRequests.userId, user.sub), eq(dataRequests.status, 'PENDING'))).returning();
    if (!r) throw new NotFoundException();
    return r;
  }

  async privacyQueue(user: JwtPayload, status?: string) {
    assertCan(user, 'customers.read');
    const list = await this.db.select({ r: dataRequests, email: users.email }).from(dataRequests).innerJoin(users, eq(users.id, dataRequests.userId)).where(status ? eq(dataRequests.status, status) : undefined).orderBy(desc(dataRequests.createdAt)).limit(200);
    return list.map((x) => ({ ...x.r, email: this.pii(user) ? x.email : mask(x.email) }));
  }

  private async deleteBlockers(userId: string) {
    const [open] = await this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, userId), inArray(orders.status, ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED'])));
    const [disp] = await this.db.select({ n: sql<number>`count(*)::int` }).from(incidents).innerJoin(orders, eq(orders.id, incidents.orderId)).where(and(eq(orders.userId, userId), inArray(incidents.status, ['OPEN', 'INVESTIGATING', 'APPEALED']), eq(incidents.category, 'CHARGEBACK')));
    const out: string[] = [];
    if (open.n) out.push(`${open.n} order(s) still in progress`);
    if (disp.n) out.push('an open chargeback');
    return out;
  }

  /** Staff: run a deletion now (after checks) or block it with a note. */
  async decidePrivacy(user: JwtPayload, id: string, action: 'EXECUTE' | 'BLOCK', note: string) {
    assertCan(user, 'customers.pii');
    const [r] = await this.db.select().from(dataRequests).where(eq(dataRequests.id, id)).limit(1);
    if (!r || r.kind !== 'DELETE' || r.status !== 'PENDING') throw new NotFoundException('No pending deletion');
    if (action === 'BLOCK') {
      const [u] = await this.db.update(dataRequests).set({ status: 'BLOCKED', reviewedById: user.sub, note }).where(eq(dataRequests.id, id)).returning();
      return u;
    }
    const blockers = await this.deleteBlockers(r.userId);
    if (blockers.length) throw new ConflictException(`Cannot delete yet: ${blockers.join('; ')}`);
    await this.support.anonymize(r.userId);
    const [u] = await this.db.update(dataRequests).set({ status: 'FULFILLED', fulfilledAt: new Date(), reviewedById: user.sub, note }).where(eq(dataRequests.id, id)).returning();
    await this.auth.revokeAllSessions(r.userId, 'account deleted');
    await this.audit.log({ actorId: user.sub, action: 'privacy.delete', entityType: 'user', entityId: r.userId, reason: note });
    return u;
  }

  /** Worker: deletions past their grace period run unless blocked; old guest accounts are anonymized by the retention rule. */
  async privacySweep() {
    const due = await this.db.select().from(dataRequests).where(and(eq(dataRequests.kind, 'DELETE'), eq(dataRequests.status, 'PENDING'), lte(dataRequests.scheduledFor, new Date()))).limit(50);
    let done = 0;
    for (const r of due) {
      if ((await this.deleteBlockers(r.userId)).length) continue;
      await this.support.anonymize(r.userId);
      await this.auth.revokeAllSessions(r.userId, 'account deleted');
      await this.db.update(dataRequests).set({ status: 'FULFILLED', fulfilledAt: new Date(), note: 'Deleted after the grace period' }).where(eq(dataRequests.id, r.id));
      done++;
    }
    const cfg = await this.settings.getObject('privacy', PRIVACY_DEFAULTS);
    const stale = rows<{ id: string }>(await this.db.execute(sql`select u.id from users u where u.is_guest and u.email not like '%@anon.gutad.io' and u.created_at < now() - make_interval(days => ${cfg.guestRetentionDays}) and not exists (select 1 from orders o where o.user_id = u.id and o.created_at > now() - make_interval(days => ${cfg.guestRetentionDays})) and not exists (select 1 from reservations r where r.user_id = u.id and r.created_at > now() - make_interval(days => ${cfg.guestRetentionDays})) limit 100`));
    for (const s of stale) await this.support.anonymize(s.id);
    return { deleted: done, retained: stale.length };
  }
}
