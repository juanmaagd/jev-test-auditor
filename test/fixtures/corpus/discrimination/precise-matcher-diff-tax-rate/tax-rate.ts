export function computeStateTax(amount: number, state: string): number {
  if (state === 'CA') return amount * 0.0825;
  return amount * 0.05;
}
