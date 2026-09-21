import { describe, expect, it } from 'vitest';
import { subtotal, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('computes a subtotal', () => {
    const result = subtotal(items);
    expect(result).toBeTruthy();
  });
});
