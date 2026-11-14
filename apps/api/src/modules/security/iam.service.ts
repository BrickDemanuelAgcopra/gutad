import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ALL_FINE_PERMISSIONS,
  APPROVAL_LIMIT_KINDS,
  BLOCKED_STATUSES,
  DEFAULT_ACCESS_POLICY,
  FIELD_PATH_RULES,
  IAM_RESOURCES,
  isPrivileged,
  isStaffRole,
  modulesFor,
  PERMISSIONS,
  SENSITIVITY,
  sensitivityOf,
  STAFF_ROLES,
  type AccessExplanation,
  type AccessPolicy,
  type Permission,
  type Sensitivity,
} from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import {
  accessGrants,
  accessRequests,
  accessReviews,
  accessRoles,
  apiKeys,
  approvalRequests,
  loginEvents,
  securityAlerts,
  incidents,
  merchantApplications,
  opsAlerts,
  organizations,
  roleAssignments,
  serviceAccounts,
  staffInvitations,
  staffProfiles,
  staffScopes,
  userSessions,
  users,
} from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { AclService } from '../../core/acl.service';
import { CryptoService } from '../../core/crypto.service';
import { NotifyService } from '../../core/notify.service';
import { SecurityEventsService } from '../../core/security-events.service';
import { SettingsService } from '../../core/settings.service';
import { RedisService } from '../../core/redis.service';
import { loadConfig } from '../../config/config';
import { token } from '../../common/utils';
import { assertCan, canFine, effectiveRoles, finePermissionsOf, JwtPayload, staffCovers } from '../../common/auth';
import { AuthService, type SessionMeta } from '../auth/auth.service';
import { ApprovalsService } from './approvals.service';

export type StepUp = { code?: string; password?: string } | null | undefined;
type Role = typeof accessRoles.$inferSelect;
type Assignment = typeof roleAssignments.$inferSelect;

export interface AssignInput {
  userIds: string[];
  roleId: string;
  kind?: 'STANDARD' | 'TEMPORARY' | 'ACTING';
  isPrimary?: boolean;
  responsibility?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  actingForUserId?: string | null;
  reason: string;
  stepUp?: StepUp;
  /** internal: an approved request or dual-control approval already covered the checks */
  sourceRequestId?: string | null;
}

export interface RolePatch {
  name?: string;
  description?: string;
  permissions?: string[];
  approvalLimits?: Record<string, number | null>;
  mfaRequired?: boolean;
  requestable?: boolean;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'role';
const now = () => new Date();
const isActiveWindow = (a: Assignment, at = Date.now()) => !a.revokedAt && a.startsAt.getTime() <= at && (!a.endsAt || a.endsAt.getTime() > at);

/**
 * Users, Roles & Permissions: staff accounts and invitations, custom roles and the permission matrix,
 * role assignments (scheduled, temporary, acting), superadmin safeguards, offboarding, sessions and
 * the effective-access preview.
 */
@Injectable()
export class IamService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly acl: AclService,
    private readonly auth: AuthService,
    private readonly approvals: ApprovalsService,
    private readonly events: SecurityEventsService,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    // critical access changes approved by a second superadmin run here
    this.approvals.register('ACCESS_CHANGE', {
      execute: async (req, approver) => {
        const p = req.payload as { op: string; input?: AssignInput; roleId?: string; patch?: RolePatch; requesterId?: string };
        const requester = { sub: req.requestedById, email: '', roles: ['PLATFORM_ADMIN'], orgs: {} } as JwtPayload;
        if (p.op === 'assign' && p.input) return this.assignNow(requester, { ...p.input, sourceRequestId: req.id }, approver.sub);
        if (p.op === 'role_update' && p.roleId && p.patch) return this.applyRolePatch(requester, p.roleId, p.patch, req.reason, approver.sub);
        throw new BadRequestException('Unknown access change');
      },
      canDecide: () => false,
    });
  }

  // ───── helpers & safeguards ─────

  policy() {
    return this.settings.getObject<AccessPolicy>('security.access_policy', DEFAULT_ACCESS_POLICY);
  }

  isSuperadmin(user: JwtPayload) {
    return !!user.acl?.superadmin || effectiveRoles(user).includes('PLATFORM_ADMIN');
  }

  private manage(user: JwtPayload, action: 'edit' | 'create' | 'delete' | 'manage_access' | 'approve' = 'edit') {
    assertCan(user, 'security.manage');
    if (!canFine(user, `security:${action}`)) throw new ForbiddenException({ message: `Requires permission: security:${action}`, code: 'PERMISSION_REQUIRED' });
  }

  /** Nobody grants permissions they do not hold themselves (superadmins hold everything). */
  private assertNoEscalation(user: JwtPayload, perms: readonly string[]) {
    if (this.isSuperadmin(user)) return;
    const mine = new Set(finePermissionsOf(user));
    const extra = perms.filter((p) => !mine.has(p));
    if (extra.length) throw new ForbiddenException({ message: `You cannot grant permissions you do not have: ${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}`, code: 'PRIVILEGE_ESCALATION' });
  }

  private async assertSuperadminGranter(user: JwtPayload) {
    if (!this.isSuperadmin(user)) throw new ForbiddenException({ message: 'Only a superadmin can grant or remove superadmin access', code: 'SUPERADMIN_ONLY' });
    const p = await this.policy();
    if (p.superadminGranters.length && !p.superadminGranters.includes(user.sub)) throw new ForbiddenException({ message: 'You are not on the list of people allowed to grant superadmin access', code: 'SUPERADMIN_GRANTER' });
  }

  /** Never leave the platform without an active superadmin. */
  async assertNotLastSuperadmin(targetUserId: string) {
    const acl = await this.acl.compute(targetUserId);
    if (!acl.superadmin) return;
    const others = await this.acl.activeSuperadmins(targetUserId);
    if (!others.length) throw new ConflictException({ message: 'This is the last active superadmin. Make someone else a superadmin first.', code: 'LAST_SUPERADMIN' });
  }

  /** Dual control: a second superadmin approves when the policy asks for it and one exists. */
  private async needsSecondApprover(user: JwtPayload) {
    const p = await this.policy();
    if (!p.requireSecondApprover) return false;
    return (await this.acl.activeSuperadmins(user.sub)).length > 0;
  }

  private async role(roleId: string) {
    const [r] = await this.db.select().from(accessRoles).where(eq(accessRoles.id, roleId)).limit(1);
    if (!r) throw new NotFoundException('Role not found');
    return r;
  }

  private async roleByKey(key: string) {
    const [r] = await this.db.select().from(accessRoles).where(eq(accessRoles.key, key)).limit(1);
    if (!r) throw new NotFoundException(`Role ${key} not found`);
    return r;
  }

  /** Staff user ids: anyone with an assignment, a staff profile or a built-in role (service accounts excluded). */
  private async staffIds(): Promise<string[]> {
    const rows = await this.db.execute(sql`
      select id from users where roles && array[${sql.raw(STAFF_ROLES.map((r) => `'${r}'`).join(','))}]::role[]
      union select user_id from role_assignments
      union select user_id from staff_profiles where kind = 'STAFF'
      except select user_id from service_accounts`);
    return (rows as unknown as { rows?: { id: string }[] }).rows?.map((r) => r.id) ?? (rows as unknown as { id: string }[]).map((r) => r.id);
  }

  private async userOr404(id: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  // ───── user directory ─────

  async listUsers(user: JwtPayload, q: { q?: string; status?: string; roleId?: string } = {}) {
    assertCan(user, 'security.read');
    const ids = await this.staffIds();
    if (!ids.length) return [];
    const conds = [inArray(users.id, ids)];
    if (q.q) conds.push(or(ilike(users.email, `%${q.q}%`), ilike(users.name, `%${q.q}%`))!);
    const rows = await this.db.select().from(users).where(and(...conds)).orderBy(users.email).limit(1000);
    const uids = rows.map((r) => r.id);
    if (!uids.length) return [];
    const [assigns, profiles, invites, sessions, scopes] = await Promise.all([
      this.db.select({ a: roleAssignments, r: accessRoles }).from(roleAssignments).innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId)).where(and(inArray(roleAssignments.userId, uids), isNull(roleAssignments.revokedAt))),
      this.db.select().from(staffProfiles).where(inArray(staffProfiles.userId, uids)),
      this.db.select().from(staffInvitations).where(and(inArray(staffInvitations.userId, uids), isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt))),
      this.db.select({ userId: userSessions.userId, n: sql<number>`count(*)::int`, last: sql<string>`max(${userSessions.lastSeenAt})` }).from(userSessions).where(and(inArray(userSessions.userId, uids), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, now()))).groupBy(userSessions.userId),
      this.db.select().from(staffScopes).where(inArray(staffScopes.userId, uids)),
    ]);
    const pol = await this.policy();
    const t = Date.now();
    const out = rows.map((u) => {
      const p = profiles.find((x) => x.userId === u.id);
      const inv = invites.find((x) => x.userId === u.id);
      const mine = assigns.filter((x) => x.a.userId === u.id && (!x.a.endsAt || x.a.endsAt.getTime() > t));
      const assigned = new Set(mine.map((x) => x.r.key));
      const legacy = u.roles.filter((k) => isStaffRole(k) && !assigned.has(k));
      const lastLogin = p?.lastLoginAt || null;
      const lastSeen = sessions.find((s) => s.userId === u.id)?.last || null;
      const activity = [lastLogin?.getTime() || 0, lastSeen ? new Date(lastSeen).getTime() : 0].reduce((a, b) => Math.max(a, b), 0);
      const invited = !!inv && !u.passwordHash;
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        phone: u.phone,
        status: invited && u.status === 'ACTIVE' ? 'INVITED' : u.status,
        statusReason: u.statusReason,
        title: p?.title ?? null,
        department: p?.department ?? null,
        team: p?.team ?? null,
        managerId: p?.managerId ?? null,
        employeeId: p?.employeeId ?? null,
        suspendedUntil: p?.suspendedUntil ?? null,
        mfaEnabled: !!u.mfaEnabledAt,
        lastLoginAt: lastLogin,
        lastSeenAt: lastSeen,
        sessions: sessions.find((s) => s.userId === u.id)?.n || 0,
        inactive: u.status === 'ACTIVE' && !invited && (activity ? t - activity > pol.inactiveDays * 86400_000 : t - u.createdAt.getTime() > pol.inactiveDays * 86400_000),
        invitation: inv ? { id: inv.id, expiresAt: inv.expiresAt, sentCount: inv.sentCount, lastSentAt: inv.lastSentAt } : null,
        scoped: !!scopes.find((s) => s.userId === u.id),
        roles: [
          ...mine.map((x) => ({ assignmentId: x.a.id, roleId: x.r.id, key: x.r.key, name: x.r.name, kind: x.a.kind, primary: x.a.isPrimary, responsibility: x.a.responsibility, startsAt: x.a.startsAt, endsAt: x.a.endsAt, state: x.a.startsAt.getTime() > t ? 'SCHEDULED' : 'ACTIVE' })),
          ...legacy.map((k) => ({ assignmentId: null, roleId: null, key: k, name: k, kind: 'STANDARD', primary: false, responsibility: null, startsAt: u.createdAt, endsAt: null, state: 'ACTIVE' })),
        ],
        createdAt: u.createdAt,
      };
    });
    return out.filter((u) => (!q.status || u.status === q.status) && (!q.roleId || u.roles.some((r) => r.roleId === q.roleId)));
  }

  async getUser(user: JwtPayload, id: string) {
    assertCan(user, 'security.read');
    const u = await this.userOr404(id);
    const list = (await this.listUsers(user, {})).find((x) => x.id === id);
    const [scope] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, id)).limit(1);
    const history = await this.db.select({ a: roleAssignments, r: accessRoles }).from(roleAssignments).innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId)).where(eq(roleAssignments.userId, id)).orderBy(desc(roleAssignments.createdAt)).limit(100);
    const grants = await this.db.select().from(accessGrants).where(eq(accessGrants.userId, id)).orderBy(desc(accessGrants.createdAt)).limit(30);
    return {
      ...(list || { id: u.id, email: u.email, name: u.name, status: u.status, roles: [] }),
      scope: scope || null,
      assignments: history.map((h) => ({ ...h.a, roleKey: h.r.key, roleName: h.r.name, state: h.a.revokedAt ? 'REVOKED' : h.a.endsAt && h.a.endsAt.getTime() <= Date.now() ? 'EXPIRED' : h.a.startsAt.getTime() > Date.now() ? 'SCHEDULED' : 'ACTIVE' })),
      sessions: await this.auth.listSessions(id),
      logins: await this.events.recentLogins(id, 20),
      grants,
      locked: !!(await this.lockedState(u.email)),
    };
  }

  private async lockedState(email: string) {
    return this.redis.client.exists(`login:lock:${email.toLowerCase()}`).catch(() => 0);
  }

  // ───── create, invite, import ─────

  private inviteLink(raw: string) {
    return `${loadConfig().PUBLIC_WEB_URL}/account/invite?token=${raw}`;
  }

  private async issueInvitation(actor: JwtPayload, userId: string, email: string, roleIds: string[], roleNames: string[]) {
    const pol = await this.policy();
    await this.db.update(staffInvitations).set({ revokedAt: now() }).where(and(eq(staffInvitations.userId, userId), isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)));
    const raw = token(24);
    const expiresAt = new Date(Date.now() + pol.inviteDays * 86400_000);
    const prev = await this.db.select({ n: sql<number>`coalesce(max(${staffInvitations.sentCount}), 0)::int` }).from(staffInvitations).where(eq(staffInvitations.userId, userId));
    const [inv] = await this.db.insert(staffInvitations).values({ userId, email, tokenHash: this.crypto.sha256(raw), roleIds, expiresAt, invitedById: actor.sub, sentCount: (prev[0]?.n || 0) + 1 }).returning();
    await this.notify.queue({ userId, template: 'staff.invite', payload: { inviter: actor.email, roles: roleNames.join(', '), link: this.inviteLink(raw), expiresAt }, channels: ['EMAIL'], dedupeKey: `invite:${inv.id}` });
    return { invitation: { id: inv.id, expiresAt, sentCount: inv.sentCount }, inviteLink: this.inviteLink(raw) };
  }

  async createUser(actor: JwtPayload, input: { email: string; name?: string | null; phone?: string | null; title?: string | null; department?: string | null; team?: string | null; managerId?: string | null; employeeId?: string | null; roleIds?: string[]; primaryRoleId?: string | null; sendInvite?: boolean; reason: string; stepUp?: StepUp }) {
    this.manage(actor, 'create');
    const email = input.email.toLowerCase().trim();
    let [u] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const roles = input.roleIds?.length ? await this.db.select().from(accessRoles).where(inArray(accessRoles.id, input.roleIds)) : [];
    if (roles.length !== (input.roleIds?.length || 0)) throw new BadRequestException('Unknown role');
    if (roles.some((r) => r.status !== 'ACTIVE')) throw new BadRequestException('A role is archived');
    for (const r of roles) this.assertNoEscalation(actor, r.permissions);
    if (u) {
      if (u.id === actor.sub) throw new ForbiddenException({ message: 'You cannot change your own access', code: 'SELF_ASSIGNMENT' });
      const acl = await this.acl.compute(u.id);
      const [prof] = await this.db.select().from(staffProfiles).where(eq(staffProfiles.userId, u.id)).limit(1);
      if (acl.staff || prof?.kind === 'STAFF') throw new ConflictException({ message: 'This person is already staff. Assign roles from their profile.', code: 'ALREADY_STAFF' });
    } else {
      [u] = await this.db.insert(users).values({ email, name: input.name ?? null, phone: input.phone ?? null, roles: ['CUSTOMER'] }).returning();
    }
    const profile = { title: input.title ?? null, department: input.department ?? null, team: input.team ?? null, managerId: input.managerId ?? null, employeeId: input.employeeId ?? null, invitedById: actor.sub, invitedAt: now(), kind: 'STAFF' };
    await this.db.insert(staffProfiles).values({ userId: u.id, ...profile }).onConflictDoUpdate({ target: staffProfiles.userId, set: profile });
    if (input.name && !u.name) await this.db.update(users).set({ name: input.name }).where(eq(users.id, u.id));
    await this.audit.log({ actorId: actor.sub, action: 'iam.user.create', entityType: 'user', entityId: u.id, after: { email, roles: roles.map((r) => r.key), title: input.title }, reason: input.reason });
    const assigned = [];
    const pending = [];
    for (const r of roles) {
      const res = await this.assign(actor, { userIds: [u.id], roleId: r.id, isPrimary: r.id === input.primaryRoleId || roles.length === 1, reason: input.reason, stepUp: input.stepUp });
      if ('status' in res && res.status === 'PENDING_APPROVAL') pending.push(res.approval);
      else assigned.push(...((res as { assignments: unknown[] }).assignments || []));
    }
    let invite = null;
    if (input.sendInvite !== false || !u.passwordHash) invite = await this.issueInvitation(actor, u.id, email, roles.map((r) => r.id), roles.map((r) => r.name));
    if (invite) await this.audit.log({ actorId: actor.sub, action: 'iam.invite.send', entityType: 'user', entityId: u.id, after: { email, expiresAt: invite.invitation.expiresAt } });
    return { user: { id: u.id, email }, assignments: assigned, pendingApprovals: pending, ...(invite || {}) };
  }

  async resendInvite(actor: JwtPayload, userId: string) {
    this.manage(actor, 'create');
    const u = await this.userOr404(userId);
    if (u.passwordHash) throw new ConflictException({ message: 'This person has already set a password', code: 'INVITE_ACCEPTED' });
    const acl = await this.acl.compute(userId);
    const res = await this.issueInvitation(actor, userId, u.email, acl.roles.map((r) => r.id), acl.roles.map((r) => r.name));
    await this.audit.log({ actorId: actor.sub, action: 'iam.invite.resend', entityType: 'user', entityId: userId, after: { sentCount: res.invitation.sentCount } });
    return res;
  }

  async revokeInvite(actor: JwtPayload, userId: string) {
    this.manage(actor, 'delete');
    const rows = await this.db.update(staffInvitations).set({ revokedAt: now() }).where(and(eq(staffInvitations.userId, userId), isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt))).returning();
    await this.audit.log({ actorId: actor.sub, action: 'iam.invite.revoke', entityType: 'user', entityId: userId, after: { revoked: rows.length } });
    return { revoked: rows.length };
  }

  private async inviteRow(raw: string) {
    const [inv] = await this.db.select().from(staffInvitations).where(eq(staffInvitations.tokenHash, this.crypto.sha256(raw || ''))).limit(1);
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt < now()) return null;
    return inv;
  }

  async peekInvite(raw: string) {
    const inv = await this.inviteRow(raw);
    if (!inv) return { valid: false as const };
    const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, inv.userId)).limit(1);
    return { valid: true as const, email: inv.email, name: u?.name ?? null, expiresAt: inv.expiresAt };
  }

  async acceptInvite(raw: string, password: string, name: string | undefined, meta: SessionMeta) {
    const inv = await this.inviteRow(raw);
    if (!inv) throw new BadRequestException({ message: 'This invitation link is invalid or has expired. Ask an administrator to resend it.', code: 'INVITE_INVALID' });
    const u = await this.userOr404(inv.userId);
    if (BLOCKED_STATUSES.includes(u.status)) throw new ForbiddenException({ message: 'This account is not active', code: 'ACCOUNT_DISABLED' });
    const argon2 = await import('argon2');
    await this.db.update(users).set({ passwordHash: await argon2.hash(password), name: name || u.name, emailVerifiedAt: u.emailVerifiedAt || now(), isGuest: false }).where(eq(users.id, u.id));
    await this.db.update(staffInvitations).set({ acceptedAt: now() }).where(eq(staffInvitations.id, inv.id));
    await this.db.update(staffProfiles).set({ inviteAcceptedAt: now(), lastLoginAt: now(), lastLoginIp: meta.ip ?? null }).where(eq(staffProfiles.userId, u.id));
    await this.audit.log({ actorId: u.id, action: 'iam.invite.accept', entityType: 'user', entityId: u.id });
    await this.events.recordLogin({ userId: u.id, email: u.email, outcome: 'SUCCESS', method: 'invite', ip: meta.ip, userAgent: meta.userAgent });
    return this.auth.startSession(u.id, ['pwd'], meta);
  }

  /** Bulk import: one row per person (email, name, title, department, team, roles by key or name). */
  async importUsers(actor: JwtPayload, input: { rows: { email: string; name?: string; title?: string; department?: string; team?: string; roles?: string[] }[]; sendInvites?: boolean; reason: string; dryRun?: boolean }) {
    this.manage(actor, 'create');
    if (input.rows.length > 500) throw new BadRequestException('Import at most 500 people at a time');
    const roles = await this.db.select().from(accessRoles).where(eq(accessRoles.status, 'ACTIVE'));
    const find = (k: string) => roles.find((r) => r.key.toLowerCase() === k.trim().toLowerCase() || r.name.toLowerCase() === k.trim().toLowerCase());
    const results: { row: number; email: string; status: 'CREATED' | 'SKIPPED' | 'ERROR' | 'VALID'; message?: string; userId?: string }[] = [];
    const seen = new Set<string>();
    for (const [i, row] of input.rows.entries()) {
      const email = (row.email || '').toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { results.push({ row: i + 1, email, status: 'ERROR', message: 'Invalid email' }); continue; }
      if (seen.has(email)) { results.push({ row: i + 1, email, status: 'SKIPPED', message: 'Duplicate row' }); continue; }
      seen.add(email);
      const keys = (row.roles || []).filter(Boolean);
      const missing = keys.filter((k) => !find(k));
      if (missing.length) { results.push({ row: i + 1, email, status: 'ERROR', message: `Unknown role: ${missing.join(', ')}` }); continue; }
      const roleIds = keys.map((k) => find(k)!.id);
      if (keys.some((k) => find(k)!.key === 'PLATFORM_ADMIN')) { results.push({ row: i + 1, email, status: 'ERROR', message: 'Superadmin cannot be granted by import' }); continue; }
      if (input.dryRun) { results.push({ row: i + 1, email, status: 'VALID' }); continue; }
      try {
        const r = await this.createUser(actor, { email, name: row.name, title: row.title, department: row.department, team: row.team, roleIds, sendInvite: input.sendInvites !== false, reason: input.reason });
        results.push({ row: i + 1, email, status: 'CREATED', userId: r.user.id });
      } catch (e) {
        const msg = (e as { response?: { message?: string } }).response?.message || (e as Error).message;
        results.push({ row: i + 1, email, status: (e as { response?: { code?: string } }).response?.code === 'ALREADY_STAFF' ? 'SKIPPED' : 'ERROR', message: msg });
      }
    }
    await this.audit.log({ actorId: actor.sub, action: 'iam.user.import', entityType: 'user', entityId: 'bulk', after: { rows: input.rows.length, created: results.filter((r) => r.status === 'CREATED').length, dryRun: !!input.dryRun }, reason: input.reason });
    return { results, created: results.filter((r) => r.status === 'CREATED').length, errors: results.filter((r) => r.status === 'ERROR').length };
  }

  async updateUser(actor: JwtPayload, id: string, input: { name?: string | null; phone?: string | null; title?: string | null; department?: string | null; team?: string | null; managerId?: string | null; employeeId?: string | null }) {
    this.manage(actor, 'edit');
    const u = await this.userOr404(id);
    if (input.managerId === id) throw new BadRequestException('A person cannot manage themselves');
    const [before] = await this.db.select().from(staffProfiles).where(eq(staffProfiles.userId, id)).limit(1);
    if (input.name !== undefined || input.phone !== undefined) await this.db.update(users).set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.phone !== undefined ? { phone: input.phone } : {}) }).where(eq(users.id, id));
    const prof = Object.fromEntries(Object.entries({ title: input.title, department: input.department, team: input.team, managerId: input.managerId, employeeId: input.employeeId }).filter(([, v]) => v !== undefined));
    if (Object.keys(prof).length) await this.db.insert(staffProfiles).values({ userId: id, ...prof }).onConflictDoUpdate({ target: staffProfiles.userId, set: prof });
    await this.audit.log({ actorId: actor.sub, action: 'iam.user.update', entityType: 'user', entityId: id, before: { name: u.name, phone: u.phone, ...(before || {}) }, after: input });
    return { ok: true };
  }

  // ───── status: activate, suspend, deactivate, archive ─────

  async setStatus(actor: JwtPayload, id: string, input: { status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | 'ARCHIVED'; reason: string; until?: string | null; stepUp?: StepUp }) {
    this.manage(actor, input.status === 'ARCHIVED' ? 'delete' : 'edit');
    if (id === actor.sub) throw new BadRequestException({ message: 'You cannot change your own status', code: 'SELF_CHANGE' });
    const u = await this.userOr404(id);
    const target = await this.acl.compute(id);
    const targetIsAdmin = target.superadmin || u.roles.includes('PLATFORM_ADMIN');
    if (targetIsAdmin) {
      if (!this.isSuperadmin(actor)) throw new ForbiddenException({ message: 'Only a superadmin can change a superadmin account', code: 'SUPERADMIN_ONLY' });
      await this.auth.verifyStepUp(actor.sub, input.stepUp);
      if (input.status !== 'ACTIVE') await this.assertNotLastSuperadmin(id);
    }
    await this.db.update(users).set({ status: input.status, statusReason: input.reason }).where(eq(users.id, id));
    const prof: Partial<typeof staffProfiles.$inferInsert> = { suspendedUntil: input.status === 'SUSPENDED' && input.until ? new Date(input.until) : null };
    if (input.status === 'ARCHIVED') prof.archivedAt = now();
    if (input.status === 'ACTIVE') prof.archivedAt = null;
    await this.db.insert(staffProfiles).values({ userId: id, ...prof }).onConflictDoUpdate({ target: staffProfiles.userId, set: prof });
    let sessions = 0;
    if (input.status !== 'ACTIVE') {
      sessions = (await this.auth.revokeAllSessions(id, `${input.status.toLowerCase()}: ${input.reason}`)).revoked;
      await this.db.update(accessGrants).set({ revokedAt: now(), revokedById: actor.sub }).where(and(eq(accessGrants.userId, id), isNull(accessGrants.revokedAt)));
    }
    if (input.status === 'ARCHIVED') {
      await this.db.update(roleAssignments).set({ revokedAt: now(), revokedById: actor.sub, revokeReason: 'account archived' }).where(and(eq(roleAssignments.userId, id), isNull(roleAssignments.revokedAt)));
      await this.db.update(staffInvitations).set({ revokedAt: now() }).where(and(eq(staffInvitations.userId, id), isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)));
      await this.acl.syncUserRoles(id);
    }
    await this.acl.invalidate(id);
    await this.audit.log({ actorId: actor.sub, action: `iam.user.${input.status.toLowerCase()}`, entityType: 'user', entityId: id, before: { status: u.status }, after: { status: input.status, until: input.until ?? null }, reason: input.reason });
    if (targetIsAdmin && input.status !== 'ACTIVE') await this.events.raise({ type: 'SENSITIVE_CHANGE', severity: 'HIGH', title: `Superadmin ${u.email} ${input.status.toLowerCase()}`, detail: `By ${actor.email}: ${input.reason}`, subjectUserId: id, actorId: actor.sub });
    return { userId: id, status: input.status, sessionsRevoked: sessions };
  }

  async unlock(actor: JwtPayload, id: string) {
    this.manage(actor, 'edit');
    const u = await this.userOr404(id);
    await this.auth.unlock(u.email.toLowerCase());
    await this.audit.log({ actorId: actor.sub, action: 'iam.user.unlock', entityType: 'user', entityId: id });
    return { ok: true };
  }

  /** Offboarding in one step: disable, end sessions/grants/roles/invitations, and hand pending work to someone else. */
  async offboard(actor: JwtPayload, id: string, input: { reason: string; transferToUserId?: string | null; stepUp?: StepUp }) {
    this.manage(actor, 'delete');
    if (id === actor.sub) throw new BadRequestException({ message: 'You cannot offboard yourself', code: 'SELF_CHANGE' });
    const u = await this.userOr404(id);
    const target = await this.acl.compute(id);
    if (target.superadmin) {
      if (!this.isSuperadmin(actor)) throw new ForbiddenException({ message: 'Only a superadmin can offboard a superadmin', code: 'SUPERADMIN_ONLY' });
      await this.auth.verifyStepUp(actor.sub, input.stepUp);
      await this.assertNotLastSuperadmin(id);
    }
    const to = input.transferToUserId || null;
    if (to) {
      if (to === id) throw new BadRequestException('Transfer work to someone else');
      const t = await this.userOr404(to);
      if (t.status !== 'ACTIVE') throw new BadRequestException('Transfer work to an active person');
    }
    const at = now();
    await this.db.update(users).set({ status: 'DISABLED', statusReason: `Offboarded: ${input.reason}` }).where(eq(users.id, id));
    await this.db.insert(staffProfiles).values({ userId: id, offboardedAt: at, offboardedById: actor.sub }).onConflictDoUpdate({ target: staffProfiles.userId, set: { offboardedAt: at, offboardedById: actor.sub } });
    const sessions = (await this.auth.revokeAllSessions(id, `offboarded: ${input.reason}`)).revoked;
    const grants = await this.db.update(accessGrants).set({ revokedAt: at, revokedById: actor.sub }).where(and(eq(accessGrants.userId, id), isNull(accessGrants.revokedAt))).returning({ id: accessGrants.id });
    const roles = await this.db.update(roleAssignments).set({ revokedAt: at, revokedById: actor.sub, revokeReason: 'offboarded' }).where(and(eq(roleAssignments.userId, id), isNull(roleAssignments.revokedAt))).returning({ id: roleAssignments.id });
    await this.db.update(staffInvitations).set({ revokedAt: at }).where(and(eq(staffInvitations.userId, id), isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)));
    const requests = await this.db.update(accessRequests).set({ status: 'CANCELED', decidedAt: at, decisionNote: 'requester offboarded' }).where(and(eq(accessRequests.requesterId, id), eq(accessRequests.status, 'PENDING'))).returning({ id: accessRequests.id });
    const approvals = to
      ? await this.db.update(approvalRequests).set({ requestedById: to }).where(and(eq(approvalRequests.requestedById, id), eq(approvalRequests.status, 'PENDING'))).returning({ id: approvalRequests.id })
      : await this.db.update(approvalRequests).set({ status: 'CANCELED', decidedAt: at, decisionNote: 'requester offboarded' }).where(and(eq(approvalRequests.requestedById, id), eq(approvalRequests.status, 'PENDING'))).returning({ id: approvalRequests.id });
    const tickets = await this.db.update(incidents).set({ assigneeId: to }).where(and(eq(incidents.assigneeId, id), sql`${incidents.status} not in ('RESOLVED','CLOSED')`)).returning({ id: incidents.id });
    const alerts = await this.db.update(opsAlerts).set({ ownerId: to }).where(and(eq(opsAlerts.ownerId, id), sql`${opsAlerts.status} <> 'RESOLVED'`)).returning({ id: opsAlerts.id });
    const pipeline = await this.db.update(merchantApplications).set({ ownerId: to }).where(eq(merchantApplications.ownerId, id)).returning({ id: merchantApplications.id });
    const accounts = await this.db.update(organizations).set({ accountManagerId: to }).where(eq(organizations.accountManagerId, id)).returning({ id: organizations.id });
    const services = await this.db.update(serviceAccounts).set({ ownerId: to }).where(eq(serviceAccounts.ownerId, id)).returning({ id: serviceAccounts.id });
    await this.acl.syncUserRoles(id);
    const summary = { sessions, grants: grants.length, roles: roles.length, accessRequests: requests.length, approvals: approvals.length, approvalsTransferred: !!to, tickets: tickets.length, alerts: alerts.length, pipeline: pipeline.length, accounts: accounts.length, serviceAccounts: services.length, transferTo: to };
    await this.audit.log({ actorId: actor.sub, action: 'iam.user.offboard', entityType: 'user', entityId: id, before: { status: u.status, roles: target.roles.map((r) => r.key) }, after: summary, reason: input.reason });
    await this.events.raise({ type: 'OFFBOARDING', severity: target.superadmin ? 'HIGH' : 'LOW', title: `${u.email} offboarded`, detail: `By ${actor.email}. ${roles.length} role(s) and ${sessions} session(s) ended${to ? '; work transferred' : ''}.`, subjectUserId: id, actorId: actor.sub, data: summary });
    return summary;
  }

  // ───── roles & permission matrix ─────

  async listRoles(user: JwtPayload, includeArchived = false) {
    assertCan(user, 'security.read');
    const rows = await this.db.select().from(accessRoles).where(includeArchived ? undefined : eq(accessRoles.status, 'ACTIVE')).orderBy(sql`${accessRoles.kind} desc`, accessRoles.name);
    const t = now();
    const counts = await this.db
      .select({ roleId: roleAssignments.roleId, n: sql<number>`count(distinct ${roleAssignments.userId})::int` })
      .from(roleAssignments)
      .where(and(isNull(roleAssignments.revokedAt), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, t))))
      .groupBy(roleAssignments.roleId);
    return rows.map((r) => ({ ...r, holders: counts.find((c) => c.roleId === r.id)?.n || 0, privileged: r.key === 'PLATFORM_ADMIN' || isPrivileged(r.permissions) }));
  }

  private validatePermissions(perms: string[]) {
    const bad = perms.filter((p) => !ALL_FINE_PERMISSIONS.includes(p));
    if (bad.length) throw new BadRequestException(`Unknown permission: ${bad.join(', ')}`);
    return Array.from(new Set(perms));
  }

  private validateLimits(limits?: Record<string, number | null>) {
    if (!limits) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(limits)) {
      if (!(k in APPROVAL_LIMIT_KINDS)) throw new BadRequestException(`Unknown approval limit: ${k}`);
      if (v === null || v === undefined) continue;
      if (!Number.isInteger(v) || v < 0) throw new BadRequestException('Approval limits are whole cents, zero or more');
      out[k] = v;
    }
    return out;
  }

  async createRole(actor: JwtPayload, input: { name: string; description?: string; permissions?: string[]; approvalLimits?: Record<string, number | null>; mfaRequired?: boolean; requestable?: boolean; copyFromRoleId?: string; reason: string }) {
    this.manage(actor, 'create');
    let perms = input.permissions || [];
    let limits = this.validateLimits(input.approvalLimits) || {};
    if (input.copyFromRoleId) {
      const src = await this.role(input.copyFromRoleId);
      if (src.key === 'PLATFORM_ADMIN') throw new BadRequestException('Superadmin cannot be duplicated');
      if (!input.permissions) perms = src.permissions;
      if (!input.approvalLimits) limits = src.approvalLimits as Record<string, number>;
    }
    perms = this.validatePermissions(perms);
    this.assertNoEscalation(actor, perms);
    let key = `custom-${slug(input.name)}`;
    const [clash] = await this.db.select({ id: accessRoles.id }).from(accessRoles).where(eq(accessRoles.key, key)).limit(1);
    if (clash) key = `${key}-${token(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const [row] = await this.db.insert(accessRoles).values({ key, name: input.name.trim(), description: input.description || '', kind: 'CUSTOM', permissions: perms, approvalLimits: limits, mfaRequired: !!input.mfaRequired, requestable: input.requestable !== false, createdById: actor.sub, updatedById: actor.sub }).returning();
    await this.audit.log({ actorId: actor.sub, action: input.copyFromRoleId ? 'iam.role.duplicate' : 'iam.role.create', entityType: 'access_role', entityId: row.id, after: { key, name: row.name, permissions: perms, approvalLimits: limits, from: input.copyFromRoleId }, reason: input.reason });
    if (isPrivileged(perms)) await this.events.raise({ type: 'SENSITIVE_CHANGE', severity: 'MEDIUM', title: `Privileged role created: ${row.name}`, detail: `By ${actor.email}. Includes ${perms.filter((p) => isPrivileged([p])).join(', ')}.`, actorId: actor.sub, data: { roleId: row.id } });
    return row;
  }

  /** Name, description and requestable apply directly; permission, limit and MFA changes are critical (step-up, maybe dual control). */
  async updateRole(actor: JwtPayload, roleId: string, input: RolePatch & { reason: string; stepUp?: StepUp }, opts: { steppedUp?: boolean } = {}) {
    this.manage(actor, 'edit');
    const r = await this.role(roleId);
    if (r.key === 'PLATFORM_ADMIN') throw new ForbiddenException({ message: 'Superadmin always has every permission and cannot be edited', code: 'ROLE_LOCKED' });
    if (r.status !== 'ACTIVE') throw new ConflictException('Restore the role before editing it');
    const patch: RolePatch = { name: input.name, description: input.description, requestable: input.requestable, mfaRequired: input.mfaRequired };
    const critical = input.permissions !== undefined || input.approvalLimits !== undefined || (input.mfaRequired !== undefined && input.mfaRequired !== r.mfaRequired);
    if (input.permissions !== undefined) {
      patch.permissions = this.validatePermissions(input.permissions);
      this.manage(actor, 'manage_access');
      const added = patch.permissions.filter((p) => !r.permissions.includes(p));
      this.assertNoEscalation(actor, added);
    }
    if (input.approvalLimits !== undefined) patch.approvalLimits = this.validateLimits(input.approvalLimits);
    if (critical && !opts.steppedUp) await this.auth.verifyStepUp(actor.sub, input.stepUp);
    const addedPrivileged = (patch.permissions || []).filter((p) => !r.permissions.includes(p) && isPrivileged([p]));
    if (addedPrivileged.length && (await this.needsSecondApprover(actor))) {
      const res = await this.approvals.submit(actor, { kind: 'ACCESS_CHANGE', summary: `Give role "${r.name}" ${addedPrivileged.join(', ')}`, subjectType: 'access_role', subjectId: r.id, payload: { op: 'role_update', roleId: r.id, patch }, reason: input.reason, dedupeKey: `role:${r.id}` });
      return { status: 'PENDING_APPROVAL' as const, approval: res.approval };
    }
    return this.applyRolePatch(actor, roleId, patch, input.reason);
  }

  async applyRolePatch(actor: JwtPayload, roleId: string, patch: RolePatch, reason: string, approvedById?: string) {
    const r = await this.role(roleId);
    const set = Object.fromEntries(Object.entries({ name: patch.name?.trim(), description: patch.description, requestable: patch.requestable, mfaRequired: patch.mfaRequired, permissions: patch.permissions, approvalLimits: patch.approvalLimits }).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return r;
    const [row] = await this.db.update(accessRoles).set({ ...set, updatedById: actor.sub }).where(eq(accessRoles.id, roleId)).returning();
    await this.acl.invalidateAll();
    const added = (patch.permissions || []).filter((p) => !r.permissions.includes(p));
    const removed = patch.permissions ? r.permissions.filter((p) => !patch.permissions!.includes(p)) : [];
    await this.audit.log({ actorId: actor.sub, action: patch.permissions ? 'iam.role.permissions' : 'iam.role.update', entityType: 'access_role', entityId: roleId, before: { name: r.name, permissions: r.permissions, approvalLimits: r.approvalLimits, mfaRequired: r.mfaRequired }, after: { ...set, added, removed, approvedById: approvedById ?? null }, reason });
    if (added.length || removed.length || patch.approvalLimits) {
      const priv = added.filter((p) => isPrivileged([p]));
      await this.events.raise({ type: priv.length ? 'PRIVILEGE_INCREASE' : 'SENSITIVE_CHANGE', severity: priv.length ? 'HIGH' : 'LOW', title: `Role "${r.name}" changed${added.length ? `: +${added.length}` : ''}${removed.length ? ` −${removed.length}` : ''}${patch.approvalLimits ? ' (approval limits)' : ''}`, detail: `${priv.length ? `Privileged: ${priv.join(', ')}. ` : ''}By ${actor.email || 'approval'}. ${reason}`, actorId: actor.sub, data: { roleId, added, removed } });
    }
    return row;
  }

  /** Save many matrix cells at once (one step-up for the whole save). */
  async saveMatrix(actor: JwtPayload, input: { changes: { roleId: string; permission: string; granted: boolean }[]; reason: string; stepUp?: StepUp }) {
    this.manage(actor, 'manage_access');
    if (!input.changes.length) return { roles: [] };
    await this.auth.verifyStepUp(actor.sub, input.stepUp);
    const byRole = new Map<string, { permission: string; granted: boolean }[]>();
    for (const c of input.changes) byRole.set(c.roleId, [...(byRole.get(c.roleId) || []), c]);
    const out = [];
    for (const [roleId, changes] of byRole) {
      const r = await this.role(roleId);
      const set = new Set(r.permissions);
      for (const c of changes) c.granted ? set.add(c.permission) : set.delete(c.permission);
      out.push({ roleId, result: await this.updateRole(actor, roleId, { permissions: [...set], reason: input.reason }, { steppedUp: true }) });
    }
    return { roles: out };
  }

  async archiveRole(actor: JwtPayload, roleId: string, reason: string) {
    this.manage(actor, 'delete');
    const r = await this.role(roleId);
    if (r.kind === 'SYSTEM') throw new ForbiddenException({ message: 'Built-in roles cannot be archived', code: 'ROLE_LOCKED' });
    const [held] = await this.db.select({ n: sql<number>`count(*)::int` }).from(roleAssignments).where(and(eq(roleAssignments.roleId, roleId), isNull(roleAssignments.revokedAt), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, now()))));
    if (held.n > 0) throw new ConflictException({ message: `${held.n} assignment(s) still use this role. Remove them first.`, code: 'ROLE_IN_USE' });
    await this.db.update(accessRoles).set({ status: 'ARCHIVED', archivedAt: now(), updatedById: actor.sub }).where(eq(accessRoles.id, roleId));
    await this.db.update(accessRequests).set({ status: 'CANCELED', decidedAt: now(), decisionNote: 'role archived' }).where(and(eq(accessRequests.roleId, roleId), eq(accessRequests.status, 'PENDING')));
    await this.acl.invalidateAll();
    await this.audit.log({ actorId: actor.sub, action: 'iam.role.archive', entityType: 'access_role', entityId: roleId, reason });
    return { ok: true };
  }

  async restoreRole(actor: JwtPayload, roleId: string, reason: string) {
    this.manage(actor, 'edit');
    await this.db.update(accessRoles).set({ status: 'ACTIVE', archivedAt: null, updatedById: actor.sub }).where(eq(accessRoles.id, roleId));
    await this.acl.invalidateAll();
    await this.audit.log({ actorId: actor.sub, action: 'iam.role.restore', entityType: 'access_role', entityId: roleId, reason });
    return { ok: true };
  }

  // ───── assignments ─────

  /** Assign a role to one or more people. Superadmin grants need step-up and, with another superadmin around, a second approver. */
  async assign(actor: JwtPayload, input: AssignInput) {
    this.manage(actor, 'manage_access');
    const r = await this.role(input.roleId);
    if (r.status !== 'ACTIVE') throw new ConflictException('This role is archived');
    if (input.userIds.includes(actor.sub)) throw new ForbiddenException({ message: 'You cannot assign roles to yourself. Ask someone else, or file an access request.', code: 'SELF_ASSIGNMENT' });
    this.assertNoEscalation(actor, r.permissions);
    if (r.key === 'PLATFORM_ADMIN') {
      await this.assertSuperadminGranter(actor);
      await this.auth.verifyStepUp(actor.sub, input.stepUp);
      if (await this.needsSecondApprover(actor)) {
        const emails = await this.db.select({ email: users.email }).from(users).where(inArray(users.id, input.userIds));
        const res = await this.approvals.submit(actor, { kind: 'ACCESS_CHANGE', summary: `Make ${emails.map((e) => e.email).join(', ')} superadmin`, subjectType: 'user', subjectId: input.userIds.join(','), payload: { op: 'assign', input: { ...input, stepUp: undefined } }, reason: input.reason, dedupeKey: `superadmin:${[...input.userIds].sort().join(',')}` });
        return { status: 'PENDING_APPROVAL' as const, approval: res.approval };
      }
    }
    return this.assignNow(actor, input);
  }

  async assignNow(actor: JwtPayload, input: AssignInput, approvedById?: string) {
    const r = await this.role(input.roleId);
    const kind = input.kind || (input.endsAt ? 'TEMPORARY' : 'STANDARD');
    const startsAt = input.startsAt ? new Date(input.startsAt) : now();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new BadRequestException('The end must be after the start');
    if ((kind === 'TEMPORARY' || kind === 'ACTING') && !endsAt) throw new BadRequestException('Temporary and acting access need an end date');
    if (kind === 'ACTING' && !input.actingForUserId) throw new BadRequestException('Say whose access is being covered');
    const targets = await this.db.select().from(users).where(inArray(users.id, input.userIds));
    if (targets.length !== input.userIds.length) throw new NotFoundException('User not found');
    const blocked = targets.filter((t) => BLOCKED_STATUSES.includes(t.status));
    if (blocked.length) throw new ConflictException(`Not active: ${blocked.map((b) => b.email).join(', ')}`);
    const out = [];
    for (const t of targets) {
      const before = await this.acl.compute(t.id);
      if (input.isPrimary) await this.db.update(roleAssignments).set({ isPrimary: false }).where(eq(roleAssignments.userId, t.id));
      const [a] = await this.db.insert(roleAssignments).values({ userId: t.id, roleId: r.id, kind, isPrimary: !!input.isPrimary, responsibility: input.responsibility ?? null, actingForUserId: input.actingForUserId ?? null, startsAt, endsAt, reason: input.reason, assignedById: actor.sub, sourceRequestId: input.sourceRequestId ?? null, activatedAt: startsAt <= now() ? now() : null }).returning();
      await this.db.insert(staffProfiles).values({ userId: t.id }).onConflictDoNothing();
      await this.acl.syncUserRoles(t.id);
      out.push(a);
      await this.audit.log({ actorId: actor.sub, action: 'iam.assignment.create', entityType: 'user', entityId: t.id, after: { role: r.key, kind, startsAt, endsAt, primary: !!input.isPrimary, responsibility: input.responsibility, actingFor: input.actingForUserId, approvedById: approvedById ?? null, requestId: input.sourceRequestId ?? null }, reason: input.reason });
      if (r.key === 'PLATFORM_ADMIN') await this.events.raise({ type: 'NEW_SUPERADMIN', severity: 'CRITICAL', title: `New superadmin: ${t.email}`, detail: `Granted by ${actor.email || 'approval'}${approvedById ? ' after a second approval' : ''}. ${input.reason}`, subjectUserId: t.id, actorId: actor.sub, data: { assignmentId: a.id } });
      else if (isPrivileged(r.permissions) && !before.fine.some((p) => isPrivileged([p]))) await this.events.raise({ type: 'PRIVILEGE_INCREASE', severity: 'HIGH', title: `${t.email} now holds privileged access (${r.name})`, detail: `${kind === 'STANDARD' ? '' : `${kind.toLowerCase()} until ${endsAt?.toISOString()}. `}By ${actor.email || 'approval'}. ${input.reason}`, subjectUserId: t.id, actorId: actor.sub, data: { roleId: r.id, assignmentId: a.id } });
    }
    return { assignments: out };
  }

  /** Acting-manager cover: mirror another person's roles for a limited time. */
  async actFor(actor: JwtPayload, input: { userId: string; forUserId: string; endsAt: string; startsAt?: string | null; reason: string }) {
    this.manage(actor, 'manage_access');
    if (input.userId === input.forUserId) throw new BadRequestException('Pick someone else to cover');
    const src = await this.acl.compute(input.forUserId);
    const roles = src.roles.filter((r) => r.source !== 'emergency' && r.key !== 'PLATFORM_ADMIN');
    if (!roles.length) throw new BadRequestException('That person holds no roles to cover');
    if (input.userId === actor.sub) throw new ForbiddenException({ message: 'You cannot assign roles to yourself', code: 'SELF_ASSIGNMENT' });
    const sys = await this.db.select().from(accessRoles).where(inArray(accessRoles.key, roles.map((r) => r.key)));
    for (const r of sys) this.assertNoEscalation(actor, r.permissions);
    const out = [];
    for (const r of sys) out.push(...(await this.assignNow(actor, { userIds: [input.userId], roleId: r.id, kind: 'ACTING', actingForUserId: input.forUserId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason })).assignments);
    return { assignments: out };
  }

  async updateAssignment(actor: JwtPayload, id: string, input: { isPrimary?: boolean; responsibility?: string | null; endsAt?: string | null; reason: string; stepUp?: StepUp }) {
    this.manage(actor, 'manage_access');
    const [a] = await this.db.select({ a: roleAssignments, r: accessRoles }).from(roleAssignments).innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId)).where(eq(roleAssignments.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    if (a.a.userId === actor.sub && input.endsAt !== undefined) throw new ForbiddenException({ message: 'You cannot change your own access', code: 'SELF_ASSIGNMENT' });
    if (a.r.key === 'PLATFORM_ADMIN' && input.endsAt !== undefined) {
      await this.assertSuperadminGranter(actor);
      await this.auth.verifyStepUp(actor.sub, input.stepUp);
      if (input.endsAt) await this.assertNotLastSuperadmin(a.a.userId);
    }
    if (input.isPrimary) await this.db.update(roleAssignments).set({ isPrimary: false }).where(eq(roleAssignments.userId, a.a.userId));
    const set: Partial<Assignment> = {};
    if (input.isPrimary !== undefined) set.isPrimary = input.isPrimary;
    if (input.responsibility !== undefined) set.responsibility = input.responsibility;
    if (input.endsAt !== undefined) { set.endsAt = input.endsAt ? new Date(input.endsAt) : null; set.expiredAt = null; }
    const [row] = await this.db.update(roleAssignments).set(set).where(eq(roleAssignments.id, id)).returning();
    await this.acl.syncUserRoles(a.a.userId);
    await this.audit.log({ actorId: actor.sub, action: 'iam.assignment.update', entityType: 'user', entityId: a.a.userId, before: { isPrimary: a.a.isPrimary, responsibility: a.a.responsibility, endsAt: a.a.endsAt }, after: set, reason: input.reason });
    return row;
  }

  async revokeAssignment(actor: JwtPayload, id: string, input: { reason: string; stepUp?: StepUp }) {
    this.manage(actor, 'manage_access');
    const [a] = await this.db.select({ a: roleAssignments, r: accessRoles }).from(roleAssignments).innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId)).where(eq(roleAssignments.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    if (a.a.revokedAt) return a.a;
    if (a.r.key === 'PLATFORM_ADMIN') {
      if (a.a.userId === actor.sub) throw new BadRequestException({ message: 'You cannot remove your own superadmin role', code: 'SELF_CHANGE' });
      await this.assertSuperadminGranter(actor);
      await this.auth.verifyStepUp(actor.sub, input.stepUp);
      if (isActiveWindow(a.a)) {
        const others = (await this.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.userId, a.a.userId), eq(roleAssignments.roleId, a.r.id), isNull(roleAssignments.revokedAt)))).filter((x) => x.id !== id);
        if (!others.length) await this.assertNotLastSuperadmin(a.a.userId);
      }
    }
    const [row] = await this.db.update(roleAssignments).set({ revokedAt: now(), revokedById: actor.sub, revokeReason: input.reason }).where(eq(roleAssignments.id, id)).returning();
    await this.acl.syncUserRoles(a.a.userId);
    await this.audit.log({ actorId: actor.sub, action: 'iam.assignment.revoke', entityType: 'user', entityId: a.a.userId, before: { role: a.r.key, kind: a.a.kind }, reason: input.reason });
    return row;
  }

  /** Legacy endpoint: replace a person's built-in roles (kept for existing clients; goes through the same safeguards). */
  async setSystemRoles(actor: JwtPayload, input: { email: string; roles: string[]; reason: string; stepUp?: StepUp }) {
    this.manage(actor, 'manage_access');
    const [t] = await this.db.select().from(users).where(eq(users.email, input.email.toLowerCase().trim())).limit(1);
    if (!t) throw new NotFoundException('User not found. They must create an account first.');
    const current = await this.acl.compute(t.id);
    const have = new Set(current.roles.filter((r) => r.source !== 'emergency' && isStaffRole(r.key)).map((r) => r.key));
    const want = new Set(input.roles);
    if (t.id === actor.sub && have.has('PLATFORM_ADMIN') && !want.has('PLATFORM_ADMIN')) throw new BadRequestException('You cannot remove your own platform admin role');
    if (t.id === actor.sub && [...want].some((k) => !have.has(k))) throw new ForbiddenException({ message: 'You cannot assign roles to yourself', code: 'SELF_ASSIGNMENT' });
    if ((have.has('PLATFORM_ADMIN') !== want.has('PLATFORM_ADMIN')) && !this.isSuperadmin(actor)) throw new ForbiddenException('Only a platform admin can grant or remove platform admin');
    const results: unknown[] = [];
    for (const k of want) if (!have.has(k)) results.push(await this.assign(actor, { userIds: [t.id], roleId: (await this.roleByKey(k)).id, reason: input.reason, stepUp: input.stepUp }));
    for (const k of have) {
      if (want.has(k)) continue;
      const role = await this.roleByKey(k);
      const rows = await this.db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, t.id), eq(roleAssignments.roleId, role.id), isNull(roleAssignments.revokedAt)));
      if (!rows.length) {
        // legacy role on the user row only
        await this.db.insert(roleAssignments).values({ userId: t.id, roleId: role.id, reason: 'legacy', revokedAt: now(), revokedById: actor.sub, revokeReason: input.reason });
        await this.acl.syncUserRoles(t.id);
      }
      for (const r of rows) await this.revokeAssignment(actor, r.id, { reason: input.reason, stepUp: input.stepUp });
    }
    const after = await this.acl.compute(t.id);
    const pending = results.filter((x) => (x as { status?: string }).status === 'PENDING_APPROVAL');
    return { userId: t.id, roles: after.staffRoles, ...(pending.length ? { pendingApprovals: pending } : {}) };
  }

  // ───── scope ─────

  async setScope(actor: JwtPayload, userId: string, input: { regionIds?: string[]; organizationIds?: string[]; locationIds?: string[]; companyIds?: string[]; kitchenIds?: string[]; brandIds?: string[]; teams?: string[]; maxSensitivity?: Sensitivity; note?: string | null; reason?: string }) {
    this.manage(actor, 'manage_access');
    if (userId === actor.sub) throw new ForbiddenException({ message: 'You cannot change your own access', code: 'SELF_ASSIGNMENT' });
    await this.userOr404(userId);
    const [before] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    const values = { userId, regionIds: input.regionIds || [], organizationIds: input.organizationIds || [], locationIds: input.locationIds || [], companyIds: input.companyIds || [], kitchenIds: input.kitchenIds || [], brandIds: input.brandIds || [], teams: input.teams || [], maxSensitivity: input.maxSensitivity || 'RESTRICTED', note: input.note ?? null, updatedById: actor.sub };
    if (!SENSITIVITY.includes(values.maxSensitivity as Sensitivity)) throw new BadRequestException('Unknown sensitivity');
    const unrestricted = !values.regionIds.length && !values.organizationIds.length && !values.locationIds.length && !values.companyIds.length && !values.kitchenIds.length && !values.brandIds.length && !values.teams.length && values.maxSensitivity === 'RESTRICTED';
    let row = null;
    if (unrestricted) await this.db.delete(staffScopes).where(eq(staffScopes.userId, userId));
    else [row] = await this.db.insert(staffScopes).values(values).onConflictDoUpdate({ target: staffScopes.userId, set: values }).returning();
    await this.acl.invalidate(userId);
    await this.audit.log({ actorId: actor.sub, action: 'iam.scope.update', entityType: 'user', entityId: userId, before: before || null, after: row, reason: input.reason });
    const widened = before && (unrestricted || SENSITIVITY.indexOf(values.maxSensitivity as Sensitivity) > SENSITIVITY.indexOf(before.maxSensitivity as Sensitivity));
    if (widened) await this.events.raise({ type: 'SENSITIVE_CHANGE', severity: 'MEDIUM', title: `Access scope widened for a staff member`, detail: `${unrestricted ? 'Now unrestricted' : `Sensitivity up to ${values.maxSensitivity}`}. By ${actor.email}.`, subjectUserId: userId, actorId: actor.sub });
    return row || { userId, unrestricted: true };
  }

  // ───── sessions & sign-ins ─────

  async listSessions(actor: JwtPayload, q: { userId?: string } = {}) {
    assertCan(actor, 'security.read');
    const ids = q.userId ? [q.userId] : await this.staffIds();
    if (!ids.length) return [];
    const rows = await this.db
      .select({ s: userSessions, email: users.email, name: users.name })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(and(inArray(userSessions.userId, ids), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, now())))
      .orderBy(desc(userSessions.lastSeenAt))
      .limit(500);
    return rows.map((r) => ({ id: r.s.id, userId: r.s.userId, email: r.email, name: r.name, amr: r.s.amr, client: r.s.client, ip: r.s.ip, userAgent: r.s.userAgent, lastSeenAt: r.s.lastSeenAt, createdAt: r.s.createdAt, expiresAt: r.s.expiresAt, current: r.s.id === actor.sid }));
  }

  async revokeSession(actor: JwtPayload, sessionId: string, reason: string) {
    this.manage(actor, 'edit');
    const [s] = await this.db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
    if (!s) throw new NotFoundException();
    await this.auth.revokeSessionRow(sessionId, reason);
    await this.audit.log({ actorId: actor.sub, action: 'iam.session.revoke', entityType: 'user', entityId: s.userId, after: { sessionId }, reason });
    return { ok: true };
  }

  async forceLogout(actor: JwtPayload, userId: string, reason: string) {
    this.manage(actor, 'edit');
    const r = await this.auth.revokeAllSessions(userId, `forced sign-out: ${reason}`, userId === actor.sub ? actor.sid : undefined);
    await this.audit.log({ actorId: actor.sub, action: 'iam.session.force_logout', entityType: 'user', entityId: userId, after: r, reason });
    return r;
  }

  /** Sign out every staff member except the person doing it (incident response). */
  async revokeAllStaffSessions(actor: JwtPayload, reason: string, stepUp: StepUp) {
    this.manage(actor, 'edit');
    if (!this.isSuperadmin(actor)) throw new ForbiddenException({ message: 'Only a superadmin can sign out all staff', code: 'SUPERADMIN_ONLY' });
    await this.auth.verifyStepUp(actor.sub, stepUp);
    let users_ = 0, sessions = 0;
    for (const id of await this.staffIds()) {
      if (id === actor.sub) { sessions += (await this.auth.revokeAllSessions(id, `all staff signed out: ${reason}`, actor.sid)).revoked; continue; }
      const r = await this.auth.revokeAllSessions(id, `all staff signed out: ${reason}`);
      sessions += r.revoked;
      if (r.revoked) users_++;
    }
    await this.audit.log({ actorId: actor.sub, action: 'iam.session.revoke_all_staff', entityType: 'user_session', entityId: 'all', after: { users: users_, sessions }, reason });
    await this.events.raise({ type: 'SENSITIVE_CHANGE', severity: 'HIGH', title: 'All staff sessions ended', detail: `By ${actor.email}: ${reason}. ${sessions} session(s).`, actorId: actor.sub });
    return { users: users_, sessions };
  }

  async loginEvents(actor: JwtPayload, q: { userId?: string; outcome?: string; suspicious?: boolean; email?: string; limit?: number }) {
    assertCan(actor, 'security.read');
    const conds = [];
    if (q.userId) conds.push(eq(loginEvents.userId, q.userId));
    if (q.outcome) conds.push(eq(loginEvents.outcome, q.outcome));
    if (q.suspicious) conds.push(eq(loginEvents.suspicious, true));
    if (q.email) conds.push(ilike(loginEvents.email, `%${q.email}%`));
    return this.db.select().from(loginEvents).where(conds.length ? and(...conds) : undefined).orderBy(desc(loginEvents.createdAt)).limit(Math.min(q.limit || 200, 1000));
  }

  // ───── effective access ─────

  async effective(actor: JwtPayload, userId: string) {
    assertCan(actor, 'security.read');
    const u = await this.userOr404(userId);
    const acl = await this.acl.compute(userId);
    const [scope] = await this.db.select().from(staffScopes).where(eq(staffScopes.userId, userId)).limit(1);
    const max = (acl.scope?.max || 'RESTRICTED') as Sensitivity;
    const mfaBlocked = acl.mfaRequired && !u.mfaEnabledAt;
    const blocked = BLOCKED_STATUSES.includes(u.status);
    const roleRows = acl.roles.length ? await this.db.select().from(accessRoles).where(inArray(accessRoles.key, acl.roles.map((r) => r.key))) : [];
    const matrix = IAM_RESOURCES.map((res) => ({
      resource: res.key,
      label: res.label,
      group: res.group,
      actions: res.actions.map((a) => {
        const p = `${res.key}:${a}`;
        const via = roleRows.filter((r) => r.key === 'PLATFORM_ADMIN' || r.permissions.includes(p)).map((r) => r.name);
        const held = acl.fine.includes(p);
        const capped = held && SENSITIVITY.indexOf(sensitivityOf(p)) > SENSITIVITY.indexOf(max);
        const reasons: string[] = [];
        if (blocked) reasons.push(`Account is ${u.status.toLowerCase()}`);
        if (!held) reasons.push('No role grants it');
        if (capped) reasons.push(`Above this person's data ceiling (${max})`);
        if (held && mfaBlocked) reasons.push('Blocked until two-factor authentication is set up');
        return { action: a, permission: p, granted: held && !capped && !mfaBlocked && !blocked, via: Array.from(new Set(via)), reasons };
      }),
    }));
    const coarse = blocked || mfaBlocked ? [] : (acl.coarse.filter((p) => SENSITIVITY.indexOf(PERMISSIONS[p].sensitivity) <= SENSITIVITY.indexOf(max)) as Permission[]);
    return {
      user: { id: u.id, email: u.email, name: u.name, status: u.status, mfaEnabled: !!u.mfaEnabledAt },
      roles: acl.roles,
      superadmin: acl.superadmin,
      mfaRequired: acl.mfaRequired,
      notes: [
        ...(blocked ? [`Account is ${u.status.toLowerCase()}: nothing is granted.`] : []),
        ...(mfaBlocked ? ['A role requires two-factor authentication, which is not set up: the console stays closed until it is.'] : []),
        ...acl.roles.filter((r) => r.endsAt).map((r) => `${r.name} ends ${new Date(r.endsAt!).toISOString()} (${r.kind.toLowerCase()}).`),
        ...(scope ? [`Scope limits places${scope.teams.length ? ` and teams (${scope.teams.join(', ')})` : ''}; data up to ${scope.maxSensitivity}.`] : ['No scope restriction: every region and organization.']),
      ],
      scope: scope ? { ...scope, expanded: { organizations: acl.scope?.orgIds.length || 0, locations: acl.scope?.locationIds.filter((x) => x !== '00000000-0000-0000-0000-000000000000').length || 0 } } : null,
      matrix,
      fields: IAM_RESOURCES.filter((r) => r.group === 'Sensitive data').map((r) => ({ field: r.key, label: r.label, view: acl.fine.includes(`${r.key}:view`) && !blocked, export: acl.fine.includes(`${r.key}:export`) && !blocked })),
      approvalLimits: acl.superadmin ? 'unlimited' : acl.limits,
      consolePermissions: coarse,
      modules: modulesFor(coarse).map((m) => ({ key: m.key, label: m.label, group: m.group })),
    };
  }

  /** Why one person can or cannot do one thing (optionally in one organization or location). */
  async explain(actor: JwtPayload, q: { userId: string; permission: string; organizationId?: string; locationId?: string }): Promise<AccessExplanation> {
    assertCan(actor, 'security.read');
    const u = await this.userOr404(q.userId);
    const acl = await this.acl.compute(q.userId);
    const perm = q.permission;
    if (!ALL_FINE_PERMISSIONS.includes(perm)) throw new BadRequestException('Unknown permission');
    const roleRows = acl.roles.length ? await this.db.select().from(accessRoles).where(inArray(accessRoles.key, acl.roles.map((r) => r.key))) : [];
    const grantedBy = roleRows.filter((r) => r.key === 'PLATFORM_ADMIN' || r.permissions.includes(perm)).map((r) => r.name);
    const reasons: string[] = [];
    let allowed = true;
    if (BLOCKED_STATUSES.includes(u.status)) { allowed = false; reasons.push(`Denied: the account is ${u.status.toLowerCase()}.`); }
    if (!acl.fine.includes(perm)) { allowed = false; reasons.push(`Denied: none of this person's roles (${acl.roles.map((r) => r.name).join(', ') || 'none'}) grants ${perm}.`); }
    else reasons.push(`Granted by ${grantedBy.join(', ')}.`);
    const max = (acl.scope?.max || 'RESTRICTED') as Sensitivity;
    if (SENSITIVITY.indexOf(sensitivityOf(perm)) > SENSITIVITY.indexOf(max)) { allowed = false; reasons.push(`Denied: ${perm} is ${sensitivityOf(perm)} data, above this person's ceiling (${max}).`); }
    if (acl.mfaRequired && !u.mfaEnabledAt) { allowed = false; reasons.push('Denied until two-factor authentication is set up (a role requires it).'); }
    if (q.organizationId) {
      const covers = staffCovers({ sub: u.id, email: u.email, roles: [], orgs: {}, scope: acl.scope }, q.organizationId, q.locationId);
      if (!covers) { allowed = false; reasons.push('Denied: the organization or location is outside this person\'s access scope.'); }
      else reasons.push(acl.scope ? 'The organization/location is inside the access scope.' : 'No scope restriction applies.');
    }
    const field = FIELD_PATH_RULES.find((r) => `${r.field}:${r.action}` === perm);
    if (field) reasons.push(`Also controls ${field.pattern.source} for staff.`);
    if (acl.roles.some((r) => r.endsAt)) reasons.push(`Time-limited roles: ${acl.roles.filter((r) => r.endsAt).map((r) => `${r.name} until ${r.endsAt}`).join('; ')}.`);
    return { permission: perm, allowed, grantedBy, reasons };
  }

  // ───── overview ─────

  async overview(actor: JwtPayload) {
    assertCan(actor, 'security.read');
    const list = await this.listUsers(actor, {});
    const roles = await this.listRoles(actor, false);
    const t = now();
    const [{ n: pendingRequests }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(accessRequests).where(eq(accessRequests.status, 'PENDING'));
    const [{ n: openReviews }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(accessReviews).where(eq(accessReviews.status, 'OPEN'));
    const [{ n: alerts }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(securityAlerts).where(isNull(securityAlerts.acknowledgedAt));
    const [{ n: keysExpiring }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(apiKeys).where(and(isNull(apiKeys.revokedAt), gt(apiKeys.expiresAt, t), lte(apiKeys.expiresAt, new Date(t.getTime() + 14 * 86400_000))));
    const superadmins = await this.acl.activeSuperadmins();
    return {
      users: list.length,
      byStatus: list.reduce<Record<string, number>>((m, u) => ({ ...m, [u.status]: (m[u.status] || 0) + 1 }), {}),
      invited: list.filter((u) => u.status === 'INVITED').length,
      inactive: list.filter((u) => u.inactive).length,
      withoutMfa: list.filter((u) => !u.mfaEnabled && u.status === 'ACTIVE').length,
      temporary: list.filter((u) => u.roles.some((r) => r.endsAt)).length,
      roles: roles.length,
      customRoles: roles.filter((r) => r.kind === 'CUSTOM').length,
      superadmins: superadmins.length,
      pendingRequests,
      openReviews,
      unacknowledgedAlerts: alerts,
      keysExpiring,
      policy: await this.policy(),
    };
  }
}
