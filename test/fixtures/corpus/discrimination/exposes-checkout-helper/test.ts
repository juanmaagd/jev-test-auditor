import { describe, expect, it } from 'vitest';
import { checkout } from './cart.js';

describe('cart', () => {
  it('exposes the checkout helper', () => {
    expect(checkout).toBeDefined();
  });
});
