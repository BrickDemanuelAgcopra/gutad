/** Delivery areas, couriers and dispatch contracts shared by API, web and mobile (Phase G). */

export const VEHICLE_TYPES = ['BIKE', 'EBIKE', 'SCOOTER', 'CAR', 'VAN', 'WALK'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const COURIER_CAPABILITIES = ['ALCOHOL', 'LARGE_ORDER', 'COLD_BAG', 'HOT_BAG'] as const;
export type CourierCapability = (typeof COURIER_CAPABILITIES)[number];
/** Capabilities a job can require outright; COLD_BAG / HOT_BAG only improve a courier's score. */
export const HARD_REQUIREMENTS: CourierCapability[] = ['ALCOHOL', 'LARGE_ORDER'];

export const COURIER_DOC_KINDS = ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK', 'VEHICLE_REGISTRATION', 'ID'] as const;
export type CourierDocKind = (typeof COURIER_DOC_KINDS)[number];
export const COURIER_DOC_LABELS: Record<CourierDocKind, string> = { LICENSE: 'Driving license', INSURANCE: 'Insurance', BACKGROUND_CHECK: 'Background check', VEHICLE_REGISTRATION: 'Vehicle registration', ID: 'Photo ID' };
/** Documents a courier needs approved (and unexpired) before approval and to go online. */
export const REQUIRED_COURIER_DOCS: CourierDocKind[] = ['LICENSE', 'INSURANCE', 'BACKGROUND_CHECK'];

export const DELIVERY_EXCEPTION_KINDS = ['CUSTOMER_UNREACHABLE', 'WRONG_ADDRESS', 'ACCESS_PROBLEM', 'UNSAFE_LOCATION'] as const;
export type DeliveryExceptionKind = (typeof DELIVERY_EXCEPTION_KINDS)[number];
export const DELIVERY_EXCEPTION_RESOLUTIONS = ['RETURN', 'DISPOSE', 'SAFE_PLACE'] as const;

export const RESTRICTION_KINDS = ['PAUSE', 'SHRINK_RADIUS', 'ADD_MINUTES'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

/** Setting `delivery.dispatch`. */
export interface DispatchConfig { offerSeconds: number; offersPerRound: number; maxOfferRounds: number; radiusKm: number; waitMinutes: number; proofRetentionDays: number; docExpiryWarnDays: number; travelMinutesPerKm: number }
export const DEFAULT_DISPATCH: DispatchConfig = { offerSeconds: 90, offersPerRound: 3, maxOfferRounds: 3, radiusKm: 12, waitMinutes: 5, proofRetentionDays: 90, docExpiryWarnDays: 30, travelMinutesPerKm: 3 };

/** Setting `delivery.batching` (17.4). */
export interface BatchingConfig {
  enabled: boolean; maxOrders: number; readyWindowMinutes: number; maxBearingDiff: number; maxExtraMinutes: number;
  /** Courier R2 — false: a job needing a cold bag is never batched with one needing a hot bag */
  allowMixedTemperature: boolean;
  /** jobs with any of these requirements are never batched */
  excludeRequirements: string[];
  /** max distance between the dropoffs of batched jobs */
  maxDropoffSpreadKm: number;
}
export const DEFAULT_BATCHING: BatchingConfig = { enabled: true, maxOrders: 2, readyWindowMinutes: 10, maxBearingDiff: 45, maxExtraMinutes: 15, allowMixedTemperature: true, excludeRequirements: ['ALCOHOL'], maxDropoffSpreadKm: 3 };

/** Courier R2 setting `delivery.readySync`: kitchen readiness drives when own-fleet offers go out. */
export interface ReadySyncConfig {
  enabled: boolean;
  /** offers go out this long before a courier must leave for the pickup */
  offerLeadMinutes: number;
  /** typical travel to the pickup used to time the offer */
  pickupTravelMinutes: number;
  /** a partner's pickup time is updated when the estimate moves at least this much */
  resyncMinutes: number;
  /** estimate used when an order has no promise time */
  defaultPrepMinutes: number;
}
export const DEFAULT_READY_SYNC: ReadySyncConfig = { enabled: true, offerLeadMinutes: 5, pickupTravelMinutes: 8, resyncMinutes: 3, defaultPrepMinutes: 15 };

/** Courier R2 multi-brand manifest: what the courier collects, per brand. `brandKey` is the brand id or `location:<id>`. */
export interface ManifestBrand { brandKey: string; brandName: string; orderId: string; orderNumber: string; items: { name: string; quantity: number; handling: string[] }[]; bagCount: number; bagCodes: string[] }
export interface Manifest { brands: ManifestBrand[]; totals: { items: number; bags: number }; handling: string[]; hasAlcohol: boolean }
export interface Readiness { status: 'PREPARING' | 'READY'; estReadyAt: string | null; readyAt: string | null }

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Compass bearing from a to b in degrees (0–360). */
export function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export const bearingDiff = (x: number, y: number) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };

/** Web Mercator: world pixel coordinates at a zoom level (256-px tiles), for the tile maps on web and mobile. */
export function project(lat: number, lng: number, zoom: number) {
  const s = 256 * 2 ** zoom;
  const sin = Math.sin(rad(Math.max(-85, Math.min(85, lat))));
  return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}
export function unproject(x: number, y: number, zoom: number) {
  const s = 256 * 2 ** zoom;
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng };
}
/** OpenStreetMap raster tile URL (attribution "© OpenStreetMap contributors" required where shown). */
export const osmTile = (x: number, y: number, z: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
