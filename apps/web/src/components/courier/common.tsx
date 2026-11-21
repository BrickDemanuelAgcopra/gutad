'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '@/lib/api';
import { GutadApiError, type ApplicationStatus, type CheckStatus, type EligibilityCheck, type EquipmentItem, type LifecycleStatus, type OnboardingStepKey } from '@gutad/shared';

/** `GET /driver/onboarding` (also `onboarding` on the admin courier view). */
export interface Onboarding {
  driver: { id: string; applicationStatus: ApplicationStatus; lifecycleStatus: LifecycleStatus | null; status: string; vehicleType: string; decisionNote: string | null; submittedAt: string | null; firstDeliveryAt: string | null } | null;
  steps: { key: OnboardingStepKey; label: string; done: boolean; needsAction: boolean; note?: string }[];
  checks: { check: EligibilityCheck; status: CheckStatus; note: string | null; expiresAt: string | null }[];
  data: {
    location?: { country?: string; city?: string; zoneIds?: string[]; transport?: string };
    profile?: { legalName?: string; addressLine1?: string; city?: string; postalCode?: string; phone?: string; languages?: string[]; photoUrl?: string };
    vehicle?: { make?: string; model?: string; plate?: string; color?: string; year?: number | string };
    screening?: { consentVersion: string; consentedAt: string };
    payout?: { method: string; accountLast4: string; taxFormAcceptedAt: string | null };
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

/** Current position, or a fallback in the demo city when location is unavailable. */
export const getLoc = () => new Promise<{ lat: number; lng: number }>((res) => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return res({ lat: 40.73, lng: -73.99 });
  navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({ lat: 40.73, lng: -73.99 }), { timeout: 8000 });
});

/** Plain-language text for the API error codes couriers can hit. */
const CODE_TEXT: Record<string, string> = {
  PIN_MISMATCH: 'That PIN doesn’t match. Ask the customer to read the PIN from their Gutad order.',
  ID_CHECK_REQUIRED: 'This order has restricted items. Check the customer’s ID and tick “I checked ID”.',
  SEAL_BROKEN: 'The seal is broken, so you can’t take this order. Report “Damaged packaging or broken seal” below.',
  WRONG_ANSWER: 'Not quite. Read the module again and try another answer.',
  ONBOARDING_INCOMPLETE: 'Some steps still need to be finished.',
  AT_CAPACITY: 'You already have as many orders as you can carry.',
  MANIFEST_INCOMPLETE: 'Some brands’ bags are missing. Collect every brand’s bags before you leave.',
};
export const errCode = (e: unknown): string | undefined => (e instanceof GutadApiError ? (e.body as unknown as { code?: string } | null)?.code : undefined);
export const friendlyError = (e: unknown) => {
  const code = errCode(e);
  return (code && CODE_TEXT[code]) || (e as Error).message;
};

/** Like useAction, but turns known error codes into plain language. */
export function useCourierAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(friendlyError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/** Re-renders every `ms` so countdowns stay current. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function checkTone(s?: string): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (s === 'PASSED') return 'good';
  if (s === 'PENDING' || s === 'NEEDS_ACTION') return 'warn';
  if (s === 'FAILED' || s === 'EXPIRED') return 'bad';
  return 'neutral';
}

export function applicationTone(s?: string | null): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (s === 'APPROVED') return 'good';
  if (s === 'SUBMITTED' || s === 'VERIFICATION_PENDING') return 'info';
  if (s === 'NEEDS_ACTION' || s === 'WAITLISTED') return 'warn';
  if (s === 'REJECTED') return 'bad';
  return 'neutral';
}

export function lifecycleTone(s?: string | null): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (s === 'ACTIVE') return 'good';
  if (s === 'RESTRICTED' || s === 'REACTIVATION_PENDING') return 'warn';
  if (s === 'SUSPENDED' || s === 'DEACTIVATED') return 'bad';
  return 'neutral';
}

export const minutes = (m: number | null | undefined) => {
  const v = Math.round(m || 0);
  return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`;
};

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export type PhotoPurpose = 'HANDOFF' | 'SAFE_PLACE' | 'PROFILE' | 'EQUIPMENT' | 'ISSUE';
export interface UploadedPhoto { id: string; url: string; previewUrl: string | null }

/** Take a photo (phones open the rear camera) or choose one; uploads privately and hands back the `/files/<id>` reference. */
export function PhotoCapture({ purpose, label = 'Take photo', value, onChange }: { purpose: PhotoPurpose; label?: string; value: UploadedPhoto | null; onChange: (p: UploadedPhoto | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('purpose', purpose);
      fd.append('file', f, f.name || 'photo.jpg');
      onChange(await uploadFile<UploadedPhoto>('/driver/photos', fd));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="space-y-1">
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-2">
        {value?.previewUrl && <img src={value.previewUrl} alt="Your photo" className="h-16 w-16 rounded object-cover" />}
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium hover:bg-ink-50 disabled:opacity-50">{busy ? 'Uploading…' : value ? 'Retake photo' : label}</button>
        {value && !busy && <button type="button" className="text-xs underline" onClick={() => onChange(null)}>Remove</button>}
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

/** A stored `/files/<id>` photo shown through a short-lived link; external links are shown as they are. */
export function StoredPhoto({ url, alt, className = 'h-16 w-16 rounded object-cover' }: { url?: string | null; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const m = url ? /^\/files\/([0-9a-f-]{36})$/i.exec(url) : null;
    if (!m) { setSrc(url || null); return; }
    let live = true;
    api.get<{ url: string }>(`/files/${m[1]}/link`).then((r) => { if (live) setSrc(r.url); }).catch(() => undefined);
    return () => { live = false; };
  }, [url]);
  return src ? <img src={src} alt={alt} className={className} /> : null;
}
