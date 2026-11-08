import { useEffect, useState } from 'react';
import { api, API_URL } from './api';
import { useSession, useStored } from './hooks';

export interface Loc { id: string; name: string; kitchenId: string | null; isPaused: boolean; acceptsReservations: boolean }

/** Resolves the staff member's locations and keeps the selected one; sends device heartbeats when a tablet token is set. */
export function useMerchantLocation() {
  const { user } = useSession();
  const [locs, setLocs] = useState<Loc[]>([]);
  const [locId, setLocId] = useStored<string | null>('gutad.merchant.loc', null);
  const [deviceToken, setDeviceToken] = useStored<string>('gutad.device.token', '');
  useEffect(() => {
    if (!user) return;
    api.get<{ id: string }[]>('/organizations').then(async (orgs) => {
      const all: Loc[] = [];
      for (const o of orgs) {
        const full = await api.get<{ locations: Loc[] }>(`/organizations/${o.id}`);
        all.push(...full.locations);
      }
      setLocs(all);
    }).catch(() => setLocs([]));
  }, [user]);
  useEffect(() => {
    if (!deviceToken) return;
    const beat = () => fetch(`${API_URL}/devices/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken }, body: JSON.stringify({ app: 'mobile', at: new Date().toISOString() }) }).catch(() => undefined);
    beat();
    const t = setInterval(beat, 60_000);
    return () => clearInterval(t);
  }, [deviceToken]);
  const loc = locs.find((l) => l.id === locId) || locs[0] || null;
  return { loc, locs, setLocId, deviceToken, setDeviceToken };
}
