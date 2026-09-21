export function applyStrictDiscount(amount: number, pct: number): number {
  if (pct < 0) throw new RangeError('negative percentage');
  return amount * (1 - pct / 100);
}
