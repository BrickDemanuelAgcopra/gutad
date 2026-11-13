import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { platformSettings } from '../db/schema';
import { RedisService } from './redis.service';

/** Read-through cache over `platform_settings` (AdminService clears `setting:<key>` on change). */
@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db, private readonly redis: RedisService) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const cached = await this.redis.getJson<{ v: T }>(`setting:${key}`);
    if (cached) return cached.v ?? fallback;
    const [row] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
    const v = (row?.value as T | undefined) ?? fallback;
    await this.redis.setJson(`setting:${key}`, { v }, 60);
    return v;
  }

  /** Object settings merge over their defaults so new keys keep working. */
  async getObject<T extends object>(key: string, defaults: T): Promise<T> {
    const v = await this.get<Partial<T> | null>(key, null);
    return v && typeof v === 'object' ? { ...defaults, ...v } : defaults;
  }
}
