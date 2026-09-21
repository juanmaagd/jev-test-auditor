import { describe, expect, it } from 'vitest';
import { computeTotalWithFee } from './pricing.js';

describe('pricing', () => {
  it('computes exact total including fee', () => {
    expect(computeTotalWithFee(50, 5)).toBe(55);
  });
});
