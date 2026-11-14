import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Per-request facts the audit trail and access checks need without threading them through every call. */
export interface RequestContext {
  requestId: string;
  method: string;
  /** request path without the query string */
  path: string;
  ip: string | null;
  /** set by the auth guard */
  userId?: string;
  /** emergency or support grant in use */
  grantId?: string;
  /** reason supplied with the request (header `X-Audit-Reason` or body `reason`) */
  reason?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers['x-audit-reason'];
  const reason = typeof header === 'string' && header.trim() ? decodeURIComponent(header).slice(0, 500) : undefined;
  requestContext.run({ requestId: (req.headers['x-request-id'] as string) || randomUUID(), method: req.method, path: (req.originalUrl || req.url || '').split('?')[0], ip: req.ip || null, reason }, next);
}

export const ctx = () => requestContext.getStore();
export const isMutatingRequest = () => {
  const m = ctx()?.method;
  return !!m && !['GET', 'HEAD', 'OPTIONS'].includes(m);
};
