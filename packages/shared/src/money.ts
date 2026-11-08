/** Money helpers: all amounts are integer minor units (cents). */

export function formatCents(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** Basis points of an amount, rounded half-up to a whole cent. */
export function bps(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10_000);
}

/** Allocate a total across weights so the parts sum exactly to the total (largest remainder). */
export function allocate(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}
