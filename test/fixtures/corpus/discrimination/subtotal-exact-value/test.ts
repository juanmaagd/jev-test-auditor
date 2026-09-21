import { describe, expect, it } from 'vitest';
import { subtotal, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('subtotals a two-line cart to 25', () => {
    expect(subtotal(items)).toBe(25);
  });
});
