/**
 * 23.8-V equipment vendor adapters for automated kitchens. They only READ from the vendor (status pulls) and normalize
 * pushed events; there is deliberately no method that sends commands, settings or recipes to a machine.
 */
export interface VendorEvent { id?: string; kind: 'TELEMETRY' | 'MAINTENANCE' | 'FAULT' | 'STATUS'; code?: string; severity?: 'INFO' | 'LOW' | 'HIGH' | 'CRITICAL'; message?: string; metrics?: Record<string, number>; at?: string; softwareVersion?: string; status?: 'OK' | 'DEGRADED' | 'DOWN' | 'OFFLINE' }
export interface VendorStatus { status: 'OK' | 'DEGRADED' | 'DOWN' | 'OFFLINE'; softwareVersion?: string; metrics?: Record<string, number>; events?: VendorEvent[] }
export interface VendorContext { externalId: string; credentials: { accessToken?: string; apiKey?: string; [k: string]: unknown }; config: Record<string, unknown> }
export interface EquipmentVendorAdapter {
  readonly vendor: 'MOCK' | 'GENERIC' | 'RATIONAL' | 'WELBILT';
  readonly canPull: boolean;
  /** read-only status / telemetry / event pull */
  pullStatus(ctx: VendorContext): Promise<VendorStatus>;
}

async function get(url: string, headers: Record<string, string>, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(t);
  }
}

const sev = (s: unknown): VendorEvent['severity'] => { const v = String(s ?? '').toUpperCase(); return v === 'CRITICAL' || v === 'ERROR_CRITICAL' ? 'CRITICAL' : v === 'HIGH' || v === 'ERROR' ? 'HIGH' : v === 'LOW' || v === 'WARNING' ? 'LOW' : 'INFO'; };

/** Deterministic vendor for tests: status/metrics/events come from the link config (`mockStatus`, `mockMetrics`, `mockEvents`, `mockFail`). */
export class MockEquipmentVendor implements EquipmentVendorAdapter {
  readonly vendor = 'MOCK' as const;
  readonly canPull = true;
  async pullStatus(ctx: VendorContext): Promise<VendorStatus> {
    if (ctx.config.mockFail === true) throw new Error('Mock vendor unreachable (mockFail)');
    return { status: (ctx.config.mockStatus as VendorStatus['status']) || 'OK', softwareVersion: ctx.config.mockSoftwareVersion as string | undefined, metrics: (ctx.config.mockMetrics as Record<string, number>) || undefined, events: (ctx.config.mockEvents as VendorEvent[]) || [] };
  }
}

/** Push-only feed: the vendor (or a gateway) posts events; nothing is pulled. */
export class GenericEquipmentVendor implements EquipmentVendorAdapter {
  readonly vendor = 'GENERIC' as const;
  readonly canPull = false;
  async pullStatus(): Promise<VendorStatus> { throw new Error('This vendor link is push-only'); }
}

/** Rational ConnectedCooking: unit status and recent HACCP / error messages (read-only API). */
export class RationalEquipmentVendor implements EquipmentVendorAdapter {
  readonly vendor = 'RATIONAL' as const;
  readonly canPull = true;
  async pullStatus(ctx: VendorContext): Promise<VendorStatus> {
    if (!ctx.credentials.accessToken) throw new Error('ConnectedCooking access token missing');
    const base = (ctx.config.baseUrl as string) || process.env.RATIONAL_API_URL || 'https://www.connectedcooking.com/api';
    const j = await get(`${base}/units/${encodeURIComponent(ctx.externalId)}`, { Authorization: `Bearer ${ctx.credentials.accessToken}` });
    const errors = (j.errors as { code?: string; text?: string; severity?: string; timestamp?: string; id?: string }[] | undefined) || [];
    const online = j.online !== false;
    return { status: !online ? 'OFFLINE' : errors.some((e) => sev(e.severity) === 'CRITICAL') ? 'DOWN' : errors.length ? 'DEGRADED' : 'OK', softwareVersion: (j.softwareVersion as string) || undefined, metrics: typeof j.cabinetTemperature === 'number' ? { cabinetTemperatureC: j.cabinetTemperature as number } : undefined, events: errors.map((e) => ({ id: e.id || `${e.code}:${e.timestamp}`, kind: 'FAULT' as const, code: e.code, message: e.text, severity: sev(e.severity), at: e.timestamp })) };
  }
}

/** Welbilt KitchenConnect: asset status, telemetry and service events (read-only API). */
export class WelbiltEquipmentVendor implements EquipmentVendorAdapter {
  readonly vendor = 'WELBILT' as const;
  readonly canPull = true;
  async pullStatus(ctx: VendorContext): Promise<VendorStatus> {
    if (!ctx.credentials.apiKey) throw new Error('KitchenConnect API key missing');
    const base = (ctx.config.baseUrl as string) || process.env.WELBILT_API_URL || 'https://api.kitchenconnect.welbilt.com';
    const j = await get(`${base}/v1/assets/${encodeURIComponent(ctx.externalId)}/status`, { 'x-api-key': String(ctx.credentials.apiKey) });
    const alarms = (j.alarms as { id?: string; code?: string; description?: string; severity?: string; raisedAt?: string }[] | undefined) || [];
    const service = (j.serviceEvents as { id?: string; type?: string; description?: string; at?: string }[] | undefined) || [];
    const state = String(j.state ?? 'OK').toUpperCase();
    return { status: state === 'OFFLINE' ? 'OFFLINE' : state === 'FAULT' ? 'DOWN' : alarms.length ? 'DEGRADED' : 'OK', softwareVersion: (j.firmware as string) || undefined, metrics: (j.telemetry as Record<string, number>) || undefined, events: [...alarms.map((a) => ({ id: a.id, kind: 'FAULT' as const, code: a.code, message: a.description, severity: sev(a.severity), at: a.raisedAt })), ...service.map((s) => ({ id: s.id, kind: 'MAINTENANCE' as const, code: s.type, message: s.description, at: s.at }))] };
  }
}

const adapters: Record<string, EquipmentVendorAdapter> = { MOCK: new MockEquipmentVendor(), GENERIC: new GenericEquipmentVendor(), RATIONAL: new RationalEquipmentVendor(), WELBILT: new WelbiltEquipmentVendor() };
export const equipmentVendor = (v: string) => adapters[v] ?? null;
export const setEquipmentVendor = (v: string, a: EquipmentVendorAdapter) => { adapters[v] = a; };
