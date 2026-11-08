import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, DbOrTx } from '../db/db.module';
import { auditLogs, configChanges } from '../db/schema';

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
    },
    tx: DbOrTx = this.db,
  ) {
    await tx.insert(auditLogs).values({
      organizationId: input.organizationId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: input.ip ?? null,
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
