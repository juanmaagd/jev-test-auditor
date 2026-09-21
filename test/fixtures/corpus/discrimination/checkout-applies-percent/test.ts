import { describe, expect, it } from 'vitest';
import { checkout, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('applies a 10 percent discount to a 25 cart', () => {
    expect(checkout(items, 10)).toBe(22.5);
  });
});
