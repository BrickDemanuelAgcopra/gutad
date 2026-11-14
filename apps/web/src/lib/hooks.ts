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

export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, [key]);
  const set = useCallback(
    (nv: T | ((p: T) => T)) => {
      setV((p) => {
        const next = typeof nv === 'function' ? (nv as (p: T) => T)(p) : nv;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [v, set];
}
