import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, DbOrTx } from '../db/db.module';
import { auditLogs, configChanges } from '../db/schema';
import { ctx } from '../common/request-context';

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async log(
    input: {
      organizationId?: string | null;
      actorId?: string | null;
      action: string;
      entityType: string;
      entityId: string;
      before?: unknown;
      after?: unknown;
      ip?: string | null;
      reason?: string | null;
    },
    tx: DbOrTx = this.db,
  ) {
    const c = ctx();
    await tx.insert(auditLogs).values({
      organizationId: input.organizationId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: input.ip ?? c?.ip ?? null,
      reason: input.reason ?? c?.reason ?? null,
      requestId: c?.requestId ?? null,
      grantId: c?.grantId ?? null,
    });
  }

  async configChange(
    input: { organizationId?: string | null; key: string; before?: unknown; after?: unknown; actorId?: string | null; approvedById?: string | null },
    tx: DbOrTx = this.db,
  ) {
    await tx.insert(configChanges).values({
      organizationId: input.organizationId ?? null,
      key: input.key,
      before: input.before ?? null,
      after: input.after ?? null,
      actorId: input.actorId ?? null,
      approvedById: input.approvedById ?? null,
    });
  }
}
