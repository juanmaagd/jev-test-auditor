import { describe, expect, it } from 'vitest';
import { checkout, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 1 }];

describe('cart', () => {
  it('checks out with discount through public seam', () => {
    expect(checkout(items, 10)).toBe(9);
  });
});
