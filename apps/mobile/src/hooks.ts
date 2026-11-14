import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STAFF_ROLES, type AuthUser } from '@gutad/shared';
import { api, session } from './api';

export function useApi<T>(path: string | null, opts?: { poll?: number; deps?: unknown[] }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const ref = useRef(path);
  ref.current = path;
  const load = useCallback(async () => {
    if (!ref.current) return;
    try {
      setData(await api.get<T>(ref.current));
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
  return { data, error, loading, reload: load };
}

export function useSession() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => session.user().then((u) => { setUser(u); setReady(true); });
    void sync();
    return session.subscribe(() => void sync());
  }, []);
  const perms = user?.permissions || [];
  const isStaff = !!user && (user.staff === true || user.roles.some((r) => (STAFF_ROLES as readonly string[]).includes(r)) || !!user.elevated);
  const memberRoles = Object.values(user?.memberRoles || {}).flat();
  return {
    user,
    ready,
    isMerchant: !!user && user.merchantIds.length > 0,
    isDriver: !!user && user.roles.includes('DRIVER'),
    isStaff,
    memberRoles,
    can: (p: string) => perms.includes(p),
    logout: () => session.clear(),
  };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
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
  return { busy, error, run };
}

export function useStored<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void, boolean] {
  const [v, setV] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(key).then((raw) => {
      if (raw) setV(JSON.parse(raw) as T);
      setLoaded(true);
    });
  }, [key]);
  const set = useCallback((nv: T | ((p: T) => T)) => setV((p) => { const next = typeof nv === 'function' ? (nv as (p: T) => T)(p) : nv; void AsyncStorage.setItem(key, JSON.stringify(next)); return next; }), [key]);
  return [v, set, loaded];
}
