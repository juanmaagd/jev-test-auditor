export function computeVolumeDiscount(quantity: number, unitPrice: number): number {
  const discount = quantity >= 10 ? 0.2 : 0;
  return Math.round(quantity * unitPrice * (1 - discount) * 100) / 100;
}
