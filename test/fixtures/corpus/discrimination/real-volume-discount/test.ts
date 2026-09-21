import { describe, expect, it } from 'vitest';
import { computeVolumeDiscount } from './volume.js';

describe('volume', () => {
  it('calculates volume discount with real domain rules', () => {
    expect(computeVolumeDiscount(10, 50)).toBe(400);
  });
});
