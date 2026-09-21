export function computeTieredTax(amount: number): number {
  if (amount > 100) return amount * 0.2;
  return amount * 0.1;
}
