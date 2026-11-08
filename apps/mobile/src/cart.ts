import { useCallback } from 'react';
import { useStored } from './hooks';

export interface CartLine { key: string; menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string }
export interface Cart { locationId: string | null; locationName: string | null; locationSlug: string | null; lines: CartLine[] }
const EMPTY: Cart = { locationId: null, locationName: null, locationSlug: null, lines: [] };

export function useCart() {
  const [cart, setCart] = useStored<Cart>('gutad.cart', EMPTY);
  const add = useCallback((loc: { id: string; name: string; slug: string }, line: Omit<CartLine, 'key'>) => {
    setCart((c) => {
      const base = c.locationId && c.locationId !== loc.id ? EMPTY : c;
      const key = `${line.menuItemId}:${[...line.modifierOptionIds].sort().join(',')}`;
      const ex = base.lines.find((l) => l.key === key);
      return { locationId: loc.id, locationName: loc.name, locationSlug: loc.slug, lines: ex ? base.lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...base.lines, { ...line, key }] };
    });
  }, [setCart]);
  const setQty = useCallback((key: string, q: number) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity: q } : l)).filter((l) => l.quantity > 0) })), [setCart]);
  const clear = useCallback(() => setCart(EMPTY), [setCart]);
  const subtotal = cart.lines.reduce((a, l) => a + (l.unitPriceCents + l.modifiersCents) * l.quantity, 0);
  const count = cart.lines.reduce((a, l) => a + l.quantity, 0);
  return { cart, add, setQty, clear, subtotal, count };
}
