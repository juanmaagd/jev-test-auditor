import { describe, expect, it } from 'vitest';
import { validateCart } from './cart.js';

describe('cart validation', () => {
  it('throws when cart is empty', () => {
    expect(() => validateCart([])).toThrow('cart empty');
  });
});
