'use client';
import { useCallback, useEffect, useState } from 'react';
import { GutadApiError } from '@gutad/shared';
import { api } from './api';
import { useApi } from './hooks';

const read = <T,>(key: string): T | null => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/**
 * 13.8 degraded mode: polls like useApi, keeps the last good response on the device and serves it
 * (flagged `offline`) while the API cannot be reached.
 */
export function useCachedApi<T>(key: string, path: string | null, poll = 4000) {
  const r = useApi<T>(path, { poll, deps: [path] });
  const [cached, setCached] = useState<{ at: string; data: T } | null>(null);
  useEffect(() => { setCached(read(key)); }, [key]);
  useEffect(() => {
    if (!r.data) return;
    const c = { at: new Date().toISOString(), data: r.data };
    setCached(c);
    write(key, c);
  }, [key, r.data]);
  return { ...r, data: r.data ?? cached?.data ?? null, offline: !!r.error && /fetch|network|load failed|timed? ?out|ECONN/i.test(r.error), cachedAt: cached?.at ?? null };
}

interface Pending { id: string; path: string; body: unknown; at: string }
const QKEY = 'gutad.kds.pending';

/**
 * 13.8 manual mode: kitchen actions taken while offline are kept on the device and replayed
 * in order once the API is reachable again. Server-side checks still apply on replay.
 */
export function useOfflineActions(onFlushed?: () => void) {
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => { setPending(read<Pending[]>(QKEY) || []); }, []);
  const save = (p: Pending[]) => { setPending(p); write(QKEY, p); };
  const post = useCallback(async (path: string, body: unknown = {}) => {
    try {
      return await api.post(path, body);
    } catch (e) {
      if (e instanceof GutadApiError) throw e; // the server answered: a real error
      const p = [...(read<Pending[]>(QKEY) || []), { id: globalThis.crypto.randomUUID(), path, body, at: new Date().toISOString() }];
      save(p);
      return null;
    }
  }, []);
  const flush = useCallback(async () => {
    let q = read<Pending[]>(QKEY) || [];
    if (!q.length) return;
    while (q.length) {
      try { await api.post(q[0].path, q[0].body); } catch (e) { if (!(e instanceof GutadApiError)) break; /* rejected on replay: drop it */ }
      q = q.slice(1);
      save(q);
    }
    onFlushed?.();
  }, [onFlushed]);
  useEffect(() => { const t = setInterval(() => void flush(), 10_000); return () => clearInterval(t); }, [flush]);
  return { post, pending, flush };
}
