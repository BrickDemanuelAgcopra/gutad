import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { APPROVAL_KINDS, DEFAULT_APPROVAL_THRESHOLDS, type ApprovalKind } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { approvalRequests, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { can, isPlatformStaff, JwtPayload, staffCovers } from '../../common/auth';

type Row = typeof approvalRequests.$inferSelect;

export interface ApprovalHandler {
  /** Runs once the request has enough approvals. Must be idempotent (it may be retried after a failure). */
  execute(req: Row, approver: JwtPayload): Promise<unknown>;
  /** Extra deciders beyond staff with the kind's permission, e.g. the merchant owner for in-org purchase orders. */
  canDecide?(user: JwtPayload, req: Row): boolean;
}

export interface SubmitInput {
  kind: ApprovalKind;
  summary: string;
  organizationId?: string | null;
  subjectType: string;
  subjectId: string;
  amountCents?: number | null;
  payload?: Record<string, unknown>;
  reason: string;
  /** approvals needed from people other than the requester (default 1 = two-person rule) */
  requiredApprovals?: number;
  dedupeKey?: string;
  expiresInHours?: number;
}

/**
 * One approval engine for refunds, bank-account changes, sensitive settings, purchase orders, price changes
 * and payout releases. The requester can never approve their own request; the action runs only on final approval.
 */
@Injectable()
export class ApprovalsService {
  private readonly log = new Logger(ApprovalsService.name);
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly notify: NotifyService, private readonly settings: SettingsService) {}

  register(kind: ApprovalKind, handler: ApprovalHandler) {
    this.handlers.set(kind, handler);
  }

  thresholds() {
    return this.settings.getObject('approvals.thresholds', DEFAULT_APPROVAL_THRESHOLDS);
  }

  /** Staff refund limit for this person (highest of their roles); platform admins are unlimited. */
  async staffRefundLimit(user: JwtPayload): Promise<number> {
    if (user.roles.includes('PLATFORM_ADMIN')) return Number.MAX_SAFE_INTEGER;
    const t = await this.thresholds();
    return Math.max(0, ...user.roles.map((r) => t.refundByRole[r] ?? 0));
  }

  async submit(user: JwtPayload, input: SubmitInput) {
    if (!input.reason || input.reason.trim().length < 5) throw new BadRequestException({ message: 'A reason (at least 5 characters) is required', code: 'REASON_REQUIRED' });
    if (input.dedupeKey) {
      const [dup] = await this.db.select().from(approvalRequests).where(and(eq(approvalRequests.dedupeKey, input.dedupeKey), eq(approvalRequests.status, 'PENDING'))).limit(1);
      if (dup) return { status: 'PENDING_APPROVAL' as const, approval: dup, duplicate: true };
    }
    const [row] = await this.db
      .insert(approvalRequests)
      .values({
        kind: input.kind,
        summary: input.summary,
        organizationId: input.organizationId ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        amountCents: input.amountCents ?? null,
        payload: input.payload || {},
        reason: input.reason.trim(),
        requestedById: user.sub,
        requiredApprovals: Math.max(1, input.requiredApprovals ?? 1),
        dedupeKey: input.dedupeKey ?? null,
        expiresAt: new Date(Date.now() + (input.expiresInHours ?? 72) * 3600_000),
      })
      .returning();
    await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'approval.request', entityType: 'approval_request', entityId: row.id, after: { kind: row.kind, summary: row.summary, amountCents: row.amountCents }, reason: row.reason });
    await this.notifyApprovers(row, user.email);
    return { status: 'PENDING_APPROVAL' as const, approval: row };
  }

  private async notifyApprovers(row: Row, requester: string) {
    const perm = APPROVAL_KINDS[row.kind as ApprovalKind]?.permission;
    const staff = await this.db.select({ id: users.id, roles: users.roles }).from(users).where(sql`${users.roles} && array['PLATFORM_ADMIN','EXECUTIVE','FINANCE','OPERATIONS','SUPPORT','IT','CULINARY']::role[]`).limit(50);
    for (const s of staff) {
      if (s.id === row.requestedById) continue;
      const fake: JwtPayload = { sub: s.id, email: '', roles: s.roles as JwtPayload['roles'], orgs: {} };
      if (!can(fake, 'approvals.decide') || (perm && !can(fake, perm))) continue;
      await this.notify.queue({ userId: s.id, template: 'approval.requested', payload: { summary: row.summary, amountCents: row.amountCents, reason: row.reason, requester }, channels: ['IN_APP', 'PUSH'], dedupeKey: `approval:${row.id}` });
    }
  }

  canDecide(user: JwtPayload, row: Row): boolean {
    if (row.requestedById === user.sub) return false;
    const perm = APPROVAL_KINDS[row.kind as ApprovalKind]?.permission;
    if (can(user, 'approvals.decide') && (!perm || can(user, perm)) && (!row.organizationId || staffCovers(user, row.organizationId))) return true;
    return !!this.handlers.get(row.kind)?.canDecide?.(user, row);
  }

  async decide(user: JwtPayload, id: string, approve: boolean, note?: string) {
    const [row] = await this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    if (row.status !== 'PENDING') throw new ConflictException(`Request is already ${row.status.toLowerCase()}`);
    if (row.requestedById === user.sub) throw new ForbiddenException({ message: 'You cannot decide your own request', code: 'SELF_APPROVAL' });
    if (!this.canDecide(user, row)) throw new ForbiddenException('You are not allowed to decide this request');
    if (row.expiresAt && row.expiresAt < new Date()) {
      await this.db.update(approvalRequests).set({ status: 'EXPIRED' }).where(eq(approvalRequests.id, id));
      throw new ConflictException('Request expired');
    }
    const approvals = (row.approvals as { userId: string; email: string; at: string; note?: string | null }[]) || [];
    if (approvals.some((a) => a.userId === user.sub)) throw new ConflictException('You already approved this request');
    if (!approve) {
      if (!note || note.trim().length < 3) throw new BadRequestException('Say why you are rejecting it');
      const [u] = await this.db.update(approvalRequests).set({ status: 'REJECTED', decidedById: user.sub, decisionNote: note, decidedAt: new Date() }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'PENDING'))).returning();
      await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'approval.reject', entityType: 'approval_request', entityId: id, reason: note });
      await this.notify.queue({ userId: row.requestedById, template: 'approval.decided', payload: { summary: row.summary, status: 'REJECTED', note }, channels: ['IN_APP', 'PUSH', 'EMAIL'] });
      return u;
    }
    const next = [...approvals, { userId: user.sub, email: user.email, at: new Date().toISOString(), note: note || null }];
    if (next.length < row.requiredApprovals) {
      const [u] = await this.db.update(approvalRequests).set({ approvals: next }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'PENDING'))).returning();
      await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'approval.approve_partial', entityType: 'approval_request', entityId: id, reason: note });
      return u;
    }
    // claim the request atomically so two approvers can't execute it twice
    const [claimed] = await this.db.update(approvalRequests).set({ approvals: next, status: 'APPROVED', decidedById: user.sub, decisionNote: note || null, decidedAt: new Date() }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'PENDING'))).returning();
    if (!claimed) throw new ConflictException('Request was decided by someone else');
    await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'approval.approve', entityType: 'approval_request', entityId: id, reason: note });
    return this.execute(claimed, user);
  }

  /** Runs the handler for an APPROVED (or FAILED, on retry) request. */
  async execute(row: Row, approver: JwtPayload) {
    const h = this.handlers.get(row.kind);
    if (!h) throw new BadRequestException(`No handler for ${row.kind}`);
    try {
      const result = await h.execute(row, approver);
      const [u] = await this.db.update(approvalRequests).set({ status: 'EXECUTED', executedAt: new Date(), result: (result ?? null) as never }).where(eq(approvalRequests.id, row.id)).returning();
      await this.notify.queue({ userId: row.requestedById, template: 'approval.decided', payload: { summary: row.summary, status: 'APPROVED' }, channels: ['IN_APP', 'PUSH'] });
      return u;
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`approval ${row.id} (${row.kind}) failed: ${msg}`);
      const [u] = await this.db.update(approvalRequests).set({ status: 'FAILED', result: { error: msg } }).where(eq(approvalRequests.id, row.id)).returning();
      return u;
    }
  }

  async retry(user: JwtPayload, id: string) {
    const [row] = await this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    if (row.status !== 'FAILED') throw new ConflictException('Only failed requests can be retried');
    if (!this.canDecide(user, row) && row.decidedById !== user.sub) throw new ForbiddenException();
    return this.execute(row, user);
  }

  async cancel(user: JwtPayload, id: string) {
    const [row] = await this.db.update(approvalRequests).set({ status: 'CANCELED', decidedAt: new Date(), decidedById: user.sub }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.requestedById, user.sub), eq(approvalRequests.status, 'PENDING'))).returning();
    if (!row) throw new NotFoundException('No pending request of yours with that id');
    await this.audit.log({ organizationId: row.organizationId, actorId: user.sub, action: 'approval.cancel', entityType: 'approval_request', entityId: id });
    return row;
  }

  /** Staff deciders see requests in their scope; merchants see their organizations' requests; everyone sees their own. */
  async list(user: JwtPayload, q: { status?: string; kind?: string; mine?: boolean; organizationId?: string }) {
    const conds = [];
    if (q.status) conds.push(eq(approvalRequests.status, q.status));
    if (q.kind) conds.push(eq(approvalRequests.kind, q.kind));
    if (q.organizationId) conds.push(eq(approvalRequests.organizationId, q.organizationId));
    if (q.mine) conds.push(eq(approvalRequests.requestedById, user.sub));
    const rows = await this.db
      .select({ r: approvalRequests, email: users.email })
      .from(approvalRequests)
      .leftJoin(users, eq(users.id, approvalRequests.requestedById))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(200);
    const staff = isPlatformStaff(user) && can(user, 'approvals.decide');
    const myOrgs = Object.keys(user.orgs || {});
    return rows
      .filter(({ r }) => r.requestedById === user.sub || (staff && (!r.organizationId || staffCovers(user, r.organizationId))) || (r.organizationId && myOrgs.includes(r.organizationId)))
      .map(({ r, email }) => ({ ...r, requestedByEmail: email, canDecide: r.status === 'PENDING' && this.canDecide(user, r) }));
  }

  async get(user: JwtPayload, id: string) {
    const rows = await this.list(user, {});
    const hit = rows.find((r) => r.id === id);
    if (hit) return hit;
    const [row] = await this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    if (row.requestedById !== user.sub && !this.canDecide(user, row)) throw new ForbiddenException();
    return { ...row, canDecide: row.status === 'PENDING' && this.canDecide(user, row) };
  }

  async pendingCount(user: JwtPayload) {
    const rows = await this.list(user, { status: 'PENDING' });
    return { pending: rows.filter((r) => r.canDecide).length, mine: rows.filter((r) => r.requestedById === user.sub).length };
  }

  /** Worker: pending requests past their expiry become EXPIRED. */
  async expireStale() {
    const rows = await this.db.update(approvalRequests).set({ status: 'EXPIRED' }).where(and(eq(approvalRequests.status, 'PENDING'), lt(approvalRequests.expiresAt, new Date()))).returning({ id: approvalRequests.id });
    return { expired: rows.length };
  }

  /** Whether a pending or executed approval already covers this dedupe key (used to block duplicate compensation). */
  async existing(dedupeKey: string) {
    return this.db.select().from(approvalRequests).where(and(eq(approvalRequests.dedupeKey, dedupeKey), inArray(approvalRequests.status, ['PENDING', 'APPROVED', 'EXECUTED']))).limit(1);
  }
}
