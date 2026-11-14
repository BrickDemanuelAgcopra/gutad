import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { GL_PROVIDERS } from '@gutad/shared';
import { DB, Db } from '../../db/db.module';
import { closePeriods, glConnections, glPushBatches, journalEntries } from '../../db/schema';
import { assertCan, JwtPayload } from '../../common/auth';
import { AuditService } from '../../core/audit.service';
import { CryptoService } from '../../core/crypto.service';
import { AccountingService } from './accounting.service';
import { glAdapter, type GlContext, type GlJournal } from './gl-adapters';

const SYSTEM = { sub: null, roles: ['PLATFORM_ADMIN'], permissions: ['finance.read'], orgs: {} } as unknown as JwtPayload;
const MAX_ATTEMPTS = 6;
const monthRange = (period: string) => { const [y, m] = period.split('-').map(Number); return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) }; };

/** 20.1-L live push of a month's journals to QuickBooks Online / Xero (mock for tests); CSV export stays the default. */
@Injectable()
export class GlPushService {
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService, private readonly crypto: CryptoService, private readonly acc: AccountingService) {}

  private sanitize(c: typeof glConnections.$inferSelect) {
    const { credentials, ...rest } = c;
    const creds = this.crypto.decryptObject(credentials as Record<string, unknown>);
    return { ...rest, hasCredentials: Object.values(creds).some(Boolean) };
  }

  async connection(user: JwtPayload, legalEntity = 'GUTAD') {
    assertCan(user, 'finance.read');
    const [c] = await this.db.select().from(glConnections).where(eq(glConnections.legalEntity, legalEntity)).limit(1);
    const batches = await this.db.select().from(glPushBatches).where(eq(glPushBatches.legalEntity, legalEntity)).orderBy(desc(glPushBatches.period), desc(glPushBatches.createdAt)).limit(36);
    const active = c && c.status !== 'DISCONNECTED';
    return { legalEntity, providers: GL_PROVIDERS, mode: active ? 'PUSH' : 'CSV', connection: c ? this.sanitize(c) : null, batches };
  }

  async connect(user: JwtPayload, input: { legalEntity?: string; provider: string; externalTenantId?: string | null; credentials?: Record<string, string>; config?: Record<string, unknown> }) {
    assertCan(user, 'finance.manage');
    const adapter = glAdapter(input.provider);
    if (!adapter) throw new BadRequestException('Unknown accounting provider');
    const legalEntity = input.legalEntity || 'GUTAD';
    const [cur] = await this.db.select().from(glConnections).where(eq(glConnections.legalEntity, legalEntity)).limit(1);
    // keep stored credentials when only the config changes
    const creds = input.credentials && Object.values(input.credentials).some(Boolean) ? input.credentials : cur && cur.provider === input.provider ? (this.crypto.decryptObject(cur.credentials as Record<string, unknown>) as Record<string, string>) : {};
    const tenantId = input.externalTenantId !== undefined ? input.externalTenantId : cur?.externalTenantId ?? null;
    const config = input.config ?? (cur?.provider === input.provider ? (cur.config as Record<string, unknown>) : {});
    const problem = adapter.validate({ credentials: creds, tenantId, config });
    if (problem) throw new BadRequestException(problem);
    const v = { legalEntity, provider: input.provider, status: 'CONNECTED', credentials: this.crypto.encryptObject(creds), externalTenantId: tenantId, config, connectedById: user.sub, lastError: null };
    const [row] = await this.db.insert(glConnections).values(v).onConflictDoUpdate({ target: glConnections.legalEntity, set: v }).returning();
    await this.audit.log({ actorId: user.sub, action: 'finance.gl_connect', entityType: 'gl_connection', entityId: row.id, before: cur ? { provider: cur.provider, status: cur.status } : null, after: { provider: row.provider, legalEntity, externalTenantId: tenantId, config } });
    return this.sanitize(row);
  }

  async disconnect(user: JwtPayload, legalEntity = 'GUTAD') {
    assertCan(user, 'finance.manage');
    const [row] = await this.db.update(glConnections).set({ status: 'DISCONNECTED', credentials: this.crypto.encryptObject({}) }).where(eq(glConnections.legalEntity, legalEntity)).returning();
    if (!row) throw new NotFoundException('No accounting connection');
    await this.audit.log({ actorId: user.sub, action: 'finance.gl_disconnect', entityType: 'gl_connection', entityId: row.id });
    return this.sanitize(row);
  }

  /** The month as one summarized journal: net debit or credit per GL account code (every batch balances, so the journal does). */
  async buildJournal(period: string, legalEntity: string, reference: string, currency = 'USD'): Promise<{ journal: GlJournal; entries: number; unmapped: string[] }> {
    const { from, to } = monthRange(period);
    const sums = await this.db.select({ account: journalEntries.account, d: sql<number>`coalesce(sum(${journalEntries.debitCents}),0)::bigint`, c: sql<number>`coalesce(sum(${journalEntries.creditCents}),0)::bigint`, n: sql<number>`count(*)::int` }).from(journalEntries).where(and(gte(journalEntries.createdAt, from), lt(journalEntries.createdAt, to))).groupBy(journalEntries.account);
    const map = new Map((await this.acc.glMap(SYSTEM, legalEntity)).map((g) => [g.ledgerAccount, g]));
    const byCode = new Map<string, { name: string; net: number; accounts: string[] }>();
    const unmapped: string[] = [];
    for (const s of sums) {
      const g = map.get(s.account);
      if (!g) { unmapped.push(s.account); continue; }
      const cur = byCode.get(g.glCode) || { name: g.glName, net: 0, accounts: [] };
      cur.net += Number(s.d) - Number(s.c);
      cur.accounts.push(s.account);
      byCode.set(g.glCode, cur);
    }
    const lines = [...byCode.entries()].filter(([, x]) => x.net !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([code, x]) => ({ accountCode: code, accountName: x.name, debitCents: Math.max(0, x.net), creditCents: Math.max(0, -x.net), description: `Gutad ${period}: ${x.accounts.join(', ')}` }));
    const last = new Date(to.getTime() - 86400_000).toISOString().slice(0, 10);
    return { journal: { reference, period, date: last, legalEntity, currency, narration: `Gutad journals ${period} (${legalEntity})`, lines }, entries: sums.reduce((a, s) => a + s.n, 0), unmapped };
  }

  /** Push a month; idempotent per (legal entity, provider, period): a pushed month returns the existing batch. */
  async push(user: JwtPayload, input: { period: string; legalEntity?: string; allowOpen?: boolean }) {
    assertCan(user, 'finance.manage');
    const legalEntity = input.legalEntity || 'GUTAD';
    if (!/^\d{4}-\d{2}$/.test(input.period)) throw new BadRequestException('Period is YYYY-MM');
    if (input.period > new Date().toISOString().slice(0, 7)) throw new BadRequestException('That month has not started');
    const [conn] = await this.db.select().from(glConnections).where(eq(glConnections.legalEntity, legalEntity)).limit(1);
    if (!conn || conn.status === 'DISCONNECTED') throw new ConflictException({ message: 'No accounting software connected; use the CSV journal export', code: 'GL_NOT_CONNECTED' });
    const [cp] = await this.db.select().from(closePeriods).where(eq(closePeriods.period, input.period)).limit(1);
    if (cp?.status !== 'CLOSED' && !input.allowOpen) throw new ConflictException({ message: `${input.period} is not closed; close the month first or push it anyway`, code: 'PERIOD_OPEN' });
    const key = `gl:${legalEntity}:${conn.provider}:${input.period}`;
    await this.db.insert(glPushBatches).values({ connectionId: conn.id, legalEntity, provider: conn.provider, period: input.period, idempotencyKey: key, createdById: user.sub }).onConflictDoNothing();
    const [batch] = await this.db.select().from(glPushBatches).where(and(eq(glPushBatches.legalEntity, legalEntity), eq(glPushBatches.provider, conn.provider), eq(glPushBatches.period, input.period))).limit(1);
    if (batch.status === 'PUSHED') return { batch, alreadyPushed: true };
    if (batch.status === 'PUSHING' && Date.now() - batch.updatedAt.getTime() < 120_000) throw new ConflictException('A push for this month is already running');
    return { batch: await this.attempt(batch.id, user.sub), alreadyPushed: false };
  }

  async retry(user: JwtPayload, batchId: string) {
    assertCan(user, 'finance.manage');
    const [b] = await this.db.select().from(glPushBatches).where(eq(glPushBatches.id, batchId)).limit(1);
    if (!b) throw new NotFoundException();
    if (b.status === 'PUSHED') return { batch: b, alreadyPushed: true };
    return { batch: await this.attempt(b.id, user.sub), alreadyPushed: false };
  }

  /** Worker: failed pushes retry with backoff (5 min doubling, up to 6 attempts). */
  async retryDue() {
    const due = await this.db.select().from(glPushBatches).where(and(eq(glPushBatches.status, 'FAILED'), lte(glPushBatches.nextRetryAt, new Date()), lt(glPushBatches.attempts, MAX_ATTEMPTS))).limit(20);
    for (const b of due) await this.attempt(b.id, null);
    return { retried: due.length };
  }

  private async attempt(batchId: string, actorId: string | null) {
    const [b] = await this.db.update(glPushBatches).set({ status: 'PUSHING', attempts: sql`${glPushBatches.attempts} + 1` }).where(eq(glPushBatches.id, batchId)).returning();
    const [conn] = await this.db.select().from(glConnections).where(eq(glConnections.id, b.connectionId)).limit(1);
    const fail = async (message: string) => {
      const delayMin = Math.min(360, 5 * 2 ** Math.max(0, b.attempts - 1));
      const [u] = await this.db.update(glPushBatches).set({ status: 'FAILED', lastError: message.slice(0, 500), nextRetryAt: b.attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + delayMin * 60_000) }).where(eq(glPushBatches.id, batchId)).returning();
      if (conn) await this.db.update(glConnections).set({ lastError: message.slice(0, 500) }).where(eq(glConnections.id, conn.id));
      await this.audit.log({ actorId, action: 'finance.gl_push_failed', entityType: 'gl_push_batch', entityId: batchId, after: { period: b.period, attempts: b.attempts, error: message.slice(0, 200) } });
      return u;
    };
    if (!conn || conn.status === 'DISCONNECTED' || conn.provider !== b.provider) return fail('The accounting connection was changed or removed');
    const adapter = glAdapter(conn.provider);
    if (!adapter) return fail(`No adapter for ${conn.provider}`);
    const { journal, entries, unmapped } = await this.buildJournal(b.period, b.legalEntity, b.idempotencyKey, (conn.config as { currency?: string }).currency || 'USD');
    if (unmapped.length) return fail(`Ledger accounts without a GL code: ${unmapped.join(', ')}`);
    if (!journal.lines.length) return fail(`No journal entries in ${b.period}`);
    const debit = journal.lines.reduce((a, l) => a + l.debitCents, 0), credit = journal.lines.reduce((a, l) => a + l.creditCents, 0);
    if (debit !== credit) return fail(`Journal for ${b.period} does not balance (${debit} vs ${credit})`);
    const ctx: GlContext = { credentials: this.crypto.decryptObject(conn.credentials as Record<string, unknown>) as GlContext['credentials'], tenantId: conn.externalTenantId, config: conn.config as Record<string, unknown> };
    try {
      const r = await adapter.push(journal, ctx);
      const [u] = await this.db.update(glPushBatches).set({ status: 'PUSHED', externalId: r.externalId, lines: entries, debitCents: debit, creditCents: credit, unmapped: 0, lastError: null, nextRetryAt: null, pushedAt: new Date() }).where(eq(glPushBatches.id, batchId)).returning();
      await this.db.update(glConnections).set({ lastPushAt: new Date(), lastError: null, status: 'CONNECTED' }).where(eq(glConnections.id, conn.id));
      await this.tickExported(b.period, actorId);
      await this.audit.log({ actorId, action: 'finance.gl_push', entityType: 'gl_push_batch', entityId: batchId, after: { provider: conn.provider, period: b.period, externalId: r.externalId, lines: journal.lines.length, debitCents: debit } });
      return u;
    } catch (e) {
      return fail((e as Error).message || 'Push failed');
    }
  }

  /** A pushed month ticks "Journal exported to the general ledger" on its close checklist. */
  private async tickExported(period: string, actorId: string | null) {
    const [cp] = await this.db.select().from(closePeriods).where(eq(closePeriods.period, period)).limit(1);
    if (!cp || cp.status === 'CLOSED') return;
    const list = (cp.checklist as { key: string; label: string; done: boolean }[]).map((c) => (c.key === 'journal_exported' ? { ...c, done: true, by: actorId ?? 'gl-push', at: new Date().toISOString() } : c));
    await this.db.update(closePeriods).set({ checklist: list }).where(eq(closePeriods.id, cp.id));
  }
}
