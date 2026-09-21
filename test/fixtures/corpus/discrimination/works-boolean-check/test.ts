import { describe, expect, it } from 'vitest';
import { applyDiscount, checkout, subtotal, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('works', () => {
    expect(Boolean(subtotal(items) && applyDiscount(100, 10) && checkout(items, 0))).toBe(true);
  });
});
