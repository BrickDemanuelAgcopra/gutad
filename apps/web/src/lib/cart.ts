'use client';
import { useCallback } from 'react';
import { useLocalState } from './hooks';

export interface CartLine {
  key: string;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifierOptionIds: string[];
  modifierNames: string[];
  modifiersCents: number;
  specialInstructions?: string;
  brandName?: string | null;
}

export interface Cart {
  locationId: string | null;
  locationSlug: string | null;
  locationName: string | null;
  channel: 'MARKETPLACE' | 'DIRECT' | 'WIDGET' | 'QR';
  src: string | null;
  lines: CartLine[];
}

const EMPTY: Cart = { locationId: null, locationSlug: null, locationName: null, channel: 'MARKETPLACE', src: null, lines: [] };

export function useCart() {
  const [cart, setCart] = useLocalState<Cart>('gutad.cart', EMPTY);
  const add = useCallback(
    (loc: { id: string; slug: string; name: string }, line: Omit<CartLine, 'key'>, channel: Cart['channel'] = 'MARKETPLACE', src: string | null = null) => {
      setCart((c) => {
        const base = c.locationId && c.locationId !== loc.id ? { ...EMPTY } : c;
        const key = `${line.menuItemId}:${[...line.modifierOptionIds].sort().join(',')}:${line.specialInstructions || ''}`;
        const existing = base.lines.find((l) => l.key === key);
        const lines = existing ? base.lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...base.lines, { ...line, key }];
        return { ...base, locationId: loc.id, locationSlug: loc.slug, locationName: loc.name, channel, src, lines };
      });
    },
    [setCart],
  );
  const setQty = useCallback((key: string, quantity: number) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity } : l)).filter((l) => l.quantity > 0) })), [setCart]);
  const clear = useCallback(() => setCart({ ...EMPTY }), [setCart]);
  const subtotal = cart.lines.reduce((a, l) => a + (l.unitPriceCents + l.modifiersCents) * l.quantity, 0);
  const count = cart.lines.reduce((a, l) => a + l.quantity, 0);
  return { cart, add, setQty, clear, subtotal, count };
}
