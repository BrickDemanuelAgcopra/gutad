'use client';
import { useEffect, useRef, useState } from 'react';
import type { LiveDeliveryEvent } from '@gutad/shared';
import { API_URL, session } from './api';

/**
 * 17.1-R live delivery updates over server-sent events (`GET /live/delivery`). Returns `connected`; pages keep a slow
 * poll as a fallback and poll faster while the stream is down. EventSource cannot send headers, so the token goes in
 * the query string; when the stream closes (token expiry, deploy) it reconnects with the current token.
 */
export function useLiveDelivery(opts: { locationId?: string | null; enabled?: boolean; onEvent: (ev: LiveDeliveryEvent) => void }) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(opts.onEvent);
  cb.current = opts.onEvent;
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open = () => {
      const token = session.token();
      if (!token || stopped) return;
      const q = new URLSearchParams({ token });
      if (opts.locationId) q.set('locationId', opts.locationId);
      es = new EventSource(`${API_URL}/live/delivery?${q.toString()}`);
      es.addEventListener('ready', () => setConnected(true));
      const handle = (e: MessageEvent) => { try { cb.current(JSON.parse(e.data) as LiveDeliveryEvent); } catch { /* ignore */ } };
      es.addEventListener('courier', handle as EventListener);
      es.addEventListener('job', handle as EventListener);
      es.onerror = () => {
        setConnected(false);
        if (es && es.readyState === EventSource.CLOSED) {
          es = null;
          if (!stopped) retry = setTimeout(open, 10_000);
        }
      };
    };
    open();
    return () => { stopped = true; if (retry) clearTimeout(retry); es?.close(); setConnected(false); };
  }, [enabled, opts.locationId]);
  return { connected };
}

/** Calls `fn` at most once per `ms` (trailing), for refetching after a burst of events. */
export function useDebounced(fn: () => void, ms = 1000) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return () => { if (t.current) return; t.current = setTimeout(() => { t.current = null; f.current(); }, ms); };
}
