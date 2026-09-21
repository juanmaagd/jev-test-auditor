export function calculateProcessingFee(amount: number): number {
  return Math.round((amount * 0.029 + 0.3) * 100) / 100;
}
