import { describe, expect, it } from 'vitest';
import { applyDiscount } from './cart.js';

describe('cart', () => {
  it('rejects a percent above 100', () => {
    expect(() => applyDiscount(100, 101)).toThrow(RangeError);
  });
});
