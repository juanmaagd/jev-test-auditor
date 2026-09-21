export function calculateTieredDiscount(price: number): number {
  if (price > 100) return price * 0.8;
  return price * 0.9;
}
