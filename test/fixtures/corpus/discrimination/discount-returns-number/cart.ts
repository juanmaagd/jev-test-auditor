export interface Item { readonly sku: string; readonly price: number; readonly qty: number; }

export function subtotal(items: readonly Item[]): number {
  return items.reduce((total, item) => total + item.price * item.qty, 0);
}

export function applyDiscount(amount: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100');
  return Math.round(amount * (100 - percent)) / 100;
}

export function checkout(items: readonly Item[], percent: number): number {
  return applyDiscount(subtotal(items), percent);
}
