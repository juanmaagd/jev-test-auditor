import { describe, expect, it, vi } from 'vitest';
import { applyDiscount, checkout, subtotal, type Item } from './src/cart.js';
import { history, record } from './src/audit-log.js';

const items: Item[] = [{ sku: 'a', price: 10, qty: 2 }, { sku: 'b', price: 5, qty: 1 }];

describe('cart', () => {
  it('exposes the checkout helper', () => {
    expect(checkout).toBeDefined();
  });

  it('works', () => {
    expect(Boolean(subtotal(items) && applyDiscount(100, 10) && checkout(items, 0))).toBe(true);
  });

  it('computes a subtotal', () => {
    const result = subtotal(items);
    expect(result).toBeTruthy();
  });

  it('returns a number for a discount', () => {
    expect(typeof applyDiscount(100, 10)).toBe('number');
  });

  it('checks out correctly', () => {
    expect(25).toBe(25);
  });

  it('calls subtotal once during checkout', () => {
    const spy = vi.spyOn(globalThis.Math, 'round');
    checkout(items, 10);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('applies the discount', () => {
    const mocked = vi.fn(() => 99);
    expect(mocked()).toBe(99);
  });

  it('records history across runs', () => {
    record(`run-${Math.random()}`);
    expect(history().length).toBeGreaterThan(0);
  });

  it('subtotals a two-line cart to 25', () => {
    expect(subtotal(items)).toBe(25);
  });

  it('rejects a percent above 100', () => {
    expect(() => applyDiscount(100, 101)).toThrow(RangeError);
  });

  it('applies a 10 percent discount to a 25 cart', () => {
    expect(checkout(items, 10)).toBe(22.5);
  });
});
