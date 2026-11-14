import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { DEFAULT_SENSOR_CONFIG, DEFAULT_TEMP_RANGES, type SensorConfig } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { kitchens, opsAlerts, storageAreas, temperatureSensors } from '../../db/schema';
import { assertCan, assertOrgAccess, JwtPayload, MANAGER_ROLES } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { SettingsService } from '../../core/settings.service';
import { KitchenService } from '../kitchen/kitchen.service';
import { SafetyService } from './safety.service';
import { hashToken, newToken } from './tokens';

type Sensor = typeof temperatureSensors.$inferSelect;

/**
 * 22.2-S wireless temperature sensors: one per storage area, authenticated by its own token. Readings become
 * temperature logs through SafetyService (same out-of-range alert and corrective action); silent sensors raise an
 * offline alert once per outage.
 */
@Injectable()
export class SensorsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly kitchen: KitchenService, private readonly safety: SafetyService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  cfg() { return this.settings.getObject<SensorConfig>('safety.sensors', DEFAULT_SENSOR_CONFIG); }

  private present(s: Sensor, area?: string | null) {
    const { tokenHash: _h, ...rest } = s;
    return { ...rest, storageArea: area ?? null, minutesSinceReading: s.lastReadingAt ? Math.round((Date.now() - s.lastReadingAt.getTime()) / 60_000) : null };
  }

  async list(user: JwtPayload, kitchenId: string) {
    await this.kitchen.requireKitchen(user, kitchenId);
    const rows = await this.db.select({ s: temperatureSensors, area: storageAreas.name }).from(temperatureSensors).leftJoin(storageAreas, eq(storageAreas.id, temperatureSensors.storageAreaId)).where(and(eq(temperatureSensors.kitchenId, kitchenId), ne(temperatureSensors.status, 'RETIRED'))).orderBy(storageAreas.name, temperatureSensors.name);
    return { config: await this.cfg(), sensors: rows.map((r) => this.present(r.s, r.area)) };
  }

  /** Gutad staff (web admin safety, mobile ops safety): every active sensor across kitchens, offline and out-of-range first. */
  async overview(user: JwtPayload) {
    assertCan(user, 'kitchens.read', 'ops.read');
    const rows = await this.db.select({ s: temperatureSensors, area: storageAreas.name, kitchen: kitchens.name }).from(temperatureSensors).innerJoin(kitchens, eq(kitchens.id, temperatureSensors.kitchenId)).leftJoin(storageAreas, eq(storageAreas.id, temperatureSensors.storageAreaId)).where(eq(temperatureSensors.status, 'ACTIVE')).orderBy(kitchens.name, temperatureSensors.name).limit(500);
    const list = rows.map((r) => ({ ...this.present(r.s, r.area), kitchen: r.kitchen }));
    const rank = (x: (typeof list)[number]) => (!x.isOnline ? 0 : x.lastInRange === false ? 1 : 2);
    return { config: await this.cfg(), total: list.length, offline: list.filter((x) => !x.isOnline).length, outOfRange: list.filter((x) => x.lastInRange === false).length, sensors: list.sort((a, b) => rank(a) - rank(b)) };
  }

  async register(user: JwtPayload, kitchenId: string, input: { storageAreaId: string; name: string; vendor?: string; serial?: string; offlineAfterMinutes?: number | null }) {
    const k = await this.kitchen.requireKitchen(user, kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    const [a] = await this.db.select().from(storageAreas).where(and(eq(storageAreas.id, input.storageAreaId), eq(storageAreas.kitchenId, kitchenId))).limit(1);
    if (!a) throw new NotFoundException('Storage area not found');
    const t = newToken('sens');
    const [row] = await this.db.insert(temperatureSensors).values({ kitchenId, storageAreaId: a.id, name: input.name, vendor: input.vendor ?? null, serial: input.serial ?? null, tokenHash: t.hash, tokenHint: t.hint, offlineAfterMinutes: input.offlineAfterMinutes ?? null, createdById: user.sub }).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'sensor.register', entityType: 'temperature_sensor', entityId: row.id, after: { storageAreaId: a.id, name: row.name, serial: row.serial } });
    return { ...this.present(row, a.name), token: t.token };
  }

  private async own(user: JwtPayload, id: string) {
    const [s] = await this.db.select().from(temperatureSensors).where(eq(temperatureSensors.id, id)).limit(1);
    if (!s) throw new NotFoundException('Sensor not found');
    const k = await this.kitchen.requireKitchen(user, s.kitchenId);
    assertOrgAccess(user, k.organizationId, null, MANAGER_ROLES);
    return { s, k };
  }

  async rotate(user: JwtPayload, id: string) {
    const { s, k } = await this.own(user, id);
    const t = newToken('sens');
    const [row] = await this.db.update(temperatureSensors).set({ tokenHash: t.hash, tokenHint: t.hint }).where(eq(temperatureSensors.id, s.id)).returning();
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'sensor.rotate_token', entityType: 'temperature_sensor', entityId: s.id });
    return { ...this.present(row), token: t.token };
  }

  async retire(user: JwtPayload, id: string) {
    const { s, k } = await this.own(user, id);
    const [row] = await this.db.update(temperatureSensors).set({ status: 'RETIRED', isOnline: false }).where(eq(temperatureSensors.id, s.id)).returning();
    await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: 'Sensor retired', autoResolved: true }).where(and(sql`${opsAlerts.dedupeKey} in (${`sensor-offline:${s.id}`}, ${`sensor-temp:${s.id}`})`, ne(opsAlerts.status, 'RESOLVED')));
    await this.audit.log({ organizationId: k.organizationId, actorId: user.sub, action: 'sensor.retire', entityType: 'temperature_sensor', entityId: s.id });
    return this.present(row);
  }

  /** Readings from a sensor (header `x-sensor-token`); one reading or a batch, oldest first. */
  async ingest(token: string | undefined, input: { readings: { tempC: number; at?: string }[]; batteryPct?: number }) {
    if (!token) throw new UnauthorizedException('Sensor token required');
    const [s] = await this.db.select().from(temperatureSensors).where(eq(temperatureSensors.tokenHash, hashToken(token))).limit(1);
    if (!s || s.status !== 'ACTIVE') throw new UnauthorizedException('Unknown or retired sensor');
    if (!input.readings.length) throw new BadRequestException('No readings');
    const [k] = await this.db.select().from(kitchens).where(eq(kitchens.id, s.kitchenId)).limit(1);
    const [area] = await this.db.select().from(storageAreas).where(eq(storageAreas.id, s.storageAreaId)).limit(1);
    if (!k || !area) throw new ConflictException('The sensor storage area no longer exists');
    const cfg = await this.cfg();
    const min = area.minTempC ?? DEFAULT_TEMP_RANGES[area.kind]?.min ?? null, max = area.maxTempC ?? DEFAULT_TEMP_RANGES[area.kind]?.max ?? null;
    const now = Date.now();
    const readings = input.readings.map((r) => ({ tempC: r.tempC, at: r.at ? new Date(r.at) : new Date() })).filter((r) => !Number.isNaN(r.at.getTime()) && r.at.getTime() <= now + 5 * 60_000 && r.at.getTime() > now - 24 * 3600_000).sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!readings.length) throw new BadRequestException('Readings must be from the last 24 hours');
    let lastLogged = s.lastLoggedAt?.getTime() ?? 0;
    let lastInRange = s.lastInRange;
    let logged = 0, outOfRange = 0;
    for (const r of readings) {
      const inRange = (min === null || r.tempC >= min) && (max === null || r.tempC <= max);
      if (!inRange) outOfRange++;
      // keep every out-of-range reading and every change of state; in-range ones at most every `logEveryMinutes`
      const due = !inRange || lastInRange === false || lastInRange === null || r.at.getTime() - lastLogged >= cfg.logEveryMinutes * 60_000;
      if (due) {
        await this.safety.recordTemperature(k, { kind: 'STORAGE', tempC: r.tempC, storageAreaId: area.id, note: `Sensor ${s.name}${s.serial ? ` (${s.serial})` : ''} at ${r.at.toISOString().slice(0, 16).replace('T', ' ')} UTC` }, null, { alertKey: `sensor-temp:${s.id}` });
        lastLogged = r.at.getTime();
        logged++;
      }
      if (inRange && lastInRange === false) await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: `${s.name} back in range (${r.tempC} °C)`, autoResolved: true }).where(and(eq(opsAlerts.dedupeKey, `sensor-temp:${s.id}`), ne(opsAlerts.status, 'RESOLVED')));
      lastInRange = inRange;
    }
    const last = readings[readings.length - 1];
    await this.db.update(temperatureSensors).set({ isOnline: true, offlineAlertedAt: null, lastReadingAt: last.at, lastTempC: last.tempC, lastInRange, lastLoggedAt: lastLogged ? new Date(lastLogged) : s.lastLoggedAt, ...(input.batteryPct !== undefined ? { batteryPct: input.batteryPct } : {}) }).where(eq(temperatureSensors.id, s.id));
    if (s.offlineAlertedAt) await this.db.update(opsAlerts).set({ status: 'RESOLVED', resolvedAt: new Date(), resolution: `${s.name} reporting again`, autoResolved: true }).where(and(eq(opsAlerts.dedupeKey, `sensor-offline:${s.id}`), ne(opsAlerts.status, 'RESOLVED')));
    return { sensorId: s.id, accepted: readings.length, logged, outOfRange, inRange: lastInRange, range: { minC: min, maxC: max } };
  }

  /** Worker: active sensors silent past their window go offline with one alert per outage. */
  async offlineSweep(now = new Date()) {
    const cfg = await this.cfg();
    const list = await this.db.select({ s: temperatureSensors, org: kitchens.organizationId, kitchen: kitchens.name, area: storageAreas.name }).from(temperatureSensors).innerJoin(kitchens, eq(kitchens.id, temperatureSensors.kitchenId)).leftJoin(storageAreas, eq(storageAreas.id, temperatureSensors.storageAreaId)).where(and(eq(temperatureSensors.status, 'ACTIVE'), isNull(temperatureSensors.offlineAlertedAt)));
    let offline = 0;
    for (const { s, org, kitchen, area } of list) {
      const since = (s.lastReadingAt ?? s.createdAt).getTime();
      if (now.getTime() - since < (s.offlineAfterMinutes ?? cfg.offlineAfterMinutes) * 60_000) continue;
      await this.db.update(temperatureSensors).set({ isOnline: false, offlineAlertedAt: new Date() }).where(eq(temperatureSensors.id, s.id));
      await this.db.insert(opsAlerts).values({ type: 'SENSOR_OFFLINE', severity: 'HIGH', title: `Temperature sensor ${s.name} offline (${area ?? 'storage'}, ${kitchen})`, detail: `${s.lastReadingAt ? `No reading since ${s.lastReadingAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'No reading received yet'}. Log temperatures by hand until it reports again.${s.batteryPct != null ? ` Battery was ${s.batteryPct}%.` : ''}`, subjectType: 'temperature_sensor', subjectId: s.id, organizationId: org, dedupeKey: `sensor-offline:${s.id}`, ownerRole: 'CULINARY', escalateAt: new Date(Date.now() + 30 * 60_000), history: [{ at: new Date().toISOString(), by: null, action: 'RAISED', note: 'Sensor silent' }] }).onConflictDoNothing();
      offline++;
    }
    return { offline };
  }

  /** Recent sensor-sourced readings for a kitchen (web/mobile read-only views use /kitchens/:id/temperatures too). */
  async recent(user: JwtPayload, id: string) {
    const [s] = await this.db.select().from(temperatureSensors).where(eq(temperatureSensors.id, id)).limit(1);
    if (!s) throw new NotFoundException();
    await this.kitchen.requireKitchen(user, s.kitchenId);
    const alerts = await this.db.select().from(opsAlerts).where(sql`${opsAlerts.dedupeKey} in (${`sensor-offline:${s.id}`}, ${`sensor-temp:${s.id}`})`).orderBy(desc(opsAlerts.createdAt)).limit(20);
    return { sensor: this.present(s), alerts };
  }
}
