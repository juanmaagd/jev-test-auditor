import { describe, expect, it } from 'vitest';
import { calculateTotal } from './pricing.js';

describe('pricing', () => {
  it('calculates total through public seam', () => {
    expect(calculateTotal(10, 2)).toBe(20);
  });
});
