export function convertUsdToEur(amountUsd: number, rate: number = 0.9): number {
  return Math.round(amountUsd * rate * 100) / 100;
}

export function totalInEur(amountUsd: number): number {
  return convertUsdToEur(amountUsd, 0.92);
}
