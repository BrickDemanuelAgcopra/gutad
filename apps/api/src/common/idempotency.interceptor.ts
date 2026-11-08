import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import type { Response } from 'express';
import { DB, Db } from '../db/db.module';
import { idempotencyRecords } from '../db/schema';
import type { AuthedRequest } from './auth';

/**
 * Every side-effecting endpoint accepts an `Idempotency-Key` header.
 * A repeated key within the same scope (user + route) replays the stored response instead of re-executing.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next.handle();
    const key = req.header('Idempotency-Key');
    if (!key) return next.handle();
    const scope = `${req.user?.sub || req.ip}:${req.method}:${req.path}`;
    const fullKey = `${scope}:${key}`;

    return from(this.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, fullKey)).limit(1)).pipe(
      switchMap((rows) => {
        if (rows.length) {
          const rec = rows[0];
          if (rec.scope !== scope) throw new ConflictException('Idempotency key reused across scopes');
          res.status(rec.responseCode);
          res.setHeader('Idempotent-Replayed', 'true');
          return of(rec.response);
        }
        return next.handle().pipe(
          tap((body) => {
            void this.db
              .insert(idempotencyRecords)
              .values({ key: fullKey, scope, responseCode: res.statusCode || 200, response: body ?? null })
              .onConflictDoNothing()
              .catch(() => undefined);
          }),
        );
      }),
    );
  }
}
