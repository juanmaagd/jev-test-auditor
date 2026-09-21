import { describe, expect, it } from 'vitest';
import { totalInEur } from './currency.js';

describe('currency', () => {
  it('converts total to EUR using real conversion logic', () => {
    expect(totalInEur(100)).toBe(92);
  });
});
