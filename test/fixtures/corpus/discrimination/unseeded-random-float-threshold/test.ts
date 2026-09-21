import { describe, expect, it } from 'vitest';
import { coinFlip } from './random.js';

describe('random', () => {
  it('returns a valid coin flip string', () => {
    const result = coinFlip();
    expect(typeof result).toBe('string');
  });
});
