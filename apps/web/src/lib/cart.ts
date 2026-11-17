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
  /** Gutad Chef Network: a line from an accepted special-request quote (price, quantity and day fixed by the chef) */
  chefRequestQuoteId?: string;
  serviceDate?: string;
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
export const cartSubtotal = (c: Cart) => c.lines.reduce((a, l) => a + (l.unitPriceCents + l.modifiersCents) * l.quantity, 0);

/**
 * One active cart (one place: a restaurant, or one Made at Gutad food hall) plus "parked" carts.
 * Adding from an incompatible place can park the current cart as its own separate order instead of
 * discarding it; checkout lists parked carts so each can be placed in turn.
 */
export function useCart() {
  const [cart, setCart] = useLocalState<Cart>('gutad.cart', EMPTY);
  const [parked, setParked] = useLocalState<Cart[]>('gutad.cart.parked', []);
  const add = useCallback(
    (loc: { id: string; slug: string; name: string }, line: Omit<CartLine, 'key'>, channel: Cart['channel'] = 'MARKETPLACE', src: string | null = null, opts?: { park?: boolean }) => {
      setCart((c) => {
        const switching = !!c.locationId && c.locationId !== loc.id;
        if (switching && opts?.park && c.lines.length) setParked((p) => [...p.filter((x) => x.locationId !== c.locationId), c]);
        // resume a parked cart for this place rather than starting from scratch
        let base = switching ? { ...EMPTY } : c;
        if (switching || !c.locationId) {
          const resumed = parked.find((p) => p.locationId === loc.id);
          if (resumed) { base = resumed; setParked((p) => p.filter((x) => x.locationId !== loc.id)); }
        }
        const key = line.chefRequestQuoteId ? `quote:${line.chefRequestQuoteId}` : `${line.menuItemId}:${[...line.modifierOptionIds].sort().join(',')}:${line.specialInstructions || ''}`;
        const existing = base.lines.find((l) => l.key === key);
        // a quoted line keeps the chef's quantity (adding it again doesn't double it)
        const lines = existing ? base.lines.map((l) => (l.key === key ? { ...l, quantity: line.chefRequestQuoteId ? line.quantity : l.quantity + line.quantity } : l)) : [...base.lines, { ...line, key }];
        return { ...base, locationId: loc.id, locationSlug: loc.slug, locationName: loc.name, channel, src, lines };
      });
    },
    [setCart, setParked, parked],
  );
  const setQty = useCallback((key: string, quantity: number) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity } : l)).filter((l) => l.quantity > 0) })), [setCart]);
  /** Clear the active cart; the next parked cart (if any) becomes active. */
  const clear = useCallback(() => {
    const [next, ...rest] = parked;
    setCart(next ? next : { ...EMPTY });
    setParked(rest);
  }, [setCart, setParked, parked]);
  /** Make a parked cart active, parking the current one. */
  const switchTo = useCallback((locationId: string) => {
    const target = parked.find((p) => p.locationId === locationId);
    if (!target) return;
    setParked((p) => [...p.filter((x) => x.locationId !== locationId), ...(cart.lines.length ? [cart] : [])]);
    setCart(target);
  }, [cart, parked, setCart, setParked]);
  const discardParked = useCallback((locationId: string) => setParked((p) => p.filter((x) => x.locationId !== locationId)), [setParked]);
  /** Remove several carts at once (multi-chef checkout placed them together); the next parked cart becomes active. */
  const removeCarts = useCallback((locationIds: string[]) => {
    const rest = parked.filter((p) => !locationIds.includes(p.locationId!));
    if (cart.locationId && locationIds.includes(cart.locationId)) { const [next, ...more] = rest; setCart(next ? next : { ...EMPTY }); setParked(more); }
    else setParked(rest);
  }, [cart.locationId, parked, setCart, setParked]);
  /** Replace the lines of a cart, active or parked (quantity changes on the multi-chef checkout). */
  const setCartQty = useCallback((locationId: string, key: string, quantity: number) => {
    const upd = (c: Cart) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity } : l)).filter((l) => l.quantity > 0) });
    if (cart.locationId === locationId) setCart(upd); else setParked((ps) => ps.map((p) => (p.locationId === locationId ? upd(p) : p)));
  }, [cart.locationId, setCart, setParked]);
  const subtotal = cartSubtotal(cart);
  const count = cart.lines.reduce((a, l) => a + l.quantity, 0);
  return { cart, parked, add, setQty, clear, switchTo, discardParked, removeCarts, setCartQty, subtotal, count };
}
