import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db, DbService } from '../../db/db.module';
import { auditLogs, configChanges, deliveryJobs, integrationAccounts, locations, orders, orgMemberships, organizations, outboxEvents, platformSettings, refreshTokens, reservations, users, notifications, payouts } from '../../db/schema';
import { isPlatformStaff, JwtPayload, RoleName } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { RedisService } from '../../core/redis.service';
import { LedgerService } from '../../core/ledger.service';
import { loadConfig } from '../../config/config';

/** 30 — tenant provisioning, entitlements, staff roles, approval limits, config history, credentials, monitoring, offboarding. */
@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly dbs: DbService, private readonly audit: AuditService, private readonly redis: RedisService, private readonly ledger: LedgerService) {}

  private staff(user: JwtPayload) {
    if (!user.roles.includes('PLATFORM_ADMIN')) throw new ForbiddenException('Platform admin only');
  }

  /** Provision a tenant (organization + owner invite + feature entitlements) in one step. */
  async provisionTenant(user: JwtPayload, input: { name: string; kind?: string; ownerEmail: string; featureFlags?: Record<string, boolean>; billingEmail?: string }) {
    this.staff(user);
    return this.db.transaction(async (tx) => {
      const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
      const [org] = await tx.insert(organizations).values({ name: input.name, slug, kind: input.kind || 'MERCHANT', billingEmail: input.billingEmail || input.ownerEmail, status: 'PROSPECT', featureFlags: input.featureFlags || { ordering: true, reservations: false, delivery: false, events: false, sharedKitchen: false, mealKits: false, programs: false } }).returning();
      let [owner] = await tx.select().from(users).where(eq(users.email, input.ownerEmail.toLowerCase())).limit(1);
      if (!owner) [owner] = await tx.insert(users).values({ email: input.ownerEmail.toLowerCase(), isGuest: true }).returning();
      await tx.insert(orgMemberships).values({ userId: owner.id, organizationId: org.id, role: 'MERCHANT_OWNER' }).onConflictDoNothing();
      await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'tenant.provision', entityType: 'organization', entityId: org.id, after: org }, tx);
      return org;
    });
  }

  async setFeatureFlags(user: JwtPayload, orgId: string, flags: Record<string, boolean>) {
    this.staff(user);
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new NotFoundException();
    const merged = { ...(org.featureFlags as object), ...flags };
    const [u] = await this.db.update(organizations).set({ featureFlags: merged }).where(eq(organizations.id, orgId)).returning();
    await this.audit.configChange({ organizationId: orgId, key: 'featureFlags', before: org.featureFlags, after: merged, actorId: user.sub, approvedById: user.sub });
    return u;
  }

  async grantPlatformRole(user: JwtPayload, targetEmail: string, role: RoleName, grant: boolean) {
    this.staff(user);
    if (!['PLATFORM_ADMIN', 'SUPPORT', 'FINANCE', 'DISPATCHER'].includes(role)) throw new BadRequestException('Not a platform role');
    const [t] = await this.db.select().from(users).where(eq(users.email, targetEmail.toLowerCase())).limit(1);
    if (!t) throw new NotFoundException('User not found');
    const roles = grant ? Array.from(new Set([...t.roles, role])) : t.roles.filter((r) => r !== role);
    await this.db.update(users).set({ roles: roles as never }).where(eq(users.id, t.id));
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, t.id)); // force re-login with new claims
    await this.audit.log({ actorId: user.sub, action: grant ? 'role.grant' : 'role.revoke', entityType: 'user', entityId: t.id, before: t.roles, after: roles });
    return { userId: t.id, roles };
  }

  async setApprovalLimit(user: JwtPayload, membershipId: string, approvalLimitCents: number) {
    this.staff(user);
    const [m] = await this.db.update(orgMemberships).set({ approvalLimitCents }).where(eq(orgMemberships.id, membershipId)).returning();
    if (!m) throw new NotFoundException();
    await this.audit.configChange({ organizationId: m.organizationId, key: `approvalLimit:${membershipId}`, after: { approvalLimitCents }, actorId: user.sub, approvedById: user.sub });
    return m;
  }

  async getSettings(user: JwtPayload) {
    this.staff(user);
    const rows = await this.db.select().from(platformSettings);
    const cfg = loadConfig();
    return { env: { paymentProvider: cfg.PAYMENT_PROVIDER, deliveryProvider: cfg.DELIVERY_PROVIDER, smsProvider: cfg.SMS_PROVIDER, emailProvider: cfg.EMAIL_PROVIDER, currency: cfg.DEFAULT_CURRENCY, timezone: cfg.DEFAULT_TIMEZONE }, settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  /** High-value settings require a second approver (configured via `approvals.required` setting). */
  async setSetting(user: JwtPayload, key: string, value: unknown, approvedByEmail?: string) {
    this.staff(user);
    const [existing] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
    const sensitive = key.startsWith('fees.') || key.startsWith('payout.') || key.startsWith('beneficiary.');
    let approvedById: string | null = null;
    if (sensitive) {
      if (!approvedByEmail) throw new BadRequestException('This setting requires a second approver');
      const [a] = await this.db.select().from(users).where(eq(users.email, approvedByEmail.toLowerCase())).limit(1);
      if (!a || !a.roles.includes('PLATFORM_ADMIN') || a.id === user.sub) throw new ForbiddenException('Approver must be a different platform admin');
      approvedById = a.id;
    }
    const [row] = await this.db.insert(platformSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: platformSettings.key, set: { value: value as never } }).returning();
    await this.audit.configChange({ key, before: existing?.value, after: value, actorId: user.sub, approvedById });
    await this.redis.del(`setting:${key}`);
    return row;
  }

  async configHistory(user: JwtPayload, orgId?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select().from(configChanges).where(orgId ? eq(configChanges.organizationId, orgId) : undefined).orderBy(desc(configChanges.createdAt)).limit(200);
  }

  async auditTrail(user: JwtPayload, entityType?: string, entityId?: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const conds = [];
    if (entityType) conds.push(eq(auditLogs.entityType, entityType));
    if (entityId) conds.push(eq(auditLogs.entityId, entityId));
    return this.db.select().from(auditLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(auditLogs.createdAt)).limit(200);
  }

  async rotateIntegrationSecret(user: JwtPayload, integrationId: string) {
    this.staff(user);
    const secret = Buffer.from(Array.from({ length: 24 }, () => Math.floor(Math.random() * 256))).toString('base64url');
    const [i] = await this.db.update(integrationAccounts).set({ webhookSecret: secret }).where(eq(integrationAccounts.id, integrationId)).returning();
    if (!i) throw new NotFoundException();
    await this.audit.log({ organizationId: i.organizationId, actorId: user.sub, action: 'integration.rotate_secret', entityType: 'integration', entityId: integrationId });
    return { webhookSecret: secret };
  }

  /** Monitoring: liveness of dependencies and backlog gauges (also exposed unauthenticated at /health). */
  async health() {
    let db = false;
    let redis = false;
    try { db = await this.dbs.ping(); } catch { db = false; }
    try { redis = (await this.redis.client.ping()) === 'PONG'; } catch { redis = false; }
    const [outbox] = db ? await this.db.select({ n: sql<number>`count(*)::int` }).from(outboxEvents).where(sql`${outboxEvents.publishedAt} is null`) : [{ n: -1 }];
    const [notif] = db ? await this.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(eq(notifications.status, 'QUEUED')) : [{ n: -1 }];
    const [stuck] = db ? await this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.status, 'SUBMITTED'), sql`${orders.createdAt} < now() - interval '10 minutes'`, sql`${orders.scheduledFor} is null`)) : [{ n: -1 }];
    const [failedPayouts] = db ? await this.db.select({ n: sql<number>`count(*)::int` }).from(payouts).where(inArray(payouts.status, ['FAILED', 'HELD'])) : [{ n: -1 }];
    return { ok: db && redis, db, redis, outboxBacklog: outbox.n, notificationBacklog: notif.n, unacknowledgedOrders: stuck.n, failedPayouts: failedPayouts.n, version: process.env.npm_package_version || '1.0.0', uptimeSec: Math.round(process.uptime()) };
  }

  /** Offboarding: pause selling, resolve open commitments, revoke access & integrations, settle, export. */
  async offboard(user: JwtPayload, orgId: string) {
    this.staff(user);
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new NotFoundException();
    const locs = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId));
    const locIds = locs.map((l) => l.id);
    const openOrders = locIds.length ? await this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(inArray(orders.locationId, locIds), inArray(orders.status, ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY']))) : [{ n: 0 }];
    const openBookings = locIds.length ? await this.db.select({ n: sql<number>`count(*)::int` }).from(reservations).where(and(inArray(reservations.locationId, locIds), inArray(reservations.status, ['HELD', 'CONFIRMED', 'ARRIVED', 'SEATED']))) : [{ n: 0 }];
    const openJobs = locIds.length ? await this.db.select({ n: sql<number>`count(*)::int` }).from(deliveryJobs).where(and(inArray(deliveryJobs.locationId, locIds), inArray(deliveryJobs.status, ['REQUESTED', 'ASSIGNED', 'PICKED_UP']))) : [{ n: 0 }];
    if (openOrders[0].n || openBookings[0].n || openJobs[0].n) {
      // step 1: stop new sales but keep honoring commitments
      if (locIds.length) await this.db.update(locations).set({ isPaused: true, pausedReason: 'Offboarding: no new orders', status: 'PAUSED' }).where(inArray(locations.id, locIds));
      return { status: 'PAUSED_PENDING_COMMITMENTS', openOrders: openOrders[0].n, openBookings: openBookings[0].n, openDeliveries: openJobs[0].n };
    }
    const balance = await this.ledger.balance('MERCHANT_PAYABLE', orgId);
    await this.db.transaction(async (tx) => {
      if (locIds.length) await tx.update(locations).set({ status: 'OFFBOARDED', isPaused: true, pausedReason: 'Offboarded' }).where(inArray(locations.id, locIds));
      await tx.update(organizations).set({ status: 'OFFBOARDED' }).where(eq(organizations.id, orgId));
      await tx.update(integrationAccounts).set({ status: 'DISABLED', credentials: {} }).where(eq(integrationAccounts.organizationId, orgId));
      const members = await tx.select().from(orgMemberships).where(eq(orgMemberships.organizationId, orgId));
      for (const m of members) await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, m.userId));
      await tx.delete(orgMemberships).where(eq(orgMemberships.organizationId, orgId));
      await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'tenant.offboard', entityType: 'organization', entityId: orgId, after: { balanceCents: balance } }, tx);
    });
    return { status: 'OFFBOARDED', finalBalanceCents: balance, note: balance !== 0 ? 'Settle remaining balance via finance close-period' : 'No outstanding balance', exportHint: `GET /organizations/${orgId}/statements and /locations/:id/reports/orders.csv remain readable to platform staff under the retention policy.` };
  }

  async listTenants(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    return this.db.select({ org: organizations, locations: sql<number>`(select count(*) from locations l where l.organization_id = ${organizations.id})::int` }).from(organizations).orderBy(desc(organizations.createdAt)).limit(500);
  }
}
