export function calculateShipping(weightKg: number): number {
  if (weightKg <= 5) return 5;
  return 10;
}
