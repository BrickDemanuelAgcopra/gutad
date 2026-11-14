import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { isStaffRole, SENSITIVITY, STAFF_ROLES, type Sensitivity, type StaffRole } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { accessGrants, auditLogs, brands, platformSettings, kitchens, legalSellers, locations, organizations, regions, staffScopes, userSessions, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { CryptoService } from '../../core/crypto.service';
import { RedisService } from '../../core/redis.service';
import { assertCan, can, effectiveRoles, JwtPayload, RoleName, staffCovers } from '../../common/auth';
import { AuthService, SESSION_DEFAULTS, type SsoConfig } from '../auth/auth.service';
import { IamService, type StepUp } from './iam.service';

export const EMERGENCY_DEFAULTS = { maxMinutes: 240, grantableRoles: ['OPERATIONS', 'FINANCE', 'SUPPORT', 'CULINARY', 'MARKETING', 'IT', 'DISPATCHER', 'EXECUTIVE'] as string[] };

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 2 — staff access (roles, scopes, sessions, MFA resets, disable), emergency & support access, hierarchy, audit. */
@Injectable()
export class SecurityService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly auth: AuthService, private readonly notify: NotifyService, private readonly settings: SettingsService, private readonly crypto: CryptoService, private readonly redis: RedisService, private readonly iam: IamService) {}

  // ───── staff directory ─────

  async listStaff(user: JwtPayload) {
    assertCan(user, 'security.read');
    const rows = await this.db.select().from(users).where(sql`${users.roles} && array[${sql.raw(STAFF_ROLES.map((r) => `'${r}'`).join(','))}]::role[]`).orderBy(users.email).limit(500);
    const ids = rows.map((r) => r.id);
    const scopes = ids.length ? await this.db.select().from(staffScopes).where(inArray(staffScopes.userId, ids)) : [];
    const grants = ids.length ? await this.db.select().from(accessGrants).where(and(inArray(accessGrants.userId, ids), isNull(accessGrants.revokedAt), gt(accessGrants.expiresAt, new Date()))) : [];
    const sessions = ids.length ? await this.db.select({ userId: userSessions.userId, n: sql<number>`count(*)::int`, last: sql<string>`max(${userSessions.lastSeenAt})` }).from(userSessions).where(and(inArray(userSessions.userId, ids), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date()))).groupBy(userSessions.userId) : [];
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: u.roles.filter(isStaffRole),
      status: u.status,
      statusReason: u.statusReason,
      mfaEnabled: !!u.mfaEnabledAt,
      scope: scopes.find((s) => s.userId === u.id) || null,
      activeGrants: grants.filter((g) => g.userId === u.id),
      sessions: sessions.find((s) => s.userId === u.id)?.n || 0,
      lastSeenAt: sessions.find((s) => s.userId === u.id)?.last || null,
    }));
  }

  async userDetail(user: JwtPayload, userId: string) {
    assertCan(user, 'security.read');
    const [u] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new NotFoundException();
    const [scope] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    const grants = await this.db.select().from(accessGrants).where(eq(accessGrants.userId, userId)).orderBy(desc(accessGrants.createdAt)).limit(50);
    const recent = await this.db.select().from(auditLogs).where(eq(auditLogs.actorId, userId)).orderBy(desc(auditLogs.createdAt)).limit(50);
    return { id: u.id, email: u.email, name: u.name, roles: u.roles, status: u.status, statusReason: u.statusReason, mfaEnabled: !!u.mfaEnabledAt, scope: scope || null, sessions: await this.auth.listSessions(userId), grants, recentActions: recent };
  }

  /** Replace a person's staff roles. Only platform admins can grant PLATFORM_ADMIN. Their sessions end so new claims apply. */
  async setStaffRoles(user: JwtPayload, input: { email: string; roles: StaffRole[]; reason?: string; stepUp?: StepUp }) {
    return this.iam.setSystemRoles(user, { email: input.email, roles: input.roles, reason: input.reason || 'role change', stepUp: input.stepUp });
  }

  /** @deprecated replaced by IamService.setSystemRoles */
  async setStaffRolesLegacy(user: JwtPayload, input: { email: string; roles: StaffRole[] }) {
    assertCan(user, 'security.manage');
    const [t] = await this.db.select().from(users).where(eq(users.email, input.email.toLowerCase().trim())).limit(1);
    if (!t) throw new NotFoundException('User not found. They must create an account first.');
    const touchesAdmin = input.roles.includes('PLATFORM_ADMIN') !== t.roles.includes('PLATFORM_ADMIN');
    if (touchesAdmin && !effectiveRoles(user).includes('PLATFORM_ADMIN')) throw new ForbiddenException('Only a platform admin can grant or remove platform admin');
    if (t.id === user.sub && t.roles.includes('PLATFORM_ADMIN') && !input.roles.includes('PLATFORM_ADMIN')) throw new BadRequestException('You cannot remove your own platform admin role');
    const roles = Array.from(new Set([...t.roles.filter((r) => !isStaffRole(r)), ...input.roles]));
    await this.db.update(users).set({ roles: roles as never }).where(eq(users.id, t.id));
    await this.auth.revokeAllSessions(t.id, 'roles changed');
    await this.audit.log({ actorId: user.sub, action: 'staff.roles', entityType: 'user', entityId: t.id, before: t.roles, after: roles });
    return { userId: t.id, roles };
  }

  async setScope(user: JwtPayload, userId: string, input: { regionIds?: string[]; organizationIds?: string[]; locationIds?: string[]; maxSensitivity?: Sensitivity; note?: string | null; reason?: string }) {
    const [cur] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    return this.iam.setScope(user, userId, { companyIds: cur?.companyIds, kitchenIds: cur?.kitchenIds, brandIds: cur?.brandIds, teams: cur?.teams, ...input });
  }

  /** @deprecated replaced by IamService.setScope */
  async setScopeLegacy(user: JwtPayload, userId: string, input: { regionIds?: string[]; organizationIds?: string[]; locationIds?: string[]; maxSensitivity?: Sensitivity; note?: string | null }) {
    assertCan(user, 'security.manage');
    const [t] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!t) throw new NotFoundException();
    const [before] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    const values = { userId, regionIds: input.regionIds || [], organizationIds: input.organizationIds || [], locationIds: input.locationIds || [], maxSensitivity: input.maxSensitivity || 'RESTRICTED', note: input.note ?? null, updatedById: user.sub };
    if (!SENSITIVITY.includes(values.maxSensitivity as Sensitivity)) throw new BadRequestException('Unknown sensitivity');
    const unrestricted = !values.regionIds.length && !values.organizationIds.length && !values.locationIds.length && values.maxSensitivity === 'RESTRICTED';
    let row = null;
    if (unrestricted) await this.db.delete(staffScopes).where(eq(staffScopes.userId, userId));
    else [row] = await this.db.insert(staffScopes).values(values).onConflictDoUpdate({ target: staffScopes.userId, set: values }).returning();
    await this.auth.revokeAllSessions(userId, 'access scope changed');
    await this.audit.log({ actorId: user.sub, action: 'staff.scope', entityType: 'user', entityId: userId, before: before || null, after: row });
    return row || { userId, unrestricted: true };
  }

  /** Access revocation in one step: account disabled, every session ended, every grant revoked. */
  async setStatus(user: JwtPayload, userId: string, status: 'ACTIVE' | 'DISABLED', reason: string, stepUp?: StepUp) {
    return this.iam.setStatus(user, userId, { status, reason, stepUp });
  }

  /** @deprecated replaced by IamService.setStatus */
  async setStatusLegacy(user: JwtPayload, userId: string, status: 'ACTIVE' | 'DISABLED', reason: string) {
    assertCan(user, 'security.manage');
    if (userId === user.sub) throw new BadRequestException('You cannot change your own status');
    const [t] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!t) throw new NotFoundException();
    if (t.roles.includes('PLATFORM_ADMIN') && !effectiveRoles(user).includes('PLATFORM_ADMIN')) throw new ForbiddenException('Only a platform admin can disable a platform admin');
    await this.db.update(users).set({ status, statusReason: reason }).where(eq(users.id, userId));
    let revoked = 0;
    if (status === 'DISABLED') {
      revoked = (await this.auth.revokeAllSessions(userId, `disabled: ${reason}`)).revoked;
      await this.db.update(accessGrants).set({ revokedAt: new Date(), revokedById: user.sub }).where(and(eq(accessGrants.userId, userId), isNull(accessGrants.revokedAt)));
    }
    await this.audit.log({ actorId: user.sub, action: status === 'DISABLED' ? 'staff.disable' : 'staff.enable', entityType: 'user', entityId: userId, before: { status: t.status }, after: { status }, reason });
    return { userId, status, sessionsRevoked: revoked };
  }

  async resetMfa(user: JwtPayload, userId: string, reason: string) {
    assertCan(user, 'security.manage');
    await this.db.update(users).set({ mfaEnabledAt: null, mfaSecret: null, mfaRecoveryCodes: [] }).where(eq(users.id, userId));
    await this.auth.revokeAllSessions(userId, 'MFA reset');
    await this.audit.log({ actorId: user.sub, action: 'staff.mfa_reset', entityType: 'user', entityId: userId, reason });
    return { ok: true };
  }

  async revokeUserSessions(user: JwtPayload, userId: string, reason: string, sessionId?: string) {
    assertCan(user, 'security.manage');
    if (sessionId) await this.auth.revokeSessionRow(sessionId, reason);
    const r = sessionId ? { revoked: 1 } : await this.auth.revokeAllSessions(userId, reason);
    await this.audit.log({ actorId: user.sub, action: 'staff.sessions_revoke', entityType: 'user', entityId: userId, after: r, reason });
    return r;
  }

  // ───── emergency (break-glass) access ─────

  async requestEmergency(user: JwtPayload, input: { roles: RoleName[]; minutes: number; reason: string; ticketRef?: string }) {
    if (!user.roles.some(isStaffRole)) throw new ForbiddenException('Emergency access is for platform staff');
    const cfg = await this.settings.getObject('security.emergency', EMERGENCY_DEFAULTS);
    if (!input.reason || input.reason.trim().length < 10) throw new BadRequestException({ message: 'Explain the emergency (at least 10 characters)', code: 'REASON_REQUIRED' });
    const bad = input.roles.filter((r) => !cfg.grantableRoles.includes(r));
    if (bad.length || !input.roles.length) throw new ForbiddenException(`Not available through emergency access: ${bad.join(', ') || 'no roles'}`);
    const minutes = Math.min(Math.max(5, input.minutes), cfg.maxMinutes);
    const [g] = await this.db.insert(accessGrants).values({ kind: 'EMERGENCY', userId: user.sub, roles: input.roles, reason: input.reason.trim(), ticketRef: input.ticketRef ?? null, expiresAt: new Date(Date.now() + minutes * 60_000), readOnly: 0 }).returning();
    await this.audit.log({ actorId: user.sub, action: 'access.emergency_start', entityType: 'access_grant', entityId: g.id, after: { roles: g.roles, expiresAt: g.expiresAt }, reason: g.reason });
    const admins = await this.db.select({ id: users.id }).from(users).where(and(sql`'PLATFORM_ADMIN' = any(${users.roles})`, eq(users.status, 'ACTIVE')));
    for (const a of admins) if (a.id !== user.sub) await this.notify.queue({ userId: a.id, template: 'access.emergency', payload: { email: user.email, roles: g.roles, until: g.expiresAt, reason: g.reason }, channels: ['EMAIL', 'PUSH', 'IN_APP'], dedupeKey: `emergency:${g.id}` });
    return { grant: g, ...(await this.auth.reissue(user)) };
  }

  /** End a grant early. Ending someone else's grant also ends their sessions so the elevated token stops working. */
  async endGrant(user: JwtPayload, grantId: string) {
    const [g] = await this.db.select().from(accessGrants).where(eq(accessGrants.id, grantId)).limit(1);
    if (!g) throw new NotFoundException();
    if (g.userId !== user.sub) assertCan(user, 'security.manage');
    await this.db.update(accessGrants).set({ revokedAt: new Date(), revokedById: user.sub }).where(and(eq(accessGrants.id, grantId), isNull(accessGrants.revokedAt)));
    await this.audit.log({ actorId: user.sub, action: `access.${g.kind.toLowerCase()}_end`, entityType: 'access_grant', entityId: grantId });
    if (g.userId === user.sub) return { ok: true, ...(await this.auth.reissue(user)) };
    await this.auth.revokeAllSessions(g.userId, 'grant ended by security');
    return { ok: true };
  }

  async reviewGrant(user: JwtPayload, grantId: string, note: string) {
    assertCan(user, 'security.manage');
    const [g] = await this.db.update(accessGrants).set({ reviewedAt: new Date(), reviewedById: user.sub, reviewNote: note }).where(eq(accessGrants.id, grantId)).returning();
    if (!g) throw new NotFoundException();
    if (g.userId === user.sub) throw new BadRequestException('Someone else must review your grant');
    await this.audit.log({ actorId: user.sub, action: 'access.review', entityType: 'access_grant', entityId: grantId, reason: note });
    return g;
  }

  async listGrants(user: JwtPayload, q: { kind?: string; active?: boolean; unreviewed?: boolean }) {
    const mine = !can(user, 'security.read');
    const conds = [];
    if (mine) conds.push(eq(accessGrants.userId, user.sub));
    if (q.kind) conds.push(eq(accessGrants.kind, q.kind));
    if (q.active) conds.push(and(isNull(accessGrants.revokedAt), gt(accessGrants.expiresAt, new Date())));
    if (q.unreviewed) conds.push(isNull(accessGrants.reviewedAt));
    return this.db
      .select({ g: accessGrants, email: users.email, org: organizations.name })
      .from(accessGrants)
      .innerJoin(users, eq(users.id, accessGrants.userId))
      .leftJoin(organizations, eq(organizations.id, accessGrants.organizationId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(accessGrants.createdAt))
      .limit(200)
      .then((rows) => rows.map((r) => ({ ...r.g, email: r.email, organizationName: r.org })));
  }

  // ───── support access ("view as merchant") ─────

  async startSupportAccess(user: JwtPayload, input: { organizationId: string; minutes?: number; reason: string; readOnly?: boolean }) {
    assertCan(user, 'merchants.read');
    if (input.readOnly === false) assertCan(user, 'merchants.manage');
    if (!staffCovers(user, input.organizationId)) throw new ForbiddenException('Outside your access scope');
    if (!input.reason || input.reason.trim().length < 5) throw new BadRequestException({ message: 'A reason is required', code: 'REASON_REQUIRED' });
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);
    if (!org) throw new NotFoundException();
    await this.db.update(accessGrants).set({ revokedAt: new Date(), revokedById: user.sub }).where(and(eq(accessGrants.userId, user.sub), eq(accessGrants.kind, 'SUPPORT'), isNull(accessGrants.revokedAt)));
    const minutes = Math.min(Math.max(5, input.minutes || 60), 240);
    const [g] = await this.db.insert(accessGrants).values({ kind: 'SUPPORT', userId: user.sub, organizationId: org.id, readOnly: input.readOnly === false ? 0 : 1, reason: input.reason.trim(), expiresAt: new Date(Date.now() + minutes * 60_000) }).returning();
    await this.audit.log({ organizationId: org.id, actorId: user.sub, action: 'access.support_start', entityType: 'access_grant', entityId: g.id, after: { readOnly: g.readOnly === 1, expiresAt: g.expiresAt }, reason: g.reason });
    return { grant: g, organization: { id: org.id, name: org.name }, ...(await this.auth.reissue(user)) };
  }

  // ───── organization structure ─────

  async structure(user: JwtPayload) {
    assertCan(user, 'merchants.read');
    const [regs, orgs, locs, sellers, brandRows, kits] = await Promise.all([
      this.db.select().from(regions).orderBy(regions.name),
      this.db.select({ id: organizations.id, name: organizations.name, kind: organizations.kind, status: organizations.status, parentId: organizations.parentId }).from(organizations).orderBy(organizations.name).limit(1000),
      this.db.select({ id: locations.id, name: locations.name, city: locations.city, organizationId: locations.organizationId, regionId: locations.regionId, status: locations.status, platformOperated: locations.platformOperated, kitchenId: locations.kitchenId, legalSellerId: locations.legalSellerId }).from(locations).limit(5000),
      this.db.select({ id: legalSellers.id, legalName: legalSellers.legalName, organizationId: legalSellers.organizationId, country: legalSellers.country }).from(legalSellers),
      this.db.select({ id: brands.id, name: brands.name, organizationId: brands.organizationId }).from(brands),
      this.db.select({ id: kitchens.id, name: kitchens.name, organizationId: kitchens.organizationId, isShared: kitchens.isShared }).from(kitchens),
    ]);
    const visible = (orgId: string, locId?: string) => staffCovers(user, orgId, locId);
    const vLocs = locs.filter((l) => visible(l.organizationId, l.id));
    const vOrgIds = new Set([...orgs.filter((o) => visible(o.id)).map((o) => o.id)]);
    const regionNode = (r: (typeof regs)[number] | null) => {
      const inRegion = vLocs.filter((l) => (r ? l.regionId === r.id : !l.regionId));
      return {
        region: r,
        foodHalls: inRegion.filter((l) => l.platformOperated).map((l) => ({ ...l, kitchen: kits.find((k) => k.id === l.kitchenId) || null, brands: brandRows.filter((b) => b.organizationId === l.organizationId) })),
        merchants: Array.from(new Set(inRegion.filter((l) => !l.platformOperated).map((l) => l.organizationId))).map((orgId) => ({ org: orgs.find((o) => o.id === orgId), locations: inRegion.filter((l) => l.organizationId === orgId && !l.platformOperated) })),
      };
    };
    return {
      companies: orgs.filter((o) => !o.parentId && vOrgIds.has(o.id) && orgs.some((c) => c.parentId === o.id)).map((o) => ({ ...o, children: orgs.filter((c) => c.parentId === o.id) })),
      legalEntities: sellers.filter((s) => vOrgIds.has(s.organizationId)).map((s) => ({ ...s, organizationName: orgs.find((o) => o.id === s.organizationId)?.name })),
      regions: [...regs.map((r) => regionNode(r)), regionNode(null)].filter((n) => n.region || n.foodHalls.length || n.merchants.length),
      brands: brandRows.filter((b) => vOrgIds.has(b.organizationId)).map((b) => ({ ...b, organizationName: orgs.find((o) => o.id === b.organizationId)?.name })),
      counts: { regions: regs.length, organizations: vOrgIds.size, locations: vLocs.length, foodHalls: vLocs.filter((l) => l.platformOperated).length, brands: brandRows.length, legalEntities: sellers.length },
    };
  }

  async listRegions() {
    const rows = await this.db.select({ r: regions, n: sql<number>`(select count(*) from locations l where l.region_id = ${regions.id})::int` }).from(regions).orderBy(regions.name);
    return rows.map((x) => ({ ...x.r, locations: x.n }));
  }

  async upsertRegion(user: JwtPayload, input: { id?: string; code: string; name: string; parentId?: string | null; timezone?: string }) {
    assertCan(user, 'merchants.manage');
    const values = { code: input.code.toUpperCase(), name: input.name, parentId: input.parentId ?? null, timezone: input.timezone || 'America/New_York' };
    const [row] = input.id ? await this.db.update(regions).set(values).where(eq(regions.id, input.id)).returning() : await this.db.insert(regions).values(values).returning();
    await this.audit.log({ actorId: user.sub, action: input.id ? 'region.update' : 'region.create', entityType: 'region', entityId: row.id, after: row });
    return row;
  }

  async assignLocationRegion(user: JwtPayload, locationId: string, regionId: string | null) {
    assertCan(user, 'merchants.manage');
    const [before] = await this.db.select({ regionId: locations.regionId, organizationId: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!before) throw new NotFoundException();
    await this.db.update(locations).set({ regionId }).where(eq(locations.id, locationId));
    await this.audit.log({ organizationId: before.organizationId, actorId: user.sub, action: 'location.region', entityType: 'location', entityId: locationId, before, after: { regionId } });
    return { ok: true };
  }

  async setParentOrg(user: JwtPayload, orgId: string, parentId: string | null) {
    assertCan(user, 'merchants.manage');
    if (parentId === orgId) throw new BadRequestException('An organization cannot be its own parent');
    await this.db.update(organizations).set({ parentId }).where(eq(organizations.id, orgId));
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'org.parent', entityType: 'organization', entityId: orgId, after: { parentId } });
    return { ok: true };
  }

  // ───── audit history ─────

  async searchAudit(user: JwtPayload, q: { actorId?: string; actor?: string; action?: string; entityType?: string; entityId?: string; organizationId?: string; from?: string; to?: string; withReason?: boolean; limit?: number }) {
    assertCan(user, 'security.read');
    const conds = [];
    if (q.actorId) conds.push(eq(auditLogs.actorId, q.actorId));
    if (q.actor) conds.push(ilike(users.email, `%${q.actor}%`));
    if (q.action) conds.push(ilike(auditLogs.action, `${q.action}%`));
    if (q.entityType) conds.push(eq(auditLogs.entityType, q.entityType));
    if (q.entityId) conds.push(eq(auditLogs.entityId, q.entityId));
    if (q.organizationId) conds.push(eq(auditLogs.organizationId, q.organizationId));
    if (q.from) conds.push(gte(auditLogs.createdAt, new Date(q.from)));
    if (q.to) conds.push(lte(auditLogs.createdAt, new Date(q.to)));
    if (q.withReason) conds.push(sql`${auditLogs.reason} is not null`);
    const rows = await this.db
      .select({ a: auditLogs, email: users.email })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(q.limit || 200, 5000));
    return rows.map((r) => ({ ...r.a, actorEmail: r.email }));
  }

  async exportAudit(user: JwtPayload, q: Parameters<SecurityService['searchAudit']>[1]) {
    const rows = await this.searchAudit(user, { ...q, limit: 5000 });
    await this.audit.log({ actorId: user.sub, action: 'audit.export', entityType: 'audit_log', entityId: 'export', after: { filters: q, rows: rows.length } });
    const head = ['createdAt', 'actorEmail', 'action', 'entityType', 'entityId', 'organizationId', 'reason', 'ip', 'grantId', 'requestId', 'before', 'after'];
    return [head.join(','), ...rows.map((r) => head.map((h) => csvCell((r as Record<string, unknown>)[h] instanceof Date ? ((r as Record<string, unknown>)[h] as Date).toISOString() : (r as Record<string, unknown>)[h])).join(','))].join('\n');
  }

  /** Counts for the security overview tiles. */
  async overview(user: JwtPayload) {
    assertCan(user, 'security.read');
    const staff = await this.listStaff(user);
    const unreviewed = await this.db.select({ n: sql<number>`count(*)::int` }).from(accessGrants).where(and(eq(accessGrants.kind, 'EMERGENCY'), isNull(accessGrants.reviewedAt)));
    const required = await this.settings.get<string[]>('security.mfa_required_roles', []);
    return {
      staff: staff.length,
      withoutMfa: staff.filter((s) => !s.mfaEnabled && s.status === 'ACTIVE').length,
      disabled: staff.filter((s) => s.status === 'DISABLED').length,
      scoped: staff.filter((s) => s.scope).length,
      activeEmergency: staff.reduce((n, s) => n + s.activeGrants.filter((g) => g.kind === 'EMERGENCY').length, 0),
      unreviewedEmergency: unreviewed[0].n,
      mfaRequiredRoles: required,
      sso: await this.auth.ssoConfig(),
    };
  }

  // ───── security settings: SSO, MFA policy, session policy, emergency policy ─────

  async securitySettings(user: JwtPayload) {
    assertCan(user, 'security.read');
    const sso = await this.settings.get<SsoConfig | null>('security.sso', null);
    return {
      sso: sso ? { ...sso, clientSecretEnc: undefined, hasClientSecret: !!sso.clientSecretEnc } : { enabled: false, issuer: '', clientId: '', redirectUri: '', allowedDomains: [], label: 'Single sign-on', hasClientSecret: false },
      mfaRequiredRoles: await this.settings.get<string[]>('security.mfa_required_roles', []),
      sessions: await this.settings.getObject('security.sessions', SESSION_DEFAULTS),
      emergency: await this.settings.getObject('security.emergency', EMERGENCY_DEFAULTS),
    };
  }

  private async put(user: JwtPayload, key: string, value: unknown, redact = false) {
    const [before] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
    await this.db.insert(platformSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: platformSettings.key, set: { value: value as never } });
    await this.audit.configChange({ key, before: redact ? '[redacted]' : before?.value, after: redact ? '[redacted]' : value, actorId: user.sub, approvedById: user.sub });
    await this.redis.del(`setting:${key}`);
  }

  async updateSecuritySettings(user: JwtPayload, input: { sso?: Partial<SsoConfig> & { clientSecret?: string }; mfaRequiredRoles?: string[]; sessions?: Partial<typeof SESSION_DEFAULTS>; emergency?: Partial<typeof EMERGENCY_DEFAULTS> }) {
    assertCan(user, 'security.manage');
    if (input.sso) {
      const cur = (await this.settings.get<SsoConfig | null>('security.sso', null)) || { enabled: false, issuer: '', clientId: '', redirectUri: '', allowedDomains: [], label: 'Single sign-on' };
      const { clientSecret, ...rest } = input.sso;
      const next: SsoConfig = { ...cur, ...rest, clientSecretEnc: clientSecret ? this.crypto.encrypt(clientSecret) : cur.clientSecretEnc };
      if (next.enabled && (!next.issuer || !next.clientId || !next.redirectUri)) throw new BadRequestException('Issuer, client id and redirect URI are required to turn on SSO');
      await this.put(user, 'security.sso', next, true);
    }
    if (input.mfaRequiredRoles) {
      const bad = input.mfaRequiredRoles.filter((r) => !isStaffRole(r));
      if (bad.length) throw new BadRequestException(`Not staff roles: ${bad.join(', ')}`);
      await this.put(user, 'security.mfa_required_roles', input.mfaRequiredRoles);
    }
    if (input.sessions) await this.put(user, 'security.sessions', { ...(await this.settings.getObject('security.sessions', SESSION_DEFAULTS)), ...input.sessions });
    if (input.emergency) {
      const next = { ...(await this.settings.getObject('security.emergency', EMERGENCY_DEFAULTS)), ...input.emergency };
      if (next.grantableRoles.includes('PLATFORM_ADMIN') && !effectiveRoles(user).includes('PLATFORM_ADMIN')) throw new ForbiddenException('Only a platform admin can make platform admin available through emergency access');
      await this.put(user, 'security.emergency', next);
    }
    return this.securitySettings(user);
  }

  async orgsLookup(user: JwtPayload, q?: string) {
    assertCan(user, 'merchants.read');
    const rows = await this.db.select({ id: organizations.id, name: organizations.name, status: organizations.status }).from(organizations).where(q ? or(ilike(organizations.name, `%${q}%`)) : undefined).orderBy(organizations.name).limit(50);
    return rows.filter((o) => staffCovers(user, o.id));
  }
}
