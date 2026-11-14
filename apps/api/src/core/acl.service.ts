import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ALL_PERMISSIONS,
  BLOCKED_STATUSES,
  coarseFromFine,
  isStaffRole,
  STAFF_ROLE_LABELS,
  STAFF_ROLES,
  SYSTEM_ROLE_DESCRIPTIONS,
  systemRolePermissions,
  type Permission,
  type Sensitivity,
  type StaffRole,
} from '@gutad/shared';
import { DB, Db } from '../db/db.module';
import { accessGrants, accessRoles, apiKeys, brands, locations, organizations, refreshTokens, roleAssignments, serviceAccounts, staffScopes, userSessions, users } from '../db/schema';
import { RedisService } from './redis.service';
import { SettingsService } from './settings.service';
import { CryptoService } from './crypto.service';
import type { JwtPayload, RoleName } from '../common/auth';

export const SESSION_POLICY_DEFAULTS = { staffTokenMinutes: 720, staffIdleMinutes: 480, staffMaxHours: 72 };

export interface AclRole { id: string; key: string; name: string; kind: string; primary: boolean; endsAt: string | null; source: 'assignment' | 'legacy' | 'emergency' }

/** Everything the guards need to authorize one person right now. Cached in Redis, rebuilt on any access change. */
export interface Acl {
  staff: boolean;
  crossTenant: boolean;
  status: string;
  roles: AclRole[];
  /** platform role enum values held (built-in roles), for code that checks roles directly */
  staffRoles: RoleName[];
  fine: string[];
  coarse: Permission[];
  /** approval authority per kind (cents); a missing kind means no cap */
  limits: Record<string, number>;
  superadmin: boolean;
  mfaRequired: boolean;
  scope?: JwtPayload['scope'];
  teams: string[];
  emergencyGrantId: string | null;
  idleMinutes: number;
  /** epoch ms after which the cache entry must be rebuilt (next scheduled start / expiry) */
  until: number;
}

const ACL_TTL_MS = 60_000;
const NO_LOCATION = '00000000-0000-0000-0000-000000000000';

/**
 * Live access control: combines role assignments (with their time windows), built-in roles on the user row,
 * emergency grants, scope and status into one cached record. The auth guard attaches it to every staff request,
 * so role, permission, scope and status changes apply at once without signing anyone out.
 */
@Injectable()
export class AclService implements OnApplicationBootstrap {
  private readonly log = new Logger(AclService.name);
  constructor(@Inject(DB) private readonly db: Db, private readonly redis: RedisService, private readonly settings: SettingsService, private readonly crypto: CryptoService) {}

  async onApplicationBootstrap() {
    await this.bootstrap().catch((e) => this.log.warn(`IAM bootstrap skipped: ${(e as Error).message}`));
  }

  /** Idempotent: built-in roles exist as SYSTEM rows; people holding built-in roles have matching assignments. */
  async bootstrap() {
    const lock = await this.redis.client.set('lock:iam-bootstrap', '1', 'EX', 60, 'NX').catch(() => 'OK');
    if (lock !== 'OK') return;
    const existing = await this.db.select({ key: accessRoles.key }).from(accessRoles).where(eq(accessRoles.kind, 'SYSTEM'));
    const have = new Set(existing.map((r) => r.key));
    for (const key of STAFF_ROLES) {
      if (have.has(key)) continue;
      await this.db
        .insert(accessRoles)
        .values({ key, name: STAFF_ROLE_LABELS[key], description: SYSTEM_ROLE_DESCRIPTIONS[key], kind: 'SYSTEM', permissions: systemRolePermissions(key), requestable: key !== 'PLATFORM_ADMIN' })
        .onConflictDoNothing();
    }
    // PLATFORM_ADMIN always carries every permission (new permissions included)
    await this.db.update(accessRoles).set({ permissions: systemRolePermissions('PLATFORM_ADMIN') }).where(eq(accessRoles.key, 'PLATFORM_ADMIN'));
    await this.backfillAssignments();
  }

  /** People with a built-in role on their user row and no assignment record for it get one (startup and seed safety). */
  async backfillAssignments() {
    const roles = await this.db.select({ id: accessRoles.id, key: accessRoles.key }).from(accessRoles).where(eq(accessRoles.kind, 'SYSTEM'));
    const byKey = new Map(roles.map((r) => [r.key, r.id]));
    const staff = await this.db.select({ id: users.id, roles: users.roles }).from(users).where(sql`${users.roles} && array[${sql.raw(STAFF_ROLES.map((r) => `'${r}'`).join(','))}]::role[]`);
    if (!staff.length) return 0;
    const rows = await this.db.select({ userId: roleAssignments.userId, roleId: roleAssignments.roleId }).from(roleAssignments).where(inArray(roleAssignments.userId, staff.map((s) => s.id)));
    const seen = new Set(rows.map((r) => `${r.userId}:${r.roleId}`));
    let n = 0;
    for (const u of staff) {
      for (const k of u.roles.filter(isStaffRole)) {
        const roleId = byKey.get(k);
        if (!roleId || seen.has(`${u.id}:${roleId}`)) continue;
        await this.db.insert(roleAssignments).values({ userId: u.id, roleId, reason: 'Existing role (IAM migration)', isPrimary: false });
        n++;
      }
    }
    return n;
  }

  private key(userId: string, ver: string) {
    return `acl:${ver}:${userId}`;
  }
  private async ver() {
    return (await this.redis.client.get('acl:ver').catch(() => null)) || '0';
  }

  /** Every cached ACL is stale (role permissions changed, policy changed). */
  async invalidateAll() {
    await this.redis.client.incr('acl:ver').catch(() => undefined);
  }
  async invalidate(...userIds: string[]) {
    const v = await this.ver();
    if (userIds.length) await this.redis.del(...userIds.map((u) => this.key(u, v))).catch(() => undefined);
  }

  async get(userId: string): Promise<Acl> {
    const v = await this.ver();
    const cached = await this.redis.getJson<Acl>(this.key(userId, v)).catch(() => null);
    if (cached && cached.until > Date.now()) return cached;
    const acl = await this.compute(userId);
    const ttl = Math.max(1, Math.ceil((acl.until - Date.now()) / 1000));
    await this.redis.setJson(this.key(userId, v), acl, ttl).catch(() => undefined);
    return acl;
  }

  async compute(userId: string, at = new Date()): Promise<Acl> {
    const now = at.getTime();
    const [u] = await this.db.select({ id: users.id, status: users.status, roles: users.roles }).from(users).where(eq(users.id, userId)).limit(1);
    let until = now + ACL_TTL_MS;
    const empty: Acl = { staff: false, crossTenant: false, status: u?.status || 'MISSING', roles: [], staffRoles: [], fine: [], coarse: [], limits: {}, superadmin: false, mfaRequired: false, teams: [], emergencyGrantId: null, idleMinutes: SESSION_POLICY_DEFAULTS.staffIdleMinutes, until };
    if (!u) return empty;
    const rows = await this.db
      .select({ a: roleAssignments, r: accessRoles })
      .from(roleAssignments)
      .innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    const svc = await this.db.select().from(serviceAccounts).where(eq(serviceAccounts.userId, userId)).limit(1);
    const held: { role: typeof accessRoles.$inferSelect; a?: typeof roleAssignments.$inferSelect; source: AclRole['source'] }[] = [];
    for (const { a, r } of rows) {
      if (a.revokedAt || r.status !== 'ACTIVE') continue;
      const start = a.startsAt.getTime();
      const end = a.endsAt?.getTime();
      if (start > now) { until = Math.min(until, start); continue; }
      if (end !== undefined && end <= now) continue;
      if (end !== undefined) until = Math.min(until, end);
      held.push({ role: r, a, source: 'assignment' });
    }
    // built-in roles on the user row that were never managed through assignments (seed, legacy) still count
    const everAssigned = new Set(rows.map((x) => x.r.key));
    const legacyKeys = u.roles.filter((k) => isStaffRole(k) && !everAssigned.has(k));
    if (legacyKeys.length) {
      const sys = await this.db.select().from(accessRoles).where(inArray(accessRoles.key, legacyKeys));
      for (const k of legacyKeys) {
        const r = sys.find((x) => x.key === k) || ({ id: k, key: k, name: STAFF_ROLE_LABELS[k as StaffRole], kind: 'SYSTEM', status: 'ACTIVE', permissions: systemRolePermissions(k as StaffRole), approvalLimits: {}, mfaRequired: false } as unknown as typeof accessRoles.$inferSelect);
        held.push({ role: r, source: 'legacy' });
      }
    }
    // emergency (break-glass) grants add their roles until they expire
    const grants = await this.db.select().from(accessGrants).where(and(eq(accessGrants.userId, userId), eq(accessGrants.kind, 'EMERGENCY'), isNull(accessGrants.revokedAt), gt(accessGrants.expiresAt, at)));
    let emergencyGrantId: string | null = null;
    if (grants.length) {
      const g = grants[0];
      emergencyGrantId = g.id;
      until = Math.min(until, g.expiresAt.getTime());
      const er = await this.db.select().from(accessRoles).where(inArray(accessRoles.key, g.roles));
      for (const k of g.roles) {
        const r = er.find((x) => x.key === k);
        if (r) held.push({ role: r, source: 'emergency', a: { endsAt: g.expiresAt, kind: 'EMERGENCY', isPrimary: false } as typeof roleAssignments.$inferSelect });
      }
    }
    const blocked = BLOCKED_STATUSES.includes(u.status);
    const policy = await this.settings.getObject('security.sessions', SESSION_POLICY_DEFAULTS);
    if (blocked) return { ...empty, until };
    if (svc[0]) {
      // service accounts: their own permission list and organization scope
      const s = svc[0];
      const active = s.status === 'ACTIVE';
      const fine = active ? s.permissions : [];
      return { ...empty, staff: active, crossTenant: active, status: active ? 'ACTIVE' : s.status, fine, coarse: coarseFromFine(fine), scope: { orgIds: s.organizationIds, locationIds: s.organizationIds.length ? [NO_LOCATION] : [], locOrgIds: [], max: 'RESTRICTED' }, until };
    }
    const superadmin = held.some((h) => h.role.key === 'PLATFORM_ADMIN');
    const fine = superadmin ? systemRolePermissions('PLATFORM_ADMIN') : Array.from(new Set(held.flatMap((h) => h.role.permissions)));
    const coarse = superadmin ? [...ALL_PERMISSIONS] : coarseFromFine(fine);
    const limits: Record<string, number> = {};
    if (!superadmin) {
      for (const h of held) for (const [k, val] of Object.entries((h.role.approvalLimits || {}) as Record<string, number>)) if (typeof val === 'number') limits[k] = Math.max(limits[k] ?? 0, val);
    }
    const mfaKeys = await this.settings.get<string[]>('security.mfa_required_roles', []);
    const roleList: AclRole[] = held.map((h) => ({ id: h.role.id, key: h.role.key, name: h.role.name, kind: h.a?.kind || 'STANDARD', primary: !!h.a?.isPrimary, endsAt: h.a?.endsAt ? new Date(h.a.endsAt).toISOString() : null, source: h.source }));
    const keys = Array.from(new Set(roleList.map((r) => r.key)));
    const staff = keys.length > 0;
    const sc = staff ? await this.scope(userId) : undefined;
    return {
      staff,
      crossTenant: keys.some((k) => k !== 'DISPATCHER'),
      status: u.status,
      roles: roleList,
      staffRoles: keys.filter(isStaffRole) as RoleName[],
      fine,
      coarse,
      limits,
      superadmin,
      mfaRequired: held.some((h) => h.role.mfaRequired) || keys.some((k) => mfaKeys.includes(k)),
      scope: sc?.scope,
      teams: sc?.teams || [],
      emergencyGrantId,
      idleMinutes: policy.staffIdleMinutes,
      until,
    };
  }

  /** Staff scope with regions, companies, kitchens and brands expanded to organizations and locations. */
  async scope(userId: string): Promise<{ scope: JwtPayload['scope']; teams: string[] } | undefined> {
    const [sc] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    if (!sc) return undefined;
    let orgIds = [...sc.organizationIds];
    if (sc.companyIds.length) {
      const kids = await this.db.select({ id: organizations.id }).from(organizations).where(or(inArray(organizations.parentId, sc.companyIds), inArray(organizations.id, sc.companyIds)));
      orgIds.push(...kids.map((k) => k.id));
    }
    if (sc.brandIds.length) {
      const bs = await this.db.select({ org: brands.organizationId }).from(brands).where(inArray(brands.id, sc.brandIds));
      orgIds.push(...bs.map((b) => b.org));
    }
    orgIds = Array.from(new Set(orgIds));
    let locIds = [...sc.locationIds];
    const conds = [];
    if (sc.regionIds.length) conds.push(inArray(locations.regionId, sc.regionIds));
    if (sc.kitchenIds.length) conds.push(inArray(locations.kitchenId, sc.kitchenIds));
    if (locIds.length) conds.push(inArray(locations.id, locIds));
    const locs = conds.length ? await this.db.select({ id: locations.id, org: locations.organizationId }).from(locations).where(or(...conds)) : [];
    locIds = Array.from(new Set([...locIds, ...locs.map((l) => l.id)]));
    const restrictsPlaces = sc.regionIds.length || sc.kitchenIds.length || sc.locationIds.length || sc.companyIds.length || sc.brandIds.length || sc.organizationIds.length;
    if (restrictsPlaces && !locIds.length && !orgIds.length) locIds = [NO_LOCATION]; // scoped to places with nothing in them yet
    return { scope: { orgIds, locationIds: locIds, locOrgIds: Array.from(new Set(locs.map((l) => l.org))), max: sc.maxSensitivity as Sensitivity }, teams: sc.teams };
  }

  // ───── roles mirror: built-in roles stay on users.roles for code that checks roles directly ─────

  /** Rewrites the built-in staff roles on the user row from active assignments (keeps non-staff roles). */
  async syncUserRoles(userId: string) {
    const acl = await this.compute(userId);
    const [u] = await this.db.select({ roles: users.roles }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return;
    const fromAssignments = acl.roles.filter((r) => r.source === 'assignment' || r.source === 'legacy').map((r) => r.key).filter(isStaffRole);
    const next = Array.from(new Set([...u.roles.filter((r) => !isStaffRole(r)), ...fromAssignments]));
    if (next.sort().join() !== [...u.roles].sort().join()) await this.db.update(users).set({ roles: next as never }).where(eq(users.id, userId));
    await this.invalidate(userId);
  }

  /** Active superadmins (assignment or legacy), optionally excluding one person. */
  async activeSuperadmins(excludeUserId?: string): Promise<string[]> {
    const [role] = await this.db.select({ id: accessRoles.id }).from(accessRoles).where(eq(accessRoles.key, 'PLATFORM_ADMIN')).limit(1);
    const now = new Date();
    const viaAssign = role
      ? await this.db
          .select({ id: roleAssignments.userId })
          .from(roleAssignments)
          .innerJoin(users, eq(users.id, roleAssignments.userId))
          .where(and(eq(roleAssignments.roleId, role.id), isNull(roleAssignments.revokedAt), lte(roleAssignments.startsAt, now), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, now)), eq(users.status, 'ACTIVE')))
      : [];
    const viaRow = await this.db.select({ id: users.id }).from(users).where(and(sql`'PLATFORM_ADMIN' = any(${users.roles})`, eq(users.status, 'ACTIVE')));
    const ever = role ? new Set((await this.db.select({ id: roleAssignments.userId }).from(roleAssignments).where(eq(roleAssignments.roleId, role.id))).map((r) => r.id)) : new Set<string>();
    const ids = new Set([...viaAssign.map((r) => r.id), ...viaRow.filter((r) => !ever.has(r.id)).map((r) => r.id)]);
    if (excludeUserId) ids.delete(excludeUserId);
    return [...ids];
  }

  /** People who receive security notifications: superadmins and holders of a role that manages access. */
  async securityRecipients(): Promise<string[]> {
    const admins = await this.activeSuperadmins();
    const now = new Date();
    const managers = await this.db
      .select({ id: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId))
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(and(isNull(roleAssignments.revokedAt), lte(roleAssignments.startsAt, now), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, now)), eq(users.status, 'ACTIVE'), eq(accessRoles.status, 'ACTIVE'), sql`${accessRoles.permissions} && array['security:manage_access','security:edit']::text[]`));
    return Array.from(new Set([...admins, ...managers.map((m) => m.id)]));
  }

  /** Staff inactivity timeout, enforced on every request: idle sessions end; activity refreshes last-seen. */
  async touchSession(sid: string, idleMinutes: number): Promise<'ok' | 'idle'> {
    const k = `sess:seen:${sid}`;
    const now = Date.now();
    const last = Number(await this.redis.client.get(k)) || 0;
    if (last && now - last > idleMinutes * 60_000) {
      await this.redis.client.set(`sess:revoked:${sid}`, '1', 'EX', 7 * 86400).catch(() => undefined);
      await this.db.update(userSessions).set({ revokedAt: new Date(), revokedReason: 'idle timeout' }).where(and(eq(userSessions.id, sid), isNull(userSessions.revokedAt)));
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.sessionId, sid), isNull(refreshTokens.revokedAt)));
      return 'idle';
    }
    if (!last || now - last > 60_000) {
      await this.redis.client.set(k, String(now), 'EX', 30 * 86400);
      if (!last || now - last > 300_000) await this.db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, sid));
    }
    return 'ok';
  }

  // ───── API keys ─────

  /** Resolves `gsk_…` bearer keys to a service-account principal, or null. */
  async authenticateKey(raw: string, ip: string | null): Promise<JwtPayload | null> {
    const hash = this.crypto.sha256(raw);
    const cacheKey = `apikey:${hash}`;
    let hit = await this.redis.getJson<{ keyId: string; svcId: string; userId: string; email: string; expiresAt: string; allow: string[] } | { none: true }>(cacheKey).catch(() => null);
    if (!hit) {
      const [row] = await this.db
        .select({ k: apiKeys, s: serviceAccounts, email: users.email })
        .from(apiKeys)
        .innerJoin(serviceAccounts, eq(serviceAccounts.id, apiKeys.serviceAccountId))
        .innerJoin(users, eq(users.id, serviceAccounts.userId))
        .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
        .limit(1);
      hit = row && row.s.status === 'ACTIVE' ? { keyId: row.k.id, svcId: row.s.id, userId: row.s.userId, email: row.email, expiresAt: row.k.expiresAt.toISOString(), allow: row.s.ipAllowlist } : { none: true };
      await this.redis.setJson(cacheKey, hit, 60).catch(() => undefined);
    }
    if ('none' in hit) return null;
    if (new Date(hit.expiresAt).getTime() <= Date.now()) return null;
    if (hit.allow.length && (!ip || !hit.allow.some((a) => ip === a || ip.endsWith(`:${a}`)))) return null;
    const seenKey = `apikey:seen:${hit.keyId}`;
    if (!(await this.redis.client.exists(seenKey).catch(() => 1))) {
      await this.redis.client.set(seenKey, '1', 'EX', 60).catch(() => undefined);
      await this.db.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: ip }).where(eq(apiKeys.id, hit.keyId)).catch(() => undefined);
    }
    return { sub: hit.userId, email: hit.email, roles: [], orgs: {}, amr: ['api_key'], svc: { id: hit.svcId, keyId: hit.keyId } };
  }

  /** Forget cached key lookups (revocation, rotation, account disabled). */
  async forgetKeys(hashes: string[]) {
    if (hashes.length) await this.redis.del(...hashes.map((h) => `apikey:${h}`)).catch(() => undefined);
  }
}
