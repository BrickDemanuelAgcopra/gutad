/** 13.7-L auto-throttle for restaurants without a production kitchen (per-location settings; platform defaults in `orders.locationThrottle`). */
export interface LocationThrottle {
  enabled: boolean;
  busyAtOpenOrders: number;
  overloadAtOpenOrders: number;
  busyAtBacklogMinutes: number | null;
  overloadAtBacklogMinutes: number | null;
  parallelOrders: number;
  busyExtraMinutes: number;
}
export const DEFAULT_LOCATION_THROTTLE: LocationThrottle = { enabled: false, busyAtOpenOrders: 8, overloadAtOpenOrders: 14, busyAtBacklogMinutes: null, overloadAtBacklogMinutes: null, parallelOrders: 3, busyExtraMinutes: 10 };

export type LoadLevel = 'NORMAL' | 'BUSY' | 'OVERLOADED';

/** Level for an open-order count and backlog, against the thresholds (no hysteresis: quotes compute it live). */
export function locationLoadLevel(cfg: LocationThrottle, openOrders: number, backlogMinutes: number): LoadLevel {
  if (!cfg.enabled) return 'NORMAL';
  if (openOrders >= cfg.overloadAtOpenOrders || (cfg.overloadAtBacklogMinutes != null && backlogMinutes >= cfg.overloadAtBacklogMinutes)) return 'OVERLOADED';
  if (openOrders >= cfg.busyAtOpenOrders || (cfg.busyAtBacklogMinutes != null && backlogMinutes >= cfg.busyAtBacklogMinutes)) return 'BUSY';
  return 'NORMAL';
}

/** 13.8-P printers */
export const PRINTER_PROTOCOLS = ['LOG', 'RAW_TCP'] as const;
export type PrinterProtocol = (typeof PRINTER_PROTOCOLS)[number];
export const PRINTER_ROLES = ['TICKETS', 'LABELS', 'BOTH'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];
export const PRINT_JOB_KINDS = ['STATION_TICKET', 'BAG_LABEL', 'TEST'] as const;
export type PrintJobStatus = 'QUEUED' | 'PRINTING' | 'PRINTED' | 'FAILED';

/** 17.1-R live delivery events pushed over server-sent events (`GET /live/delivery`). */
export type LiveDeliveryEvent =
  | { type: 'courier'; driverId: string; lat: number; lng: number; isAvailable?: boolean; jobIds: string[]; locationIds: string[]; at: string }
  | { type: 'job'; jobId: string; orderId: string | null; locationId: string; organizationId: string | null; status: string; fleet: string; provider: string; driverId: string | null; at: string };

/** 15.3-R routing providers (env ROUTING_PROVIDER). */
export const ROUTING_PROVIDERS = ['straight', 'osrm', 'google', 'mapbox'] as const;
