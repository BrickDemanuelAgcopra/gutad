import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { ALL_FINE_PERMISSIONS, DEFAULT_ACCESS_POLICY, isPrivileged, type AccessPolicy } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { platformSettings, accessRequests, accessReviewItems, accessReviews, accessRoles, apiKeys, roleAssignments, securityAlerts, serviceAccounts, staffProfiles, userSessions, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { AclService } from '../../core/acl.service';
import { CryptoService } from '../../core/crypto.service';
import { NotifyService } from '../../core/notify.service';
import { RedisService } from '../../core/redis.service';
import { SecurityEventsService } from '../../core/security-events.service';
import { SettingsService } from '../../core/settings.service';
import { token } from '../../common/utils';
import { assertCan, canFine, finePermissionsOf, JwtPayload } from '../../common/auth';
import { AuthService } from '../auth/auth.service';
import { IamService, type StepUp } from './iam.service';

const now = () => new Date();

/** Access requests, access reviews, inactivity, service accounts & API keys, security alerts, access policy, sweeps. */
@Injectable()
export class IamGovernanceService {
  private readonly log = new Logger(IamGovernanceService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly iam: IamService,
    private readonly acl: AclService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly events: SecurityEventsService,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
  ) {}

  private manage(user: JwtPayload, action: 'edit' | 'approve' | 'manage_access' | 'create' = 'edit') {
    assertCan(user, 'security.manage');
    if (!canFine(user, `security:${action}`) && !(action === 'approve' && canFine(user, 'security:manage_access'))) throw new ForbiddenException({ message: `Requires permission: security:${action}`, code: 'PERMISSION_REQUIRED' });
  }

  // ───── access requests ─────

  async requestableRoles(user: JwtPayload) {
    const rows = await this.db.select({ id: accessRoles.id, key: accessRoles.key, name: accessRoles.name, description: accessRoles.description, permissions: accessRoles.permissions }).from(accessRoles).where(and(eq(accessRoles.status, 'ACTIVE'), eq(accessRoles.requestable, true)));
    const held = new Set((user.acl?.roles || []).map((r) => r.id));
    return rows.filter((r) => r.key !== 'PLATFORM_ADMIN').map((r) => ({ ...r, held: held.has(r.id) }));
  }

  async createRequest(user: JwtPayload, input: { roleId: string; justification: string; durationHours?: number | null }) {
    const [prof] = await this.db.select().from(staffProfiles).where(eq(staffProfiles.userId, user.sub)).limit(1);
    if (!user.acl?.staff && prof?.kind !== 'STAFF') throw new ForbiddenException({ message: 'Access requests are for staff accounts', code: 'STAFF_ONLY' });
    if (user.svc) throw new ForbiddenException('Service accounts cannot request access');
    const [r] = await this.db.select().from(accessRoles).where(eq(accessRoles.id, input.roleId)).limit(1);
    if (!r || r.status !== 'ACTIVE' || !r.requestable || r.key === 'PLATFORM_ADMIN') throw new BadRequestException({ message: 'This role cannot be requested', code: 'NOT_REQUESTABLE' });
    if ((user.acl?.roles || []).some((x) => x.id === r.id && !x.endsAt)) throw new ConflictException({ message: 'You already hold this role', code: 'ALREADY_HELD' });
    const [dup] = await this.db.select({ id: accessRequests.id }).from(accessRequests).where(and(eq(accessRequests.requesterId, user.sub), eq(accessRequests.roleId, r.id), eq(accessRequests.status, 'PENDING'))).limit(1);
    if (dup) throw new ConflictException({ message: 'You already asked for this role', code: 'DUPLICATE_REQUEST' });
    if (input.justification.trim().length < 10) throw new BadRequestException({ message: 'Explain why you need it (at least 10 characters)', code: 'REASON_REQUIRED' });
    const [row] = await this.db.insert(accessRequests).values({ requesterId: user.sub, roleId: r.id, justification: input.justification.trim(), durationHours: input.durationHours ?? null, expiresAt: new Date(Date.now() + 7 * 86400_000) }).returning();
    await this.audit.log({ actorId: user.sub, action: 'iam.request.create', entityType: 'access_request', entityId: row.id, after: { role: r.key, durationHours: row.durationHours }, reason: row.justification });
    for (const id of await this.acl.securityRecipients()) {
      if (id === user.sub) continue;
      await this.notify.queue({ userId: id, template: 'access.request', payload: { requester: user.email, role: r.name, hours: row.durationHours, justification: row.justification }, channels: ['IN_APP', 'EMAIL'], dedupeKey: `accessreq:${row.id}:${id}` });
    }
    return row;
  }

  async listRequests(user: JwtPayload, q: { mine?: boolean; status?: string }) {
    const all = !q.mine && assertCanSoft(user);
    const conds = [];
    if (!all) conds.push(eq(accessRequests.requesterId, user.sub));
    if (q.status) conds.push(eq(accessRequests.status, q.status));
    const rows = await this.db
      .select({ r: accessRequests, role: accessRoles.name, roleKey: accessRoles.key, perms: accessRoles.permissions, email: users.email, name: users.name })
      .from(accessRequests)
      .innerJoin(accessRoles, eq(accessRoles.id, accessRequests.roleId))
      .innerJoin(users, eq(users.id, accessRequests.requesterId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(accessRequests.createdAt))
      .limit(300);
    return rows.map((x) => ({ ...x.r, roleName: x.role, roleKey: x.roleKey, privileged: isPrivileged(x.perms), requesterEmail: x.email, requesterName: x.name, canDecide: x.r.status === 'PENDING' && x.r.requesterId !== user.sub && canDecideRequest(user) }));
  }

  async decideRequest(user: JwtPayload, id: string, input: { approve: boolean; note?: string; durationHours?: number | null }) {
    this.manage(user, 'approve');
    const [r] = await this.db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException();
    if (r.status !== 'PENDING') throw new ConflictException(`Request is already ${r.status.toLowerCase()}`);
    if (r.requesterId === user.sub) throw new ForbiddenException({ message: 'You cannot approve your own request', code: 'SELF_APPROVAL' });
    if (r.expiresAt < now()) {
      await this.db.update(accessRequests).set({ status: 'EXPIRED' }).where(eq(accessRequests.id, id));
      throw new ConflictException('Request expired');
    }
    const [role] = await this.db.select().from(accessRoles).where(eq(accessRoles.id, r.roleId)).limit(1);
    if (!input.approve) {
      if (!input.note || input.note.trim().length < 3) throw new BadRequestException('Say why you are rejecting it');
      const [row] = await this.db.update(accessRequests).set({ status: 'REJECTED', decidedById: user.sub, decisionNote: input.note, decidedAt: now() }).where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'PENDING'))).returning();
      await this.audit.log({ actorId: user.sub, action: 'iam.request.reject', entityType: 'access_request', entityId: id, reason: input.note });
      await this.notify.queue({ userId: r.requesterId, template: 'access.request.decided', payload: { role: role?.name, status: 'REJECTED', note: input.note }, channels: ['IN_APP', 'EMAIL'] });
      return row;
    }
    const hours = input.durationHours !== undefined ? input.durationHours : r.durationHours;
    const res = await this.iam.assign(user, { userIds: [r.requesterId], roleId: r.roleId, kind: hours ? 'TEMPORARY' : 'STANDARD', endsAt: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null, reason: `Access request: ${r.justification}`, sourceRequestId: r.id });
    const assignmentId = 'assignments' in res ? (res.assignments[0] as { id: string })?.id : null;
    const [row] = await this.db.update(accessRequests).set({ status: 'APPROVED', decidedById: user.sub, decisionNote: input.note || null, decidedAt: now(), assignmentId, durationHours: hours ?? null }).where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'PENDING'))).returning();
    await this.audit.log({ actorId: user.sub, action: 'iam.request.approve', entityType: 'access_request', entityId: id, after: { assignmentId, hours }, reason: input.note });
    await this.notify.queue({ userId: r.requesterId, template: 'access.request.decided', payload: { role: role?.name, status: 'APPROVED', note: input.note }, channels: ['IN_APP', 'EMAIL', 'PUSH'] });
    return row;
  }

  async cancelRequest(user: JwtPayload, id: string) {
    const [row] = await this.db.update(accessRequests).set({ status: 'CANCELED', decidedAt: now() }).where(and(eq(accessRequests.id, id), eq(accessRequests.requesterId, user.sub), eq(accessRequests.status, 'PENDING'))).returning();
    if (!row) throw new NotFoundException('No pending request of yours with that id');
    await this.audit.log({ actorId: user.sub, action: 'iam.request.cancel', entityType: 'access_request', entityId: id });
    return row;
  }

  // ───── access reviews ─────

  async createReview(user: JwtPayload, input: { name: string; dueInDays?: number; roleIds?: string[]; inactiveDays?: number }, automatic = false) {
    if (!automatic) this.manage(user, 'edit');
    const pol = await this.iam.policy();
    const inactiveDays = input.inactiveDays ?? pol.inactiveDays;
    const [rev] = await this.db.insert(accessReviews).values({ name: input.name, dueAt: new Date(Date.now() + (input.dueInDays ?? 14) * 86400_000), criteria: { roleIds: input.roleIds || [], inactiveDays, automatic }, createdById: automatic ? null : user.sub }).returning();
    const t = now();
    const rows = await this.db
      .select({ a: roleAssignments, r: accessRoles, u: users, p: staffProfiles })
      .from(roleAssignments)
      .innerJoin(accessRoles, eq(accessRoles.id, roleAssignments.roleId))
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .leftJoin(staffProfiles, eq(staffProfiles.userId, roleAssignments.userId))
      .where(and(isNull(roleAssignments.revokedAt), lte(roleAssignments.startsAt, t), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, t)), eq(users.status, 'ACTIVE'), input.roleIds?.length ? inArray(roleAssignments.roleId, input.roleIds) : undefined));
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) byUser.set(r.u.id, [...(byUser.get(r.u.id) || []), r]);
    const lastSeen = byUser.size ? await this.db.select({ userId: userSessions.userId, last: sql<string>`max(${userSessions.lastSeenAt})` }).from(userSessions).where(inArray(userSessions.userId, [...byUser.keys()])).groupBy(userSessions.userId) : [];
    let n = 0;
    for (const [userId, list] of byUser) {
      const u = list[0].u;
      const p = list[0].p;
      const activity = Math.max(p?.lastLoginAt?.getTime() || 0, new Date(lastSeen.find((x) => x.userId === userId)?.last || 0).getTime());
      const flags: string[] = [];
      if (!activity) flags.push('NEVER_SIGNED_IN');
      else if (Date.now() - activity > inactiveDays * 86400_000) flags.push('INACTIVE');
      if (!u.mfaEnabledAt) flags.push('NO_MFA');
      if (list.some((x) => x.r.key === 'PLATFORM_ADMIN')) flags.push('SUPERADMIN');
      else if (list.some((x) => isPrivileged(x.r.permissions))) flags.push('PRIVILEGED');
      if (list.some((x) => x.a.endsAt)) flags.push('TEMPORARY');
      await this.db.insert(accessReviewItems).values({ reviewId: rev.id, userId, flags, snapshot: list.map((x) => ({ assignmentId: x.a.id, roleId: x.r.id, key: x.r.key, name: x.r.name, kind: x.a.kind, endsAt: x.a.endsAt })) });
      n++;
    }
    await this.audit.log({ actorId: automatic ? null : user.sub, action: 'iam.review.create', entityType: 'access_review', entityId: rev.id, after: { name: rev.name, people: n, automatic } });
    return { ...rev, items: n };
  }

  async listReviews(user: JwtPayload) {
    assertCan(user, 'security.read');
    const rows = await this.db.select().from(accessReviews).orderBy(desc(accessReviews.createdAt)).limit(50);
    const counts = rows.length ? await this.db.select({ id: accessReviewItems.reviewId, total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${accessReviewItems.decision} = 'PENDING')::int`, revoked: sql<number>`count(*) filter (where ${accessReviewItems.decision} in ('REVOKE','SUSPEND'))::int` }).from(accessReviewItems).where(inArray(accessReviewItems.reviewId, rows.map((r) => r.id))).groupBy(accessReviewItems.reviewId) : [];
    return rows.map((r) => ({ ...r, ...(counts.find((c) => c.id === r.id) || { total: 0, open: 0, revoked: 0 }) }));
  }

  async getReview(user: JwtPayload, id: string) {
    assertCan(user, 'security.read');
    const [rev] = await this.db.select().from(accessReviews).where(eq(accessReviews.id, id)).limit(1);
    if (!rev) throw new NotFoundException();
    const items = await this.db.select({ i: accessReviewItems, email: users.email, name: users.name, status: users.status }).from(accessReviewItems).innerJoin(users, eq(users.id, accessReviewItems.userId)).where(eq(accessReviewItems.reviewId, id)).orderBy(users.email);
    return { ...rev, items: items.map((x) => ({ ...x.i, email: x.email, name: x.name, userStatus: x.status, mine: x.i.userId === user.sub })) };
  }

  async decideItem(user: JwtPayload, reviewId: string, itemId: string, input: { decision: 'KEEP' | 'REVOKE' | 'SUSPEND'; note?: string; stepUp?: StepUp }) {
    this.manage(user, 'edit');
    const [it] = await this.db.select().from(accessReviewItems).where(and(eq(accessReviewItems.id, itemId), eq(accessReviewItems.reviewId, reviewId))).limit(1);
    if (!it) throw new NotFoundException();
    const [rev] = await this.db.select().from(accessReviews).where(eq(accessReviews.id, reviewId)).limit(1);
    if (rev?.status !== 'OPEN') throw new ConflictException('This review is closed');
    if (it.userId === user.sub) throw new ForbiddenException({ message: 'Someone else must review your access', code: 'SELF_REVIEW' });
    if (input.decision !== 'KEEP' && (!input.note || input.note.trim().length < 3)) throw new BadRequestException('Say why the access should go');
    if (input.decision === 'REVOKE') {
      const active = await this.db.select({ a: roleAssignments }).from(roleAssignments).where(and(eq(roleAssignments.userId, it.userId), isNull(roleAssignments.revokedAt)));
      if ((await this.acl.compute(it.userId)).superadmin) await this.iam.assertNotLastSuperadmin(it.userId);
      for (const a of active) await this.iam.revokeAssignment(user, a.a.id, { reason: `Access review "${rev.name}": ${input.note}`, stepUp: input.stepUp });
    }
    if (input.decision === 'SUSPEND') await this.iam.setStatus(user, it.userId, { status: 'SUSPENDED', reason: `Access review "${rev.name}": ${input.note}`, stepUp: input.stepUp });
    const [row] = await this.db.update(accessReviewItems).set({ decision: input.decision, reviewerId: user.sub, note: input.note || null, decidedAt: now() }).where(eq(accessReviewItems.id, itemId)).returning();
    await this.audit.log({ actorId: user.sub, action: `iam.review.${input.decision.toLowerCase()}`, entityType: 'user', entityId: it.userId, after: { reviewId }, reason: input.note });
    return row;
  }

  async completeReview(user: JwtPayload, id: string) {
    this.manage(user, 'edit');
    const [{ open }] = await this.db.select({ open: sql<number>`count(*) filter (where ${accessReviewItems.decision} = 'PENDING')::int` }).from(accessReviewItems).where(eq(accessReviewItems.reviewId, id));
    if (open > 0) throw new ConflictException({ message: `${open} person(s) still need a decision`, code: 'REVIEW_INCOMPLETE' });
    const [row] = await this.db.update(accessReviews).set({ status: 'COMPLETED', completedAt: now() }).where(and(eq(accessReviews.id, id), eq(accessReviews.status, 'OPEN'))).returning();
    if (!row) throw new NotFoundException('No open review with that id');
    await this.audit.log({ actorId: user.sub, action: 'iam.review.complete', entityType: 'access_review', entityId: id });
    return row;
  }

  // ───── service accounts & API keys ─────

  private apiManage(user: JwtPayload) {
    assertCan(user, 'integrations.manage');
    if (!canFine(user, 'integrations:manage_access')) throw new ForbiddenException({ message: 'Requires permission: integrations:manage_access', code: 'PERMISSION_REQUIRED' });
  }

  private assertGrantable(user: JwtPayload, perms: string[]) {
    const bad = perms.filter((p) => !ALL_FINE_PERMISSIONS.includes(p));
    if (bad.length) throw new BadRequestException(`Unknown permission: ${bad.join(', ')}`);
    if (perms.some((p) => p.startsWith('security:'))) throw new BadRequestException({ message: 'Service accounts cannot manage users, roles or security', code: 'SERVICE_SECURITY' });
    if (!this.iam.isSuperadmin(user)) {
      const mine = new Set(finePermissionsOf(user));
      const extra = perms.filter((p) => !mine.has(p));
      if (extra.length) throw new ForbiddenException({ message: `You cannot grant permissions you do not have: ${extra.join(', ')}`, code: 'PRIVILEGE_ESCALATION' });
    }
  }

  async listServiceAccounts(user: JwtPayload) {
    assertCan(user, 'integrations.manage');
    const rows = await this.db.select({ s: serviceAccounts, owner: users.email }).from(serviceAccounts).leftJoin(users, eq(users.id, serviceAccounts.ownerId)).orderBy(serviceAccounts.name);
    const keys = rows.length ? await this.db.select().from(apiKeys).where(inArray(apiKeys.serviceAccountId, rows.map((r) => r.s.id))).orderBy(desc(apiKeys.createdAt)) : [];
    const t = Date.now();
    return rows.map((r) => ({
      ...r.s,
      ownerEmail: r.owner,
      keys: keys.filter((k) => k.serviceAccountId === r.s.id).map(({ keyHash: _h, ...k }) => ({ ...k, state: k.revokedAt ? 'REVOKED' : k.expiresAt.getTime() <= t ? 'EXPIRED' : k.expiresAt.getTime() - t < 14 * 86400_000 ? 'EXPIRING' : 'ACTIVE' })),
    }));
  }

  async createServiceAccount(user: JwtPayload, input: { name: string; description?: string; ownerId?: string | null; permissions: string[]; organizationIds?: string[]; ipAllowlist?: string[]; reason: string }) {
    this.apiManage(user);
    const perms = Array.from(new Set(input.permissions));
    this.assertGrantable(user, perms);
    const handle = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'service';
    const [shadow] = await this.db.insert(users).values({ email: `svc-${handle}-${token(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}@service.gutad.local`, name: `Service: ${input.name}`, roles: ['CUSTOMER'] }).returning();
    await this.db.insert(staffProfiles).values({ userId: shadow.id, kind: 'SERVICE' });
    const [row] = await this.db.insert(serviceAccounts).values({ userId: shadow.id, name: input.name, description: input.description || '', ownerId: input.ownerId ?? user.sub, permissions: perms, organizationIds: input.organizationIds || [], ipAllowlist: input.ipAllowlist || [], createdById: user.sub }).returning();
    await this.audit.log({ actorId: user.sub, action: 'iam.service.create', entityType: 'service_account', entityId: row.id, after: { name: row.name, permissions: perms, organizationIds: row.organizationIds }, reason: input.reason });
    await this.events.raise({ type: 'API_KEY', severity: 'MEDIUM', title: `Service account created: ${row.name}`, detail: `By ${user.email}. Permissions: ${perms.join(', ') || 'none'}.`, actorId: user.sub, data: { serviceAccountId: row.id } });
    return row;
  }

  private async svc(id: string) {
    const [s] = await this.db.select().from(serviceAccounts).where(eq(serviceAccounts.id, id)).limit(1);
    if (!s) throw new NotFoundException('Service account not found');
    return s;
  }

  private async forgetKeysOf(serviceAccountId: string) {
    const ks = await this.db.select({ h: apiKeys.keyHash }).from(apiKeys).where(eq(apiKeys.serviceAccountId, serviceAccountId));
    await this.acl.forgetKeys(ks.map((k) => k.h));
  }

  async updateServiceAccount(user: JwtPayload, id: string, input: { description?: string; ownerId?: string | null; permissions?: string[]; organizationIds?: string[]; ipAllowlist?: string[]; status?: 'ACTIVE' | 'DISABLED'; reason: string }) {
    this.apiManage(user);
    const s = await this.svc(id);
    if (input.permissions) this.assertGrantable(user, input.permissions);
    const set = Object.fromEntries(Object.entries({ description: input.description, ownerId: input.ownerId, permissions: input.permissions && Array.from(new Set(input.permissions)), organizationIds: input.organizationIds, ipAllowlist: input.ipAllowlist, status: input.status }).filter(([, v]) => v !== undefined));
    const [row] = await this.db.update(serviceAccounts).set(set).where(eq(serviceAccounts.id, id)).returning();
    await this.forgetKeysOf(id);
    await this.acl.invalidate(s.userId);
    await this.audit.log({ actorId: user.sub, action: 'iam.service.update', entityType: 'service_account', entityId: id, before: { permissions: s.permissions, status: s.status, organizationIds: s.organizationIds }, after: set, reason: input.reason });
    const added = (input.permissions || []).filter((p) => !s.permissions.includes(p));
    if (added.length || input.status) await this.events.raise({ type: 'API_KEY', severity: added.length ? 'MEDIUM' : 'LOW', title: `Service account ${s.name} ${input.status ? input.status.toLowerCase() : 'permissions changed'}`, detail: `${added.length ? `Added: ${added.join(', ')}. ` : ''}By ${user.email}.`, actorId: user.sub, data: { serviceAccountId: id } });
    return row;
  }

  async createKey(user: JwtPayload, serviceAccountId: string, input: { name: string; expiresInDays: number; reason?: string }, rotatedFromId?: string) {
    this.apiManage(user);
    const s = await this.svc(serviceAccountId);
    if (s.status !== 'ACTIVE') throw new ConflictException('Enable the service account first');
    const pol = await this.iam.policy();
    if (input.expiresInDays < 1 || input.expiresInDays > pol.apiKeyMaxDays) throw new BadRequestException(`Keys expire within 1–${pol.apiKeyMaxDays} days`);
    const raw = `gsk_${token(32).replace(/[^A-Za-z0-9]/g, '')}`;
    const [k] = await this.db.insert(apiKeys).values({ serviceAccountId, name: input.name, prefix: raw.slice(0, 12), keyHash: this.crypto.sha256(raw), expiresAt: new Date(Date.now() + input.expiresInDays * 86400_000), createdById: user.sub, rotatedFromId: rotatedFromId ?? null }).returning();
    await this.audit.log({ actorId: user.sub, action: rotatedFromId ? 'iam.key.rotate' : 'iam.key.create', entityType: 'service_account', entityId: serviceAccountId, after: { keyId: k.id, prefix: k.prefix, expiresAt: k.expiresAt, rotatedFromId }, reason: input.reason });
    await this.events.raise({ type: 'API_KEY', severity: 'LOW', title: `API key ${rotatedFromId ? 'rotated' : 'created'} for ${s.name}`, detail: `${k.prefix}… expires ${k.expiresAt.toISOString().slice(0, 10)}. By ${user.email}.`, actorId: user.sub, data: { keyId: k.id } });
    const { keyHash: _h, ...safe } = k;
    return { ...safe, key: raw };
  }

  async rotateKey(user: JwtPayload, keyId: string, input: { graceHours?: number; expiresInDays?: number; reason?: string }) {
    this.apiManage(user);
    const [k] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
    if (!k || k.revokedAt) throw new NotFoundException('Active key not found');
    const pol = await this.iam.policy();
    const fresh = await this.createKey(user, k.serviceAccountId, { name: k.name, expiresInDays: input.expiresInDays ?? Math.min(pol.apiKeyMaxDays, 90), reason: input.reason }, k.id);
    const grace = new Date(Date.now() + Math.min(Math.max(0, input.graceHours ?? 24), 168) * 3600_000);
    if (grace < k.expiresAt) await this.db.update(apiKeys).set({ expiresAt: grace }).where(eq(apiKeys.id, keyId));
    await this.acl.forgetKeys([k.keyHash]);
    return { ...fresh, previousKeyExpiresAt: grace < k.expiresAt ? grace : k.expiresAt };
  }

  async revokeKey(user: JwtPayload, keyId: string, reason: string) {
    this.apiManage(user);
    const [k] = await this.db.update(apiKeys).set({ revokedAt: now(), revokedById: user.sub, revokeReason: reason }).where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt))).returning();
    if (!k) throw new NotFoundException('Active key not found');
    await this.acl.forgetKeys([k.keyHash]);
    await this.audit.log({ actorId: user.sub, action: 'iam.key.revoke', entityType: 'service_account', entityId: k.serviceAccountId, after: { keyId, prefix: k.prefix }, reason });
    return { ok: true };
  }

  /** Who is calling: works for staff tokens and API keys. */
  whoami(user: JwtPayload) {
    return { id: user.sub, email: user.email, serviceAccountId: user.svc?.id ?? null, keyId: user.svc?.keyId ?? null, staff: !!user.acl?.staff, roles: user.acl?.roles.map((r) => r.key) || [], permissions: finePermissionsOf(user), scope: user.scope ?? null };
  }

  // ───── security alerts ─────

  async listAlerts(user: JwtPayload, q: { open?: boolean; type?: string; limit?: number }) {
    assertCan(user, 'security.read');
    const conds = [];
    if (q.open) conds.push(isNull(securityAlerts.acknowledgedAt));
    if (q.type) conds.push(eq(securityAlerts.type, q.type));
    const rows = await this.db.select({ a: securityAlerts, subject: users.email }).from(securityAlerts).leftJoin(users, eq(users.id, securityAlerts.subjectUserId)).where(conds.length ? and(...conds) : undefined).orderBy(desc(securityAlerts.createdAt)).limit(Math.min(q.limit || 200, 500));
    return rows.map((r) => ({ ...r.a, subjectEmail: r.subject }));
  }

  async ackAlert(user: JwtPayload, id: string | 'all') {
    assertCan(user, 'security.read');
    const rows = await this.db.update(securityAlerts).set({ acknowledgedAt: now(), acknowledgedById: user.sub }).where(and(id === 'all' ? undefined : eq(securityAlerts.id, id), isNull(securityAlerts.acknowledgedAt))).returning({ id: securityAlerts.id });
    await this.audit.log({ actorId: user.sub, action: 'iam.alert.ack', entityType: 'security_alert', entityId: id, after: { count: rows.length } });
    return { acknowledged: rows.length };
  }

  // ───── access policy ─────

  async getPolicy(user: JwtPayload) {
    assertCan(user, 'security.read');
    return { policy: await this.iam.policy(), superadmins: await this.acl.activeSuperadmins() };
  }

  async updatePolicy(user: JwtPayload, input: Partial<AccessPolicy> & { reason: string; stepUp?: StepUp }) {
    this.manage(user, 'edit');
    assertCan(user, 'settings.manage');
    const { reason, stepUp, ...patch } = input;
    const cur = await this.iam.policy();
    if ((patch.superadminGranters !== undefined || patch.requireSecondApprover !== undefined) && !this.iam.isSuperadmin(user)) throw new ForbiddenException({ message: 'Only a superadmin can change superadmin safeguards', code: 'SUPERADMIN_ONLY' });
    if (patch.superadminGranters?.length) {
      const admins = await this.acl.activeSuperadmins();
      const bad = patch.superadminGranters.filter((g) => !admins.includes(g));
      if (bad.length) throw new BadRequestException('Granters must be active superadmins');
    }
    await this.auth.verifyStepUp(user.sub, stepUp);
    const next = { ...cur, ...patch };
    await this.db.insert(platformSettings).values({ key: 'security.access_policy', value: next as never }).onConflictDoUpdate({ target: platformSettings.key, set: { value: next as never } });
    await this.audit.configChange({ key: 'security.access_policy', before: cur, after: next, actorId: user.sub, approvedById: user.sub });
    await this.audit.log({ actorId: user.sub, action: 'iam.policy.update', entityType: 'platform_setting', entityId: 'security.access_policy', before: cur, after: next, reason });
    await this.redis.del('setting:security.access_policy');
    await this.acl.invalidateAll();
    const weakened = (cur.requireSecondApprover && next.requireSecondApprover === false) || next.maxLoginAttempts > cur.maxLoginAttempts;
    await this.events.raise({ type: 'SENSITIVE_CHANGE', severity: weakened ? 'HIGH' : 'LOW', title: `Access policy changed${weakened ? ' (a safeguard was relaxed)' : ''}`, detail: `By ${user.email}: ${Object.keys(patch).join(', ')}. ${reason}`, actorId: user.sub });
    return next;
  }

  // ───── worker sweeps ─────

  /** Every minute: scheduled roles start, temporary roles end, suspensions lift, requests expire. */
  async sweep() {
    const t = now();
    const starting = await this.db.select().from(roleAssignments).where(and(isNull(roleAssignments.activatedAt), isNull(roleAssignments.revokedAt), lte(roleAssignments.startsAt, t)));
    const ending = await this.db.select().from(roleAssignments).where(and(isNull(roleAssignments.expiredAt), isNull(roleAssignments.revokedAt), isNotNull(roleAssignments.endsAt), lte(roleAssignments.endsAt, t)));
    for (const a of starting) {
      await this.db.update(roleAssignments).set({ activatedAt: t }).where(eq(roleAssignments.id, a.id));
      await this.acl.syncUserRoles(a.userId);
      await this.audit.log({ action: 'iam.assignment.start', entityType: 'user', entityId: a.userId, after: { assignmentId: a.id } });
    }
    for (const a of ending) {
      await this.db.update(roleAssignments).set({ expiredAt: t }).where(eq(roleAssignments.id, a.id));
      await this.acl.syncUserRoles(a.userId);
      await this.audit.log({ action: 'iam.assignment.expire', entityType: 'user', entityId: a.userId, after: { assignmentId: a.id, kind: a.kind } });
    }
    const lifted = await this.db.select({ userId: staffProfiles.userId }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId)).where(and(eq(users.status, 'SUSPENDED'), isNotNull(staffProfiles.suspendedUntil), lte(staffProfiles.suspendedUntil, t)));
    for (const l of lifted) {
      await this.db.update(users).set({ status: 'ACTIVE', statusReason: 'suspension ended' }).where(eq(users.id, l.userId));
      await this.db.update(staffProfiles).set({ suspendedUntil: null }).where(eq(staffProfiles.userId, l.userId));
      await this.acl.invalidate(l.userId);
      await this.audit.log({ action: 'iam.user.suspension_end', entityType: 'user', entityId: l.userId });
    }
    const expired = await this.db.update(accessRequests).set({ status: 'EXPIRED' }).where(and(eq(accessRequests.status, 'PENDING'), lt(accessRequests.expiresAt, t))).returning({ id: accessRequests.id });
    return { started: starting.length, ended: ending.length, suspensionsLifted: lifted.length, requestsExpired: expired.length };
  }

  /** Hourly: inactive staff, expiring API keys, automatic access-review campaigns. */
  async hourly() {
    const pol = await this.iam.policy();
    const t = Date.now();
    // inactive staff
    const staff = await this.db.execute(sql`
      select u.id, u.email, u.created_at, p.inactive_flagged_at, greatest(p.last_login_at, (select max(s.last_seen_at) from user_sessions s where s.user_id = u.id)) as last_activity
      from users u
      left join staff_profiles p on p.user_id = u.id
      where u.status = 'ACTIVE'
        and u.id in (select user_id from role_assignments where revoked_at is null and (ends_at is null or ends_at > now()))
        and u.id not in (select user_id from service_accounts)`);
    const list = ((staff as unknown as { rows?: unknown[] }).rows ?? (staff as unknown as unknown[])) as { id: string; email: string; created_at: string; inactive_flagged_at: string | null; last_activity: string | null }[];
    let flagged = 0, suspended = 0;
    for (const s of list) {
      const last = s.last_activity ? new Date(s.last_activity).getTime() : new Date(s.created_at).getTime();
      const idleDays = (t - last) / 86400_000;
      if (pol.autoSuspendInactiveDays > 0 && idleDays > pol.autoSuspendInactiveDays && !(await this.acl.compute(s.id)).superadmin) {
        await this.db.update(users).set({ status: 'SUSPENDED', statusReason: `inactive for ${Math.floor(idleDays)} days` }).where(eq(users.id, s.id));
        await this.auth.revokeAllSessions(s.id, 'suspended for inactivity');
        await this.acl.invalidate(s.id);
        await this.audit.log({ action: 'iam.user.auto_suspend', entityType: 'user', entityId: s.id, after: { idleDays: Math.floor(idleDays) } });
        await this.events.raise({ type: 'INACTIVE_ACCOUNT', severity: 'MEDIUM', title: `Suspended for inactivity: ${s.email}`, detail: `No sign-in for ${Math.floor(idleDays)} days.`, subjectUserId: s.id, dedupeKey: `autosuspend:${s.id}:${new Date().toISOString().slice(0, 10)}` });
        suspended++;
      } else if (idleDays > pol.inactiveDays && !s.inactive_flagged_at) {
        await this.db.insert(staffProfiles).values({ userId: s.id, inactiveFlaggedAt: new Date() }).onConflictDoUpdate({ target: staffProfiles.userId, set: { inactiveFlaggedAt: new Date() } });
        await this.events.raise({ type: 'INACTIVE_ACCOUNT', severity: 'LOW', title: `Inactive staff account: ${s.email}`, detail: `No sign-in for ${Math.floor(idleDays)} days. Review whether the access is still needed.`, subjectUserId: s.id, dedupeKey: `inactive:${s.id}:${new Date().toISOString().slice(0, 7)}` });
        flagged++;
      }
    }
    // API keys expiring within 14 days
    const soon = await this.db.select({ k: apiKeys, name: serviceAccounts.name }).from(apiKeys).innerJoin(serviceAccounts, eq(serviceAccounts.id, apiKeys.serviceAccountId)).where(and(isNull(apiKeys.revokedAt), isNull(apiKeys.expiryWarnedAt), gt(apiKeys.expiresAt, new Date(t)), lte(apiKeys.expiresAt, new Date(t + 14 * 86400_000))));
    for (const s of soon) {
      if ((await this.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.rotatedFromId, s.k.id)).limit(1)).length) continue; // already rotated
      await this.db.update(apiKeys).set({ expiryWarnedAt: new Date() }).where(eq(apiKeys.id, s.k.id));
      await this.events.raise({ type: 'KEY_EXPIRING', severity: 'MEDIUM', title: `API key for ${s.name} expires ${s.k.expiresAt.toISOString().slice(0, 10)}`, detail: `Key ${s.k.prefix}… Rotate it before then to avoid an outage.`, dedupeKey: `keyexp:${s.k.id}` });
    }
    // periodic access review
    let review = null;
    if (pol.reviewIntervalDays > 0) {
      const [last] = await this.db.select().from(accessReviews).orderBy(desc(accessReviews.createdAt)).limit(1);
      if (!last || t - last.createdAt.getTime() > pol.reviewIntervalDays * 86400_000) {
        const anyStaff = await this.db.select({ id: roleAssignments.id }).from(roleAssignments).where(isNull(roleAssignments.revokedAt)).limit(1);
        if (anyStaff.length) review = await this.createReview({ sub: '', email: 'system', roles: [], orgs: {} }, { name: `Periodic access review ${new Date().toISOString().slice(0, 10)}`, dueInDays: 14 }, true);
      }
    }
    return { flagged, suspended, keysExpiring: soon.length, review: review?.id ?? null };
  }

  async ensureDefaultPolicy() {
    return this.settings.getObject<AccessPolicy>('security.access_policy', DEFAULT_ACCESS_POLICY);
  }
}

/** Security viewers see everyone's requests; others see their own. */
function assertCanSoft(user: JwtPayload) {
  try {
    assertCan(user, 'security.read');
    return true;
  } catch {
    return false;
  }
}

function canDecideRequest(user: JwtPayload) {
  return canFine(user, 'security:approve') || canFine(user, 'security:manage_access');
}
