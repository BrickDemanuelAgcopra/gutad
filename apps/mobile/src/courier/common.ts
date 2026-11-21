import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { GutadApiError, type CheckStatus, type EligibilityCheck, type EquipmentItem, type Manifest, type OnboardingStepKey, type Readiness } from '@gutad/shared';

/** Courier Release 1 shapes, as in docs/COURIER-R1-PLAN.md. */
export interface Onboarding {
  driver: { id: string; applicationStatus: string; lifecycleStatus: string | null; status: string; vehicleType: string; decisionNote: string | null; submittedAt: string | null; firstDeliveryAt: string | null } | null;
  steps: { key: OnboardingStepKey; label: string; done: boolean; needsAction: boolean; note?: string }[];
  checks: { check: EligibilityCheck; status: CheckStatus; note: string | null; expiresAt: string | null }[];
  data: {
    location?: { country?: string; city?: string; zoneIds?: string[]; transport?: string };
    profile?: { legalName?: string; addressLine1?: string; city?: string; postalCode?: string; phone?: string; languages?: string[]; photoUrl?: string };
    vehicle?: { make?: string; model?: string; plate?: string; color?: string; year?: number };
    screening?: { consentVersion: string; consentedAt: string };
    payout?: { method: string; accountLast4: string; taxFormAcceptedAt: string };
    agreement?: { version: string; acceptedAt: string };
    training?: Record<string, string>;
    equipment?: { items: EquipmentItem[]; photoUrl?: string };
  };
  requiredDocs: string[];
  documents: { id: string; kind: string; status: string; expiresAt: string | null; reviewNote: string | null }[];
  availability?: { serviceable: boolean; waitlist: boolean; message: string };
  canSubmit: boolean;
  missing: string[];
}

export interface DriverStatus {
  dispatchable: boolean; reasons: string[]; isAvailable: boolean; mode: 'ON_DEMAND' | 'RESERVED'; onBreak: boolean; finishAfterCurrent: boolean; onlineSince: string | null; activeJobs: number; firstDeliveryAt: string | null; lifecycleStatus: string; applicationStatus: string;
  today: { onlineMinutes: number; breakMinutes: number; activeMinutes: number; waitingMinutes: number; deliveries: number; earningsCents: number };
}

export interface Offer {
  id: string; deliveryJobId: string; expiresAt: string; payCents: number; pay: { baseCents: number; distanceCents: number; timeCents: number; totalCents: number }; tipCents: number;
  stops: number; pickup: { name: string; line1: string; city: string }; dropoffArea: { city: string; postalCode: string }; distanceKm: number; toPickupKm: number; estMinutes: number;
  requirements: string[]; equipment: string[]; policy: { version: number; waitingGraceMinutes: number; waitingPerMinuteCents: number; returnCents: number; cancelAfterArrivalCents: number; waitingCapMinutes?: number; dropoffGraceMinutes?: number }; batchWith: string | null;
  /** Courier R2 */
  readiness?: Readiness | null; manifest?: Manifest | null; market?: { id: string; name: string } | null;
}

export interface Addr { line1: string; city: string; lat?: number; lng?: number; instructions?: string }
export interface Job {
  id: string; status: string; pickupAddress: Addr; dropoffAddress: Addr; tipCents: number; providerCostCents: number; batchId: string | null; arrivedPickupAt: string | null; arrivedDropoffAt: string | null; requirements: string[];
  exception: { kind: string; attempts: unknown[]; waitUntil: string; resolution?: string } | null;
  pickupCheck?: { orderCode?: string; bagCount: number; drinkCount?: number; sealIntact: boolean; note?: string } | null;
  custody?: unknown; payPolicy?: unknown; issues?: { kind: string; note?: string; at?: string; createdAt?: string; outcome?: string }[] | null;
  requiresIdCheck?: boolean; pinRequired?: boolean; orderCode?: string | null;
  /** Courier R2 */
  readiness?: Readiness | null; manifest?: Manifest | null; shelfSlot?: string | null;
}

/** The API's machine-readable error code (e.g. PIN_MISMATCH), if any. */
export function errCode(e: unknown): string | null {
  if (e instanceof GutadApiError) return ((e.body as unknown as { code?: string } | null)?.code) || (typeof e.body?.message === 'string' && /^[A-Z_]+$/.test(e.body.message) ? e.body.message : null);
  return null;
}
export function errBody<T>(e: unknown): T | null {
  return e instanceof GutadApiError ? (e.body as unknown as T) : null;
}
/** True when the request never got an HTTP answer (offline, DNS, timeout). */
export const isNetworkError = (e: unknown) => !(e instanceof GutadApiError) && (e instanceof TypeError || /network|fetch|timeout|offline/i.test(String((e as Error)?.message || '')));

export const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** "Ready now" / "Ready ~18:40" / "Being prepared" for the readiness chip. */
export function readyText(r: Readiness | null | undefined): { text: string; tone: 'good' | 'warn' | 'neutral' } | null {
  if (!r) return null;
  if (r.status === 'READY') return { text: 'Ready now', tone: 'good' };
  return r.estReadyAt ? { text: `Ready ~${hhmm(r.estReadyAt)}`, tone: 'warn' } : { text: 'Being prepared', tone: 'neutral' };
}
export const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ');

export async function currentPos(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({});
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return null;
  }
}

/** Seconds left until `iso`, ticking every second. */
export function useCountdown(iso: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
}

export const checkTone = (st: string): 'good' | 'warn' | 'bad' | 'neutral' | 'info' => (st === 'PASSED' ? 'good' : st === 'PENDING' ? 'warn' : ['FAILED', 'EXPIRED', 'NEEDS_ACTION'].includes(st) ? 'bad' : 'neutral');
