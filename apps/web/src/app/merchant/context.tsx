'use client';
import { createContext, useContext } from 'react';

export interface Loc { id: string; name: string; slug: string; status: string; isPaused: boolean; kitchenId: string | null; acceptsDelivery: boolean; acceptsReservations: boolean; acceptsEvents: boolean; organizationId: string; timezone: string; currency: string }
export interface Org { id: string; name: string; locations: Loc[]; legalSellers: { id: string; legalName: string; payoutOnboardingState: string }[]; brands: { id: string; name: string }[]; members: { id: string; email: string; role: string; locationIds: string[] }[]; featureFlags: Record<string, boolean> }
export const MerchantCtx = createContext<{ org: Org | null; loc: Loc | null; orgs: Org[]; setLoc: (id: string) => void; reload: () => void }>({ org: null, loc: null, orgs: [], setLoc: () => undefined, reload: () => undefined });
export const useMerchant = () => useContext(MerchantCtx);
