export class CartService {
  _cache: Record<string, number> = {};
  getPrice(sku: string): number {
    if (this._cache[sku] === undefined) this._cache[sku] = 10;
    return this._cache[sku]!;
  }
}
