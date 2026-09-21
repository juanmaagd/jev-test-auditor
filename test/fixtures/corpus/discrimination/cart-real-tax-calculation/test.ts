import { describe, expect, it } from 'vitest';
import { totalWithTax } from './tax.js';

describe('tax', () => {
  it('calculates total with real tax logic', () => {
    expect(totalWithTax(100, 0.05)).toBe(105);
  });
});
