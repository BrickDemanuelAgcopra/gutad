import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { devices, inboxEvents, integrationAccounts, integrationMappings, locations, menuItems, orders, outboxEvents, reservations, tables } from '../../db/schema';
import { assertOrgAccess, isPlatformStaff, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { CryptoService } from '../../core/crypto.service';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import { PaymentsService } from '../payments/payments.service';
import { DeliveryService } from '../delivery/delivery.service';
import { token } from '../../common/utils';

type IntegrationType = (typeof integrationAccounts.type.enumValues)[number];

/** 27 — POS mapping, partner callbacks, device registry/heartbeat, connection health, replay. */
@Injectable()
export class IntegrationsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly outbox: OutboxService, private readonly payments: PaymentsService, private readonly delivery: DeliveryService) {}

  async create(user: JwtPayload, orgId: string, input: { locationId?: string; type: IntegrationType; provider: string; credentials?: Record<string, unknown>; externalIds?: Record<string, unknown> }) {
    assertOrgAccess(user, orgId, input.locationId, MANAGER_ROLES);
    const webhookSecret = token(24);
    const [row] = await this.db.insert(integrationAccounts).values({ organizationId: orgId, locationId: input.locationId ?? null, type: input.type, provider: input.provider, credentials: this.crypto.encryptObject(input.credentials || {}), externalIds: input.externalIds || {}, webhookSecret, status: 'ACTIVE', lastHealthAt: new Date() }).returning();
    await this.audit.log({ organizationId: orgId, actorId: user.sub, action: 'integration.create', entityType: 'integration', entityId: row.id, after: { type: input.type, provider: input.provider } });
    return { ...row, credentials: undefined, webhookSecret, webhookUrl: `/webhooks/integrations/${row.id}` };
  }

  async list(user: JwtPayload, orgId: string) {
    assertOrgAccess(user, orgId);
    const rows = await this.db.select().from(integrationAccounts).where(eq(integrationAccounts.organizationId, orgId));
    return rows.map((r) => ({ ...r, credentials: undefined, webhookSecret: undefined, healthy: r.status === 'ACTIVE' && !!r.lastHealthAt && Date.now() - r.lastHealthAt.getTime() < 15 * 60_000 }));
  }

  /** Map external catalog/table ids to internal ids (idempotent). */
  async map(user: JwtPayload, integrationId: string, mappings: { entityType: 'MENU_ITEM' | 'TABLE' | 'LOCATION' | 'MODIFIER'; internalId: string; externalId: string }[]) {
    const [i] = await this.db.select().from(integrationAccounts).where(eq(integrationAccounts.id, integrationId)).limit(1);
    if (!i) throw new NotFoundException();
    assertOrgAccess(user, i.organizationId, i.locationId, MANAGER_ROLES);
    for (const m of mappings) {
      await this.db.insert(integrationMappings).values({ ...m, integrationId }).onConflictDoUpdate({ target: [integrationMappings.integrationId, integrationMappings.entityType, integrationMappings.externalId], set: { internalId: m.internalId } });
      if (m.entityType === 'MENU_ITEM') await this.db.update(menuItems).set({ posExternalId: m.externalId }).where(eq(menuItems.id, m.internalId));
      if (m.entityType === 'TABLE') await this.db.update(tables).set({ posTableId: m.externalId }).where(eq(tables.id, m.internalId));
    }
    // orphan check: every mapping must resolve
    const items = mappings.filter((m) => m.entityType === 'MENU_ITEM').map((m) => m.internalId);
    const found = items.length ? await this.db.select({ id: menuItems.id }).from(menuItems).where(inArray(menuItems.id, items)) : [];
    const orphans = items.filter((id) => !found.some((f) => f.id === id));
    if (orphans.length) throw new BadRequestException(`Orphan mapping ids: ${orphans.join(', ')}`);
    return { ok: true, count: mappings.length };
  }

  /**
   * Generic inbound webhook for POS/partner callbacks: HMAC-verified, durable inbox, applied idempotently.
   * Supported events: pos.check.closed (table/check → reservation), pos.item.86 (sold-out), pos.ticket.ack (order ack).
   */
  async ingest(integrationId: string, rawBody: Buffer, signature: string | undefined) {
    const [i] = await this.db.select().from(integrationAccounts).where(eq(integrationAccounts.id, integrationId)).limit(1);
    if (!i || i.status === 'DISABLED') throw new NotFoundException();
    if (!i.webhookSecret || !this.crypto.verifyHmac(i.webhookSecret, rawBody.toString('utf8'), signature || '')) throw new UnauthorizedException('Bad signature');
    const body = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; data: Record<string, unknown> };
    if (!body.id || !body.type) throw new BadRequestException('id and type required');
    const [inserted] = await this.db.insert(inboxEvents).values({ provider: `integration:${integrationId}`, eventId: body.id, type: body.type, payload: body }).onConflictDoNothing().returning();
    if (!inserted) return { duplicate: true };
    try {
      await this.apply(i, body);
      await this.db.update(inboxEvents).set({ processedAt: new Date() }).where(eq(inboxEvents.id, inserted.id));
      await this.db.update(integrationAccounts).set({ lastHealthAt: new Date(), lastError: null, status: 'ACTIVE' }).where(eq(integrationAccounts.id, integrationId));
    } catch (e) {
      await this.db.update(inboxEvents).set({ error: (e as Error).message }).where(eq(inboxEvents.id, inserted.id));
      await this.db.update(integrationAccounts).set({ lastError: (e as Error).message, status: 'ERROR' }).where(eq(integrationAccounts.id, integrationId));
      await this.outbox.publish('integration.failed', integrationId, { type: body.type, error: (e as Error).message });
    }
    return { ok: true };
  }

  private async apply(i: typeof integrationAccounts.$inferSelect, body: { type: string; data: Record<string, unknown> }) {
    const d = body.data || {};
    switch (body.type) {
      case 'pos.check.closed': {
        // match POS check to the seated party on that table; if uncertain, don't duplicate: queue for reconcile
        const [tbl] = d.posTableId ? await this.db.select().from(tables).where(and(eq(tables.posTableId, String(d.posTableId)), ...(i.locationId ? [eq(tables.locationId, i.locationId)] : []))).limit(1) : [];
        if (!tbl) throw new Error(`Unknown POS table ${d.posTableId}`);
        const seated = await this.db.execute(sql`select r.id from reservations r join reservation_tables rt on rt.reservation_id = r.id where rt.table_id = ${tbl.id} and r.status = 'SEATED' order by r.seated_at desc limit 2`);
        if (seated.rows.length !== 1) throw new Error(`Ambiguous seated party for table ${tbl.name} (${seated.rows.length} candidates); reconcile manually`);
        const rid = (seated.rows[0] as { id: string }).id;
        await this.db.update(reservations).set({ posCheckId: String(d.checkId), checkTotalCents: Number(d.totalCents || 0) }).where(and(eq(reservations.id, rid), isNull(reservations.posCheckId)));
        return;
      }
      case 'pos.item.86': {
        const [m] = await this.db.select().from(integrationMappings).where(and(eq(integrationMappings.integrationId, i.id), eq(integrationMappings.entityType, 'MENU_ITEM'), eq(integrationMappings.externalId, String(d.externalId)))).limit(1);
        if (!m) throw new Error(`Unmapped POS item ${d.externalId}`);
        await this.db.update(menuItems).set({ soldOut: !!d.soldOut, soldOutUntil: null }).where(eq(menuItems.id, m.internalId));
        return;
      }
      case 'pos.ticket.ack': {
        const [o] = await this.db.select().from(orders).where(eq(orders.id, String(d.orderId))).limit(1);
        if (!o) throw new Error(`Unknown order ${d.orderId}`);
        if (o.posTicketId && o.posTicketId !== String(d.ticketId)) throw new Error(`Order ${o.number} already has POS ticket ${o.posTicketId}`);
        await this.db.update(orders).set({ posTicketId: String(d.ticketId) }).where(eq(orders.id, o.id));
        return;
      }
      default:
        return; // unknown types are stored for audit but ignored
    }
  }

  /** Devices: tablets, printers, KDS, host & packing screens. Token-authenticated heartbeat. */
  async registerDevice(user: JwtPayload, locationId: string, input: { kind: 'TABLET' | 'PRINTER' | 'KDS' | 'HOST_SCREEN' | 'PACKING_SCREEN'; name: string; fallbackOwner?: string; config?: Record<string, unknown> }) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId, MANAGER_ROLES);
    const [d] = await this.db.insert(devices).values({ ...input, locationId, token: token(24), config: input.config || {} }).returning();
    return d;
  }

  async heartbeat(deviceToken: string, status?: Record<string, unknown>) {
    const s = (status || {}) as { firmware?: string; firmwareVersion?: string; appVersion?: string; app?: string; error?: string };
    const [d] = await this.db.update(devices).set({ lastHeartbeatAt: new Date(), isOnline: true, offlineAlertedAt: null, ...(s.firmware || s.firmwareVersion ? { firmwareVersion: s.firmware || s.firmwareVersion } : {}), ...(s.appVersion ? { appVersion: s.appVersion } : {}), lastError: s.error ?? null, config: status ? sql`${devices.config} || ${JSON.stringify({ lastStatus: status })}::jsonb` : undefined }).where(eq(devices.token, deviceToken)).returning();
    if (!d) throw new UnauthorizedException('Unknown device');
    // 23.7 a device that comes back closes its offline alert
    await this.db.execute(sql`update ops_alerts set status = 'RESOLVED', resolved_at = now(), resolution = 'Device back online', auto_resolved = true where dedupe_key = ${'device:' + d.id} and status <> 'RESOLVED'`);
    return { ok: true, deviceId: d.id, locationId: d.locationId };
  }

  async devicesFor(user: JwtPayload, locationId: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!loc) throw new NotFoundException();
    assertOrgAccess(user, loc.organizationId, locationId);
    return this.db.select({ id: devices.id, kind: devices.kind, name: devices.name, isOnline: devices.isOnline, lastHeartbeatAt: devices.lastHeartbeatAt, fallbackOwner: devices.fallbackOwner }).from(devices).where(eq(devices.locationId, locationId));
  }

  /** Marks devices offline when heartbeats stop (worker). */
  async sweepOffline(now = new Date()) {
    const r = await this.db.update(devices).set({ isOnline: false }).where(and(eq(devices.isOnline, true), lt(devices.lastHeartbeatAt, new Date(now.getTime() - 3 * 60_000)))).returning({ id: devices.id, locationId: devices.locationId, kind: devices.kind });
    for (const d of r) await this.outbox.publish('integration.failed', d.id, { kind: 'device.offline', locationId: d.locationId, deviceKind: d.kind });
    return r.length;
  }

  /** Health and replay for operators. */
  async health(user: JwtPayload) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const failedInbox = await this.db.select().from(inboxEvents).where(sql`${inboxEvents.error} is not null and ${inboxEvents.processedAt} is null`).orderBy(desc(inboxEvents.receivedAt)).limit(100);
    const stuckOutbox = await this.db.select().from(outboxEvents).where(and(isNull(outboxEvents.publishedAt), sql`${outboxEvents.attempts} >= 5`)).limit(100);
    const errored = await this.db.select().from(integrationAccounts).where(eq(integrationAccounts.status, 'ERROR'));
    const offline = await this.db.select().from(devices).where(eq(devices.isOnline, false));
    return { failedInbox: failedInbox.map((e) => ({ id: e.id, provider: e.provider, type: e.type, error: e.error, receivedAt: e.receivedAt })), stuckOutbox, erroredIntegrations: errored.map((e) => ({ id: e.id, provider: e.provider, lastError: e.lastError })), offlineDevices: offline.length };
  }

  async replayInbox(user: JwtPayload, id: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    const [row] = await this.db.select().from(inboxEvents).where(eq(inboxEvents.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    if (row.provider.startsWith('integration:')) {
      const [i] = await this.db.select().from(integrationAccounts).where(eq(integrationAccounts.id, row.provider.slice('integration:'.length))).limit(1);
      if (!i) throw new NotFoundException();
      await this.apply(i, row.payload as { type: string; data: Record<string, unknown> });
    } else if (row.provider.startsWith('delivery:')) {
      await this.delivery.applyProviderEvent(row.payload as never);
    } else {
      await this.payments.applyProviderEvent(row.payload as never);
    }
    await this.db.update(inboxEvents).set({ processedAt: new Date(), error: null }).where(eq(inboxEvents.id, id));
    await this.audit.log({ actorId: user.sub, action: 'inbox.replay', entityType: 'inbox_event', entityId: id });
    return { ok: true };
  }

  async replayOutbox(user: JwtPayload, id: string) {
    if (!isPlatformStaff(user)) throw new ForbiddenException();
    await this.db.update(outboxEvents).set({ attempts: 0, lastError: null }).where(eq(outboxEvents.id, id));
    return { ok: true };
  }
}
