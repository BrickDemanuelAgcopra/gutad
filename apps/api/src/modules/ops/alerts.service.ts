import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { opsAlerts, users } from '../../db/schema';
import { AuditService } from '../../core/audit.service';
import { NotifyService } from '../../core/notify.service';
import { SettingsService } from '../../core/settings.service';
import { assertCan, can, JwtPayload, staffCovers } from '../../common/auth';
import type { Permission } from '@gutad/shared';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
interface Detected { dedupeKey: string; type: string; severity: Severity; title: string; detail?: string; subjectType: string; subjectId: string; organizationId?: string | null; locationId?: string | null; ownerRole: string }
type Alert = typeof opsAlerts.$inferSelect;

export const ALERT_DEFAULTS = {
  unacceptedMinutes: 5,
  overdueMinutes: 10,
  readyWaitingMinutes: 20,
  deliveryLateMinutes: 10,
  /** minutes until an unresolved alert escalates, by severity */
  escalateMinutes: { CRITICAL: 10, HIGH: 20, MEDIUM: 60, LOW: 240 } as Record<Severity, number>,
};
/** Who takes over at each escalation level. */
const ESCALATE_TO: Record<string, string> = { SUPPORT: 'OPERATIONS', DISPATCHER: 'OPERATIONS', IT: 'OPERATIONS', FINANCE: 'EXECUTIVE', OPERATIONS: 'EXECUTIVE', EXECUTIVE: 'PLATFORM_ADMIN', PLATFORM_ADMIN: 'PLATFORM_ADMIN' };
const TEAM_PERMISSION: Record<string, Permission> = { OPERATIONS: 'ops.manage', DISPATCHER: 'delivery.manage', FINANCE: 'finance.manage', IT: 'integrations.manage', SUPPORT: 'support.manage', EXECUTIVE: 'ops.manage', PLATFORM_ADMIN: 'ops.manage' };
const rows = <T>(r: unknown) => ((r as { rows: T[] }).rows || []) as T[];
/** Detector types that clear themselves when the condition is gone. */
const AUTO_TYPES = ['ORDER_UNACCEPTED', 'ORDER_OVERDUE', 'READY_WAITING', 'DELIVERY_LATE', 'STATUS_CONFLICT', 'DEVICE_OFFLINE', 'LOCATION_PAUSED', 'PAYOUT_FAILED', 'WEBHOOK_FAILED'];

/** 1.7 & 12.8 — alerts with an owner, an escalation deadline and resolution history; detectors and escalation run in the worker. */
@Injectable()
export class AlertsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly notify: NotifyService, private readonly settings: SettingsService) {}

  private cfg() {
    return this.settings.getObject('ops.alerts', ALERT_DEFAULTS);
  }

  private entry(by: string | null, action: string, note?: string | null, extra?: Record<string, unknown>) {
    return { at: new Date().toISOString(), by, action, note: note ?? null, ...(extra || {}) };
  }

  async raise(d: Detected, by: string | null = null): Promise<{ alert: Alert; created: boolean }> {
    const [open] = await this.db.select().from(opsAlerts).where(and(eq(opsAlerts.dedupeKey, d.dedupeKey), ne(opsAlerts.status, 'RESOLVED'))).limit(1);
    if (open) return { alert: open, created: false };
    const cfg = await this.cfg();
    try {
      const [a] = await this.db
        .insert(opsAlerts)
        .values({ ...d, organizationId: d.organizationId ?? null, locationId: d.locationId ?? null, escalateAt: new Date(Date.now() + cfg.escalateMinutes[d.severity] * 60_000), history: [this.entry(by, 'RAISED', d.detail)] })
        .returning();
      if (d.severity === 'HIGH' || d.severity === 'CRITICAL') await this.page(a, false);
      return { alert: a, created: true };
    } catch {
      const [again] = await this.db.select().from(opsAlerts).where(and(eq(opsAlerts.dedupeKey, d.dedupeKey), ne(opsAlerts.status, 'RESOLVED'))).limit(1);
      return { alert: again, created: false };
    }
  }

  /** Notify the owner (or everyone on the owning team) about an alert. */
  private async page(a: Alert, escalated: boolean) {
    const targets = a.ownerId ? [{ id: a.ownerId }] : await this.db.select({ id: users.id }).from(users).where(and(sql`${a.ownerRole}::role = any(${users.roles})`, eq(users.status, 'ACTIVE'))).limit(25);
    for (const t of targets) await this.notify.queue({ userId: t.id, template: 'ops.alert', payload: { title: a.title, detail: a.detail, severity: a.severity, escalated, level: a.escalationLevel, alertId: a.id }, channels: ['IN_APP', 'PUSH'], dedupeKey: `alert:${a.id}:${a.escalationLevel}` });
  }

  // ───── detectors ─────

  async detect() {
    const c = await this.cfg();
    const found: Detected[] = [];
    const q = async <T>(s: ReturnType<typeof sql>) => rows<T>(await this.db.execute(s));
    for (const o of await q<{ id: string; number: string; organization_id: string; location_id: string; m: number; name: string }>(sql`select o.id, o.number, o.organization_id, o.location_id, l.name, extract(epoch from now() - o.created_at)::int / 60 as m from orders o join locations l on l.id = o.location_id where o.status = 'SUBMITTED' and (o.scheduled_for is null or o.scheduled_for <= now() + interval '45 minutes') and o.created_at < now() - make_interval(mins => ${c.unacceptedMinutes}) and o.created_at > now() - interval '1 day'`)) {
      found.push({ dedupeKey: `unaccepted:${o.id}`, type: 'ORDER_UNACCEPTED', severity: o.m >= 15 ? 'CRITICAL' : 'HIGH', title: `Order ${o.number} not accepted for ${o.m} min`, detail: `${o.name} has not accepted it yet.`, subjectType: 'order', subjectId: o.id, organizationId: o.organization_id, locationId: o.location_id, ownerRole: 'OPERATIONS' });
    }
    for (const o of await q<{ id: string; number: string; organization_id: string; location_id: string; status: string; m: number; name: string }>(sql`select o.id, o.number, o.organization_id, o.location_id, o.status, l.name, extract(epoch from now() - o.promise_at)::int / 60 as m from orders o join locations l on l.id = o.location_id where o.status in ('ACCEPTED','PREPARING') and o.promise_at < now() - make_interval(mins => ${c.overdueMinutes}) and o.created_at > now() - interval '1 day'`)) {
      found.push({ dedupeKey: `overdue:${o.id}`, type: 'ORDER_OVERDUE', severity: o.m >= 30 ? 'HIGH' : 'MEDIUM', title: `Order ${o.number} is ${o.m} min past its promise time`, detail: `${o.name}: still ${o.status.toLowerCase()}.`, subjectType: 'order', subjectId: o.id, organizationId: o.organization_id, locationId: o.location_id, ownerRole: 'OPERATIONS' });
    }
    for (const o of await q<{ id: string; number: string; organization_id: string; location_id: string; fulfillment_type: string; m: number; name: string }>(sql`select o.id, o.number, o.organization_id, o.location_id, o.fulfillment_type, l.name, extract(epoch from now() - o.ready_at)::int / 60 as m from orders o join locations l on l.id = o.location_id where o.status = 'READY' and o.ready_at < now() - make_interval(mins => ${c.readyWaitingMinutes}) and o.created_at > now() - interval '1 day'`)) {
      found.push({ dedupeKey: `ready:${o.id}`, type: 'READY_WAITING', severity: o.m >= 45 ? 'HIGH' : 'MEDIUM', title: `Order ${o.number} ready ${o.m} min and not collected`, detail: o.fulfillment_type === 'DELIVERY' ? `${o.name}: waiting for a courier.` : `${o.name}: customer has not picked it up.`, subjectType: 'order', subjectId: o.id, organizationId: o.organization_id, locationId: o.location_id, ownerRole: o.fulfillment_type === 'DELIVERY' ? 'DISPATCHER' : 'OPERATIONS' });
    }
    for (const j of await q<{ id: string; order_id: string; number: string; organization_id: string; location_id: string; status: string; m: number }>(sql`select dj.id, dj.order_id, o.number, o.organization_id, dj.location_id, dj.status, extract(epoch from now() - dj.eta_at)::int / 60 as m from delivery_jobs dj join orders o on o.id = dj.order_id where dj.status in ('ASSIGNED','PICKED_UP','REQUESTED','UNASSIGNED') and dj.eta_at < now() - make_interval(mins => ${c.deliveryLateMinutes}) and dj.created_at > now() - interval '1 day'`)) {
      found.push({ dedupeKey: `late:${j.id}`, type: 'DELIVERY_LATE', severity: j.status === 'UNASSIGNED' || j.m >= 30 ? 'HIGH' : 'MEDIUM', title: `Delivery for ${j.number} ${j.m} min late (${j.status.toLowerCase()})`, subjectType: 'order', subjectId: j.order_id, organizationId: j.organization_id, locationId: j.location_id, ownerRole: 'DISPATCHER' });
    }
    for (const x of await q<{ id: string; number: string; organization_id: string; location_id: string; status: string; job: string | null; pay: string | null; captured: number; refunded: number; fulfillment_type: string }>(sql`
      select o.id, o.number, o.organization_id, o.location_id, o.status, o.fulfillment_type, dj.status as job, p.status as pay, p.captured_cents as captured, p.refunded_cents as refunded
      from orders o left join delivery_jobs dj on dj.order_id = o.id left join payments p on p.order_id = o.id and p.purpose = 'ORDER'
      where o.updated_at > now() - interval '3 days' and (
        (dj.status = 'DELIVERED' and o.status not in ('COLLECTED','COMPLETED'))
        or (o.status in ('CANCELED','REJECTED') and p.status = 'CAPTURED' and p.refunded_cents < p.captured_cents)
        or (o.status in ('COMPLETED','COLLECTED') and p.status = 'AUTHORIZED')
        or (o.status in ('CANCELED','REJECTED') and dj.status in ('REQUESTED','ASSIGNED','PICKED_UP'))
      ) limit 200`)) {
      const money = x.pay && ['CANCELED', 'REJECTED', 'COMPLETED', 'COLLECTED'].includes(x.status) && (x.pay === 'CAPTURED' || x.pay === 'AUTHORIZED');
      const what = x.job === 'DELIVERED' && !['COLLECTED', 'COMPLETED'].includes(x.status) ? `delivery DELIVERED, order ${x.status}` : money ? `order ${x.status}, payment ${x.pay}` : `order ${x.status}, courier job ${x.job}`;
      found.push({ dedupeKey: `conflict:${x.id}`, type: 'STATUS_CONFLICT', severity: 'HIGH', title: `Conflicting statuses on ${x.number}`, detail: what, subjectType: 'order', subjectId: x.id, organizationId: x.organization_id, locationId: x.location_id, ownerRole: money ? 'FINANCE' : 'OPERATIONS' });
    }
    for (const d of await q<{ order_id: string; number: string; organization_id: string; location_id: string; type: string; n: number }>(sql`select e.order_id, o.number, o.organization_id, o.location_id, e.type, count(*)::int as n from order_events e join orders o on o.id = e.order_id where e.created_at > now() - interval '3 days' and e.type in ('ACCEPTED','READY','REJECTED','CANCELED','COLLECTED','COMPLETED') group by 1,2,3,4,5 having count(*) > 1 limit 100`)) {
      found.push({ dedupeKey: `dupe:${d.order_id}:${d.type}`, type: 'DUPLICATE_EVENT', severity: 'LOW', title: `${d.type} recorded ${d.n} times on ${d.number}`, subjectType: 'order', subjectId: d.order_id, organizationId: d.organization_id, locationId: d.location_id, ownerRole: 'IT' });
    }
    for (const v of await q<{ id: string; name: string; kind: string; location_id: string; organization_id: string; loc: string }>(sql`select d.id, d.name, d.kind, d.location_id, l.organization_id, l.name as loc from devices d join locations l on l.id = d.location_id where not d.is_online and d.last_heartbeat_at > now() - interval '1 day' and l.status = 'LIVE'`)) {
      found.push({ dedupeKey: `device:${v.id}`, type: 'DEVICE_OFFLINE', severity: v.kind === 'TABLET' || v.kind === 'KDS' ? 'HIGH' : 'MEDIUM', title: `${v.kind.toLowerCase()} "${v.name}" offline at ${v.loc}`, subjectType: 'device', subjectId: v.id, organizationId: v.organization_id, locationId: v.location_id, ownerRole: 'IT' });
    }
    for (const l of await q<{ id: string; name: string; organization_id: string; paused_reason: string | null }>(sql`select id, name, organization_id, paused_reason from locations where is_paused and paused_until is null and status = 'LIVE'`)) {
      found.push({ dedupeKey: `paused:${l.id}`, type: 'LOCATION_PAUSED', severity: 'LOW', title: `${l.name} is paused with no reopening time`, detail: l.paused_reason || undefined, subjectType: 'location', subjectId: l.id, organizationId: l.organization_id, locationId: l.id, ownerRole: 'OPERATIONS' });
    }
    for (const p of await q<{ id: string; party_type: string; amount_cents: number; status: string; failure_reason: string | null }>(sql`select id, party_type, amount_cents, status, failure_reason from payouts where status in ('FAILED','HELD') and created_at > now() - interval '30 days' limit 100`)) {
      found.push({ dedupeKey: `payout:${p.id}`, type: 'PAYOUT_FAILED', severity: 'HIGH', title: `${p.party_type.toLowerCase()} payout $${(p.amount_cents / 100).toFixed(2)} ${p.status.toLowerCase()}`, detail: p.failure_reason || undefined, subjectType: 'payout', subjectId: p.id, ownerRole: 'FINANCE' });
    }
    for (const w of await q<{ id: string; provider: string; type: string; error: string }>(sql`select id, provider, type, error from inbox_events where error is not null and processed_at is null and created_at > now() - interval '3 days' limit 100`)) {
      found.push({ dedupeKey: `webhook:${w.id}`, type: 'WEBHOOK_FAILED', severity: 'MEDIUM', title: `${w.provider} webhook ${w.type} failed`, detail: w.error, subjectType: 'inbox_event', subjectId: w.id, ownerRole: 'IT' });
    }
    let created = 0;
    for (const d of found) if ((await this.raise(d)).created) created++;
    // auto-resolve detector alerts whose condition has cleared
    const keys = new Set(found.map((d) => d.dedupeKey));
    const open = await this.db.select().from(opsAlerts).where(and(ne(opsAlerts.status, 'RESOLVED'), inArray(opsAlerts.type, AUTO_TYPES)));
    let cleared = 0;
    for (const a of open) {
      if (a.dedupeKey && !keys.has(a.dedupeKey)) {
        await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), autoResolved: true, resolution: 'Condition cleared', history: [...(a.history as unknown[]), this.entry(null, 'AUTO_RESOLVED', 'Condition cleared')] }).where(eq(opsAlerts.id, a.id));
        cleared++;
      }
    }
    return { detected: found.length, created, cleared };
  }

  /** Worker: unresolved alerts past their deadline move up a level and page the next owner. */
  async escalate() {
    const c = await this.cfg();
    const due = await this.db.select().from(opsAlerts).where(and(ne(opsAlerts.status, 'RESOLVED'), lt(opsAlerts.escalateAt, new Date()))).limit(200);
    for (const a of due) {
      const nextRole = ESCALATE_TO[a.ownerRole] || 'OPERATIONS';
      const level = a.escalationLevel + 1;
      const [u] = await this.db
        .update(opsAlerts)
        .set({ escalationLevel: level, ownerRole: nextRole, ownerId: null, status: 'OPEN', escalateAt: new Date(Date.now() + c.escalateMinutes[a.severity as Severity] * 60_000 * Math.min(level + 1, 4)), history: [...(a.history as unknown[]), this.entry(null, 'ESCALATED', `Deadline passed; now owned by ${nextRole.toLowerCase()} (level ${level})`)] })
        .where(and(eq(opsAlerts.id, a.id), lt(opsAlerts.escalateAt, new Date())))
        .returning();
      if (u) await this.page(u, true);
    }
    return { escalated: due.length };
  }

  // ───── people acting on alerts ─────

  private async get(id: string) {
    const [a] = await this.db.select().from(opsAlerts).where(eq(opsAlerts.id, id)).limit(1);
    if (!a) throw new NotFoundException();
    return a;
  }

  private visible(user: JwtPayload, a: Alert) {
    if (a.organizationId && !staffCovers(user, a.organizationId, a.locationId)) return false;
    if (a.ownerRole === 'FINANCE' && !can(user, 'finance.read') && a.type === 'PAYOUT_FAILED') return false;
    return true;
  }

  async list(user: JwtPayload, q: { status?: string; type?: string; severity?: string; mine?: boolean; ownerRole?: string; subjectId?: string }) {
    assertCan(user, 'ops.read');
    const conds = [];
    if (q.status === 'ACTIVE' || !q.status) conds.push(ne(opsAlerts.status, 'RESOLVED'));
    else conds.push(eq(opsAlerts.status, q.status));
    if (q.type) conds.push(eq(opsAlerts.type, q.type));
    if (q.severity) conds.push(eq(opsAlerts.severity, q.severity));
    if (q.ownerRole) conds.push(eq(opsAlerts.ownerRole, q.ownerRole));
    if (q.mine) conds.push(eq(opsAlerts.ownerId, user.sub));
    if (q.subjectId) conds.push(eq(opsAlerts.subjectId, q.subjectId));
    const list = await this.db.select({ a: opsAlerts, owner: users.email }).from(opsAlerts).leftJoin(users, eq(users.id, opsAlerts.ownerId)).where(and(...conds)).orderBy(sql`case ${opsAlerts.severity} when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end`, desc(opsAlerts.createdAt)).limit(300);
    return list.filter((x) => this.visible(user, x.a)).map((x) => ({ ...x.a, ownerEmail: x.owner }));
  }

  async summary(user: JwtPayload) {
    const active = await this.list(user, { status: 'ACTIVE' });
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
    for (const a of active) bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    return { active: active.length, unacknowledged: active.filter((a) => a.status === 'OPEN').length, overdue: active.filter((a) => a.escalateAt && new Date(a.escalateAt) < new Date()).length, mine: active.filter((a) => a.ownerId === user.sub).length, bySeverity };
  }

  async create(user: JwtPayload, input: { title: string; detail?: string; severity: Severity; subjectType?: string; subjectId?: string; organizationId?: string; locationId?: string; ownerRole?: string }) {
    assertCan(user, 'ops.manage');
    const { alert } = await this.raise({ dedupeKey: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, type: 'MANUAL', severity: input.severity, title: input.title, detail: input.detail, subjectType: input.subjectType || 'manual', subjectId: input.subjectId || '-', organizationId: input.organizationId, locationId: input.locationId, ownerRole: input.ownerRole || 'OPERATIONS' }, user.sub);
    await this.audit.log({ organizationId: alert.organizationId, actorId: user.sub, action: 'alert.create', entityType: 'ops_alert', entityId: alert.id, after: alert });
    return alert;
  }

  async act(user: JwtPayload, id: string, action: 'ACK' | 'ASSIGN' | 'RESOLVE' | 'COMMENT' | 'REOPEN', input: { note?: string; ownerId?: string | null; ownerRole?: string; resolution?: string }) {
    assertCan(user, 'ops.read');
    const a = await this.get(id);
    if (!this.visible(user, a)) throw new NotFoundException();
    // acting needs the owning team's manage permission (or being the assigned owner); anyone who can see it may comment
    if (action !== 'COMMENT' && a.ownerId !== user.sub) assertCan(user, TEAM_PERMISSION[a.ownerRole] || 'ops.manage');
    const hist = [...(a.history as unknown[])];
    const set: Partial<typeof opsAlerts.$inferInsert> = {};
    const cfg = await this.cfg();
    if (action === 'ACK') {
      if (a.status === 'RESOLVED') throw new ConflictException('Already resolved');
      Object.assign(set, { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), ownerId: a.ownerId || user.sub });
      hist.push(this.entry(user.sub, 'ACKNOWLEDGED', input.note, { email: user.email }));
    } else if (action === 'ASSIGN') {
      Object.assign(set, { ownerId: input.ownerId ?? null, ownerRole: input.ownerRole || a.ownerRole, escalateAt: new Date(Date.now() + cfg.escalateMinutes[a.severity as Severity] * 60_000) });
      hist.push(this.entry(user.sub, 'ASSIGNED', input.note, { ownerId: input.ownerId ?? null, ownerRole: input.ownerRole || a.ownerRole, email: user.email }));
    } else if (action === 'RESOLVE') {
      if (!input.resolution || input.resolution.trim().length < 3) throw new BadRequestException('Describe how it was resolved');
      Object.assign(set, { status: 'RESOLVED', resolvedAt: new Date(), resolution: input.resolution });
      hist.push(this.entry(user.sub, 'RESOLVED', input.resolution, { email: user.email }));
    } else if (action === 'REOPEN') {
      Object.assign(set, { status: 'OPEN', resolvedAt: null, resolution: null, escalateAt: new Date(Date.now() + cfg.escalateMinutes[a.severity as Severity] * 60_000) });
      hist.push(this.entry(user.sub, 'REOPENED', input.note, { email: user.email }));
    } else {
      if (!input.note) throw new BadRequestException('Note required');
      hist.push(this.entry(user.sub, 'COMMENT', input.note, { email: user.email }));
    }
    const [u] = await this.db.update(opsAlerts).set({ ...set, history: hist }).where(eq(opsAlerts.id, id)).returning();
    await this.audit.log({ organizationId: a.organizationId, actorId: user.sub, action: `alert.${action.toLowerCase()}`, entityType: 'ops_alert', entityId: id, after: set, reason: input.note || input.resolution });
    return u;
  }
}
