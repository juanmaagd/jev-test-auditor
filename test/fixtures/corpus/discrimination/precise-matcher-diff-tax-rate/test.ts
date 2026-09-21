import { describe, expect, it } from 'vitest';
import { computeStateTax } from './tax-rate.js';

describe('tax rate', () => {
  it('computes exact California state tax rate with clear diagnostic matcher', () => {
    expect(computeStateTax(100, 'CA')).toBe(8.25);
  });
});
