'use client';
import { createContext, useContext } from 'react';

export interface Loc { id: string; name: string; slug: string; status: string; isPaused: boolean; kitchenId: string | null; acceptsDelivery: boolean; acceptsReservations: boolean; acceptsEvents: boolean; organizationId: string; timezone: string; currency: string; deliveryFleet: 'MERCHANT' | 'PARTNER' | 'PLATFORM'; deliveryFleetRequested: 'MERCHANT' | 'PARTNER' | 'PLATFORM' | null; deliveryFleetRequestedAt: string | null; platformOperated: boolean; verifiedAt: string | null }
export interface Org { id: string; name: string; locations: Loc[]; legalSellers: { id: string; legalName: string; payoutOnboardingState: string }[]; brands: { id: string; name: string }[]; members: { id: string; email: string; role: string; locationIds: string[] }[]; featureFlags: Record<string, boolean> }
/** What the selected location's plan includes (GET /locations/:id/entitlements). */
export interface Ent { source: 'PLAN' | 'LEGACY' | 'DEFAULT'; planCode: string | null; planName: string | null; unrestricted: boolean; features: Record<string, boolean>; limits: Record<string, { max: number | null; used: number }>; names: Record<string, string> }
export const MerchantCtx = createContext<{ org: Org | null; loc: Loc | null; orgs: Org[]; ent: Ent | null; setLoc: (id: string) => void; reload: () => void }>({ org: null, loc: null, orgs: [], ent: null, setLoc: () => undefined, reload: () => undefined });
/** True while entitlements are loading, so nothing flashes as locked. */
export const allowed = (ent: Ent | null, key: string) => !ent || ent.unrestricted || !!ent.features[key];
export const useMerchant = () => useContext(MerchantCtx);
