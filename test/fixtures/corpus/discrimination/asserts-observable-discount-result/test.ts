import { describe, expect, it } from 'vitest';
import { calculateDiscount } from './discount.js';

describe('discount', () => {
  it('computes discounted price correctly', () => {
    expect(calculateDiscount(100, 0.2)).toBe(80);
  });
});
