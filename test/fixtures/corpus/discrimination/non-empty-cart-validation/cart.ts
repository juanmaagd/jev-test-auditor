export function validateCart(items: readonly string[]): void {
  if (items.length === 0) throw new Error('cart empty');
}
