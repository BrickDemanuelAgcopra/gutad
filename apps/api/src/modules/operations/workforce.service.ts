import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { DEFAULT_WORKFORCE, type WorkforceConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { devices, equipment, equipmentTickets, kitchens, laborEntries, locations, menuItems, opsAlerts, orgMemberships, staffShifts, staffSkills, stations, timeEntries, users } from '../../db/schema';
import { assertCan, assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { KitchenService } from '../kitchen/kitchen.service';

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;
const n = (x: unknown) => (x == null ? 0 : Number(x));
const hoursOf = (e: { clockInAt: Date; clockOutAt: Date | null; breakMinutes: number }) => (e.clockOutAt ? Math.max(0, (e.clockOutAt.getTime() - e.clockInAt.getTime()) / 3600_000 - e.breakMinutes / 60) : 0);
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const isoWeek = (d: Date) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y.getTime()) / 86400_000 + 1) / 7)).padStart(2, '0')}`; };

/** Phase I, section 23: workforce, training and equipment. */
@Injectable()
export class WorkforceService {
  constructor(@Inject(DB) private readonly db: Db, private readonly kitchen: KitchenService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  cfg() { return this.settings.getObject<WorkforceConfig>('workforce.config', DEFAULT_WORKFORCE); }

  private async loc(user: JwtPayload, locationId: string, roles?: typeof MANAGER_ROLES) {
    const [l] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!l) throw new NotFoundException('Location not found');
    assertOrgAccess(user, l.organizationId, l.id, roles);
    return l;
  }

  // 23.2 skills
  async skills(user: JwtPayload, organizationId: string) {
    assertOrgAccess(user, organizationId);
    return this.db.select({ s: staffSkills, email: users.email, name: users.name }).from(staffSkills).innerJoin(users, eq(users.id, staffSkills.userId)).where(eq(staffSkills.organizationId, organizationId)).then((r) => r.map((x) => ({ ...x.s, email: x.email, name: x.name, expired: !!x.s.expiresAt && x.s.expiresAt < new Date() })));
  }

  async grantSkill(user: JwtPayload, input: { organizationId: string; userId: string; skill: string; expiresAt?: string | null }) {
    assertOrgAccess(user, input.organizationId, null, MANAGER_ROLES);
    const [m] = await this.db.select().from(orgMemberships).where(and(eq(orgMemberships.organizationId, input.organizationId), eq(orgMemberships.userId, input.userId))).limit(1);
    if (!m) throw new BadRequestException('Not a member of this team');
    const v = { userId: input.userId, organizationId: input.organizationId, skill: input.skill.toUpperCase(), certifiedAt: new Date(), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, trainedById: user.sub };
    await this.db.insert(staffSkills).values(v).onConflictDoUpdate({ target: [staffSkills.userId, staffSkills.organizationId, staffSkills.skill], set: { certifiedAt: v.certifiedAt, expiresAt: v.expiresAt, trainedById: v.trainedById } });
    await this.audit.log({ organizationId: input.organizationId, actorId: user.sub, action: 'staff.skill', entityType: 'user', entityId: input.userId, after: v });
    return v;
  }

  // 23.1 shifts & staffing forecast
  async shifts(user: JwtPayload, locationId: string, from: Date, to: Date) {
    await this.loc(user, locationId);
    return this.db.select({ s: staffShifts, email: users.email, name: users.name }).from(staffShifts).innerJoin(users, eq(users.id, staffShifts.userId)).where(and(eq(staffShifts.locationId, locationId), eq(staffShifts.status, 'SCHEDULED'), gte(staffShifts.endsAt, from), lt(staffShifts.startsAt, to))).orderBy(staffShifts.startsAt).then((r) => r.map((x) => ({ ...x.s, email: x.email, name: x.name })));
  }

  /** Schedule a shift; a station that requires a skill only takes someone holding it (unexpired). */
  async addShift(user: JwtPayload, input: { locationId: string; userId: string; startsAt: string; endsAt: string; stationCode?: string; role?: string }) {
    const l = await this.loc(user, input.locationId, MANAGER_ROLES);
    const s = new Date(input.startsAt), e = new Date(input.endsAt);
    if (e <= s || e.getTime() - s.getTime() > 14 * 3600_000) throw new BadRequestException('A shift is up to 14 hours');
    const [m] = await this.db.select().from(orgMemberships).where(and(eq(orgMemberships.organizationId, l.organizationId), eq(orgMemberships.userId, input.userId))).limit(1);
    if (!m) throw new BadRequestException('Not a member of this team');
    if (input.stationCode && l.kitchenId) {
      const [st] = await this.db.select().from(stations).where(and(eq(stations.kitchenId, l.kitchenId), eq(stations.code, input.stationCode.toUpperCase()))).limit(1);
      if (st?.requiredSkill) {
        const [sk] = await this.db.select().from(staffSkills).where(and(eq(staffSkills.userId, input.userId), eq(staffSkills.organizationId, l.organizationId), eq(staffSkills.skill, st.requiredSkill))).limit(1);
        if (!sk || (sk.expiresAt && sk.expiresAt < s)) throw new BadRequestException({ message: `${st.name} needs the ${st.requiredSkill.toLowerCase().replace(/_/g, ' ')} skill`, code: 'SKILL_REQUIRED' });
      }
    }
    const [overlap] = await this.db.select().from(staffShifts).where(and(eq(staffShifts.userId, input.userId), eq(staffShifts.status, 'SCHEDULED'), sql`${staffShifts.startsAt} < ${e.toISOString()} and ${staffShifts.endsAt} > ${s.toISOString()}`)).limit(1);
    if (overlap) throw new ConflictException('This person already has a shift then');
    const [r] = await this.db.insert(staffShifts).values({ locationId: l.id, kitchenId: l.kitchenId, userId: input.userId, stationCode: input.stationCode?.toUpperCase() ?? null, role: input.role ?? null, startsAt: s, endsAt: e, createdById: user.sub }).returning();
    return r;
  }

  async cancelShift(user: JwtPayload, id: string) {
    const [s] = await this.db.select().from(staffShifts).where(eq(staffShifts.id, id)).limit(1);
    if (!s) throw new NotFoundException();
    await this.loc(user, s.locationId, MANAGER_ROLES);
    const [u] = await this.db.update(staffShifts).set({ status: 'CANCELED' }).where(eq(staffShifts.id, id)).returning();
    return u;
  }

  /** Staff needed per hour for a day from the average orders that weekday (last 4 weeks), vs scheduled. */
  async staffingForecast(user: JwtPayload, locationId: string, date: string) {
    const l = await this.loc(user, locationId);
    const cfg = await this.cfg();
    const day = new Date(`${date}T00:00:00`);
    const dow = day.getDay();
    const vol = rows<{ h: number; n: number }>(await this.db.execute(sql`select extract(hour from created_at at time zone ${l.timezone})::int as h, count(*)::numeric / 4 as n from orders where location_id = ${locationId} and extract(dow from created_at at time zone ${l.timezone}) = ${dow} and created_at > now() - interval '28 days' and status not in ('REJECTED','CANCELED') group by 1`));
    const sh = await this.db.select().from(staffShifts).where(and(eq(staffShifts.locationId, locationId), eq(staffShifts.status, 'SCHEDULED'), gte(staffShifts.endsAt, day), lt(staffShifts.startsAt, new Date(day.getTime() + 86400_000))));
    const hours = Array.from({ length: 24 }, (_, h) => {
      const orders = n(vol.find((v) => v.h === h)?.n);
      const at = new Date(day.getTime() + h * 3600_000 + 1800_000);
      const scheduled = sh.filter((s) => s.startsAt <= at && s.endsAt > at).length;
      const needed = orders > 0 ? Math.max(cfg.minStaffPerHour, Math.ceil(orders / cfg.ordersPerStaffHour)) : 0;
      return { hour: h, expectedOrders: Math.round(orders * 10) / 10, needed, scheduled, gap: scheduled - needed };
    });
    return { date, ordersPerStaffHour: cfg.ordersPerStaffHour, hours, understaffedHours: hours.filter((h) => h.gap < 0).map((h) => h.hour) };
  }

  // 23.3 attendance & payroll
  async clockIn(user: JwtPayload, locationId: string) {
    const l = await this.loc(user, locationId);
    const [open] = await this.db.select().from(timeEntries).where(and(eq(timeEntries.userId, user.sub), isNull(timeEntries.clockOutAt))).limit(1);
    if (open) throw new ConflictException('You are already clocked in');
    const now = new Date();
    const [sh] = await this.db.select().from(staffShifts).where(and(eq(staffShifts.userId, user.sub), eq(staffShifts.locationId, locationId), eq(staffShifts.status, 'SCHEDULED'), lt(staffShifts.startsAt, new Date(now.getTime() + 3600_000)), gte(staffShifts.endsAt, now))).limit(1);
    const rate = (await this.cfg()).defaultRateCents;
    const [e] = await this.db.insert(timeEntries).values({ userId: user.sub, locationId, kitchenId: l.kitchenId, shiftId: sh?.id ?? null, clockInAt: now, rateCents: rate }).returning();
    return e;
  }

  /** Clock out; hours also feed kitchen labor (contribution uses actual labor, 1.6-L). */
  async clockOut(user: JwtPayload, breakMinutes = 0) {
    const [open] = await this.db.select().from(timeEntries).where(and(eq(timeEntries.userId, user.sub), isNull(timeEntries.clockOutAt))).limit(1);
    if (!open) throw new ConflictException('You are not clocked in');
    const [e] = await this.db.update(timeEntries).set({ clockOutAt: new Date(), breakMinutes }).where(eq(timeEntries.id, open.id)).returning();
    const h = hoursOf(e);
    if (e.kitchenId && h > 0) await this.db.insert(laborEntries).values({ kitchenId: e.kitchenId, userId: e.userId, hours: Math.round(h * 100) / 100, rateCents: e.rateCents, date: e.clockInAt });
    return { ...e, hours: Math.round(h * 100) / 100 };
  }

  async myAttendance(user: JwtPayload) {
    const list = await this.db.select().from(timeEntries).where(eq(timeEntries.userId, user.sub)).orderBy(desc(timeEntries.clockInAt)).limit(30);
    return { open: list.find((e) => !e.clockOutAt) ?? null, entries: list.map((e) => ({ ...e, hours: Math.round(hoursOf(e) * 100) / 100 })) };
  }

  async timesheet(user: JwtPayload, locationId: string, from: Date, to: Date) {
    await this.loc(user, locationId, MANAGER_ROLES);
    return this.db.select({ e: timeEntries, email: users.email, name: users.name }).from(timeEntries).innerJoin(users, eq(users.id, timeEntries.userId)).where(and(eq(timeEntries.locationId, locationId), gte(timeEntries.clockInAt, from), lt(timeEntries.clockInAt, to))).orderBy(desc(timeEntries.clockInAt)).then((r) => r.map((x) => ({ ...x.e, email: x.email, name: x.name, hours: Math.round(hoursOf(x.e) * 100) / 100 })));
  }

  async editEntry(user: JwtPayload, id: string, input: { clockInAt?: string; clockOutAt?: string | null; breakMinutes?: number; rateCents?: number; approve?: boolean; note?: string }) {
    const [e] = await this.db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
    if (!e) throw new NotFoundException();
    await this.loc(user, e.locationId, MANAGER_ROLES);
    if (input.approve && e.userId === user.sub) throw new ForbiddenException('Someone else approves your hours');
    const set: Partial<typeof timeEntries.$inferInsert> = { ...(input.clockInAt ? { clockInAt: new Date(input.clockInAt) } : {}), ...(input.clockOutAt !== undefined ? { clockOutAt: input.clockOutAt ? new Date(input.clockOutAt) : null } : {}), ...(input.breakMinutes !== undefined ? { breakMinutes: input.breakMinutes } : {}), ...(input.rateCents ? { rateCents: input.rateCents } : {}), ...(input.approve ? { approvedById: user.sub } : {}), ...(input.note ? { note: input.note } : {}) };
    const [u] = await this.db.update(timeEntries).set(set).where(eq(timeEntries.id, id)).returning();
    await this.audit.log({ actorId: user.sub, action: 'attendance.edit', entityType: 'time_entry', entityId: id, before: e, after: set, reason: input.note });
    return u;
  }

  /** Payroll export: hours per person and ISO week, overtime above the weekly threshold, gross pay. Only approved entries. */
  async payrollCsv(user: JwtPayload, locationId: string, from: Date, to: Date) {
    await this.loc(user, locationId, ['MERCHANT_OWNER', 'MERCHANT_MANAGER']);
    const cfg = await this.cfg();
    const list = await this.timesheet(user, locationId, from, to);
    const by = new Map<string, { name: string; email: string; week: string; hours: number; rateCents: number; unapproved: number }>();
    for (const e of list) {
      const k = `${e.userId}|${isoWeek(e.clockInAt)}`;
      const g = by.get(k) || { name: e.name || '', email: e.email, week: isoWeek(e.clockInAt), hours: 0, rateCents: e.rateCents, unapproved: 0 };
      if (e.approvedById) g.hours += e.hours; else g.unapproved += e.hours;
      g.rateCents = e.rateCents;
      by.set(k, g);
    }
    const head = ['Employee', 'Email', 'Week', 'RegularHours', 'OvertimeHours', 'Rate', 'GrossPay', 'UnapprovedHours'];
    const lines = [...by.values()].map((g) => { const reg = Math.min(g.hours, cfg.overtimeWeeklyHours), ot = Math.max(0, g.hours - cfg.overtimeWeeklyHours); const gross = (reg * g.rateCents + ot * g.rateCents * cfg.overtimeMultiplier) / 100; return [g.name, g.email, g.week, reg.toFixed(2), ot.toFixed(2), (g.rateCents / 100).toFixed(2), gross.toFixed(2), g.unapproved.toFixed(2)]; });
    return [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n');
  }

  /** 23.4 labor hours vs order volume per day. */
  async laborReport(user: JwtPayload, locationId: string, days = 14) {
    await this.loc(user, locationId);
    const r = rows<{ day: string; orders: number; sales: number; hours: number | null; cost: number | null }>(await this.db.execute(sql`with o as (select date_trunc('day', created_at) as day, count(*)::int as orders, sum(subtotal_cents - discount_cents)::bigint as sales from orders where location_id = ${locationId} and status in ('COMPLETED','COLLECTED') and created_at > now() - make_interval(days => ${days}) group by 1),
      t as (select date_trunc('day', clock_in_at) as day, sum(greatest(0, extract(epoch from coalesce(clock_out_at, now()) - clock_in_at) / 3600 - break_minutes / 60.0)) as hours, sum(greatest(0, extract(epoch from coalesce(clock_out_at, now()) - clock_in_at) / 3600 - break_minutes / 60.0) * rate_cents) as cost from time_entries where location_id = ${locationId} and clock_in_at > now() - make_interval(days => ${days}) group by 1)
      select coalesce(o.day, t.day) as day, coalesce(o.orders, 0) as orders, coalesce(o.sales, 0) as sales, t.hours, t.cost from o full join t on t.day = o.day order by 1 desc`));
    return r.map((x) => ({ day: x.day, orders: n(x.orders), salesCents: n(x.sales), laborHours: Math.round(n(x.hours) * 10) / 10, laborCents: Math.round(n(x.cost)), ordersPerLaborHour: n(x.hours) ? Math.round((n(x.orders) / n(x.hours)) * 10) / 10 : null, laborPctOfSales: n(x.sales) ? Math.round((n(x.cost) / n(x.sales)) * 1000) / 10 : null }));
  }

  // 23.5 / 23.6 / 23.8 equipment
  async equipmentList(user: JwtPayload, kitchenId?: string) {
    if (kitchenId) await this.kitchen.requireKitchen(user, kitchenId); else assertCan(user, 'kitchens.read');
    const list = await this.db.select({ e: equipment, kitchen: kitchens.name }).from(equipment).innerJoin(kitchens, eq(kitchens.id, equipment.kitchenId)).where(kitchenId ? eq(equipment.kitchenId, kitchenId) : sql`true`).orderBy(kitchens.name, equipment.name);
    const approved = await this.settings.getObject<Record<string, string[]>>('equipment.approvedVersions', {});
    const open = list.length ? await this.db.select({ id: equipmentTickets.equipmentId, n: sql<number>`count(*)::int` }).from(equipmentTickets).where(and(inArray(equipmentTickets.equipmentId, list.map((x) => x.e.id)), ne(equipmentTickets.status, 'RESOLVED'))).groupBy(equipmentTickets.equipmentId) : [];
    const now = Date.now();
    return list.map(({ e, kitchen }) => ({ ...e, kitchen, openTickets: open.find((o) => o.id === e.id)?.n ?? 0, serviceDue: !!e.nextServiceDueAt && e.nextServiceDueAt.getTime() < now, softwareApproved: e.isAutomated ? (approved[e.kind] ? approved[e.kind].includes(e.softwareVersion || '') : null) : null }));
  }

  async upsertEquipment(user: JwtPayload, input: { id?: string; kitchenId: string; name: string; kind: string; stationCode?: string | null; manufacturer?: string; model?: string; serial?: string; isAutomated?: boolean; softwareVersion?: string | null; serviceIntervalDays?: number | null }) {
    const k = await this.kitchen.requireKitchen(user, input.kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const v = { kitchenId: input.kitchenId, name: input.name, kind: input.kind.toUpperCase(), stationCode: input.stationCode?.toUpperCase() ?? null, manufacturer: input.manufacturer ?? null, model: input.model ?? null, serial: input.serial ?? null, isAutomated: !!input.isAutomated, softwareVersion: input.softwareVersion ?? null, serviceIntervalDays: input.serviceIntervalDays ?? null };
    const [r] = input.id ? await this.db.update(equipment).set(v).where(eq(equipment.id, input.id)).returning() : await this.db.insert(equipment).values({ ...v, nextServiceDueAt: v.serviceIntervalDays ? new Date(Date.now() + v.serviceIntervalDays * 86400_000) : null }).returning();
    if (input.softwareVersion) await this.checkVersion(r);
    return r;
  }

  private async checkVersion(e: typeof equipment.$inferSelect) {
    if (!e.isAutomated || !e.softwareVersion) return;
    const approved = await this.settings.getObject<Record<string, string[]>>('equipment.approvedVersions', {});
    if (approved[e.kind] && !approved[e.kind].includes(e.softwareVersion)) {
      const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, e.kitchenId)).limit(1);
      await this.db.insert(opsAlerts).values({ type: 'EQUIPMENT_SOFTWARE', severity: 'HIGH', title: `${e.name}: unapproved software ${e.softwareVersion}`, detail: `Approved for ${e.kind}: ${approved[e.kind].join(', ')}. Escalate to the operator; Gutad never changes equipment software or controls.`, subjectType: 'equipment', subjectId: e.id, organizationId: k?.organizationId ?? null, dedupeKey: `eq-sw:${e.id}:${e.softwareVersion}`, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + 60 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'Unapproved software version' }] }).onConflictDoNothing();
    }
  }

  /**
   * Status change. DOWN (or MAINTENANCE) takes the affected items off the menu (recipes needing this kind of
   * equipment, or items at its station when nothing else there works) and reduces the station's capacity (closed
   * if nothing else works there, otherwise halved). Back to OK restores exactly what was changed.
   */
  async setStatus(user: JwtPayload | null, id: string, status: 'OK' | 'DEGRADED' | 'DOWN' | 'MAINTENANCE', note?: string) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, id)).limit(1);
    if (!e) throw new NotFoundException();
    if (user) await this.kitchen.requireKitchen(user, e.kitchenId);
    if (e.status === status) return e;
    const out = status === 'DOWN' || status === 'MAINTENANCE';
    const wasOut = e.status === 'DOWN' || e.status === 'MAINTENANCE';
    await this.db.transaction(async (tx) => {
      if (out && !wasOut) {
        const others = e.stationCode ? await tx.select().from(equipment).where(and(eq(equipment.kitchenId, e.kitchenId), eq(equipment.stationCode, e.stationCode), ne(equipment.id, e.id), inArray(equipment.status, ['OK', 'DEGRADED']))) : [];
        const items = rows<{ id: string }>(await tx.execute(sql`select distinct mi.id from menu_items mi join menu_categories c on c.id = mi.category_id join menus m on m.id = c.menu_id join locations l on l.id = m.location_id left join recipes r on r.id = mi.recipe_id
          where l.kitchen_id = ${e.kitchenId} and not mi.sold_out and (upper(${e.kind}) = any(select upper(x) from unnest(coalesce(r.equipment, '{}')) x) ${e.stationCode && !others.length ? sql`or mi.station_code = ${e.stationCode}` : sql``})`)).map((x) => x.id);
        if (items.length) await tx.update(menuItems).set({ soldOut: true, soldOutUntil: null, soldOutSource: 'EQUIPMENT' }).where(inArray(menuItems.id, items));
        const st = e.stationCode ? await tx.select().from(stations).where(and(eq(stations.kitchenId, e.kitchenId), eq(stations.code, e.stationCode))) : [];
        for (const s of st) await tx.update(stations).set(others.length ? { maxConcurrent: Math.max(1, Math.ceil((s.maxConcurrent ?? 4) / 2)) } : { isAvailable: false }).where(eq(stations.id, s.id));
        await tx.update(equipment).set({ status, outageState: { soldOutItemIds: items, stations: st.map((s) => ({ id: s.id, maxConcurrent: s.maxConcurrent, isAvailable: s.isAvailable })) } }).where(eq(equipment.id, id));
        const [k] = await tx.select().from(kitchens).where(eq(kitchens.id, e.kitchenId)).limit(1);
        await tx.insert(opsAlerts).values({ type: 'EQUIPMENT_DOWN', severity: items.length ? 'HIGH' : 'MEDIUM', title: `${e.name} ${status === 'DOWN' ? 'is down' : 'is in maintenance'}`, detail: `${items.length} menu item(s) paused${st.length ? `; station ${e.stationCode} ${others.length ? 'capacity halved' : 'closed'}` : ''}.${note ? ` ${note}` : ''}`, subjectType: 'equipment', subjectId: e.id, organizationId: k?.organizationId ?? null, dedupeKey: `eq-down:${e.id}`, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + 30 * 60_000), history: [{ at: new Date().toISOString(), by: user?.sub ?? null, action: 'RAISED', note: note ?? null }] }).onConflictDoNothing();
      } else if (!out && wasOut) {
        const st = (e.outageState as { soldOutItemIds?: string[]; stations?: { id: string; maxConcurrent: number | null; isAvailable: boolean }[] } | null) || {};
        if (st.soldOutItemIds?.length) await tx.update(menuItems).set({ soldOut: false, soldOutSource: null }).where(and(inArray(menuItems.id, st.soldOutItemIds), eq(menuItems.soldOutSource, 'EQUIPMENT')));
        for (const s of st.stations || []) await tx.update(stations).set({ maxConcurrent: s.maxConcurrent, isAvailable: s.isAvailable }).where(eq(stations.id, s.id));
        await tx.update(equipment).set({ status, outageState: null }).where(eq(equipment.id, id));
        await tx.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: `${e.name} back in service` }).where(and(eq(opsAlerts.dedupeKey, `eq-down:${e.id}`), ne(opsAlerts.status, 'RESOLVED')));
      } else await tx.update(equipment).set({ status }).where(eq(equipment.id, id));
      await this.audit.log({ actorId: user?.sub ?? null, action: 'equipment.status', entityType: 'equipment', entityId: id, before: { status: e.status }, after: { status }, reason: note }, tx);
    });
    return (await this.db.select().from(equipment).where(eq(equipment.id, id)))[0];
  }

  async tickets(user: JwtPayload, equipmentId: string) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, equipmentId)).limit(1);
    if (!e) throw new NotFoundException();
    await this.kitchen.requireKitchen(user, e.kitchenId);
    return this.db.select().from(equipmentTickets).where(eq(equipmentTickets.equipmentId, equipmentId)).orderBy(desc(equipmentTickets.createdAt));
  }

  async openTicket(user: JwtPayload | null, equipmentId: string, input: { kind: 'FAULT' | 'SERVICE' | 'MAINTENANCE'; title: string; detail?: string; faultCode?: string; vendor?: string; takeOutOfService?: boolean }) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, equipmentId)).limit(1);
    if (!e) throw new NotFoundException();
    if (user) await this.kitchen.requireKitchen(user, e.kitchenId);
    const [t] = await this.db.insert(equipmentTickets).values({ equipmentId, kind: input.kind, title: input.title, detail: input.detail ?? null, faultCode: input.faultCode ?? null, vendor: input.vendor ?? null, openedById: user?.sub ?? null }).returning();
    if (input.takeOutOfService) await this.setStatus(user, equipmentId, input.kind === 'FAULT' ? 'DOWN' : 'MAINTENANCE', input.title);
    return t;
  }

  async resolveTicket(user: JwtPayload, id: string, resolution: string, backInService = true) {
    const [t] = await this.db.select().from(equipmentTickets).where(eq(equipmentTickets.id, id)).limit(1);
    if (!t) throw new NotFoundException();
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, t.equipmentId)).limit(1);
    await this.kitchen.requireKitchen(user, e!.kitchenId);
    const [u] = await this.db.update(equipmentTickets).set({ status: 'RESOLVED', resolution, resolvedById: user.sub, resolvedAt: new Date() }).where(eq(equipmentTickets.id, id)).returning();
    if (t.kind !== 'FAULT' || backInService) await this.db.update(equipment).set({ lastServiceAt: new Date(), nextServiceDueAt: e!.serviceIntervalDays ? new Date(Date.now() + e!.serviceIntervalDays * 86400_000) : e!.nextServiceDueAt }).where(eq(equipment.id, e!.id));
    if (backInService && e!.status !== 'OK') await this.setStatus(user, e!.id, 'OK', resolution);
    return u;
  }

  /**
   * 23.8 automated equipment reports a fault (device token of the kitchen's location, or staff). It is recorded and
   * escalated to an operator; Gutad never sends commands back to the machine.
   */
  async ingestFault(deviceToken: string | undefined, user: JwtPayload | null, equipmentId: string, input: { faultCode: string; message: string; severity?: 'LOW' | 'HIGH' | 'CRITICAL'; softwareVersion?: string }) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, equipmentId)).limit(1);
    if (!e) throw new NotFoundException();
    if (user) await this.kitchen.requireKitchen(user, e.kitchenId);
    else {
      const [d] = deviceToken ? await this.db.select({ id: devices.id }).from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(and(eq(devices.token, deviceToken), eq(locations.kitchenId, e.kitchenId))).limit(1) : [];
      if (!d) throw new ForbiddenException('Unknown device for this kitchen');
    }
    if (input.softwareVersion && input.softwareVersion !== e.softwareVersion) { await this.db.update(equipment).set({ softwareVersion: input.softwareVersion }).where(eq(equipment.id, e.id)); await this.checkVersion({ ...e, softwareVersion: input.softwareVersion }); }
    const t = await this.openTicket(null, e.id, { kind: 'FAULT', title: `${input.faultCode}: ${input.message}`, faultCode: input.faultCode, takeOutOfService: input.severity === 'CRITICAL' });
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, e.kitchenId)).limit(1);
    await this.db.insert(opsAlerts).values({ type: 'EQUIPMENT_FAULT', severity: input.severity === 'CRITICAL' ? 'CRITICAL' : input.severity === 'LOW' ? 'LOW' : 'HIGH', title: `${e.name} fault ${input.faultCode}`, detail: `${input.message}. Operator action needed on site; follow the manufacturer's procedure. Gutad records and escalates only.`, subjectType: 'equipment', subjectId: e.id, organizationId: k?.organizationId ?? null, dedupeKey: `eq-fault:${e.id}:${input.faultCode}`, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + (input.severity === 'CRITICAL' ? 10 : 30) * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: input.faultCode }] }).onConflictDoNothing();
    return { ticket: t, escalated: true };
  }

  /** Service due soon or overdue → alert (daily). */
  async maintenanceSweep() {
    const due = await this.db.select({ e: equipment, org: kitchens.organizationId }).from(equipment).innerJoin(kitchens, eq(kitchens.id, equipment.kitchenId)).where(lt(equipment.nextServiceDueAt, new Date(Date.now() + 3 * 86400_000)));
    for (const { e, org } of due) await this.db.insert(opsAlerts).values({ type: 'EQUIPMENT_SERVICE_DUE', severity: 'LOW', title: `${e.name} service due ${e.nextServiceDueAt!.toISOString().slice(0, 10)}`, detail: 'Book the service and record it on the equipment.', subjectType: 'equipment', subjectId: e.id, organizationId: org, dedupeKey: `eq-service:${e.id}:${e.nextServiceDueAt!.toISOString().slice(0, 10)}`, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + 24 * 3600_000), history: [] }).onConflictDoNothing();
    return { due: due.length };
  }

  // 23.7 device health
  async devicesHealth(user: JwtPayload, locationId?: string) {
    if (locationId) await this.loc(user, locationId); else assertCan(user, 'ops.read', 'kitchens.read');
    const list = await this.db.select({ d: devices, loc: locations.name }).from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(locationId ? eq(devices.locationId, locationId) : sql`true`).orderBy(locations.name, devices.name);
    const now = Date.now();
    return list.map(({ d, loc }) => ({ id: d.id, location: loc, locationId: d.locationId, kind: d.kind, name: d.name, isOnline: d.isOnline, lastHeartbeatAt: d.lastHeartbeatAt, minutesSinceSeen: d.lastHeartbeatAt ? Math.round((now - d.lastHeartbeatAt.getTime()) / 60_000) : null, firmwareVersion: d.firmwareVersion, appVersion: d.appVersion, lastError: d.lastError }));
  }

  /** Devices silent for 10 minutes go offline with one alert per outage. */
  async deviceSweep() {
    const stale = await this.db.select({ d: devices, org: locations.organizationId, loc: locations.name }).from(devices).innerJoin(locations, eq(locations.id, devices.locationId)).where(and(lt(devices.lastHeartbeatAt, new Date(Date.now() - 10 * 60_000)), isNull(devices.offlineAlertedAt)));
    for (const { d, org, loc } of stale) {
      await this.db.update(devices).set({ isOnline: false, offlineAlertedAt: new Date() }).where(eq(devices.id, d.id));
      await this.db.insert(opsAlerts).values({ type: 'DEVICE_OFFLINE', severity: d.kind === 'KDS' || d.kind === 'TABLET' ? 'HIGH' : 'MEDIUM', title: `${d.name} (${d.kind.toLowerCase()}) offline at ${loc}`, detail: `No heartbeat since ${d.lastHeartbeatAt?.toISOString().slice(11, 16)} UTC.${d.fallbackOwner ? ` Fallback: ${d.fallbackOwner}.` : ''}`, subjectType: 'device', subjectId: d.id, organizationId: org, locationId: d.locationId, dedupeKey: `device:${d.id}`, ownerRole: 'IT', escalateAt: new Date(Date.now() + 20 * 60_000), history: [] }).onConflictDoNothing();
    }
    return { offline: stale.length };
  }
}
