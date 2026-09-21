import { describe, expect, it } from 'vitest';
import { calculateShipping } from './shipping.js';

describe('shipping', () => {
  it('charges lower rate for light parcels', () => {
    expect(calculateShipping(3)).toBe(5);
  });
});
