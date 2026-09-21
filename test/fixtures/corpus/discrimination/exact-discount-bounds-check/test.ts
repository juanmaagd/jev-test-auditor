import { describe, expect, it } from 'vitest';
import { applyStrictDiscount } from './discount.js';

describe('strict discount', () => {
  it('throws RangeError when percentage is negative', () => {
    expect(() => applyStrictDiscount(100, -10)).toThrow(RangeError);
  });
});
