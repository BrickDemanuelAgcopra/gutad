'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { STAFF_ROLES, type AuthUser } from '@gutad/shared';
import { api, session } from './api';

/** Fetch helper with loading/error state and optional polling. */
export function useApi<T>(path: string | null, opts?: { poll?: number; deps?: unknown[] }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;
  const load = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const d = await api.get<T>(pathRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(!!path);
    void load();
    if (!opts?.poll || !path) return;
    const t = setInterval(load, opts.poll);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts?.poll, ...(opts?.deps || [])]);
  return { data, error, loading, reload: load, setData };
}

export function useSession() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => setUser(session.user());
    sync();
    setReady(true);
    window.addEventListener('gutad:auth', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('gutad:auth', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const isMerchant = !!user && (user.merchantIds.length > 0 || user.roles.includes('PLATFORM_ADMIN'));
  const perms = user?.permissions || [];
  const isStaff = !!user && (user.staff === true || user.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r)) || !!user.elevated);
  const isAdmin = isStaff && (perms.length > 0 || !!user?.mfaSetupRequired || user.roles.includes('PLATFORM_ADMIN'));
  const can = (p: string) => perms.includes(p);
  return { user, ready, isMerchant, isAdmin, isStaff, can, logout: () => session.clear() };
}

/** Generic mutation wrapper that surfaces errors as strings. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/** Same-tab subscribers per key: every component using a key sees each write (the header's cart badge and checkout share one cart). */
const localSubs = new Map<string, Set<(v: unknown) => void>>();

export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  // this instance's subscriber (stable), so a write isn't echoed back to the component that made it
  const sub = useRef<(v: unknown) => void>((nv: unknown) => setV(nv as T)).current;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
    const subs = localSubs.get(key) || new Set();
    subs.add(sub);
    localSubs.set(key, subs);
    // other tabs
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      try { setV(e.newValue ? (JSON.parse(e.newValue) as T) : initial); } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => { subs.delete(sub); window.removeEventListener('storage', onStorage); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback(
    (nv: T | ((p: T) => T)) => {
      setV((p) => {
        const next = typeof nv === 'function' ? (nv as (p: T) => T)(p) : nv;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        // tell the other components using this key, after this render pass
        queueMicrotask(() => localSubs.get(key)?.forEach((fn) => { if (fn !== sub) fn(next); }));
        return next;
      });
    },
    [key, sub],
  );
  return [v, set];
}
