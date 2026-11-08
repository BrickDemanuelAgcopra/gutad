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

export const api = new GutadClient({
  baseUrl: API_URL,
  getToken: () => session.token(),
  onUnauthorized: async () => {
    const refresh = typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
    if (!refresh) return;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) });
      if (res.ok) session.set((await res.json()) as AuthResponse);
      else session.clear();
    } catch {
      session.clear();
    }
  },
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
