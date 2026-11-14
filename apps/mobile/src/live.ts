import { useEffect, useRef, useState } from 'react';
import type { LiveDeliveryEvent } from '@gutad/shared';
import { API_URL, session } from './api';

/**
 * 17.1-R live delivery events (server-sent events from `GET /live/delivery`). React Native has no EventSource, so the
 * stream is read incrementally from an XMLHttpRequest (the approach react-native-sse uses); it reconnects after 10 s
 * when the stream drops. Screens keep a slow poll as a fallback and poll faster while `connected` is false.
 */
export function useLiveDelivery(opts: { locationId?: string | null; enabled?: boolean; onEvent: (ev: LiveDeliveryEvent) => void }) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(opts.onEvent);
  cb.current = opts.onEvent;
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (!enabled || typeof XMLHttpRequest === 'undefined') return;
    let xhr: XMLHttpRequest | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const schedule = () => { setConnected(false); if (!stopped) retry = setTimeout(() => void open(), 10_000); };
    const open = async () => {
      const token = await session.token();
      if (!token || stopped) return;
      const q = `token=${encodeURIComponent(token)}${opts.locationId ? `&locationId=${encodeURIComponent(opts.locationId)}` : ''}`;
      const x = new XMLHttpRequest();
      xhr = x;
      let seen = 0;
      let buf = '';
      let ended = false;
      const end = () => { if (ended) return; ended = true; schedule(); };
      x.open('GET', `${API_URL}/live/delivery?${q}`);
      x.setRequestHeader('Accept', 'text/event-stream');
      x.setRequestHeader('Cache-Control', 'no-cache');
      x.onreadystatechange = () => {
        if (x.readyState !== 3 && x.readyState !== 4) return;
        if (x.status !== 200) { if (x.readyState === 4) end(); return; }
        buf += x.responseText.slice(seen);
        seen = x.responseText.length;
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const block of parts) {
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event === 'ready') setConnected(true);
          else if ((event === 'courier' || event === 'job') && data) { try { cb.current(JSON.parse(data) as LiveDeliveryEvent); } catch { /* ignore */ } }
        }
        if (x.readyState === 4) end();
      };
      x.onerror = () => end();
      x.send();
    };
    void open();
    return () => { stopped = true; if (retry) clearTimeout(retry); xhr?.abort(); setConnected(false); };
  }, [enabled, opts.locationId]);
  return { connected };
}
