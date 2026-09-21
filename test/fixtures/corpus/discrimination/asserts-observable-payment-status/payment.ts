export function processPayment(amount: number): { success: boolean; status: string } {
  if (amount <= 0) return { success: false, status: 'INVALID_AMOUNT' };
  return { success: true, status: 'PAID' };
}
