import { describe, expect, it } from 'vitest';
import { calculateTieredDiscount } from './discount.js';

describe('tiered discount', () => {
  it('gives exact 20 percent discount for high tier', () => {
    expect(calculateTieredDiscount(200)).toBe(160);
  });
});
