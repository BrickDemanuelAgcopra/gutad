import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../../db/db.module';
import { guestProfiles, locations, orders, reviews, segments, users } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';

@Injectable()
export class CrmService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Upsert a guest profile per organization keyed on email (fallback phone). */
  async upsertGuest(orgId: string, input: { locationId?: string | null; userId?: string | null; name: string; email?: string | null; phone?: string | null }, tx: DbOrTx = this.db) {
    const email = input.email?.toLowerCase() || null;
    let [g] = email ? await tx.select().from(guestProfiles).where(and(eq(guestProfiles.organizationId, orgId), eq(guestProfiles.email, email))).limit(1) : [];
    if (!g && input.phone) [g] = await tx.select().from(guestProfiles).where(and(eq(guestProfiles.organizationId, orgId), eq(guestProfiles.phone, input.phone))).limit(1);
    if (g) {
      const [u] = await tx.update(guestProfiles).set({ userId: g.userId || input.userId || null, phone: g.phone || input.phone || null, name: g.name || input.name }).where(eq(guestProfiles.id, g.id)).returning();
      return u;
    }
    const [n] = await tx.insert(guestProfiles).values({ organizationId: orgId, locationId: input.locationId ?? null, userId: input.userId ?? null, name: input.name, email, phone: input.phone ?? null }).returning();
    return n;
  }

  async recordOrder(orgId: string, input: { locationId: string; userId?: string | null; name: string; email?: string | null; phone?: string | null; spendCents: number }, tx: DbOrTx = this.db) {
    const g = await this.upsertGuest(orgId, input, tx);
    await tx.update(guestProfiles).set({ orderCount: sql`${guestProfiles.orderCount} + 1`, lifetimeSpendCents: sql`${guestProfiles.lifetimeSpendCents} + ${input.spendCents}`, lastVisitAt: new Date() }).where(eq(guestProfiles.id, g.id));
    return g;
  }

  async recordVisit(orgId: string, input: { locationId: string; userId?: string | null; name: string; email?: string | null; phone?: string | null; spendCents?: number }, tx: DbOrTx = this.db) {
    const g = await this.upsertGuest(orgId, input, tx);
    await tx.update(guestProfiles).set({ visitCount: sql`${guestProfiles.visitCount} + 1`, lifetimeSpendCents: sql`${guestProfiles.lifetimeSpendCents} + ${input.spendCents || 0}`, lastVisitAt: new Date() }).where(eq(guestProfiles.id, g.id));
    return g;
  }

  async search(user: JwtPayload, orgId: string, q?: string) {
    assertOrgAccess(user, orgId);
    const where = q ? and(eq(guestProfiles.organizationId, orgId), or(ilike(guestProfiles.name, `%${q}%`), ilike(guestProfiles.email, `%${q}%`), ilike(guestProfiles.phone, `%${q}%`))) : eq(guestProfiles.organizationId, orgId);
    return this.db.select().from(guestProfiles).where(where).orderBy(desc(guestProfiles.lastVisitAt)).limit(100);
  }

  async get(user: JwtPayload, id: string) {
    const [g] = await this.db.select().from(guestProfiles).where(eq(guestProfiles.id, id)).limit(1);
    if (!g) throw new NotFoundException();
    assertOrgAccess(user, g.organizationId);
    const history = g.userId ? await this.db.select({ id: orders.id, number: orders.number, totalCents: orders.totalCents, status: orders.status, createdAt: orders.createdAt, locationId: orders.locationId }).from(orders).where(and(eq(orders.userId, g.userId), eq(orders.organizationId, g.organizationId))).orderBy(desc(orders.createdAt)).limit(50) : [];
    return { ...g, orderHistory: history };
  }

  /** Protected guest notes & tags — managers only; never exposed to customers. */
  async update(user: JwtPayload, id: string, input: { notes?: string; tags?: string[]; favorites?: unknown[]; contactPrefs?: Record<string, unknown> }) {
    const [g] = await this.db.select().from(guestProfiles).where(eq(guestProfiles.id, id)).limit(1);
    if (!g) throw new NotFoundException();
    assertOrgAccess(user, g.organizationId, null, MANAGER_ROLES);
    const [u] = await this.db.update(guestProfiles).set(input as never).where(eq(guestProfiles.id, id)).returning();
    return u;
  }

  async createSegment(user: JwtPayload, orgId: string, input: { name: string; rules: Record<string, unknown> }) {
    assertOrgAccess(user, orgId, null, MANAGER_ROLES);
    const [s] = await this.db.insert(segments).values({ organizationId: orgId, name: input.name, rules: input.rules }).returning();
    return s;
  }

  async listSegments(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    return this.db.select().from(segments).where(eq(segments.organizationId, orgId));
  }

  // ───── reviews (verified = tied to a completed order) ─────

  async createReview(user: JwtPayload, input: { locationId: string; orderId?: string; rating: number; body?: string }) {
    if (input.rating < 1 || input.rating > 5) throw new BadRequestException('Rating must be 1–5');
    let verified = false;
    if (input.orderId) {
      const [o] = await this.db.select().from(orders).where(and(eq(orders.id, input.orderId), eq(orders.userId, user.sub))).limit(1);
      if (!o) throw new ForbiddenException('Order not yours');
      if (o.status !== 'COMPLETED' && o.status !== 'COLLECTED') throw new BadRequestException('Order not completed yet');
      verified = true;
      const [dupe] = await this.db.select().from(reviews).where(eq(reviews.orderId, input.orderId)).limit(1);
      if (dupe) throw new BadRequestException('Order already reviewed');
    }
    const [r] = await this.db.insert(reviews).values({ locationId: input.locationId, userId: user.sub, orderId: input.orderId ?? null, rating: input.rating, body: input.body ?? null, verified, status: verified ? 'PUBLISHED' : 'PENDING' }).returning();
    if (verified) await this.recomputeRating(input.locationId);
    return r;
  }

  async moderate(user: JwtPayload, reviewId: string, status: 'PUBLISHED' | 'REJECTED', merchantReply?: string) {
    const [r] = await this.db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!r) throw new NotFoundException();
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, r.locationId)).limit(1);
    if (merchantReply !== undefined) assertOrgAccess(user, loc!.organizationId, r.locationId, MANAGER_ROLES);
    else if (!isPlatformStaff(user)) throw new ForbiddenException('Moderation is platform staff only');
    const [u] = await this.db.update(reviews).set({ ...(merchantReply !== undefined ? { merchantReply } : { status }) }).where(eq(reviews.id, reviewId)).returning();
    await this.recomputeRating(r.locationId);
    return u;
  }

  async publicReviews(locationId: string) {
    return this.db
      .select({ id: reviews.id, rating: reviews.rating, body: reviews.body, verified: reviews.verified, merchantReply: reviews.merchantReply, createdAt: reviews.createdAt, author: users.name })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(and(eq(reviews.locationId, locationId), eq(reviews.status, 'PUBLISHED')))
      .orderBy(desc(reviews.createdAt))
      .limit(50);
  }

  private async recomputeRating(locationId: string) {
    const [r] = await this.db.select({ avg: sql<number>`avg(${reviews.rating})::float`, n: sql<number>`count(*)::int` }).from(reviews).where(and(eq(reviews.locationId, locationId), eq(reviews.status, 'PUBLISHED')));
    await this.db.update(locations).set({ rating: r?.avg ?? null, ratingCount: r?.n || 0 }).where(eq(locations.id, locationId));
  }
}
