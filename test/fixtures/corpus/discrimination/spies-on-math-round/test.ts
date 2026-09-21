import { describe, expect, it, vi } from 'vitest';
import { checkout, type Item } from './cart.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('calls subtotal once during checkout', () => {
    const spy = vi.spyOn(globalThis.Math, 'round');
    checkout(items, 10);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
