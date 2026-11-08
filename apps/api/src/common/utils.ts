import { randomBytes, randomInt } from 'node:crypto';

const ALPHANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export function shortCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHANUM[randomInt(ALPHANUM.length)];
  return s;
}

export function orderNumber(prefix = 'G'): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear().toString().slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}${ymd}-${shortCode(5)}`;
}

export function invoiceNumber(kind: string): string {
  return `INV-${kind.slice(0, 3).toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${shortCode(4)}`;
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function bps(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Ray-casting point-in-polygon for a GeoJSON Polygon ([[[lng,lat],...]]). */
export function pointInPolygon(lng: number, lat: number, polygon: { coordinates: number[][][] }): boolean {
  const ring = polygon.coordinates?.[0] || [];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Local wall-clock parts for a timezone. */
export function localParts(d: Date, timeZone: string): { dayOfWeek: number; hhmm: string; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    dayOfWeek: days.indexOf(parts.weekday),
    hhmm: `${hour}:${parts.minute}`,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Convert "YYYY-MM-DD" + "HH:MM" in a timezone to a UTC Date (handles DST by iterative offset). */
export function zonedTimeToUtc(ymd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetFor = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    const [py, pm, pd] = p.ymd.split('-').map(Number);
    const [ph, pmin] = p.hhmm.split(':').map(Number);
    return Date.UTC(py, pm - 1, pd, ph, pmin) - t;
  };
  let t = guess - offsetFor(guess);
  t = guess - offsetFor(t);
  return new Date(t);
}

export function isWithin(hhmm: string, opens: string, closes: string): boolean {
  if (closes <= opens) return hhmm >= opens || hhmm < closes; // overnight
  return hhmm >= opens && hhmm < closes;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function nonNull<T>(v: T | null | undefined, msg = 'Not found'): T {
  if (v === null || v === undefined) throw new Error(msg);
  return v;
}
