export interface Item { readonly sku: string; readonly price: number; readonly qty: number; }

export function subtotal(items: readonly Item[]): number {
  return items.reduce((total, item) => total + item.price * item.qty, 0);
}
