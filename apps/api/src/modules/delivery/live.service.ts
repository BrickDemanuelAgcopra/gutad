import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import type { LiveDeliveryEvent } from '@gutad/shared';
import { RedisService } from '../../core/redis.service';

const CHANNEL = 'live:delivery';

/**
 * 17.1-R push for the live map. Courier positions and job transitions are published on a Redis channel (so the worker
 * and every API replica share them); each API process subscribes lazily, on its first server-sent-events client.
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly log = new Logger(LiveService.name);
  private readonly emitter = new EventEmitter();
  private sub: Redis | null = null;
  private ready: Promise<void> | null = null;
  private clients = 0;

  constructor(private readonly redis: RedisService) {
    this.emitter.setMaxListeners(0);
  }

  /** Best effort: a Redis hiccup must never fail a courier update or a delivery transition. */
  publish(ev: LiveDeliveryEvent) {
    try {
      void this.redis.client.publish(CHANNEL, JSON.stringify(ev)).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private ensureSubscribed(): Promise<void> {
    if (this.ready) return this.ready;
    const sub = this.redis.client.duplicate();
    sub.on('error', (e) => this.log.warn(`live subscriber: ${e.message}`));
    sub.on('message', (_ch: string, msg: string) => {
      try {
        this.emitter.emit('event', JSON.parse(msg) as LiveDeliveryEvent);
      } catch {
        /* ignore malformed */
      }
    });
    this.sub = sub;
    this.ready = sub.subscribe(CHANNEL).then(() => undefined).catch((e: Error) => this.log.warn(`live subscribe: ${e.message}`));
    return this.ready;
  }

  /** Resolves once the Redis subscription is live (or after 2 s if Redis is slow), so no event published after it is missed. */
  async subscribe(fn: (ev: LiveDeliveryEvent) => void): Promise<() => void> {
    this.clients++;
    this.emitter.on('event', fn);
    await Promise.race([this.ensureSubscribed(), new Promise((r) => setTimeout(r, 2000))]);
    return () => {
      this.clients--;
      this.emitter.off('event', fn);
    };
  }

  get connectedClients() { return this.clients; }

  async onModuleDestroy() {
    if (this.sub) await this.sub.quit().catch(() => undefined);
  }
}
