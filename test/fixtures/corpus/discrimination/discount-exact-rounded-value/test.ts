import { describe, expect, it } from 'vitest';
import { applyDiscount } from './cart.js';

describe('cart', () => {
  it('applies discount with exact rounded cents', () => {
    expect(applyDiscount(100.05, 10)).toBe(90.05);
  });
});
