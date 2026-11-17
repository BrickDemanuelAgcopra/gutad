import { useCallback } from 'react';
import { useStored } from './hooks';

export interface CartLine { key: string; menuItemId: string; name: string; quantity: number; unitPriceCents: number; modifierOptionIds: string[]; modifierNames: string[]; modifiersCents: number; specialInstructions?: string; /** Phase 6: an accepted chef quote (price, quantity and date fixed by the chef) */ chefRequestQuoteId?: string; serviceDate?: string; serviceTime?: string | null }
export interface Cart { locationId: string | null; locationName: string | null; locationSlug: string | null; lines: CartLine[] }
const EMPTY: Cart = { locationId: null, locationName: null, locationSlug: null, lines: [] };
/** The cooking day an accepted chef quote fixes, to preselect at checkout. */
export const preferredSchedule = (c: Cart): { date: string; time: string } | null => { const l = c.lines.find((x) => x.chefRequestQuoteId && x.serviceDate); return l ? { date: l.serviceDate!, time: l.serviceTime || '' } : null; };
export const cartSubtotal = (c: Cart) => c.lines.reduce((a, l) => a + (l.unitPriceCents + l.modifiersCents) * l.quantity, 0);

/** One active cart (one restaurant or one Made at Gutad food hall) plus parked carts that become separate orders. */
export function useCart() {
  const [cart, setCart] = useStored<Cart>('gutad.cart', EMPTY);
  const [parked, setParked] = useStored<Cart[]>('gutad.cart.parked', []);
  const add = useCallback((loc: { id: string; name: string; slug: string }, line: Omit<CartLine, 'key'>, opts?: { park?: boolean }) => {
    setCart((c) => {
      const switching = !!c.locationId && c.locationId !== loc.id;
      if (switching && opts?.park && c.lines.length) setParked((p) => [...p.filter((x) => x.locationId !== c.locationId), c]);
      let base = switching ? EMPTY : c;
      if (switching || !c.locationId) {
        const resumed = parked.find((p) => p.locationId === loc.id);
        if (resumed) { base = resumed; setParked((p) => p.filter((x) => x.locationId !== loc.id)); }
      }
      // a quote line never merges with a normal line, and adding it again replaces it (its quantity is fixed)
      const key = line.chefRequestQuoteId ? `quote:${line.chefRequestQuoteId}` : `${line.menuItemId}:${[...line.modifierOptionIds].sort().join(',')}`;
      const ex = base.lines.find((l) => l.key === key);
      return { locationId: loc.id, locationName: loc.name, locationSlug: loc.slug, lines: ex ? base.lines.map((l) => (l.key === key ? (line.chefRequestQuoteId ? { ...line, key } : { ...l, quantity: l.quantity + line.quantity }) : l)) : [...base.lines, { ...line, key }] };
    });
  }, [setCart, setParked, parked]);
  const setQty = useCallback((key: string, q: number) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity: q } : l)).filter((l) => l.quantity > 0) })), [setCart]);
  const clear = useCallback(() => { const [next, ...rest] = parked; setCart(next || EMPTY); setParked(rest); }, [setCart, setParked, parked]);
  const switchTo = useCallback((locationId: string) => {
    const target = parked.find((p) => p.locationId === locationId);
    if (!target) return;
    setParked((p) => [...p.filter((x) => x.locationId !== locationId), ...(cart.lines.length ? [cart] : [])]);
    setCart(target);
  }, [cart, parked, setCart, setParked]);
  const discardParked = useCallback((locationId: string) => setParked((p) => p.filter((x) => x.locationId !== locationId)), [setParked]);
  /** Drops the carts for these places (active and parked), e.g. after a multi-chef checkout; the next parked cart becomes active. */
  const removeCarts = useCallback((locationIds: string[]) => {
    const rest = parked.filter((p) => !locationIds.includes(p.locationId!));
    if (cart.locationId && locationIds.includes(cart.locationId)) { const [next, ...others] = rest; setCart(next || EMPTY); setParked(others); } else setParked(rest);
  }, [cart, parked, setCart, setParked]);
  const subtotal = cartSubtotal(cart);
  const count = cart.lines.reduce((a, l) => a + l.quantity, 0);
  return { cart, parked, add, setQty, clear, switchTo, discardParked, removeCarts, subtotal, count };
}
