import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { GutadClient, newIdempotencyKey } from '@gutad/shared';
import type { AuthResponse, AuthUser } from '@gutad/shared';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl || 'http://localhost:4000';

const TOKEN = 'gutad.token';
const REFRESH = 'gutad.refresh';
const USER = 'gutad.user';

async function secureGet(k: string) {
  if (Platform.OS === 'web') return AsyncStorage.getItem(k);
  return SecureStore.getItemAsync(k);
}
async function secureSet(k: string, v: string | null) {
  if (Platform.OS === 'web') return v === null ? AsyncStorage.removeItem(k) : AsyncStorage.setItem(k, v);
  return v === null ? SecureStore.deleteItemAsync(k) : SecureStore.setItemAsync(k, v);
}

let listeners: (() => void)[] = [];
export const session = {
  token: () => secureGet(TOKEN),
  async user(): Promise<AuthUser | null> {
    const raw = await AsyncStorage.getItem(USER);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  },
  async set(a: AuthResponse) {
    await secureSet(TOKEN, a.accessToken);
    await secureSet(REFRESH, a.refreshToken);
    await AsyncStorage.setItem(USER, JSON.stringify(a.user));
    listeners.forEach((l) => l());
  },
  async clear() {
    await secureSet(TOKEN, null);
    await secureSet(REFRESH, null);
    await AsyncStorage.removeItem(USER);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  },
};

/** 10.4-D a random id this install keeps (secure storage), sent on sign-in calls as a duplicate-account signal. */
const DEVICE = 'gutad.device';
let deviceCache: string | null = null;
export async function deviceId(): Promise<string | null> {
  if (deviceCache) return deviceCache;
  try {
    let d = await secureGet(DEVICE);
    if (!d) {
      d = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9]/g, '');
      await secureSet(DEVICE, d);
    }
    deviceCache = d;
    return d;
  } catch {
    return null;
  }
}

export const api = new GutadClient({
  baseUrl: API_URL,
  getToken: () => session.token(),
  extraHeaders: async (path): Promise<Record<string, string>> => { const d = path.startsWith('/auth/') ? await deviceId() : null; return d ? { 'X-Device-Id': d, 'X-Client': Platform.OS } : {}; },
  onUnauthorized: async () => {
    const refresh = await secureGet(REFRESH);
    if (!refresh) return;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) });
      if (res.ok) await session.set((await res.json()) as AuthResponse);
      else await session.clear();
    } catch {
      /* offline */
    }
  },
});

export { newIdempotencyKey };
export const money = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;
export const when = (d?: string | Date | null) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
