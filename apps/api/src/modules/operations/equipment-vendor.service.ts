import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, ne, or, isNull, lt } from 'drizzle-orm';
import { EQUIPMENT_VENDORS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { equipment, equipmentTickets, equipmentVendorEvents, equipmentVendorLinks, kitchens, opsAlerts } from '../../db/schema';
import { assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { CryptoService } from '../../core/crypto.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { equipmentVendor, type VendorContext, type VendorEvent } from './equipment-vendors';
import { hashToken, newToken } from './tokens';
import { WorkforceService } from './workforce.service';

type Link = typeof equipmentVendorLinks.$inferSelect;
type Equipment = typeof equipment.$inferSelect;
const SERVICE_DONE = ['SERVICE_DONE', 'SERVICE_COMPLETED', 'MAINTENANCE_DONE', 'DESCALE_DONE', 'CLEANING_DONE'];
const SERVICE_DUE = ['SERVICE_DUE', 'MAINTENANCE_DUE', 'DESCALE_DUE', 'FILTER_DUE'];

/**
 * 23.8-V vendor integrations for automated kitchen equipment: telemetry, maintenance and fault events are pushed in
 * (vendor token) or pulled (read-only status APIs). Everything is recorded and alerted; Gutad never sends commands.
 */
@Injectable()
export class EquipmentVendorService {
  constructor(@Inject(DB) private readonly db: Db, private readonly kitchen: KitchenService, private readonly wf: WorkforceService, private readonly audit: AuditService, private readonly crypto: CryptoService) {}

  private present(l: Link) {
    const { tokenHash: _h, credentials, ...rest } = l;
    const creds = this.crypto.decryptObject(credentials as Record<string, unknown>);
    return { ...rest, hasCredentials: Object.values(creds).some(Boolean), canPull: !!equipmentVendor(l.vendor)?.canPull };
  }

  private async eq(user: JwtPayload | null, id: string, manage = false) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, id)).limit(1);
    if (!e) throw new NotFoundException('Equipment not found');
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, e.kitchenId)).limit(1);
    if (user) { await this.kitchen.requireKitchen(user, e.kitchenId); if (manage) assertOrgAccess(user, k!.organizationId, null, MANAGER_ROLES); }
    return { e, k: k! };
  }

  async get(user: JwtPayload, equipmentId: string) {
    await this.eq(user, equipmentId);
    const [l] = await this.db.select().from(equipmentVendorLinks).where(eq(equipmentVendorLinks.equipmentId, equipmentId)).limit(1);
    const events = await this.db.select().from(equipmentVendorEvents).where(eq(equipmentVendorEvents.equipmentId, equipmentId)).orderBy(desc(equipmentVendorEvents.occurredAt)).limit(50);
    return { vendors: EQUIPMENT_VENDORS, link: l ? this.present(l) : null, events };
  }

  /** Create or update the vendor link; a new link (or `rotateToken`) returns the push-feed token once. */
  async upsert(user: JwtPayload, equipmentId: string, input: { vendor: string; externalId: string; credentials?: Record<string, string>; config?: Record<string, unknown>; pollEnabled?: boolean; rotateToken?: boolean }) {
    const { e, k } = await this.eq(user, equipmentId, true);
    const adapter = equipmentVendor(input.vendor);
    if (!adapter) throw new BadRequestException('Unknown equipment vendor');
    if (input.pollEnabled && !adapter.canPull) throw new BadRequestException('This vendor link is push-only');
    const [cur] = await this.db.select().from(equipmentVendorLinks).where(eq(equipmentVendorLinks.equipmentId, equipmentId)).limit(1);
    const creds = input.credentials && Object.values(input.credentials).some(Boolean) ? input.credentials : cur && cur.vendor === input.vendor ? (this.crypto.decryptObject(cur.credentials as Record<string, unknown>) as Record<string, string>) : {};
    const t = !cur || input.rotateToken ? newToken('eqv') : null;
    const v = { equipmentId, vendor: input.vendor, externalId: input.externalId, credentials: this.crypto.encryptObject(creds), config: input.config ?? (cur?.config as Record<string, unknown>) ?? {}, pollEnabled: !!input.pollEnabled, isActive: true, ...(t ? { tokenHash: t.hash, tokenHint: t.hint } : {}) };
    const [row] = cur ? await this.db.update(equipmentVendorLinks).set(v).where(eq(equipmentVendorLinks.id, cur.id)).returning() : await this.db.insert(equipmentVendorLinks).values({ ...v, tokenHash: t!.hash, tokenHint: t!.hint, createdById: user.sub }).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'equipment.vendor_link', entityType: 'equipment', entityId: e.id, before: cur ? { vendor: cur.vendor, externalId: cur.externalId } : null, after: { vendor: row.vendor, externalId: row.externalId, pollEnabled: row.pollEnabled, tokenRotated: !!t } });
    return { ...this.present(row), ...(t ? { token: t.token } : {}) };
  }

  async unlink(user: JwtPayload, equipmentId: string) {
    const { e, k } = await this.eq(user, equipmentId, true);
    const [row] = await this.db.update(equipmentVendorLinks).set({ isActive: false, pollEnabled: false }).where(eq(equipmentVendorLinks.equipmentId, equipmentId)).returning();
    if (!row) throw new NotFoundException('No vendor link');
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'equipment.vendor_unlink', entityType: 'equipment', entityId: e.id });
    return this.present(row);
  }

  /** Vendor push feed (header `x-vendor-token`). */
  async ingest(token: string | undefined, events: VendorEvent[]) {
    if (!token) throw new UnauthorizedException('Vendor token required');
    const [l] = await this.db.select().from(equipmentVendorLinks).where(eq(equipmentVendorLinks.tokenHash, hashToken(token))).limit(1);
    if (!l || !l.isActive) throw new UnauthorizedException('Unknown or inactive vendor link');
    return this.apply(l, events);
  }

  /** Pull status now (staff) — a read-only call to the vendor. */
  async poll(user: JwtPayload | null, equipmentId: string) {
    if (user) await this.eq(user, equipmentId);
    const [l] = await this.db.select().from(equipmentVendorLinks).where(eq(equipmentVendorLinks.equipmentId, equipmentId)).limit(1);
    if (!l || !l.isActive) throw new NotFoundException('No active vendor link');
    return this.pull(l);
  }

  private async pull(l: Link) {
    const adapter = equipmentVendor(l.vendor);
    if (!adapter?.canPull) throw new BadRequestException('This vendor link is push-only');
    const ctx: VendorContext = { externalId: l.externalId, credentials: this.crypto.decryptObject(l.credentials as Record<string, unknown>) as VendorContext['credentials'], config: l.config as Record<string, unknown> };
    try {
      const s = await adapter.pullStatus(ctx);
      await this.db.update(equipmentVendorLinks).set({ lastPolledAt: new Date(), lastError: null }).where(eq(equipmentVendorLinks.id, l.id));
      const status: VendorEvent = { kind: 'STATUS', status: s.status, softwareVersion: s.softwareVersion, metrics: s.metrics };
      const r = await this.apply(l, [status, ...(s.metrics ? [{ kind: 'TELEMETRY' as const, metrics: s.metrics }] : []), ...(s.events || [])]);
      return { status: s.status, ...r };
    } catch (e) {
      await this.db.update(equipmentVendorLinks).set({ lastPolledAt: new Date(), lastError: (e as Error).message.slice(0, 300) }).where(eq(equipmentVendorLinks.id, l.id));
      return { status: 'UNREACHABLE', error: (e as Error).message, accepted: 0, duplicates: 0, alerts: 0 };
    }
  }

  /** Worker: pull every active, pull-enabled link at most every 5 minutes. */
  async pollSweep() {
    const due = await this.db.select().from(equipmentVendorLinks).where(and(eq(equipmentVendorLinks.isActive, true), eq(equipmentVendorLinks.pollEnabled, true), or(isNull(equipmentVendorLinks.lastPolledAt), lt(equipmentVendorLinks.lastPolledAt, new Date(Date.now() - 5 * 60_000))))).limit(50);
    let polled = 0;
    for (const l of due) { await this.pull(l); polled++; }
    return { polled };
  }

  private async alert(e: Equipment, orgId: string, v: { type: string; severity: string; title: string; detail: string; dedupeKey: string; minutes: number }) {
    const r = await this.db.insert(opsAlerts).values({ type: v.type, severity: v.severity, title: v.title, detail: `${v.detail} Gutad records and escalates only; act on the machine following the manufacturer's procedure.`, subjectType: 'equipment', subjectId: e.id, organizationId: orgId, dedupeKey: v.dedupeKey, ownerRole: 'OPERATIONS', escalateAt: new Date(Date.now() + v.minutes * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: v.title.slice(0, 120) }] }).onConflictDoNothing().returning({ id: opsAlerts.id });
    return r.length > 0;
  }

  private async resolveAlert(dedupeKey: string, resolution: string) {
    await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution, autoResolved: true }).where(and(eq(opsAlerts.dedupeKey, dedupeKey), ne(opsAlerts.status, 'RESOLVED')));
  }

  private async apply(l: Link, events: VendorEvent[]) {
    const [e] = await this.db.select().from(equipment).where(eq(equipment.id, l.equipmentId)).limit(1);
    if (!e) throw new NotFoundException('Equipment not found');
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, e.kitchenId)).limit(1);
    const org = k!.organizationId;
    const limits = ((l.config as { telemetryLimits?: Record<string, { min?: number; max?: number }> }).telemetryLimits) || {};
    let accepted = 0, duplicates = 0, alerts = 0, tickets = 0;
    let lastStatus = (l.lastStatus as Record<string, unknown> | null) || {};
    for (const ev of events) {
      const at = ev.at && !Number.isNaN(new Date(ev.at).getTime()) ? new Date(ev.at) : new Date();
      const [row] = await this.db.insert(equipmentVendorEvents).values({ equipmentId: e.id, linkId: l.id, vendor: l.vendor, kind: ev.kind, externalEventId: ev.id ?? null, code: ev.code ?? (ev.kind === 'STATUS' ? ev.status ?? null : null), severity: ev.severity ?? null, message: ev.message ?? null, metrics: ev.metrics ?? null, occurredAt: at }).onConflictDoNothing().returning();
      if (!row) { duplicates++; continue; }
      accepted++;
      let alerted = false, ticketId: string | null = null;
      if (ev.softwareVersion && ev.softwareVersion !== e.softwareVersion) {
        await this.db.update(equipment).set({ softwareVersion: ev.softwareVersion }).where(eq(equipment.id, e.id));
        e.softwareVersion = ev.softwareVersion;
        await this.wf.checkVersion(e);
      }
      if (ev.kind === 'FAULT') {
        const code = ev.code || 'VENDOR_FAULT';
        const s = ev.severity || 'HIGH';
        if (s === 'HIGH' || s === 'CRITICAL') {
          const [open] = await this.db.select({ id: equipmentTickets.id }).from(equipmentTickets).where(and(eq(equipmentTickets.equipmentId, e.id), eq(equipmentTickets.faultCode, code), ne(equipmentTickets.status, 'RESOLVED'))).limit(1);
          if (open) ticketId = open.id;
          else { const t = await this.wf.openTicket(null, e.id, { kind: 'FAULT', title: `${code}: ${ev.message || 'reported by vendor'}`, faultCode: code, vendor: l.vendor, takeOutOfService: s === 'CRITICAL' }); ticketId = t.id; tickets++; }
        }
        alerted = await this.alert(e, org, { type: 'EQUIPMENT_FAULT', severity: s === 'CRITICAL' ? 'CRITICAL' : s === 'HIGH' ? 'HIGH' : 'LOW', title: `${e.name} fault ${code}`, detail: `${ev.message || 'Fault reported'} (via ${l.vendor}).`, dedupeKey: `eq-fault:${e.id}:${code}`, minutes: s === 'CRITICAL' ? 10 : 30 });
      } else if (ev.kind === 'MAINTENANCE') {
        const code = (ev.code || '').toUpperCase();
        if (SERVICE_DONE.includes(code)) await this.db.update(equipment).set({ lastServiceAt: at, nextServiceDueAt: e.serviceIntervalDays ? new Date(at.getTime() + e.serviceIntervalDays * 86400_000) : e.nextServiceDueAt }).where(eq(equipment.id, e.id));
        else if (SERVICE_DUE.includes(code)) alerted = await this.alert(e, org, { type: 'EQUIPMENT_SERVICE_DUE', severity: 'LOW', title: `${e.name}: ${code.toLowerCase().replace(/_/g, ' ')}`, detail: `${ev.message || 'The vendor reports maintenance is due'}.`, dedupeKey: `eq-vendor-maint:${e.id}:${code}`, minutes: 24 * 60 });
      } else if (ev.kind === 'TELEMETRY' && ev.metrics) {
        for (const [metric, value] of Object.entries(ev.metrics)) {
          const lim = limits[metric];
          if (!lim || typeof value !== 'number') continue;
          const out = (lim.min !== undefined && value < lim.min) || (lim.max !== undefined && value > lim.max);
          if (out) alerted = (await this.alert(e, org, { type: 'EQUIPMENT_TELEMETRY', severity: 'MEDIUM', title: `${e.name}: ${metric} ${value} outside ${lim.min ?? '—'}…${lim.max ?? '—'}`, detail: `Telemetry from ${l.vendor} is outside the configured limits.`, dedupeKey: `eq-telemetry:${e.id}:${metric}`, minutes: 30 })) || alerted;
          else await this.resolveAlert(`eq-telemetry:${e.id}:${metric}`, `${metric} back within limits (${value})`);
        }
        lastStatus = { ...lastStatus, metrics: { ...((lastStatus.metrics as object) || {}), ...ev.metrics }, metricsAt: at.toISOString() };
      } else if (ev.kind === 'STATUS' && ev.status) {
        if (ev.status === 'DOWN' || ev.status === 'OFFLINE') alerted = await this.alert(e, org, { type: 'EQUIPMENT_VENDOR_STATUS', severity: 'HIGH', title: `${e.name} reported ${ev.status.toLowerCase()} by ${l.vendor}`, detail: `Gutad status is ${e.status}; set it to Down in Gutad if the machine is out of service (that pauses the affected items).`, dedupeKey: `eq-vendor-status:${e.id}`, minutes: 20 });
        else await this.resolveAlert(`eq-vendor-status:${e.id}`, `${l.vendor} reports ${ev.status}`);
        lastStatus = { ...lastStatus, status: ev.status, statusAt: at.toISOString() };
      }
      if (alerted) alerts++;
      if (alerted || ticketId) await this.db.update(equipmentVendorEvents).set({ alerted, ticketId }).where(eq(equipmentVendorEvents.id, row.id));
    }
    await this.db.update(equipmentVendorLinks).set({ lastEventAt: new Date(), lastStatus }).where(eq(equipmentVendorLinks.id, l.id));
    return { accepted, duplicates, alerts, tickets };
  }
}
