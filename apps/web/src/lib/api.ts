'use client';
import { GutadClient, newIdempotencyKey } from '@gutad/shared';
import type { AuthResponse, AuthUser } from '@gutad/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'gutad.token';
const REFRESH_KEY = 'gutad.refresh';
const USER_KEY = 'gutad.user';

export const session = {
  token: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  user: (): AuthUser | null => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  },
  set(a: AuthResponse) {
    localStorage.setItem(TOKEN_KEY, a.accessToken);
    localStorage.setItem(REFRESH_KEY, a.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(a.user));
    window.dispatchEvent(new Event('gutad:auth'));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new Event('gutad:auth'));
  },
};

export async function refreshSession() {
  const refresh = typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
  if (!refresh) return;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) });
    if (res.ok) session.set((await res.json()) as AuthResponse);
    else session.clear();
  } catch {
    session.clear();
  }
}

/** 10.4-D a random id this browser keeps, sent on sign-in calls as a duplicate-account signal. */
const DEVICE_KEY = 'gutad.device';
export function deviceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  } catch {
    return null;
  }
}

export const api = new GutadClient({
  baseUrl: API_URL,
  getToken: () => session.token(),
  onUnauthorized: refreshSession,
  extraHeaders: (path): Record<string, string> => { const d = path.startsWith('/auth/') ? deviceId() : null; return d ? { 'X-Device-Id': d, 'X-Client': 'web' } : {}; },
});

export { newIdempotencyKey };

export const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);
export const when = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const ago = (d?: string | Date | null) => {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/** Multipart upload with the session token (the JSON client cannot send files). */
export async function uploadFile<T>(path: string, form: FormData): Promise<T> {
  const send = () => fetch(`${API_URL}${path}`, { method: 'POST', headers: session.token() ? { Authorization: `Bearer ${session.token()}` } : {}, body: form });
  let res = await send();
  if (res.status === 401) {
    await refreshSession();
    res = await send();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { message?: string }).message || `Upload failed (${res.status})`);
  return body as T;
}

/** Download an authenticated file and hand it to the browser. */
export async function downloadFile(path: string, fileName: string) {
  const res = await fetch(`${API_URL}${path}`, { headers: session.token() ? { Authorization: `Bearer ${session.token()}` } : {} });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
