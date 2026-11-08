import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db, DbOrTx } from '../db/db.module';
import { notifications, users } from '../db/schema';

export type NotifyChannel = 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP';

export interface NotifyInput {
  userId?: string | null;
  email?: string | null;
  phone?: string | null;
  template: string;
  payload?: Record<string, unknown>;
  kind?: 'TRANSACTIONAL' | 'MARKETING';
  /** stable key to suppress duplicates (e.g. `order.ready:${orderId}`) */
  dedupeKey?: string;
  channels?: NotifyChannel[];
}

/**
 * Queues notifications (one row per channel) in the DB outbox; the worker delivers them.
 * Transactional messages ignore marketing consent; marketing messages require it.
 */
@Injectable()
export class NotifyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async queue(input: NotifyInput, tx: DbOrTx = this.db): Promise<void> {
    const kind = input.kind || 'TRANSACTIONAL';
    let email = input.email ?? null;
    let phone = input.phone ?? null;
    let pushTokens: string[] = [];
    let marketingConsent = false;
    let smsConsent = false;
    if (input.userId) {
      const [u] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
      if (u) {
        email = email || u.email;
        phone = phone || u.phone;
        pushTokens = u.pushTokens;
        marketingConsent = u.marketingConsent;
        smsConsent = u.smsConsent;
      }
    }
    const channels = input.channels || ['EMAIL', 'PUSH', 'IN_APP', ...(phone ? (['SMS'] as NotifyChannel[]) : [])];
    const rows: (typeof notifications.$inferInsert)[] = [];
    for (const channel of channels) {
      let recipient: string | null = null;
      if (channel === 'EMAIL') recipient = email;
      if (channel === 'SMS') recipient = phone;
      if (channel === 'IN_APP') recipient = input.userId ?? null;
      if (channel === 'PUSH') {
        for (const t of pushTokens) rows.push(this.row(input, 'PUSH', t, kind, 'QUEUED'));
        continue;
      }
      if (!recipient) continue;
      let status = 'QUEUED';
      if (kind === 'MARKETING') {
        if (channel === 'EMAIL' && !marketingConsent) status = 'SUPPRESSED';
        if (channel === 'SMS' && !smsConsent) status = 'SUPPRESSED';
      }
      rows.push(this.row(input, channel, recipient, kind, status));
    }
    if (!rows.length) return;
    await tx.insert(notifications).values(rows).onConflictDoNothing({ target: notifications.dedupeKey });
  }

  private row(input: NotifyInput, channel: NotifyChannel, recipient: string, kind: 'TRANSACTIONAL' | 'MARKETING', status: string) {
    return {
      userId: input.userId ?? null,
      recipient,
      channel,
      kind,
      template: input.template,
      payload: input.payload || {},
      dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${channel}:${recipient}` : null,
      status,
    };
  }
}
