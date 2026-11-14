import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { AuthResponse } from '@gutad/shared';
import { api, session } from './api';

/**
 * 2.4c-M SSO sign-in on mobile: OpenID Connect in the system browser. The API starts the flow with the app's deep
 * link as `returnTo` and hands back a one-time verifier; the identity provider (directly, or through the web
 * callback) returns code + state to the deep link, and the app redeems them together with the verifier.
 */
const PENDING = 'gutad.sso.pending';
const inflight = new Map<string, Promise<AuthResponse>>();

export const ssoReturnUrl = () => Linking.createURL('auth/sso');

/** Redeem code + state once (the auth-session result and the deep-link route can both deliver them). */
export async function finishSso(code: string, state: string): Promise<AuthResponse> {
  const existing = inflight.get(state);
  if (existing) return existing;
  const p = (async () => {
    const raw = await AsyncStorage.getItem(PENDING);
    const pending = raw ? (JSON.parse(raw) as { state: string; verifier: string }) : null;
    if (!pending || pending.state !== state) throw new Error('This sign-in was not started on this device. Start again.');
    const r = await api.post<AuthResponse>('/auth/sso/callback', { code, state, verifier: pending.verifier });
    await AsyncStorage.removeItem(PENDING);
    await session.set(r);
    return r;
  })();
  inflight.set(state, p);
  p.catch(() => inflight.delete(state));
  return p;
}

/** Runs the whole flow; resolves with the session, or null when the user closed the browser. */
export async function signInWithSso(): Promise<AuthResponse | null> {
  const returnTo = ssoReturnUrl();
  const start = await api.post<{ url: string; state?: string; verifier?: string }>('/auth/sso/start', { returnTo });
  if (!start.state || !start.verifier) throw new Error('Single sign-on is not available for the app');
  await AsyncStorage.setItem(PENDING, JSON.stringify({ state: start.state, verifier: start.verifier }));
  const r = await WebBrowser.openAuthSessionAsync(start.url, returnTo);
  if (r.type !== 'success') return null;
  const q = Linking.parse(r.url).queryParams || {};
  if (q.error) throw new Error(String(q.error_description || q.error));
  if (!q.code || !q.state) throw new Error('Missing sign-in response');
  return finishSso(String(q.code), String(q.state));
}
