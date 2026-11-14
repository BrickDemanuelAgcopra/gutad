import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { SECURITY_ALERT_TYPES, type SecurityAlertType } from '@gutad/shared';
import { DB, Db } from '../db/db.module';
import { loginEvents, securityAlerts } from '../db/schema';
import { AclService } from './acl.service';
import { NotifyService } from './notify.service';

export interface RaiseAlert {
  type: SecurityAlertType;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  detail?: string | null;
  subjectUserId?: string | null;
  actorId?: string | null;
  data?: Record<string, unknown>;
  /** one alert per key (e.g. one "key expiring" alert per key) */
  dedupeKey?: string;
}

/** Security alerts (with notifications to the people who manage access) and the sign-in event log. */
@Injectable()
export class SecurityEventsService {
  private readonly log = new Logger(SecurityEventsService.name);
  constructor(@Inject(DB) private readonly db: Db, private readonly acl: AclService, private readonly notify: NotifyService) {}

  async raise(a: RaiseAlert) {
    try {
      const [row] = await this.db
        .insert(securityAlerts)
        .values({ type: a.type, severity: a.severity || 'MEDIUM', title: a.title, detail: a.detail ?? null, subjectUserId: a.subjectUserId ?? null, actorId: a.actorId ?? null, data: (a.data || {}) as never, dedupeKey: a.dedupeKey ?? null })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      const recipients = await this.acl.securityRecipients();
      for (const id of recipients) {
        if (id === a.actorId && a.type !== 'SUSPICIOUS_LOGIN') continue;
        await this.notify.queue({ userId: id, template: 'security.alert', payload: { title: a.title, detail: a.detail, type: SECURITY_ALERT_TYPES[a.type] }, channels: a.severity === 'HIGH' || a.severity === 'CRITICAL' ? ['EMAIL', 'PUSH', 'IN_APP'] : ['IN_APP', 'EMAIL'], dedupeKey: `secalert:${row.id}:${id}` });
      }
      return row;
    } catch (e) {
      this.log.warn(`security alert not raised: ${(e as Error).message}`);
      return null;
    }
  }

  async recordLogin(e: { userId?: string | null; email?: string | null; outcome: 'SUCCESS' | 'FAILURE' | 'LOCKED' | 'BLOCKED' | 'MFA_FAILURE'; method?: string; reason?: string | null; ip?: string | null; userAgent?: string | null; suspicious?: boolean }) {
    await this.db
      .insert(loginEvents)
      .values({ userId: e.userId ?? null, email: e.email?.toLowerCase() ?? null, outcome: e.outcome, method: e.method || 'pwd', reason: e.reason ?? null, ip: e.ip ?? null, userAgent: e.userAgent?.slice(0, 300) ?? null, suspicious: !!e.suspicious })
      .catch((err) => this.log.warn(`login event not recorded: ${(err as Error).message}`));
  }

  /** A staff sign-in from an IP this account has not used successfully in 30 days (and it has signed in before). */
  async isNewIp(userId: string, ip: string | null | undefined) {
    if (!ip) return false;
    const since = new Date(Date.now() - 30 * 86400_000);
    const [prior] = await this.db.select({ n: sql<number>`count(*)::int`, same: sql<number>`count(*) filter (where ${loginEvents.ip} = ${ip})::int` }).from(loginEvents).where(and(eq(loginEvents.userId, userId), eq(loginEvents.outcome, 'SUCCESS'), gt(loginEvents.createdAt, since)));
    return prior.n > 0 && prior.same === 0;
  }

  async recentLogins(userId: string, limit = 20) {
    return this.db.select().from(loginEvents).where(eq(loginEvents.userId, userId)).orderBy(desc(loginEvents.createdAt)).limit(limit);
  }
}
