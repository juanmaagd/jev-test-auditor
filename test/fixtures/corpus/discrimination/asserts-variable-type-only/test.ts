import { describe, expect, it } from 'vitest';
import { checkout, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 1 }];

describe('cart', () => {
  it('checks checkout output is defined', () => {
    const result = checkout(items, 0);
    expect(result !== undefined).toBe(true);
  });
});
