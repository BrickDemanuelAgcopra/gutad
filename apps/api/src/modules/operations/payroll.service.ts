import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PAYROLL_PROVIDERS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { locations, payrollConnections, payrollExportBatches } from '../../db/schema';
import { assertOrgAccess, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { CryptoService } from '../../core/crypto.service';
import { payrollAdapter, type PayrollContext } from './payroll-adapters';
import { WorkforceService } from './workforce.service';

const OWNERS = ['MERCHANT_OWNER', 'MERCHANT_MANAGER'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 23.3-P push approved hours (with overtime) per pay period to Gusto / ADP (mock by default); batches tracked per period. */
@Injectable()
export class PayrollService {
  constructor(@Inject(DB) private readonly db: Db, private readonly wf: WorkforceService, private readonly audit: AuditService, private readonly crypto: CryptoService) {}

  private sanitize(c: typeof payrollConnections.$inferSelect) {
    const { credentials, ...rest } = c;
    const creds = this.crypto.decryptObject(credentials as Record<string, unknown>);
    return { ...rest, hasCredentials: Object.values(creds).some(Boolean) };
  }

  private async loc(user: JwtPayload, locationId: string) {
    const [l] = await this.db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!l) throw new NotFoundException('Location not found');
    assertOrgAccess(user, l.organizationId, l.id, [...OWNERS]);
    return l;
  }

  async status(user: JwtPayload, locationId: string) {
    const l = await this.loc(user, locationId);
    const [c] = await this.db.select().from(payrollConnections).where(eq(payrollConnections.organizationId, l.organizationId)).limit(1);
    const batches = await this.db.select().from(payrollExportBatches).where(eq(payrollExportBatches.locationId, locationId)).orderBy(desc(payrollExportBatches.periodStart), desc(payrollExportBatches.createdAt)).limit(30);
    return { providers: PAYROLL_PROVIDERS, connection: c ? this.sanitize(c) : null, batches: batches.map(({ payload: _p, ...b }) => b) };
  }

  async connect(user: JwtPayload, organizationId: string, input: { provider: string; externalCompanyId?: string | null; credentials?: Record<string, string>; employeeIds?: Record<string, string>; config?: Record<string, unknown> }) {
    assertOrgAccess(user, organizationId, null, ['MERCHANT_OWNER']);
    const adapter = payrollAdapter(input.provider);
    if (!adapter) throw new BadRequestException('Unknown payroll provider');
    const [cur] = await this.db.select().from(payrollConnections).where(eq(payrollConnections.organizationId, organizationId)).limit(1);
    const sameProvider = cur?.provider === input.provider;
    const creds = input.credentials && Object.values(input.credentials).some(Boolean) ? input.credentials : sameProvider ? (this.crypto.decryptObject(cur!.credentials as Record<string, unknown>) as Record<string, string>) : {};
    const prevCfg = sameProvider ? (cur!.config as Record<string, unknown>) : {};
    const config = { ...prevCfg, ...(input.config || {}), ...(input.employeeIds ? { employeeIds: input.employeeIds } : {}) };
    const companyId = input.externalCompanyId !== undefined ? input.externalCompanyId : sameProvider ? cur!.externalCompanyId : null;
    const problem = adapter.validate({ credentials: creds, companyId, config });
    if (problem) throw new BadRequestException(problem);
    const v = { organizationId, provider: input.provider, status: 'CONNECTED', credentials: this.crypto.encryptObject(creds), externalCompanyId: companyId, config, connectedById: user.sub };
    const [row] = await this.db.insert(payrollConnections).values(v).onConflictDoUpdate({ target: payrollConnections.organizationId, set: v }).returning();
    await this.audit.log({ organizationId, actorId: user.sub, action: 'payroll.connect', entityType: 'payroll_connection', entityId: row.id, before: cur ? { provider: cur.provider, status: cur.status } : null, after: { provider: row.provider, externalCompanyId: companyId, mappedEmployees: Object.keys((config.employeeIds as object) || {}).length } });
    return this.sanitize(row);
  }

  async disconnect(user: JwtPayload, organizationId: string) {
    assertOrgAccess(user, organizationId, null, ['MERCHANT_OWNER']);
    const [row] = await this.db.update(payrollConnections).set({ status: 'DISCONNECTED', credentials: this.crypto.encryptObject({}) }).where(eq(payrollConnections.organizationId, organizationId)).returning();
    if (!row) throw new NotFoundException('No payroll connection');
    await this.audit.log({ organizationId, actorId: user.sub, action: 'payroll.disconnect', entityType: 'payroll_connection', entityId: row.id });
    return this.sanitize(row);
  }

  /** Push a pay period (end exclusive). A pushed period returns the existing batch; a failed one is retried. */
  async push(user: JwtPayload, locationId: string, input: { periodStart: string; periodEnd: string }) {
    const l = await this.loc(user, locationId);
    if (!DAY.test(input.periodStart) || !DAY.test(input.periodEnd) || input.periodEnd <= input.periodStart) throw new BadRequestException('Pay period is YYYY-MM-DD … YYYY-MM-DD (end exclusive)');
    const [conn] = await this.db.select().from(payrollConnections).where(eq(payrollConnections.organizationId, l.organizationId)).limit(1);
    const provider = conn && conn.status === 'CONNECTED' ? conn.provider : null;
    if (!provider) throw new ConflictException({ message: 'No payroll provider connected; use the CSV export', code: 'PAYROLL_NOT_CONNECTED' });
    await this.db.insert(payrollExportBatches).values({ organizationId: l.organizationId, locationId, provider, periodStart: input.periodStart, periodEnd: input.periodEnd, createdById: user.sub }).onConflictDoNothing();
    const [b] = await this.db.select().from(payrollExportBatches).where(and(eq(payrollExportBatches.locationId, locationId), eq(payrollExportBatches.provider, provider), eq(payrollExportBatches.periodStart, input.periodStart), eq(payrollExportBatches.periodEnd, input.periodEnd))).limit(1);
    if (b.status === 'PUSHED') return { batch: b, alreadyPushed: true };
    if (b.status === 'PUSHING' && Date.now() - b.updatedAt.getTime() < 120_000) throw new ConflictException('A push for this period is already running');
    return { batch: await this.attempt(user, b.id, l.name), alreadyPushed: false };
  }

  async retry(user: JwtPayload, batchId: string) {
    const [b] = await this.db.select().from(payrollExportBatches).where(eq(payrollExportBatches.id, batchId)).limit(1);
    if (!b) throw new NotFoundException();
    const l = await this.loc(user, b.locationId);
    if (b.status === 'PUSHED') return { batch: b, alreadyPushed: true };
    return { batch: await this.attempt(user, b.id, l.name), alreadyPushed: false };
  }

  private async attempt(user: JwtPayload, batchId: string, locationName: string) {
    const [b] = await this.db.update(payrollExportBatches).set({ status: 'PUSHING', attempts: sql`${payrollExportBatches.attempts} + 1` }).where(eq(payrollExportBatches.id, batchId)).returning();
    const fail = async (message: string) => {
      const [u] = await this.db.update(payrollExportBatches).set({ status: 'FAILED', lastError: message.slice(0, 500) }).where(eq(payrollExportBatches.id, batchId)).returning();
      await this.audit.log({ organizationId: b.organizationId, actorId: user.sub, action: 'payroll.push_failed', entityType: 'payroll_batch', entityId: batchId, after: { attempts: b.attempts, error: message.slice(0, 200) } });
      return u;
    };
    const [conn] = await this.db.select().from(payrollConnections).where(eq(payrollConnections.organizationId, b.organizationId)).limit(1);
    if (!conn || conn.status !== 'CONNECTED' || conn.provider !== b.provider) return fail('The payroll connection was changed or removed');
    const adapter = payrollAdapter(conn.provider);
    if (!adapter) return fail(`No adapter for ${conn.provider}`);
    const rows = await this.wf.payrollRows(user, b.locationId, new Date(`${b.periodStart}T00:00:00Z`), new Date(`${b.periodEnd}T00:00:00Z`));
    const approved = rows.filter((r) => r.regularHours + r.overtimeHours > 0);
    const unapproved = rows.reduce((a, r) => a + r.unapprovedHours, 0);
    const config = conn.config as { employeeIds?: Record<string, string> };
    const missing = adapter.needsEmployeeIds ? [...new Set(approved.filter((r) => !config.employeeIds?.[r.userId]).map((r) => r.email))] : [];
    const lines = approved.map((r) => ({ ...r, providerEmployeeId: config.employeeIds?.[r.userId] || r.userId }));
    const totals = { employees: new Set(lines.map((l) => l.userId)).size, regularHours: Math.round(lines.reduce((a, l) => a + l.regularHours, 0) * 100) / 100, overtimeHours: Math.round(lines.reduce((a, l) => a + l.overtimeHours, 0) * 100) / 100, grossCents: lines.reduce((a, l) => a + l.grossCents, 0), unapprovedHours: Math.round(unapproved * 100) / 100, payload: lines };
    await this.db.update(payrollExportBatches).set(totals).where(eq(payrollExportBatches.id, batchId));
    if (!lines.length) return fail('No approved hours in this pay period');
    if (missing.length) return fail(`No ${conn.provider} employee id for: ${missing.join(', ')}`);
    const ctx: PayrollContext = { credentials: this.crypto.decryptObject(conn.credentials as Record<string, unknown>) as PayrollContext['credentials'], companyId: conn.externalCompanyId, config: conn.config as Record<string, unknown> };
    try {
      const r = await adapter.push({ reference: `payroll:${b.locationId}:${b.periodStart}:${b.periodEnd}`, periodStart: b.periodStart, periodEnd: b.periodEnd, locationName, lines }, ctx);
      const [u] = await this.db.update(payrollExportBatches).set({ status: 'PUSHED', externalId: r.externalId, lastError: null, pushedAt: new Date() }).where(eq(payrollExportBatches.id, batchId)).returning();
      await this.audit.log({ organizationId: b.organizationId, actorId: user.sub, action: 'payroll.push', entityType: 'payroll_batch', entityId: batchId, after: { provider: conn.provider, externalId: r.externalId, ...totals, payload: undefined } });
      return u;
    } catch (e) {
      return fail((e as Error).message || 'Push failed');
    }
  }
}
