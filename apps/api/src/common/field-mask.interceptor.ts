import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { MASKED_FIELDS } from '@gutad/shared';
import type { AuthedRequest } from './auth';

/**
 * Data-level restrictions: staff without a sensitive-data permission (`field.bank:view`, `field.salary:view`)
 * get those keys masked (null) in every JSON response. Merchant members are judged by their own org role and
 * never masked; superadmins hold every field permission.
 */
@Injectable()
export class FieldMaskInterceptor implements NestInterceptor {
  intercept(c: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = c.switchToHttp().getRequest<AuthedRequest>().user;
    const acl = user?.acl;
    if (!acl?.staff || acl.superadmin || Object.keys(user?.orgs || {}).length) return next.handle();
    const hidden = new Set<string>();
    for (const [field, keys] of Object.entries(MASKED_FIELDS)) if (!acl.fine.includes(`${field}:view`)) keys.forEach((k) => hidden.add(k));
    if (!hidden.size) return next.handle();
    return next.handle().pipe(map((body) => mask(body, hidden, 0)));
  }
}

function mask(v: unknown, hidden: Set<string>, depth: number): unknown {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map((x) => mask(x, hidden, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = hidden.has(k) && x !== null && x !== undefined ? null : mask(x, hidden, depth + 1);
  return out;
}
