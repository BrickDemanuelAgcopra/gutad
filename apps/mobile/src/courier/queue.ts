import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GutadApiError } from '@gutad/shared';
import { api, newIdempotencyKey } from '../api';
import { isNetworkError } from './common';

/**
 * Offline resilience for trip actions (arrived / transition / issue): when the phone has no connection the action is
 * kept in a local queue and sent again on the next poll or when the app comes back to the foreground. Each item keeps
 * its idempotency key so a retry never applies twice. HTTP errors (4xx) are never queued: the courier sees them.
 */
const KEY = 'gutad.courier.queue';
export interface QueuedAction { id: string; path: string; body: unknown; label: string; createdAt: string }

let listeners: ((n: number) => void)[] = [];
let failures: string[] = [];
let flushing = false;

async function read(): Promise<QueuedAction[]> {
  try { const raw = await AsyncStorage.getItem(KEY); return raw ? (JSON.parse(raw) as QueuedAction[]) : []; } catch { return []; }
}
async function write(q: QueuedAction[]) {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l(q.length));
}

/** Send now; on a network failure keep it for later and resolve `{ queued: true }`. */
export async function sendOrQueue<T>(path: string, body: unknown, label: string): Promise<{ queued: true } | { queued: false; result: T }> {
  const id = newIdempotencyKey();
  try {
    return { queued: false, result: await api.post<T>(path, body, id) };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const q = await read();
    q.push({ id, path, body, label, createdAt: new Date().toISOString() });
    await write(q);
    return { queued: true };
  }
}

/** Send what is waiting, oldest first. Stops at the first network failure; drops (and reports) actions the server refuses. */
export async function flushQueue(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let q = await read();
    while (q.length) {
      const item = q[0];
      try {
        await api.post(item.path, item.body, item.id);
        sent++;
      } catch (e) {
        if (isNetworkError(e)) break;
        if (e instanceof GutadApiError && e.status >= 500) break;
        failures = [...failures, `${item.label}: ${(e as Error).message}`];
      }
      q = q.slice(1);
      await write(q);
    }
  } finally {
    flushing = false;
  }
  return sent;
}

/** Number of waiting actions, plus actions the server refused after reconnecting; flushes on foreground. */
export function useQueue(onFlushed?: () => void) {
  const [count, setCount] = useState(0);
  const [refused, setRefused] = useState<string[]>([]);
  useEffect(() => {
    const l = (n: number) => { setCount(n); setRefused(failures); };
    listeners.push(l);
    void read().then((q) => setCount(q.length));
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void flushQueue().then((n) => { if (n) onFlushed?.(); }); });
    return () => { listeners = listeners.filter((x) => x !== l); sub.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const clearRefused = () => { failures = []; setRefused([]); };
  return { count, refused, clearRefused, flush: async () => { const n = await flushQueue(); if (n) onFlushed?.(); return n; } };
}
