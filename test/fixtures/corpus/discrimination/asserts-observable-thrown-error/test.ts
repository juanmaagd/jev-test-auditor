import { describe, expect, it } from 'vitest';
import { validateQuantity } from './validator.js';

describe('validator', () => {
  it('throws RangeError when quantity is negative', () => {
    expect(() => validateQuantity(-1)).toThrow(RangeError);
  });
});
