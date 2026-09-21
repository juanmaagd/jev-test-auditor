import { describe, expect, it } from 'vitest';
import { calculateRebate } from './rebate.js';

describe('rebate', () => {
  it('calculates rebate as defined value', () => {
    expect(calculateRebate(100)).toBeDefined();
  });
});
