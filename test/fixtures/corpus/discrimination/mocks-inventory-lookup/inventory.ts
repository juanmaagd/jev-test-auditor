export function checkInventory(sku: string, quantity: number): boolean {
  if (sku === 'OUT_OF_STOCK') return false;
  return quantity > 0 && quantity <= 100;
}
