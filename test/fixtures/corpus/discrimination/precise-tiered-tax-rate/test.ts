import { describe, expect, it } from 'vitest';
import { computeTieredTax } from './tax.js';

describe('tiered tax', () => {
  it('computes exact tax for upper tier', () => {
    expect(computeTieredTax(200)).toBe(40);
  });
});
