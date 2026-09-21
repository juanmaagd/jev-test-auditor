import { describe, expect, it } from 'vitest';
import { applyDiscount } from './cart.js';

describe('cart', () => {
  it('returns a number for a discount', () => {
    expect(typeof applyDiscount(100, 10)).toBe('number');
  });
});
