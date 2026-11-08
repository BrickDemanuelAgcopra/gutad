import type { ApiError } from './types';

export interface ClientOptions {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export class GutadApiError extends Error {
  constructor(public status: number, public body: ApiError | null) {
    super(
      Array.isArray(body?.message) ? body!.message.join('; ') : body?.message || `HTTP ${status}`,
    );
  }
}

/**
 * Minimal isomorphic API client (works in Next.js server components, browsers and React Native).
 * Every mutating call accepts an idempotency key so retries never double-submit.
 */
export class GutadClient {
  constructor(private readonly opts: ClientOptions) {}

  private async headers(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(extra || {}) };
    const token = this.opts.getToken ? await this.opts.getToken() : null;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options?: { idempotencyKey?: string; headers?: Record<string, string> },
  ): Promise<T> {
    const f = this.opts.fetchImpl || fetch;
    const headers = await this.headers(options?.headers);
    if (options?.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const res = await f(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && this.opts.onUnauthorized) this.opts.onUnauthorized();
    if (!res.ok) {
      let parsed: ApiError | null = null;
      try {
        parsed = (await res.json()) as ApiError;
      } catch {
        parsed = null;
      }
      throw new GutadApiError(res.status, parsed);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, headers?: Record<string, string>) {
    return this.request<T>('GET', path, undefined, { headers });
  }
  post<T>(path: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>('POST', path, body, { idempotencyKey });
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>('PATCH', path, body, { idempotencyKey });
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

export function newIdempotencyKey(): string {
  // RFC4122-ish v4 without relying on crypto availability in every runtime
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
