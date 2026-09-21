export function calculateTax(subtotal: number, rate: number): number {
  return Math.round(subtotal * rate * 100) / 100;
}

export function totalWithTax(subtotal: number, rate: number): number {
  return subtotal + calculateTax(subtotal, rate);
}
