import { describe, expect, it } from 'vitest';
import { subtotal } from './cart.js';

describe('cart', () => {
  it('computes zero subtotal for empty cart', () => {
    expect(subtotal([])).toBe(0);
  });
});
