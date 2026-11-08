import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { loadConfig } from '../config/config';

/** Shared Redis connection for caches, rate limiting and short-lived locks. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    this.client = new Redis(loadConfig().REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false, enableOfflineQueue: true });
    this.client.on('error', (e) => this.log.warn(`redis: ${e.message}`));
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const v = await this.client.get(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      /* cache is best-effort */
    }
  }

  async del(...keys: string[]) {
    try {
      if (keys.length) await this.client.del(...keys);
    } catch {
      /* ignore */
    }
  }

  /** Simple lock: returns a release function or null if the lock is held. */
  async lock(key: string, ttlMs = 10_000): Promise<(() => Promise<void>) | null> {
    const token = Math.random().toString(36).slice(2);
    const ok = await this.client.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    if (!ok) return null;
    return async () => {
      const v = await this.client.get(`lock:${key}`);
      if (v === token) await this.client.del(`lock:${key}`);
    };
  }

  /** Sliding counter used for merchant order throttles. */
  async incrWindow(key: string, windowSeconds: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSeconds);
    return n;
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }
}
