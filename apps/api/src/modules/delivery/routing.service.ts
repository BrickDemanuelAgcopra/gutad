import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../../config/config';
import { RedisService } from '../../core/redis.service';
import { haversineKm } from '../../common/utils';

export interface Point { lat: number; lng: number }
export interface TravelEstimate { minutes: number; km: number; source: string; cached?: boolean }

/** Travel time between two points by road (or as the crow flies). */
export interface RoutingAdapter {
  readonly name: string;
  /** null when the provider has no answer (the caller falls back to straight-line) */
  route(from: Point, to: Point): Promise<{ minutes: number; km: number } | null>;
}

const TIMEOUT_MS = 2500;
async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`routing HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** OSRM (self-hosted or the public demo): GET {ROUTING_URL}/route/v1/driving/lng,lat;lng,lat */
export class OsrmRouting implements RoutingAdapter {
  readonly name = 'osrm';
  constructor(private readonly baseUrl: string) {}
  async route(a: Point, b: Point) {
    const j = (await getJson(`${this.baseUrl.replace(/\/$/, '')}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`)) as { routes?: { duration: number; distance: number }[] };
    const r = j.routes?.[0];
    return r ? { minutes: r.duration / 60, km: r.distance / 1000 } : null;
  }
}

/** Google Distance Matrix (driving). */
export class GoogleRouting implements RoutingAdapter {
  readonly name = 'google';
  constructor(private readonly key: string) {}
  async route(a: Point, b: Point) {
    const j = (await getJson(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${a.lat},${a.lng}&destinations=${b.lat},${b.lng}&mode=driving&key=${encodeURIComponent(this.key)}`)) as { rows?: { elements?: { status: string; duration?: { value: number }; distance?: { value: number } }[] }[] };
    const e = j.rows?.[0]?.elements?.[0];
    return e && e.status === 'OK' && e.duration && e.distance ? { minutes: e.duration.value / 60, km: e.distance.value / 1000 } : null;
  }
}

/** Mapbox Directions (driving). */
export class MapboxRouting implements RoutingAdapter {
  readonly name = 'mapbox';
  constructor(private readonly token: string) {}
  async route(a: Point, b: Point) {
    const j = (await getJson(`https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&access_token=${encodeURIComponent(this.token)}`)) as { routes?: { duration: number; distance: number }[] };
    const r = j.routes?.[0];
    return r ? { minutes: r.duration / 60, km: r.distance / 1000 } : null;
  }
}

/**
 * 15.3-R travel times. The default is today's estimate (straight-line km × minutes per km for the zone), with no network
 * calls. ROUTING_PROVIDER=osrm (ROUTING_URL), google or mapbox (ROUTING_API_KEY) asks a routing provider for the road
 * travel time; answers are cached (Redis 15 min + memory) and any failure falls back to the straight-line estimate.
 */
@Injectable()
export class RoutingService {
  private readonly log = new Logger(RoutingService.name);
  readonly adapter: RoutingAdapter | null;
  private readonly memo = new Map<string, { v: { minutes: number; km: number }; exp: number }>();
  private stats = { calls: 0, cacheHits: 0, failures: 0 };

  constructor(private readonly redis: RedisService) {
    const cfg = loadConfig();
    this.adapter =
      cfg.ROUTING_PROVIDER === 'osrm' && cfg.ROUTING_URL ? new OsrmRouting(cfg.ROUTING_URL)
      : cfg.ROUTING_PROVIDER === 'google' && cfg.ROUTING_API_KEY ? new GoogleRouting(cfg.ROUTING_API_KEY)
      : cfg.ROUTING_PROVIDER === 'mapbox' && cfg.ROUTING_API_KEY ? new MapboxRouting(cfg.ROUTING_API_KEY)
      : null;
  }

  get providerName() { return this.adapter?.name ?? 'straight'; }

  status() {
    const cfg = loadConfig();
    return { provider: this.providerName, requested: cfg.ROUTING_PROVIDER, configured: !!this.adapter || cfg.ROUTING_PROVIDER === 'straight', ...this.stats };
  }

  straight(from: Point, to: Point, minutesPerKm: number): TravelEstimate {
    const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
    return { minutes: km * minutesPerKm, km, source: 'straight' };
  }

  /** Road travel time from the provider when configured, else straight-line km × minutes per km. */
  async travel(from: Point, to: Point, minutesPerKm: number): Promise<TravelEstimate> {
    if (!this.adapter) return this.straight(from, to, minutesPerKm);
    const r4 = (x: number) => x.toFixed(4);
    const key = `route:${this.adapter.name}:${r4(from.lat)},${r4(from.lng)}:${r4(to.lat)},${r4(to.lng)}`;
    const m = this.memo.get(key);
    if (m && m.exp > Date.now()) { this.stats.cacheHits++; return { ...m.v, source: this.adapter.name, cached: true }; }
    const cached = await this.redis.getJson<{ minutes: number; km: number }>(key);
    if (cached) { this.stats.cacheHits++; this.remember(key, cached); return { ...cached, source: this.adapter.name, cached: true }; }
    try {
      this.stats.calls++;
      const r = await this.adapter.route(from, to);
      if (!r) throw new Error('no route');
      this.remember(key, r);
      await this.redis.setJson(key, r, 900);
      return { ...r, source: this.adapter.name };
    } catch (e) {
      this.stats.failures++;
      this.log.warn(`routing (${this.adapter.name}) failed, using straight-line: ${(e as Error).message}`);
      return this.straight(from, to, minutesPerKm);
    }
  }

  private remember(key: string, v: { minutes: number; km: number }) {
    if (this.memo.size > 5000) this.memo.clear();
    this.memo.set(key, { v, exp: Date.now() + 300_000 });
  }
}
